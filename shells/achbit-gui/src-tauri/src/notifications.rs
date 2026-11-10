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
    #[serde(default)]
    foreground_sound: bool,
}

fn is_foreground(app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    let main = app.get_window("main").ok_or("main_window_unavailable")?;
    #[cfg(target_os = "macos")]
    if objc2_app_kit::NSApplication::sharedApplication(
        objc2::MainThreadMarker::new().ok_or("completion_requires_main_thread")?,
    )
    .isActive()
        && main.is_visible().map_err(|error| error.to_string())?
        && !main.is_minimized().map_err(|error| error.to_string())?
    {
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    for (label, window) in app.windows() {
        if label != WINDOW && window.is_focused().map_err(|error| error.to_string())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn completion_delivery(foreground: bool, foreground_sound: bool) -> (bool, bool) {
    (!foreground || foreground_sound, !foreground)
}

fn reminder_url(reminder: &Reminder) -> Result<tauri::Url, String> {
    // WebView2 rewrites custom protocols only during creation, not navigate().
    // Use the same navigable origin for the first and subsequent reminders.
    let origin = if cfg!(windows) {
        format!("http://{}.localhost", crate::APP_ASSET_SCHEME)
    } else {
        format!("{}://localhost", crate::APP_ASSET_SCHEME)
    };
    let mut url = format!("{origin}/completion.html")
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut().extend_pairs([
        ("session", &reminder.session_id),
        ("title", &reminder.title),
        ("body", &reminder.body),
        ("open", &reminder.open_label),
        ("dismiss", &reminder.dismiss_label),
    ]);
    Ok(url)
}

fn show_reminder(app: &tauri::AppHandle, reminder: Reminder) -> Result<(), String> {
    let main = app.get_window("main").ok_or("main_window_unavailable")?;
    let monitor = main
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("completion_monitor_unavailable")?;
    let url = reminder_url(&reminder)?;
    let window = if let Some(window) = app.get_webview_window(WINDOW) {
        window.navigate(url).map_err(|error| error.to_string())?;
        window
    } else {
        let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
            .title("Achbit")
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
pub async fn achbit_notify_completed(
    app: tauri::AppHandle,
    reminder: Reminder,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = is_foreground(&handle).map(|foreground| {
            let (play_sound, show_popup) =
                completion_delivery(foreground, reminder.foreground_sound);
            let popup = if show_popup {
                show_reminder(&handle, reminder)
            } else {
                Ok(())
            };
            (play_sound, popup)
        });
        let _ = sender.try_send(result);
    })
    .map_err(|error| error.to_string())?;
    let (play_sound, popup) = receiver
        .recv()
        .await
        .ok_or("completion_callback_closed")??;
    // Popup failures do not suppress an independently requested sound.
    let audio = if play_sound {
        tauri::async_runtime::spawn_blocking(crate::completion_sound::play)
            .await
            .map_err(|error| error.to_string())?
    } else {
        Ok(())
    };
    match (audio, popup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(audio), Err(popup)) => Err(format!("{audio}; {popup}")),
    }
}

#[tauri::command]
pub fn achbit_dismiss_completion(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn achbit_open_completion(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let main = app.get_window("main").ok_or("main_window_unavailable")?;
    app.emit_to("main", "achbit:completion-open", session_id)
        .map_err(|error| error.to_string())?;
    main.unminimize().map_err(|error| error.to_string())?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reminder_navigation_preserves_identity_and_uses_a_browser_loadable_origin() {
        let reminder = Reminder {
            session_id: "session:long-identity-1234567890".into(),
            title: "任务已完成".into(),
            body: "标题 & details? #1".into(),
            open_label: "查看会话".into(),
            dismiss_label: "关闭提醒".into(),
            foreground_sound: false,
        };
        let url = reminder_url(&reminder).unwrap();
        #[cfg(windows)]
        {
            assert_eq!(url.scheme(), "http");
            assert_eq!(url.host_str(), Some("achbit-gui.localhost"));
        }
        #[cfg(not(windows))]
        {
            assert_eq!(url.scheme(), crate::APP_ASSET_SCHEME);
            assert_eq!(url.host_str(), Some("localhost"));
        }
        assert!(crate::trusted_app_navigation(&url));
        assert_eq!(url.path(), "/completion.html");
        let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["session"], reminder.session_id);
        assert_eq!(query["title"], reminder.title);
        assert_eq!(query["body"], reminder.body);
        assert_eq!(query["open"], reminder.open_label);
        assert_eq!(query["dismiss"], reminder.dismiss_label);
        assert!(url.fragment().is_none());
    }

    #[test]
    fn foreground_sound_is_optional_and_background_reminders_remain_enabled() {
        assert_eq!(completion_delivery(true, false), (false, false));
        assert_eq!(completion_delivery(true, true), (true, false));
        assert_eq!(completion_delivery(false, false), (true, true));
        assert_eq!(completion_delivery(false, true), (true, true));
        let reminder: Reminder = serde_json::from_value(serde_json::json!({
            "sessionId": "test", "title": "done", "body": "task", "openLabel": "open", "dismissLabel": "close"
        })).unwrap();
        assert!(!reminder.foreground_sound);
    }
}
