//! Fixed AppContainer identities and per-invocation capability sets.
use super::os::*;
use std::ptr::null_mut;
use windows_sys::Win32::Security::{Authorization::ConvertSidToStringSidW, Isolation::*, *};
use windows_sys::Win32::System::SystemServices::SE_GROUP_ENABLED;

const ALREADY_EXISTS: i32 = 0x8007_00B7_u32 as i32;
const NOT_FOUND: [i32; 2] = [0x8007_0002_u32 as i32, 0x8007_0490_u32 as i32];

/// One identity per data root and network setting, reused by every invocation.
/// Access comes from the capabilities in each token, never from this SID.
pub(super) struct Profile {
    sid: PSID,
}

// The SID is immutable after creation and only read by Win32 calls.
unsafe impl Send for Profile {}
unsafe impl Sync for Profile {}

impl Profile {
    pub(super) fn open(name: &str) -> Result<Self, String> {
        let wide_name = wide(name);
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                wide_name.as_ptr(),
                wide_name.as_ptr(),
                wide_name.as_ptr(),
                std::ptr::null(),
                0,
                &mut sid,
            )
        };
        if result == ALREADY_EXISTS {
            let derived =
                unsafe { DeriveAppContainerSidFromAppContainerName(wide_name.as_ptr(), &mut sid) };
            if derived < 0 {
                return Err(format!(
                    "Open Shell AppContainer profile {name}: HRESULT {derived:#x}"
                ));
            }
        } else if result < 0 {
            return Err(format!(
                "Create Shell AppContainer profile {name}: HRESULT {result:#x}"
            ));
        }
        Ok(Self { sid })
    }

    pub(super) fn delete(name: &str) -> Result<(), String> {
        let result = unsafe { DeleteAppContainerProfile(wide(name).as_ptr()) };
        if result < 0 && !NOT_FOUND.contains(&result) {
            return Err(format!(
                "Delete Shell AppContainer profile {name}: HRESULT {result:#x}"
            ));
        }
        Ok(())
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.sid);
        }
    }
}

/// Capabilities carried by one invocation's token: Windows runtime capabilities
/// plus one capability per admitted grant.
pub(super) struct Capabilities {
    storage: Vec<Local>,
    attributes: Vec<SID_AND_ATTRIBUTES>,
}

impl Capabilities {
    pub(super) fn derive(names: &[String]) -> Result<Self, String> {
        let storage = names
            .iter()
            .map(|name| capability(name))
            .collect::<Result<Vec<_>, _>>()?;
        let attributes = storage
            .iter()
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.0,
                Attributes: SE_GROUP_ENABLED as u32,
            })
            .collect();
        Ok(Self {
            storage,
            attributes,
        })
    }

    pub(super) fn sid(&self, index: usize) -> PSID {
        self.storage[index].0
    }

    pub(super) fn security(&self, profile: &Profile) -> SECURITY_CAPABILITIES {
        SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            // CreateProcess rejects a non-null pointer to an empty list (error 87).
            Capabilities: if self.attributes.is_empty() {
                null_mut()
            } else {
                self.attributes.as_ptr() as *mut _
            },
            CapabilityCount: self.attributes.len() as u32,
            Reserved: 0,
        }
    }
}

pub(super) fn sid_string(sid: PSID) -> Result<String, String> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(error("Format capability SID"));
    }
    let _owner = Local(text.cast());
    let length = unsafe { (0..).take_while(|i| *text.add(*i) != 0).count() };
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(text, length)
    }))
}

fn capability(name: &str) -> Result<Local, String> {
    let (mut groups, mut sids) = (null_mut(), null_mut());
    let (mut group_count, mut count) = (0, 0);
    if unsafe {
        DeriveCapabilitySidsFromName(
            wide(name).as_ptr(),
            &mut groups,
            &mut group_count,
            &mut sids,
            &mut count,
        )
    } == 0
    {
        return Err(error(&format!("Derive Windows capability {name}")));
    }
    let _groups = Local(groups.cast());
    let _sids = Local(sids.cast());
    for i in 0..group_count {
        drop(Local(unsafe { *groups.add(i as usize) }));
    }
    let mut capabilities = (0..count)
        .map(|i| Local(unsafe { *sids.add(i as usize) }))
        .collect::<Vec<_>>();
    if capabilities.len() != 1 {
        return Err(format!("Expected one SID for Windows capability {name}"));
    }
    Ok(capabilities.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_profile_is_reused_and_capabilities_are_deterministic() {
        let name = format!("Achbit.Shell.test{}", std::process::id());
        let first = Profile::open(&name).unwrap();
        let second = Profile::open(&name).expect("an existing profile is opened, not recreated");
        assert_eq!(
            sid_string(first.sid).unwrap(),
            sid_string(second.sid).unwrap()
        );
        let directory = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
            .join("Packages")
            .join(&name);
        assert!(directory.is_dir());
        super::super::runner::probe(&first, &Capabilities::derive(&[]).unwrap()).unwrap();
        let names = [
            "Achbit.test.Read.0".to_string(),
            "Achbit.test.Write.0".to_string(),
        ];
        let (a, b) = (
            Capabilities::derive(&names).unwrap(),
            Capabilities::derive(&names).unwrap(),
        );
        assert_eq!(sid_string(a.sid(0)).unwrap(), sid_string(b.sid(0)).unwrap());
        assert_ne!(sid_string(a.sid(0)).unwrap(), sid_string(a.sid(1)).unwrap());
        drop((first, second));
        Profile::delete(&name).unwrap();
        Profile::delete(&name).expect("deleting a missing profile is not an error");
        assert!(!directory.exists(), "deleted profile left its storage");
    }
}
