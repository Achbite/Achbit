//! Scoped AX client for the current Debug GUI's own active file-selection sheet.
//! Runs on an existing worker, while AppKit's main thread remains free to answer AX.
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    ffi::{c_char, c_void, CString},
    ptr,
};

type Ref = *const c_void;
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementCopyAttributeValue(element: Ref, name: Ref, result: *mut Ref) -> i32;
    fn AXUIElementSetAttributeValue(element: Ref, name: Ref, value: Ref) -> i32;
    fn AXUIElementIsAttributeSettable(element: Ref, name: Ref, result: *mut u8) -> i32;
    fn AXUIElementCopyActionNames(element: Ref, result: *mut Ref) -> i32;
    fn AXUIElementCopyAttributeNames(element: Ref, result: *mut Ref) -> i32;
    fn AXUIElementPerformAction(element: Ref, action: Ref) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Ref, seconds: f32) -> i32;
    fn AXValueGetValue(value: Ref, kind: u32, result: *mut c_void) -> u8;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(value: Ref) -> Ref;
    fn CFRelease(value: Ref);
    fn CFEqual(a: Ref, b: Ref) -> u8;
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithCString(allocator: Ref, value: *const c_char, encoding: u32) -> Ref;
    fn CFStringGetLength(value: Ref) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(value: Ref, buffer: *mut c_char, length: isize, encoding: u32) -> u8;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayCreate(allocator: Ref, values: *const Ref, count: isize, callbacks: Ref) -> Ref;
    static kCFTypeArrayCallBacks: u8;
    fn CFArrayGetCount(value: Ref) -> isize;
    fn CFArrayGetValueAtIndex(value: Ref, index: isize) -> Ref;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: Ref) -> u8;
    fn CFURLGetTypeID() -> usize;
    fn CFURLCopyFileSystemPath(value: Ref, style: isize) -> Ref;
    static kCFBooleanTrue: Ref;
}
const UTF8: u32 = 0x0800_0100;
const MAX_NODES: usize = 512;

