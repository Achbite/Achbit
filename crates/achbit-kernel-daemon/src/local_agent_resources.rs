//! Managed child workdirs are read through their actual Session ownership.
//! This does not add them to the caller's immutable execution workspace bindings.
use crate::conversation_resources::{resource_entry, ResourceReference};
use crate::local_agent_store::LocalAgentJournal;
use crate::session_service::SessionServiceError;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub(crate) struct SessionResources {
    caller: String,
    journal: LocalAgentJournal,
    gui: Arc<Mutex<crate::GuiState>>,
}

impl SessionResources {
    pub(crate) fn new(
        caller: String,
        journal: LocalAgentJournal,
        gui: Arc<Mutex<crate::GuiState>>,
    ) -> Self {
        Self {
            caller,
            journal,
            gui,
        }
    }

    pub(crate) fn read(&self, query: Value) -> Result<Value, SessionServiceError> {
        let target = query["sessionId"]
            .as_str()
            .ok_or_else(|| error("sessionId is required"))?;
        if target != self.caller
            && !self
                .journal
                .is_descendant_session(&self.caller, target)
                .map_err(|cause| SessionServiceError::new(cause.code, cause.message))?
        {
            return Err(SessionServiceError::new(
                "agent_resource_not_owned",
                "只能管理自己及后代 Agent 的工作目录。",
            ));
        }
        // Workdirs are registered after Session creation. Their Host catalog owner,
        // not the immutable creation bindings, identifies the managed directory.
        let roots = {
            let gui = self
                .gui
                .lock()
                .map_err(|_| error("Workspace catalog lock failed."))?;
            if let Some(cause) = &gui.conversation_catalog_error {
                return Err(error(cause.clone()));
            }
            gui.conversation_catalog
                .workspaces
                .iter()
                .filter(|workspace| {
                    workspace.session_workdir
                        && workspace.owner_session_id.as_deref() == Some(target)
                })
                .map(|workspace| {
                    (
                        workspace.workspace_id.clone(),
                        workspace.display_name.clone(),
                        workspace.canonical_root.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let Some(resource) = query.get("resource") else {
            return Ok(
                json!({"sessionId":target,"roots": roots.iter().map(|(id, name, root)| resource_entry(name.clone(),
                ResourceReference { workspace_id: Some(id.clone()), file_grant: None, change: None, logical_path: String::new() },
                std::path::Path::new(root))).collect::<Vec<_>>()}),
            );
        };
        let reference: ResourceReference =
            serde_json::from_value(resource.clone()).map_err(|cause| error(cause.to_string()))?;
        if reference.file_grant.is_some() || reference.change.is_some() {
            return Err(error(
                "Use a managed workdir reference returned by view=resources.",
            ));
        }
        let (_, _, root) = roots
            .iter()
            .find(|(id, _, _)| Some(id) == reference.workspace_id.as_ref())
            .ok_or_else(|| {
                error("The resource does not belong to this Agent's managed workdir.")
            })?;
        let path = crate::host_inspection::resolve_workspace_read_path(
            std::path::Path::new(root),
            &reference.logical_path,
        )
        .map_err(|cause| SessionServiceError::new(cause.code, cause.message))?;
        if path.is_dir() {
            let entries = crate::conversation_resources::directory_entries(&path, &reference)
                .map_err(|cause| error(cause.to_string()))?;
            Ok(json!({"sessionId": target, "entries": entries}))
        } else {
            let mut result = achbit_kernel_tools::text_range::read_text_range(
                &path,
                query["startLine"].as_u64().unwrap_or(1),
                query["startByte"].as_u64(),
                2000,
                262144,
            )
            .map_err(error)?;
            result["sessionId"] = json!(target);
            result["resource"] = resource.clone();
            Ok(result)
        }
    }
}

fn error(message: impl Into<String>) -> SessionServiceError {
    SessionServiceError::new("agent_resource_read_failed", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    struct Workdir(PathBuf);
    impl Drop for Workdir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn parent_reads_child_workdir_without_acquiring_its_binding_or_file_ownership() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        for id in ["session:parent", "session:peer"] {
            journal
                .create_session(id, "Owner", &json!([]), None, None)
                .unwrap();
        }
        journal.create_session("session:child", "Child", &json!([]), None,
            Some(&json!({"ownerSessionId":"session:parent", "parentSessionId":"session:parent", "parentRunId":"run:parent", "parentCallId":"call:child",
                "capabilities":{"messaging":true,"continuation":true,"delegation":false}}))).unwrap();
        let path = std::env::temp_dir().join(format!(
            "agent-resource-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        let root = Workdir(path);
        let path = root.0.join("child-workdir");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("result.txt"), "Child finding.\n").unwrap();
        let mut gui = crate::GuiState::open_at(&root.0).unwrap();
        let catalog_path = gui.paths.catalog_store_path.clone();
        gui.conversation_catalog
            .write_rows(
                &catalog_path,
                vec![crate::conversation_catalog::ConversationWorkspaceRecord {
                    workspace_id: "workspace:child".into(),
                    display_name: "Workdir".into(),
                    canonical_root: path.to_string_lossy().into(),
                    owner_session_id: Some("session:child".into()),
                    session_workdir: true,
                    created_at: crate::now_text(),
                }],
                None,
                None,
            )
            .unwrap();
        journal.append(&json!({"type":"session.directory-index.attached", "sessionId":"session:child",
            "payload":{"commandId":"command:workdir", "workspaceBinding":{"workspaceId":"workspace:child", "displayName":"Workdir"}}})).unwrap();
        let gui = Arc::new(Mutex::new(gui));
        let resources =
            SessionResources::new("session:parent".into(), journal.clone(), gui.clone());
        let roots = resources
            .read(json!({"sessionId":"session:child", "view":"resources"}))
            .unwrap();
        let reference = &roots["roots"][0]["resource"];
        let listing = resources
            .read(json!({"sessionId":"session:child", "view":"resources", "resource": reference}))
            .unwrap();
        let file = &listing["entries"][0]["resource"];
        let contents = resources
            .read(json!({"sessionId":"session:child", "view":"resources", "resource":file}))
            .unwrap();
        assert!(contents.to_string().contains("Child finding."));
        assert_eq!(contents["sessionId"], "session:child");
        assert_eq!(
            journal.read_events("session:parent", 0).unwrap()[0]["payload"]["workspaceBindings"],
            json!([])
        );
        let peer = SessionResources::new("session:peer".into(), journal, gui);
        assert_eq!(
            peer.read(json!({"sessionId":"session:child", "view":"resources"}))
                .unwrap_err()
                .code,
            "agent_resource_not_owned"
        );
    }
}
