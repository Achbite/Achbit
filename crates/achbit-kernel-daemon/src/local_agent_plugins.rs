use crate::local_agent_mcp::McpServerSource;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_SKILL_BYTES: u64 = 512 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMountSetting {
    id: String,
    path: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    #[serde(default)]
    activation_media_types: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginSelectionInput {
    pub(crate) selection_id: String,
    pub(crate) uri: String,
    pub(crate) label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PublicPluginCatalogItem {
    uri: String,
    display_name: String,
    short_description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    management: Option<Value>,
    activation_media_types: Vec<String>,
    enabled: bool,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<PluginCatalogError>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct PluginCatalogError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone)]
enum PluginCatalogEntry {
    Skill(SkillLocator),
    Loaded(PluginSource),
    Unavailable(PublicPluginCatalogItem),
}

#[derive(Debug, Clone)]
struct SkillLocator {
    public: PublicPluginCatalogItem,
    id: String,
    path: PathBuf,
}

impl PluginCatalogEntry {
    fn public(&self) -> &PublicPluginCatalogItem {
        match self {
            Self::Skill(locator) => &locator.public,
            Self::Loaded(source) => &source.public,
            Self::Unavailable(public) => public,
        }
    }

    fn into_public(self) -> PublicPluginCatalogItem {
        match self {
            Self::Skill(locator) => match skill_plugin(&locator) {
                Ok(source) => source.public,
                Err(message) => PublicPluginCatalogItem {
                    error: Some(PluginCatalogError {
                        code: "skill_load_failed",
                        message,
                    }),
                    ..locator.public
                },
            },
            Self::Loaded(source) => source.public,
            Self::Unavailable(public) => public,
        }
    }
}

#[derive(Debug, Clone)]
enum PluginContribution {
    Skill,
    Host,
    Container,
    Process,
    Mcp { plugin_uri: String },
}

#[derive(Debug, Clone)]
struct PluginSource {
    public: PublicPluginCatalogItem,
    plugin_artifact_ref: String,
    plugin_instance_ref: String,
    capability_refs: Vec<String>,
    capability_summary: String,
    tool_prompt_provider: Option<Value>,
    contribution: PluginContribution,
    implementation: Value,
    content: Arc<[u8]>,
}

impl PluginSource {
    fn same_input(&self, other: &Self) -> bool {
        self.public == other.public
            && self.implementation == other.implementation
            && self.content == other.content
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedPluginSelection {
    catalog_revision: String,
    plugins: Vec<PluginSource>,
    mcp_plugin_instances: BTreeMap<String, String>,
    pub(crate) mcp_sources: Vec<McpServerSource>,
}

impl ResolvedPluginSelection {
    pub(crate) fn file_read_roots(&self) -> Vec<PathBuf> {
        self.plugins
            .iter()
            .filter_map(|plugin| {
                plugin
                    .implementation
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|path| Path::new(path).parent())
                    .map(Path::to_path_buf)
            })
            .collect()
    }
    pub(crate) fn same_inputs(&self, other: &Self) -> bool {
        self.plugins.len() == other.plugins.len()
            && self
                .plugins
                .iter()
                .zip(&other.plugins)
                .all(|(left, right)| left.same_input(right))
    }
    pub(crate) fn retain_prepared(&mut self, previous: &Self) {
        for plugin in &mut self.plugins {
            if let Some(existing) = previous
                .plugins
                .iter()
                .find(|entry| entry.same_input(plugin))
            {
                *plugin = existing.clone();
                if let PluginContribution::Mcp { plugin_uri } = &plugin.contribution {
                    self.mcp_plugin_instances
                        .insert(plugin_uri.clone(), plugin.plugin_instance_ref.clone());
                }
            }
        }
    }

    pub(crate) fn computer_use_instance(&self) -> Option<String> {
        self.plugins
            .iter()
            .find(|plugin| matches!(plugin.contribution, PluginContribution::Host))
            .map(|plugin| plugin.plugin_instance_ref.clone())
    }

    pub(crate) fn process_instance(&self) -> Option<String> {
        self.plugins
            .iter()
            .find(|plugin| matches!(plugin.contribution, PluginContribution::Process))
            .map(|plugin| plugin.plugin_instance_ref.clone())
    }

    pub(crate) fn container_instance(&self) -> Option<String> {
        self.plugins
            .iter()
            .find(|plugin| matches!(plugin.contribution, PluginContribution::Container))
            .map(|plugin| plugin.plugin_instance_ref.clone())
    }

    pub(crate) fn mcp_plugin_instances(&self) -> &BTreeMap<String, String> {
        &self.mcp_plugin_instances
    }

    pub(crate) fn extension_tool_prompt_providers(&self) -> Vec<Value> {
        self.plugins
            .iter()
            .filter_map(|plugin| plugin.tool_prompt_provider.clone())
            .collect()
    }
}

pub(crate) fn plugin_catalog_projection(settings: &Value) -> Result<Value, String> {
    let (revision, sources, _) = plugin_catalog(settings)?;
    let mut plugins: Vec<Value> = sources
        .into_values()
        .map(|source| {
            let kind = match &source {
                PluginCatalogEntry::Skill(_) => "skill",
                PluginCatalogEntry::Loaded(source)
                    if matches!(source.contribution, PluginContribution::Skill) =>
                {
                    "skill"
                }
                PluginCatalogEntry::Loaded(source)
                    if matches!(
                        source.contribution,
                        PluginContribution::Host
                            | PluginContribution::Container
                            | PluginContribution::Process
                    ) =>
                {
                    "host"
                }
                _ if source.public().uri.ends_with("@cli")
                    || source.public().uri.ends_with("@first-party") =>
                {
                    "cli"
                }
                _ => "mcp",
            };
            let mut item =
                serde_json::to_value(source.into_public()).expect("catalog item serializes");
            item["source"] = json!(if kind == "host" { "builtin" } else { "mounted" });
            item["category"] = json!("functional");
            item["discovery"] = json!("default");
            item["contributionKind"] = json!(kind);
            item
        })
        .collect();
    for skill in crate::local_agent_product_tools::bundled_skill_settings() {
        let id = skill["id"].as_str().expect("bundled Skill id");
        let functional = id == "achbit-documents";
        plugins.push(json!({"uri":format!("plugin://{id}@builtin"),"displayName":skill["displayName"],"shortDescription":skill["description"],
            "source":"builtin","category":if functional {"functional"} else {"reference"},"contributionKind":"skill","discovery":if functional {"default"} else {"searchOnly"},
            "activationMediaTypes":[],"enabled":true,"available":true,"reference":{"toolName":"skill.read","name":id}}));
    }
    for name in crate::local_agent_product_tools::bundled_doc_names() {
        plugins.push(json!({"uri":format!("plugin://doc-{name}@builtin"),"displayName":name,"shortDescription":"DeepCode product documentation",
            "source":"builtin","category":"reference","contributionKind":"skill","discovery":"searchOnly","activationMediaTypes":[],"enabled":true,"available":true,"reference":{"toolName":"doc.read","name":name}}));
    }
    Ok(json!({"revision":revision,"plugins":plugins}))
}

pub(crate) fn plugin_allowed_for_session(uri: &str, is_child_agent: bool) -> bool {
    !is_child_agent || uri != "plugin://computer-use@builtin"
}

pub(crate) fn search_plugins(
    settings: &Value,
    query: &str,
    limit: usize,
    offset: usize,
    is_child_agent: bool,
) -> Result<Value, String> {
    let (revision, sources, _) = plugin_catalog(settings)?;
    let words = query.to_lowercase();
    let mut matches = Vec::new();
    for source in sources.into_values() {
        let capabilities = match &source {
            PluginCatalogEntry::Loaded(source) => source.capability_summary.clone(),
            _ => String::new(),
        };
        let item = source.into_public();
        if !item.enabled
            || !item.available
            || !plugin_allowed_for_session(&item.uri, is_child_agent)
        {
            continue;
        }
        let searchable = format!(
            "{} {} {} {capabilities}",
            item.uri, item.display_name, item.short_description
        )
        .to_lowercase();
        if words
            .split_whitespace()
            .all(|word| searchable.contains(word))
        {
            matches.push(json!({"uri":item.uri,"displayName":item.display_name,"shortDescription":item.short_description}));
        }
    }
    let total = matches.len();
    let plugins: Vec<_> = matches.into_iter().skip(offset).take(limit).collect();
    let end = offset.saturating_add(plugins.len());
    let next_offset = (end < total).then_some(end);
    Ok(json!({"revision":revision,"plugins":plugins,"total":total,"nextOffset":next_offset}))
}

/// Settings inspects text Skills through the same loader used for run preparation.
/// It does not activate an MCP server or a binary plugin while opening the page.
pub(crate) fn skill_settings_projection(settings: &Value) -> Result<Value, String> {
    let mut skills = crate::local_agent_product_tools::bundled_skill_settings();
    for entry in skill_catalog_entries(settings)? {
        let source = entry.into_public();
        skills.push(json!({
            "id": source.uri,
            "displayName": source.display_name,
            "description": source.short_description,
            "source": "mounted",
        }));
    }
    Ok(json!({ "skills": skills }))
}

pub(crate) fn plugin_uri_for_activation_media_type(
    settings: &Value,
    media_type: &str,
) -> Result<Option<String>, String> {
    let (_, sources, _) = plugin_catalog(settings)?;
    for entry in sources.into_values() {
        let source = entry.public();
        if source.enabled
            && source
                .activation_media_types
                .iter()
                .any(|candidate| candidate == media_type)
        {
            // Attachment selection depends on the declared activation owner.
            // Readiness is checked by resolve_plugin_selection before preparation;
            // looking up the owner must not launch or require its executable.
            return Ok(Some(source.uri.clone()));
        }
    }
    Ok(None)
}

pub(crate) fn resolve_plugin_selection(
    settings: &Value,
    selections: &mut Vec<PluginSelectionInput>,
    refresh: bool,
) -> Result<ResolvedPluginSelection, String> {
    if selections.is_empty() {
        return Ok(ResolvedPluginSelection {
            catalog_revision: "plugin-catalog:empty".into(),
            plugins: Vec::new(),
            mcp_plugin_instances: BTreeMap::new(),
            mcp_sources: Vec::new(),
        });
    }
    let (revision, sources, mcp_sources) = plugin_catalog(settings)?;
    if refresh {
        selections.retain(|selection| {
            sources
                .get(&selection.uri)
                .is_some_and(|entry| entry.public().enabled)
        });
    }
    let mut selection_ids = BTreeSet::new();
    let mut uris = BTreeSet::new();
    let mut plugins = Vec::new();
    let mut mcp_plugin_instances = BTreeMap::new();
    for selection in selections {
        if !valid_identifier(&selection.selection_id)
            || selection.label.trim().is_empty()
            || selection.label.len() > 160
            || !selection_ids.insert(selection.selection_id.clone())
            || !uris.insert(selection.uri.clone())
        {
            return Err("plugin_selection_invalid: 插件选择字段无效或重复。".to_string());
        }
        let entry = sources.get(&selection.uri).cloned().ok_or_else(|| {
            format!(
                "plugin_selection_unavailable: 显式选择的插件不可用：{}",
                selection.uri
            )
        })?;
        let mut source = match entry {
            PluginCatalogEntry::Skill(locator) => {
                skill_plugin(&locator).map_err(|message| format!("skill_load_failed: {message}"))?
            }
            PluginCatalogEntry::Loaded(source) => source,
            PluginCatalogEntry::Unavailable(public) => {
                return Err(match public.error {
                    Some(error) => format!("{}: {}", error.code, error.message),
                    None => format!("plugin_selection_disabled: 插件未启用：{}", public.uri),
                });
            }
        };
        if !source.public.enabled || !source.public.available {
            return Err(format!(
                "plugin_selection_disabled: 插件未启用：{}",
                source.public.uri
            ));
        }
        source.plugin_instance_ref = crate::utils::new_runtime_ref("plugin-instance")?;
        if let PluginContribution::Mcp { plugin_uri } = &source.contribution {
            mcp_plugin_instances.insert(plugin_uri.clone(), source.plugin_instance_ref.clone());
        }
        plugins.push(source);
    }
    plugins.sort_by(|left, right| left.public.uri.cmp(&right.public.uri));
    Ok(ResolvedPluginSelection {
        catalog_revision: revision,
        plugins,
        mcp_plugin_instances,
        mcp_sources,
    })
}

pub(crate) fn local_agent_plugin_config(
    settings: &Value,
    selection: &ResolvedPluginSelection,
) -> Result<Value, String> {
    Ok(json!({
        "permissions": crate::settings_api::permission_settings(settings),
        "selectedPlugins": selection.plugins.iter().map(|plugin| json!({
            "uri": plugin.public.uri,
            "displayName": plugin.public.display_name,
            "capabilitySummary": plugin.capability_summary,
        })).collect::<Vec<_>>(),
    }))
}

pub(crate) fn selected_plugin_snapshot(
    selection: &ResolvedPluginSelection,
    extension_generation_ref: &str,
) -> Value {
    json!({
        "catalogRevision": selection.catalog_revision,
        "plugins": selection.plugins.iter().map(|plugin| json!({
            "uri": plugin.public.uri,
            "pluginArtifactRef": plugin.plugin_artifact_ref,
            "pluginInstanceRef": plugin.plugin_instance_ref,
            "extensionGenerationRef": extension_generation_ref,
            "capabilityRefs": plugin.capability_refs,
        })).collect::<Vec<_>>(),
    })
}

fn plugin_catalog(
    settings: &Value,
) -> Result<
    (
        String,
        BTreeMap<String, PluginCatalogEntry>,
        Vec<McpServerSource>,
    ),
    String,
> {
    let mut sources = BTreeMap::new();
    let uri = "plugin://computer-use@builtin";
    let disabled_plugins: Vec<String> =
        serde_json::from_str(settings["plugins.disabled"].as_str().unwrap_or("[]"))
            .map_err(|error| format!("plugin_config_invalid: {error}"))?;
    let disabled = disabled_plugins.iter().any(|value| value == uri);
    // Shared guidance plus this Kernel platform's desktop identifiers and actions.
    #[cfg(windows)]
    let desktop = include_str!("../../../plugins/computer-use/AGENT_GUIDE.windows.md");
    #[cfg(not(windows))]
    let desktop = include_str!("../../../plugins/computer-use/AGENT_GUIDE.macos.md");
    let guide = format!(
        "{}\n{desktop}",
        include_str!("../../../plugins/computer-use/AGENT_GUIDE.md")
    );
    insert_plugin_source(
        &mut sources,
        PluginCatalogEntry::Loaded(PluginSource {
            public: PublicPluginCatalogItem {
                uri: uri.into(),
                display_name: "Computer Use".into(),
                short_description: "前端内容优先使用内置浏览器；按需提供经授权的桌面操作和截图。"
                    .into(),
                icon_ref: None,
                management: Some(json!({"key":"plugins.disabled","id":uri})),
                activation_media_types: vec![],
                enabled: !disabled,
                available: !disabled,
                error: None,
            },
            plugin_artifact_ref: crate::utils::new_runtime_ref("plugin-artifact")?,
            plugin_instance_ref: String::new(),
            capability_refs: vec!["host:computer-use".into()],
            capability_summary: guide.clone(),
            tool_prompt_provider: None,
            contribution: PluginContribution::Host,
            implementation: json!({"host":"native","plugin":"computer-use"}),
            content: Arc::from(guide.as_bytes()),
        }),
    )?;
    let uri = "plugin://containers@builtin";
    let guide = include_str!("../../../plugins/containers/README.md");
    insert_plugin_source(
        &mut sources,
        PluginCatalogEntry::Loaded(PluginSource {
            public: PublicPluginCatalogItem {
                uri: uri.into(),
                display_name: "Containers".into(),
                short_description: "在已授权容器中运行命令，创建独立测试容器。".into(),
                icon_ref: None,
                management: Some(json!({"key":"plugins.disabled","id":uri})),
                activation_media_types: vec![],
                enabled: !disabled_plugins.iter().any(|id| id == uri),
                available: !disabled_plugins.iter().any(|id| id == uri),
                error: None,
            },
            plugin_artifact_ref: crate::utils::new_runtime_ref("plugin-artifact")?,
            plugin_instance_ref: String::new(),
            capability_refs: vec!["host:containers".into()],
            capability_summary: "Run commands in an approved Docker container or create an independent temporary test container; Kernel owns approval and cleanup.".into(),
            tool_prompt_provider: None,
            contribution: PluginContribution::Container,
            implementation: json!({"host":"native","plugin":"containers"}),
            content: Arc::from(guide.as_bytes()),
        }),
    )?;
    let uri = "plugin://processes@builtin";
    let guide = include_str!("../../../plugins/processes/README.md");
    insert_plugin_source(
        &mut sources,
        PluginCatalogEntry::Loaded(PluginSource {
            public: PublicPluginCatalogItem {
                uri: uri.into(),
                display_name: "Processes".into(),
                short_description: "托管长时间命令、等待结果或并行处理独立工作。".into(),
                icon_ref: None,
                management: Some(json!({"key":"plugins.disabled","id":uri})),
                activation_media_types: vec![],
                enabled: !disabled_plugins.iter().any(|id| id == uri),
                available: !disabled_plugins.iter().any(|id| id == uri),
                error: None,
            },
            plugin_artifact_ref: crate::utils::new_runtime_ref("plugin-artifact")?,
            plugin_instance_ref: String::new(),
            capability_refs: vec!["host:processes".into()],
            capability_summary: "Start run-owned commands, wait for results, or cancel them. Status is delivered automatically; do independent work or wait before dependent actions.".into(),
            tool_prompt_provider: None,
            contribution: PluginContribution::Process,
            implementation: json!({"host":"native","plugin":"processes"}),
            content: Arc::from(guide.as_bytes()),
        }),
    )?;
    for source in skill_catalog_entries(settings)? {
        insert_plugin_source(&mut sources, source)?;
    }
    let mcp_sources = crate::local_agent_mcp::available_server_sources(settings)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    for descriptor in mcp_sources.iter().map(|source| source.descriptor.clone()) {
        let public = PublicPluginCatalogItem {
            uri: descriptor.uri.clone(),
            display_name: descriptor.name.clone(),
            short_description: descriptor.short_description,
            icon_ref: None,
            management: Some(descriptor.management),
            activation_media_types: descriptor.activation_media_types,
            enabled: descriptor.enabled,
            available: descriptor.enabled && descriptor.error.is_none(),
            error: descriptor.error.map(|error| PluginCatalogError {
                code: error.code,
                message: error.message,
            }),
        };
        let entry = if public.available {
            PluginCatalogEntry::Loaded(PluginSource {
                public,
                plugin_artifact_ref: crate::utils::new_runtime_ref("plugin-artifact")?,
                plugin_instance_ref: String::new(),
                capability_refs: descriptor.capability_refs,
                capability_summary: descriptor.capability_summary,
                tool_prompt_provider: descriptor.tool_prompt_provider,
                contribution: PluginContribution::Mcp {
                    plugin_uri: descriptor.uri,
                },
                implementation: descriptor.implementation,
                content: descriptor.content,
            })
        } else {
            PluginCatalogEntry::Unavailable(public)
        };
        insert_plugin_source(&mut sources, entry)?;
    }
    let mut activation_owners = BTreeMap::new();
    for source in sources
        .values()
        .map(PluginCatalogEntry::public)
        .filter(|source| source.enabled)
    {
        for media_type in &source.activation_media_types {
            if let Some(previous) = activation_owners.insert(media_type, &source.uri) {
                return Err(format!(
                    "Plugin activationMediaTypes 重复：{media_type} 同时属于 {previous} 和 {}",
                    source.uri
                ));
            }
        }
    }
    Ok((
        crate::utils::new_runtime_ref("plugin-catalog")?,
        sources,
        mcp_sources,
    ))
}

fn insert_plugin_source(
    sources: &mut BTreeMap<String, PluginCatalogEntry>,
    source: PluginCatalogEntry,
) -> Result<(), String> {
    let uri = source.public().uri.clone();
    if sources.insert(uri.clone(), source).is_some() {
        return Err(format!("Plugin URI 重复：{uri}"));
    }
    Ok(())
}

fn skill_catalog_entries(settings: &Value) -> Result<Vec<PluginCatalogEntry>, String> {
    let encoded = settings
        .get("skills.mounts")
        .and_then(Value::as_str)
        .unwrap_or("[]");
    let mounts: Vec<SkillMountSetting> = serde_json::from_str(encoded)
        .map_err(|error| format!("解析 skills.mounts 失败：{error}"))?;
    let mut files = BTreeMap::new();
    let mut entries = Vec::new();
    for mount in mounts {
        let mut public = PublicPluginCatalogItem {
            uri: format!("plugin://{}@skill-mount", plugin_slug(&mount.id)),
            display_name: Path::new(&mount.path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| mount.id.clone()),
            short_description: "任务方法与指导资料。".into(),
            icon_ref: None,
            management: Some(json!({"key":"skills.mounts","id":mount.id,"path":mount.path})),
            activation_media_types: Vec::new(),
            enabled: mount.enabled,
            available: false,
            error: None,
        };
        if !mount.enabled {
            entries.push(PluginCatalogEntry::Unavailable(public));
            continue;
        }
        let loaded = (|| {
            public.activation_media_types =
                normalize_activation_media_types(&mount.activation_media_types)?;
            if mount.path.trim().is_empty() {
                return Err(format!("Skill 挂载 {} 的路径不能为空。", mount.id));
            }
            let root = fs::canonicalize(mount.path.trim())
                .map_err(|error| format!("Skill 挂载 {} 不可用：{error}", mount.path))?;
            let mut mounted_files = Vec::new();
            collect_skill_files(&root, &mut mounted_files)?;
            Ok(mounted_files)
        })();
        match loaded {
            Ok(mounted_files) => {
                for path in mounted_files {
                    files.entry(path).or_insert_with(|| {
                        (mount.id.clone(), public.activation_media_types.clone())
                    });
                }
            }
            Err(message) => {
                public.error = Some(PluginCatalogError {
                    code: "skill_mount_unavailable",
                    message,
                });
                entries.push(PluginCatalogEntry::Unavailable(public));
            }
        }
    }
    for (index, (path, (mount_id, activation_media_types))) in files.into_iter().enumerate() {
        let id = skill_id(&mount_id, &path, index);
        entries.push(PluginCatalogEntry::Skill(SkillLocator {
            public: PublicPluginCatalogItem {
                uri: format!("plugin://{}@skill", plugin_slug(&id)),
                display_name: skill_display_name(&path, ""),
                short_description: format!("Skill file {}", path.display()),
                icon_ref: None,
                management: Some(json!({"key":"skills.mounts","id":mount_id,"path":path})),
                activation_media_types,
                enabled: true,
                available: false,
                error: None,
            },
            id,
            path,
        }));
    }
    Ok(entries)
}

fn skill_plugin(locator: &SkillLocator) -> Result<PluginSource, String> {
    let path = &locator.path;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("读取 Skill 元数据 {} 失败：{error}", path.display()))?;
    if metadata.len() > MAX_SKILL_BYTES {
        return Err(format!("Skill 文件 {} 超过大小上限", path.display()));
    }
    let instructions = fs::read_to_string(path)
        .map_err(|error| format!("读取 Skill {} 失败：{error}", path.display()))?;
    if instructions.trim().is_empty() {
        return Err(format!("Skill 文件 {} 不能为空", path.display()));
    }
    let display_name = skill_display_name(path, &instructions);
    let short_description = skill_short_description(&instructions, &display_name);
    path.to_str()
        .ok_or_else(|| format!("Skill 路径不是 UTF-8：{}", path.display()))?;
    let plugin_artifact_ref = crate::utils::new_runtime_ref("plugin-artifact")?;
    Ok(PluginSource {
        public: PublicPluginCatalogItem {
            display_name,
            short_description,
            available: true,
            ..locator.public.clone()
        },
        plugin_artifact_ref,
        plugin_instance_ref: String::new(),
        capability_refs: vec![format!("skill:{}", locator.id)],
        capability_summary: instructions.clone(),
        tool_prompt_provider: None,
        contribution: PluginContribution::Skill,
        implementation: json!({"id": locator.id, "path": path}),
        content: Arc::from(instructions.as_bytes()),
    })
}

fn normalize_activation_media_types(values: &[String]) -> Result<Vec<String>, String> {
    let mut normalized = BTreeSet::new();
    for value in values {
        let candidate = value.trim().to_ascii_lowercase();
        let valid = candidate.len() <= 128
            && candidate.split_once('/').is_some_and(|(kind, subtype)| {
                !kind.is_empty()
                    && !subtype.is_empty()
                    && kind.chars().chain(subtype.chars()).all(|character| {
                        character.is_ascii_alphanumeric()
                            || matches!(
                                character,
                                '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                            )
                    })
            });
        if !valid {
            return Err(format!("Skill activationMediaTypes 无效：{value}"));
        }
        normalized.insert(candidate);
    }
    Ok(normalized.into_iter().collect())
}

fn collect_skill_files(path: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_file() {
        if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            output.push(path.to_path_buf());
        }
        return Ok(());
    }
    let direct = path.join("SKILL.md");
    if direct.is_file() {
        output.push(direct);
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("扫描 Skill 目录 {} 失败：{error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("扫描 Skill 目录 {} 失败：{error}", path.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取 Skill 条目 {} 失败：{error}", entry.path().display()))?;
        if file_type.is_dir()
            && !file_type.is_symlink()
            && !name.starts_with('.')
            && !matches!(name.as_ref(), "node_modules" | "target")
        {
            collect_skill_files(&entry.path(), output)?;
        }
    }
    Ok(())
}