pub struct Target {
    pub dialog_id: String,
    pub parent_window_id: u32,
    pub parent_title: String,
    /// Global top-left coordinates in points, matching AXPosition / AXSize.
    pub parent_frame: [f64; 4],
    pub panel_window_id: u32,
    pub panel_title: String,
    pub panel_frame: [f64; 4],
}
struct Owned(Ref);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
impl Owned {
    fn new(value: Ref) -> Result<Self, String> {
        if value.is_null() {
            Err("debug_dialog_ax_null_object".into())
        } else {
            Ok(Self(value))
        }
    }
    fn retained(value: Ref) -> Result<Self, String> {
        Self::new(unsafe { CFRetain(value) })
    }
}
fn checked(code: i32, operation: &str) -> Result<(), String> {
    match code {
        0 => Ok(()),
        -25211 => Err(format!("manual-required: accessibility permission is required by the current Debug GUI ({operation}; AXError={code})")),
        _ => Err(format!("debug_dialog_ax_failed: {operation}; AXError={code}")),
    }
}
fn string(value: &str) -> Result<Owned, String> {
    let value = CString::new(value).map_err(|_| "debug_dialog_ax_string_contains_nul")?;
    Owned::new(unsafe { CFStringCreateWithCString(ptr::null(), value.as_ptr(), UTF8) })
}
fn text(value: Ref) -> Option<String> {
    if value.is_null() || unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
        return None;
    }
    let max = unsafe { CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), UTF8) };
    if max < 0 {
        return None;
    }
    let mut buffer = vec![0u8; max as usize + 1];
    if unsafe {
        CFStringGetCString(
            value,
            buffer.as_mut_ptr().cast(),
            buffer.len() as isize,
            UTF8,
        )
    } == 0
    {
        return None;
    }
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf8(buffer[..end].to_vec()).ok()
}
fn element(value: Ref) -> Result<(), String> {
    if value.is_null() || unsafe { CFGetTypeID(value) != AXUIElementGetTypeID() } {
        return Err("debug_dialog_ax_element_invalid".into());
    }
    checked(
        unsafe { AXUIElementSetMessagingTimeout(value, 2.0) },
        "set messaging timeout",
    )
}
fn attribute(node: &Owned, name: &str) -> Result<Option<Owned>, String> {
    element(node.0)?;
    let key = string(name)?;
    let mut value = ptr::null();
    let result = unsafe { AXUIElementCopyAttributeValue(node.0, key.0, &mut value) };
    if matches!(result, -25205 | -25212) {
        return Ok(None);
    }
    checked(result, name)?;
    Owned::new(value).map(Some)
}
fn text_attribute(node: &Owned, name: &str) -> Result<Option<String>, String> {
    Ok(attribute(node, name)?.as_ref().and_then(|v| text(v.0)))
}
fn elements(value: &Owned) -> Result<Vec<Owned>, String> {
    if unsafe { CFGetTypeID(value.0) != CFArrayGetTypeID() } {
        return Err("debug_dialog_ax_array_invalid".into());
    }
    let count = unsafe { CFArrayGetCount(value.0) };
    if count < 0 || count > 4096 {
        return Err("debug_dialog_ax_children_limit".into());
    }
    (0..count)
        .map(|index| {
            let value = unsafe { CFArrayGetValueAtIndex(value.0, index) };
            element(value)?;
            Owned::retained(value)
        })
        .collect()
}
fn children(node: &Owned) -> Result<Vec<Owned>, String> {
    match attribute(node, "AXChildren")? {
        Some(value) => elements(&value),
        None => Ok(vec![]),
    }
}
fn frame(node: &Owned) -> Result<Option<[f64; 4]>, String> {
    let (Some(position), Some(size)) = (attribute(node, "AXPosition")?, attribute(node, "AXSize")?)
    else {
        return Ok(None);
    };
    let mut point = [0f64; 2];
    let mut dimensions = [0f64; 2];
    if unsafe { AXValueGetValue(position.0, 1, point.as_mut_ptr().cast()) } == 0
        || unsafe { AXValueGetValue(size.0, 2, dimensions.as_mut_ptr().cast()) } == 0
    {
        return Err("debug_dialog_ax_geometry_invalid".into());
    }
    Ok(Some([point[0], point[1], dimensions[0], dimensions[1]]))
}
fn same_frame(actual: Option<[f64; 4]>, expected: &[f64; 4]) -> bool {
    actual.is_some_and(|actual| {
        actual
            .iter()
            .zip(expected)
            .all(|(a, b)| (a - b).abs() <= 3.0)
    })
}
fn scoped_sheet(application: &Owned, target: &Target) -> Result<Owned, String> {
    let windows = attribute(application, "AXWindows")?.ok_or("debug_dialog_ax_windows_missing")?;
    let mut parents = Vec::new();
    for window in elements(&windows)? {
        if same_frame(frame(&window)?, &target.parent_frame)
            && (target.parent_title.is_empty()
                || text_attribute(&window, "AXTitle")?.as_deref() == Some(&target.parent_title))
        {
            parents.push(window);
        }
    }
    if parents.len() != 1 {
        return Err(format!(
            "debug_dialog_parent_not_unique: matches={}; windowId={}",
            parents.len(),
            target.parent_window_id
        ));
    }
    let parent = parents.pop().unwrap();
    // AX's documented hierarchy attaches a sheet directly to its parent window.
    // Do not recurse into unrelated WebKit views belonging to that window.
    let children = children(&parent).map_err(|error| {
        format!(
            "phase=parentChildren windowId={}: {error}",
            target.parent_window_id
        )
    })?;
    let mut sheets = Vec::new();
    let mut sheet_frames = Vec::new();
    for node in children {
        if text_attribute(&node, "AXRole")?.as_deref() == Some("AXSheet") {
            let bounds = frame(&node)?;
            sheet_frames.push(bounds);
            if same_frame(bounds, &target.panel_frame) {
                sheets.push(node);
            }
        }
    }
    if sheets.len() != 1 {
        return Err(format!(
            "debug_dialog_sheet_not_unique: matches={}; panelWindowId={}; title={}; sheetFrames={sheet_frames:?}",
            sheets.len(),
            target.panel_window_id,
            target.panel_title
        ));
    }
    Ok(sheets.pop().unwrap())
}
fn node_at(root: &Owned, path: &[Value]) -> Result<Owned, String> {
    if path.len() > 16 {
        return Err("debug_dialog_node_path_too_deep".into());
    }
    let mut node = Owned::retained(root.0)?;
    for part in path {
        let index = part.as_u64().ok_or("debug_dialog_node_path_invalid")? as usize;
        let list = children(&node)?;
        node = Owned::retained(list.get(index).ok_or("debug_dialog_node_not_found")?.0)?;
    }
    Ok(node)
}
fn walk(root: &Owned) -> Result<(Vec<(Owned, Vec<usize>)>, bool), String> {
    let mut pending = VecDeque::from([(Owned::retained(root.0)?, Vec::new())]);
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some((node, path)) = pending.pop_front() {
        if rows.len() >= MAX_NODES {
            truncated = true;
            break;
        }
        if path.len() < 16 {
            for (index, child) in children(&node)
                .map_err(|error| format!("phase=sheetWalk nodePath={path:?}: {error}"))?
                .into_iter()
                .enumerate()
            {
                let mut next = path.clone();
                next.push(index);
                pending.push_back((child, next));
            }
        } else {
            truncated = true;
        }
        rows.push((node, path));
    }
    Ok((rows, truncated))
}

