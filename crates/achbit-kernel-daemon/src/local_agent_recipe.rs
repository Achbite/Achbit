//! Creation-time composition selections. Authorization facts remain Kernel-owned.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRecipe {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_scope: Option<AgentFileScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub tools: ToolSelection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_components: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Value>,
    #[serde(default)]
    pub permission_policy: PermissionPolicySelection,
    #[serde(default)]
    pub workspace_sandbox: WorkspaceSandboxSelection,
}

/// A restriction on resolved file effects, not a grant or an extra workspace binding.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentFileScope {
    pub workspace_id: String,
    pub read: Vec<String>,
    pub write: Vec<String>,
}
impl AgentFileScope {
    fn validate(&self) -> Result<(), String> {
        let valid = |path: &String| {
            path == "."
                || !path.is_empty()
                    && path.len() <= 1024
                    && !path
                        .chars()
                        .any(|c| c.is_control() || c == '\\' || c == ':')
                    && path.split('/').all(|p| !matches!(p, "" | "." | ".."))
        };
        if self.workspace_id.trim().is_empty()
            || self.workspace_id.trim() != self.workspace_id
            || [&self.read, &self.write].iter().any(|v| {
                v.len() > 64
                    || !v.iter().all(valid)
                    || v.iter().collect::<std::collections::BTreeSet<_>>().len() != v.len()
            })
        {
            return Err("agent_file_scope_invalid".into());
        }
        Ok(())
    }
    fn covers_child(&self, child: &Self) -> bool {
        let covers =
            |root: &str, path: &str| root == "." || std::path::Path::new(path).starts_with(root);
        self.workspace_id == child.workspace_id
            && child
                .write
                .iter()
                .all(|p| self.write.iter().any(|r| covers(r, p)))
            && child
                .read
                .iter()
                .all(|p| self.read.iter().chain(&self.write).any(|r| covers(r, p)))
    }
    pub fn file_tools(&self) -> Vec<String> {
        let mut names = vec!["fs.read".into()];
        if !self.write.is_empty() {
            names.extend(["fs.write", "fs.edit", "fs.delete"].map(String::from));
        }
        names
    }
}

/// This selection owns both declaration and dispatch membership for a task.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolSelection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<String>>,
    #[serde(default = "permitted")]
    pub plugins: bool,
}

impl Default for ToolSelection {
    fn default() -> Self {
        Self {
            kernel: None,
            controls: None,
            plugins: true,
        }
    }
}

fn valid_selection_ids(names: &[String]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    names.iter().all(|name| {
        name.as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
            && seen.insert(name)
    })
}

impl ToolSelection {
    pub fn inherit_missing(&mut self, parent: &Self, requested: Option<&Value>) {
        if requested.and_then(|value| value.get("kernel")).is_none() {
            self.kernel = parent.kernel.clone();
        }
        if requested.and_then(|value| value.get("controls")).is_none() {
            self.controls = parent.controls.clone();
        }
        if requested.and_then(|value| value.get("plugins")).is_none() {
            self.plugins = parent.plugins;
        }
    }

    pub fn allows_kernel(&self, name: &str) -> bool {
        (self.plugins || name != "plugin.search")
            && self
                .kernel
                .as_ref()
                .is_none_or(|names| names.iter().any(|item| item == name))
    }

    fn validate(&self) -> Result<(), String> {
        if [&self.kernel, &self.controls]
            .into_iter()
            .flatten()
            .any(|names| !valid_selection_ids(names))
        {
            return Err("agent_tools_invalid".into());
        }
        Ok(())
    }

