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
        if prepared.workspace_root.is_none() {
            return Ok(());
        }
        let working_directories = self
            .journal
            .run_workspace_binding_ids(&request.session_id, &request.run_id)?;
        let mut bindings = Vec::new();
        for id in &request.workspace_bindings {
            let binding = self.resolver.resolve(id)?;
            if binding
                .access
                .owner_session_id()
                .is_some_and(|owner| owner != request.session_id)
                || (!working_directories.contains(id) && !binding.access.read_only())
            {
                continue;
            }
            bindings.push(binding);
        }
        prepare_file_access(
            prepared,
            bindings,
            self.session_output_directory(&request.session_id),
            self.journal.file_authorizations(
                &request.session_id,
                &request.run_id,
                &prepared.file_environment(),
            )?,
        )
    }
}

pub(super) fn prepare_file_access(
    prepared: &mut PreparedEffect,
    bindings: Vec<ResolvedWorkspace>,
    output_directory: PathBuf,
    authorizations: Vec<Value>,
) -> Result<(), LocalAgentKernelError> {
    let Some(workspace_root) = prepared.workspace_root.as_ref() else {
        return Ok(());
    };
    let root = Path::new(workspace_root);
    let mut files = FileAccessScope::default();
    let mut project_roots = Vec::new();
    for binding in bindings {
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
    let archive = output_directory;
    std::fs::create_dir_all(&archive).map_err(|error| {
        LocalAgentKernelError::new("tool_output_directory_failed", error.to_string())
    })?;
    files.read.push(archive);
    // These roots only let programs start; a sandbox that cannot grant one
    // skips it rather than refusing every Shell command.
    let config = &prepared.generation.executor_config;
    let mut best_effort = config.file_read_roots.clone();
    if let Some(path) = config.execution_path.as_ref() {
        best_effort
            .extend(std::env::split_paths(path).filter(|path| path.is_absolute() && path.is_dir()));
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
    for grant in authorizations {
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
            let in_project_scope = prepared
                .workspace_policy
                .as_ref()
                .is_some_and(|policy| path.starts_with(&policy.root));
            if prepared.scope != PreparedEffectScope::WorkspaceRead
                && !in_project_scope
                && overlaps_project(&path, &project_roots)
            {
                return Err(LocalAgentKernelError::input("$.workspaceId", "workspaceWriteScope",
                        "This target belongs to another bound project. Select that project's workspace handle so its write policy applies.", None));
            }
            if prepared.scope == PreparedEffectScope::WorkspaceRead {
                if !files.read.iter().any(|root| covers(root, &path)) {
                    prepared.file_requests.read.push(path);
                }
            } else if !in_project_scope || files.protects(&path) {
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
    if is_shell_tool(&prepared.operation) && !files.read.iter().any(|allowed| covers(allowed, root))
    {
        // Selecting a referenced directory as cwd still needs an external read grant.
        prepared.file_requests.read.push(root.to_path_buf());
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
        // Host execution already carries the host user's network access. Keep the
        // original request in the ToolRecord, but do not mint a second sandbox
        // network binding that was never part of the actual execution boundary.
        let sandbox_network = self.network_request.is_some() && !self.is_host_process();
        if self.file_requests.is_empty() && !sandbox_network {
            return self.command_authorization_context();
        }
        let mut context = self
            .command_authorization_context()
            .unwrap_or_else(|| json!({"toolName":self.operation}));
        if sandbox_network {
            context["networkEnvironment"] = self.file_environment();
        }
        context["fileEnvironment"] = self.file_environment();
        context["fileAccess"] = self.file_requests.display();
        Some(context)
    }

    pub(super) fn external_file_target(&self) -> bool {
        self.operation.starts_with("fs.")
            && (self.workspace_policy.is_none()
                || self.workspace_policy.as_ref().is_some_and(|policy| {
                    self.private_resolved_targets
                        .iter()
                        .any(|path| !Path::new(path).starts_with(&policy.root))
                }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_agent_kernel::attempt_control_tests::kernel_with_request;

    struct Resources(PathBuf);
    impl WorkspaceResolverPort for Resources {
        fn resolve(&self, id: &str) -> Result<ResolvedWorkspace, LocalAgentKernelError> {
            let path = match id {
                "workspace:test" => "project",
                "resource:subdir" => "project/src",
                "resource:outside" => "outside",
                _ => return Err(LocalAgentKernelError::new("workspace_not_found", id)),
            };
            Ok(ResolvedWorkspace {
                root: self.0.join(path).to_string_lossy().into(),
                access: WorkspaceAccess::Project,
            })
        }
    }
    impl Drop for Resources {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn resources() -> Arc<Resources> {
        let root =
            std::env::temp_dir().join(random_id("reference-policy").unwrap().replace(':', "-"));
        for path in ["project/src", "outside"] {
            std::fs::create_dir_all(root.join(path)).unwrap();
            std::fs::write(root.join(path).join("target.txt"), "original").unwrap();
        }
        Arc::new(Resources(root))
    }

    #[test]
    fn resource_addresses_do_not_grant_external_reads_or_writes() {
        let resources = resources();
        for tool in ["fs.read", "fs.write", "bash"] {
            let input = match tool {
                "fs.read" => json!({"workspaceId":"resource:outside", "path":"target.txt"}),
                "fs.write" => {
                    json!({"workspaceId":"resource:outside", "path":"target.txt", "content":"changed"})
                }
                _ => json!({"workspaceId":"resource:outside", "command":"pwd"}),
            };
            let (mut kernel, mut request, _) = kernel_with_request(resources.clone(), tool, input);
            kernel.output_root = resources.0.join("outputs");
            request.workspace_bindings.push("resource:outside".into());
            let effect = kernel.prepare_tool(&request).unwrap();
            assert!(effect.workspace_policy.is_none());
            assert!(effect.file_authority_required);
            assert!(matches!(
                kernel.admit(&request, &effect).unwrap(),
                Admission::ApprovalRequired
            ));
            let target = resources.0.join("outside/target.txt");
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
            assert!(!effect
                .file_access
                .read
                .iter()
                .any(|root| covers(root, &target)));
            if tool == "fs.write" {
                assert_eq!(effect.file_requests.write, vec![target]);
            }
        }
    }

    #[test]
    fn referenced_subdirectory_uses_its_project_read_scope_and_plan() {
        let resources = resources();
        let (mut kernel, mut read, _) = kernel_with_request(
            resources.clone(),
            "fs.read",
            json!({"workspaceId":"resource:subdir", "path":"target.txt"}),
        );
        kernel.output_root = resources.0.join("outputs");
        read.workspace_bindings.push("resource:subdir".into());
        let effect = kernel.prepare_tool(&read).unwrap();
        assert!(!effect.file_authority_required);
        assert!(matches!(
            kernel.admit(&read, &effect).unwrap(),
            Admission::Allowed(_)
        ));

        for (plan_workspace, target, directory) in [
            ("workspace:test", "src/target.txt", false),
            ("resource:subdir", "target.txt", false),
            ("resource:subdir", "nested", true),
        ] {
            let path = if directory {
                "nested/target.txt"
            } else {
                "target.txt"
            };
            let (mut kernel, mut request, _) = kernel_with_request(
                resources.clone(),
                "fs.write",
                json!({"workspaceId":"resource:subdir", "path":path, "content":"changed"}),
            );
            kernel.output_root = resources.0.join("outputs");
            request.workspace_bindings.push("resource:subdir".into());
            let effect = kernel.prepare_tool(&request).unwrap();
            assert!(
                matches!(kernel.admit(&request, &effect).unwrap(), Admission::Denied { error, .. } if error["code"] == "plan_scope_required")
            );
            let mut authority = json!({"authorityId":"authority:plan", "planId":"plan:reference", "revision":1,
                "decisionId":"decision:plan", "sessionId":request.session_id, "runId":request.run_id,
                "workspaceId":plan_workspace, "coveredOperations":[{"workspaceId":plan_workspace, "operation":"fs.write", "target":target}]});
            if directory {
                authority["coveredOperations"][0]["targetKind"] = json!("directoryTree");
            }
            kernel.journal.append(&json!({"type":"plan.published", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:plan",
                "payload":{"providerCallId":"provider:plan", "planId":"plan:reference", "revision":1, "title":"Edit supplied target", "summary":"Edit one project file", "steps":[{"stepId":"write", "title":"Write", "details":"Edit target.txt"}], "mutationManifest":authority["coveredOperations"]}})).unwrap();
            kernel.journal.append(&json!({"type":"plan.confirmed", "sessionId":request.session_id,"runId":request.run_id,"callId":"call:plan",
                "payload":{"planId":"plan:reference", "revision":1, "commandId":"command:plan", "decisionId":"decision:plan", "authorities":[authority]}})).unwrap();
            request.plan_authorities = vec![authority];
            assert!(
                matches!(kernel.admit(&request, &effect).unwrap(), Admission::Allowed(authority) if authority["workspaceId"] == "workspace:test")
            );
            request.input = json!({"workspaceId":"workspace:test", "path":format!("src/{path}"), "content":"changed"});
            let primary = kernel.prepare_tool(&request).unwrap();
            assert!(matches!(
                kernel.admit(&request, &primary).unwrap(),
                Admission::Allowed(_)
            ));
            request.input["path"] = json!("src/unplanned.txt");
            let unplanned = kernel.prepare_tool(&request).unwrap();
            assert!(
                matches!(kernel.admit(&request, &unplanned).unwrap(), Admission::Denied { error, .. } if error["code"] == "plan_scope_required")
            );
            assert_eq!(
                std::fs::read_to_string(resources.0.join("project/src/target.txt")).unwrap(),
                "original"
            );
        }
    }
}