fn value(node: &Owned, name: &str) -> Result<Value, String> {
    let Some(value) = attribute(node, name)? else {
        return Ok(Value::Null);
    };
    if let Some(text) = text(value.0) {
        return Ok(json!(text));
    }
    if unsafe { CFGetTypeID(value.0) == CFBooleanGetTypeID() } {
        return Ok(json!(unsafe { CFBooleanGetValue(value.0) } != 0));
    }
    Ok(json!({"typeId":unsafe{CFGetTypeID(value.0)}}))
}
fn url_path(node: &Owned) -> Result<Option<String>, String> {
    let Some(url) = attribute(node, "AXURL")? else {
        return Ok(None);
    };
    if unsafe { CFGetTypeID(url.0) != CFURLGetTypeID() } {
        return Ok(None);
    }
    let path = Owned::new(unsafe { CFURLCopyFileSystemPath(url.0, 0) })?;
    Ok(text(path.0))
}
fn actions(node: &Owned) -> Result<Vec<String>, String> {
    element(node.0)?;
    let mut raw = ptr::null();
    checked(
        unsafe { AXUIElementCopyActionNames(node.0, &mut raw) },
        "read actions",
    )?;
    let array = Owned::new(raw)?;
    if unsafe { CFGetTypeID(array.0) != CFArrayGetTypeID() } {
        return Err("debug_dialog_ax_actions_invalid".into());
    }
    Ok((0..unsafe { CFArrayGetCount(array.0) })
        .filter_map(|i| text(unsafe { CFArrayGetValueAtIndex(array.0, i) }))
        .collect())
}
fn attribute_names(node: &Owned) -> Result<Vec<String>, String> {
    element(node.0)?;
    let mut raw = ptr::null();
    checked(
        unsafe { AXUIElementCopyAttributeNames(node.0, &mut raw) },
        "read attribute names",
    )?;
    let array = Owned::new(raw)?;
    if unsafe { CFGetTypeID(array.0) != CFArrayGetTypeID() } {
        return Err("debug_dialog_ax_attributes_invalid".into());
    }
    Ok((0..unsafe { CFArrayGetCount(array.0) })
        .filter_map(|index| text(unsafe { CFArrayGetValueAtIndex(array.0, index) }))
        .collect())
}

fn inspect_node(node: &Owned, path: Vec<usize>) -> Result<Value, String> {
    let attributes = attribute_names(node)?;
    let supported = |name: &str| attributes.iter().any(|value| value == name);
    let mut result = json!({"path":path,"attributes":attributes});
    let mut errors = serde_json::Map::new();
    let mut record = |field: &str, value: Result<Value, String>| match value {
        Ok(value) => result[field] = value,
        Err(error) => {
            errors.insert(field.into(), json!({"error":error}));
        }
    };
    for (field, name) in [
        ("role", "AXRole"),
        ("title", "AXTitle"),
        ("label", "AXDescription"),
    ] {
        if supported(name) {
            record(field, text_attribute(node, name).map(|value| json!(value)));
        }
    }
    for (field, name) in [
        ("value", "AXValue"),
        ("selected", "AXSelected"),
        ("enabled", "AXEnabled"),
    ] {
        if supported(name) {
            record(field, value(node, name));
        }
    }
    if supported("AXURL") {
        record("filePath", url_path(node).map(|value| json!(value)));
    }
    if supported("AXPosition") && supported("AXSize") {
        record("frame", frame(node).map(|value| json!(value)));
    }
    record("actions", actions(node).map(|value| json!(value)));
    if !errors.is_empty() {
        result["attributeErrors"] = Value::Object(errors);
    }
    Ok(result)
}

