use super::super::sharing::Sharing;
use super::*;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::time::Instant;
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::*;

#[test]
fn stopped_capture_drops_pixels_and_rejects_late_callbacks() {
    let frame = || Frame {
        image: Image {
            width: 1,
            height: 1,
            rgb: vec![1, 2, 3],
        },
        captured_at: "now".into(),
        sequence: 1,
        window: Window {
            id: 1,
            pid: 2,
            app: "app".into(),
            class: "class".into(),
            title: "title".into(),
            bounds: protocol::Bounds {
                x: 0.,
                y: 0.,
                width: 1.,
                height: 1.,
            },
        },
    };
    let mut latest = Latest::default();
    latest.publish(frame());
    assert!(latest.frame.is_some());
    latest.stop(Some("original capture error".into()));
    latest.publish(frame());
    latest.stop(Some("later cleanup error".into()));
    assert!(latest.frame.is_none());
    assert_eq!(latest.error.as_deref(), Some("original capture error"));
}

#[test]
fn bgra_readback_respects_gpu_row_padding() {
    let mut bytes = [
        3u8, 2, 1, 255, 6, 5, 4, 255, 99, 99, 99, 99, 9, 8, 7, 255, 12, 11, 10, 255, 99, 99, 99, 99,
    ];
    let mut mapped = D3D11_MAPPED_SUBRESOURCE {
        pData: bytes.as_mut_ptr().cast(),
        RowPitch: 12,
        DepthPitch: 24,
    };
    let size = SizeInt32 {
        Width: 2,
        Height: 2,
    };
    assert_eq!(
        read_pixels(&mapped, size).unwrap().rgb,
        (1..=12).collect::<Vec<_>>()
    );
    mapped.RowPitch = 4;
    assert!(read_pixels(&mapped, size).is_err());
}

const PAINT_VARIANT: u32 = WM_APP + 1;

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe {
        match message {
            PAINT_VARIANT => {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, w.0 as isize);
                let _ = InvalidateRect(Some(hwnd), None, false);
                let _ = UpdateWindow(hwnd);
                LRESULT(0)
            }
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                let mut rect = RECT::default();
                let _ = GetClientRect(hwnd, &mut rect);
                let variant = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
                let colors = if variant == 2 {
                    [0x00ffff00; 4]
                } else {
                    [
                        if variant == 1 { 0x00ff00ff } else { 0x000000ff },
                        0x0000ff00,
                        0x00ff0000,
                        0x0000ffff,
                    ]
                };
                for (index, color) in colors.into_iter().enumerate() {
                    let half_x = rect.right / 2;
                    let half_y = rect.bottom / 2;
                    let part = RECT {
                        left: if index % 2 == 0 { 0 } else { half_x },
                        right: if index % 2 == 0 { half_x } else { rect.right },
                        top: if index < 2 { 0 } else { half_y },
                        bottom: if index < 2 { half_y } else { rect.bottom },
                    };
                    let brush = CreateSolidBrush(COLORREF(color));
                    FillRect(dc, &part, brush);
                    let _ = DeleteObject(brush.into());
                }
                let _ = EndPaint(hwnd, &paint);
                LRESULT(0)
            }
            WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                if GetWindowLongPtrW(hwnd, GWLP_USERDATA) != 2 {
                    PostQuitMessage(0);
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, w, l),
        }
    }
}

