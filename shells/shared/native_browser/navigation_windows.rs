use super::Snapshot;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, COREWEBVIEW2_WEB_ERROR_STATUS, COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
};
use webview2_com::{
    take_pwstr, HistoryChangedEventHandler, NavigationCompletedEventHandler,
    SourceChangedEventHandler,
};
use windows::core::{BOOL, PWSTR};

unsafe fn snapshot(view: &ICoreWebView2) -> windows::core::Result<Snapshot> {
    let mut title = PWSTR::null();
    view.DocumentTitle(&mut title)?;
    let title = take_pwstr(title);
    let mut url = PWSTR::null();
    view.Source(&mut url)?;
    let url = take_pwstr(url);
    let mut back = BOOL(0);
    view.CanGoBack(&mut back)?;
    let mut forward = BOOL(0);
    view.CanGoForward(&mut forward)?;
    Ok(Snapshot {
        title,
        url,
        can_go_back: back.as_bool(),
        can_go_forward: forward.as_bool(),
    })
}
pub(super) fn operate(
    native: tauri::webview::PlatformWebview,
    action: &str,
    app: &tauri::AppHandle,
    id: &str,
) -> Result<Snapshot, String> {
    (|| -> windows::core::Result<Snapshot> {
        unsafe {
            let view = native.controller().CoreWebView2()?;
            match action {
                "install" => {
                    let mut token = 0;
                    let app1 = app.clone();
                    let id1 = id.to_string();
                    view.add_HistoryChanged(
                        &HistoryChangedEventHandler::create(Box::new(move |view, _| {
                            if let Some(view) = view {
                                super::changed(&app1, &id1, snapshot(&view)?);
                            }
                            Ok(())
                        })),
                        &mut token,
                    )?;
                    let app2 = app.clone();
                    let id2 = id.to_string();
                    view.add_SourceChanged(
                        &SourceChangedEventHandler::create(Box::new(move |view, _| {
                            if let Some(view) = view {
                                super::changed(&app2, &id2, snapshot(&view)?);
                            }
                            Ok(())
                        })),
                        &mut token,
                    )?;
                    let app3 = app.clone();
                    let id3 = id.to_string();
                    view.add_NavigationCompleted(
                        &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                            if let Some(args) = args {
                                let mut success = BOOL(0);
                                args.IsSuccess(&mut success)?;
                                if !success.as_bool() {
                                    let mut error = COREWEBVIEW2_WEB_ERROR_STATUS(0);
                                    args.WebErrorStatus(&mut error)?;
                                    if error != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                                        super::failed(
                                            &app3,
                                            &id3,
                                            format!("WebView2 navigation failed: {error:?}"),
                                        );
                                    }
                                }
                            }
                            Ok(())
                        })),
                        &mut token,
                    )?;
                }
                "back" => view.GoBack()?,
                "forward" => view.GoForward()?,
                "stop" => view.Stop()?,
                "status" | "dispose" => {}
                _ => {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80070057u32 as i32,
                    )))
                }
            }
            snapshot(&view)
        }
    })()
    .map_err(|error| error.to_string())
}
