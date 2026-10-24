use crate::WorkspaceBinding;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostResultSource {
    HostManagement,
    HostProjection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostCapability {
    BrowserRuntime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostCapabilityUnavailableReason {
    BackendUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilityUnavailable {
    pub capability: HostCapability,
    pub reason: HostCapabilityUnavailableReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostWorkspaceSourceKind {
    Directory,
    CodeWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceFolder {
    pub id: String,
    pub name: String,
    pub path: String,
    pub absolute_path: String,
    pub original_path: String,
    pub is_absolute: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUnsupportedWorkspaceField {
    pub key: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceSpec {
    pub id: String,
    pub name: String,
    pub source: HostWorkspaceSourceKind,
    pub source_path: Option<String>,
    pub root_path: String,
    pub folders: Vec<HostWorkspaceFolder>,
    pub unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
    pub opened_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostWorkspaceRootStatus {
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceBindingResolved {
    pub workspace_binding: WorkspaceBinding,
    pub root_status: HostWorkspaceRootStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceOpened {
    pub workspace: HostWorkspaceSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceCurrent {
    pub current: Option<HostWorkspaceSpec>,
    pub fallback_used: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceSaved {
    pub workspace_file_path: String,
    pub workspace: HostWorkspaceSpec,
    pub created: bool,
    pub overwritten: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum HostWorkspaceOutput {
    BindingResolved(HostWorkspaceBindingResolved),
    Opened(HostWorkspaceOpened),
    Current(HostWorkspaceCurrent),
    Saved(HostWorkspaceSaved),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceResult {
    pub source: HostResultSource,
    pub output: HostWorkspaceOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillEffect {
    ReadsWorkspace,
    WritesWorkspace,
    CreatesWorkspace,
    DeletesWorkspace,
    ReadsGit,
    RunsProcess,
    UsesNetwork,
    ReadsSecret,
    ModifiesGit,
    PushesGit,
    ControlsBrowser,
    ModifiesKernel,
    ModifiesConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostSkillSource {
    LocalPack { pack_id: String },
    ExternalProcess { program: String, argv: Vec<String> },
    ExternalConnector { connector_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillAdapterKind {
    Declarative,
    ExternalProcess,
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillActivationStatus {
    Dormant,
    Registered,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSkillDescriptor {
    pub id: String,
    pub version: String,
    pub title_key: Option<String>,
    pub description_key: Option<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    pub required_capabilities: Vec<String>,
    pub allowed_phases: Vec<String>,
    pub risk_level: HostSkillRiskLevel,
    pub effects: Vec<HostSkillEffect>,
    pub source: HostSkillSource,
    pub adapter_kind: HostSkillAdapterKind,
    pub activation_status: HostSkillActivationStatus,
    pub requested_model_visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSkillCatalogResult {
    pub source: HostResultSource,
    pub skills: Vec<HostSkillDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostBrowseEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBrowseEntry {
    pub name: String,
    pub absolute_path: String,
    #[serde(rename = "type")]
    pub kind: HostBrowseEntryKind,
    pub is_code_workspace: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBrowseResult {
    pub absolute_path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<HostBrowseEntry>,
}
