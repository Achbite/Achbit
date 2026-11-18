//! Native browsing state and actions. The Reader consumes these facts; it does
//! not maintain a second navigation stack. Installed handlers die with the view.
use serde::Serialize;
use tauri::Manager;

#[cfg(target_os = "macos")]
#[path = "navigation_macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "navigation_windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "navigation_linux.rs"]
mod platform;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    pub title: String,
    #[serde(skip_serializing)]
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

pub(super) fn changed(app: &tauri::AppHandle, id: &str, snapshot: Snapshot) {
    let state = app.state::<super::NativeBrowser>();
    if let Ok(mut pages) = state.pages.lock() {
        if let Some(page) = pages.get_mut(id) {
            if !snapshot.url.is_empty() {
                page.url = snapshot.url.clone();
            }
            page.navigation = snapshot;
            super::publish(app, page);
        }
    };
}

pub(super) fn started(app: &tauri::AppHandle, id: &str) {
    let state = app.state::<super::NativeBrowser>();
    if let Ok(mut pages) = state.pages.lock() {
        if let Some(page) = pages.get_mut(id) {
            page.status = "loading".into();
            page.load_error = None;
            super::publish(app, page);
            state.page_changed.notify_all();
        }
    };
}

pub(super) fn failed(app: &tauri::AppHandle, id: &str, message: String) {
    let state = app.state::<super::NativeBrowser>();
    if let Ok(mut pages) = state.pages.lock() {
        if let Some(page) = pages.get_mut(id) {
            if page.status == "stopped" {
                return;
            }
            page.status = "error".into();
            page.load_error = Some(message);
            super::publish(app, page);
            state.page_changed.notify_all();
        }
    };
}

/// Called inside the page-creation main-thread callback. Pinned Tauri dispatches
/// with_webview inline there, before navigation events can leave that callback.
pub(super) fn install(view: &tauri::Webview) -> Result<(), String> {
    let app = view.app_handle().clone();
    let id = view.label().to_string();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |native| {
        let _ = tx.send(platform::operate(native, "install", &app, &id));
    })
    .map_err(|error| error.to_string())?;
    rx.try_recv()
        .map_err(|_| "native_browser_install_requires_main_thread".to_string())??;
    Ok(())
}

pub(super) async fn operate(view: tauri::Webview, action: &str) -> Result<Snapshot, String> {
    let action = action.to_string();
    let app = view.app_handle().clone();
    let id = view.label().to_string();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |native| {
        let result = platform::operate(native, &action, &app, &id);
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| format!("native_browser_navigation_failed: {error}"))?
    })
    .await
    .map_err(|error| error.to_string())?
}
