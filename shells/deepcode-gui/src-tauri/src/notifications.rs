use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const WINDOW: &str = "completion-reminder";
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    session_id: String,
    title: String,
    body: String,
    open_label: String,
    dismiss_label: String,
}

fn show_if_background(app: &tauri::AppHandle, reminder: Reminder) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("main_window_unavailable")?;
    #[cfg(target_os = "macos")]
    if objc2_app_kit::NSApplication::sharedApplication(
        objc2::MainThreadMarker::new().ok_or("completion_requires_main_thread")?,
    )
    .isActive()
        && main.is_visible().map_err(|error| error.to_string())?
        && !main.is_minimized().map_err(|error| error.to_string())?
    {
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    for (label, window) in app.webview_windows() {
        if label != WINDOW && window.is_focused().map_err(|error| error.to_string())? {
            return Ok(());
        }
    }
    let monitor = main
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("completion_monitor_unavailable")?;
    let mut url: tauri::Url = format!("{}://localhost/completion.html", crate::APP_ASSET_SCHEME)
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut().extend_pairs([
        ("session", reminder.session_id),
        ("title", reminder.title),
        ("body", reminder.body),
        ("open", reminder.open_label),
        ("dismiss", reminder.dismiss_label),
    ]);
    let window = if let Some(window) = app.get_webview_window(WINDOW) {
        window.navigate(url).map_err(|error| error.to_string())?;
        window
    } else {
        let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
            .title("DeepCode")
            .inner_size(360.0, 116.0)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .focused(false)
            .visible(false)
            .on_navigation(crate::trusted_app_navigation);
        #[cfg(feature = "debug-control")]
        let builder = builder.initialization_script_for_all_frames(
            crate::native_browser::debug::initialization_script(),
        );
        builder.build().map_err(|error| error.to_string())?
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let margin = (20.0 * scale) as i32;
    window
        .set_position(PhysicalPosition::new(
            area.position.x + area.size.width as i32 - size.width as i32 - margin,
            area.position.y + area.size.height as i32 - size.height as i32 - margin,
        ))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_secs(8));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if GENERATION.load(Ordering::SeqCst) == generation {
                if let Some(window) = handle.get_webview_window(WINDOW) {
                    if let Err(error) = window.hide() {
                        eprintln!("completion_reminder_hide: {error}");
                    }
                }
            }
        });
    });
    Ok(())
}

/// GUI presentation only: the caller observes the canonical completed run.
#[tauri::command]
pub async fn deepcode_notify_completed(
    app: tauri::AppHandle,
    reminder: Reminder,
) -> Result<(), String> {
    // Audio is independent of popup delivery and never depends on notification permission.
    let sound = tauri::async_runtime::spawn_blocking(crate::completion_sound::play);
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.try_send(show_if_background(&handle, reminder));
    })
    .map_err(|error| error.to_string())?;
    let popup = receiver.recv().await.ok_or("completion_callback_closed")?;
    let audio = sound.await.map_err(|error| error.to_string())?;
    match (audio, popup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(audio), Err(popup)) => Err(format!("{audio}; {popup}")),
    }
}

#[tauri::command]
pub fn deepcode_dismiss_completion(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn deepcode_open_completion(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("main_window_unavailable")?;
    app.emit_to("main", "deepcode:completion-open", session_id)
        .map_err(|error| error.to_string())?;
    main.unminimize().map_err(|error| error.to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}
