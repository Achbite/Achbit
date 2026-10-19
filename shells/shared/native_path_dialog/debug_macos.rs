//! Lifecycle and identity for an actual product-owned NSOpenPanel. A selected path
//! is reported only from NSOpenPanel's modal completion, never fabricated here.
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_app_kit::NSOpenPanel;
use objc2_foundation::{NSArray, NSString};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(1);
thread_local! { static STATE: RefCell<DialogState> = RefCell::new(DialogState { active: None, last: Value::Null }); }
struct DialogState {
    active: Option<(String, Retained<NSOpenPanel>)>,
    last: Value,
}

pub(super) fn opened(panel: &Retained<NSOpenPanel>) -> Result<String, String> {
    if STATE.with(|state| state.borrow().active.is_some()) {
        return Err("debug_native_dialog_already_open".into());
    }
    let id = format!("native-dialog-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    STATE.with(|state| state.borrow_mut().active = Some((id.clone(), panel.clone())));
    Ok(id)
}
pub(super) fn completed(id: String, result: &Result<Option<Vec<PathBuf>>, String>) {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.last = match result {
            Ok(Some(paths)) => json!({"id":id,"status":"selected","paths":paths}),
            Ok(None) => json!({"id":id,"status":"cancelled"}),
            Err(error) => json!({"id":id,"status":"failed","error":error}),
        };
        state.active = None;
    });
}
#[path = "debug_ax_macos.rs"]
mod accessibility;

pub fn command(name: &str, args: &Value) -> Result<Value, String> {
    objc2::exception::catch(|| command_inner(name, args))
        .map_err(|exception| format!("debug_native_dialog_exception: {exception:?}"))?
}

fn command_inner(name: &str, args: &Value) -> Result<Value, String> {
    if name == "menus" || name == "menu" {
        return unsafe { menu_command(name, args) };
    }
    let current = STATE.with(|state| state.borrow().active.clone());
    let Some((id, panel)) = current else {
        return if name == "inspect" {
            STATE.with(|state| Ok(json!({"status":"closed","lastResult":state.borrow().last})))
        } else {
            Err("debug_native_dialog_not_open".into())
        };
    };
    if args["dialogId"]
        .as_str()
        .is_some_and(|expected| expected != id)
    {
        return Err("debug_native_dialog_identity_mismatch".into());
    }
    if name == "cancel" {
        unsafe {
            panel.cancel(None);
        }
        return Ok(json!({"dialogId":id,"status":"dispatched","completion":"query-native-result"}));
    }
    let parent = panel
        .sheetParent()
        .ok_or("debug_native_dialog_parent_missing")?;
    unsafe {
        let screens: *mut NSArray<AnyObject> = msg_send![class!(NSScreen), screens];
        let screen: *mut AnyObject = msg_send![screens, firstObject];
        if screen.is_null() {
            return Err("debug_native_display_missing".into());
        }
        let primary: objc2_foundation::NSRect = msg_send![screen, frame];
        let frame = |rect: objc2_foundation::NSRect| {
            [
                rect.origin.x,
                primary.origin.y + primary.size.height - rect.origin.y - rect.size.height,
                rect.size.width,
                rect.size.height,
            ]
        };
        Ok(
            json!({"id":id,"status":"waiting","kind":"native-path-dialog","title":panel.title().to_string(),"directory":panel.directoryURL().and_then(|url|url.path()).map(|path|path.to_string()),"selected":panel.URLs().iter().filter_map(|url|url.path().map(|path|path.to_string())).collect::<Vec<_>>(),"parentWindowId":parent.windowNumber(),"parentTitle":parent.title().to_string(),"parentFrame":frame(parent.frame()),"panelWindowId":panel.windowNumber(),"panelFrame":frame(panel.frame()),"actions":["dialog.inspect","dialog.press","dialog.setValue","dialog.selectRow","dialog.cancel"]}),
        )
    }
}

