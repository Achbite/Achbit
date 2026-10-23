//! Inspect the child token before its suspended main thread is resumed.
use super::os::*;
use std::ptr::null_mut;
use windows_sys::Win32::{Foundation::*, Security::*, System::Threading::*};

// TokenSecurityAttributes uses the native layout (UNICODE_STRING names), not
// CLAIM_SECURITY_ATTRIBUTE_V1's null-terminated names. This query works on
// Windows builds that reject TokenIsLessPrivilegedAppContainer with error 87.
#[repr(C)]
struct Attribute {
    name: UNICODE_STRING,
    value_type: u16,
    reserved: u16,
    flags: u32,
    count: u32,
    values: *const u64,
}

#[repr(C)]
struct Attributes {
    version: u16,
    reserved: u16,
    count: u32,
    attributes: *const Attribute,
}

pub(super) fn verified(process: HANDLE) -> Result<Handle, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, &mut token) } == 0 {
        return Err(error("Open sandbox token"));
    }
    let token = Handle(token);
    let mut enabled: u32 = 0;
    let mut length = 0;
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenIsAppContainer,
            (&mut enabled as *mut u32).cast(),
            std::mem::size_of_val(&enabled) as u32,
            &mut length,
        )
    } == 0
    {
        return Err(error("Verify AppContainer token"));
    }
    if enabled == 0 {
        return Err("Windows did not create the requested AppContainer token".into());
    }
    unsafe {
        GetTokenInformation(token.0, TokenSecurityAttributes, null_mut(), 0, &mut length);
    }
    if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(error("Size LPAC token attributes"));
    }
    let mut storage = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenSecurityAttributes,
            storage.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(error("Read LPAC token attributes"));
    }
    let info = unsafe { &*storage.as_ptr().cast::<Attributes>() };
    if info.version != 1 {
        return Err(format!(
            "Unsupported token attribute version {}",
            info.version
        ));
    }
    let expected: Vec<u16> = "WIN://NOALLAPPPKG".encode_utf16().collect();
    for index in 0..info.count {
        // The OS owns the layout and returns pointers into the aligned buffer.
        let attribute = unsafe { &*info.attributes.add(index as usize) };
        let name = unsafe {
            std::slice::from_raw_parts(attribute.name.Buffer, attribute.name.Length as usize / 2)
        };
        if name == expected
            && attribute.value_type == CLAIM_SECURITY_ATTRIBUTE_TYPE_UINT64
            && attribute.count == 1
            && unsafe { *attribute.values } == 1
        {
            return Ok(token);
        }
    }
    Err("Windows did not apply the requested LPAC opt-out".into())
}
