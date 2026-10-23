use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub snapshot_id: String,
    pub schema_version: String,
    pub source_refs: Vec<ConfigSourceRef>,
    pub effective: Value,
    pub hash: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshotRef {
    pub snapshot_id: String,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSourceRef {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub trust_level: Option<String>,
}
