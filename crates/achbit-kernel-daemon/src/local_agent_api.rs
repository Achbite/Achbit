use crate::local_agent_kernel::{
    LocalAgentKernel, LocalAgentKernelError, LocalAgentPermissionPolicy, LocalToolExecutionRequest,
    PermissionMode, PrepareToolCatalogRequest, ReleaseToolCatalogRequest, WorkspaceResolverPort,
};
use crate::local_agent_provider_runtime::{ProviderRuntimeRegistry, ProviderRuntimeSnapshot};
use crate::local_agent_store::{LocalAgentJournal, LocalAgentStoreError, RunProviderRuntime};
use crate::prelude::*;
use crate::*;
use achbit_kernel_runtime::executors::web_search_availability;
use achbit_kernel_tools::ToolAvailability;
use axum::http::HeaderMap;

const SESSION_SERVICE_TOKEN_HEADER: &str = "x-achbit-session-service-token";

#[derive(Clone)]
pub(crate) struct LocalAgentRuntime {
    token: Arc<str>,
    pub(crate) journal: LocalAgentJournal,
    pub(crate) kernel: LocalAgentKernel,
    provider_runtimes: ProviderRuntimeRegistry,
    pub(crate) provider_transport: crate::provider_transport::ProviderTransport,
    runtime_transition: Arc<Mutex<()>>,
    prepared_runs: Arc<Mutex<HashMap<PreparedRunKey, Vec<PreparedRunRecord>>>>,
    active_runtime_settings: Arc<Mutex<Value>>,
    session_store_path: Arc<std::path::PathBuf>,
    tool_record_store_path: Arc<std::path::PathBuf>,
}

impl std::fmt::Debug for LocalAgentRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("LocalAgentRuntime([REDACTED])")
    }
}

impl LocalAgentRuntime {
    pub(crate) fn open(
        session_store_path: &FsPath,
        tool_record_store_path: &FsPath,
        workspace_resolver: Arc<dyn WorkspaceResolverPort>,
        settings: &Value,
    ) -> Result<Self, String> {
        let journal = LocalAgentJournal::open(session_store_path)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let kernel =
            LocalAgentKernel::open(tool_record_store_path, journal.clone(), workspace_resolver)
                .map_err(|error| format!("{}: {}", error.code, error.message))?;
        Ok(Self {
            token: Arc::from(random_service_token()?),
            journal,
            kernel,
            provider_runtimes: ProviderRuntimeRegistry::default(),
            provider_transport: crate::provider_transport::ProviderTransport::new()
                .map_err(|error| format!("provider_client_init_failed: {error}"))?,
            runtime_transition: Arc::new(Mutex::new(())),
            prepared_runs: Arc::new(Mutex::new(HashMap::new())),
            active_runtime_settings: Arc::new(Mutex::new(settings.clone())),
            session_store_path: Arc::new(session_store_path.to_path_buf()),
            tool_record_store_path: Arc::new(tool_record_store_path.to_path_buf()),
        })
    }

    pub(crate) fn service_token(&self) -> &str {
        &self.token
    }

    pub(crate) fn shutdown_plugins(&self) -> Result<(), String> {
        self.kernel
            .shutdown_plugins()
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        self.provider_runtimes.clear()
    }

    pub(crate) fn runtime_transition(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.runtime_transition
            .lock()
            .map_err(|_| "Agent runtime transition 锁已损坏。".to_string())
    }

