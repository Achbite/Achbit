use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBinding {
    pub workspace_id: Option<String>,
    pub workspace_hash: Option<String>,
    pub open_path: Option<String>,
    pub active_folder_id: Option<String>,
    pub folder_hash: Option<String>,
}
