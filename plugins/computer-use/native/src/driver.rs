//! Physical macOS I/O in the independently signed helper. Kernel admits every call.
use objc2::{class, msg_send, runtime::AnyObject};
use objc2_foundation::NSString;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    ffi::{c_char, c_void},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

type Ref = *const c_void;
#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct Point {
    pub x: f64,
    pub y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct Size {
    pub width: f64,
    pub height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub origin: Point,
    pub size: Size,
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementCopyAttributeValue(element: Ref, name: Ref, result: *mut Ref) -> i32;
    fn AXUIElementSetAttributeValue(element: Ref, name: Ref, value: Ref) -> i32;
    fn AXUIElementPerformAction(element: Ref, action: Ref) -> i32;
    fn AXUIElementCopyActionNames(element: Ref, result: *mut Ref) -> i32;
    fn AXUIElementIsAttributeSettable(element: Ref, name: Ref, result: *mut bool) -> i32;
    fn CGRectMakeWithDictionaryRepresentation(dictionary: Ref, rect: *mut Rect) -> bool;
    fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
    fn AXValueGetValue(value: Ref, kind: u32, result: *mut c_void) -> bool;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGWindowListCopyWindowInfo(options: u32, relative_to: u32) -> Ref;
    fn CGEventCreateMouseEvent(source: Ref, kind: u32, position: Point, button: u32) -> Ref;
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    fn CGEventKeyboardSetUnicodeString(event: Ref, length: usize, text: *const u16);
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventCreateScrollWheelEvent(source: Ref, units: u32, count: u32, ...) -> Ref;
    fn CGEventPost(tap: u32, event: Ref);
    fn CGEventGetLocation(event: Ref) -> Point;
    fn CGEventGetType(event: Ref) -> u32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: Ref);
    fn CFRetain(value: Ref) -> Ref;
    fn CFEqual(left: Ref, right: Ref) -> bool;
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: Ref) -> bool;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(value: Ref, kind: isize, result: *mut c_void) -> bool;
    static kCFBooleanTrue: Ref;
    fn CFStringGetCString(value: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    fn CFStringGetLength(value: Ref) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(value: Ref) -> isize;
    fn CFArrayGetValueAtIndex(value: Ref, index: isize) -> Ref;
}
struct Owned(Ref);
impl Owned {
    fn new(value: Ref) -> Result<Self, String> {
        if value.is_null() {
            Err("macOS returned an empty native object".into())
        } else {
            Ok(Self(value))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
#[derive(Clone)]
struct Observation {
    id: String,
    app: String,
    pid: i32,
    at: Instant,
    bounds: Rect,
    window_id: u32,
    foreground: bool,
    binding: Value,
    image_width: f64,
    image_height: f64,
    sharing_generation: u64,
}
static OBSERVATION: Mutex<Option<Observation>> = Mutex::new(None);

// The mutex serializes physical operations. Only the AppKit thread owns AX refs;
// this is the retained window of that one observation, not a second session.
struct ObservedWindow {
    element: Owned,
    bounds: Rect,
    elements: Vec<Owned>,
}
thread_local! {
    static OBSERVED_WINDOW: RefCell<Option<ObservedWindow>> = const { RefCell::new(None) };
}

fn on_main_thread<T: Send + 'static>(
    app: &crate::runtime::MainThread,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = objc2::rc::autoreleasepool(|_| operation());
        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;
    rx.recv().map_err(|error| error.to_string())?
}

fn with_accessibility<T: Send + 'static>(
    app: &crate::runtime::MainThread,
    pid: i32,
    operation: impl FnOnce(Ref) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // AX calls targeting this process can synchronously enter AppKit. Keep
    // every AX object and callback on the GUI thread; never send raw refs.
    on_main_thread(app, move || unsafe {
        let root = Owned::new(AXUIElementCreateApplication(pid))?;
        let error = AXUIElementSetMessagingTimeout(root.0, 0.3);
        if error != 0 {
            return Err(format!(
                "Could not set AX messaging timeout (AX error {error})"
            ));
        }
        operation(root.0)
    })
}

unsafe fn string(value: *mut NSString) -> String {
    if value.is_null() {
        String::new()
    } else {
        (&*value).to_string()
    }
}
unsafe fn applications() -> *mut AnyObject {
    let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
    msg_send![workspace, runningApplications]
}
unsafe fn target(bundle: &str) -> Result<*mut AnyObject, String> {
    let apps = applications();
    let count: usize = msg_send![apps, count];
    for index in 0..count {
        let app: *mut AnyObject = msg_send![apps, objectAtIndex:index];
        let id: *mut NSString = msg_send![app, bundleIdentifier];
        if string(id) == bundle {
            return Ok(app);
        }
    }
    Err(format!(
        "Application is not running: {bundle}. Use listApps to choose a running app."
    ))
}
unsafe fn attribute(element: Ref, key: &str) -> Result<Option<Owned>, String> {
    let name = NSString::from_str(key);
    let mut result = std::ptr::null();
    match AXUIElementCopyAttributeValue(element, (&*name as *const NSString).cast(), &mut result) {
        0 => Owned::new(result).map(Some),
        // kAXErrorAttributeUnsupported / kAXErrorNoValue are legitimate absence.
        -25205 | -25212 => Ok(None),
        error => Err(format!("Could not read {key} (AX error {error})")),
    }
}
unsafe fn text_attribute(element: Ref, key: &str) -> Result<Option<String>, String> {
    attribute(element, key)?
        .map(|value| text_value(value.0))
        .transpose()
}
unsafe fn text_value(value: Ref) -> Result<String, String> {
    if CFGetTypeID(value) != CFStringGetTypeID() {
        return Err("AX text attribute is not a string".into());
    }
    let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), 0x08000100)
        .checked_add(1)
        .filter(|size| *size > 0)
        .ok_or("Invalid AX string length")?;
    let mut bytes = vec![0u8; size as usize];
    if !CFStringGetCString(
        value,
        bytes.as_mut_ptr().cast(),
        bytes.len() as isize,
        0x08000100,
    ) {
        return Err("AX string UTF-8 conversion failed".into());
    }
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8(bytes[..end].to_vec()).map_err(|error| error.to_string())
}
unsafe fn scalar_attribute(element: Ref, key: &str) -> Result<Option<Value>, String> {
    let Some(value) = attribute(element, key)? else {
        return Ok(None);
    };
    let kind = CFGetTypeID(value.0);
    if kind == CFStringGetTypeID() {
        return text_value(value.0).map(|text| Some(Value::String(text)));
    }
    if kind == CFBooleanGetTypeID() {
        return Ok(Some(Value::Bool(CFBooleanGetValue(value.0))));
    }
    if kind == CFNumberGetTypeID() {
        let mut number = 0.0_f64;
        // kCFNumberFloat64Type; preserve zero-valued controls as actual facts.
        if CFNumberGetValue(value.0, 6, (&mut number as *mut f64).cast()) {
            return serde_json::Number::from_f64(number)
                .map(|number| Some(Value::Number(number)))
                .ok_or_else(|| "AX numeric value is not finite".into());
        }
        return Err("AX numeric conversion failed".into());
    }
    Err(format!("AXValue has unsupported scalar type {}", kind))
}
unsafe fn frontmost(root: Ref) -> Result<bool, String> {
    let value = attribute(root, "AXFrontmost")?
        .ok_or("Could not read the target application's foreground state")?;
    if CFGetTypeID(value.0) != CFBooleanGetTypeID() {
        return Err("Target application's foreground state is not a boolean".into());
    }
    Ok(CFBooleanGetValue(value.0))
}

