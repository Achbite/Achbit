use achbit_kernel_runtime::workspace_boundary::WorkspaceBoundary;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ProjectInstruction {
    pub path: String,
    pub text: String,
}

/// Each project's root-to-directory chain contributes in binding order, once per directory.
pub(crate) fn read_projects(project_roots: &[PathBuf]) -> Result<Vec<ProjectInstruction>, String> {
    let mut directories = Vec::new();
    let mut seen = HashSet::new();
    for project in project_roots {
        let root = project
            .canonicalize()
            .map_err(|error| format!("{}: {error}", project.display()))?;
        if !root.is_dir() {
            return Err(format!(
                "{}: project root is not a directory",
                project.display()
            ));
        }
        let ancestors: Vec<_> = root.ancestors().map(Path::to_path_buf).collect();
        for directory in ancestors.into_iter().rev() {
            if seen.insert(directory.clone()) {
                directories.push(directory);
            }
        }
    }
    read_directories(&directories)
}

/// Read an explicit ordered directory scope without descending into subdirectories.
pub(crate) fn read_directories(directories: &[PathBuf]) -> Result<Vec<ProjectInstruction>, String> {
    let mut instructions = Vec::new();
    let mut sources = HashSet::new();
    for directory in directories {
        if let Some(instruction) = read_directory(directory)? {
            if sources.insert(instruction.path.clone()) {
                instructions.push(instruction);
            }
        }
    }
    Ok(instructions)
}

