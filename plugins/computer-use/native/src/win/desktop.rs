//! Top-level windows, owning processes and foreground control.
//! A window is identified by its exact HWND plus owning process, class and geometry.
use crate::protocol::Bounds;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::time::{Duration, Instant};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW,
    GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, GA_ROOTOWNER, GWL_EXSTYLE,
    WS_EX_TOOLWINDOW,
};

/// Packaged (UWP) apps draw inside a frame window owned by this host process.
const FRAME_HOST: &str = "ApplicationFrameHost.exe";

#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub id: u32,
    pub pid: u32,
    pub app: String,
    pub class: String,
    pub title: String,
    pub bounds: Bounds,
}

impl Window {
    pub fn hwnd(&self) -> HWND {
        hwnd(self.id)
    }
}

pub fn hwnd(id: u32) -> HWND {
    HWND(id as usize as *mut c_void)
}

fn window_id(hwnd: HWND) -> Option<u32> {
    u32::try_from(hwnd.0 as usize).ok().filter(|id| *id > 0)
}

fn wide_text(buffer: &[u16], length: i32) -> String {
    String::from_utf16_lossy(&buffer[..length.clamp(0, buffer.len() as i32) as usize])
}

fn title(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    wide_text(&buffer, length)
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    wide_text(&buffer, length)
}

fn owner_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// Visible frame in physical pixels, excluding the invisible resize border.
pub fn frame_bounds(hwnd: HWND) -> Result<Bounds, String> {
    let mut rect = RECT::default();
    let frame = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if frame.is_err() {
        unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|error| error.to_string())?;
    }
    rect_bounds(rect).ok_or_else(|| "Target window has invalid geometry; observe again".into())
}

pub fn rect_bounds(rect: RECT) -> Option<Bounds> {
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    (width > 0 && height > 0).then_some(Bounds {
        x: rect.left as f64,
        y: rect.top as f64,
        width: width as f64,
        height: height as f64,
    })
}

fn cloaked(hwnd: HWND) -> bool {
    let mut value = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut value as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    }
    .is_ok()
        && value != 0
}

pub fn process_path(pid: u32) -> Result<String, String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|error| format!("Cannot inspect process {pid}: {error}"))?;
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(process);
        result.map_err(|error| format!("Cannot read process {pid} executable: {error}"))?;
        Ok(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> BOOL {
    unsafe { (*(list.0 as *mut Vec<HWND>)).push(hwnd) };
    true.into()
}

fn top_level_windows() -> Result<Vec<HWND>, String> {
    let mut list: Vec<HWND> = Vec::new();
    unsafe { EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize)) }
        .map_err(|error| format!("Cannot enumerate windows: {error}"))?;
    Ok(list)
}

/// Packaged app content runs in a child window of a different process.
fn app_process(hwnd: HWND, pid: u32) -> Result<(u32, String), String> {
    let path = process_path(pid)?;
    if !file_name(&path).eq_ignore_ascii_case(FRAME_HOST) {
        return Ok((pid, path));
    }
    let mut children: Vec<HWND> = Vec::new();
    let _ = unsafe {
        EnumChildWindows(
            Some(hwnd),
            Some(collect),
            LPARAM(&mut children as *mut Vec<HWND> as isize),
        )
    };
    for child in children {
        let child_pid = owner_pid(child);
        if child_pid != 0 && child_pid != pid {
            return Ok((child_pid, process_path(child_pid)?));
        }
    }
    Ok((pid, path))
}

fn eligible(hwnd: HWND) -> bool {
    let shown = unsafe {
        IsWindowVisible(hwnd).as_bool()
            && !IsIconic(hwnd).as_bool()
            && GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 == 0
    };
    shown && !cloaked(hwnd) && owner_pid(hwnd) != std::process::id() && frame_bounds(hwnd).is_ok()
}

fn describe(hwnd: HWND) -> Result<Window, String> {
    let id = window_id(hwnd).ok_or("Window handle is outside the supported identifier range")?;
    let (pid, app) = app_process(hwnd, owner_pid(hwnd))?;
    Ok(Window {
        id,
        pid,
        app,
        class: class_name(hwnd),
        title: title(hwnd),
        bounds: frame_bounds(hwnd)?,
    })
}

/// Current facts of one exact window; never substitutes another window.
pub fn snapshot(id: u32) -> Result<Window, String> {
    let handle = hwnd(id);
    unsafe {
        if !IsWindow(Some(handle)).as_bool() {
            return Err("Target window is closed or unavailable; observe again".into());
        }
        if IsIconic(handle).as_bool() {
            return Err("Target window is minimized; restore it, then observe again".into());
        }
        if !IsWindowVisible(handle).as_bool() || cloaked(handle) {
            return Err("Target window is hidden or off-screen; observe again".into());
        }
    }
    describe(handle)
}

