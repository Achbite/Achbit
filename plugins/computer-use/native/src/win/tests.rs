use super::*;
use std::sync::mpsc;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

pub(super) fn initialize() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match message {
        WM_COMMAND if w.0 & 0xffff == 100 => {
            let other = HWND(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut _);
            let _ = SetForegroundWindow(other);
            LRESULT(0)
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}

pub(super) struct Fixture {
    pub target: u32,
    pub other: u32,
    owner: Option<std::thread::JoinHandle<()>>,
}

impl Fixture {
    pub fn open(children: usize) -> Self {
        let (tx, rx) = mpsc::channel();
        let owner = std::thread::spawn(move || unsafe {
            windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            );
            let instance = GetModuleHandleW(None).unwrap();
            let class = w!("Achbit.UIA.Regression.Window");
            assert_ne!(
                RegisterClassW(&WNDCLASSW {
                    hInstance: instance.into(),
                    lpszClassName: class,
                    lpfnWndProc: Some(window_proc),
                    ..Default::default()
                }),
                0
            );
            let target = CreateWindowExW(
                Default::default(),
                class,
                w!("Achbit UIA regression target"),
                WS_OVERLAPPEDWINDOW,
                100,
                100,
                600,
                400,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap();
            let other = CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("Achbit focus destination"),
                WS_OVERLAPPEDWINDOW,
                760,
                120,
                450,
                300,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap();
            SetWindowLongPtrW(target, GWLP_USERDATA, other.0 as isize);
            CreateWindowExW(
                Default::default(),
                w!("BUTTON"),
                w!("Switch foreground"),
                WS_CHILD | WS_VISIBLE,
                25,
                25,
                220,
                40,
                Some(target),
                Some(HMENU(100 as *mut _)),
                Some(instance.into()),
                None,
            )
            .unwrap();
            for index in 0..children {
                let title: Vec<u16> = format!("Child {index}\0").encode_utf16().collect();
                CreateWindowExW(
                    Default::default(),
                    w!("BUTTON"),
                    PCWSTR(title.as_ptr()),
                    WS_CHILD | WS_VISIBLE,
                    25,
                    80 + index as i32 * 22,
                    200,
                    20,
                    Some(target),
                    None,
                    Some(instance.into()),
                    None,
                )
                .unwrap();
            }
            let _ = ShowWindow(other, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(target, SW_SHOWNOACTIVATE);
            tx.send((target.0 as usize as u32, other.0 as usize as u32))
                .unwrap();
            let mut event = MSG::default();
            while GetMessageW(&mut event, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&event);
                DispatchMessageW(&event);
            }
            let _ = DestroyWindow(other);
            UnregisterClassW(class, Some(instance.into())).unwrap();
        });
        let (target, other) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        Self {
            target,
            other,
            owner: Some(owner),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe {
            PostMessageW(
                Some(desktop::hwnd(self.target)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            )
        }
        .unwrap();
        self.owner.take().unwrap().join().unwrap();
    }
}

#[test]
#[ignore = "requires an interactive Windows desktop, UI Automation and WGC"]
fn post_action_observation_does_not_reactivate_but_next_input_restores_focus() {
    initialize();
    let fixture = Fixture::open(0);
    let window = desktop::snapshot(fixture.target).unwrap();
    let sharing = Arc::new(sharing::Sharing::default());
    let mut executor = Executor::new(protocol::instance_name().unwrap(), sharing.clone()).unwrap();
    let archive = std::env::temp_dir().join(format!(
        "achbit-focus-test-{}",
        protocol::timestamp_millis().unwrap()
    ));
    std::fs::create_dir(&archive).unwrap();
    let binding =
        json!({"hostInstanceId":"host:test","sessionId":"session:focus","runId":"run:focus"});
    let observation = executor
        .execute(
            &binding,
            &json!({"action":"observe","app":window.app,
        "windowId":window.id,"mode":"foreground","captureDirectory":archive}),
        )
        .unwrap();
    assert_eq!(unsafe { GetForegroundWindow() }, window.hwnd());
    let button = observation["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|element| element["title"] == "Switch foreground")
        .unwrap();
    let bounds = &button["bounds"];
    let result = executor
        .execute(
            &binding,
            &json!({"action":"click","app":window.app,
        "observationId":observation["observationId"],"captureDirectory":archive,
        "x":bounds["x"].as_f64().unwrap()+bounds["width"].as_f64().unwrap()/2.,
        "y":bounds["y"].as_f64().unwrap()+bounds["height"].as_f64().unwrap()/2.}),
        )
        .unwrap();
    assert_eq!(result["dispatched"], true);
    assert!(result.get("observationError").is_none(), "{result}");
    assert_eq!(result["mode"], "foreground");
    assert_eq!(
        unsafe { GetForegroundWindow() },
        desktop::hwnd(fixture.other),
        "reading the action result must not reactivate the original window"
    );
    let next = executor
        .execute(
            &binding,
            &json!({"action":"key","key":"tab","app":window.app,
        "observationId":result["observationId"],"captureDirectory":archive}),
        )
        .unwrap();
    assert_eq!(next["dispatched"], true);
    assert!(next.get("observationError").is_none(), "{next}");
    assert_eq!(
        unsafe { GetForegroundWindow() },
        window.hwnd(),
        "the next foreground input must restore its target"
    );
    executor
        .execute(&binding, &json!({"action":"releaseRun"}))
        .unwrap();
    sharing.shutdown().unwrap();
    std::fs::remove_dir_all(archive).unwrap();
}