    pub(crate) fn active_runtime_settings(&self) -> Result<Value, String> {
        self.active_runtime_settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "Agent active runtime settings 锁已损坏。".to_string())
    }

    /// Acquire all fallible resources before persisting. Once persistence succeeds,
    /// publishing the prepared in-memory value cannot fail.
    pub(crate) fn publish_runtime_settings(
        &self,
        patch: &Value,
        persist: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut settings = self
            .active_runtime_settings
            .lock()
            .map_err(|_| "Agent active runtime settings 锁已损坏。".to_string())?;
        let mut next = settings.clone();
        merge_object(&mut next, patch);
        persist()?;
        *settings = next;
        Ok(())
    }

    fn prepare_run_runtime(
        &self,
        gui: &Arc<Mutex<GuiState>>,
        session_service: SessionServiceProcess,
        mut request: PrepareRunRuntimeRequest,
    ) -> Result<Value, RunPreparationError> {
        for (field, value) in [
            ("sessionId", request.session_id.as_str()),
            ("runId", request.run_id.as_str()),
        ] {
            if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
                return Err(RunPreparationError::new(
                    "run_runtime_identity_invalid",
                    format!("{field} 不是有效标识。"),
                ));
            }
        }
        let agent_context = self
            .journal
            .agent_context(&request.session_id)
            .map_err(|error| RunPreparationError::new(error.code, error.message))?;
        let recipe = self
            .journal
            .agent_recipe(&request.session_id)
            .map_err(|error| RunPreparationError::new(error.code, error.message))?;
        let policy_constraints = recipe
            .constraints()
            .map_err(|error| RunPreparationError::new("permission_policy_invalid", error))?;
        let agent_capabilities = agent_context
            .as_ref()
            .map(|context| context["capabilities"].clone())
            .unwrap_or_else(
                || json!({"messaging": true, "continuation": true, "delegation": true}),
            );
        if agent_context.is_some() {
            if request.host_binding.is_some()
                || request.rebind_host.is_some()
                || request
                    .environment
                    .as_ref()
                    .is_some_and(|environment| environment.get("hostBinding").is_some())
            {
                return Err(RunPreparationError::new(
                    "agent_host_binding_forbidden",
                    "子 Agent 不绑定 GUI Host 或父会话桌面。",
                ));
            }
            if request.plugin_selections.iter().any(|selection| {
                !crate::local_agent_plugins::plugin_allowed_for_session(
                    &selection.uri,
                    agent_context.is_some(),
                )
            }) {
                return Err(RunPreparationError::new(
                    "agent_computer_use_forbidden",
                    "子 Agent 不支持 Computer Use。",
                ));
            }
        }
        let _transition = self.runtime_transition().map_err(|message| {
            RunPreparationError::new("runtime_transition_lock_failed", message)
        })?;
        let key = PreparedRunKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
        };
        let resource_catalog = gui.clone();
        let gui = gui.lock().map_err(|_| {
            RunPreparationError::new("gui_state_lock_failed", "GUI state 锁已损坏。")
        })?;
        let mut prepared_runs = self.prepared_runs.lock().map_err(|_| {
            RunPreparationError::new(
                "prepared_run_registry_lock_failed",
                "Prepared run registry 锁已损坏。",
            )
        })?;
        let previous = prepared_runs
            .get(&key)
            .and_then(|views| views.iter().rev().find(|view| view.mcp.is_some()))
            .cloned();
        let mut settings = previous
            .as_ref()
            .map(|prepared| &prepared.runtime_settings)
            .unwrap_or(&gui.user_settings)
            .clone();
        let permissions = self
            .journal
            .permissions_for_run(&request.session_id, &settings)
            .map_err(|error| RunPreparationError::new(error.code, error.message))?;
        merge_object(&mut settings, &permissions);
        let settings = &settings;
        if request.restore_environment {
            return prepared_runs
                .get(&key)
                .and_then(|views| views.first())
                .map(|prepared| prepared.response.clone())
                .ok_or_else(|| {
                    RunPreparationError::new(
                        "provider_runtime_unavailable",
                        "当前 run 的运行时绑定已丢失；历史记录仍可读取，请开始新的会话。",
                    )
                });
        }
        let mut plugin_selection = crate::local_agent_plugins::resolve_plugin_selection(
            settings,
            &mut request.plugin_selections,
            request.refresh_plugins,
        )
        .map_err(|message| {
            RunPreparationError::new("extension_snapshot_prepare_failed", message)
        })?;
        if (!policy_constraints.allow_external_tools || !policy_constraints.allow_host_execution)
            && (!plugin_selection.mcp_plugin_instances().is_empty()
                || plugin_selection.computer_use_instance().is_some())
        {
            return Err(RunPreparationError::new("agent_plugin_isolation_required",
                "The selected policy prohibits Host CLI/MCP processes. No plugin process was started."));
        }
        if !policy_constraints.allow_host_execution
            && plugin_selection.container_instance().is_some()
        {
            return Err(RunPreparationError::new(
                "permission_policy_denied",
                "Container tools require a Host execution route.",
            ));
        }
        let requested_plugin_identity = json!({
            "pluginCatalogRevision": request.plugin_catalog_revision.clone(),
            "refreshPlugins":request.refresh_plugins,
            "pluginSelections": request.plugin_selections.clone(),
            "rebindHost": request.rebind_host,
        });
        let requested_host = request
            .rebind_host
            .as_ref()
            .map(|change| &change.host_binding)
            .or_else(|| {
                previous
                    .as_ref()
                    .and_then(|view| view.response.pointer("/environment/hostBinding"))
            })
            .or(request.host_binding.as_ref());
        if let Some(prepared) = &previous {
            let effective_profile_id = prepared
                .response
                .pointer("/provider/profileId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RunPreparationError::new(
                        "prepared_run_registry_corrupt",
                        "Prepared run 缺少有效的 Provider Profile identity。",
                    )
                })?;
            if request
                .profile_id
                .as_deref()
                .is_some_and(|requested| requested != effective_profile_id)
            {
                return Err(RunPreparationError::new(
                    "run_runtime_identity_conflict",
                    "当前 run 已使用不同的有效 Profile 完成运行时准备。",
                ));
            }
            if prepared
                .response
                .pointer("/provider/reasoningEffortOverride")
                .and_then(Value::as_str)
                != request.reasoning_effort_override.as_deref()
            {
                return Err(RunPreparationError::new(
                    "run_runtime_identity_conflict",
                    "当前 run 已使用不同推理强度完成运行时准备。",
                ));
            }
            if let Some(existing) = prepared_runs.get(&key).and_then(|views| {
                views.iter().find(|view| {
                    view.mcp.is_some()
                        && view.requested_plugin_identity == requested_plugin_identity
                        && view.plugin_selection.same_inputs(&plugin_selection)
                        && view.response.pointer("/environment/hostBinding") == requested_host
                })
            }) {
                return Ok(existing.response.clone());
            }
        }
        let mut environment_settings = settings.clone();
        if let Some(project_id) = gui
            .conversation_catalog
            .session(&request.session_id)
            .and_then(|session| session.project_id.as_ref())
        {
            let projects =
                crate::session_environment::project_environments(settings).map_err(|message| {
                    RunPreparationError::new("session_environment_invalid", message)
                })?;
            if let Some(target) = projects.get(project_id) {
                crate::session_environment::apply_project_environment(
                    &mut environment_settings,
                    target,
                );
            }
        }
        let mut environment = if let Some(previous) = &previous {
            previous.response["environment"].clone()
        } else {
            crate::session_environment::prepare(
                &environment_settings,
                request.environment.as_ref(),
                request.restore_environment,
            )
            .map_err(|message| RunPreparationError::new("session_environment_invalid", message))?
        };
        recipe
            .bind_environment(&mut environment)
            .map_err(|error| RunPreparationError::new("agent_composition_unavailable", error))?;
        // A new task binds its own originating window; it never inherits the
        // preceding task's GUI capability from the saved execution environment.
        if previous.is_none() {
            environment
                .as_object_mut()
                .expect("prepared environment")
                .remove("hostBinding");
            if let Some(binding) = request.host_binding.as_ref() {
                if binding["hostInstanceId"].as_str().is_none_or(str::is_empty)
                    || binding["windowLabel"].as_str().is_none_or(str::is_empty)
                {
                    return Err(RunPreparationError::new(
                        "session_host_binding_invalid",
                        "Host and window identity are required.",
                    ));
                }
                environment["hostBinding"] = binding.clone();
            }
        }
        if let Some(change) = &request.rebind_host {
            if previous.is_none()
                || environment.get("hostBinding") != Some(&change.expected_binding)
            {
                return Err(RunPreparationError::new(
                    "host_rebind_target_changed",
                    "The prepared run no longer has the expected GUI binding.",
                ));
            }
            if change.command_id.is_empty() || change.host_binding == change.expected_binding {
                return Err(RunPreparationError::new(
                    "host_rebind_invalid",
                    "An explicit command and a different GUI binding are required.",
                ));
            }
            crate::browser_tools::host_status(&change.host_binding)
                .and_then(|status| status.check_tool("browser.open").map_err(str::to_owned))
                .map_err(|error| RunPreparationError::new("host_rebind_unavailable", error))?;
            environment["hostBinding"] = change.host_binding.clone();
        }
        // Validate and freeze the requested Provider before starting any new
        // out-of-process plugin generation. A bad Profile must not replace the
        // currently usable tool generation or leave an unused MCP process set.
        let provider_binding = if let Some(previous) = &previous {
            previous.provider_binding.clone()
        } else {
            ProviderRuntimeRegistry::prepare_agent(
                &gui,
                request.profile_id.as_deref(),
                request.reasoning_effort_override.as_deref(),
                agent_context
                    .as_ref()
                    .and_then(|context| context.get("model")),
            )
            .map_err(|message| {
                RunPreparationError::new("provider_runtime_prepare_failed", message)
            })?
        };
        let provider_runtime = provider_binding.snapshot().clone();
        // Freeze reviewer failures too: ordinary turns remain usable, while a
        // later approval request must report this error rather than switch models.
        let approval_reviewer_binding = if let Some(previous) = &previous {
            previous.approval_reviewer_binding.clone()
        } else {
            let selected = settings["agent.approvalReview.profileId"]
                .as_str()
                .filter(|id| !id.is_empty());
            match selected {
                Some(profile_id) => ProviderRuntimeRegistry::prepare(&gui, Some(profile_id), None),
                None => Ok(provider_binding.clone()),
            }
            .and_then(|binding| {
                binding.approval_reviewer(
                    settings["agent.approvalReview.reasoningEffort"]
                        .as_str()
                        .filter(|effort| !effort.is_empty()),
                )
            })
        };
        if let Some(previous) = &previous {
            plugin_selection.retain_prepared(&previous.plugin_selection);
        }
        let mut plugin_config =
            crate::local_agent_plugins::local_agent_plugin_config(settings, &plugin_selection)
                .map_err(|message| {
                    RunPreparationError::new("extension_snapshot_prepare_failed", message)
                })?;
        let mcp = if let Some(previous) = &previous {
            previous
                .mcp
                .as_ref()
                .expect("live prepared view")
                .extend_selected_sources(
                    &plugin_selection.mcp_sources,
                    plugin_selection.mcp_plugin_instances(),
                )
        } else {
            crate::local_agent_mcp::McpRuntime::from_selected_sources(
                &plugin_selection.mcp_sources,
                plugin_selection.mcp_plugin_instances(),
                crate::local_agent_mcp::session_workdir_for_run(
                    &gui.conversation_catalog,
                    &request.session_id,
                )
                .map_err(|error| RunPreparationError::new(error.code, error.message))?,
            )
        }
        .map_err(|error| RunPreparationError::new(error.code, error.message))?;
        let extension_generation_ref = crate::utils::new_runtime_ref("extension-generation")
            .map_err(|message| {
                RunPreparationError::new("extension_identity_prepare_failed", message)
            })?;
        let (mut executor_config, mut secrets) = if let Some(previous) = &previous {
            (previous.executor_config.clone(), previous.secrets.clone())
        } else {
            crate::runtime_tool_configuration(&gui).map_err(|message| {
                RunPreparationError::new("kernel_runtime_config_prepare_failed", message)
            })?
        };
        executor_config.sandbox_backend =
            if recipe.workspace_sandbox.backend_id == "platform-default" {
                None
            } else {
                environment["workspaceSandbox"]["backend"]
                    .as_str()
                    .map(str::to_owned)
            };
        executor_config.shell_program = serde_json::from_value(environment["shell"].clone())
            .map_err(|error| {
                RunPreparationError::new("session_environment_invalid", error.to_string())
            })?;
        executor_config.execution_path = Some(
            environment["executionPath"]
                .as_str()
                .ok_or_else(|| {
                    RunPreparationError::new(
                        "session_environment_invalid",
                        "Prepared execution PATH is missing.",
                    )
                })?
                .into(),
        );
        if environment["executionTarget"]["kind"] == "wsl" {
            executor_config.wsl = Some(achbit_kernel_runtime::wsl_execution::WslExecution {
                distribution: environment["executionTarget"]["distribution"]
                    .as_str()
                    .ok_or_else(|| {
                        RunPreparationError::new(
                            "session_environment_invalid",
                            "Missing WSL distribution",
                        )
                    })?
                    .into(),
                worker: environment["executionTarget"]["worker"]
                    .as_str()
                    .ok_or_else(|| {
                        RunPreparationError::new(
                            "session_environment_invalid",
                            "Missing WSL worker",
                        )
                    })?
                    .into(),
            });
        }
        crate::local_agent_search::bind_cloud_search(
            &mut executor_config,
            &mut secrets,
            &provider_binding.profile(),
            &provider_runtime.profile_id,
        );
        executor_config.file_read_roots = plugin_selection.file_read_roots();
        if let Some(path) = environment["productDocsPath"].as_str() {
            executor_config.file_read_roots.push(path.into());
        }
        #[cfg(target_os = "macos")]
        if let Some(commands) = environment["commandPaths"].as_object() {
            for (name, path) in commands {
                let target = std::fs::canonicalize(path.as_str().ok_or_else(|| {
                    RunPreparationError::new(
                        "host_command_path_invalid",
                        format!("Invalid path for {name}"),
                    )
                })?)
                .map_err(|error| {
                    RunPreparationError::new(
                        "host_command_path_failed",
                        format!("Resolve {name}: {error}"),
                    )
                })?;
                // PATH can contain executable symlinks into a separate toolchain directory.
                executor_config.file_read_roots.push(target);
            }
        }
        #[cfg(windows)]
        if environment["executionTarget"]["kind"] == "native" {
            let command_paths = environment["commandPaths"]
                .as_object()
                .into_iter()
                .flat_map(|commands| commands.values());
            for path in command_paths.chain(std::iter::once(&environment["shell"]["executable"])) {
                if let Some(path) = path.as_str() {
                    executor_config.file_read_roots.extend(
                        achbit_kernel_runtime::shell_environment::windows_runtime_read_roots(
                            std::path::Path::new(path),
                        ),
                    );
                }
            }
        }
        let mut permissions = LocalAgentPermissionPolicy::from_settings(settings)
            .map_err(RunPreparationError::from)?;
        permissions.constraints = policy_constraints;
        let web_search = prepare_web_search_binding(
            &provider_runtime,
            permissions.clone(),
            web_search_availability(&executor_config) == ToolAvailability::Callable,
        );
        let enable_kernel_web_search =
            web_search.get("owner").and_then(Value::as_str) == Some("kernelAdapter");
        let prepared = LocalAgentKernel::prepare_generation(
            &extension_generation_ref,
            executor_config.clone(),
            Arc::new(secrets.clone()),
            mcp.clone(),
            permissions,
            enable_kernel_web_search,
            Arc::new(
                crate::local_agent_product_tools::ProductTools::new(Arc::new(session_service))
                    .with_resources(crate::local_agent_resources::SessionResources::new(
                        request.session_id.clone(),
                        self.journal.clone(),
                        resource_catalog,
                    ))
                    .with_plugin_settings(settings.clone(), agent_context.is_some())
                    .with_computer_use(plugin_selection.computer_use_instance())
                    .with_desktop(
                        self.kernel
                            .desktop
                            .run(&request.session_id, &request.run_id),
                    )
                    .with_containers(plugin_selection.container_instance())
                    .with_documents(plugin_selection.document_instance())
                    .with_browser_binding(environment.get("hostBinding").cloned().map(
                        |mut binding| {
                            binding["sessionId"] = json!(request.session_id);
                            binding["runId"] = json!(request.run_id);
                            binding
                        },
                    ))
                    .with_document_python(
                        settings
                            .get("agent.documents.pythonPath")
                            .and_then(Value::as_str),
                    ),
            ),
        )
        .map_err(RunPreparationError::from)?;
        if previous.is_none() {
            *self.active_runtime_settings.lock().map_err(|_| {
                RunPreparationError::new(
                    "active_runtime_settings_lock_failed",
                    "Agent active runtime settings 锁已损坏。",
                )
            })? = settings.clone();
        }

        let catalog = self
            .kernel
            .bind_run_catalog(
                PrepareToolCatalogRequest::new(
                    &request.session_id,
                    &request.run_id,
                    &extension_generation_ref,
                ),
                prepared,
            )
            .map_err(RunPreparationError::from)?;
        let kernel_catalog_snapshot_ref = catalog["kernelCatalogSnapshotRef"]
            .as_str()
            .ok_or_else(|| {
                RunPreparationError::new(
                    "tool_catalog_reply_invalid",
                    "Kernel catalog reply 缺少 KernelCatalogSnapshotRef。",
                )
            })?
            .to_string();
        if let Err(message) = self.provider_runtimes.bind(
            &request.session_id,
            &request.run_id,
            provider_binding.clone(),
        ) {
            return Err(self.rollback_run_preparation(
                RunPreparationError::new("provider_runtime_bind_failed", message),
                &request.session_id,
                &request.run_id,
                &kernel_catalog_snapshot_ref,
                false,
            ));
        }
        if let Err(message) = approval_reviewer_binding
            .as_ref()
            .map_or(Ok(()), |binding| {
                self.provider_runtimes
                    .bind(&request.session_id, &request.run_id, binding.clone())
            })
        {
            return Err(self.rollback_run_preparation(
                RunPreparationError::new("approval_reviewer_bind_failed", message),
                &request.session_id,
                &request.run_id,
                &kernel_catalog_snapshot_ref,
                previous.is_none(),
            ));
        }
        plugin_config["extensionGenerationRef"] = json!(extension_generation_ref.clone());
        let selected_plugins = crate::local_agent_plugins::selected_plugin_snapshot(
            &plugin_selection,
            extension_generation_ref.as_str(),
        );
        let mut response = json!({
            "schemaVersion": "deepcode.local-agent",
            "type": "run.runtime.prepared",
            "sessionId": request.session_id,
            "runId": request.run_id,
            "provider": provider_runtime,
            "webSearch": web_search,
            "extensionGenerationRef": plugin_config["extensionGenerationRef"],
            "kernelCatalogSnapshotRef": catalog["kernelCatalogSnapshotRef"],
            "tools": catalog["tools"],
            "toolPromptProviders": crate::local_agent_tool_prompts::run_tool_prompt_providers(
                &plugin_selection,
            ),
            "pluginConfig": plugin_config,
            "selectedPlugins": selected_plugins,
            "environment": environment,
            "agentCapabilities": agent_capabilities,
            "contextManagement": {
                "enabled": settings.get("agent.contextManagement.enabled").and_then(Value::as_bool).unwrap_or(false),
                "thresholdTokens": settings.get("agent.contextManagement.thresholdTokens").and_then(Value::as_u64).unwrap_or(500_000),
            },
        });
        // Handler availability is stable; delegation settings belong to Session.
        response["agentToolsEnabled"] = json!(true);
        match &approval_reviewer_binding {
            Ok(binding) => response["approvalReviewer"] = json!(binding.snapshot()),
            Err(message) => {
                response["approvalReviewerError"] = json!({
                    "code": "approval_reviewer_prepare_failed", "message": message,
                })
            }
        }
        prepared_runs
            .entry(key)
            .or_default()
            .push(PreparedRunRecord {
                runtime_settings: settings.clone(),
                executor_config,
                secrets,
                kernel_catalog_snapshot_ref,
                requested_plugin_identity,
                response: response.clone(),
                provider_binding,
                approval_reviewer_binding,
                plugin_selection,
                mcp: Some(mcp),
            });
        Ok(response)
    }

    fn retire_tool_views(
        &self,
        request: RetireToolViewsRequest,
    ) -> Result<Value, RunPreparationError> {
        let _transition = self.runtime_transition().map_err(|message| {
            RunPreparationError::new("runtime_transition_lock_failed", message)
        })?;
        let key = PreparedRunKey {
            session_id: request.session_id.clone(),
            run_id: request.run_id.clone(),
        };
        let mut prepared_runs = self.prepared_runs.lock().map_err(|_| {
            RunPreparationError::new(
                "prepared_run_registry_lock_failed",
                "Prepared run registry 锁已损坏。",
            )
        })?;
        let views = prepared_runs.get_mut(&key).ok_or_else(|| {
            RunPreparationError::new("prepared_run_missing", "当前 run 没有已准备的工具视图。")
        })?;
        if !views.iter().any(|view| {
            view.mcp.is_some()
                && view.kernel_catalog_snapshot_ref == request.keep_kernel_catalog_snapshot_ref
        }) {
            return Err(RunPreparationError::new(
                "tool_catalog_keep_binding_missing",
                "保留的工具视图不存在或已退役。",
            ));
        }
        let result = self.kernel.retire_tool_views(
            &request.session_id,
            &request.run_id,
            &request.keep_kernel_catalog_snapshot_ref,
        );
        // Kernel has accepted retirement even when a disposer reports failure. Never reuse
        // those physical views; keep their original response identities for final release.
        if result
            .as_ref()
            .err()
            .is_none_or(|error| error.code == "tool_view_retire_failed")
        {
            for view in views.iter_mut().filter(|view| {
                view.kernel_catalog_snapshot_ref != request.keep_kernel_catalog_snapshot_ref
            }) {
                view.mcp = None;
            }
        }
        result.map_err(RunPreparationError::from)?;
        Ok(
            json!({ "sessionId": request.session_id, "runId": request.run_id,
            "keepKernelCatalogSnapshotRef": request.keep_kernel_catalog_snapshot_ref }),
        )
    }

    fn rollback_run_preparation(
        &self,
        mut failure: RunPreparationError,
        session_id: &str,
        run_id: &str,
        catalog_ref: &str,
        release_provider: bool,
    ) -> RunPreparationError {
        if let Err(error) = self.kernel.release_catalog(ReleaseToolCatalogRequest::new(
            session_id,
            run_id,
            catalog_ref,
        )) {
            failure.message.push_str(&format!(
                "；初始化回滚清理失败 {}: {}",
                error.code, error.message
            ));
        }
        if release_provider {
            if let Err(message) = self.provider_runtimes.release(session_id, run_id) {
                failure.message.push_str(&format!(
                    "；初始化回滚清理失败 provider_runtime_release_failed: {message}"
                ));
            }
        }
        failure
    }

    fn release_run_runtime(
        &self,
        request: ReleaseToolCatalogRequest,
    ) -> Result<Value, RunPreparationError> {
        let _transition = self.runtime_transition().map_err(|message| {
            RunPreparationError::new("runtime_transition_lock_failed", message)
        })?;
        let key = PreparedRunKey {
            session_id: request.session_id().to_string(),
            run_id: request.run_id().to_string(),
        };
        let mut prepared_runs = self.prepared_runs.lock().map_err(|_| {
            RunPreparationError::new(
                "prepared_run_registry_lock_failed",
                "Prepared run registry 锁已损坏。",
            )
        })?;
        if let Some(prepared) = prepared_runs.get(&key) {
            if !prepared.iter().any(|view| {
                view.kernel_catalog_snapshot_ref == request.kernel_catalog_snapshot_ref()
            }) {
                return Err(RunPreparationError::new(
                    "tool_catalog_release_identity_conflict",
                    "KernelCatalogSnapshotRef 与当前 prepared run 不一致。",
                ));
            }
        }
        let mut failures = Vec::new();
        if let Some(views) = prepared_runs.get(&key) {
            for view in views.iter().filter(|view| {
                view.kernel_catalog_snapshot_ref != request.kernel_catalog_snapshot_ref()
            }) {
                if let Err(error) = self.kernel.release_catalog(ReleaseToolCatalogRequest::new(
                    &key.session_id,
                    &key.run_id,
                    &view.kernel_catalog_snapshot_ref,
                )) {
                    failures.push(RunPreparationError::from(error));
                }
            }
        }
        let response = self
            .kernel
            .release_catalog(request)
            .map_err(RunPreparationError::from);
        if let Err(message) = self.provider_runtimes.release(&key.session_id, &key.run_id) {
            failures.push(RunPreparationError::new(
                "provider_runtime_release_failed",
                message,
            ));
        }
        if let Err(error) = &response {
            failures.push(RunPreparationError::new(error.code, error.message.clone()));
        }
        if !failures.is_empty() {
            let mut failure = failures.remove(0);
            for error in failures {
                failure
                    .message
                    .push_str(&format!("；{}: {}", error.code, error.message));
            }
            return Err(failure);
        }
        let response = response?;
        prepared_runs.remove(&key);
        Ok(response)
    }

    fn delete_session_archive(&self, session_id: &str) -> Result<usize, LocalAgentStoreError> {
        self.journal.delete_archive(
            self.session_store_path.as_ref(),
            self.tool_record_store_path.as_ref(),
            session_id,
        )
    }

    fn authorize(&self, headers: &HeaderMap) -> bool {
        headers
            .get(SESSION_SERVICE_TOKEN_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == self.token.as_ref())
    }
}