    fn validate_child(&self, child: &Self) -> Result<(), String> {
        for (parent, selected) in [
            (&self.kernel, &child.kernel),
            (&self.controls, &child.controls),
        ] {
            if let Some(parent) = parent {
                if selected
                    .as_ref()
                    .is_none_or(|names| names.iter().any(|name| !parent.contains(name)))
                {
                    return Err("agent_tools_not_grantable".into());
                }
            }
        }
        if !self.plugins && child.plugins {
            return Err("agent_tools_not_grantable".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PermissionPolicySelection {
    pub id: String,
    #[serde(default)]
    pub parameters: PolicyConstraints,
}

impl Default for PermissionPolicySelection {
    fn default() -> Self {
        Self {
            id: "local-standard".into(),
            parameters: PolicyConstraints::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicyConstraints {
    #[serde(default = "permitted")]
    pub allow_host_execution: bool,
    #[serde(default = "permitted")]
    pub allow_external_tools: bool,
}
fn permitted() -> bool {
    true
}
impl Default for PolicyConstraints {
    fn default() -> Self {
        Self {
            allow_host_execution: true,
            allow_external_tools: true,
        }
    }
}

impl PermissionPolicySelection {
    pub fn resolve(&self) -> Result<PolicyConstraints, String> {
        // Trusted built-in policy registry. A policy can only restrict Kernel admission.
        match self.id.as_str() {
            "local-standard" => Ok(self.parameters),
            "workspace-only" => Ok(PolicyConstraints {
                allow_host_execution: false,
                allow_external_tools: false,
            }),
            _ => Err(format!("permission_policy_unavailable:{}", self.id)),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceSandboxSelection {
    pub backend_id: String,
    #[serde(default)]
    pub require_isolated_processes: bool,
}
impl Default for WorkspaceSandboxSelection {
    fn default() -> Self {
        Self {
            backend_id: "platform-default".into(),
            require_isolated_processes: false,
        }
    }
}

impl AgentRecipe {
    /// Narrow the creation recipe for one run. Full removes only this narrowing.
    /// Permission policy, sandbox, model and creation permissions are untouched.
    pub fn with_mode(mut self, mode: &str) -> Self {
        if mode == "minimal" {
            // The Kernel advertises only the Shell selected for the execution environment.
            let coding = ["fs.read", "bash", "powershell", "fs.edit", "fs.write"];
            self.tools.kernel = Some(
                coding
                    .into_iter()
                    .filter(|name| self.tools.allows_kernel(name))
                    .map(String::from)
                    .collect(),
            );
            self.tools.controls = Some(vec![]);
            self.tools.plugins = false;
            self.product_components = Some(vec![]);
            self.configuration = Some(
                json!({"context":{"id":"coding"},"controls":{"id":"none"},"compaction":{"id":"none"}}),
            );
            self.runner = Some(json!({"id":"standard","parameters":{"toolExecution":"parallel"}}));
        }
        self
    }

    /// An opt-in creation preset. Unspecified permission settings (including command rules)
    /// continue to come from the ordinary Kernel permission policy.
    pub fn minimal_coding() -> Self {
        Self {
            permissions: Some(json!({
                "agent.permissions.workspaceMutation": "allow",
                "agent.permissions.engineeringDecisions": "delegate",
                "agent.permissions.shell": "allow",
                "agent.permissions.shellAccess": "full"
            })),
            ..Self::default()
        }
        .with_mode("minimal")
    }

    pub fn decode(value: &Value) -> Result<Self, String> {
        let mut recipe: Self = serde_json::from_value(value.clone())
            .map_err(|error| format!("agent_recipe_invalid:{error}"))?;
        if recipe.permission_policy.id == "workspace-only" {
            if value
                .pointer("/permissionPolicy/parameters")
                .and_then(Value::as_object)
                .is_some_and(|parameters| parameters.values().any(|value| value == true))
            {
                return Err("permission_policy_parameters_invalid".into());
            }
            recipe.permission_policy.parameters = PolicyConstraints {
                allow_host_execution: false,
                allow_external_tools: false,
            };
        }
        recipe.validate()?;
        recipe.restrict_file_tools();
        Ok(recipe)
    }

    /// Host features use the creation recipe and never enter the Agent's tool catalog.
    pub fn product_component_enabled(&self, id: &str, enabled_by_default: bool) -> bool {
        self.product_components
            .as_ref()
            .map_or(enabled_by_default && self.tools.plugins, |selected| {
                selected.iter().any(|component| component == id)
            })
    }

    pub fn restrict_file_tools(&mut self) {
        if let Some(scope) = &self.file_scope {
            let allowed = scope.file_tools();
            let selected = self.tools.kernel.get_or_insert_with(|| allowed.clone());
            selected.retain(|tool| allowed.contains(tool));
            self.tools.plugins = false;
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if let Some(scope) = &self.file_scope {
            scope.validate()?;
        }
        if self
            .profile_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty())
            || self.reasoning_effort.as_deref().is_some_and(|effort| {
                !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max")
            })
        {
            return Err("agent_recipe_model_invalid".into());
        }
        if let Some(configuration) = &self.configuration {
            let object = configuration
                .as_object()
                .ok_or("agent_configuration_invalid")?;
            if object.len() != 3 {
                return Err("agent_configuration_invalid".into());
            }
            for kind in ["context", "compaction", "controls"] {
                validate_contribution(&configuration[kind])?;
            }
        }
        if let Some(runner) = &self.runner {
            validate_contribution(runner)?;
        }
        if let Some(permissions) = &self.permissions {
            crate::local_agent_store::validate_permission_patches(permissions)
                .map_err(|error| error.message)?;
        }
        if self
            .product_components
            .as_ref()
            .is_some_and(|ids| !valid_selection_ids(ids))
        {
            return Err("agent_product_components_invalid".into());
        }
        self.tools.validate()?;
        self.permission_policy.resolve()?;
        achbit_kernel_runtime::workspace_sandbox::validate_backend_id(
            &self.workspace_sandbox.backend_id,
        )?;
        Ok(())
    }

    pub fn constraints(&self) -> Result<PolicyConstraints, String> {
        let mut constraints = self.permission_policy.resolve()?;
        if self.workspace_sandbox.require_isolated_processes {
            constraints.allow_host_execution = false;
            constraints.allow_external_tools = false;
        }
        Ok(constraints)
    }

    pub fn validate_child(&self, child: &Self) -> Result<(), String> {
        self.tools.validate_child(&child.tools)?;
        if self.file_scope.as_ref().is_some_and(|parent| {
            !child
                .file_scope
                .as_ref()
                .is_some_and(|child| parent.covers_child(child))
        }) {
            return Err("agent_file_scope_not_grantable".into());
        }
        let parent = self.constraints()?;
        let requested = child.constraints()?;
        if !parent.allow_host_execution && requested.allow_host_execution
            || !parent.allow_external_tools && requested.allow_external_tools
            || self.workspace_sandbox.require_isolated_processes
                && !child.workspace_sandbox.require_isolated_processes
        {
            return Err("agent_policy_not_grantable".into());
        }
        Ok(())
    }

    pub fn bind_environment(&self, environment: &mut Value) -> Result<(), String> {
        let backend = environment["workspaceSandbox"]["backend"]
            .as_str()
            .ok_or("sandbox_backend_missing")?
            .to_string();
        let selected = &self.workspace_sandbox.backend_id;
        if selected != "platform-default" && selected != &backend {
            return Err(format!(
                "sandbox_backend_unavailable:{selected}:execution environment uses {backend}"
            ));
        }
        // An explicit selection must be usable. Default sessions retain file-only operation
        // when the platform cannot sandbox a Shell; the Shell still fails closed.
        if (selected != "platform-default" || self.workspace_sandbox.require_isolated_processes)
            && environment["workspaceSandbox"]["available"] != true
        {
            return Err(format!(
                "sandbox_backend_unavailable:{backend}:{}",
                environment["workspaceSandbox"]["reason"]
            ));
        }
        environment["agentComposition"] = json!({
            "permissionPolicy": self.permission_policy,
            "policyConstraints": self.constraints()?,
            "workspaceSandbox": {"backendId":backend,"requireIsolatedProcesses":self.workspace_sandbox.require_isolated_processes},
            "sandboxCoverage":"workspaceShell"
        });
        Ok(())
    }
}

fn validate_contribution(value: &Value) -> Result<(), String> {
    let selection = value.as_object().ok_or("agent_contribution_invalid")?;
    if selection
        .keys()
        .any(|key| key != "id" && key != "parameters")
        || !selection
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.trim().is_empty() && id.trim() == id)
        || selection
            .get("parameters")
            .is_some_and(|value| !value.is_object())
    {
        return Err("agent_contribution_invalid".into());
    }
    Ok(())
}

/// Creation settings can restrict an inherited grant, never manufacture one.
/// Actual file/Plan scopes remain journal authorities, checked per Kernel call.
pub(crate) fn inherit_permissions(parent: &Value, patch: Option<&Value>) -> Result<Value, String> {
    let mut inherited = crate::settings_api::permission_settings(parent);
    if let Some(patch) = patch {
        crate::local_agent_store::validate_permission_patches(patch)
            .map_err(|error| error.message)?;
        for (key, value) in patch.as_object().expect("validated permissions") {
            if inherited.get(key) == Some(value) {
                continue;
            }
            let levels: &[&str] = match key.as_str() {
                "agent.permissions.workspaceMutation" => &["plan", "review", "allow"],
                "agent.permissions.engineeringDecisions" => &["ask", "delegate"],
                "agent.permissions.shell" => &["ask", "review", "allow"],
                "agent.permissions.shellAccess" => &["workspace", "full"],
                "agent.permissions.networkRead" | "agent.permissions.external" => {
                    &["deny", "ask", "review", "allow"]
                }
                _ => &[],
            };
            let requested = value
                .as_str()
                .and_then(|value| levels.iter().position(|item| *item == value));
            let granted = inherited[key]
                .as_str()
                .and_then(|value| levels.iter().position(|item| *item == value));
            if !matches!((requested, granted), (Some(requested), Some(granted)) if requested <= granted)
            {
                return Err(format!("agent_permission_not_grantable:{key}"));
            }
            inherited[key] = value.clone();
        }
    }
    Ok(inherited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_scope_keeps_tools_and_descendant_paths_inside_the_same_workspace() {
        let scoped = |id: &str, read: &[&str], write: &[&str]| {
            AgentRecipe::decode(&json!({
                "fileScope":{"workspaceId":id,"read":read,"write":write},
                "tools":{"kernel":["fs.read","fs.write","bash"],"plugins":true}
            }))
        };
        let parent = scoped("workspace:src", &["contract"], &["tests"]).unwrap();
        assert!(!parent.tools.plugins && !parent.tools.allows_kernel("bash"));
        let child = scoped("workspace:src", &["tests/one"], &["tests/two"]).unwrap();
        parent.validate_child(&child).unwrap();
        for invalid in [
            scoped("workspace:other", &[], &["tests"]),
            scoped("workspace:src", &[], &["tests-other"]),
            scoped("workspace:src", &["."], &[]),
        ] {
            assert!(parent.validate_child(&invalid.unwrap()).is_err());
        }
        assert!(scoped("workspace:src", &["../src"], &[]).is_err());
    }

    #[test]
    fn task_tools_can_only_narrow_child_admission() {
        let parent = AgentRecipe::decode(
            &json!({"tools":{"kernel":["fs.read"],"controls":[],"plugins":false}}),
        )
        .unwrap();
        let empty =
            AgentRecipe::decode(&json!({"tools":{"kernel":[],"controls":[],"plugins":false}}))
                .unwrap();
        let mut inherited = AgentRecipe::decode(&json!({"tools":{"kernel":[]}})).unwrap();
        inherited
            .tools
            .inherit_missing(&parent.tools, Some(&json!({"kernel":[]})));
        parent.validate_child(&inherited).unwrap();
        assert_eq!(inherited.tools.controls, Some(vec![]));
        assert!(!inherited.tools.plugins);
        parent.validate_child(&parent).unwrap();
        parent.validate_child(&empty).unwrap();
        assert!(parent.validate_child(&AgentRecipe::default()).is_err());
        for tools in [
            json!({"kernel":["fs.read","bash"],"controls":[],"plugins":false}),
            json!({"kernel":["fs.read"],"controls":["agent"],"plugins":false}),
            json!({"kernel":["fs.read"],"controls":[],"plugins":true}),
        ] {
            let child = AgentRecipe::decode(&json!({"tools":tools})).unwrap();
            assert!(parent.validate_child(&child).is_err());
        }
        for tools in [
            json!({"kernel":["fs.read","fs.read"]}),
            json!({"plugins":"false"}),
            json!({"unknown":[]}),
        ] {
            assert!(AgentRecipe::decode(&json!({"tools":tools})).is_err());
        }
    }

    #[test]
    fn session_mode_narrows_tools_without_replacing_permissions() {
        let base = AgentRecipe::decode(&json!({"tools":{"kernel":["fs.read","web.search"],"plugins":false},
            "permissions":{"agent.permissions.workspaceMutation":"plan","agent.permissions.shell":"review"},
            "permissionPolicy":{"id":"workspace-only"}})).unwrap();
        let expected = serde_json::to_value(&base).unwrap();
        let minimal = base.clone().with_mode("minimal");
        assert_eq!(minimal.tools.kernel, Some(vec!["fs.read".into()]));
        assert_eq!(minimal.tools.controls, Some(vec![]));
        assert!(!minimal.tools.plugins);
        assert_eq!(minimal.permissions, base.permissions);
        assert_eq!(minimal.permission_policy.id, base.permission_policy.id);
        assert_eq!(
            minimal.workspace_sandbox.backend_id,
            base.workspace_sandbox.backend_id
        );
        assert_eq!(
            serde_json::to_value(base.with_mode("full")).unwrap(),
            expected
        );
    }

    #[test]
    fn minimal_preset_selects_bare_parallel_coding_without_product_controls() {
        let recipe = AgentRecipe::minimal_coding();
        assert_eq!(recipe.tools.controls, Some(vec![]));
        assert!(!recipe.tools.plugins);
        assert_eq!(recipe.product_components, Some(vec![]));
        assert_eq!(
            recipe.runner.unwrap(),
            json!({"id":"standard", "parameters":{"toolExecution":"parallel"}})
        );
        assert_eq!(
            recipe.configuration.unwrap()["controls"],
            json!({"id":"none"})
        );
        assert_eq!(
            recipe.permissions.unwrap()["agent.permissions.workspaceMutation"],
            "allow"
        );
    }

    #[test]
    fn minimal_preset_keeps_its_complete_creation_contract() {
        assert_eq!(
            serde_json::to_value(AgentRecipe::minimal_coding()).unwrap(),
            json!({
                "tools": {"kernel":["fs.read","bash","powershell","fs.edit","fs.write"],"controls":[],"plugins":false},
                "productComponents": [],
                "configuration": {"context":{"id":"coding"},"controls":{"id":"none"},"compaction":{"id":"none"}},
                "runner": {"id":"standard","parameters":{"toolExecution":"parallel"}},
                "permissions": {
                    "agent.permissions.workspaceMutation":"allow",
                    "agent.permissions.engineeringDecisions":"delegate",
                    "agent.permissions.shell":"allow",
                    "agent.permissions.shellAccess":"full"
                },
                "permissionPolicy": {"id":"local-standard","parameters":{"allowHostExecution":true,"allowExternalTools":true}},
                "workspaceSandbox": {"backendId":"platform-default","requireIsolatedProcesses":false}
            })
        );
    }

    #[test]
    fn child_recipes_cannot_widen_policy_or_permission_settings() {
        let parent =
            AgentRecipe::decode(&json!({"permissionPolicy":{"id":"workspace-only"}})).unwrap();
        assert!(parent.validate_child(&AgentRecipe::default()).is_err());
        let narrowed = AgentRecipe::decode(&json!({"permissionPolicy":{"id":"local-standard",
            "parameters":{"allowHostExecution":false,"allowExternalTools":false}}}))
        .unwrap();
        parent.validate_child(&narrowed).unwrap();
        let permissions = json!({"agent.permissions.workspaceMutation":"plan", "agent.permissions.shell":"review"});
        assert!(inherit_permissions(
            &permissions,
            Some(&json!({"agent.permissions.workspaceMutation":"allow"}))
        )
        .is_err());
        assert!(inherit_permissions(
            &permissions,
            Some(&json!({"agent.permissions.runtimeReadRoots":["/extra"]}))
        )
        .is_err());
        let result = inherit_permissions(
            &permissions,
            Some(&json!({"agent.permissions.shell":"ask"})),
        )
        .unwrap();
        assert_eq!(result["agent.permissions.workspaceMutation"], "plan");
        assert_eq!(result["agent.permissions.shell"], "ask");
    }

    #[test]
    fn title_component_uses_product_defaults_or_the_explicit_selection() {
        let title = "achbit.conversation-title";
        for (input, active) in [
            (json!({}), true),
            (json!({"tools":{"plugins":false}}), false),
            (json!({"productComponents":[]}), false),
            (json!({"productComponents":["achbit.collaboration"]}), false),
            (
                json!({"tools":{"plugins":false},"productComponents":[title]}),
                true,
            ),
        ] {
            let recipe = AgentRecipe::decode(&input).unwrap();
            assert_eq!(recipe.product_component_enabled(title, true), active);
        }
        assert!(AgentRecipe::decode(&json!({"productComponents":[title,title]})).is_err());
    }

    #[test]
    fn explicit_isolation_cannot_fall_back_to_host_execution() {
        let strict = AgentRecipe::decode(&json!({"workspaceSandbox":{"backendId":"platform-default","requireIsolatedProcesses":true}})).unwrap();
        assert!(!strict.constraints().unwrap().allow_host_execution);
        assert!(!strict.constraints().unwrap().allow_external_tools);
        assert!(strict.validate_child(&AgentRecipe::default()).is_err());
        let mut environment = json!({"workspaceSandbox":{"backend":"bubblewrap","available":false,"reason":"namespace disabled"}});
        assert!(strict.bind_environment(&mut environment).is_err());
        assert!(environment.get("agentComposition").is_none());
        AgentRecipe::default()
            .bind_environment(&mut environment)
            .unwrap();
        assert_eq!(
            environment["agentComposition"]["sandboxCoverage"],
            "workspaceShell"
        );
        let mismatch =
            AgentRecipe::decode(&json!({"workspaceSandbox":{"backendId":"windows-lpac"}})).unwrap();
        assert!(mismatch.bind_environment(&mut environment).is_err());
    }
}