fn set(node: &Owned, name: &str, value: Ref) -> Result<(), String> {
    element(node.0)?;
    let key = string(name)?;
    let mut writable = 0;
    checked(
        unsafe { AXUIElementIsAttributeSettable(node.0, key.0, &mut writable) },
        name,
    )?;
    if writable == 0 {
        return Err(format!("debug_dialog_ax_attribute_readonly: {name}"));
    }
    checked(
        unsafe { AXUIElementSetAttributeValue(node.0, key.0, value) },
        name,
    )
}
fn select_child(collection: &Owned, child: &Owned) -> Result<(), String> {
    if !children(collection)?
        .iter()
        .any(|node| unsafe { CFEqual(node.0, child.0) } != 0)
    {
        return Err("debug_dialog_selection_not_direct_child".into());
    }
    let value = Owned::new(unsafe {
        CFArrayCreate(
            ptr::null(),
            &child.0,
            1,
            ptr::addr_of!(kCFTypeArrayCallBacks).cast(),
        )
    })?;
    set(collection, "AXSelectedChildren", value.0)
}

fn perform(node: &Owned, name: &str) -> Result<(), String> {
    if !matches!(
        name,
        "AXPress" | "AXOpen" | "AXConfirm" | "AXShowMenu" | "AXCancel" | "AXRaise"
    ) {
        return Err("debug_dialog_ax_action_not_supported".into());
    }
    element(node.0)?;
    if !actions(node)?.iter().any(|action| action == name) {
        return Err(format!("debug_dialog_ax_action_not_available: {name}"));
    }
    let action = string(name)?;
    checked(unsafe { AXUIElementPerformAction(node.0, action.0) }, name)
}

pub fn permissions() -> Value {
    let trusted = unsafe { AXIsProcessTrusted() } != 0;
    json!({"pid":std::process::id(),"scope":"current-debug-gui","accessibilityTrusted":trusted,
        "status":if trusted{"granted"}else{"not-trusted"},"diagnosticOnly":true,"prompted":false})
}

pub fn command(name: &str, args: &Value, target: Target) -> Result<Value, String> {
    if let Some(expected) = args["dialogId"].as_str() {
        if expected != target.dialog_id {
            return Err("debug_native_dialog_identity_mismatch".into());
        }
    }
    if target
        .parent_frame
        .iter()
        .chain(target.panel_frame.iter())
        .any(|v| !v.is_finite())
    {
        return Err("debug_dialog_target_geometry_invalid".into());
    }
    let application =
        Owned::new(unsafe { AXUIElementCreateApplication(std::process::id() as i32) })?;
    let sheet = scoped_sheet(&application, &target)?;
    if name == "inspect" {
        let base: Vec<Value> = match args.get("nodePath") {
            Some(value) => value
                .as_array()
                .ok_or("debug_dialog_node_path_invalid")?
                .clone(),
            None => Vec::new(),
        };
        let scope = node_at(&sheet, &base)?;
        let (rows, truncated) = walk(&scope)?;
        let mut nodes = Vec::new();
        for (node, path) in rows {
            let mut absolute: Vec<usize> = base
                .iter()
                .map(|part| part.as_u64().unwrap() as usize)
                .collect();
            absolute.extend(path);
            nodes.push(
                inspect_node(&node, absolute.clone()).map_err(|error| {
                    format!("phase=sheetInspect nodePath={absolute:?}: {error}")
                })?,
            );
        }
        return Ok(
            json!({"dialogId":target.dialog_id,"status":"waiting","pid":std::process::id(),
            "parentWindowId":target.parent_window_id,"panelWindowId":target.panel_window_id,"scope":"owned-parent-sheet","rootNodePath":base,
            "permissions":permissions(),"coverage":if truncated || nodes.iter().any(|node|node.get("attributeErrors").is_some()) {"partial"} else {"complete"},"truncated":truncated,"truncationReason":truncated.then_some("node-or-depth-limit"),"nodes":nodes,"nodeLimit":MAX_NODES}),
        );
    }
    match name {
        "press" | "setValue" | "selectRow" => {
            let path = args["nodePath"]
                .as_array()
                .ok_or("debug_dialog_node_path_required")?;
            let node = node_at(&sheet, path)?;
            match name {
                "press" => perform(&node, args["action"].as_str().unwrap_or("AXPress"))?,
                "selectRow" => {
                    if let Some(path) = args["collectionPath"].as_array() {
                        let collection = node_at(&sheet, path)?;
                        select_child(&collection, &node)?;
                    } else {
                        set(&node, "AXSelected", unsafe { kCFBooleanTrue })?;
                    }
                }
                _ => {
                    let input = args["value"]
                        .as_str()
                        .ok_or("debug_dialog_value_required")?;
                    let input = string(input)?;
                    set(&node, "AXValue", input.0)?;
                }
            }
        }
        _ => return Err("debug_native_dialog_action_unsupported".into()),
    }
    Ok(
        json!({"dialogId":target.dialog_id,"status":"dispatched","completion":"query-native-result","scope":"owned-parent-sheet"}),
    )
}
