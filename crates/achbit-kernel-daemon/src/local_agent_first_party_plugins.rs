use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

const PROVIDER_BINARY: &str = "achbit-first-party-provider";
const GITHUB_MANIFEST: &str = include_str!("../../achbit-first-party-tools/manifests/github.json");
const ARXIV_MANIFEST: &str = include_str!("../../achbit-first-party-tools/manifests/arxiv.json");
const PDF_MANIFEST: &str = include_str!("../../achbit-first-party-tools/manifests/pdf.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FirstPartyToolEffect {
    NetworkRead,
    WorkspaceRead,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum FirstPartyToolBinding {
    None,
    WorkspacePath { argument: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FirstPartyPromptContribution {
    pub(crate) contribution_ref: String,
    pub(crate) prompt_snippet: String,
    pub(crate) usage_guidelines: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FirstPartyToolDescriptor {
    pub(crate) remote_name: String,
    pub(crate) canonical_name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
    pub(crate) effect: FirstPartyToolEffect,
    pub(crate) logical_target: Option<String>,
    pub(crate) binding: FirstPartyToolBinding,
    pub(crate) tool_contribution_ref: String,
    pub(crate) prompt_contribution: FirstPartyPromptContribution,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FirstPartyPluginManifest {
    schema_version: String,
    id: String,
    uri: String,
    display_name: String,
    short_description: String,
    activation_media_types: Vec<String>,
    provider_ref: String,
    capability_refs: Vec<String>,
    capability_summary: String,
    tools: Vec<FirstPartyToolDescriptor>,
}

#[derive(Debug, Clone)]
pub(crate) struct FirstPartyPluginDescriptor {
    pub(crate) id: String,
    pub(crate) uri: String,
    pub(crate) display_name: String,
    pub(crate) short_description: String,
    pub(crate) activation_media_types: Vec<String>,
    pub(crate) provider_ref: String,
    pub(crate) implementation: Value,
    pub(crate) capability_refs: Vec<String>,
    pub(crate) capability_summary: String,
    pub(crate) tools: Vec<FirstPartyToolDescriptor>,
}

pub(crate) fn descriptors() -> Result<Vec<FirstPartyPluginDescriptor>, String> {
    [GITHUB_MANIFEST, ARXIV_MANIFEST, PDF_MANIFEST]
        .into_iter()
        .map(decode_manifest)
        .collect()
}

pub(crate) fn provider_binary() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("定位 first-party provider 失败：{error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "定位 first-party provider 目录失败。".to_string())?;
    Ok(directory.join(format!("{PROVIDER_BINARY}{}", std::env::consts::EXE_SUFFIX)))
}

fn decode_manifest(encoded: &str) -> Result<FirstPartyPluginDescriptor, String> {
    let manifest: FirstPartyPluginManifest = serde_json::from_str(encoded)
        .map_err(|error| format!("解析 first-party plugin manifest 失败：{error}"))?;
    if manifest.schema_version != "deepcode.first-party-plugin.v1"
        || manifest.id.is_empty()
        || manifest.uri != format!("plugin://{}@first-party", manifest.id)
        || manifest.display_name.trim().is_empty()
        || manifest.short_description.trim().is_empty()
        || manifest.provider_ref != format!("tool-provider:first-party:{}", manifest.id)
        || manifest.capability_refs.is_empty()
        || manifest.capability_summary.trim().is_empty()
        || manifest.tools.is_empty()
    {
        return Err(format!(
            "first-party plugin manifest identity 无效：{}",
            manifest.id
        ));
    }
    let mut remote_names = BTreeSet::new();
    let mut canonical_names = BTreeSet::new();
    let mut contribution_refs = BTreeSet::new();
    for tool in &manifest.tools {
        if tool.remote_name.is_empty()
            || tool.canonical_name.is_empty()
            || tool.description.trim().is_empty()
            || !tool.input_schema.is_object()
            || !remote_names.insert(tool.remote_name.clone())
            || !canonical_names.insert(tool.canonical_name.clone())
            || !contribution_refs.insert(tool.tool_contribution_ref.clone())
            || !contribution_refs.insert(tool.prompt_contribution.contribution_ref.clone())
            || tool.prompt_contribution.prompt_snippet.trim().is_empty()
        {
            return Err(format!(
                "first-party plugin tool descriptor 无效：{}",
                tool.canonical_name
            ));
        }
        match (&tool.effect, &tool.binding, tool.logical_target.as_deref()) {
            (FirstPartyToolEffect::NetworkRead, FirstPartyToolBinding::None, Some(_)) => {}
            (
                FirstPartyToolEffect::WorkspaceRead,
                FirstPartyToolBinding::WorkspacePath { argument },
                None,
            ) if !argument.is_empty() => {}
            _ => {
                return Err(format!(
                    "first-party plugin effect/binding 不一致：{}",
                    tool.canonical_name
                ))
            }
        }
    }
    Ok(FirstPartyPluginDescriptor {
        id: manifest.id,
        uri: manifest.uri,
        display_name: manifest.display_name,
        short_description: manifest.short_description,
        activation_media_types: manifest.activation_media_types,
        provider_ref: manifest.provider_ref,
        implementation: serde_json::from_str(encoded).map_err(|error| error.to_string())?,
        capability_refs: manifest.capability_refs,
        capability_summary: manifest.capability_summary,
        tools: manifest.tools,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifests_define_three_independent_logical_plugins() {
        let descriptors = descriptors().expect("first-party descriptors");
        assert_eq!(
            descriptors
                .iter()
                .map(|descriptor| descriptor.uri.as_str())
                .collect::<Vec<_>>(),
            vec![
                "plugin://github@first-party",
                "plugin://arxiv@first-party",
                "plugin://pdf@first-party",
            ]
        );
        let pdf = descriptors
            .iter()
            .find(|descriptor| descriptor.id == "pdf")
            .expect("PDF descriptor");
        assert_eq!(pdf.activation_media_types, ["application/pdf"]);
        assert_eq!(pdf.tools[0].effect, FirstPartyToolEffect::WorkspaceRead);
        assert!(matches!(
            pdf.tools[0].binding,
            FirstPartyToolBinding::WorkspacePath { ref argument } if argument == "path"
        ));
    }
}