// Runs on the existing blocking worker. Main-thread AppKit remains free to serve
// the accessibility requests and the sheet's original completion callback.
pub fn accessibility_command(name: &str, args: &Value, mut state: Value) -> Result<Value, String> {
    let frame = |key: &str| -> Result<[f64; 4], String> {
        serde_json::from_value(state[key].clone())
            .map_err(|error| format!("debug_dialog_frame_invalid: {error}"))
    };
    let target = accessibility::Target {
        dialog_id: state["id"]
            .as_str()
            .ok_or("debug_native_dialog_identity_missing")?
            .into(),
        parent_window_id: state["parentWindowId"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or("debug_native_dialog_parent_invalid")?,
        parent_title: state["parentTitle"]
            .as_str()
            .ok_or("debug_native_dialog_parent_missing")?
            .into(),
        parent_frame: frame("parentFrame")?,
        panel_window_id: state["panelWindowId"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or("debug_native_dialog_window_invalid")?,
        panel_title: state["title"]
            .as_str()
            .ok_or("debug_native_dialog_title_missing")?
            .into(),
        panel_frame: frame("panelFrame")?,
    };
    let result = accessibility::command(name, args, target);
    if name != "inspect" {
        return result;
    }
    state["permissions"] = accessibility::permissions();
    match result {
        Ok(value) => state["accessibility"] = value,
        Err(error) => {
            state["accessibility"] = json!({"status":if error.contains("manual-required") {"manual-required"} else {"unavailable"},"error":error})
        }
    }
    Ok(state)
}

unsafe fn menu_command(name: &str, args: &Value) -> Result<Value, String> {
    let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
    let root: *mut AnyObject = msg_send![application, mainMenu];
    if root.is_null() {
        return Err("debug_menu_unavailable".into());
    }
    if name == "menu" {
        let path = args["itemPath"]
            .as_array()
            .filter(|path| !path.is_empty())
            .ok_or("debug_menu_path_required")?;
        let mut menu = root;
        for (depth, index) in path.iter().enumerate() {
            let index = index.as_u64().ok_or("debug_menu_path_invalid")? as isize;
            let count: isize = msg_send![menu, numberOfItems];
            if index >= count {
                return Err("debug_menu_item_missing".into());
            }
            let item: *mut AnyObject = msg_send![menu, itemAtIndex:index];
            let enabled: bool = msg_send![item, isEnabled];
            if !enabled {
                return Err("debug_menu_item_disabled".into());
            }
            if depth + 1 == path.len() {
                let _: () = msg_send![menu, performActionForItemAtIndex:index];
            } else {
                menu = msg_send![item, submenu];
                if menu.is_null() {
                    return Err("debug_menu_submenu_missing".into());
                }
            }
        }
        return Ok(json!({"status":"dispatched","itemPath":path}));
    }
    let mut rows = Vec::new();
    let mut pending = vec![(root, Vec::<usize>::new())];
    while let Some((menu, path)) = pending.pop() {
        let count: isize = msg_send![menu, numberOfItems];
        for index in 0..count {
            let item: *mut AnyObject = msg_send![menu, itemAtIndex:index];
            let title: *mut NSString = msg_send![item, title];
            let enabled: bool = msg_send![item, isEnabled];
            let mut item_path = path.clone();
            item_path.push(index as usize);
            let submenu: *mut AnyObject = msg_send![item, submenu];
            rows.push(json!({"itemPath":item_path,"title":(*title).to_string(),"enabled":enabled,"submenu":!submenu.is_null()}));
            if !submenu.is_null() && item_path.len() < 8 {
                pending.push((submenu, item_path));
            }
        }
    }
    Ok(json!({"items":rows}))
}

#[path = "debug_capture_macos.rs"]
mod screenshot;

pub fn capture(path: PathBuf, reply: std::sync::mpsc::SyncSender<Result<Option<Value>, String>>) {
    let error_reply = reply.clone();
    let result = objc2::exception::catch(move || {
        let Some((id, panel)) = STATE.with(|state| state.borrow().active.clone()) else {
            let _ = reply.send(Ok(None));
            return Ok(());
        };
        let parent = panel
            .sheetParent()
            .ok_or("debug_native_dialog_parent_missing")?;
        let parent_id = u32::try_from(parent.windowNumber())
            .map_err(|_| "debug_native_dialog_parent_invalid")?;
        let panel_id = u32::try_from(panel.windowNumber())
            .map_err(|_| "debug_native_dialog_window_invalid")?;
        screenshot::start(path, id, parent_id, panel_id, reply);
        Ok::<(), String>(())
    })
    .map_err(|error| format!("debug_native_dialog_capture_exception: {error:?}"))
    .and_then(|result| result);
    if let Err(error) = result {
        let _ = error_reply.send(Err(error));
    }
}
