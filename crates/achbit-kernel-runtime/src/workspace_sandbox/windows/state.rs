//! Persistent sandbox identity of one Achbit data root.
//!
//! Every grant is an ACE for a capability SID derived from (owner, access, path).
//! A Shell's token carries only the capabilities of its own admitted scope, so an
//! ACE left in place grants nothing to a later Shell that was not admitted to that
//! path. Grants therefore persist across invocations instead of being propagated
//! through a whole tree and revoked again on every call. The ledger records them
//! for an explicit reset (uninstall or `--workspace-sandbox-reset`).
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub(super) struct State {
    root: PathBuf,
    owner: String,
    ledger: Mutex<HashSet<Entry>>,
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
        std::fs::create_dir_all(root)
            .map_err(|error| format!("Create Windows sandbox state {}: {error}", root.display()))?;
        let ledger = root.join("acl-ledger.jsonl");
        let mut entries = HashSet::new();
        match std::fs::read_to_string(&ledger) {
            Ok(text) => {
                for line in text.lines().filter(|line| !line.trim().is_empty()) {
                    let entry: Entry = serde_json::from_str(line)
                        .map_err(|error| format!("Read Windows sandbox ledger: {error}"))?;
                    // A removed path took its ACEs with it.
                    if entry.path.exists() {
                        entries.insert(entry);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Read Windows sandbox ledger: {error}")),
        }
        let state = Self {
            root: root.to_path_buf(),
            owner: stable_hash(&root.to_string_lossy()),
            ledger: Mutex::new(entries),
        };
        state.rewrite()?;
        Ok(state)
    }

    fn ledger_path(&self) -> PathBuf {
        self.root.join("acl-ledger.jsonl")
    }

    fn rewrite(&self) -> Result<(), String> {
        let entries = self
            .ledger
            .lock()
            .map_err(|_| "Windows sandbox ledger unavailable")?;
        let text: String = entries
            .iter()
            .filter_map(|entry| serde_json::to_string(entry).ok())
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
        let _guard = self
            .ledger
            .lock()
            .map_err(|_| "Windows sandbox ledger unavailable")?;
        if self.profiles().iter().any(|known| known == name) {
            return Ok(());
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.profiles_path())
            .and_then(|mut file| writeln!(file, "{name}"))
            .map_err(|error| format!("Record Windows sandbox profile: {error}"))
    }

    pub(super) fn profiles(&self) -> Vec<String> {
        std::fs::read_to_string(self.profiles_path())
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(String::from)
            .collect()
    }

    pub(super) fn forget_profiles(&self, kept: &[String]) -> Result<(), String> {
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
        let mut entries = self
            .ledger
            .lock()
            .map_err(|_| "Windows sandbox ledger unavailable")?;
        if entries.contains(&entry) {
            return Ok(());
        }
        let line = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.ledger_path())
            .and_then(|mut file| writeln!(file, "{line}"))
            .map_err(|error| format!("Record Windows sandbox grant: {error}"))?;
        entries.insert(entry);
        Ok(())
    }

    pub(super) fn entries(&self) -> Result<Vec<Entry>, String> {
        Ok(self
            .ledger
            .lock()
            .map_err(|_| "Windows sandbox ledger unavailable")?
            .iter()
            .cloned()
            .collect())
    }

    /// Keep entries that could not be revoked; drop the rest.
    pub(super) fn retain(&self, failed: &[Entry]) -> Result<(), String> {
        self.ledger
            .lock()
            .map_err(|_| "Windows sandbox ledger unavailable")?
            .retain(|entry| failed.contains(entry));
        self.rewrite()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(state.profiles(), vec!["Achbit.Shell.test.a".to_string()]);
        state.forget_profiles(&[]).unwrap();
        assert!(state.profiles().is_empty());
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
