use super::*;
use deepcode_kernel_runtime::executors::WorkspaceWriteTarget;
use deepcode_kernel_runtime::file_access::resolve_path;
use serde::Serialize;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RequestedFiles {
    #[serde(default)]
    pub read: Vec<PathBuf>,
    #[serde(default)]
    pub write: Vec<PathBuf>,
    pub reason: Option<String>,
}

impl RequestedFiles {
    pub fn is_empty(&self) -> bool {
        self.read.is_empty() && self.write.is_empty()
    }

    fn resolve(&mut self) -> Result<(), LocalAgentKernelError> {
        if self
            .reason
            .as_ref()
            .is_some_and(|reason| reason.trim().is_empty() || reason.len() > 4096)
        {
            return Err(LocalAgentKernelError::input(
                "$.requestFileAccess.reason",
                "length",
                "Use a short, nonempty access reason.",
                None,
            ));
        }
        for path in self.read.iter_mut().chain(&mut self.write) {
            *path = resolve_path(path).map_err(file_error)?;
        }
        self.read.sort();
        self.read.dedup();
        self.write.sort();
        self.write.dedup();
        Ok(())
    }

    pub fn display(&self) -> Value {
        json!({"read":self.read,"write":self.write})
    }

    fn apply(&self, scope: &mut FileAccessScope) {
        scope.read.extend(self.read.clone());
        scope.read.extend(self.write.clone());
        scope
            .write
            .extend(self.write.iter().map(|path| WorkspaceWriteTarget {
                path: path.clone(),
                directory: path.is_dir(),
            }));
    }
}

fn file_error(error: deepcode_kernel_abi::KernelError) -> LocalAgentKernelError {
    LocalAgentKernelError::input("$.path", "fileAccess", &error.to_string(), None)
}

fn covers(root: &Path, path: &Path) -> bool {
    root == path || (root.is_dir() && path.starts_with(root))
}

fn overlaps_project(path: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| path.starts_with(root) || root.starts_with(path))
}

