//! Noninteractive, window-relative feedback retained for each debugging run.
//! The badge sits directly above the target window in z-order, so it is visible
//! only where the target is; it never activates, takes input or enters captures.
use super::desktop::{self, Window};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{mpsc, Mutex, OnceLock};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreatePen, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint,
    FillRect, MonitorFromWindow, Polygon, RoundRect, SelectObject, SetBkMode, SetTextColor,
    CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DT_END_ELLIPSIS,
    DT_SINGLELINE, DT_VCENTER, FW_MEDIUM, MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS,
    PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, GetWindow,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostThreadMessageW, RegisterClassExW,
    SetLayeredWindowAttributes, SetTimer, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
    TranslateMessage, GW_HWNDPREV, HWND_TOP, LWA_ALPHA, LWA_COLORKEY, MSG, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SW_HIDE, WDA_EXCLUDEFROMCAPTURE, WM_PAINT, WM_TIMER, WM_USER, WNDCLASSEXW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

const REFRESH: u32 = WM_USER + 1;
const TRANSPARENT_KEY: COLORREF = COLORREF(0x00FF00FF);
const WHITE: COLORREF = COLORREF(0x00FFFFFF);
const CONTROL_LABEL: &str = "Achbit 正在调试此窗口";

fn badge_size(icon_size: f64, scale: f64) -> (f64, f64) {
    (260.0 * scale, icon_size + 12.0 * scale)
}

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

#[derive(Clone)]
struct Target {
    window: Window,
    // A packaged app's semantic PID can differ from its top-level frame owner.
    owner_pid: u32,
    runs: HashSet<(String, String)>,
    /// Normalized position within the exact target window frame.
    cursor: Option<(f64, f64)>,
    cursor_owner: Option<(String, String)>,
}

#[derive(Default)]
struct Targets(Vec<Target>);

fn run_key(binding: &Value) -> (String, String) {
    (
        binding["sessionId"]
            .as_str()
            .expect("validated binding")
            .into(),
        binding["runId"].as_str().expect("validated binding").into(),
    )
}

impl Targets {
    fn record(
        &mut self,
        window: &Window,
        owner_pid: u32,
        binding: &Value,
        cursor: Option<(f64, f64)>,
    ) {
        self.0.retain(|target| {
            target.window.id != window.id
                || (target.owner_pid == owner_pid && target.window.pid == window.pid)
        });
        let index = self
            .0
            .iter()
            .position(|target| target.window.id == window.id)
            .unwrap_or_else(|| {
                self.0.push(Target {
                    window: window.clone(),
                    owner_pid,
                    runs: HashSet::new(),
                    cursor: None,
                    cursor_owner: None,
                });
                self.0.len() - 1
            });
        let target = &mut self.0[index];
        target.runs.insert(run_key(binding));
        if let Some((x, y)) = cursor {
            target.cursor = Some((
                (x - window.bounds.x) / window.bounds.width,
                (y - window.bounds.y) / window.bounds.height,
            ));
            target.cursor_owner = Some(run_key(binding));
        }
    }

    fn retain_open_windows(&mut self) {
        self.0
            .retain(|target| window_owner_pid(target.window.hwnd()) == Some(target.owner_pid));
    }

    fn finish_run(&mut self, binding: &Value) {
        let key = run_key(binding);
        for target in &mut self.0 {
            target.runs.remove(&key);
            if target.cursor_owner.as_ref() == Some(&key) {
                target.cursor = None;
                target.cursor_owner = None;
            }
        }
        self.0.retain(|target| !target.runs.is_empty());
    }
}

static TARGETS: Mutex<Targets> = Mutex::new(Targets(Vec::new()));
static THREAD: OnceLock<Result<u32, String>> = OnceLock::new();

#[derive(Clone, Copy)]
struct Windows {
    badge: HWND,
    cursor: HWND,
}
// Window handles are plain identifiers; only the indicator thread uses them.
unsafe impl Send for Windows {}
static WINDOWS: Mutex<Vec<(u32, Windows)>> = Mutex::new(Vec::new());

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
pub fn show(window: &Window, binding: &Value, cursor: Option<(f64, f64)>) -> Result<(), String> {
    let owner_pid =
        window_owner_pid(window.hwnd()).ok_or("Target window is no longer available")?;
    thread()?;
    TARGETS
        .lock()
        .map_err(|_| "Indicator state unavailable")?
        .record(window, owner_pid, binding, cursor);
    post_refresh();
    Ok(())
}

