//! Capability-scoped ACEs. A grant is written only when the suspended child's
//! actual token lacks the access; afterwards the ACE stays and later invocations
//! with the same admitted path reuse it without walking the tree again. Remove
//! only our SIDs, never restore a stale copy of someone else's DACL.
use super::os::*;
use super::profile::sid_string;
use super::state::{Entry, State};
use super::windows_policy::{Access, Grant};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{SystemServices::SECURITY_DESCRIPTOR_REVISION, Threading::*},
};

const READ: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
const TRAVERSE: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
// Delete the admitted objects, without extending authority through their parent.
const WRITE: u32 =
    FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE;

/// Optional paths this process could not grant: not retried or reported again.
static UNGRANTABLE: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Make every grant effective for the suspended child's token. Returns warnings
/// for skipped optional grants (each reported once per process).
pub(super) fn ensure(
    grants: &[(&Grant, PSID)],
    token: HANDLE,
    state: &State,
) -> Result<Vec<String>, String> {
    let runtime = RuntimeAccess::new(token)?;
    let mut lock = None;
    let mut warnings = Vec::new();
    for (grant, sid) in grants {
        let skipped = |reason: String, warnings: &mut Vec<String>| {
            let mut known = UNGRANTABLE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if known
                .get_or_insert_with(HashSet::new)
                .insert(grant.path.clone())
                && grant.access != Access::Traverse
            {
                warnings.push(format!(
                    "Skipped optional sandbox read access to {}: {reason}",
                    crate::file_access::process_visible_path(&grant.path).display()
                ));
            }
        };
        if grant.optional
            && UNGRANTABLE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .is_some_and(|known| known.contains(&grant.path))
        {
            continue;
        }
        let metadata = match std::fs::metadata(&grant.path) {
            Ok(metadata) => metadata,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && matches!(grant.access, Access::Read | Access::Traverse) =>
            {
                continue
            }
            Err(error) if grant.optional => {
                skipped(error.to_string(), &mut warnings);
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "Inspect sandbox path {}: {error}",
                    grant.path.display()
                ))
            }
        };
        let mask = match grant.access {
            Access::Read => READ,
            Access::Traverse => TRAVERSE,
            Access::Write => READ | WRITE,
        };
        // A normal user's Everyone/Users/AAP access is not proof of LPAC access.
        // Query the suspended child, including its package claims and capabilities.
        let satisfied = runtime.allows(&grant.path, mask);
        match satisfied {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) if grant.optional => {
                skipped(error, &mut warnings);
                continue;
            }
            Err(error) => return Err(error),
        }
        if lock.is_none() {
            lock = Some(AclLock::acquire()?);
        }
        let handle = match open_for_dacl(&grant.path) {
            Ok(handle) => handle,
            Err(error) if grant.optional => {
                skipped(error, &mut warnings);
                continue;
            }
            Err(error) => return Err(error),
        };
        let propagate = grant.access != Access::Traverse;
        if !grant.ephemeral {
            state.record(Entry {
                path: grant.path.clone(),
                sid: sid_string(*sid)?,
                propagate,
            })?;
        }
        let inherit = if metadata.is_dir() && grant.access != Access::Traverse {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            NO_INHERITANCE
        };
        let applied = edit(handle.0, *sid, GRANT_ACCESS, mask, inherit, propagate)
            .map_err(|error| format!("Grant sandbox path {}: {error}", grant.path.display()));
        match applied {
            Ok(()) => {}
            Err(error) if grant.optional => skipped(error, &mut warnings),
            Err(error) => return Err(error),
        }
    }
    Ok(warnings)
}

/// Remove one recorded ACE (allow or deny) for exactly this SID.
pub(super) fn revoke(entry: &Entry) -> Result<(), String> {
    if !entry.path.exists() {
        return Ok(());
    }
    let sid = sid(&entry.sid)?;
    let handle = open_for_dacl(&entry.path)?;
    edit(
        handle.0,
        sid.0,
        REVOKE_ACCESS,
        0,
        NO_INHERITANCE,
        entry.propagate,
    )
    .map_err(|error| format!("Revoke sandbox grant {}: {error}", entry.path.display()))
}