struct TestWindow {
    id: u32,
    cover: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestWindow {
    fn open() -> Self {
        let (send, receive) = mpsc::channel();
        let thread = std::thread::spawn(move || unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let instance = GetModuleHandleW(None).unwrap();
            let class = w!("DeepCode.Wgc.Test.Window");
            assert_ne!(
                RegisterClassW(&WNDCLASSW {
                    hInstance: instance.into(),
                    lpszClassName: class,
                    lpfnWndProc: Some(window_proc),
                    style: CS_HREDRAW | CS_VREDRAW,
                    ..Default::default()
                }),
                0
            );
            let target = CreateWindowExW(
                WS_EX_NOACTIVATE,
                class,
                w!("DeepCode WGC verification"),
                WS_OVERLAPPEDWINDOW,
                100,
                100,
                480,
                320,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap();
            let cover = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                class,
                w!("WGC occlusion fixture"),
                WS_POPUP,
                90,
                90,
                510,
                350,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .unwrap();
            SetWindowLongPtrW(cover, GWLP_USERDATA, 2);
            let _ = ShowWindow(target, SW_SHOWNOACTIVATE);
            let _ = UpdateWindow(target);
            send.send((
                u32::try_from(target.0 as usize).unwrap(),
                u32::try_from(cover.0 as usize).unwrap(),
            ))
            .unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = DestroyWindow(cover);
            UnregisterClassW(class, Some(instance.into())).unwrap();
        });
        let (id, cover) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        Self {
            id,
            cover,
            thread: Some(thread),
        }
    }
    fn window(&self) -> Window {
        desktop::snapshot(self.id).unwrap()
    }
    fn paint(&self, variant: usize) {
        unsafe {
            SendMessageW(
                desktop::hwnd(self.id),
                PAINT_VARIANT,
                Some(WPARAM(variant)),
                None,
            );
        }
    }
    fn sample_point(&self) -> (f64, f64) {
        let mut client = RECT::default();
        unsafe { GetClientRect(desktop::hwnd(self.id), &mut client) }.unwrap();
        let mut point = POINT {
            x: client.right / 4,
            y: client.bottom / 4,
        };
        assert!(unsafe { ClientToScreen(desktop::hwnd(self.id), &mut point) }.as_bool());
        (point.x as f64, point.y as f64)
    }
    fn close(&mut self) {
        if let Some(thread) = self.thread.take() {
            unsafe { PostMessageW(Some(desktop::hwnd(self.id)), WM_CLOSE, WPARAM(0), LPARAM(0)) }
                .unwrap();
            thread.join().unwrap();
        }
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        self.close();
    }
}

fn pixel(frame: &Frame, point: (f64, f64)) -> &[u8] {
    let x = ((point.0 - frame.window.bounds.x) / frame.window.bounds.width
        * f64::from(frame.image.width)) as usize;
    let y = ((point.1 - frame.window.bounds.y) / frame.window.bounds.height
        * f64::from(frame.image.height)) as usize;
    let index = (y * frame.image.width as usize + x) * 3;
    &frame.image.rgb[index..index + 3]
}

#[track_caller]
fn eventually(mut check: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(5);
    while !check() {
        assert!(
            Instant::now() < until,
            "WGC condition did not become true within 5 seconds"
        );
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Exercise the production execute/preview sockets and run cleanup against the
/// built helper, using only our own fixture window and temporary archive.
fn helper_capture_and_release(window: &Window) {
    struct OwnedHelper(Child, std::path::PathBuf);
    impl Drop for OwnedHelper {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }
    let executable = std::env::var_os("DEEPCODE_TEST_COMPUTER_USE_HELPER")
        .expect("set DEEPCODE_TEST_COMPUTER_USE_HELPER to the built Windows helper");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let archive = std::env::temp_dir().join(format!(
        "deepcode-wgc-{}-{}",
        std::process::id(),
        protocol::timestamp_millis().unwrap()
    ));
    std::fs::create_dir(&archive).unwrap();
    let mut helper = OwnedHelper(
        Command::new(executable)
            .args([
                "--connect",
                &address,
                "--token",
                "wgc-test-token",
                "--host",
                "host:wgc-test",
            ])
            .creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0)
            .spawn()
            .unwrap(),
        archive,
    );
    let started = Instant::now();
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    helper.0.try_wait().unwrap().is_none(),
                    "helper exited before handshake"
                );
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "helper handshake timed out"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("{error}"),
        }
    };
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut connection = BufReader::new(stream);
    let read = |connection: &mut BufReader<TcpStream>| {
        let mut line = String::new();
        assert!(connection.read_line(&mut line).unwrap() > 0);
        serde_json::from_str::<serde_json::Value>(&line).unwrap()
    };
    let handshake = read(&mut connection);
    assert_eq!(handshake["token"], "wgc-test-token");
    let binding = json!({"hostInstanceId":"host:wgc-test","sessionId":"session:helper-test","runId":"run:capture"});
    let preview = || {
        let mut socket =
            TcpStream::connect(handshake["previewEndpoint"].as_str().unwrap()).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        writeln!(socket, "{}", json!({"token":"wgc-test-token","binding":binding,"input":{"action":"computer:preview"}})).unwrap();
        read(&mut BufReader::new(socket))
    };
    assert_eq!(preview()["data"]["state"], "inactive");
    writeln!(
        connection.get_mut(),
        "{}",
        json!({"binding":binding,"input":{
        "action":"computer:capture","windowId":window.id,"captureDirectory":helper.1}})
    )
    .unwrap();
    let captured = read(&mut connection);
    assert_eq!(captured["ok"], true, "{captured}");
    assert!(std::path::Path::new(captured["data"]["contentRef"].as_str().unwrap()).is_file());
    let active = preview();
    assert_eq!(active["data"]["state"], "active", "{active}");
    assert_eq!(active["data"]["target"]["windowId"], window.id);
    assert!(active["data"]["frame"].is_object());
    writeln!(
        connection.get_mut(),
        "{}",
        json!({"binding":binding,"input":{"action":"computer:releaseRun"}})
    )
    .unwrap();
    assert_eq!(read(&mut connection)["data"]["released"], true);
    assert_eq!(preview()["data"], json!({"state":"inactive"}));
    connection.get_mut().shutdown(Shutdown::Both).unwrap();
    eventually(|| helper.0.try_wait().unwrap().is_some());
    assert!(helper.0.wait().unwrap().success());
    eprintln!(
        "Built helper: capture archive, independent preview, releaseRun and EOF cleanup verified"
    );
}

