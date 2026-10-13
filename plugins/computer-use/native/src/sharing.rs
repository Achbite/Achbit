//! Apple public ScreenCaptureKit bridge. Physical sharing is bound to a run;
//! it is neither a second Session nor controlled by model visibility commands.
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};

extern "C" {
    fn dc_sharing_request(request: *const c_char) -> *mut c_char;
    fn dc_sharing_free(response: *mut c_char);
}

pub fn request(mut input: Value, binding: &Value) -> Result<Value, String> {
    input["binding"] = binding.clone();
    let encoded = CString::new(input.to_string()).map_err(|e| e.to_string())?;
    let response = unsafe { dc_sharing_request(encoded.as_ptr()) };
    if response.is_null() {
        return Err("ScreenCaptureKit response unavailable".into());
    }
    let decoded = unsafe { serde_json::from_slice::<Value>(CStr::from_ptr(response).to_bytes()) };
    unsafe { dc_sharing_free(response) };
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
extern "C" fn dc_computer_feedback_clear(window: u32, generation: u64) {
    // The Objective-C bridge calls this only on the AppKit main thread.
    crate::indicator::hide_window(window, generation);
}