fn listed() -> Result<Vec<Window>, String> {
    Ok(top_level_windows()?
        .into_iter()
        .filter(|hwnd| eligible(*hwnd))
        .filter_map(|hwnd| describe(hwnd).ok())
        .collect())
}

pub fn windows_json() -> Result<Value, String> {
    let windows: Vec<Value> = listed()?
        .into_iter()
        .map(|window| {
            json!({"windowId":window.id,"pid":window.pid,"app":window.app,"owner":file_name(&window.app),
                "title":window.title,"className":window.class,"bounds":super::rect_json(window.bounds)})
        })
        .collect();
    Ok(json!({"windows":windows}))
}

pub fn applications() -> Result<Value, String> {
    let mut apps: BTreeMap<String, (String, Vec<u32>)> = BTreeMap::new();
    for window in listed()? {
        let entry = apps
            .entry(window.app.to_ascii_lowercase())
            .or_insert_with(|| (window.app.clone(), Vec::new()));
        if !entry.1.contains(&window.pid) {
            entry.1.push(window.pid);
        }
    }
    let applications: Vec<Value> = apps
        .into_values()
        .map(|(app, pids)| {
            let name = file_name(&app);
            let name = name
                .strip_suffix(".exe")
                .or_else(|| name.strip_suffix(".EXE"))
                .unwrap_or(name);
            json!({"app":app,"name":name,"pids":pids})
        })
        .collect();
    Ok(json!({"applications":applications}))
}

/// On Windows an app is identified by its full executable path from listApps.
pub fn normalize_app(app: &str) -> Result<String, String> {
    let app = app.trim().replace('/', "\\");
    let absolute = app.len() > 3 && app.as_bytes()[1] == b':' && app.as_bytes()[2] == b'\\'
        || app.starts_with("\\\\");
    if !absolute {
        return Err(
            "On Windows, app is the full executable path from listApps, e.g. C:\\Windows\\System32\\notepad.exe"
                .into(),
        );
    }
    Ok(app)
}

pub fn same_app(left: &str, right: &str) -> bool {
    left.replace('/', "\\")
        .eq_ignore_ascii_case(&right.replace('/', "\\"))
}

/// App-only observe uses the app's foreground window or its only window.
pub fn app_window(app: &str) -> Result<Window, String> {
    let windows: Vec<Window> = listed()?
        .into_iter()
        .filter(|window| same_app(&window.app, app))
        .collect();
    let foreground = window_id(unsafe { GetForegroundWindow() });
    if let Some(window) = windows.iter().find(|window| Some(window.id) == foreground) {
        return Ok(window.clone());
    }
    match windows.len() {
        1 => Ok(windows.into_iter().next().expect("one window")),
        0 => Err(format!(
            "Application has no visible window: {app}. Use listApps/listWindows to choose a running app."
        )),
        count => Err(format!(
            "Application has {count} windows; pass an exact windowId from listWindows"
        )),
    }
}

fn token_integrity(process: HANDLE) -> Option<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
        let mut buffer = vec![0u8; needed.max(64) as usize];
        let read = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr().cast()),
            buffer.len() as u32,
            &mut needed,
        );
        let _ = CloseHandle(token);
        read.ok()?;
        let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        Some(*GetSidSubAuthority(
            label.Label.Sid,
            count.checked_sub(1)? as u32,
        ))
    }
}

pub fn own_integrity() -> Option<u32> {
    token_integrity(unsafe { GetCurrentProcess() })
}

fn process_integrity(pid: u32) -> Option<u32> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let level = token_integrity(process);
        let _ = CloseHandle(process);
        level
    }
}

pub fn integrity_name(level: Option<u32>) -> &'static str {
    match level {
        None => "unknown",
        Some(level) if level >= 0x4000 => "system",
        Some(level) if level >= 0x3000 => "high",
        Some(level) if level >= 0x2000 => "medium",
        Some(level) if level >= 0x1000 => "low",
        Some(_) => "untrusted",
    }
}

/// Windows silently drops UI Automation actions and input aimed at a higher
/// integrity level, so report it instead of claiming an unconfirmed effect.
pub fn ensure_controllable(window: &Window) -> Result<(), String> {
    match (own_integrity(), process_integrity(window.pid)) {
        (Some(own), Some(target)) if target > own => Err(format!(
            "{} runs at {} integrity (for example as administrator); this {} integrity helper cannot observe its controls or send it input. Run the target without elevation.",
            file_name(&window.app),
            integrity_name(Some(target)),
            integrity_name(Some(own))
        )),
        _ => Ok(()),
    }
}

