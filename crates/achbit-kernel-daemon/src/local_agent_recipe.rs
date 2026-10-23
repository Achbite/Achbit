//! Creation-time composition selections. Authorization facts remain Kernel-owned.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRecipe {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
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
        Ok(recipe)
    }

    pub fn validate(&self) -> Result<(), String> {
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
                    &["deny", "ask", "allow"]
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
