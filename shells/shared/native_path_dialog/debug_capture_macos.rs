//! Captures only the current product window's sheet, including AppKit's remote child.
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject, AnyThread};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSDictionary, NSError, NSRect, NSString};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::mpsc::SyncSender};
type Reply = SyncSender<Result<Option<Value>, String>>;

fn capture_error(stage: &str, error: &NSError) -> String {
    let permission =
        if unsafe { !SCStreamErrorDomain.is_null() && &*error.domain() == &*SCStreamErrorDomain }
            && error.code() == -3801
        {
            "manual-required: screen-recording: "
        } else {
            ""
        };
    format!(
        "{permission}debug_native_capture_{stage}: domain={} code={} description={}",
        error.domain(),
        error.code(),
        error.localizedDescription()
    )
}

#[link(name = "ScreenCaptureKit", kind = "framework")]
unsafe extern "C" {
    static SCStreamErrorDomain: *const NSString;
}

pub fn start(path: PathBuf, dialog_id: String, parent_id: u32, panel_id: u32, reply: Reply) {
    let error_reply = reply.clone();
    let result = objc2::exception::catch(move || unsafe {
        if objc2::runtime::AnyClass::get(c"SCScreenshotManager").is_none() {
            let _ = reply.send(Err(
                "debug_native_capture_unsupported: macOS 14.2 or later required".into(),
            ));
            return;
        }
        let completion =
            block2::RcBlock::new(move |content: *mut AnyObject, error: *mut NSError| {
                let error_reply = reply.clone();
                let result = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
                    if let Some(error) = error.as_ref() {
                        return Err(capture_error("content", error));
                    }
                    if content.is_null() {
                        return Err("debug_native_capture_content_missing".into());
                    }
                    capture_content(
                        content,
                        path.clone(),
                        dialog_id.clone(),
                        parent_id,
                        panel_id,
                        reply.clone(),
                    )
                }));
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        let _ = error_reply.send(Err(error));
                    }
                    Err(error) => {
                        let _ = error_reply
                            .send(Err(format!("debug_native_capture_exception: {error:?}")));
                    }
                }
            });
        let _: () = msg_send![class!(SCShareableContent), getShareableContentExcludingDesktopWindows: true, onScreenWindowsOnly: true, completionHandler: &*completion];
    });
    if let Err(error) = result {
        let _ = error_reply.send(Err(format!("debug_native_capture_exception: {error:?}")));
    }
}

unsafe fn capture_content(
    content: *mut AnyObject,
    path: PathBuf,
    dialog_id: String,
    parent_id: u32,
    panel_id: u32,
    reply: Reply,
) -> Result<(), String> {
    let windows: *mut NSArray<AnyObject> = msg_send![content, windows];
    let windows = windows
        .as_ref()
        .ok_or("debug_native_capture_windows_missing")?;
    let mut parent = None;
    let mut panel_frame = None;
    for window in windows.iter() {
        let id: u32 = msg_send![&*window, windowID];
        if id == parent_id {
            let app: *mut AnyObject = msg_send![&*window, owningApplication];
            if app.is_null() {
                return Err("debug_native_capture_owner_missing".into());
            }
            let pid: i32 = msg_send![app, processID];
            if pid != std::process::id() as i32 {
                return Err("debug_native_capture_owner_mismatch".into());
            }
            parent = Some(window.clone());
        }
        if id == panel_id {
            panel_frame = Some(msg_send![&*window, frame]);
        }
    }
    let parent = parent.ok_or("debug_native_capture_parent_missing")?;
    let frame: NSRect = panel_frame.ok_or("debug_native_capture_panel_missing")?;
    let displays: *mut NSArray<AnyObject> = msg_send![content, displays];
    let displays = displays
        .as_ref()
        .ok_or("debug_native_capture_displays_missing")?;
    let display = displays
        .iter()
        .find(|display| {
            let area: NSRect = msg_send![&**display, frame];
            frame.origin.x >= area.origin.x
                && frame.origin.y >= area.origin.y
                && frame.origin.x + frame.size.width <= area.origin.x + area.size.width
                && frame.origin.y + frame.size.height <= area.origin.y + area.size.height
        })
        .ok_or("debug_native_capture_panel_spans_displays")?;
    let display_frame: NSRect = msg_send![&*display, frame];
    let pixel_width: isize = msg_send![&*display, width];
    let scale = pixel_width as f64 / display_frame.size.width;
    let mut source = frame;
    source.origin.x -= display_frame.origin.x;
    source.origin.y -= display_frame.origin.y;
    let selected = NSArray::from_retained_slice(&[parent]);
    let filter: *mut AnyObject = msg_send![class!(SCContentFilter), alloc];
    let filter: *mut AnyObject =
        msg_send![filter, initWithDisplay: &*display, includingWindows: &*selected];
    let filter = Retained::from_raw(filter).ok_or("debug_native_capture_filter_missing")?;
    let config: *mut AnyObject = msg_send![class!(SCStreamConfiguration), new];
    let config = Retained::from_raw(config).ok_or("debug_native_capture_configuration_missing")?;
    let supported: bool =
        msg_send![&*config, respondsToSelector: objc2::sel!(setIncludeChildWindows:)];
    if !supported {
        return Err("debug_native_capture_unsupported: macOS 14.2 or later required".into());
    }
    let _: () = msg_send![&*config, setIncludeChildWindows: true];
    let _: () = msg_send![&*config, setShowsCursor: false];
    let _: () = msg_send![&*config, setSourceRect: source];
    let _: () = msg_send![&*config, setWidth: (frame.size.width * scale).round() as usize];
    let _: () = msg_send![&*config, setHeight: (frame.size.height * scale).round() as usize];
    let complete = block2::RcBlock::new(move |image: *const CGImage, error: *mut NSError| {
        let result = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
            if let Some(error) = error.as_ref() { return Err(capture_error("image", error)); }
            let image = image.as_ref().ok_or("debug_native_capture_image_missing")?;
            let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image);
            let data = bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()).ok_or("debug_native_capture_encoding_failed")?;
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|error|error.to_string())?;
            file.write_all(&data.to_vec()).map_err(|error|error.to_string())?;
            Ok(Some(json!({"contentRef":path,"contentType":"image/png","width":bitmap.pixelsWide(),"height":bitmap.pixelsHigh(),"range":"product-window-child-sheet","dialogId":dialog_id,"parentWindowId":parent_id,"windowId":panel_id})))
        })).map_err(|error|format!("debug_native_capture_exception: {error:?}")).and_then(|result|result);
        let _ = reply.send(result);
    });
    let _: () = msg_send![class!(SCScreenshotManager), captureImageWithFilter: &*filter, configuration: &*config, completionHandler: &*complete];
    Ok(())
}