fn prepare_web_search_binding(
    provider: &ProviderRuntimeSnapshot,
    permissions: LocalAgentPermissionPolicy,
    kernel_adapter_callable: bool,
) -> Value {
    if permissions.network_mode() == PermissionMode::Deny {
        return json!({ "owner": "unavailable" });
    }
    if permissions.network_mode() == PermissionMode::Allow
        && provider.api_surface == "responses"
        && provider.hosted_web_search == "web_search"
    {
        return json!({
            "owner": "providerHosted",
            "providerToolType": "web_search",
        });
    }
    if kernel_adapter_callable {
        json!({ "owner": "kernelAdapter", "toolName": "web.search" })
    } else {
        json!({ "owner": "unavailable" })
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PreparedRunKey {
    session_id: String,
    run_id: String,
}

#[derive(Clone)]
struct PreparedRunRecord {
    runtime_settings: Value,
    executor_config: achbit_kernel_runtime::executors::KernelExecutorConfig,
    secrets: crate::DaemonSecretProvider,
    provider_binding: crate::local_agent_provider_runtime::ProviderRuntimeBinding,
    approval_reviewer_binding:
        Result<crate::local_agent_provider_runtime::ProviderRuntimeBinding, String>,
    plugin_selection: crate::local_agent_plugins::ResolvedPluginSelection,
    // None after retirement; immutable response identity remains available for restore/release.
    mcp: Option<crate::local_agent_mcp::McpRuntime>,
    kernel_catalog_snapshot_ref: String,
    requested_plugin_identity: Value,
    response: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetireToolViewsRequest {
    session_id: String,
    run_id: String,
    keep_kernel_catalog_snapshot_ref: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateLocalSessionRequest {
    session_id: String,
    display_title: String,
    workspace_bindings: Value,
    profile_id: Option<String>,
    agent_context: Option<Value>,
    recipe: Option<Value>,
    subagent_settings: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppendLocalEventsRequest {
    events: Vec<Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LocalSessionEventsQuery {
    after: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelLocalToolRequest {
    call_id: String,
    attempt_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareRunRuntimeRequest {
    session_id: String,
    run_id: String,
    profile_id: Option<String>,
    reasoning_effort_override: Option<String>,
    environment: Option<Value>,
    host_binding: Option<Value>,
    rebind_host: Option<RebindHostRequest>,
    #[serde(default)]
    restore_environment: bool,
    plugin_catalog_revision: Option<String>,
    #[serde(default)]
    refresh_plugins: bool,
    #[serde(default)]
    plugin_selections: Vec<crate::local_agent_plugins::PluginSelectionInput>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RebindHostRequest {
    command_id: String,
    expected_binding: Value,
    host_binding: Value,
}

#[derive(Debug)]
struct RunPreparationError {
    code: &'static str,
    message: String,
}

impl RunPreparationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<LocalAgentKernelError> for RunPreparationError {
    fn from(error: LocalAgentKernelError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderRequest {
    provider_attempt_id: Option<String>,
    attempt: Option<u8>,
    protocol_version: String,
    request_id: String,
    session_id: String,
    run_id: String,
    provider_runtime_ref: String,
    profile_id: String,
    purpose: String,
    response_constraint: String,
    response_format: Option<crate::llm_transport::StructuredResponseFormat>,
    max_output_tokens: u32,
    workspace_bindings: Vec<LocalProviderWorkspaceBinding>,
    messages: Vec<LocalProviderMessage>,
    tools: Vec<LlmToolDefinition>,
    hosted_tools: Vec<LocalProviderHostedTool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProviderWorkspaceBinding {
    workspace_id: String,
    display_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalProviderMessage {
    pub(crate) role: String,
    pub(crate) content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) images: Vec<LocalProviderImageReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) tool_images: Vec<LocalProviderToolImageReference>,
    #[serde(skip)]
    pub(crate) image_data: Vec<LocalProviderImage>,
    pub(crate) reasoning_content: Option<String>,
    pub(crate) reasoning_signature: Option<String>,
    pub(crate) tool_call_id: Option<String>,
    pub(crate) provider_call_id: Option<String>,
    pub(crate) tool_calls: Option<Vec<LocalProviderToolCall>>,
    pub(crate) provider_items: Option<Vec<Value>>,
    pub(crate) provider_output_blocks: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalProviderImageReference {
    pub(crate) workspace_id: String,
    pub(crate) logical_path: String,
    pub(crate) media_type: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalProviderToolImageReference {
    pub(crate) call_id: String,
    pub(crate) artifact_id: String,
}

#[derive(Debug)]
pub(crate) struct LocalProviderImage {
    pub(crate) media_type: String,
    pub(crate) base64: String,
}
impl LocalProviderImage {
    pub(crate) fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.media_type, self.base64)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalProviderToolCall {
    pub(crate) call_id: String,
    pub(crate) provider_call_id: String,
    pub(crate) name: String,
    pub(crate) input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) thought_signature: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalProviderHostedTool {
    #[serde(rename = "type")]
    pub(crate) tool_type: String,
    pub(crate) provider_tool_type: String,
}

pub(crate) async fn local_agent_session_create(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<CreateLocalSessionRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.create_session_with_recipe(
        &body.session_id,
        &body.display_title,
        &body.workspace_bindings,
        body.profile_id.as_deref(),
        body.agent_context.as_ref(),
        body.recipe.as_ref(),
        body.subagent_settings.as_ref(),
    ) {
        Ok(event) => ApiResponse::ok(event),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_settings_get(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    // Session reads these defaults only when creating a new conversation.
    let gui = state.gui.lock().expect("gui state lock");
    let mut result = serde_json::Map::new();
    for field in [
        "enabled",
        "profileId",
        "reasoningEffort",
        "maxConcurrent",
        "maxCallsPerRun",
        "maxMembersPerSession",
        "allowMemberAnalysis",
        "allowFullConfiguration",
        "presets",
    ] {
        let key = format!("agent.subagents.{field}");
        let Some(value) = gui.user_settings.get(&key) else {
            return ApiResponse::error(
                "agent_settings_missing",
                format!("缺少子 Agent 设置：{key}"),
            );
        };
        result.insert(field.into(), value.clone());
    }
    ApiResponse::ok(Value::Object(result))
}

pub(crate) async fn local_agent_settings_set(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    if let Err(error) = crate::local_agent_store::validate_subagent_settings(&body) {
        return ApiResponse::error(error.code, error.message);
    }
    let patches = body
        .as_object()
        .expect("validated settings object")
        .iter()
        .map(|(field, value)| (format!("agent.subagents.{field}"), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    // Session owns when defaults are updated; Host uses the existing atomic settings writer.
    crate::settings_api::user_settings_patch(ReadyState(state), Json(json!({"patches": patches})))
        .await
}

pub(crate) async fn local_agent_models_get(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    let gui = state.gui.lock().expect("gui state lock");
    let profiles = match gui.llm_profiles.usable() {
        Ok(config) => config["profiles"]
            .as_array()
            .expect("validated profile list"),
        Err(error) => return ApiResponse::error("agent_models_unavailable", error),
    };
    let mut models = Vec::new();
    for profile in profiles {
        if !crate::llm_profiles::llm_profile_value_is_enabled(profile) {
            continue;
        }
        let profile_id = profile["id"].as_str().expect("validated profile id");
        let Ok(binding) = ProviderRuntimeRegistry::prepare(&gui, Some(profile_id), None) else {
            continue;
        };
        let snapshot = binding.snapshot();
        let resolved = binding.profile();
        let efforts: &[&str] = if snapshot.thinking.as_deref() == Some("disabled") {
            &[]
        } else if profile["providerFlavor"].as_str() == Some("deepseek") {
            &["low", "high", "max"]
        } else {
            &["low", "medium", "high", "xhigh", "max"]
        };
        let mut model = json!({
            "profileId": profile_id,
            "name": profile["name"],
            "model": profile["model"],
            "reasoningEfforts": efforts,
            "parameters": {
                "adapterId":resolved.connection.adapter_id,
                "kind":resolved.kind, "providerFlavor":resolved.provider_flavor,
                "contextWindowTokens":snapshot.context_window_tokens, "maxOutputTokens":snapshot.max_output_tokens,
                "imageInput":resolved.image_input, "temperature":resolved.temperature, "hostedWebSearch":resolved.hosted_web_search
            },
        });
        if let Some(thinking) = &snapshot.thinking {
            model["thinking"] = json!(thinking);
        }
        if !efforts.is_empty() {
            if let Some(effort) = &snapshot.reasoning_effort {
                model["reasoningEffort"] = json!(effort);
            }
        }
        models.push(model);
    }
    ApiResponse::ok(json!(models))
}

pub(crate) async fn local_agent_child_session_create(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<crate::conversation_api::CreateAgentSessionRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    crate::conversation_api::create_agent_session(state, body).await
}

pub(crate) async fn local_agent_session_delete(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .delete_session_archive(&session_id)
        .and_then(|count| {
            state.local_agent.journal.publication(
                json!({"deleted": true, "toolRecordCount": count}),
                &session_id,
                true,
            )
        }) {
        Ok(publication) => ApiResponse::ok(publication),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_event_append(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.append(&body).and_then(|event| {
        state
            .local_agent
            .journal
            .event_publication(event, std::slice::from_ref(&body))
    }) {
        Ok(event) => ApiResponse::ok(event),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_events_append_batch(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<AppendLocalEventsRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .journal
        .append_batch(&body.events)
        .and_then(|events| {
            state
                .local_agent
                .journal
                .event_publication(json!(events), &body.events)
        }) {
        Ok(events) => ApiResponse::ok(events),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_events_read(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<LocalSessionEventsQuery>,
) -> Response {
    if let Err(response) = require_session_service(&state, &headers) {
        return response.into_response();
    }
    match state
        .local_agent
        .journal
        .read_events_publication(&session_id, query.after.unwrap_or(0))
    {
        Ok(events) => Json(ApiResponse {
            ok: true,
            data: Some(events),
            error: None,
            message: None,
        })
        .into_response(),
        Err(error) => store_error(error).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadResourceJournalRequest {
    #[serde(default)]
    record_ids: Vec<String>,
}

pub(crate) async fn local_agent_resources_read(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<ReadResourceJournalRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .journal
        .read_resources(&session_id, &body.record_ids)
    {
        Ok(read) => ApiResponse::ok(read),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_run_lifecycle_read(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<LocalSessionEventsQuery>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .journal
        .read_run_lifecycle(&session_id, query.after.unwrap_or(0))
    {
        Ok(read) => ApiResponse::ok(read),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_agent_lifecycle_read(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.read_agent_lifecycle(&session_id) {
        Ok(read) => ApiResponse::ok(read),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_provider_usage_read(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.journal.read_provider_usage(&session_id) {
        Ok(read) => ApiResponse::ok(read),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_command_read(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path((session_id, command_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .journal
        .read_command(&session_id, &command_id)
    {
        Ok(command) => ApiResponse::ok(command.unwrap_or(Value::Null)),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_command_commit(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .journal
        .commit_command_with_events(&body)
        .and_then(|commit| {
            state
                .local_agent
                .journal
                .event_publication(commit, body["events"].as_array().expect("validated events"))
        }) {
        Ok(reply) => ApiResponse::ok(reply),
        Err(error) => store_error(error),
    }
}

pub(crate) async fn local_agent_run_runtime_prepare(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<PrepareRunRuntimeRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state
        .local_agent
        .prepare_run_runtime(&state.gui, state.session_service.clone(), body)
    {
        Ok(runtime) => ApiResponse::ok(runtime),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn local_agent_tool_views_retire(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<RetireToolViewsRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.retire_tool_views(body) {
        Ok(retired) => ApiResponse::ok(retired),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn local_agent_run_runtime_release(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<ReleaseToolCatalogRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.release_run_runtime(body) {
        Ok(release) => ApiResponse::ok(release),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) async fn local_agent_kernel_prepare(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<crate::local_agent_kernel::LocalToolPreparationRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    let kernel = state.local_agent.kernel.clone();
    match tokio::task::spawn_blocking(move || kernel.prepare_file_calls(body)).await {
        Ok(Ok(reply)) => ApiResponse::ok(reply),
        Ok(Err(error)) => kernel_error(error),
        Err(error) => ApiResponse::error("tool_prepare_failed", error.to_string()),
    }
}

pub(crate) async fn local_agent_tool_execute(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<LocalToolExecutionRequest>,
) -> axum::response::Response {
    use achbit_kernel_runtime::executors::KernelProgressSink;
    use axum::response::IntoResponse;
    if let Err(response) = require_session_service(&state, &headers) {
        return response.into_response();
    }
    let kernel = state.local_agent.kernel.clone();
    // One execution stream, with bounded backpressure. Progress is never stored
    // here; the final record remains the sole execution outcome.
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Value>(64);
    let progress_sender = sender.clone();
    let call_id = body.call_id.clone();
    let attempt_id = body.attempt_id.clone();
    let progress = KernelProgressSink::new(move |progress| {
        let _ = progress_sender.blocking_send(json!({
            "type": "progress", "callId": call_id, "attemptId": attempt_id, "progress": progress,
        }));
    });
    tokio::spawn(async move {
        let frame = match tokio::task::spawn_blocking(move || {
            kernel.execute_with_progress(body, progress)
        })
        .await
        {
            Ok(Ok(reply)) => json!({ "type": "reply", "reply": reply }),
            Ok(Err(error)) => {
                json!({ "type": "error", "code": error.code, "message": error.message })
            }
            Err(error) => {
                json!({ "type": "error", "code": "tool_runtime_join_failed", "message": error.to_string() })
            }
        };
        let _ = sender.send(frame).await;
    });
    let stream = async_stream::stream! {
        while let Some(frame) = receiver.recv().await {
            // Value serialization cannot fail; each frame is a single NDJSON line.
            yield Ok::<_, std::convert::Infallible>(bytes::Bytes::from(format!("{frame}\n")));
        }
    };
    (
        [(axum::http::header::CONTENT_TYPE, "application/x-ndjson")],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

pub(crate) async fn local_agent_plan_admission(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<crate::local_agent_kernel::PlanAdmissionRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.kernel.plan_admission(body) {
        Ok(scope) => ApiResponse::ok(scope),
        Err(error) => kernel_error(error),
    }
}

pub(crate) async fn local_agent_tool_cancel(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<CancelLocalToolRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    let kernel = state.local_agent.kernel.clone();
    match tokio::task::spawn_blocking(move || kernel.cancel(&body.call_id, &body.attempt_id)).await
    {
        Ok(Ok(reply)) => ApiResponse::ok(reply),
        Ok(Err(error)) => kernel_error(error),
        Err(error) => ApiResponse::error("tool_cancel_failed", error.to_string()),
    }
}

pub(crate) async fn local_agent_processes(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<crate::managed_processes::ReadRequest>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    let jobs = state.local_agent.kernel.jobs.clone();
    match tokio::task::spawn_blocking(move || {
        if let Some(id) = &body.cancel_job_id {
            jobs.control(
                &body.session_id,
                &body.run_id,
                id,
                "cancel",
                None,
                &achbit_kernel_runtime::executors::KernelCancellationToken::default(),
            )?;
        }
        if body.cancel {
            jobs.cancel_run(&body.session_id, &body.run_id)?;
        }
        jobs.snapshots(
            &body.session_id,
            &body.run_id,
            &body.revisions,
            body.wait_ms,
        )
    })
    .await
    {
        Ok(Ok(jobs)) => ApiResponse::ok(json!({"jobs":jobs})),
        Ok(Err(error)) => ApiResponse::error("managed_process_failed", error),
        Err(error) => ApiResponse::error("managed_process_join_failed", error.to_string()),
    }
}

pub(crate) async fn local_agent_tool_record(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Path(call_id): Path<String>,
) -> Json<ApiResponse> {
    if let Err(response) = require_session_service(&state, &headers) {
        return response;
    }
    match state.local_agent.kernel.read_record(&call_id) {
        Ok(record) => ApiResponse::ok(record.unwrap_or(Value::Null)),
        Err(error) => kernel_error(error),
    }
}

pub(crate) async fn local_agent_provider_stream(
    ReadyState(state): ReadyState,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !state.local_agent.authorize(&headers) {
        return local_provider_error(
            body.get("requestId")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            "session_service_unauthorized",
            "Session Service transport token 无效。",
        );
    }
    let rejected_request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let body: LocalProviderRequest = match serde_json::from_value(body) {
        Ok(body) => body,
        Err(_) => {
            return local_provider_error(
                &rejected_request_id,
                "provider_request_shape_invalid",
                "Provider 请求字段与当前闭合协议不一致。",
            )
        }
    };
    if body.protocol_version != "deepcode.local-agent" {
        return local_provider_error(
            &body.request_id,
            "provider_request_version_invalid",
            "Provider 请求版本无效。",
        );
    }
    if let Err(message) = validate_local_provider_request(&body) {
        return local_provider_error(&body.request_id, "provider_request_shape_invalid", &message);
    }
    let request_id = body.request_id.clone();
    match state
        .local_agent
        .journal
        .run_is_settled(&body.session_id, &body.run_id)
    {
        Ok(true) => {
            return local_provider_error(
                &request_id,
                "provider_run_settled",
                "Provider 请求引用的运行已经结束。",
            );
        }
        Ok(false) => {}
        Err(error) => {
            return local_provider_error(&request_id, error.code, &error.message);
        }
    }
    let frozen_provider_runtime = match state.local_agent.journal.run_provider_runtime(
        &body.session_id,
        &body.run_id,
        &body.purpose,
    ) {
        Ok(runtime) => runtime,
        Err(error) => {
            return local_provider_error(&request_id, error.code, &error.message);
        }
    };
    if body.provider_runtime_ref != frozen_provider_runtime.provider_runtime_ref
        || body.profile_id != frozen_provider_runtime.profile_id
        || body.max_output_tokens != frozen_provider_runtime.max_output_tokens
    {
        return local_provider_error(
            &request_id,
            "provider_runtime_snapshot_mismatch",
            "Provider 请求与 run.started 固定的 runtime snapshot 不一致。",
        );
    }
    if frozen_provider_runtime.api_surface != "responses"
        && body.messages.iter().any(|message| {
            message
                .provider_items
                .as_ref()
                .is_some_and(|items| !items.is_empty())
                || message
                    .provider_output_blocks
                    .as_ref()
                    .is_some_and(|blocks| !blocks.is_empty())
        })
    {
        return local_provider_error(
            &request_id,
            "provider_item_api_surface_mismatch",
            "Provider 原生响应项只能回放到 Responses API surface。",
        );
    }
    if let Err((code, message)) = validate_provider_search_binding(
        &frozen_provider_runtime,
        &body.purpose,
        &body.hosted_tools,
    ) {
        return local_provider_error(&request_id, code, message);
    }
    let frozen_workspace_ids = match state.local_agent.journal.provider_workspace_binding_ids(
        &body.session_id,
        &body.run_id,
        &body.request_id,
    ) {
        Ok(bindings) => bindings,
        Err(error) => {
            return local_provider_error(&request_id, error.code, &error.message);
        }
    };
    let request_workspace_ids = body
        .workspace_bindings
        .iter()
        .map(|binding| binding.workspace_id.clone())
        .collect::<Vec<_>>();
    if request_workspace_ids != frozen_workspace_ids {
        return local_provider_error(
            &request_id,
            "provider_workspace_snapshot_mismatch",
            "Provider 请求的资源集合与该请求已提交的资源视图不一致。",
        );
    }
    let runtime = state.local_agent.provider_runtimes.resolve(
        &body.session_id,
        &body.run_id,
        &body.provider_runtime_ref,
        &body.profile_id,
        frozen_provider_runtime.reasoning_effort_override.as_deref(),
    );
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => {
            return local_provider_error(&request_id, "provider_runtime_unavailable", &error);
        }
    };
    if runtime.snapshot().max_output_tokens != body.max_output_tokens {
        return local_provider_error(
            &request_id,
            "provider_output_budget_mismatch",
            "Provider 请求的输出预算与 run.started 固定的 runtime 不一致。",
        );
    }
    let mut request_envelope = ProviderRequestInput {
        answer_only: body.response_constraint == "answerOnly",
        response_format: body.response_format,
        messages: body.messages,
        tools: body.tools,
        hosted_tools: body.hosted_tools,
    };
    if let Err(error) = crate::conversation_api::resolve_provider_images(
        &state,
        &body.session_id,
        &mut request_envelope.messages,
        runtime.profile().image_input,
    ) {
        return local_provider_error(&request_id, "provider_image_input_failed", &error);
    }
    let archive_directory = state
        .local_agent
        .kernel
        .session_output_directory(&body.session_id)
        .join(format!(
            "provider-{}",
            crate::local_agent_kernel::output_directory_key(&request_id)
        ));
    let archive_directory = if let Some(attempt) = &body.provider_attempt_id {
        archive_directory.join(format!(
            "attempt-{}",
            crate::local_agent_kernel::output_directory_key(attempt)
        ))
    } else {
        archive_directory
    };
    let archive_identity = json!({
        "providerAttemptId": body.provider_attempt_id, "attempt": body.attempt,
        "sessionId": body.session_id,
        "runId": body.run_id,
        "requestId": request_id,
        "purpose": body.purpose,
        "profileId": body.profile_id,
    });
    let mut profile = runtime.profile();
    if let Err(error) = crate::model_auth::authorize(&state, &mut profile).await {
        return local_provider_error(&request_id, "provider_authentication_failed", &error);
    }
    local_agent_provider_stream_response(
        state.local_agent.provider_transport.client.clone(),
        body.provider_attempt_id,
        profile,
        if body.purpose == "approvalReview" {
            runtime.review_request_context(&body.session_id, &request_id)
        } else {
            runtime.codex_request_context(&body.session_id)
        },
        request_envelope,
        request_id,
        archive_directory,
        archive_identity,
        state.model_usage.clone(),
    )
}

fn valid_provider_text(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= 512
        && !value.chars().any(char::is_control)
}

fn valid_provider_tool_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_local_provider_request(body: &LocalProviderRequest) -> Result<(), String> {
    if body.provider_attempt_id.is_some() != body.attempt.is_some()
        || body
            .provider_attempt_id
            .as_deref()
            .is_some_and(|id| !valid_provider_text(id))
        || body.attempt.is_some_and(|n| !(1..=5).contains(&n))
    {
        return Err("Provider 尝试身份或序号无效。".into());
    }

    for (name, value) in [
        ("requestId", body.request_id.as_str()),
        ("sessionId", body.session_id.as_str()),
        ("runId", body.run_id.as_str()),
    ] {
        if !valid_provider_text(value) {
            return Err(format!("Provider 请求的 {name} 无效。"));
        }
    }
    if !valid_provider_text(&body.profile_id) || !valid_provider_text(&body.provider_runtime_ref) {
        return Err("Provider 请求的 profileId 无效。".to_string());
    }
    if !matches!(body.response_constraint.as_str(), "normal" | "answerOnly") {
        return Err("Provider 请求的 responseConstraint 无效。".to_string());
    }
    if body.response_format.as_ref().is_some_and(|format| {
        !valid_provider_text(&format.name)
            || !format.schema.is_object()
            || body.response_constraint != "answerOnly"
            || !body.tools.is_empty()
            || !body.hosted_tools.is_empty()
    }) {
        return Err("结构化输出必须指定名称与对象 schema，并使用无工具的 answerOnly 请求。".into());
    }
    match body.purpose.as_str() {
        "agent" => {
            if body.response_constraint != "normal" || body.max_output_tokens == 0 {
                return Err("普通 Agent 请求必须使用固定的完整输出预算。".to_string());
            }
        }
        "contextCompaction" => {
            if body.response_constraint != "answerOnly" || body.max_output_tokens == 0 {
                return Err("上下文压缩必须使用 answerOnly 和固定的完整输出预算。".to_string());
            }
        }
        "approvalReview" => {
            // Wire tool names are aliases; the Session resolves them against the
            // frozen run catalog and admits only fs.read/session.read evidence.
            let reading = body.response_constraint == "normal"
                && !body.tools.is_empty()
                && body.response_format.is_none();
            let deciding = body.response_constraint == "answerOnly"
                && body.tools.is_empty()
                && body.response_format.is_some();
            if (!reading && !deciding)
                || !body.hosted_tools.is_empty()
                || body.max_output_tokens == 0
            {
                return Err("自动审批取证必须使用 normal 和读取工具；最终裁决必须使用无工具的 answerOnly 及结构化决策格式。".into());
            }
        }
        _ => return Err("Provider 请求的 purpose 无效。".to_string()),
    }
    let mut workspace_ids = std::collections::HashSet::new();
    for binding in &body.workspace_bindings {
        if !valid_provider_text(&binding.workspace_id)
            || binding.display_name.trim().is_empty()
            || binding.display_name.chars().count() > 120
            || !workspace_ids.insert(binding.workspace_id.as_str())
        {
            return Err("Provider 请求的 workspaceBindings 无效或重复。".to_string());
        }
    }
    let mut call_ids = std::collections::HashSet::new();
    for message in &body.messages {
        if !message.images.is_empty()
            && (message.role != "user"
                || message.images.len() > 8
                || message.images.iter().any(|image| {
                    !body
                        .workspace_bindings
                        .iter()
                        .any(|binding| binding.workspace_id == image.workspace_id)
                        || image.logical_path.trim().is_empty()
                        || !matches!(
                            image.media_type.as_str(),
                            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                        )
                }))
        {
            return Err("图片必须引用当前目录集合中的用户图片附件。".into());
        }
        if !matches!(
            message.role.as_str(),
            "system" | "user" | "assistant" | "tool"
        ) {
            return Err("Provider 请求包含无效消息角色。".to_string());
        }
        if matches!(message.role.as_str(), "system" | "user")
            && (message.content.trim().is_empty()
                || message.reasoning_content.is_some()
                || message.reasoning_signature.is_some()
                || message.tool_call_id.is_some()
                || message.provider_call_id.is_some()
                || message.tool_calls.is_some()
                || message.provider_items.is_some()
                || message.provider_output_blocks.is_some())
        {
            return Err("Provider 请求的 system/user 消息结构无效。".to_string());
        }
        if message.role == "tool" {
            if message.reasoning_content.is_some()
                || message.reasoning_signature.is_some()
                || message.tool_calls.is_some()
                || message.provider_items.is_some()
                || message.provider_output_blocks.is_some()
                || message
                    .tool_call_id
                    .as_deref()
                    .is_none_or(|call_id| !valid_provider_text(call_id))
                || message
                    .provider_call_id
                    .as_deref()
                    .is_none_or(|call_id| !valid_provider_text(call_id))
            {
                return Err("Provider 请求的 tool 消息结构无效。".to_string());
            }
        } else if message.tool_call_id.is_some() || message.provider_call_id.is_some() {
            return Err("只有 tool 消息可以携带 toolCallId 与 providerCallId。".to_string());
        }
        if message.role != "assistant" && message.reasoning_content.is_some() {
            return Err("只有 assistant 消息可以携带 reasoningContent。".to_string());
        }
        if message.role != "assistant" && message.reasoning_signature.is_some() {
            return Err("只有 assistant 消息可以携带 reasoningSignature。".to_string());
        }
        if message
            .reasoning_content
            .as_deref()
            .is_some_and(|reasoning| reasoning.trim().is_empty())
        {
            return Err("Provider 请求的 reasoningContent 不能为空。".to_string());
        }
        if message
            .reasoning_signature
            .as_deref()
            .is_some_and(|signature| signature.trim().is_empty())
        {
            return Err("Provider 请求的 reasoningSignature 不能为空。".to_string());
        }
        if message.reasoning_signature.is_some() && message.reasoning_content.is_none() {
            return Err("reasoningSignature 必须与 reasoningContent 一起提供。".to_string());
        }
        if message.role != "assistant" && message.tool_calls.is_some() {
            return Err("只有 assistant 消息可以携带 toolCalls。".to_string());
        }
        if message.role != "assistant" && message.provider_items.is_some() {
            return Err("只有 assistant 消息可以携带 providerItems。".to_string());
        }
        if message.role != "assistant" && message.provider_output_blocks.is_some() {
            return Err("只有 assistant 消息可以携带 providerOutputBlocks。".to_string());
        }
        let provider_items = message.provider_items.as_deref().unwrap_or_default();
        if body.purpose == "approvalReview"
            && (!provider_items.is_empty()
                || message
                    .provider_output_blocks
                    .as_ref()
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| block["kind"] == "providerHosted")
                    }))
        {
            return Err("自动审批不能回放 Provider hosted search。".into());
        }
        let mut provider_item_ids = std::collections::HashSet::new();
        for item in provider_items {
            let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            if !crate::llm_transport::valid_responses_hosted_search_item(item)
                || !valid_provider_text(item_id)
                || !provider_item_ids.insert(item_id)
            {
                return Err("Provider 请求的 providerItems 无效或重复。".to_string());
            }
        }
        for call in message.tool_calls.as_deref().unwrap_or_default() {
            if !valid_provider_text(&call.call_id)
                || !valid_provider_text(&call.provider_call_id)
                || !valid_provider_tool_name(&call.name)
                || !(call.input.is_object() || call.input.is_string())
                || call
                    .thought_signature
                    .as_deref()
                    .is_some_and(|value| value.trim().is_empty())
                || !call_ids.insert(call.call_id.as_str())
            {
                return Err("Provider 请求的 toolCalls 无效或重复。".to_string());
            }
        }
        if let Some(blocks) = message.provider_output_blocks.as_deref() {
            validate_provider_output_blocks(blocks)?;
            if !message.content.is_empty()
                || message.reasoning_content.is_some()
                || message.reasoning_signature.is_some()
                || message.tool_calls.is_some()
                || message.provider_items.is_some()
            {
                return Err("providerOutputBlocks 不能与聚合 assistant 字段混用。".to_string());
            }
        }
        if message.role == "assistant"
            && message.content.is_empty()
            && message.reasoning_content.is_none()
            && message.tool_calls.as_ref().is_none_or(Vec::is_empty)
            && provider_items.is_empty()
            && message
                .provider_output_blocks
                .as_ref()
                .is_none_or(Vec::is_empty)
        {
            return Err("Provider 请求的 assistant 消息没有正文或工具调用。".to_string());
        }
    }
    let mut tool_names = std::collections::HashSet::new();
    for tool in &body.tools {
        if !valid_provider_tool_name(&tool.name)
            || tool.description.trim().is_empty()
            || !tool.input_schema.is_object()
            || !tool_names.insert(tool.name.as_str())
        {
            return Err("Provider 请求的工具目录无效或重复。".to_string());
        }
    }
    if body.hosted_tools.len() > 1
        || body
            .hosted_tools
            .iter()
            .any(|tool| tool.tool_type != "webSearch" || tool.provider_tool_type != "web_search")
    {
        return Err("Provider 请求的 hostedTools 无效。".to_string());
    }
    Ok(())
}

fn validate_provider_output_blocks(blocks: &[Value]) -> Result<(), String> {
    if blocks.is_empty() {
        return Err("providerOutputBlocks 不能为空。".to_string());
    }
    let mut previous_output_index = None;
    let mut reference_ids = std::collections::HashSet::new();
    for block in blocks {
        let output_index = block
            .get("outputIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| "providerOutputBlock 缺少 outputIndex。".to_string())?;
        if previous_output_index.is_some_and(|previous| output_index <= previous) {
            return Err("providerOutputBlocks 没有按 outputIndex 递增。".to_string());
        }
        previous_output_index = Some(output_index);
        let kind = block
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "providerOutputBlock 缺少 kind。".to_string())?;
        let item = block
            .get("item")
            .filter(|item| item.is_object())
            .ok_or_else(|| "providerOutputBlock 缺少原生 item。".to_string())?;
        let valid = match kind {
            "reasoning" => item.get("type").and_then(Value::as_str) == Some("reasoning"),
            "narrative" => {
                item.get("type").and_then(Value::as_str) == Some("message")
                    && block
                        .get("narrativeId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| valid_provider_text(id) && reference_ids.insert(id))
            }
            "finalMessage" => {
                item.get("type").and_then(Value::as_str) == Some("message")
                    && block
                        .get("messageId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| valid_provider_text(id) && reference_ids.insert(id))
            }
            "toolCall" | "toolCallRejected" => {
                let provider_call_id = block.get("providerCallId").and_then(Value::as_str);
                item.get("type").and_then(Value::as_str) == Some("function_call")
                    && block
                        .get("callId")
                        .and_then(Value::as_str)
                        .is_some_and(valid_provider_text)
                    && block
                        .get("toolName")
                        .and_then(Value::as_str)
                        .is_some_and(valid_provider_text)
                    && provider_call_id.is_some_and(valid_provider_text)
                    && item.get("call_id").and_then(Value::as_str) == provider_call_id
            }
            "providerHosted" => {
                let provider_call_id = block.get("providerCallId").and_then(Value::as_str);
                block.get("providerToolType").and_then(Value::as_str) == Some("web_search")
                    && provider_call_id.is_some_and(valid_provider_text)
                    && item.get("id").and_then(Value::as_str) == provider_call_id
                    && crate::llm_transport::valid_responses_hosted_search_item(item)
            }
            _ => false,
        };
        if !valid {
            return Err("providerOutputBlock 合同无效。".to_string());
        }
    }
    Ok(())
}

fn validate_provider_search_binding(
    runtime: &RunProviderRuntime,
    purpose: &str,
    hosted_tools: &[LocalProviderHostedTool],
) -> Result<(), (&'static str, &'static str)> {
    let hosted_search_requested = hosted_tools.len() == 1
        && hosted_tools[0].tool_type == "webSearch"
        && hosted_tools[0].provider_tool_type == "web_search";
    match runtime.web_search_owner.as_str() {
        "providerHosted" => {
            let request_matches_purpose = match purpose {
                "agent" | "contextCompaction" => hosted_search_requested,
                "approvalReview" => hosted_tools.is_empty(),
                _ => false,
            };
            if runtime.api_surface != "responses"
                || runtime.hosted_web_search != "web_search"
                || !request_matches_purpose
            {
                return Err((
                    "provider_hosted_search_binding_mismatch",
                    "Provider 请求与 run.started 固定的 hosted search binding 不一致。",
                ));
            }
            Ok(())
        }
        "kernelAdapter" | "unavailable" if hosted_tools.is_empty() => Ok(()),
        "kernelAdapter" | "unavailable" => Err((
            "provider_hosted_search_binding_mismatch",
            "当前 run 的搜索执行 owner 不是 Provider。",
        )),
        _ => Err((
            "provider_hosted_search_binding_invalid",
            "run.started 的搜索执行 owner 无效。",
        )),
    }
}

fn require_session_service(state: &AppState, headers: &HeaderMap) -> Result<(), Json<ApiResponse>> {
    state
        .local_agent
        .authorize(headers)
        .then_some(())
        .ok_or_else(|| {
            ApiResponse::error(
                "session_service_unauthorized",
                "Session Service transport token 无效。",
            )
        })
}

fn store_error(error: LocalAgentStoreError) -> Json<ApiResponse> {
    ApiResponse::error(error.code, error.message)
}

fn kernel_error(error: LocalAgentKernelError) -> Json<ApiResponse> {
    ApiResponse::error(error.code, error.message)
}

fn local_provider_error(request_id: &str, code: &str, message: &str) -> Response {
    let event = json!({
        "schemaVersion": "deepcode.provider-event",
        "requestId": request_id,
        "type": "failed",
        "data": { "code": code, "message": message },
    });
    (
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        format!("event: provider_event\ndata: {event}\n\n"),
    )
        .into_response()
}

fn random_service_token() -> Result<String, String> {
    let mut entropy = [0u8; 32];
    getrandom::fill(&mut entropy).map_err(|error| error.to_string())?;
    let mut token = String::from("session-service-v2:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_workspace_names_follow_catalog_character_limit() {
        let display_name = crate::conversation_catalog::workspace_display_name(&format!(
            "/workspace/{}",
            "文".repeat(54)
        ));
        let mut request: LocalProviderRequest = serde_json::from_value(json!({
            "protocolVersion": "deepcode.local-agent",
            "requestId": "request:test",
            "sessionId": "session:test",
            "runId": "run:test",
            "providerRuntimeRef": "provider-runtime:test",
            "profileId": "profile:test",
            "purpose": "agent",
            "responseConstraint": "normal",
            "maxOutputTokens": 512,
            "workspaceBindings": [{"workspaceId": "workspace:test", "displayName": display_name}],
            "messages": [{"role": "user", "content": "Read the project."}],
            "tools": [],
            "hostedTools": []
        }))
        .unwrap();
        assert!(validate_local_provider_request(&request).is_ok());
        request.workspace_bindings[0].display_name = "文".repeat(120);
        assert!(validate_local_provider_request(&request).is_ok());
        request.workspace_bindings[0].display_name.push('文');
        assert!(validate_local_provider_request(&request).is_err());
    }

    fn permission_policy(network: &str) -> LocalAgentPermissionPolicy {
        LocalAgentPermissionPolicy::from_settings(&json!({
            "agent.permissions.networkRead": network,
        }))
        .expect("valid permission policy")
    }

    fn provider_runtime(
        api_surface: &'static str,
        hosted_web_search: &'static str,
    ) -> ProviderRuntimeSnapshot {
        ProviderRuntimeSnapshot {
            reasoning_effort: None,
            reasoning_effort_override: None,
            thinking: None,
            provider_runtime_ref: "provider-runtime:test".to_string(),
            profile_id: "profile:test".to_string(),
            context_window_tokens: 4_096,
            max_output_tokens: 512,
            api_surface,
            hosted_web_search,
        }
    }

    #[test]
    fn approval_review_requests_separate_evidence_reads_from_structured_decisions() {
        let base = json!({"protocolVersion":"deepcode.local-agent", "requestId":"request:review",
            "sessionId":"session:review", "runId":"run:review", "providerRuntimeRef":"provider-runtime:test",
            "profileId":"profile:test", "purpose":"approvalReview", "responseConstraint":"normal",
            "maxOutputTokens":512, "workspaceBindings":[], "messages":[{"role":"user","content":"Read the evidence."}],
            "tools":[{"name":"frozen_read_alias","description":"Read existing evidence","inputSchema":{"type":"object"}}],
            "hostedTools":[]});
        let validate =
            |value: Value| validate_local_provider_request(&serde_json::from_value(value).unwrap());
        validate(base.clone()).unwrap();
        let mut final_request = base.clone();
        final_request["responseConstraint"] = json!("answerOnly");
        final_request["tools"] = json!([]);
        assert!(
            validate(final_request.clone()).is_err(),
            "a final review needs structured output"
        );
        final_request["responseFormat"] = json!({"name":"execution_permission_decision", "schema":{
            "type":"object", "additionalProperties":false, "required":["decision","reason"],
            "properties":{"decision":{"enum":["allow","deny","needsUser"]},"reason":{"type":"string"}}}});
        validate(final_request.clone()).unwrap();
        final_request["tools"] = base["tools"].clone();
        assert!(validate(final_request).is_err());
        let mut no_tools = base.clone();
        no_tools["tools"] = json!([]);
        assert!(validate(no_tools).is_err());
        let mut hosted = base.clone();
        hosted["hostedTools"] = json!([{"type":"webSearch","providerToolType":"web_search"}]);
        assert!(validate(hosted).is_err());
        for field in ["providerItems", "providerOutputBlocks"] {
            let mut replay = base.clone();
            replay["messages"] = json!([{"role":"assistant","content":"",field: if field == "providerItems" {
                json!([{"type":"web_search_call","id":"search:one","status":"completed"}])
            } else { json!([{"kind":"providerHosted","outputIndex":0,"providerToolType":"web_search",
                "providerCallId":"search:one","activityId":"activity:search", "item":{"type":"web_search_call","id":"search:one","status":"completed"}}]) }}]);
            assert!(
                validate(replay).is_err(),
                "review must not replay hosted search"
            );
        }
    }

    #[test]
    fn search_owner_is_frozen_from_provider_permission_and_kernel_adapter() {
        let responses = provider_runtime("responses", "web_search");
        let chat = provider_runtime("chatCompletions", "none");

        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("allow"), true),
            json!({ "owner": "providerHosted", "providerToolType": "web_search" })
        );
        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("ask"), true),
            json!({ "owner": "kernelAdapter", "toolName": "web.search" })
        );
        assert_eq!(
            prepare_web_search_binding(&chat, permission_policy("allow"), true),
            json!({ "owner": "kernelAdapter", "toolName": "web.search" })
        );
        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("ask"), false),
            json!({ "owner": "unavailable" })
        );
        assert_eq!(
            prepare_web_search_binding(&responses, permission_policy("deny"), true),
            json!({ "owner": "unavailable" })
        );
    }

    #[test]
    fn compaction_retains_hosted_definitions_and_approval_disables_hosted_search() {
        let runtime = RunProviderRuntime {
            reasoning_effort_override: None,
            provider_runtime_ref: "provider-runtime:test".to_string(),
            profile_id: "profile:test".to_string(),
            context_window_tokens: 4_096,
            max_output_tokens: 512,
            api_surface: "responses".to_string(),
            hosted_web_search: "web_search".to_string(),
            web_search_owner: "providerHosted".to_string(),
        };
        let hosted_tool = LocalProviderHostedTool {
            tool_type: "webSearch".to_string(),
            provider_tool_type: "web_search".to_string(),
        };

        assert!(validate_provider_search_binding(
            &runtime,
            "agent",
            std::slice::from_ref(&hosted_tool),
        )
        .is_ok());
        assert!(validate_provider_search_binding(&runtime, "approvalReview", &[]).is_ok());
        assert!(validate_provider_search_binding(&runtime, "agent", &[]).is_err());
        assert!(validate_provider_search_binding(&runtime, "contextCompaction", &[]).is_err());
        assert!(validate_provider_search_binding(
            &runtime,
            "contextCompaction",
            std::slice::from_ref(&hosted_tool)
        )
        .is_ok());
        assert!(
            validate_provider_search_binding(&runtime, "approvalReview", &[hosted_tool]).is_err()
        );
    }
}