unsafe fn window_bounds(window: Ref) -> Result<Rect, String> {
    let position = attribute(window, "AXPosition")?.ok_or("Target window has no position")?;
    let size = attribute(window, "AXSize")?.ok_or("Target window has no size")?;
    let mut rect = Rect {
        origin: Point { x: 0.0, y: 0.0 },
        size: Size {
            width: 0.0,
            height: 0.0,
        },
    };
    if !AXValueGetValue(position.0, 1, (&mut rect.origin as *mut Point).cast())
        || !AXValueGetValue(size.0, 2, (&mut rect.size as *mut Size).cast())
        || !rect.origin.x.is_finite()
        || !rect.origin.y.is_finite()
        || !rect.size.width.is_finite()
        || !rect.size.height.is_finite()
        || rect.size.width <= 0.0
        || rect.size.height <= 0.0
    {
        return Err("Target window has invalid geometry; observe again".into());
    }
    Ok(rect)
}

unsafe fn set_true(element: Ref, key: &str) -> Result<(), String> {
    let name = NSString::from_str(key);
    let error =
        AXUIElementSetAttributeValue(element, (&*name as *const NSString).cast(), kCFBooleanTrue);
    if error != 0 {
        return Err(format!("Could not set {key} (AX error {error})"));
    }
    Ok(())
}

unsafe fn raise(window: Ref) -> Result<(), String> {
    let name = NSString::from_str("AXRaise");
    let error = AXUIElementPerformAction(window, (&*name as *const NSString).cast());
    if error != 0 {
        return Err(format!(
            "Could not raise the observed window (AX error {error}); observe again"
        ));
    }
    Ok(())
}

impl ObservedWindow {
    unsafe fn validate_geometry(&self) -> Result<(), String> {
        if window_bounds(self.element.0)? != self.bounds {
            return Err("Observed window moved or resized; observe again before acting".into());
        }
        if scalar_attribute(self.element.0, "AXMinimized")? == Some(json!(true)) {
            return Err("Observed window is minimized; observe again before acting".into());
        }
        Ok(())
    }

    unsafe fn focused(&self, root: Ref) -> Result<bool, String> {
        // AXUIElement is a CFType; CFEqual compares the underlying accessibility
        // objects, unlike pointer or window-title equality.
        Ok(frontmost(root)?
            && attribute(root, "AXFocusedWindow")?
                .is_some_and(|focused| CFEqual(focused.0, self.element.0)))
    }
}