pub fn finish_run(binding: &Value) -> Result<(), String> {
    TARGETS
        .lock()
        .map_err(|_| "Indicator state unavailable")?
        .finish_run(binding);
    if THREAD.get().is_some() {
        post_refresh();
    }
    Ok(())
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
            lpszClassName: w!("AchbitComputerUseIndicator"),
            ..Default::default()
        };
        if RegisterClassExW(&class) == 0 {
            return Err("Cannot register the indicator window class".into());
        }
        let timer = create_window(w!("Achbit indicator timer"))?;
        SetTimer(Some(timer), 1, 100, None);
        Ok(())
    }
}

unsafe fn create_window(name: PCWSTR) -> Result<HWND, String> {
    unsafe {
        let instance = GetModuleHandleW(None).map_err(|error| error.to_string())?;
        let window = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            w!("AchbitComputerUseIndicator"),
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
        .map_err(|error| format!("Cannot create the indicator window: {error}"))?;
        if let Err(error) =
            SetLayeredWindowAttributes(window, TRANSPARENT_KEY, 235, LWA_COLORKEY | LWA_ALPHA)
        {
            let _ = DestroyWindow(window);
            return Err(error.to_string());
        }
        let _ = SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE);
        Ok(window)
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

fn handles() -> Vec<(u32, Windows)> {
    WINDOWS
        .lock()
        .map(|windows| windows.clone())
        .unwrap_or_default()
}

fn window_owner_pid(window: HWND) -> Option<u32> {
    let mut pid = 0;
    let thread = unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    (thread != 0 && pid != 0).then_some(pid)
}

fn refresh() {
    let targets = match TARGETS.lock() {
        Ok(mut targets) => {
            targets.retain_open_windows();
            targets.0.clone()
        }
        Err(_) => return,
    };
    for (id, pair) in handles() {
        if !targets.iter().any(|target| target.window.id == id) {
            if let Ok(mut windows) = WINDOWS.lock() {
                windows.retain(|(current, _)| *current != id);
            }
            unsafe {
                let _ = DestroyWindow(pair.badge);
                let _ = DestroyWindow(pair.cursor);
            }
        }
    }
    for target in targets {
        let pair = handles()
            .into_iter()
            .find(|(id, _)| *id == target.window.id)
            .map(|(_, pair)| pair);
        let pair = match pair {
            Some(pair) => pair,
            None => {
                let created = unsafe {
                    (|| {
                        let badge = create_window(w!("Achbit Computer Use"))?;
                        match create_window(w!("Achbit Computer Use cursor")) {
                            Ok(cursor) => Ok(Windows { badge, cursor }),
                            Err(error) => {
                                let _ = DestroyWindow(badge);
                                Err(error)
                            }
                        }
                    })()
                };
                let pair = match created {
                    Ok(pair) => pair,
                    Err(error) => {
                        eprintln!("{error}");
                        continue;
                    }
                };
                if let Ok(mut windows) = WINDOWS.lock() {
                    windows.push((target.window.id, pair));
                }
                pair
            }
        };
        refresh_target(pair, &target);
    }
}

fn refresh_target(Windows { badge, cursor }: Windows, target: &Target) {
    let offset = target.cursor;
    let target = Some(target.window.hwnd()).filter(|target| unsafe {
        IsWindowVisible(*target).as_bool() && !IsIconic(*target).as_bool()
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
    let place = |window: HWND, offset: Option<(f64, f64)>, width: f64, height: f64| unsafe {
        let Some((x, y)) = offset.filter(|(x, y)| {
            *x >= 0.0 && *y >= 0.0 && x + width <= bounds.width && y + height <= bounds.height
        }) else {
            let _ = ShowWindow(window, SW_HIDE);
            return;
        };
        let _ = SetWindowPos(
            window,
            Some(above.unwrap_or(HWND_TOP)),
            (bounds.x + x).round() as i32,
            (bounds.y + y).round() as i32,
            width as i32,
            height as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    };
    let (badge_width, badge_height) = badge_size(size, scale);
    place(
        badge,
        Some((settings.inset_x * scale, settings.inset_y * scale)),
        badge_width.min((bounds.width - (settings.inset_x + 8.0) * scale).max(0.0)),
        badge_height,
    );
    place(
        cursor,
        offset.map(|(x, y)| {
            (
                x * bounds.width - size * 0.25,
                y * bounds.height - size * 0.15,
            )
        }),
        size,
        size,
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
        let height = client.bottom as f64;
        let width = height;
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
        if handles().iter().any(|(_, pair)| pair.badge == window) {
            let radius = (height * 0.5) as i32;
            let _ = RoundRect(device, 0, 0, client.right, client.bottom, radius, radius);
            SelectObject(device, white.into());
            let _ = Polygon(device, &arrow(0.55, 0.25, 0.22));
            let font = CreateFontW(
                -(height * 0.42).round() as i32,
                0,
                0,
                0,
                FW_MEDIUM.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                DEFAULT_PITCH.0 as u32,
                w!("Microsoft YaHei UI"),
            );
            let previous_font = SelectObject(device, font.into());
            SetBkMode(device, TRANSPARENT);
            SetTextColor(device, WHITE);
            let mut text: Vec<u16> = CONTROL_LABEL.encode_utf16().collect();
            let mut text_bounds = RECT {
                left: height as i32,
                top: 0,
                right: client.right - (height * 0.3) as i32,
                bottom: client.bottom,
            };
            DrawTextW(
                device,
                &mut text,
                &mut text_bounds,
                DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            );
            SelectObject(device, previous_font);
            let _ = DeleteObject(font.into());
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
    fn target_badges_survive_call_gaps_and_end_only_for_their_run() {
        let binding = |run: &str| serde_json::json!({"sessionId":"s", "runId":run});
        let window = |id| Window {
            id,
            pid: 1,
            app: "test.exe".into(),
            class: "test".into(),
            title: "test".into(),
            bounds: crate::protocol::Bounds {
                x: 0.0,
                y: 0.0,
                width: 500.0,
                height: 500.0,
            },
        };
        let mut targets = Targets::default();
        targets.record(&window(1), 1, &binding("a"), Some((20.0, 20.0)));
        targets.record(&window(1), 1, &binding("a"), None);
        assert_eq!(
            targets.0.len(),
            1,
            "thinking between calls retains the target"
        );
        assert_eq!(
            targets.0[0].cursor,
            Some((0.04, 0.04)),
            "the last operation position survives observation and thinking"
        );
        targets.record(&window(2), 1, &binding("a"), None);
        targets.record(&window(1), 1, &binding("b"), None);
        targets.finish_run(&binding("a"));
        assert_eq!(
            targets.0.len(),
            1,
            "all targets solely owned by the finished run are removed"
        );
        assert_eq!(targets.0[0].window.id, 1);
        assert!(targets.0[0].runs.contains(&run_key(&binding("b"))));
        assert!(
            targets.0[0].cursor.is_none(),
            "a finished run cannot leave its pointer on another run's window"
        );
        targets.finish_run(&binding("b"));
        assert!(targets.0.is_empty());
    }

    #[test]
    fn packaged_app_targets_follow_the_native_window_owner() {
        struct OwnedWindow(HWND);
        impl Drop for OwnedWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }
        let native = OwnedWindow(unsafe {
            CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("Achbit indicator identity test"),
                WS_POPUP,
                0,
                0,
                500,
                500,
                None,
                None,
                None,
                None,
            )
            .expect("create hidden test window")
        });
        let owner_pid = window_owner_pid(native.0).expect("native window owner");
        let window = Window {
            id: u32::try_from(native.0 .0 as usize).expect("window identifier"),
            pid: owner_pid + 1,
            app: "packaged-app.exe".into(),
            class: "ApplicationFrameWindow".into(),
            title: "test".into(),
            bounds: crate::protocol::Bounds {
                x: 0.0,
                y: 0.0,
                width: 500.0,
                height: 500.0,
            },
        };
        let binding = |run: &str| serde_json::json!({"sessionId":"s", "runId":run});
        let mut targets = Targets::default();
        targets.record(&window, owner_pid, &binding("a"), Some((20.0, 20.0)));
        targets.record(&window, owner_pid, &binding("b"), None);
        targets.retain_open_windows();
        assert_eq!(
            targets.0.len(),
            1,
            "a distinct app PID does not close the frame"
        );
        assert_eq!(
            targets.0[0].window.pid, window.pid,
            "app identity is preserved"
        );
        assert_eq!(
            targets.0[0].runs.len(),
            2,
            "the same frame shares run ownership"
        );
        assert_eq!(targets.0[0].cursor, Some((0.04, 0.04)));

        targets.record(&window, owner_pid + 1, &binding("replacement"), None);
        assert_eq!(targets.0.len(), 1);
        assert_eq!(
            targets.0[0].runs,
            HashSet::from([run_key(&binding("replacement"))])
        );
        assert!(
            targets.0[0].cursor.is_none(),
            "a different owner cannot inherit the old cursor"
        );
        targets.retain_open_windows();
        assert!(targets.0.is_empty(), "a stale native owner is removed");

        targets.record(&window, owner_pid, &binding("c"), None);
        drop(native);
        targets.retain_open_windows();
        assert!(targets.0.is_empty(), "a destroyed window is removed");
    }

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
