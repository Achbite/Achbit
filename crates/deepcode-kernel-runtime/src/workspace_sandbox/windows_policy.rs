//! Translate the shared, admitted file scope; this module owns no approvals.
use crate::executors::WorkspaceWriteTarget;
use crate::file_access::FileAccessScope;
use deepcode_kernel_abi::{KernelError, KernelResult};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Access {
    Read,
    Traverse,
    Write,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Grant {
    pub path: PathBuf,
    pub access: Access,
    /// Startup-only access (traversal, PATH, toolchains): skipped with a warning
    /// when the current user cannot grant it, instead of refusing the Shell.
    pub optional: bool,
    /// The invocation's own scratch directory: removed with the invocation, so
    /// its grant is not recorded for reset.
    pub ephemeral: bool,
}

impl Grant {
    fn new(path: &Path, access: Access) -> Self {
        Self {
            path: path.to_path_buf(),
            access,
            optional: access == Access::Traverse,
            ephemeral: false,
        }
    }
}

pub(super) fn grants(
    root: &Path,
    mode: &str,
    targets: Option<&[WorkspaceWriteTarget]>,
    temporary: &Path,
    executable: &Path,
    files: &FileAccessScope,
) -> KernelResult<Vec<Grant>> {
    if !matches!(mode, "read" | "write") {
        return Err(KernelError::InvalidCommand("Invalid workspace mode".into()));
    }
    super::validate_write_scope(root, mode, targets, temporary, files)?;
    let mut grants: Vec<Grant> = Vec::new();
    let mut add = |path: &Path, access| {
        if !grants
            .iter()
            .any(|grant| grant.path == path && grant.access == access)
        {
            grants.push(Grant::new(path, access));
        }
    };
    add(root, Access::Read);
    add(executable, Access::Read);
    for path in &files.read {
        add(path, Access::Read);
    }
    for path in super::writable_paths(root, mode, targets)? {
        add(&path, Access::Write);
    }
    for path in super::writable_paths(root, "write", Some(&files.write))? {
        add(&path, Access::Write);
    }
    add(temporary, Access::Write);
    if let Some(home) = &files.home {
        add(home, Access::Write);
    }
    for grant in &mut grants {
        grant.optional |=
            grant.access == Access::Read && files.best_effort_read.contains(&grant.path);
        grant.ephemeral = grant.path == temporary;
    }
    drop_covered(&mut grants);
    // PowerShell resolves the casing/attributes of path ancestors. Grant only
    // traversal and metadata on those directories, with no inheritance/listing.
    let ancestors: Vec<_> = grants
        .iter()
        .filter(|grant| {
            matches!(grant.access, Access::Read | Access::Write) && grant.path != executable
        })
        .flat_map(|grant| grant.path.ancestors().skip(1))
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .collect();
    for path in ancestors {
        if !grants
            .iter()
            .any(|grant| grant.path == path && grant.access == Access::Traverse)
        {
            grants.push(Grant::new(&path, Access::Traverse));
        }
    }
    Ok(grants)
}

/// A directory grant is inherited by its whole subtree, and a write grant
/// includes reading. Grants it already implies only add capability SIDs and ACL
/// work. An optional grant may be skipped,
/// so it never stands in for a required one.
fn drop_covered(grants: &mut Vec<Grant>) {
    let covering: Vec<(PathBuf, Access, bool)> = grants
        .iter()
        .filter(|grant| matches!(grant.access, Access::Read | Access::Write) && !grant.optional)
        .map(|grant| (grant.path.clone(), grant.access, grant.path.is_dir()))
        .collect();
    grants.retain(|grant| {
        if !matches!(grant.access, Access::Read | Access::Write) {
            return true;
        }
        !covering.iter().any(|(path, access, directory)| {
            let implies = *access == Access::Write || grant.access == Access::Read;
            let same =
                grant.path == *path && *access == Access::Write && grant.access == Access::Read;
            let inside = *directory && grant.path != *path && grant.path.starts_with(path);
            same || (implies && inside)
        })
    });
}

pub(super) fn capabilities(network: bool) -> Vec<&'static str> {
    // Windows runtime dependencies, not access to user documents or credentials.
    let mut names = vec![
        "registryRead",
        "lpacCom",
        "lpacCryptoServices",
        // PowerShell registers its ETW provider during startup.
        "lpacInstrumentation",
    ];
    if network {
        names.extend([
            "internetClient",
            "internetClientServer",
            "privateNetworkClientServer",
        ]);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn has(result: &[Grant], path: &Path, access: Access) -> bool {
        result
            .iter()
            .any(|grant| grant.path == path && grant.access == access)
    }

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "deepcode-policy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn read_scope_does_not_grant_workspace_writes_or_read_ancestors() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-policy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside/allowed.txt");
        let home = root.join("home");
        let scratch = root.join("scratch");
        let files = FileAccessScope {
            read: vec![outside.clone()],
            home: Some(home.clone()),
            read_only: vec![workspace.join(".git")],
            ..Default::default()
        };
        let result = grants(
            &workspace,
            "read",
            None,
            &scratch,
            Path::new("shell.exe"),
            &files,
        )
        .unwrap();
        for (path, access) in [
            (&workspace, Access::Read),
            (&outside, Access::Read),
            (&home, Access::Write),
            (&scratch, Access::Write),
        ] {
            assert!(has(&result, path, access), "{path:?} {access:?}");
        }
        assert!(!has(&result, &workspace, Access::Write));
        assert!(!result.iter().any(|grant| (grant.path == root
            || grant.path == root.join("outside"))
            && grant.access != Access::Traverse));
        assert!(has(&result, &root, Access::Traverse));
        assert!(!has(&result, &workspace.join(".git"), Access::Write));
        assert!(result
            .iter()
            .all(|grant| grant.optional == (grant.access == Access::Traverse)));
        assert!(result
            .iter()
            .all(|grant| grant.ephemeral == (grant.path == scratch)));
        assert!(!capabilities(false).contains(&"internetClient"));
        assert!(capabilities(true).contains(&"internetClient"));
    }

    #[test]
    fn plan_outputs_and_explicit_git_file_grant_preserve_other_protection() {
        let root = fixture();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let config = root.join(".git/config");
        std::fs::write(&config, "").unwrap();
        let config = config.canonicalize().unwrap();
        let output = root.join("output");
        let files = FileAccessScope {
            write: vec![WorkspaceWriteTarget {
                path: config.clone(),
                directory: false,
            }],
            read_only: vec![root.join(".git")],
            ..Default::default()
        };
        let targets = [WorkspaceWriteTarget {
            path: output.clone(),
            directory: true,
        }];
        let result = grants(
            &root,
            "write",
            Some(&targets),
            &root.join("scratch"),
            Path::new("shell.exe"),
            &files,
        )
        .unwrap();
        assert!(has(&result, &output.canonicalize().unwrap(), Access::Write));
        assert!(has(&result, &config, Access::Write));
        assert!(!has(&result, &root.join(".git"), Access::Write));
        assert!(!has(&result, &root, Access::Write));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn implied_grants_are_dropped_but_protected_exceptions_and_optional_roots_stay() {
        let root = fixture();
        let workdir = root.join("session");
        let home = workdir.join("home");
        let tools = root.join("tools");
        let tool_bin = tools.join("bin");
        for path in [&home, &tool_bin, &root.join("workspace/.git")] {
            std::fs::create_dir_all(path).unwrap();
        }
        let workspace = root.join("workspace");
        let config = workspace.join(".git/config");
        std::fs::write(&config, "").unwrap();
        let files = FileAccessScope {
            read: vec![
                workspace.join("src"),
                tools.clone(),
                tool_bin.clone(),
                workdir.clone(),
            ],
            best_effort_read: vec![tools.clone(), tool_bin.clone()],
            write: vec![
                WorkspaceWriteTarget {
                    path: workdir.clone(),
                    directory: true,
                },
                WorkspaceWriteTarget {
                    path: config.clone(),
                    directory: false,
                },
            ],
            home: Some(home.clone()),
            read_only: vec![workspace.join(".git")],
            ..Default::default()
        };
        let result = grants(
            &workspace,
            "read",
            None,
            &root.join("scratch"),
            Path::new("shell.exe"),
            &files,
        )
        .unwrap();
        // Inherited from the workspace and Session working-directory grants.
        assert!(!has(&result, &workspace.join("src"), Access::Read));
        assert!(!has(&result, &home, Access::Write));
        assert!(!has(&result, &workdir, Access::Read));
        assert!(has(&result, &workdir, Access::Write));
        // The exact resource grant does not grant its protected parent.
        assert!(has(&result, &config, Access::Write));
        assert!(!has(&result, &workspace.join(".git"), Access::Write));
        // A skippable root cannot stand in for anything: both best-effort grants stay.
        for path in [&tools, &tool_bin] {
            let grant = result
                .iter()
                .find(|grant| grant.path == *path && grant.access == Access::Read)
                .unwrap();
            assert!(grant.optional);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
