//! Noninteractive, window-relative feedback for an active native call.
//! The badge sits directly above the target window in z-order, so it is visible
//! only where the target is; it never activates, takes input or enters captures.
use super::desktop::{self, Window};
use serde_json::Value;
use std::sync::{mpsc, Mutex, OnceLock};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreatePen, CreateSolidBrush, DeleteObject, Ellipse, EndPaint, FillRect,
    MonitorFromWindow, Polygon, SelectObject, MONITOR_DEFAULTTONEAREST, PAINTSTRUCT, PS_SOLID,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindow, IsIconic, IsWindow,
    IsWindowVisible, PostThreadMessageW, RegisterClassExW, SetLayeredWindowAttributes, SetTimer,
    SetWindowDisplayAffinity, SetWindowPos, ShowWindow, TranslateMessage, GW_HWNDPREV, HWND_TOP,
    LWA_ALPHA, LWA_COLORKEY, MSG, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WDA_EXCLUDEFROMCAPTURE,
    WM_PAINT, WM_TIMER, WM_USER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TRANSPARENT, WS_POPUP,
};

const REFRESH: u32 = WM_USER + 1;
const TRANSPARENT_KEY: COLORREF = COLORREF(0x00FF00FF);
const WHITE: COLORREF = COLORREF(0x00FFFFFF);

#[derive(Clone, Copy)]
struct Config {
    size: f64,
    inset_x: f64,
    inset_y: f64,
    color: COLORREF,
}

/// Shared with macOS: resources/indicator.json, with optional Windows overrides
/// (the macOS inset leaves room for traffic-light buttons).
fn config() -> Config {
    let value: Value =
        serde_json::from_str(include_str!("../../resources/indicator.json")).unwrap_or_default();
    let number = |key: &str, default: f64| {
        value["windows"][key]
            .as_f64()
            .or_else(|| value[key].as_f64())
            .filter(|number| number.is_finite() && *number >= 0.0)
            .unwrap_or(default)
    };
    let channel = |index: usize| {
        value["color"][index]
            .as_f64()
            .filter(|number| (0.0..=1.0).contains(number))
            .map_or(0, |number| (number * 255.0).round() as u32)
    };
    Config {
        size: number("size", 20.0).max(8.0),
        inset_x: number("insetX", 8.0),
        inset_y: number("insetY", 6.0),
        color: COLORREF(channel(0) | channel(1) << 8 | channel(2) << 16),
    }
}

#[derive(Default)]
struct Target {
    window: Option<u32>,
    /// Physical pixels relative to the window frame's top-left.
    cursor: Option<(f64, f64)>,
}

static TARGET: Mutex<Target> = Mutex::new(Target {
    window: None,
    cursor: None,
});
static THREAD: OnceLock<Result<u32, String>> = OnceLock::new();

struct Windows {
    badge: HWND,
    cursor: HWND,
}
// Window handles are plain identifiers; only the indicator thread uses them.
unsafe impl Send for Windows {}
static WINDOWS: Mutex<Option<Windows>> = Mutex::new(None);

fn thread() -> Result<u32, String> {
    THREAD
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel();
            std::thread::Builder::new()
                .name("computer-use-indicator".into())
                .spawn(move || run(sender))
                .map_err(|error| error.to_string())?;
            receiver
                .recv()
                .map_err(|_| "Indicator thread did not start".to_string())?
        })
        .clone()
}

fn post_refresh() {
    if let Ok(thread) = thread() {
        let _ = unsafe { PostThreadMessageW(thread, REFRESH, WPARAM(0), LPARAM(0)) };
    }
}

/// Show the indicator on this window; `cursor` is a desktop point for semantic actions.
pub fn show(window: &Window, cursor: Option<(f64, f64)>) -> Result<(), String> {
    thread()?;
    if let Ok(mut target) = TARGET.lock() {
        target.window = Some(window.id);
        target.cursor = cursor.map(|(x, y)| (x - window.bounds.x, y - window.bounds.y));
    }
    post_refresh();
    Ok(())
}

/// Visibility follows the native call: hidden when the call returns.
pub fn hide() {
    if let Ok(mut target) = TARGET.lock() {
        if target.window.is_none() {
            return;
        }
        *target = Target::default();
    }
    post_refresh();
}

fn run(started: mpsc::Sender<Result<u32, String>>) {
    let created = unsafe { create() };
    let ok = created.is_ok();
    let _ = started.send(created.map(|()| unsafe { GetCurrentThreadId() }));
    if !ok {
        return;
    }
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        if message.hwnd.is_invalid() && message.message == REFRESH {
            refresh();
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe fn create() -> Result<(), String> {
    unsafe {
        let instance = GetModuleHandleW(None).map_err(|error| error.to_string())?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(procedure),
            hInstance: instance.into(),
            lpszClassName: w!("DeepCodeComputerUseIndicator"),
            ..Default::default()
        };
        if RegisterClassExW(&class) == 0 {
            return Err("Cannot register the indicator window class".into());
        }
        let make = |name: PCWSTR| {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("DeepCodeComputerUseIndicator"),
                name,
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .map_err(|error| format!("Cannot create the indicator window: {error}"))
        };
        let badge = make(w!("DeepCode Computer Use"))?;
        let cursor = make(w!("DeepCode Computer Use cursor"))?;
        for window in [badge, cursor] {
            SetLayeredWindowAttributes(window, TRANSPARENT_KEY, 235, LWA_COLORKEY | LWA_ALPHA)
                .map_err(|error| error.to_string())?;
            // Windows 10 2004+: keep feedback out of display captures. Older systems
            // still exclude it from window captures, which render only the target.
            let _ = SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE);
        }
        SetTimer(Some(badge), 1, 100, None);
        *WINDOWS.lock().map_err(|_| "Indicator state unavailable")? =
            Some(Windows { badge, cursor });
        Ok(())
    }
}

unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_TIMER => {
            refresh();
            LRESULT(0)
        }
        WM_PAINT => {
            unsafe { paint(window) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

fn handles() -> Option<(HWND, HWND)> {
    WINDOWS.lock().ok().and_then(|windows| {
        windows
            .as_ref()
            .map(|windows| (windows.badge, windows.cursor))
    })
}

fn refresh() {
    let Some((badge, cursor)) = handles() else {
        return;
    };
    let (target, offset) = match TARGET.lock() {
        Ok(target) => (target.window, target.cursor),
        Err(_) => (None, None),
    };
    let target = target.map(desktop::hwnd).filter(|target| unsafe {
        IsWindow(Some(*target)).as_bool()
            && IsWindowVisible(*target).as_bool()
            && !IsIconic(*target).as_bool()
    });
    let Some((target, bounds)) = target.and_then(|target| {
        desktop::frame_bounds(target)
            .ok()
            .map(|bounds| (target, bounds))
    }) else {
        unsafe {
            let _ = ShowWindow(badge, SW_HIDE);
            let _ = ShowWindow(cursor, SW_HIDE);
        }
        return;
    };
    let settings = config();
    // Physical size follows the monitor, also for DPI-unaware targets reporting 96.
    let (mut x, mut y) = (0u32, 0u32);
    let monitor = unsafe { MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST) };
    let scale = match unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) } {
        Ok(()) if x > 0 => x as f64 / 96.0,
        _ => 1.0,
    };
    let size = (settings.size * scale).round();
    // Directly above the target, below whatever covers it: never a global overlay.
    let mut above = unsafe { GetWindow(target, GW_HWNDPREV) }.ok();
    while let Some(window) = above.filter(|window| *window == badge || *window == cursor) {
        above = unsafe { GetWindow(window, GW_HWNDPREV) }.ok();
    }
    let place = |window: HWND, offset: Option<(f64, f64)>| unsafe {
        let Some((x, y)) = offset.filter(|(x, y)| {
            *x >= 0.0 && *y >= 0.0 && x + size <= bounds.width && y + size <= bounds.height
        }) else {
            let _ = ShowWindow(window, SW_HIDE);
            return;
        };
        let _ = SetWindowPos(
            window,
            Some(above.unwrap_or(HWND_TOP)),
            (bounds.x + x).round() as i32,
            (bounds.y + y).round() as i32,
            size as i32,
            size as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    };
    place(
        badge,
        Some((settings.inset_x * scale, settings.inset_y * scale)),
    );
    place(
        cursor,
        offset.map(|(x, y)| (x - size * 0.25, y - size * 0.15)),
    );
}

unsafe fn paint(window: HWND) {
    unsafe {
        let mut paint = PAINTSTRUCT::default();
        let device = BeginPaint(window, &mut paint);
        let settings = config();
        let mut client = RECT::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(window, &mut client);
        let key = CreateSolidBrush(TRANSPARENT_KEY);
        FillRect(device, &client, key);
        let fill = CreateSolidBrush(settings.color);
        let outline = CreatePen(PS_SOLID, 1, WHITE);
        let white = CreateSolidBrush(WHITE);
        let previous_brush = SelectObject(device, fill.into());
        let previous_pen = SelectObject(device, outline.into());
        let (width, height) = (client.right as f64, client.bottom as f64);
        let point = |x: f64, y: f64| POINT {
            x: (x * width).round() as i32,
            y: (y * height).round() as i32,
        };
        let arrow = |scale: f64, dx: f64, dy: f64| {
            [
                (0.0, 0.0),
                (0.0, 0.78),
                (0.2, 0.6),
                (0.34, 0.92),
                (0.47, 0.86),
                (0.33, 0.55),
                (0.6, 0.55),
            ]
            .map(|(x, y)| point(dx + x * scale, dy + y * scale))
        };
        if Some(window) == handles().map(|(badge, _)| badge) {
            let _ = Ellipse(device, 0, 0, client.right, client.bottom);
            SelectObject(device, white.into());
            let _ = Polygon(device, &arrow(0.62, 0.3, 0.16));
        } else {
            let _ = Polygon(device, &arrow(1.0, 0.05, 0.02));
        }
        SelectObject(device, previous_brush);
        SelectObject(device, previous_pen);
        for object in [key.into(), fill.into(), white.into(), outline.into()] {
            let _ = DeleteObject(object);
        }
        let _ = EndPaint(window, &paint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_indicator_settings_apply_windows_overrides() {
        let settings = config();
        assert!(settings.size >= 8.0);
        assert!(
            settings.inset_x < 76.0,
            "macOS traffic-light inset must not apply on Windows"
        );
        assert_ne!(settings.color, TRANSPARENT_KEY);
    }
}