fn read_directory(directory: &Path) -> Result<Option<ProjectInstruction>, String> {
    let boundary = WorkspaceBoundary::new(directory);
    for name in ["AGENTS.md", "Agents.md"] {
        let source = directory.join(name);
        let target = boundary
            .resolve_read(name)
            .map_err(|error| format!("{}: {error}", source.display()))?;
        match std::fs::read_to_string(&target) {
            Ok(text) => {
                return Ok((!text.trim().is_empty()).then(|| ProjectInstruction {
                    path: achbit_kernel_runtime::file_access::process_visible_path(&target)
                        .to_string_lossy()
                        .into_owned(),
                    text,
                }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{}: {error}", source.display())),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(
                crate::utils::new_runtime_ref("project-instructions-test")
                    .unwrap()
                    .replace(':', "-"),
            );
            std::fs::create_dir_all(&root).unwrap();
            Self(achbit_kernel_runtime::file_access::process_visible_path(
                &root.canonicalize().unwrap(),
            ))
        }
        fn directory(&self, name: &str) -> PathBuf {
            let directory = self.0.join(name);
            std::fs::create_dir_all(&directory).unwrap();
            directory
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn project_instructions_preserve_source_order_body_and_name_precedence() {
        let fixture = Fixture::new();
        let first = fixture.directory("first");
        let second = fixture.directory("second");
        std::fs::write(first.join("AGENTS.md"), "  First project\n\n").unwrap();
        // Case-insensitive filesystems already address the preferred file by this name.
        if !first.join("Agents.md").exists() {
            std::fs::write(first.join("Agents.md"), "Do not select this alias").unwrap();
        }
        std::fs::write(second.join("Agents.md"), "Second project\n").unwrap();
        let instructions = read_directories(&[second.clone(), first.clone()]).unwrap();
        assert_eq!(
            instructions,
            vec![
                ProjectInstruction {
                    path: second.join("Agents.md").to_string_lossy().into_owned(),
                    text: "Second project\n".into()
                },
                ProjectInstruction {
                    path: first.join("AGENTS.md").to_string_lossy().into_owned(),
                    text: "  First project\n\n".into()
                },
            ]
        );
    }

    #[test]
    fn project_instructions_missing_and_empty_files_are_not_contributions() {
        let fixture = Fixture::new();
        let missing = fixture.directory("missing");
        let empty = fixture.directory("empty");
        std::fs::write(empty.join("AGENTS.md"), " \n\t").unwrap();
        if !empty.join("Agents.md").exists() {
            std::fs::write(
                empty.join("Agents.md"),
                "An empty preferred file is still selected",
            )
            .unwrap();
        }
        assert!(read_directories(&[missing, empty]).unwrap().is_empty());
    }

    #[test]
    fn project_instructions_report_real_read_and_utf8_errors_with_the_path() {
        let fixture = Fixture::new();
        let invalid = fixture.directory("invalid");
        let source = invalid.join("AGENTS.md");
        std::fs::write(&source, [0xff]).unwrap();
        if !invalid.join("Agents.md").exists() {
            std::fs::write(invalid.join("Agents.md"), "Do not mask the first error").unwrap();
        }
        let error = read_directories(&[invalid]).unwrap_err();
        assert!(error.contains(source.to_str().unwrap()), "{error}");
        assert!(error.contains("UTF-8"), "{error}");
        let directory = fixture.directory("directory");
        let source = directory.join("AGENTS.md");
        std::fs::create_dir(&source).unwrap();
        let expected = std::fs::read_to_string(&source).unwrap_err().to_string();
        let error = read_directories(&[directory]).unwrap_err();
        assert!(error.contains(source.to_str().unwrap()), "{error}");
        assert!(error.ends_with(&expected), "{error}");
    }

    #[test]
    fn project_instructions_follow_ordered_ancestor_chains_without_scanning_children() {
        let fixture = Fixture::new();
        let first = fixture.directory("a/project");
        let second = fixture.directory("b");
        let child = fixture.directory("a/project/child");
        for (directory, text) in [
            (fixture.0.clone(), "shared ancestor"),
            (fixture.0.join("a"), "first parent"),
            (first.clone(), "first project"),
            (second.clone(), "second project"),
            (child, "not in the ancestor chain"),
        ] {
            std::fs::write(directory.join("AGENTS.md"), text).unwrap();
        }
        let instructions = read_projects(&[second.clone(), first, second]).unwrap();
        let texts: Vec<_> = instructions
            .iter()
            .filter(|item| Path::new(&item.path).starts_with(&fixture.0))
            .map(|item| item.text.as_str())
            .collect();
        assert_eq!(
            texts,
            [
                "shared ancestor",
                "second project",
                "first parent",
                "first project"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_instructions_include_the_same_resolved_source_only_once() {
        let fixture = Fixture::new();
        let project = fixture.directory("project");
        let source = project.join("rules.md");
        std::fs::write(&source, "One source").unwrap();
        std::os::unix::fs::symlink(&source, fixture.0.join("AGENTS.md")).unwrap();
        std::os::unix::fs::symlink(&source, project.join("AGENTS.md")).unwrap();
        let instructions = read_projects(&[project]).unwrap();
        let local: Vec<_> = instructions
            .iter()
            .filter(|item| Path::new(&item.path).starts_with(&fixture.0))
            .collect();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].path, source.to_str().unwrap());
        assert_eq!(local[0].text, "One source");
    }

    #[test]
    fn project_instructions_resolve_only_project_bindings_in_request_order() {
        use crate::local_agent_kernel::{
            LocalAgentKernel, LocalAgentKernelError, ResolvedWorkspace, WorkspaceAccess,
            WorkspaceResolverPort,
        };
        struct Resolver;
        impl WorkspaceResolverPort for Resolver {
            fn resolve(&self, id: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
                let (root, access) = match id {
                    "first" => ("/first", WorkspaceAccess::Project),
                    "second" => ("/second", WorkspaceAccess::Project),
                    "upload" => (
                        "/upload",
                        WorkspaceAccess::SessionInput("session:parent".into()),
                    ),
                    "workdir" => (
                        "/workdir",
                        WorkspaceAccess::SessionWorkdir("session:parent".into()),
                    ),
                    _ => {
                        return Err(LocalAgentKernelError::new(
                            "workspace_not_found",
                            "Original resolver error",
                        ))
                    }
                };
                Ok(ResolvedWorkspace {
                    root: root.into(),
                    access,
                })
            }
        }
        let fixture = Fixture::new();
        let journal =
            crate::local_agent_store::LocalAgentJournal::open(&fixture.0.join("session.sqlite"))
                .unwrap();
        let kernel = LocalAgentKernel::open(
            &fixture.0.join("tools.sqlite"),
            journal,
            std::sync::Arc::new(Resolver),
        )
        .unwrap();
        let ids = ["second", "upload", "workdir", "first"].map(String::from);
        assert_eq!(
            kernel.project_instruction_roots(&ids).unwrap(),
            vec![PathBuf::from("/second"), PathBuf::from("/first")]
        );
        assert!(kernel.project_instruction_roots(&[]).unwrap().is_empty());
        let error = kernel
            .project_instruction_roots(&["missing".into()])
            .unwrap_err();
        assert_eq!(error.code, "workspace_not_found");
        assert_eq!(error.message, "Original resolver error");
    }

    #[cfg(unix)]
    #[test]
    fn project_instructions_keep_the_existing_workspace_read_boundary() {
        let fixture = Fixture::new();
        let directory = fixture.directory("project");
        let outside = fixture.0.join("outside.md");
        std::fs::write(&outside, "Outside the selected directory").unwrap();
        std::os::unix::fs::symlink(&outside, directory.join("AGENTS.md")).unwrap();
        let error = read_directories(&[directory.clone()]).unwrap_err();
        assert!(
            error.contains(directory.join("AGENTS.md").to_str().unwrap()),
            "{error}"
        );
        assert!(error.contains("outside the workspace root"), "{error}");
    }
}
