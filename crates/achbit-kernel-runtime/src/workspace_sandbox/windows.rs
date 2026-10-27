//! Native Windows implementation of the shared workspace permission scope.
//! Shells run as a Low Privilege AppContainer of this Achbit data root. Each
//! token carries one capability per admitted path, so persistent, capability-
//! scoped ACEs grant nothing to a Shell that was not admitted to that path.
//! No dedicated account, elevation, password or firewall change is required.
use super::{windows_policy, SandboxStatus};
use crate::executors::WorkspaceWriteTarget;
use crate::file_access::FileAccessScope;
use std::path::Path;

mod acl;
mod os;
mod profile;
mod runner;
mod state;
mod token;

pub(crate) use runner::Child;
pub use state::configure;

pub(crate) struct Sandbox {
    profile: profile::Profile,
    capabilities: profile::Capabilities,
    grants: Vec<windows_policy::Grant>,
    /// Grant index and its path capability index.
    entries: Vec<(usize, usize)>,
    warnings: Vec<String>,
}

fn grant_kind(access: windows_policy::Access) -> &'static str {
    match access {
        windows_policy::Access::Read => "Read",
        windows_policy::Access::Write => "Write",
        windows_policy::Access::Traverse => "Traverse",
    }
}

impl Sandbox {
    pub(crate) fn prepare(
        root: &Path,
        mode: &str,
        targets: Option<&[WorkspaceWriteTarget]>,
        temporary: &Path,
        executable: &Path,
        files: &FileAccessScope,
    ) -> Result<Self, String> {
        let grants = windows_policy::grants(root, mode, targets, temporary, executable, files)
            .map_err(|error| error.to_string())?;
        let state = state::state()?;
        let profile_name = state.profile_name(files.network_access);
        state.record_profile(&profile_name)?;
        let profile = profile::Profile::open(&profile_name)?;
        let mut names: Vec<String> = windows_policy::capabilities(files.network_access)
            .into_iter()
            .map(String::from)
            .collect();
        let mut entries = Vec::with_capacity(grants.len());
        for (index, grant) in grants.iter().enumerate() {
            let name = match grant.access {
                // Traversal of ancestors reveals no contents and is shared by all.
                windows_policy::Access::Traverse => state.capability_name("Traverse", None),
                access => state.capability_name(grant_kind(access), Some(&grant.path)),
            };
            let capability = names
                .iter()
                .position(|existing| *existing == name)
                .unwrap_or_else(|| {
                    names.push(name);
                    names.len() - 1
                });
            entries.push((index, capability));
        }
        Ok(Self {
            capabilities: profile::Capabilities::derive(&names)?,
            profile,
            grants,
            entries,
            warnings: Vec::new(),
        })
    }

    pub(crate) fn spawn(
        &mut self,
        command: &std::process::Command,
        terminal: bool,
    ) -> Result<Child, String> {
        let state = state::state()?;
        let grants: Vec<_> = self
            .entries
            .iter()
            .map(|(grant, capability)| (&self.grants[*grant], self.capabilities.sid(*capability)))
            .collect();
        let warnings = &mut self.warnings;
        runner::spawn(
            command,
            terminal,
            &self.profile,
            &self.capabilities,
            |token| {
                *warnings = acl::ensure(&grants, token, state)?;
                Ok(())
            },
        )
    }

    /// Skipped optional grants, for the invocation's output.
    pub(crate) fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Persistent grants stay for later invocations; the scratch grant leaves
    /// with the scratch directory. Nothing is revoked per invocation.
    pub(crate) fn cleanup(&mut self) -> Result<(), String> {
        Ok(())
    }
}

pub fn probe() -> SandboxStatus {
    SandboxStatus::observed("windows-lpac", request_setup())
}

/// Retain the operator check endpoint. The backend needs no administrator setup.
/// Probe the actual LPAC launch path instead of treating an API import as support.
pub fn request_setup() -> Result<(), String> {
    let state = state::state()?;
    let name = state.profile_name(false);
    state.record_profile(&name)?;
    let profile = profile::Profile::open(&name)?;
    let capabilities = profile::Capabilities::derive(
        &windows_policy::capabilities(false)
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>(),
    )?;
    runner::probe(&profile, &capabilities)
}

/// Remove every recorded grant and this data root's profiles. Shells started
/// afterwards grant their access again; run it with Achbit closed (uninstall).
pub fn reset() -> Result<(), String> {
    let state = state::state()?;
    let mut entries = state.entries()?;
    let failures = acl::revoke_all(&mut entries);
    let failed: Vec<_> = failures.iter().map(|(entry, _)| entry.clone()).collect();
    state.retain(&failed)?;
    let mut errors: Vec<String> = failures.into_iter().map(|(_, error)| error).collect();
    let mut names = state.profiles();
    for network in [false, true] {
        let name = state.profile_name(network);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let mut kept = Vec::new();
    for name in names {
        if let Err(error) = profile::Profile::delete(&name) {
            errors.push(error);
            kept.push(name);
        }
    }
    state.forget_profiles(&kept)?;
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Windows sandbox reset incomplete: {}",
            errors.join("; ")
        ))
    }
}

fn finish<T>(result: Result<T, String>, cleanup: Result<(), String>) -> Result<T, String> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; cleanup failed: {cleanup}")),
    }
}