fn skill_id(mount_id: &str, path: &Path, index: usize) -> String {
    let parent = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    format!("{mount_id}-{parent}-{}", index + 1)
}

fn skill_display_name(path: &Path, instructions: &str) -> String {
    instructions
        .lines()
        .find_map(|line| line.trim().strip_prefix("# "))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| truncate_utf8(line, 160))
        .unwrap_or_else(|| {
            path.parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .unwrap_or("Skill")
                .to_string()
        })
}

fn skill_short_description(instructions: &str, fallback: &str) -> String {
    instructions
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && *line != "---"
                && !line.starts_with("name:")
                && !line.starts_with("description:")
        })
        .map(|line| truncate_utf8(line, 240))
        .unwrap_or_else(|| format!("Skill plugin {fallback}"))
}

fn plugin_slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "plugin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

const fn enabled_by_default() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_search_reads_cli_tools_and_mcp_descriptions_without_starting_programs() {
        struct Directory(PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let directory = Directory(std::env::temp_dir().join(format!(
            "deepcode-discovery-{}-{}",
            std::process::id(),
            crate::now_millis()
        )));
        fs::create_dir(&directory.0).unwrap();
        let marker = directory.0.join("started");
        let entry = directory.0.join("main.py");
        fs::write(
            &entry,
            format!("from pathlib import Path\nPath({:?}).touch()\n", marker),
        )
        .unwrap();
        fs::write(
            directory.0.join("achbit-tool.json"),
            serde_json::to_vec(&json!({
                "id":"warehouse", "name":"Warehouse bridge", "description":"Work with stock records.",
                "command":"python3", "entry":"main.py", "tools":[{
                    "name":"list_inventory", "description":"Read warehouse stock counts.",
                    "inputSchema":{"type":"object"}
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let settings = json!({
            "plugins.sources":serde_json::to_string(&json!([{
                "id":"warehouse", "path":directory.0
            }])).unwrap(),
            "mcp.servers":serde_json::to_string(&json!([{
                "id":"lab", "name":"Lab bridge", "description":"Inspect thermometers and read ambient temperature.",
                "command":"python3", "args":entry
            }])).unwrap()
        });
        for (query, uri) in [
            ("LIST_INVENTORY", "plugin://warehouse@cli"),
            ("stock counts", "plugin://warehouse@cli"),
            ("ambient temperature", "plugin://lab@mcp"),
        ] {
            let found = search_plugins(&settings, query, 20, 0, false).unwrap();
            assert_eq!(found["total"], 1, "{query}");
            assert_eq!(found["plugins"][0]["uri"], uri);
            assert_eq!(found["plugins"][0].as_object().unwrap().len(), 3);
            assert!(found["plugins"][0]["displayName"].is_string());
            assert!(found["plugins"][0]["shortDescription"].is_string());
        }
        let missing = search_plugins(&settings, "stock ambient", 20, 0, false).unwrap();
        assert_eq!(
            missing["total"], 0,
            "all keywords must match the same plugin"
        );
        assert_eq!(missing["plugins"], json!([]));
        assert!(missing["nextOffset"].is_null());
        assert!(
            !marker.exists(),
            "discovery must not execute a plugin entrypoint"
        );
    }

    #[test]
    fn catalog_browsing_can_continue_until_all_results_are_read() {
        let settings = json!({});
        let all = search_plugins(&settings, "", usize::MAX, 0, false).unwrap();
        let expected = all["plugins"].as_array().unwrap();
        assert!(expected.len() > 2);
        let mut seen = Vec::new();
        let mut offset = 0;
        loop {
            let page = search_plugins(&settings, "", 2, offset, false).unwrap();
            assert_eq!(page["total"], all["total"]);
            let plugins = page["plugins"].as_array().unwrap();
            assert!(!plugins.is_empty());
            seen.extend(plugins.iter().cloned());
            let Some(next) = page["nextOffset"].as_u64() else {
                break;
            };
            assert_eq!(next as usize, offset + plugins.len());
            offset = next as usize;
        }
        assert_eq!(&seen, expected);
        let exhausted = search_plugins(&settings, "", 2, expected.len(), false).unwrap();
        assert_eq!(exhausted["plugins"], json!([]));
        assert!(exhausted["nextOffset"].is_null());
    }

    #[test]
    fn computer_plugin_has_selected_identity_and_honors_disabled_setting() {
        let catalog = plugin_catalog_projection(&json!({})).unwrap();
        for uri in [
            "plugin://computer-use@builtin",
            "plugin://containers@builtin",
            "plugin://processes@builtin",
        ] {
            let item = catalog["plugins"]
                .as_array()
                .unwrap()
                .iter()
                .find(|plugin| plugin["uri"] == uri)
                .unwrap();
            assert_eq!(item["contributionKind"], "host", "{uri}");
            assert_eq!(item["source"], "builtin", "{uri}");
        }
        let mut selections = vec![PluginSelectionInput {
            selection_id: "selection:computer".into(),
            uri: "plugin://computer-use@builtin".into(),
            label: "Computer Use".into(),
        }];
        let selected = resolve_plugin_selection(&json!({}), &mut selections, false).unwrap();
        assert!(selected.computer_use_instance().is_some());
        assert!(selected
            .mcp_sources
            .iter()
            .all(|source| source.descriptor.uri != "plugin://computer-use@builtin"));
        assert!(resolve_plugin_selection(
            &json!({"plugins.disabled":"[\"plugin://computer-use@builtin\"]"}),
            &mut selections,
            false
        )
        .is_err());
        let disabled = json!({"plugins.disabled":"[\"plugin://computer-use@builtin\"]"});
        let found =
            search_plugins(&disabled, "plugin://computer-use@builtin", 20, 0, false).unwrap();
        assert_eq!(found["total"], 0);
        assert_eq!(found["plugins"], json!([]));
        assert!(found["nextOffset"].is_null());
        let catalog = plugin_catalog_projection(&disabled).unwrap();
        let item = catalog["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|plugin| plugin["uri"] == "plugin://computer-use@builtin")
            .unwrap();
        assert_eq!(item["enabled"], false);
        assert!(resolve_plugin_selection(&json!({}), &mut vec![], false)
            .unwrap()
            .computer_use_instance()
            .is_none());
    }

    #[test]
    fn empty_selection_does_not_load_the_plugin_catalog() {
        let selected = resolve_plugin_selection(
            &json!({"skills.mounts":"not JSON", "mcp.servers":"not JSON"}),
            &mut vec![],
            false,
        )
        .unwrap();
        assert!(selected.plugins.is_empty());
        assert!(selected.mcp_plugin_instances.is_empty());
        assert!(selected.extension_tool_prompt_providers().is_empty());
    }

    #[test]
    fn unavailable_plugins_preserve_their_errors_without_blocking_selected_skills() {
        struct TestDirectory(PathBuf);
        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let root = std::env::temp_dir().join(format!(
            "deepcode-plugin-test-{}-{}",
            std::process::id(),
            crate::now_millis()
        ));
        fs::create_dir(&root).unwrap();
        let directory = TestDirectory(root);
        fs::create_dir(directory.0.join("good")).unwrap();
        fs::create_dir(directory.0.join("bad")).unwrap();
        fs::write(
            directory.0.join("good/SKILL.md"),
            "# Good Skill\nRead the selected document.",
        )
        .unwrap();
        let unreadable = directory.0.join("bad/SKILL.md");
        fs::write(&unreadable, [0xff]).unwrap();
        let original_error = fs::read_to_string(&unreadable).unwrap_err().to_string();
        let settings = json!({
            "skills.mounts": serde_json::to_string(&json!([
                {"id":"fixtures", "path":directory.0, "enabled":true},
                {"id":"missing", "path":directory.0.join("missing"), "enabled":true},
                {"id":"disabled", "path":directory.0.join("disabled"), "enabled":false}
            ])).unwrap(),
            "mcp.servers": serde_json::to_string(&json!([
                {"id":"broken", "name":"Broken MCP", "command":"", "enabled":true}
            ])).unwrap(),
        });
        let catalog = plugin_catalog_projection(&settings).unwrap();
        let plugins = catalog["plugins"].as_array().unwrap();
        let good = plugins
            .iter()
            .find(|plugin| plugin["displayName"] == "Good Skill")
            .unwrap();
        assert_eq!(good["available"], true);
        let found =
            search_plugins(&settings, "Good Skill selected document", 10, 0, false).unwrap();
        assert_eq!(found["total"], 1);
        for key in ["uri", "displayName", "shortDescription"] {
            assert_eq!(found["plugins"][0][key], good[key]);
        }
        assert_eq!(found["plugins"][0].as_object().unwrap().len(), 3);
        let selection = |plugin: &Value| PluginSelectionInput {
            selection_id: "selection:test".into(),
            uri: plugin["uri"].as_str().unwrap().into(),
            label: plugin["displayName"].as_str().unwrap().into(),
        };
        let selected =
            resolve_plugin_selection(&settings, &mut vec![selection(good)], false).unwrap();
        assert_eq!(selected.plugins.len(), 1);
        assert_eq!(selected.plugins[0].public.uri, good["uri"]);

        let bad = plugins
            .iter()
            .find(|plugin| plugin["error"]["code"] == "skill_load_failed")
            .unwrap();
        assert_eq!(bad["available"], false);
        assert!(bad["error"]["message"]
            .as_str()
            .unwrap()
            .contains(&original_error));
        let found = search_plugins(&settings, bad["uri"].as_str().unwrap(), 10, 0, false).unwrap();
        assert_eq!(found["total"], 0);
        assert_eq!(found["plugins"], json!([]));
        assert!(found["nextOffset"].is_null());
        let rejected =
            resolve_plugin_selection(&settings, &mut vec![selection(bad)], false).unwrap_err();
        assert!(rejected.contains(&original_error));

        fs::write(&unreadable, "# Repaired Skill\nAn unrelated skill changed.").unwrap();
        let selected_after_unrelated_change =
            resolve_plugin_selection(&settings, &mut vec![selection(good)], false).unwrap();
        assert_eq!(
            selected_after_unrelated_change.plugins[0].capability_summary,
            selected.plugins[0].capability_summary
        );

        let revised_instructions = format!(
            "# Good Skill\n{}\nRead the newly selected document.",
            "Preserve the selected document and verify the result.\n".repeat(100)
        );
        fs::write(directory.0.join("good/SKILL.md"), &revised_instructions).unwrap();
        let selected_after_content_change =
            resolve_plugin_selection(&settings, &mut vec![selection(good)], false).unwrap();
        assert_eq!(
            selected_after_content_change.plugins[0].capability_summary,
            revised_instructions
        );
        assert!(plugins
            .iter()
            .any(|plugin| plugin["error"]["code"] == "skill_mount_unavailable"));
        let disabled = plugins
            .iter()
            .find(|plugin| plugin["enabled"] == false)
            .unwrap();
        assert_eq!(disabled["available"], false);
        assert!(disabled.get("error").is_none());
        assert!(
            resolve_plugin_selection(&settings, &mut vec![selection(disabled)], false)
                .unwrap_err()
                .starts_with("plugin_selection_disabled:")
        );

        let broken_mcp = plugins
            .iter()
            .find(|plugin| plugin["uri"] == "plugin://broken@mcp")
            .unwrap();
        assert_eq!(broken_mcp["available"], false);
        assert_eq!(broken_mcp["error"]["code"], "mcp_server_command_missing");
        let selected_mcp =
            BTreeMap::from([("plugin://broken@mcp".into(), "plugin-instance:test".into())]);
        match crate::local_agent_mcp::McpRuntime::from_selected_sources(
            &crate::local_agent_mcp::available_server_sources(&settings).unwrap(),
            &selected_mcp,
            None,
        ) {
            Err(error) => assert_eq!(error.code, "mcp_server_command_missing"),
            Ok(_) => panic!("selected invalid MCP server must fail before process startup"),
        }
    }
}
