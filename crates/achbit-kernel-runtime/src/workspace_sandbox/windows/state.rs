//! Persistent sandbox identity of one Achbit data root.
//!
//! Every grant is an ACE for a capability SID derived from (owner, access, path).
//! A Shell's token carries only the capabilities of its own admitted scope, so an
//! ACE left in place grants nothing to a later Shell that was not admitted to that
//! path. Grants therefore persist across invocations instead of being propagated
//! through a whole tree and revoked again on every call. The ledger records them
//! for an explicit reset (uninstall or `--workspace-sandbox-reset`).
use super::acl::AclLock;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub(super) struct State {
    root: PathBuf,
    owner: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub(super) struct Entry {
    pub path: PathBuf,
    pub sid: String,
    /// Inheritable ACEs are revoked through the subtree; traversal ACEs are not.
    pub propagate: bool,
}

static STATE: OnceLock<State> = OnceLock::new();

/// Bind the sandbox to a Achbit data root before its first Shell. Without it,
/// tools and tests use one fixed per-user default root.
pub fn configure(root: &Path) -> Result<(), String> {
    let state = State::open(root)?;
    let configured = STATE.get_or_init(|| state);
    if configured.root != root {
        return Err(format!(
            "Windows sandbox state is already bound to {}",
            configured.root.display()
        ));
    }
    Ok(())
}

pub(super) fn state() -> Result<&'static State, String> {
    if let Some(state) = STATE.get() {
        return Ok(state);
    }
    let state = State::open(&std::env::temp_dir().join("Achbit-windows-sandbox"))?;
    Ok(STATE.get_or_init(|| state))
}

/// FNV-1a over the case-folded text: stable across processes and versions.
pub(super) fn stable_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

impl State {
    fn open(root: &Path) -> Result<Self, String> {
        let _lock = AclLock::acquire()?;
        std::fs::create_dir_all(root)
            .map_err(|error| format!("Create Windows sandbox state {}: {error}", root.display()))?;
        let state = Self {
            root: root.to_path_buf(),
            owner: stable_hash(&root.to_string_lossy()),
        };
        state.read_entries()?;
        Ok(state)
    }

