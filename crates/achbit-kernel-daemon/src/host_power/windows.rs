use std::ffi::c_void;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[repr(C)]
struct ReasonContext {
    version: u32,
    flags: u32,
    reason: Reason,
}
#[repr(C)]
union Reason {
    simple: *mut u16,
    detailed: DetailedReason,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct DetailedReason {
    module: *mut c_void,
    id: u32,
    count: u32,
    strings: *mut *mut u16,
}
#[link(name = "kernel32")]
extern "system" {
    fn PowerCreateRequest(reason: *const ReasonContext) -> *mut c_void;
    fn PowerSetRequest(handle: *mut c_void, request: i32) -> i32;
    fn PowerClearRequest(handle: *mut c_void, request: i32) -> i32;
}
const SYSTEM_REQUIRED: i32 = 1;
pub(super) struct Lease {
    handle: Option<OwnedHandle>,
}
impl Lease {
    pub(super) async fn acquire() -> Result<Self, String> {
        let mut reason = "Achbit is executing a task\0"
            .encode_utf16()
            .collect::<Vec<_>>();
        let context = ReasonContext {
            version: 0,
            flags: 1,
            reason: Reason {
                simple: reason.as_mut_ptr(),
            },
        };
        let raw = unsafe { PowerCreateRequest(&context) };
        if raw.is_null() || raw == -1isize as *mut c_void {
            return Err(format!(
                "PowerCreateRequest: {}",
                std::io::Error::last_os_error()
            ));
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        if unsafe { PowerSetRequest(handle.as_raw_handle(), SYSTEM_REQUIRED) } == 0 {
            return Err(format!(
                "PowerSetRequest(SystemRequired): {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self {
            handle: Some(handle),
        })
    }
    fn clear(&mut self) -> Result<(), String> {
        if let Some(handle) = self.handle.take() {
            if unsafe { PowerClearRequest(handle.as_raw_handle(), SYSTEM_REQUIRED) } == 0 {
                return Err(format!(
                    "PowerClearRequest(SystemRequired): {}",
                    std::io::Error::last_os_error()
                ));
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