#[test]
#[ignore = "requires an interactive Windows desktop and a D3D11 capture device"]
fn real_window_capture_preview_pointer_and_release() {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let mut fixture = TestWindow::open();
    let window = fixture.window();
    let point = fixture.sample_point();
    let capture = Capture::start(&window, 1600).unwrap();
    let initial = capture.latest().unwrap().unwrap();
    assert_eq!(
        (initial.image.width as f64, initial.image.height as f64),
        (window.bounds.width, window.bounds.height),
        "WGC pixels must match physical target bounds"
    );
    assert_eq!(pixel(&initial, point), [255, 0, 0]);
    eprintln!(
        "WGC initial frame: {}x{}, physical bounds: {:?}",
        initial.image.width, initial.image.height, window.bounds
    );
    unsafe {
        let _ = ShowWindow(desktop::hwnd(fixture.cover), SW_SHOWNOACTIVATE);
        let _ = UpdateWindow(desktop::hwnd(fixture.cover));
    }
    assert_eq!(
        pixel(&snapshot(&window).unwrap(), point),
        [255, 0, 0],
        "occlusion must not replace the exact target with desktop pixels"
    );
    fixture.paint(1);
    eventually(|| {
        capture
            .latest()
            .unwrap()
            .is_some_and(|frame| pixel(&frame, point) == [255, 0, 255])
    });
    // A final repaint immediately after another update must not be dropped by throttling.
    fixture.paint(0);
    eventually(|| {
        capture
            .latest()
            .unwrap()
            .is_some_and(|frame| pixel(&frame, point) == [255, 0, 0])
    });
    eprintln!("WGC continued repainting the exact target while covered");
    let sharing = Sharing::default();
    let binding = json!({"hostInstanceId":"host:test","sessionId":"session:test","runId":"run:1"});
    assert_eq!(
        sharing.preview(&binding, None).unwrap()["state"],
        "inactive"
    );
    let generation = sharing.ensure(&binding, &window).unwrap();
    sharing.point(&binding, &window, point).unwrap();
    let first = sharing.preview(&binding, None).unwrap();
    assert_eq!(first["state"], "active");
    assert_eq!(first["target"]["generation"], generation);
    assert!(first["frame"]["dataUrl"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert_eq!(
        first["pointer"]["x"],
        (point.0 - window.bounds.x) / window.bounds.width
    );
    let delta = sharing
        .preview(&binding, first["frame"]["sequence"].as_u64())
        .unwrap();
    assert!(
        delta["frame"].is_null() || delta["frame"]["sequence"] != first["frame"]["sequence"],
        "an incremental preview sends no duplicate frame"
    );
    std::thread::sleep(Duration::from_millis(450));
    let later = sharing.preview(&binding, None).unwrap();
    assert_eq!(
        later["pointer"]["x"], first["pointer"]["x"],
        "action location persists between calls"
    );
    assert_eq!(later["pointer"]["pulse"], false);
    let mut another = binding.clone();
    another["runId"] = json!("run:2");
    sharing.ensure(&another, &window).unwrap();
    sharing.release(&binding).unwrap();
    assert_eq!(
        sharing.preview(&binding, None).unwrap()["state"],
        "inactive"
    );
    assert_eq!(sharing.preview(&another, None).unwrap()["state"], "active");
    assert!(sharing.validate(&binding, &window, generation).is_err());
    let next_generation = sharing.ensure(&binding, &window).unwrap();
    assert_ne!(next_generation, generation);
    assert!(sharing.validate(&binding, &window, generation).is_err());
    assert!(sharing.preview(&binding, None).unwrap()["pointer"].is_null());
    let cover = desktop::snapshot(fixture.cover).unwrap();
    let switched_generation = sharing.ensure(&binding, &cover).unwrap();
    let switched = sharing.preview(&binding, None).unwrap();
    assert_eq!(switched["target"]["windowId"], cover.id);
    assert_ne!(switched_generation, next_generation);
    assert!(
        switched["frame"]["sequence"].as_u64().unwrap()
            > first["frame"]["sequence"].as_u64().unwrap()
    );
    assert!(sharing
        .validate(&binding, &window, next_generation)
        .is_err());
    assert!(sharing
        .activate(
            &binding,
            &json!({"windowId":window.id,"generation":next_generation})
        )
        .is_err());
    sharing.ensure(&binding, &window).unwrap();
    eprintln!("Preview pointer persisted; exact run release and new generation verified");
    unsafe {
        SetWindowPos(
            desktop::hwnd(fixture.id),
            None,
            120,
            140,
            580,
            360,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
    }
    .unwrap();
    let resized = fixture.window();
    eprintln!(
        "Window bounds immediately after resize: {:?}",
        resized.bounds
    );
    let mut last_size = (initial.image.width, initial.image.height);
    eventually(|| {
        capture.latest().unwrap().is_some_and(|frame| {
            let size = (frame.image.width, frame.image.height);
            if last_size != size {
                eprintln!(
                    "WGC resized frame: {size:?}, frame bounds: {:?}, current bounds: {:?}",
                    frame.window.bounds,
                    fixture.window().bounds
                );
                last_size = size;
            }
            frame.window.bounds == resized.bounds
                && frame.image.width as f64 == resized.bounds.width
                && frame.image.height as f64 == resized.bounds.height
        })
    });
    assert_eq!(
        pixel(&capture.latest().unwrap().unwrap(), fixture.sample_point()),
        [255, 0, 0]
    );
    capture.stop().unwrap();
    assert!(capture.latest().is_err());
    helper_capture_and_release(&fixture.window());
    fixture.close();
    eventually(|| sharing.preview(&binding, None).unwrap()["state"] == "failed");
    let failed = sharing.preview(&binding, None).unwrap();
    assert!(failed["frame"].is_null() && failed["pointer"].is_null());
    sharing.shutdown().unwrap();
    assert_eq!(
        sharing.preview(&another, None).unwrap(),
        json!({"state":"inactive"})
    );
}
