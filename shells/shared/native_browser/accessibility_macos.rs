//! Initialize this exact WKWebView's remote accessibility before native observation.
//! A connected remote child is not a claim that its AX tree has been traversed.
use objc2::{class, msg_send, runtime::AnyObject};
use objc2_foundation::NSString;
use serde_json::{json, Value};
use std::time::Duration;

async fn remote_children(view: tauri::Webview) -> Result<usize, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| unsafe {
        let root = platform.inner().cast::<AnyObject>();
        let name = NSString::from_str("AXChildren");
        // This public attribute request enables accessibility in WebContent.
        // Cocoa returns remote proxies, not that process's traversed AX tree.
        let children: *mut AnyObject = msg_send![root, accessibilityAttributeValue: &*name];
        let result = if children.is_null() {
            Ok(0)
        } else {
            let is_array: bool = msg_send![children, isKindOfClass: class!(NSArray)];
            if is_array {
                let count: usize = msg_send![children, count];
                Ok(count)
            } else {
                Err("native_browser_accessibility_invalid: AXChildren is not an array".to_string())
            }
        };
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|error| format!("native_browser_accessibility_failed: {error}"))?
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) async fn prepare(view: tauri::Webview, expected_url: &str) -> Result<Value, String> {
    remote_children(view.clone()).await?;
    // The attribute request sends accessibility initialization to WebContent.
    // Await a subsequent response from that same process, then check the native
    // connection once. No elapsed delay, polling, navigation replay or retry.
    let document = super::eval(
        view.clone(),
        "({readyState:document.readyState,url:location.href})".into(),
    )
    .await?;
    if document["readyState"] != "complete" || document["url"] != expected_url {
        return Err(format!("native_browser_navigation_changed: {document}"));
    }
    let children = remote_children(view).await?;
    if children == 0 {
        return Err("native_browser_accessibility_not_connected: WKWebView has no remote AX child after WebContent responded".into());
    }
    Ok(json!({"navigation":document,
        "accessibility":{"status":"connected","remoteChildren":children}}))
}
