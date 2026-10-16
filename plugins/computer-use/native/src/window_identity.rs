//! The one platform-specific bridge between AX and WindowServer identities.
//! This macOS SPI is deliberately isolated. Missing support or an AX failure is
//! an error; titles and geometry must never become substitute window identities.
use std::{
    ffi::{c_char, c_void},
    sync::OnceLock,
};

type GetWindow = unsafe extern "C" fn(*const c_void, *mut u32) -> i32;
static GET_WINDOW: OnceLock<Option<GetWindow>> = OnceLock::new();

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

fn api() -> Option<GetWindow> {
    *GET_WINDOW.get_or_init(|| unsafe {
        // RTLD_DEFAULT on Darwin; ApplicationServices is linked by the driver.
        let symbol = dlsym((-2_isize) as *mut c_void, c"_AXUIElementGetWindow".as_ptr());
        if symbol.is_null() {
            None
        } else {
            Some(std::mem::transmute::<*mut c_void, GetWindow>(symbol))
        }
    })
}

pub fn available() -> bool {
    api().is_some()
}

/// `element` must be a live AX window reference, retained by the AppKit thread.
pub unsafe fn id(element: *const c_void) -> Result<u32, String> {
    let get_window = api().ok_or("Exact AX window identity is unavailable: _AXUIElementGetWindow is not exported by this macOS runtime")?;
    let mut window = 0;
    let error = get_window(element, &mut window);
    if error != 0 {
        return Err(format!(
            "Could not read exact AX window identity (AX error {error})"
        ));
    }
    if window == 0 {
        return Err("AX window returned an invalid WindowServer ID".into());
    }
    Ok(window)
}