/// Bring exactly this window to the foreground, or report why it is not.
pub fn focus(window: &Window) -> Result<(), String> {
    if activate(window.hwnd(), Duration::from_secs(2)) {
        return Ok(());
    }
    Err("Observed window did not become the foreground window; Windows may block focus changes. Bring it to the front, then observe again.".into())
}

fn activate(target: HWND, wait: Duration) -> bool {
    unsafe {
        if GetForegroundWindow() == target {
            return true;
        }
        // Windows limits foreground changes; sharing the current foreground thread's
        // input state lets an explicitly requested switch succeed.
        let current = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let own = GetCurrentThreadId();
        let attached =
            current != 0 && current != own && AttachThreadInput(own, current, true).as_bool();
        let _ = BringWindowToTop(target);
        let _ = SetForegroundWindow(target);
        if attached {
            let _ = AttachThreadInput(own, current, false);
        }
    }
    let started = Instant::now();
    while started.elapsed() < wait {
        if unsafe { GetForegroundWindow() } == target {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn last_input_tick() -> u32 {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    let _ = unsafe { GetLastInputInfo(&mut info) };
    info.dwTime
}

/// Foreground state before a background action. Background UI Automation must not
/// move the user's work: some apps (Chrome, for example) activate themselves when a
/// control is invoked or focused. Only a change made by the target app is undone,
/// never one made by the user, and the fact is reported either way.
pub struct ForegroundGuard {
    previous: HWND,
    input_tick: u32,
}

impl ForegroundGuard {
    pub fn capture() -> Self {
        Self {
            previous: unsafe { GetForegroundWindow() },
            input_tick: last_input_tick(),
        }
    }

    /// None when the foreground window is unchanged.
    pub fn restore(&self, target: &Window) -> Option<Value> {
        let current = unsafe { GetForegroundWindow() };
        if current == self.previous {
            return None;
        }
        let root = unsafe { GetAncestor(current, GA_ROOTOWNER) };
        let by_target = current == target.hwnd()
            || root == target.hwnd()
            || owner_pid(current) == target.pid
            || owner_pid(root) == target.pid;
        let mut fact = json!({"previousWindowId":window_id(self.previous),
            "foregroundWindowId":window_id(current),"byTarget":by_target,"restored":false});
        let reason = if !by_target {
            Some("another application became the foreground window")
        } else if last_input_tick() != self.input_tick {
            Some("user input occurred during the action")
        } else if self.previous.is_invalid() || !unsafe { IsWindow(Some(self.previous)) }.as_bool()
        {
            Some("the previous foreground window no longer exists")
        } else {
            None
        };
        match reason {
            Some(reason) => fact["reason"] = json!(reason),
            None => {
                let restored = activate(self.previous, Duration::from_millis(500));
                fact["restored"] = json!(restored);
                if !restored {
                    fact["reason"] =
                        json!("Windows rejected returning the previous window to the foreground");
                }
            }
        }
        Some(fact)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apps_are_full_paths_compared_without_case() {
        assert_eq!(
            normalize_app("c:/Windows/System32/notepad.exe").unwrap(),
            "c:\\Windows\\System32\\notepad.exe"
        );
        assert!(normalize_app("notepad.exe").is_err());
        assert!(normalize_app("com.google.Chrome").is_err());
        assert!(same_app(
            "C:\\Windows\\notepad.exe",
            "c:/windows/NOTEPAD.EXE"
        ));
        assert!(!same_app("C:\\a\\notepad.exe", "C:\\b\\notepad.exe"));
    }

    #[test]
    fn integrity_levels_are_named_by_rid() {
        assert_eq!(integrity_name(Some(0x2000)), "medium");
        assert_eq!(integrity_name(Some(0x3000)), "high");
        assert_eq!(integrity_name(None), "unknown");
        assert_ne!(integrity_name(own_integrity()), "unknown");
    }

    #[test]
    fn listed_windows_resolve_to_exact_snapshots() {
        let windows = listed().unwrap();
        for window in windows.iter().take(5) {
            assert!(std::path::Path::new(&window.app).is_absolute());
            if let Ok(current) = snapshot(window.id) {
                assert_eq!(current.pid, window.pid);
            }
        }
        assert!(snapshot(0xffff_fff0).is_err());
    }
}
