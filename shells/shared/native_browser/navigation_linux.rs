use super::Snapshot;
use gtk::prelude::ObjectExt;
use webkit2gtk::WebViewExt;

fn snapshot(view: &webkit2gtk::WebView) -> Snapshot {
    Snapshot {
        title: view.title().map(|s| s.to_string()).unwrap_or_default(),
        url: view.uri().map(|s| s.to_string()).unwrap_or_default(),
        can_go_back: view.can_go_back(),
        can_go_forward: view.can_go_forward(),
    }
}
pub(super) fn operate(
    native: tauri::webview::PlatformWebview,
    action: &str,
    app: &tauri::AppHandle,
    id: &str,
) -> Result<Snapshot, String> {
    let view = native.inner();
    match action {
        "install" => {
            for property in ["uri", "title", "is-loading"] {
                let app = app.clone();
                let id = id.to_string();
                view.connect_notify_local(Some(property), move |view, _| {
                    super::changed(&app, &id, snapshot(view))
                });
            }
            let app = app.clone();
            let id = id.to_string();
            view.connect_load_failed(move |_, _, uri, error| {
                if !error.matches(webkit2gtk::NetworkError::Cancelled) {
                    super::failed(&app, &id, format!("{uri}: {error}"));
                }
                false
            });
        }
        "back" => view.go_back(),
        "forward" => view.go_forward(),
        "stop" => view.stop_loading(),
        "status" | "dispose" => {}
        _ => return Err("native_browser_navigation_action_invalid".into()),
    }
    Ok(snapshot(&view))
}