fn with_observed_window<T: Send + 'static>(
    gui: &crate::runtime::MainThread,
    pid: i32,
    operation: impl FnOnce(Ref, &ObservedWindow) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    with_accessibility(gui, pid, move |root| {
        OBSERVED_WINDOW.with(|slot| {
            let window = slot.borrow();
            operation(
                root,
                window
                    .as_ref()
                    .ok_or("Observed window is unavailable; observe again")?,
            )
        })
    })
}

unsafe fn restore_observed_window(
    gui: &crate::runtime::MainThread,
    saved: &Observation,
) -> Result<(), String> {
    with_observed_window(gui, saved.pid, |root, window| {
        window.validate_geometry()?;
        if !window.focused(root)? {
            // Restore only the retained window. Never choose the application's
            // current window as a substitute after approval changes focus.
            set_true(window.element.0, "AXMain")?;
            set_true(root, "AXFrontmost")?;
            raise(window.element.0)?;
        }
        Ok(())
    })?;
    let started = Instant::now();
    loop {
        if with_observed_window(gui, saved.pid, |root, window| {
            window.validate_geometry()?;
            window.focused(root)
        })? {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(2) {
            return Err("Observed window did not regain focus; observe again before acting".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
unsafe fn tree_item(element: Ref, depth: usize) -> Result<Value, String> {
    let mut item = json!({"depth":depth});
    for (key, name) in [
        ("AXRole", "role"),
        ("AXTitle", "title"),
        ("AXDescription", "description"),
    ] {
        if let Some(text) = text_attribute(element, key)? {
            if !text.is_empty() {
                item[name] = json!(text);
            }
        }
    }
    if let Some(value) = scalar_attribute(element, "AXValue")? {
        item["value"] = value;
    }
    let mut position = Point { x: 0.0, y: 0.0 };
    let mut size = Size {
        width: 0.0,
        height: 0.0,
    };
    if let (Some(p), Some(s)) = (
        attribute(element, "AXPosition")?,
        attribute(element, "AXSize")?,
    ) {
        if AXValueGetValue(p.0, 1, (&mut position as *mut Point).cast())
            && AXValueGetValue(s.0, 2, (&mut size as *mut Size).cast())
        {
            item["bounds"] =
                json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height});
        } else {
            return Err("AX position or size conversion failed".into());
        }
    }
    Ok(item)
}
unsafe fn tree(root: Ref) -> (Vec<Value>, Value, Vec<Owned>) {
    // Arrays own their children while on the stack. No fixed element/depth cap.
    let mut stack: Vec<(Owned, isize, usize)> = vec![];
    let mut current = Some((root, 0));
    let started = Instant::now();
    let mut items = vec![];
    let mut handles = vec![];
    let mut errors = vec![];
    while let Some((element, depth)) = current.take() {
        if started.elapsed() > Duration::from_secs(4) {
            errors.push(json!({"phase":"accessibilityTree","message":"Accessibility observation time budget reached; tree is incomplete"}));
            break;
        }
        match tree_item(element, depth) {
            Ok(mut item) => {
                item["elementId"] = json!(format!("element:{}", handles.len()));
                let retained = match Owned::new(CFRetain(element)) {
                    Ok(retained) => retained,
                    Err(message) => {
                        errors.push(json!({"depth":depth,"message":message}));
                        break;
                    }
                };
                handles.push(retained);
                let mut actions = std::ptr::null();
                let error = AXUIElementCopyActionNames(element, &mut actions);
                if error == 0 {
                    match Owned::new(actions) {
                        Ok(actions) if CFGetTypeID(actions.0) == CFArrayGetTypeID() => {
                            let names = (0..CFArrayGetCount(actions.0))
                                .map(|i| text_value(CFArrayGetValueAtIndex(actions.0, i)))
                                .collect::<Result<Vec<_>, _>>();
                            match names {
                                Ok(names) => item["actions"] = json!(names),
                                Err(message) => {
                                    errors.push(json!({"depth":depth,"message":message}))
                                }
                            }
                        }
                        Ok(_) => errors
                            .push(json!({"depth":depth,"message":"AX actions are not an array"})),
                        Err(message) => errors.push(json!({"depth":depth,"message":message})),
                    }
                } else if error != -25206 {
                    errors.push(json!({"depth":depth,"message":format!("Could not read AX actions (AX error {error})")}));
                }
                let name = NSString::from_str("AXValue");
                let mut settable = false;
                let error = AXUIElementIsAttributeSettable(
                    element,
                    (&*name as *const NSString).cast(),
                    &mut settable,
                );
                if error == 0 {
                    item["valueSettable"] = json!(settable);
                } else if error != -25205 {
                    errors.push(json!({"depth":depth,"message":format!("Could not inspect AXValue (AX error {error})")}));
                }
                items.push(item);
            }
            Err(message) => errors.push(json!({"depth":depth,"message":message})),
        }
        match attribute(element, "AXChildren") {
            Ok(Some(children)) if CFGetTypeID(children.0) == CFArrayGetTypeID() => {
                stack.push((children, 0, depth + 1))
            }
            Ok(Some(_)) => {
                errors.push(json!({"depth":depth,"message":"AXChildren is not an array"}))
            }
            Ok(None) => {}
            Err(message) => errors.push(json!({"depth":depth,"message":message})),
        }
        while let Some((children, index, depth)) = stack.last_mut() {
            if *index < CFArrayGetCount(children.0) {
                current = Some((CFArrayGetValueAtIndex(children.0, *index), *depth));
                *index += 1;
                break;
            }
            stack.pop();
        }
    }
    (
        items,
        json!({"complete":errors.is_empty(),"errors":errors}),
        handles,
    )
}
fn point(input: &Value, x: &str, y: &str, observation: &Observation) -> Result<Point, String> {
    let value = Point {
        x: input[x].as_f64().ok_or("Missing x coordinate")?,
        y: input[y].as_f64().ok_or("Missing y coordinate")?,
    };
    if !value.x.is_finite()
        || !value.y.is_finite()
        || value.x < 0.0
        || value.y < 0.0
        || value.x >= observation.image_width
        || value.y >= observation.image_height
    {
        return Err("Coordinates must be inside the returned screenshot (image pixels).".into());
    }
    Ok(Point {
        x: observation.bounds.origin.x
            + value.x * observation.bounds.size.width / observation.image_width,
        y: observation.bounds.origin.y
            + value.y * observation.bounds.size.height / observation.image_height,
    })
}

unsafe fn select_window(
    root: Ref,
    window_id: Option<u32>,
    pid: i32,
) -> Result<(Owned, u32, Rect), String> {
    let element = if let Some(id) = window_id {
        let windows = attribute(root, "AXWindows")?.ok_or("Application has no AX windows")?;
        if CFGetTypeID(windows.0) != CFArrayGetTypeID() {
            return Err("AXWindows is not an array".into());
        }
        let mut matches = Vec::new();
        for index in 0..CFArrayGetCount(windows.0) {
            let window = CFArrayGetValueAtIndex(windows.0, index);
            if crate::window_identity::id(window)? == id {
                matches.push(Owned::new(CFRetain(window))?);
            }
        }
        if matches.len() != 1 {
            return Err(format!("WindowServer window {id} has {} exact AX matches; observe an available, unambiguous window", matches.len()));
        }
        matches.pop().expect("one window")
    } else {
        attribute(root, "AXFocusedWindow")?.ok_or("Target application has no focused window")?
    };
    let id = crate::window_identity::id(element.0)?;
    let (owner, bounds) = window_snapshot(id)?;
    if owner != pid {
        return Err("Window does not belong to the requested app".into());
    }
    // Geometry validates the observation, not the window's identity.
    if window_bounds(element.0)? != bounds {
        return Err("Window geometry changed while binding the observation; observe again".into());
    }
    Ok((element, id, bounds))
}

fn rect_json(bounds: Rect) -> Value {
    json!({"x":bounds.origin.x,"y":bounds.origin.y,"width":bounds.size.width,"height":bounds.size.height})
}

unsafe fn observe(
    app: &crate::runtime::MainThread,
    input: &Value,
    bundle: &str,
    pid: i32,
    binding: &Value,
) -> Result<(Observation, Value), String> {
    let window_id = input["windowId"].as_u64().map(|id| id as u32);
    let foreground = input["mode"].as_str().unwrap_or(if window_id.is_some() {
        "background"
    } else {
        "foreground"
    }) == "foreground";
    let (mut items, accessibility, window_info, window_id, bounds) = with_accessibility(
        app,
        pid,
        move |root| {
            let (element, window_id, bounds) = select_window(root, window_id, pid)?;
            if foreground {
                set_true(element.0, "AXMain")?;
                set_true(root, "AXFrontmost")?;
                raise(element.0)?;
            }
            let window_info = json!({"windowId":window_id,"title":text_attribute(element.0, "AXTitle")?,"bounds":rect_json(bounds)});
            let (items, accessibility, elements) = tree(element.0);
            OBSERVED_WINDOW.with(|slot| {
                *slot.borrow_mut() = Some(ObservedWindow {
                    element,
                    bounds,
                    elements,
                })
            });
            Ok((items, accessibility, window_info, window_id, bounds))
        },
    )?;
    let mut capture = input.clone();
    capture["windowId"] = json!(window_id);
    let sharing =
        crate::sharing::request(json!({"operation":"ensure","windowId":window_id}), binding)?;
    let sharing_generation = sharing["generation"]
        .as_u64()
        .ok_or("Missing sharing generation")?;
    let (id, path, width, height) = capture_pixels(app, &capture, binding)?;
    crate::sharing::validate(binding, window_id, sharing_generation)?;
    with_observed_window(app, pid, move |_, window| {
        window.validate_geometry()?;
        if window_snapshot(window_id)? != (pid, bounds) {
            return Err("Target window changed during capture; observe again".into());
        }
        Ok(())
    })?;
    let sx = width / bounds.size.width;
    let sy = height / bounds.size.height;
    for item in &mut items {
        if let Some(rect) = item.get_mut("bounds") {
            *rect = json!({"x":(rect["x"].as_f64().ok_or("Invalid AX x")? - bounds.origin.x) * sx,
                "y":(rect["y"].as_f64().ok_or("Invalid AX y")? - bounds.origin.y) * sy,
                "width":rect["width"].as_f64().ok_or("Invalid AX width")? * sx,
                "height":rect["height"].as_f64().ok_or("Invalid AX height")? * sy});
        }
    }
    let captured_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis()
        .to_string();
    let mode = if foreground {
        "foreground"
    } else {
        "background"
    };
    let output = json!({"observationId":id,"app":bundle,"window":window_info,"mode":mode,"elements":items,"accessibility":accessibility,
        "contentRef":path,"contentType":"image/png","width":width,"height":height,"capturedAt":captured_at,
        "coordinateSpace":"window screenshot pixels","sharing":sharing});
    Ok((
        Observation {
            id,
            app: bundle.into(),
            pid,
            at: Instant::now(),
            bounds,
            window_id,
            foreground,
            binding: binding.clone(),
            image_width: width,
            image_height: height,
            sharing_generation,
        },
        output,
    ))
}
unsafe fn capture_pixels(
    app: &crate::runtime::MainThread,
    input: &Value,
    binding: &Value,
) -> Result<(String, std::path::PathBuf, f64, f64), String> {
    if !CGPreflightScreenCaptureAccess() {
        return Err("macOS screen recording access is not granted to the executing Computer Use App; inspect computer.control status for its identity".into());
    }
    let directory = Path::new(
        input["captureDirectory"]
            .as_str()
            .ok_or("Missing archive directory")?,
    );
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let id = app.resource_id();
    let path = directory.join(format!("{id}.png"));
    let captured = crate::sharing::request(
        json!({"operation":"capture","windowId":input["windowId"],
        "display":input["display"],"path":path}),
        binding,
    )?;
    let width = captured["width"]
        .as_f64()
        .ok_or("Missing screenshot width")?;
    let height = captured["height"]
        .as_f64()
        .ok_or("Missing screenshot height")?;
    Ok((id, path, width, height))
}

pub fn status() -> Result<Value, String> {
    objc2::rc::autoreleasepool(|_| unsafe {
        let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
        let identifier: *mut NSString = msg_send![bundle, bundleIdentifier];
        let path: *mut NSString = msg_send![bundle, bundlePath];
        Ok(json!({
            "executor":{"pid":std::process::id(),"executable":std::env::current_exe().map_err(|error|error.to_string())?,
                "bundleId":string(identifier),"bundlePath":string(path)},
            "permissions":{"accessibility":AXIsProcessTrusted(),"screenCapture":CGPreflightScreenCaptureAccess()},
            "capabilities":{"capture":true,"accessibility":true,"input":true,
                "exactWindowIdentity":crate::window_identity::available(),"nativeWindowSharing":true}
        }))
    })
}

unsafe fn dictionary_value(dictionary: Ref, name: &str) -> *mut AnyObject {
    let key = NSString::from_str(name);
    msg_send![dictionary as *mut AnyObject, objectForKey:&*key]
}
pub(crate) unsafe fn window_snapshot(window_id: u32) -> Result<(i32, Rect), String> {
    let list = Owned::new(CGWindowListCopyWindowInfo(8 | 16, window_id))?;
    if CFArrayGetCount(list.0) != 1 {
        return Err("Target window is closed or unavailable; observe again".into());
    }
    let item = CFArrayGetValueAtIndex(list.0, 0);
    let visible: bool = msg_send![dictionary_value(item, "kCGWindowIsOnscreen"), boolValue];
    if !visible {
        return Err("Target window is minimized or off-screen; observe again".into());
    }
    let owner: i32 = msg_send![dictionary_value(item, "kCGWindowOwnerPID"), intValue];
    let mut bounds = Rect {
        origin: Point { x: 0.0, y: 0.0 },
        size: Size {
            width: 0.0,
            height: 0.0,
        },
    };
    if !CGRectMakeWithDictionaryRepresentation(
        dictionary_value(item, "kCGWindowBounds").cast(),
        &mut bounds,
    ) {
        return Err("WindowServer returned invalid geometry".into());
    }
    Ok((owner, bounds))
}

unsafe fn windows() -> Result<Value, String> {
    if !CGPreflightScreenCaptureAccess() {
        return Err("Screen recording access is required to inspect external windows; inspect computer.control status".into());
    }
    let list = Owned::new(CGWindowListCopyWindowInfo(1 | 16, 0))?;
    let mut windows = vec![];
    for index in 0..CFArrayGetCount(list.0) {
        let item = CFArrayGetValueAtIndex(list.0, index);
        let layer: i32 = msg_send![dictionary_value(item, "kCGWindowLayer"), intValue];
        if layer != 0 {
            continue;
        }
        let pid: i32 = msg_send![dictionary_value(item, "kCGWindowOwnerPID"), intValue];
        let window_id: u32 = msg_send![dictionary_value(item, "kCGWindowNumber"), unsignedIntValue];
        let mut bounds = Rect {
            origin: Point { x: 0.0, y: 0.0 },
            size: Size {
                width: 0.0,
                height: 0.0,
            },
        };
        if !CGRectMakeWithDictionaryRepresentation(
            dictionary_value(item, "kCGWindowBounds").cast(),
            &mut bounds,
        ) {
            return Err("WindowServer returned invalid geometry".into());
        }
        let title = string(dictionary_value(item, "kCGWindowName").cast());
        let owner = string(dictionary_value(item, "kCGWindowOwnerName").cast());
        windows.push(json!({"windowId":window_id,"pid":pid,"owner":owner,"title":title,"bounds":rect_json(bounds)}));
    }
    Ok(json!({"windows":windows}))
}

fn key(value: &str) -> Result<(u16, u64), String> {
    let mut parts: Vec<_> = value.split('+').collect();
    let name = parts.pop().ok_or("Missing key")?.to_ascii_lowercase();
    let mut flags = 0;
    for part in parts {
        flags |= match part.to_ascii_lowercase().as_str() {
            "cmd" | "super" => 1 << 20,
            "shift" => 1 << 17,
            "ctrl" | "control" => 1 << 18,
            "alt" | "option" => 1 << 19,
            _ => return Err(format!("Unsupported modifier: {part}")),
        };
    }
    let code = match name.as_str() {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "escape" | "esc" => 53,
        "backspace" => 51,
        "delete" => 117,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "9" => 25,
        "7" => 26,
        "8" => 28,
        "0" => 29,
        "o" => 31,
        "u" => 32,
        "i" => 34,
        "p" => 35,
        "l" => 37,
        "j" => 38,
        "k" => 40,
        "n" => 45,
        "m" => 46,
        _ => return Err(format!("Unsupported key: {name}; use type for text")),
    };
    Ok((code, flags))
}

pub fn execute(
    gui: &crate::runtime::MainThread,
    binding: &Value,
    input: &Value,
) -> Result<Value, String> {
    // GUI presentation requests are private Host commands, not model tools.
    // They neither consume an observation nor create an image artifact.
    if input["action"] == "computer:preview" {
        return crate::sharing::request(
            json!({"operation":"preview", "afterSequence":input["afterSequence"]}),
            binding,
        );
    }
    if input["action"] == "computer:activateTarget" {
        return activate_shared_target(gui, binding, input);
    }
    // One physical desktop observation at a time, across all bound sessions.
    let mut observation = OBSERVATION
        .lock()
        .map_err(|_| "Computer state unavailable")?;
    let result = objc2::rc::autoreleasepool(|_| unsafe {
        let action = input["action"]
            .as_str()
            .ok_or("Missing action")?
            .trim_start_matches("computer:");
        if action == "status" {
            let mut output = status()?;
            output["sharing"] = crate::sharing::status(binding)?;
            output["capabilities"]["nativeWindowSharing"] = json!(true);
            return Ok(output);
        }
        if action == "releaseRun" {
            if observation
                .as_ref()
                .is_some_and(|saved| saved.binding == *binding)
            {
                *observation = None;
            }
            return crate::sharing::release(binding);
        }
        if action == "listWindows" {
            return windows();
        }
        if action == "capture" {
            let (id, path, width, height) = capture_pixels(gui, input, binding)?;
            return Ok(
                json!({"captureId":id,"contentRef":path,"contentType":"image/png","width":width,"height":height,
                "target":if input["windowId"].is_number(){json!({"windowId":input["windowId"]})}else{json!({"display":"primary"})},
                "capturedAt":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error|error.to_string())?.as_millis().to_string()}),
            );
        }
        if action == "listApps" {
            return on_main_thread(gui, || {
                let apps = applications();
                let count: usize = msg_send![apps, count];
                let mut result = vec![];
                for index in 0..count {
                    let app: *mut AnyObject = msg_send![apps, objectAtIndex:index];
                    let id: *mut NSString = msg_send![app, bundleIdentifier];
                    let name: *mut NSString = msg_send![app, localizedName];
                    let id = string(id);
                    if !id.is_empty() {
                        result.push(json!({"app":id,"name":string(name)}));
                    }
                }
                Ok(json!({"applications":result}))
            });
        }
        if !AXIsProcessTrusted() {
            return Err("macOS 辅助功能授权未被当前 Computer Use 辅助 App识别。请先使用 computer.control status 核对进程和应用身份；系统设置中的同名开关不能确认当前实例的状态。".into());
        }
        if !CGPreflightScreenCaptureAccess() {
            return Err("macOS screen recording access is not granted to the executing Computer Use App; inspect computer.control status for its identity".into());
        }
        let bundle = input["app"].as_str().ok_or("Missing app")?;
        let target_bundle = bundle.to_string();
        let pid: i32 = on_main_thread(gui, move || {
            let app = target(&target_bundle)?;
            Ok(msg_send![app, processIdentifier])
        })?;
        if action == "observe" {
            let sharing = crate::sharing::status(binding)?;
            if !matches!(sharing["state"].as_str(), Some("inactive" | "active")) {
                return Err(format!("Window sharing is unavailable: {sharing}"));
            }
            *observation = None;
            let (fresh, output) = observe(gui, input, bundle, pid, binding)?;
            *observation = Some(fresh);
            return Ok(output);
        }
        let saved = observation
            .take()
            .ok_or("Observe the application before acting")?;
        if input["observationId"] != saved.id
            || saved.app != bundle
            || saved.pid != pid
            || saved.binding != *binding
            || saved.at.elapsed() > Duration::from_secs(120)
        {
            return Err("Observation is stale; observe again before acting".into());
        }
        let semantic = matches!(action, "press" | "setValue");
        if !semantic && !saved.foreground {
            return Err("This input requires an explicit foreground observation; background mode supports press and setValue only".into());
        }
        crate::sharing::validate(binding, saved.window_id, saved.sharing_generation)?;
        if !semantic {
            restore_observed_window(gui, &saved)?;
        }
        let arguments = input.clone();
        let saved_for_input = saved.clone();
        with_observed_window(gui, pid, move |root, window| {
            crate::sharing::validate(
                &saved_for_input.binding,
                saved_for_input.window_id,
                saved_for_input.sharing_generation,
            )?;
            window.validate_geometry()?;
            if window_snapshot(saved_for_input.window_id)?
                != (saved_for_input.pid, saved_for_input.bounds)
            {
                return Err("Target window changed; observe again before acting".into());
            }
            if semantic {
                let id = arguments["elementId"].as_str().ok_or("Missing elementId")?;
                let index = id
                    .strip_prefix("element:")
                    .and_then(|s| s.parse::<usize>().ok())
                    .ok_or("Invalid elementId")?;
                let element = window
                    .elements
                    .get(index)
                    .ok_or("Unknown elementId; observe again")?;
                let item = tree_item(element.0, 0)?;
                let marker = item["bounds"].as_object().and_then(|_| {
                    Some(Point {
                        x: item["bounds"]["x"].as_f64()? + item["bounds"]["width"].as_f64()? / 2.0,
                        y: item["bounds"]["y"].as_f64()? + item["bounds"]["height"].as_f64()? / 2.0,
                    })
                });
                crate::indicator::show(
                    saved_for_input.window_id,
                    marker,
                    saved_for_input.sharing_generation,
                )?;
                let error = if arguments["action"] == "computer:press" {
                    let action = NSString::from_str("AXPress");
                    AXUIElementPerformAction(element.0, (&*action as *const NSString).cast())
                } else {
                    let name = NSString::from_str("AXValue");
                    let value =
                        NSString::from_str(arguments["text"].as_str().ok_or("Missing text")?);
                    AXUIElementSetAttributeValue(
                        element.0,
                        (&*name as *const NSString).cast(),
                        (&*value as *const NSString).cast(),
                    )
                };
                if error != 0 {
                    return Err(format!("AX operation returned error {error}; effect is not confirmed. Observe before deciding any further action; no HID fallback was attempted."));
                }
                Ok(())
            } else {
                if !window.focused(root)? {
                    return Err("Observed window lost focus before input; observe again".into());
                }
                dispatch_input(&arguments, &saved_for_input)
            }
        })?;
        // A short bounded delay lets the application process dispatched input. A
        // screenshot remains an observation, not a claim that backend work settled.
        std::thread::sleep(Duration::from_millis(200));
        let mut result = json!({"app":bundle,"action":action,"dispatched":true});
        let mut next = input.clone();
        next["windowId"] = json!(saved.window_id);
        next["mode"] = json!(if saved.foreground {
            "foreground"
        } else {
            "background"
        });
        match observe(gui, &next, bundle, pid, binding) {
            Ok((fresh, mut output)) => {
                *observation = Some(fresh);
                output["action"] = json!(action);
                output["dispatched"] = json!(true);
                Ok(output)
            }
            Err(message) => {
                result["observationError"] = json!({"message":message});
                Ok(result)
            }
        }
    });
    if observation.is_none() {
        let cleanup = on_main_thread(gui, || {
            OBSERVED_WINDOW.with(|slot| slot.borrow_mut().take());
            Ok(())
        });
        if let Err(error) = cleanup {
            return match result {
                Ok(mut output) if output["dispatched"] == true => {
                    // Preserve an already-dispatched input and its original
                    // observation error when releasing the native target fails.
                    let original = output["observationError"]["message"]
                        .as_str()
                        .ok_or_else(|| format!("Could not release observed window: {error}"))?;
                    output["observationError"] = json!({"message":format!(
                        "{original}; could not release observed window: {error}"
                    )});
                    Ok(output)
                }
                Ok(_) => Err(format!("Could not release observed window: {error}")),
                Err(original) => Err(format!(
                    "{original}; could not release observed window: {error}"
                )),
            };
        }
    }
    result
}

fn activate_shared_target(
    gui: &crate::runtime::MainThread,
    binding: &Value,
    input: &Value,
) -> Result<Value, String> {
    let window = input["windowId"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or("Invalid preview windowId")?;
    let generation = input["generation"]
        .as_u64()
        .filter(|value| *value > 0)
        .ok_or("Invalid preview generation")?;
    let shared = crate::sharing::request(
        json!({"operation":"validate", "windowId":window, "generation":generation}),
        binding,
    )?;
    let pid = shared["pid"]
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or("Shared window has no process identity")?;
    let binding = binding.clone();
    with_accessibility(gui, pid, move |root| unsafe {
        crate::sharing::validate(&binding, window, generation)?;
        let (element, _, _) = select_window(root, Some(window), pid)?;
        if scalar_attribute(element.0, "AXMinimized")? == Some(json!(true)) {
            return Err("The shared window is minimized".into());
        }
        set_true(element.0, "AXMain")?;
        set_true(root, "AXFrontmost")?;
        raise(element.0)?;
        Ok(())
    })?;
    let started = Instant::now();
    loop {
        let focused = with_accessibility(gui, pid, move |root| unsafe {
            let (element, _, _) = select_window(root, Some(window), pid)?;
            Ok(frontmost(root)?
                && attribute(root, "AXFocusedWindow")?
                    .is_some_and(|focused| CFEqual(focused.0, element.0)))
        })?;
        if focused {
            return Ok(json!({"activated":true,"windowId":window,"generation":generation}));
        }
        if started.elapsed() >= Duration::from_secs(2) {
            return Err("The exact shared window did not gain focus".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

unsafe fn dispatch_input(input: &Value, saved: &Observation) -> Result<(), String> {
    let action = input["action"]
        .as_str()
        .ok_or("Missing action")?
        .trim_start_matches("computer:");
    let null = std::ptr::null();
    let mut events = vec![];
    match action {
        "click" => {
            let p = point(input, "x", "y", &saved)?;
            events.push(Owned::new(CGEventCreateMouseEvent(null, 1, p, 0))?);
            events.push(Owned::new(CGEventCreateMouseEvent(null, 2, p, 0))?);
        }
        "drag" => {
            let from = point(input, "x", "y", &saved)?;
            let to = point(input, "toX", "toY", &saved)?;
            events.push(Owned::new(CGEventCreateMouseEvent(null, 1, from, 0))?);
            for step in 1..=12 {
                let amount = step as f64 / 12.0;
                events.push(Owned::new(CGEventCreateMouseEvent(
                    null,
                    6,
                    Point {
                        x: from.x + (to.x - from.x) * amount,
                        y: from.y + (to.y - from.y) * amount,
                    },
                    0,
                ))?);
            }
            events.push(Owned::new(CGEventCreateMouseEvent(null, 2, to, 0))?);
        }
        "key" => {
            let (code, flags) = key(input["key"].as_str().ok_or("Missing key")?)?;
            for down in [true, false] {
                let event = Owned::new(CGEventCreateKeyboardEvent(null, code, down))?;
                CGEventSetFlags(event.0, flags);
                events.push(event);
            }
        }
        "type" => {
            let text = input["text"].as_str().ok_or("Missing text")?;
            if text.len() > 8192 {
                return Err("Text exceeds 8192 bytes".into());
            }
            let text: Vec<_> = text.encode_utf16().collect();
            for down in [true, false] {
                let event = Owned::new(CGEventCreateKeyboardEvent(null, 0, down))?;
                CGEventKeyboardSetUnicodeString(event.0, text.len(), text.as_ptr());
                events.push(event);
            }
        }
        "scroll" => {
            let dx = i32::try_from(input["deltaX"].as_i64().ok_or("Missing deltaX")?)
                .map_err(|_| "deltaX too large")?;
            let dy = i32::try_from(input["deltaY"].as_i64().ok_or("Missing deltaY")?)
                .map_err(|_| "deltaY too large")?;
            events.push(Owned::new(CGEventCreateScrollWheelEvent(
                null, 0, 2, dy, dx,
            ))?);
        }
        _ => return Err("Unsupported computer action".into()),
    }
    for event in events {
        if matches!(CGEventGetType(event.0), 1 | 2 | 6) {
            crate::indicator::show(
                saved.window_id,
                Some(CGEventGetLocation(event.0)),
                saved.sharing_generation,
            )?;
        }
        CGEventPost(0, event.0);
        if action == "drag" && matches!(CGEventGetType(event.0), 1 | 6) {
            // Pace the real input events, not a later replay animation. Target
            // frames and published pointer positions remain readable through
            // the separate presentation channel while this dispatch is active.
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    Ok(())
}
