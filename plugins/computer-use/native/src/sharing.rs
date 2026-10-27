//! Apple public ScreenCaptureKit bridge. Physical sharing is bound to a run;
//! it is neither a second Session nor controlled by model visibility commands.
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};

extern "C" {
    fn ac_sharing_request(request: *const c_char) -> *mut c_char;
    fn ac_sharing_free(response: *mut c_char);
    fn ac_sharing_preview(request: *const c_char) -> *mut c_char;
    fn ac_sharing_pointer_feedback(
        window: u32,
        generation: u64,
        pointer_window: u32,
        x: f64,
        y: f64,
        pulse: bool,
    );
}

/// The pointer is a real companion capture source. Position is presentation
/// metadata in target coordinates, never a replacement desktop input target.
pub fn pointer_feedback(
    window: u32,
    generation: u64,
    pointer_window: u32,
    x: f64,
    y: f64,
    pulse: bool,
) {
    unsafe { ac_sharing_pointer_feedback(window, generation, pointer_window, x, y, pulse) }
}

pub fn request(mut input: Value, binding: &Value) -> Result<Value, String> {
    input["binding"] = binding.clone();
    let encoded = CString::new(input.to_string()).map_err(|e| e.to_string())?;
    let response = unsafe { ac_sharing_request(encoded.as_ptr()) };
    decode(response)
}

/// Immutable presentation cache only; never dispatches to the AppKit queue.
pub fn preview(binding: &Value, input: &Value) -> Result<Value, String> {
    let encoded =
        CString::new(json!({"binding":binding,"afterSequence":input["afterSequence"]}).to_string())
            .map_err(|error| error.to_string())?;
    decode(unsafe { ac_sharing_preview(encoded.as_ptr()) })
}

fn decode(response: *mut c_char) -> Result<Value, String> {
    if response.is_null() {
        return Err("ScreenCaptureKit response unavailable".into());
    }
    let decoded = unsafe { serde_json::from_slice::<Value>(CStr::from_ptr(response).to_bytes()) };
    unsafe { ac_sharing_free(response) };
    let response = decoded.map_err(|e| format!("ScreenCaptureKit response invalid: {e}"))?;
    if response["ok"] != true {
        return Err(format!("ScreenCaptureKit: {}", response["error"]));
    }
    Ok(response["data"].clone())
}

pub fn status(binding: &Value) -> Result<Value, String> {
    request(json!({"operation":"status"}), binding)
}

pub fn validate(binding: &Value, window: u32, generation: u64) -> Result<(), String> {
    request(
        json!({"operation":"validate","windowId":window,"generation":generation}),
        binding,
    )?;
    Ok(())
}

pub fn release(binding: &Value) -> Result<Value, String> {
    request(json!({"operation":"release"}), binding)
}

#[no_mangle]
extern "C" fn ac_computer_feedback_clear(window: u32, generation: u64) {
    // The Objective-C bridge calls this only on the AppKit main thread.
    crate::indicator::hide_window(window, generation);
}