/// Serialize DACL edits with other processes, revoking parents first so their
/// inherited ACEs leave the subtree before child entries are processed.
pub(super) fn revoke_all(entries: &mut [Entry]) -> Vec<(Entry, String)> {
    let _lock = match AclLock::acquire() {
        Ok(lock) => lock,
        Err(error) => {
            return entries
                .iter()
                .map(|entry| (entry.clone(), error.clone()))
                .collect()
        }
    };
    entries.sort_by_key(|entry| entry.path.components().count());
    entries
        .iter()
        .filter_map(|entry| revoke(entry).err().map(|error| (entry.clone(), error)))
        .collect()
}

fn open_for_dacl(path: &Path) -> Result<Handle, String> {
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(error(&format!(
            "Open sandbox ACL {} (the current user must be able to grant this resource)",
            path.display()
        )));
    }
    Ok(Handle(handle))
}

fn trustee(sid: PSID) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid.cast(),
    }
}

fn edit(
    handle: HANDLE,
    sid: PSID,
    mode: ACCESS_MODE,
    mask: u32,
    inheritance: u32,
    propagate: bool,
) -> Result<(), String> {
    let (mut descriptor, mut acl) = (null_mut(), null_mut());
    let result = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result == ERROR_FILE_NOT_FOUND || result == ERROR_DELETE_PENDING {
        return Ok(());
    }
    code("Read path DACL", result)?;
    let _descriptor = Local(descriptor);
    // A null DACL grants unrestricted access and cannot express a read boundary.
    if acl.is_null() {
        return Err("The path has no discretionary access control list".into());
    }
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: inheritance,
        Trustee: trustee(sid),
    };
    let mut updated = null_mut();
    code("Build sandbox ACL", unsafe {
        SetEntriesInAclW(1, &entry, acl, &mut updated)
    })?;
    let _updated = Local(updated.cast());
    if !propagate {
        return set_directory_metadata_dacl(handle, updated);
    }
    code("Apply sandbox ACL", unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            updated,
            null_mut(),
        )
    })
}

// SetSecurityInfo propagates every existing inheritable ACE, even when the new
// ACE is not inheritable. Set only this directory's DACL through the native
// handle API, preserving inherited entries and the current protection state.
// MAXIMUM_ALLOWED handles also suppress propagation, but request DELETE access
// and conflict with ordinary open working-directory handles.
fn set_directory_metadata_dacl(handle: HANDLE, acl: *mut ACL) -> Result<(), String> {
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSetSecurityObject(
            handle: HANDLE,
            information: u32,
            descriptor: PSECURITY_DESCRIPTOR,
        ) -> i32;
    }
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let pointer = (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast();
    if unsafe { InitializeSecurityDescriptor(pointer, SECURITY_DESCRIPTOR_REVISION) } == 0
        || unsafe { SetSecurityDescriptorDacl(pointer, 1, acl, 0) } == 0
    {
        return Err(error("Build ancestor metadata DACL"));
    }
    let status = unsafe { NtSetSecurityObject(handle, DACL_SECURITY_INFORMATION, pointer) };
    if status < 0 {
        Err(format!(
            "Apply ancestor metadata DACL: NTSTATUS {status:#x}"
        ))
    } else {
        Ok(())
    }
}

// Use the real child token: Store runtime access also depends on package claims.
// AccessCheck preserves LPAC restrictions and handles inherited deny ACEs that
// GetEffectiveRightsFromAcl rejects as ERROR_INVALID_ACL. Never impersonate the
// child on the worker thread while changing ACLs.
struct RuntimeAccess(Handle);

impl RuntimeAccess {
    fn new(token: HANDLE) -> Result<Self, String> {
        let mut impersonation = null_mut();
        if unsafe { DuplicateToken(token, SecurityIdentification, &mut impersonation) } == 0 {
            return Err(error("Duplicate LPAC token for runtime access checks"));
        }
        Ok(Self(Handle(impersonation)))
    }