    /// The disk ledger is shared across processes. Read it while holding AclLock;
    /// an instance-local snapshot can lose another process's grants during reset.
    fn read_entries(&self) -> Result<HashSet<Entry>, String> {
        let mut entries = HashSet::new();
        match std::fs::read_to_string(self.ledger_path()) {
            Ok(text) => {
                for line in text.lines().filter(|line| !line.trim().is_empty()) {
                    let entry: Entry = serde_json::from_str(line)
                        .map_err(|error| format!("Read Windows sandbox ledger: {error}"))?;
                    // Reset handles removed paths. Reading must not prune or
                    // rewrite records while another process is granting access.
                    entries.insert(entry);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Read Windows sandbox ledger: {error}")),
        }
        Ok(entries)
    }

    fn ledger_path(&self) -> PathBuf {
        self.root.join("acl-ledger.jsonl")
    }

    fn rewrite(&self, entries: &HashSet<Entry>) -> Result<(), String> {
        let text: String = entries
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Serialize Windows sandbox ledger: {error}"))?
            .into_iter()
            .map(|line| line + "\n")
            .collect();
        let temporary = self.root.join("acl-ledger.jsonl.tmp");
        std::fs::write(&temporary, text)
            .and_then(|()| std::fs::rename(&temporary, self.ledger_path()))
            .map_err(|error| format!("Write Windows sandbox ledger: {error}"))
    }

    /// Profiles are per data root and network setting; paths use capabilities.
    pub(super) fn profile_name(&self, network: bool) -> String {
        let network = if network { "online" } else { "offline" };
        format!("Achbit.Shell.{}.{network}", self.owner)
    }

    fn profiles_path(&self) -> PathBuf {
        self.root.join("profiles.txt")
    }

    /// Remember every profile created for this data root, so reset can delete it.
    pub(super) fn record_profile(&self, name: &str) -> Result<(), String> {
        let _lock = AclLock::acquire()?;
        if self.profiles()?.iter().any(|known| known == name) {
            return Ok(());
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.profiles_path())
            .and_then(|mut file| writeln!(file, "{name}"))
            .map_err(|error| format!("Record Windows sandbox profile: {error}"))
    }

    pub(super) fn profiles(&self) -> Result<Vec<String>, String> {
        let _lock = AclLock::acquire()?;
        let text = match std::fs::read_to_string(self.profiles_path()) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("Read Windows sandbox profiles: {error}")),
        };
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(String::from)
            .collect())
    }

    pub(super) fn forget_profiles(&self, kept: &[String]) -> Result<(), String> {
        let _lock = AclLock::acquire()?;
        let text: String = kept.iter().map(|name| format!("{name}\n")).collect();
        std::fs::write(self.profiles_path(), text)
            .map_err(|error| format!("Write Windows sandbox profiles: {error}"))
    }

    pub(super) fn capability_name(&self, kind: &str, path: Option<&Path>) -> String {
        match path {
            Some(path) => format!(
                "Achbit.{}.{kind}.{}",
                self.owner,
                stable_hash(&path.to_string_lossy())
            ),
            None => format!("Achbit.{}.{kind}", self.owner),
        }
    }

    /// Record before the ACE is written: a partial propagation must stay revocable.
    pub(super) fn record(&self, entry: Entry) -> Result<(), String> {
        let _lock = AclLock::acquire()?;
        if self.read_entries()?.contains(&entry) {
            return Ok(());
        }
        let line = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.ledger_path())
            .and_then(|mut file| writeln!(file, "{line}"))
            .map_err(|error| format!("Record Windows sandbox grant: {error}"))?;
        Ok(())
    }

    pub(super) fn entries(&self) -> Result<Vec<Entry>, String> {
        let _lock = AclLock::acquire()?;
        Ok(self.read_entries()?.into_iter().collect())
    }

    /// Keep entries that could not be revoked; drop the rest.
    pub(super) fn retain(&self, failed: &[Entry]) -> Result<(), String> {
        let _lock = AclLock::acquire()?;
        let mut entries = self.read_entries()?;
        entries.retain(|entry| failed.contains(entry));
        self.rewrite(&entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_workers_keep_the_latest_grants_and_can_record_after_reset() {
        let root = std::env::temp_dir().join(format!(
            "achbit-sandbox-workers-{}",
            super::super::os::random_text()
        ));
        let first = State::open(&root).unwrap();
        let second = State::open(&root).unwrap();
        let entries: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|name| {
                let path = root.join(name);
                std::fs::create_dir(&path).unwrap();
                Entry {
                    path,
                    sid: "S-1-15-3-1".into(),
                    propagate: true,
                }
            })
            .collect();
        first.record(entries[0].clone()).unwrap();
        second.record(entries[1].clone()).unwrap();
        for worker in [&first, &second] {
            let recorded = worker.entries().unwrap();
            assert_eq!(recorded.len(), 2, "other workers' grants must stay visible");
            assert!(entries.iter().all(|entry| recorded.contains(entry)));
        }
        // Reset may have failed to revoke a grant written by another worker.
        first.retain(&entries[1..]).unwrap();
        assert_eq!(second.entries().unwrap(), entries[1..]);
        // A worker opened before reset must register a newly applied ACE again.
        second.retain(&[]).unwrap();
        first.record(entries[0].clone()).unwrap();
        assert_eq!(State::open(&root).unwrap().entries().unwrap(), entries[..1]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_profile_ledger_is_reported_without_appending() {
        let root = std::env::temp_dir().join(format!(
            "achbit-sandbox-profiles-{}",
            super::super::os::random_text()
        ));
        let state = State::open(&root).unwrap();
        let invalid = [0xff, 0xfe];
        std::fs::write(state.profiles_path(), invalid).unwrap();
        let result = state.record_profile("Achbit.Shell.test");
        let preserved = std::fs::read(state.profiles_path()).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            result.is_err(),
            "an unreadable ledger must not become an empty list"
        );
        assert_eq!(preserved, invalid);
    }

    #[test]
    fn identities_are_stable_and_scoped_by_data_root_and_path() {
        assert_eq!(stable_hash("C:\\Work"), stable_hash("c:\\work"));
        assert_ne!(stable_hash("C:\\Work"), stable_hash("C:\\Work2"));
        let root =
            std::env::temp_dir().join(format!("achbit-sandbox-state-{}", std::process::id()));
        let state = State::open(&root).unwrap();
        let other = State::open(&root.join("other")).unwrap();
        assert_ne!(state.profile_name(false), other.profile_name(false));
        assert_ne!(state.profile_name(false), state.profile_name(true));
        assert_eq!(state.profile_name(true), state.profile_name(true));
        assert!(
            state.profile_name(true).len() <= 64,
            "AppContainer names are limited to 64 characters"
        );
        state.record_profile("Achbit.Shell.test.a").unwrap();
        state.record_profile("Achbit.Shell.test.a").unwrap();
        assert_eq!(
            state.profiles().unwrap(),
            vec!["Achbit.Shell.test.a".to_string()]
        );
        state.forget_profiles(&[]).unwrap();
        assert!(state.profiles().unwrap().is_empty());
        let path = Path::new(r"C:\project");
        assert_eq!(
            state.capability_name("Read", Some(path)),
            state.capability_name("Read", Some(path))
        );
        assert_ne!(
            state.capability_name("Read", Some(path)),
            state.capability_name("Write", Some(path))
        );
        let entry = Entry {
            path: root.clone(),
            sid: "S-1-15-3-1".into(),
            propagate: true,
        };
        state.record(entry.clone()).unwrap();
        state.record(entry.clone()).unwrap();
        let reopened = State::open(&root).unwrap();
        assert_eq!(reopened.entries().unwrap(), vec![entry]);
        reopened.retain(&[]).unwrap();
        assert!(State::open(&root).unwrap().entries().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
