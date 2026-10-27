use serde_json::{json, Value};

pub(crate) fn core_tool_prompt_providers() -> Value {
    let registry = achbit_kernel_tools::KernelToolRegistry::new();
    let contributions = registry
        .prompt_guidance()
        .map(|(descriptor, guidelines)| {
            json!({
                "contributionRef": format!("tool-prompt-contribution:core:{}", descriptor.name),
                "canonicalToolName": descriptor.name,
                "promptSnippet": descriptor.description,
                "usageGuidelines": guidelines,
            })
        })
        .collect::<Vec<_>>();
    json!([{
        "providerRef": "tool-prompt-provider:core-builtin",
        "origin": "coreBuiltin",
        "contributions": contributions,
    }])
}

pub(crate) fn run_tool_prompt_providers(
    selection: &crate::local_agent_plugins::ResolvedPluginSelection,
    tools: &Value,
) -> Value {
    let mut providers = core_tool_prompt_providers()
        .as_array()
        .expect("core tool prompt providers are an array")
        .clone();
    providers.extend(selection.extension_tool_prompt_providers());
    let names: std::collections::BTreeSet<_> = tools
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    for provider in &mut providers {
        if let Some(contributions) = provider["contributions"].as_array_mut() {
            contributions.retain(|item| {
                item["canonicalToolName"]
                    .as_str()
                    .is_some_and(|name| names.contains(name))
            });
        }
    }
    Value::Array(providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_prompt_provider_uses_registered_tool_guidance() {
        let registry = achbit_kernel_tools::KernelToolRegistry::new();
        let providers = core_tool_prompt_providers();
        let contributions = providers[0]["contributions"]
            .as_array()
            .expect("contributions");
        for required in ["fs.read", "bash", "web.fetch", "web.search", "powershell"] {
            assert!(
                contributions
                    .iter()
                    .any(|item| item["canonicalToolName"] == required),
                "missing guidance for {required}"
            );
        }
        for contribution in contributions {
            let name = contribution["canonicalToolName"]
                .as_str()
                .expect("tool name");
            let descriptor = registry.descriptor(name).expect("registered tool");
            assert_eq!(contribution["promptSnippet"], descriptor.description);
            assert!(descriptor.description.chars().count() <= 512);
            let guidelines = contribution["usageGuidelines"]
                .as_array()
                .expect("guidelines");
            assert!(!guidelines.is_empty());
            assert!(guidelines
                .iter()
                .all(|item| item.as_str().is_some_and(|text| !text.trim().is_empty())));
        }
    }
}