    /// Whether the child token holds every right in `mask` on this path. Ask for
    /// exact rights: MAXIMUM_ALLOWED does not reflect the AppContainer check.
    fn allows(&self, path: &Path, mask: u32) -> Result<bool, String> {
        self.check(path, mask)
            .map_err(|error| format!("Check LPAC runtime access {}: {error}", path.display()))
    }

    fn check(&self, path: &Path, mask: u32) -> Result<bool, String> {
        let (mut descriptor, mut acl) = (null_mut(), null_mut());
        code("Read runtime path DACL", unsafe {
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        })?;
        let _descriptor = Local(descriptor);
        if acl.is_null() {
            return Err("The path has no discretionary access control list".into());
        }
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ,
            GenericWrite: FILE_GENERIC_WRITE,
            GenericExecute: FILE_GENERIC_EXECUTE,
            GenericAll: FILE_ALL_ACCESS,
        };
        let mut privileges: PRIVILEGE_SET = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&privileges) as u32;
        let (mut rights, mut allowed) = (0, 0);
        if unsafe {
            AccessCheck(
                descriptor,
                self.0 .0,
                mask,
                &mapping,
                &mut privileges,
                &mut length,
                &mut rights,
                &mut allowed,
            )
        } == 0
        {
            return Err(error("Evaluate runtime access"));
        }
        Ok(allowed != 0 && rights & mask == mask)
    }
}

// Kernel tool workers are separate processes. Serialize DACL read/modify/write
// across them; the mutex is held only while editing, never during execution.
struct AclLock(Handle);
impl AclLock {
    fn acquire() -> Result<Self, String> {
        let handle = unsafe {
            CreateMutexW(
                null(),
                0,
                wide(r"Local\DeepCode.WorkspaceSandbox.Acl").as_ptr(),
            )
        };
        if handle.is_null() {
            return Err(error("Create sandbox ACL mutex"));
        }
        let handle = Handle(handle);
        let result = unsafe { WaitForSingleObject(handle.0, 30_000) };
        if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED {
            return Err(format!("Acquire sandbox ACL mutex: wait result {result}"));
        }
        Ok(Self(handle))
    }
}
impl Drop for AclLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(in super::super) fn contains_sid(path: &Path, sid_text: &str) -> bool {
        let wanted = sid(sid_text).unwrap();
        let (mut descriptor, mut acl) = (null_mut(), null_mut());
        code("Read test DACL", unsafe {
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        })
        .unwrap();
        let _owner = Local(descriptor);
        for index in 0..unsafe { (*acl).AceCount } {
            let mut ace = null_mut();
            assert_ne!(unsafe { GetAce(acl, u32::from(index), &mut ace) }, 0);
            let ace = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            // These test directories use ordinary allow/deny ACE layouts.
            if matches!(ace.Header.AceType, 0 | 1)
                && unsafe { EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), wanted.0) }
                    != 0
            {
                return true;
            }
        }
        false
    }

    #[test]
    fn revoking_one_capability_keeps_other_grants() {
        let root = std::env::temp_dir().join(format!("deepcode-acl-{}", random_text()));
        std::fs::create_dir(&root).unwrap();
        let path = root.canonicalize().unwrap();
        let capabilities = super::super::profile::Capabilities::derive(&[
            format!("DeepCode.test.Write.{}", random_text()),
            format!("DeepCode.test.Read.{}", random_text()),
        ])
        .unwrap();
        let (first, second) = (
            sid_string(capabilities.sid(0)).unwrap(),
            sid_string(capabilities.sid(1)).unwrap(),
        );
        for (sid, mask) in [
            (capabilities.sid(0), READ | WRITE),
            (capabilities.sid(1), READ),
        ] {
            let handle = open_for_dacl(&path).unwrap();
            edit(
                handle.0,
                sid,
                GRANT_ACCESS,
                mask,
                SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                true,
            )
            .unwrap();
        }
        assert!(contains_sid(&path, &first) && contains_sid(&path, &second));
        revoke(&Entry {
            path: path.clone(),
            sid: first.clone(),
            propagate: true,
        })
        .unwrap();
        assert!(!contains_sid(&path, &first));
        assert!(contains_sid(&path, &second));
        std::fs::remove_dir_all(root).unwrap();
    }
}