impl LocalAgentKernel {
    pub(super) fn prepare_file_permissions(
        &self,
        request: &LocalToolExecutionRequest,
        prepared: &mut PreparedEffect,
    ) -> Result<(), LocalAgentKernelError> {
        let Some(workspace_root) = prepared.workspace_root.as_ref() else {
            return Ok(());
        };
        let root = Path::new(workspace_root);
        let mut files = FileAccessScope::workspace(root).map_err(file_error)?;
        let mut project_roots = Vec::new();
        for id in &request.workspace_bindings {
            let binding = self.resolver.resolve(id)?;
            if binding
                .access
                .owner_session_id()
                .is_some_and(|owner| owner != request.session_id)
            {
                continue;
            }
            let path = resolve_path(Path::new(&binding.root)).map_err(file_error)?;
            if matches!(binding.access, WorkspaceAccess::Project) {
                project_roots.push(path.clone());
            }
            let bound = FileAccessScope::workspace(&path).map_err(file_error)?;
            files.read.extend(bound.read);
            files.read_only.extend(bound.read_only);
            if matches!(binding.access, WorkspaceAccess::SessionWorkdir(_)) {
                files.write.push(WorkspaceWriteTarget {
                    path: path.clone(),
                    directory: true,
                });
                files.home = Some(path.join("home"));
            }
        }
        let archive = self.session_output_directory(&request.session_id);
        std::fs::create_dir_all(&archive).map_err(|error| {
            LocalAgentKernelError::new("tool_output_directory_failed", error.to_string())
        })?;
        files.read.push(archive);
        // These roots only let programs start; a sandbox that cannot grant one
        // skips it rather than refusing every Shell command.
        let config = &prepared.generation.executor_config;
        let mut best_effort = config.file_read_roots.clone();
        if let Some(path) = config.execution_path.as_ref() {
            best_effort.extend(
                std::env::split_paths(path).filter(|path| path.is_absolute() && path.is_dir()),
            );
        }
        if let Some(roots) = prepared
            .permissions
            .settings
            .get("agent.permissions.runtimeReadRoots")
        {
            let roots: Vec<PathBuf> = serde_json::from_value(roots.clone()).map_err(|error| {
                LocalAgentKernelError::new("runtime_read_roots_invalid", error.to_string())
            })?;
            for path in roots {
                best_effort.push(resolve_path(&path).map_err(file_error)?);
            }
        }
        if is_shell_tool(&prepared.operation) {
            // HOME is redirected for workspace Shells: toolchains under the real home
            // (rustup, pyenv, Volta, Scoop) stay readable through their variables.
            best_effort.extend(
                deepcode_kernel_runtime::shell_environment::toolchain_homes()
                    .into_iter()
                    .map(|(_, path)| path),
            );
            // One package cache shared by workspace Shells of every Session.
            if let Some(cache) = config.shell_cache_root.as_ref() {
                std::fs::create_dir_all(cache).map_err(|error| {
                    LocalAgentKernelError::new("shell_cache_unavailable", error.to_string())
                })?;
                let cache = resolve_path(cache).map_err(file_error)?;
                files.write.push(WorkspaceWriteTarget {
                    path: cache.clone(),
                    directory: true,
                });
                files.cache = Some(cache);
            }
        }
        best_effort.sort();
        best_effort.dedup();
        files.read.extend(best_effort.iter().cloned());
        files.best_effort_read = best_effort;
        files.read.sort();
        files.read.dedup();
        files.read_only.sort();
        files.read_only.dedup();
        for grant in self.journal.file_authorizations(
            &request.session_id,
            &request.run_id,
            &prepared.file_environment(),
        )? {
            let mut resources: RequestedFiles = serde_json::from_value(grant).map_err(|error| {
                LocalAgentKernelError::new("file_authority_invalid", error.to_string())
            })?;
            resources.resolve()?;
            // A resource later bound as a project follows that project's write policy.
            resources.read.extend(resources.write.clone());
            resources
                .write
                .retain(|path| !overlaps_project(path, &project_roots));
            resources.apply(&mut files);
        }
        prepared.file_requests.resolve()?;
        if !prepared.is_host_process() {
            for path in &prepared.file_requests.write {
                if overlaps_project(path, &project_roots)
                    && (is_shell_tool(&prepared.operation) || !files.protects(path))
                {
                    return Err(LocalAgentKernelError::input("$.requestFileAccess.write", "workspaceWriteScope",
                        "Project writes follow the current Plan writablePaths or workspace setting. Remove this project path from requestFileAccess; publish or extend the Plan when needed.", None));
                }
            }
        }
        if matches!(
            prepared.scope,
            PreparedEffectScope::WorkspaceRead | PreparedEffectScope::WorkspaceMutation
        ) {
            for target in &prepared.private_resolved_targets {
                let path = PathBuf::from(target);
                if prepared.scope != PreparedEffectScope::WorkspaceRead
                    && !path.starts_with(root)
                    && overlaps_project(&path, &project_roots)
                {
                    return Err(LocalAgentKernelError::input("$.workspaceId", "workspaceWriteScope",
                        "This target belongs to another bound project. Select that project's workspace handle so its write policy applies.", None));
                }
                if prepared.scope == PreparedEffectScope::WorkspaceRead {
                    if !files.read.iter().any(|root| covers(root, &path)) {
                        prepared.file_requests.read.push(path);
                    }
                } else if !path.starts_with(root) || files.protects(&path) {
                    prepared.file_requests.write.push(path);
                } else if prepared.operation == "fs.delete" && path.is_dir() {
                    // Deleting a project tree also deletes its otherwise read-only Git metadata.
                    prepared.file_requests.write.extend(
                        files
                            .read_only
                            .iter()
                            .filter(|metadata| metadata.starts_with(&path))
                            .cloned(),
                    );
                }
            }
        }
        prepared.git_write_requested = prepared
            .file_requests
            .write
            .iter()
            .any(|path| files.protects(path));
        prepared.file_authority_required = prepared.git_write_requested
            || prepared
                .file_requests
                .read
                .iter()
                .any(|path| !files.read.iter().any(|root| covers(root, path)))
            || prepared
                .file_requests
                .write
                .iter()
                .any(|path| !files.write.iter().any(|root| covers(&root.path, path)));
        prepared.file_access = files;
        Ok(())
    }
}

impl PreparedEffect {
    pub(super) fn file_environment(&self) -> Value {
        json!({"workspaceId":self.workspace_id,"workspaceRoot":self.workspace_root,
            "shell":self.generation.executor_config.shell_program,
            "wsl":self.generation.executor_config.wsl,
            "executionPath":self.generation.executor_config.execution_path})
    }

    pub(super) fn authorization_context(&self) -> Option<Value> {
        if let PreparedToolInput::Container { target, .. } = &self.input {
            return Some(json!({"container":target}));
        }

        if self.scope == PreparedEffectScope::Network {
            return Some(json!({"networkEnvironment":{"kind":"networkTools"}}));
        }
        if self.file_requests.is_empty() && self.network_request.is_none() {
            return self.command_authorization_context();
        }
        let mut context = self
            .command_authorization_context()
            .unwrap_or_else(|| json!({"toolName":self.operation}));
        if self.network_request.is_some() {
            context["networkEnvironment"] = self.file_environment();
        }
        context["fileEnvironment"] = self.file_environment();
        context["fileAccess"] = self.file_requests.display();
        Some(context)
    }

    pub(super) fn external_file_target(&self) -> bool {
        self.operation.starts_with("fs.")
            && self.workspace_root.as_ref().is_some_and(|root| {
                self.private_resolved_targets
                    .iter()
                    .any(|path| !Path::new(path).starts_with(root))
            })
    }

    pub(super) fn execution_file_access(&self) -> FileAccessScope {
        let mut files = self.file_access.clone();
        self.file_requests.apply(&mut files);
        if self.git_write_requested {
            files.read_only.retain(|path| {
                !self
                    .file_requests
                    .write
                    .iter()
                    .any(|allowed| covers(allowed, path))
            });
        }
        files
    }
}
