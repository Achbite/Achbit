use std::ffi::{c_char, c_void};
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        value: *const c_char,
        encoding: u32,
    ) -> *const c_void;
    fn CFRelease(value: *const c_void);
}
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(
        kind: *const c_void,
        level: u32,
        name: *const c_void,
        id: *mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}
pub(super) struct Lease {
    id: Option<u32>,
}
impl Lease {
    pub(super) async fn acquire() -> Result<Self, String> {
        // Only idle system sleep: display sleep, lid close and explicit sleep remain OS policy.
        unsafe {
            let kind = CFStringCreateWithCString(
                std::ptr::null(),
                c"PreventUserIdleSystemSleep".as_ptr(),
                0x08000100,
            );
            let name = CFStringCreateWithCString(
                std::ptr::null(),
                c"Achbit is executing a task".as_ptr(),
                0x08000100,
            );
            if kind.is_null() || name.is_null() {
                if !kind.is_null() {
                    CFRelease(kind);
                }
                if !name.is_null() {
                    CFRelease(name);
                }
                return Err("IOPMAssertionCreateWithName: CFString allocation failed".into());
            }
            let mut id = 0;
            let status = IOPMAssertionCreateWithName(kind, 255, name, &mut id);
            CFRelease(kind);
            CFRelease(name);
            if status != 0 {
                return Err(format!("IOPMAssertionCreateWithName: IOReturn {status:#x}"));
            }
            Ok(Self { id: Some(id) })
        }
    }
    fn clear(&mut self) -> Result<(), String> {
        if let Some(id) = self.id.take() {
            let status = unsafe { IOPMAssertionRelease(id) };
            if status != 0 {
                return Err(format!("IOPMAssertionRelease: IOReturn {status:#x}"));
            }
        }
        Ok(())
    }
}
impl super::Lease for Lease {
    async fn release(&mut self) -> Result<(), String> {
        self.clear()
    }
    async fn failed(&mut self) -> String {
        std::future::pending().await
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Err(error) = self.clear() {
            eprintln!("host_power_release_failed: {error}");
        }
    }
}
