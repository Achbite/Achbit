use crate::prelude::*;
use rusqlite::{params, Connection};

const CATALOG_SCHEMA: &str = include_str!("../../../contracts/agent-runtime/catalog.sql");
const CATALOG_VERSION: u32 = 2;
const SESSION_WORKDIR_SCHEMA: &str =
    include_str!("../../../contracts/agent-runtime/session-workdirs.sql");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBindingDisplayRecord {
    pub(crate) workspace_id: String,
    pub(crate) display_name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ConversationWorkspaceRecord {
    pub(crate) workspace_id: String,
    pub(crate) display_name: String,
    pub(crate) canonical_root: String,
    /// Present for Host-owned input snapshots and session working directories.
    pub(crate) owner_session_id: Option<String>,
    pub(crate) session_workdir: bool,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ConversationProjectRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) workspace_ids: Vec<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ConversationSessionRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) workspace_bindings: Vec<WorkspaceBindingDisplayRecord>,
    pub(crate) project_id: Option<String>,
    pub(crate) profile_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ConversationCatalog {
    pub(crate) workspaces: Vec<ConversationWorkspaceRecord>,
    pub(crate) projects: Vec<ConversationProjectRecord>,
    pub(crate) sessions: Vec<ConversationSessionRecord>,
}

impl ConversationCatalog {
    pub(crate) fn load(path: &FsPath) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建 Catalog Store 目录失败：{error}"))?;
        }
        let existed = path.exists();
        let connection =
            Connection::open(path).map_err(|error| format!("打开 Catalog Store 失败：{error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("配置 Catalog Store 超时失败：{error}"))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
            .map_err(|error| format!("配置 Catalog Store 失败：{error}"))?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("读取 Catalog Store 版本失败：{error}"))?;
        match version {
            0 if !existed || sqlite_is_empty(&connection)? => {
                connection
                    .execute_batch(CATALOG_SCHEMA)
                    .map_err(|error| format!("创建 Catalog Store 失败：{error}"))?;
                verify_version(&connection)?;
            }
            CATALOG_VERSION => verify_tables(&connection)?,
            other => {
                return Err(format!(
                    "Catalog Store schema {other} 不受支持；当前只接受 schema {CATALOG_VERSION}。"
                ))
            }
        }
        connection
            .execute_batch(SESSION_WORKDIR_SCHEMA)
            .map_err(|error| format!("创建会话工作目录目录表失败：{error}"))?;
        Self::read_all(&connection)
    }

    pub(crate) fn write_rows(
        &mut self,
        path: &FsPath,
        workspaces: Vec<ConversationWorkspaceRecord>,
        project: Option<ConversationProjectRecord>,
        session: Option<ConversationSessionRecord>,
    ) -> Result<(), String> {
        if let Some(session) = &session {
            if session.workspace_bindings.iter().any(|binding| {
                self.workspace(&binding.workspace_id).is_none()
                    && !workspaces
                        .iter()
                        .any(|workspace| workspace.workspace_id == binding.workspace_id)
            }) {
                return Err("Session workspace binding does not exist".into());
            }
        }
        let mut connection = catalog_connection(path)?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for workspace in &workspaces {
            transaction.execute(
                "INSERT INTO workspaces(workspace_id, display_name, canonical_root, owner_session_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workspace.workspace_id, workspace.display_name, workspace.canonical_root,
                    workspace.owner_session_id, workspace.created_at],
            ).map_err(|error| format!("Write workspace catalog: {error}"))?;
            if workspace.session_workdir {
                if workspace.owner_session_id.is_none() {
                    return Err("Session working directory requires an owner Session".into());
                }
                transaction
                    .execute(
                        "INSERT INTO session_workdirs(workspace_id) VALUES (?1)",
                        [&workspace.workspace_id],
                    )
                    .map_err(|error| format!("Write session working directory: {error}"))?;
            }
        }
        if let Some(project) = &project {
            transaction.execute(
                "INSERT INTO projects(project_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(project_id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at",
                params![project.id, project.title, project.created_at, project.updated_at],
            ).map_err(|error| format!("Write project catalog: {error}"))?;
            if self
                .project(&project.id)
                .is_none_or(|previous| previous.workspace_ids != project.workspace_ids)
            {
                transaction
                    .execute(
                        "DELETE FROM project_workspace_bindings WHERE project_id=?1",
                        [&project.id],
                    )
                    .map_err(|error| error.to_string())?;
                for (position, workspace_id) in project.workspace_ids.iter().enumerate() {
                    transaction.execute(
                        "INSERT INTO project_workspace_bindings(project_id, position, workspace_id) VALUES (?1, ?2, ?3)",
                        params![project.id, position as i64, workspace_id],
                    ).map_err(|error| format!("Write project binding: {error}"))?;
                }
            }
        }
        if let Some(session) = &session {
            let bindings = serde_json::to_string(&session.workspace_bindings)
                .map_err(|error| error.to_string())?;
            transaction.execute(
                "INSERT INTO session_catalog(session_id, title, project_id, workspace_bindings_json, profile_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, project_id=excluded.project_id,
                 workspace_bindings_json=excluded.workspace_bindings_json, profile_id=excluded.profile_id, updated_at=excluded.updated_at",
                params![session.id, session.title, session.project_id, bindings, session.profile_id, session.created_at, session.updated_at],
            ).map_err(|error| format!("Write session catalog: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Commit catalog: {error}"))?;
        self.workspaces.extend(workspaces);
        if let Some(project) = project {
            self.insert_project(project);
        }
        if let Some(session) = session {
            self.insert_session(session);
        }
        Ok(())
    }

    pub(crate) fn remove_project(
        &mut self,
        path: &FsPath,
        id: &str,
        now: &str,
    ) -> Result<(), String> {
        let mut connection = catalog_connection(path)?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE session_catalog SET project_id=NULL, updated_at=?2 WHERE project_id=?1",
                params![id, now],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM projects WHERE project_id=?1", [id])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.delete_project(id, now);
        Ok(())
    }

    pub(crate) fn remove_session(&mut self, path: &FsPath, id: &str) -> Result<(), String> {
        let mut connection = catalog_connection(path)?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM session_catalog WHERE session_id=?1", [id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM workspaces WHERE owner_session_id=?1", [id])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.delete_session(id);
        Ok(())
    }

    pub(crate) fn public_value(&self) -> Value {
        let mut projects = self.projects.clone();
        let mut sessions = self.sessions.clone();
        projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        json!({
            "projects": projects.into_iter().map(|project| json!({
                "id": project.id,
                "title": project.title,
                "workspaceBindings": self.binding_display(&project.workspace_ids),
                "createdAt": project.created_at,
                "updatedAt": project.updated_at,
            })).collect::<Vec<_>>(),
            "sessions": sessions.into_iter().map(|session| {
                let mut value = json!({
                    "id": session.id,
                    "title": session.title,
                    "workspaceBindings": session.workspace_bindings,
                    "createdAt": session.created_at,
                    "updatedAt": session.updated_at,
                });
                if let Some(project_id) = session.project_id {
                    value["projectId"] = json!(project_id);
                }
                if let Some(profile_id) = session.profile_id {
                    value["profileId"] = json!(profile_id);
                }
                value
            }).collect::<Vec<_>>(),
        })
    }

    pub(crate) fn management_value(&self) -> Value {
        let mut value = self.public_value();
        value["workspaces"] = Value::Array(
            self.workspaces
                .iter()
                .filter(|workspace| workspace.owner_session_id.is_none())
                .map(|workspace| {
                    json!({
                        "workspaceId": workspace.workspace_id,
                        "displayName": workspace.display_name,
                        "canonicalRoot": workspace.canonical_root,
                        "createdAt": workspace.created_at,
                    })
                })
                .collect(),
        );
        value
    }

    pub(crate) fn project(&self, project_id: &str) -> Option<&ConversationProjectRecord> {
        self.projects
            .iter()
            .find(|project| project.id == project_id)
    }

    pub(crate) fn session(&self, session_id: &str) -> Option<&ConversationSessionRecord> {
        self.sessions
            .iter()
            .find(|session| session.id == session_id)
    }

    pub(crate) fn workspace_by_root(
        &self,
        canonical_root: &str,
    ) -> Option<&ConversationWorkspaceRecord> {
        self.workspaces
            .iter()
            .find(|workspace| workspace.canonical_root == canonical_root)
    }

    pub(crate) fn workspace(&self, workspace_id: &str) -> Option<&ConversationWorkspaceRecord> {
        self.workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
    }

    pub(crate) fn insert_project(&mut self, project: ConversationProjectRecord) {
        self.projects.retain(|candidate| candidate.id != project.id);
        self.projects.insert(0, project);
    }

    pub(crate) fn insert_session(&mut self, session: ConversationSessionRecord) {
        self.sessions.retain(|candidate| candidate.id != session.id);
        self.sessions.insert(0, session);
    }

    pub(crate) fn project_binding_snapshot(
        &self,
        project_id: &str,
    ) -> Result<Vec<WorkspaceBindingDisplayRecord>, &'static str> {
        let project = self
            .project(project_id)
            .ok_or("conversation_project_not_found")?;
        Ok(self.binding_display(&project.workspace_ids))
    }

    pub(crate) fn delete_project(&mut self, project_id: &str, now: &str) -> bool {
        let before = self.projects.len();
        self.projects.retain(|project| project.id != project_id);
        if self.projects.len() == before {
            return false;
        }
        for session in &mut self.sessions {
            if session.project_id.as_deref() == Some(project_id) {
                session.project_id = None;
                session.updated_at = now.to_string();
            }
        }
        true
    }

    pub(crate) fn delete_session(&mut self, session_id: &str) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.id != session_id);
        if self.sessions.len() == before {
            return false;
        }
        self.workspaces
            .retain(|workspace| workspace.owner_session_id.as_deref() != Some(session_id));
        true
    }

    fn binding_display(&self, workspace_ids: &[String]) -> Vec<WorkspaceBindingDisplayRecord> {
        workspace_ids
            .iter()
            .filter_map(|id| self.workspace(id))
            .map(|workspace| WorkspaceBindingDisplayRecord {
                workspace_id: workspace.workspace_id.clone(),
                display_name: workspace.display_name.clone(),
            })
            .collect()
    }

    fn read_all(connection: &Connection) -> Result<Self, String> {
        let mut catalog = Self::default();
        {
            let mut statement = connection
                .prepare(
                    "SELECT w.workspace_id, w.display_name, w.canonical_root, w.owner_session_id, w.created_at,
                            d.workspace_id IS NOT NULL
                     FROM workspaces w LEFT JOIN session_workdirs d ON d.workspace_id=w.workspace_id
                     ORDER BY w.created_at, w.workspace_id",
                )
                .map_err(|error| format!("读取 workspace catalog 失败：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(ConversationWorkspaceRecord {
                        workspace_id: row.get(0)?,
                        display_name: row.get(1)?,
                        canonical_root: row.get(2)?,
                        owner_session_id: row.get(3)?,
                        created_at: row.get(4)?,
                        session_workdir: row.get(5)?,
                    })
                })
                .map_err(|error| format!("读取 workspace catalog 失败：{error}"))?;
            for row in rows {
                catalog
                    .workspaces
                    .push(row.map_err(|error| format!("解码 workspace catalog 失败：{error}"))?);
            }
        }
        {
            let mut statement = connection
                .prepare("SELECT project_id, title, created_at, updated_at FROM projects")
                .map_err(|error| format!("读取 project catalog 失败：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(ConversationProjectRecord {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        workspace_ids: Vec::new(),
                        created_at: row.get(2)?,
                        updated_at: row.get(3)?,
                    })
                })
                .map_err(|error| format!("读取 project catalog 失败：{error}"))?;
            for row in rows {
                catalog
                    .projects
                    .push(row.map_err(|error| format!("解码 project catalog 失败：{error}"))?);
            }
            for project in &mut catalog.projects {
                let mut binding_statement = connection
                    .prepare(
                        "SELECT workspace_id FROM project_workspace_bindings
                         WHERE project_id=?1 ORDER BY position",
                    )
                    .map_err(|error| format!("读取 project binding 失败：{error}"))?;
                let bindings = binding_statement
                    .query_map(params![project.id], |row| row.get::<_, String>(0))
                    .map_err(|error| format!("读取 project binding 失败：{error}"))?;
                for binding in bindings {
                    project.workspace_ids.push(
                        binding.map_err(|error| format!("解码 project binding 失败：{error}"))?,
                    );
                }
            }
        }
        {
            let mut statement = connection
                .prepare(
                    "SELECT session_id, title, project_id,
                            workspace_bindings_json, profile_id, created_at, updated_at
                     FROM session_catalog",
                )
                .map_err(|error| format!("读取 session catalog 失败：{error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .map_err(|error| format!("读取 session catalog 失败：{error}"))?;
            for row in rows {
                let (id, title, project_id, bindings, profile_id, created_at, updated_at) =
                    row.map_err(|error| format!("解码 session catalog 失败：{error}"))?;
                catalog.sessions.push(ConversationSessionRecord {
                    id,
                    title,
                    project_id,
                    workspace_bindings: serde_json::from_str(&bindings)
                        .map_err(|error| format!("Session binding display 已损坏：{error}"))?,
                    profile_id,
                    created_at,
                    updated_at,
                });
            }
        }
        catalog.validate()?;
        Ok(catalog)
    }

    fn validate(&self) -> Result<(), String> {
        let declared_session_ids = self
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut workspace_ids = std::collections::HashSet::new();
        let mut canonical_roots = std::collections::HashSet::new();
        let mut workdir_owners = std::collections::HashSet::new();
        for workspace in &self.workspaces {
            validate_record_id("workspaceId", &workspace.workspace_id)?;
            validate_title(&workspace.display_name)?;
            if workspace.session_workdir
                && (workspace.owner_session_id.is_none()
                    || !workdir_owners.insert(workspace.owner_session_id.as_deref()))
            {
                return Err("Session working directory owner is missing or duplicated".into());
            }
            if workspace
                .owner_session_id
                .as_deref()
                .is_some_and(|session_id| !declared_session_ids.contains(session_id))
            {
                return Err("Host-owned attachment workspace 引用了不存在的 Session。".to_string());
            }
            if !workspace_ids.insert(workspace.workspace_id.as_str())
                || !canonical_roots.insert(workspace.canonical_root.as_str())
            {
                return Err("Workspace catalog 包含重复身份或路径。".to_string());
            }
        }
        let mut project_ids = std::collections::HashSet::new();
        for project in &self.projects {
            validate_record_id("projectId", &project.id)?;
            validate_title(&project.title)?;
            if !project_ids.insert(project.id.as_str()) {
                return Err("Project catalog 包含重复 projectId。".to_string());
            }
            let mut bindings = std::collections::HashSet::new();
            for workspace_id in &project.workspace_ids {
                if !workspace_ids.contains(workspace_id.as_str())
                    || self
                        .workspace(workspace_id)
                        .is_some_and(|workspace| workspace.owner_session_id.is_some())
                    || !bindings.insert(workspace_id)
                {
                    return Err(format!("项目 {} 的 workspace binding 无效。", project.id));
                }
            }
        }
        let mut session_ids = std::collections::HashSet::new();
        for session in &self.sessions {
            validate_record_id("sessionId", &session.id)?;
            validate_title(&session.title)?;
            if !session_ids.insert(session.id.as_str()) {
                return Err("Session catalog 包含重复 sessionId。".to_string());
            }
            if session
                .project_id
                .as_deref()
                .is_some_and(|id| !project_ids.contains(id))
            {
                return Err(format!("会话 {} 引用了不存在的项目。", session.id));
            }
            let mut bindings = std::collections::HashSet::new();
            for binding in &session.workspace_bindings {
                validate_record_id("workspaceId", &binding.workspace_id)?;
                validate_title(&binding.display_name)?;
                let canonical_display_name = self
                    .workspace(&binding.workspace_id)
                    .filter(|workspace| workspace.owner_session_id.is_none())
                    .map(|workspace| workspace.display_name.as_str());
                if canonical_display_name != Some(binding.display_name.as_str())
                    || !bindings.insert(binding.workspace_id.as_str())
                {
                    return Err(format!(
                        "会话 {} 的 workspace creation snapshot 无效。",
                        session.id
                    ));
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn canonical_folder_path(path: &str) -> Result<String, String> {
    let canonical = fs::canonicalize(path).map_err(|error| format!("本地文件夹不可用：{error}"))?;
    if !canonical.is_dir() {
        return Err("项目路径必须是本地文件夹。".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

pub(crate) fn workspace_display_name(canonical_root: &str) -> String {
    FsPath::new(canonical_root)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

pub(crate) fn clean_title(value: &str) -> Result<String, String> {
    let title = value.trim();
    validate_title(title)?;
    Ok(title.to_string())
}

pub(crate) fn automatic_conversation_title(value: &str) -> String {
    let line = value.lines().next().unwrap_or_default().trim();
    let mut chars = line.chars();
    let mut title: String = chars.by_ref().take(48).collect();
    // 超出上限时留一个可见标记，避免标题在末尾无声断开。
    if chars.next().is_some() {
        title.push('…');
    }
    title
}

fn verify_version(connection: &Connection) -> Result<(), String> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取 Catalog Store 版本失败：{error}"))?;
    if version != CATALOG_VERSION {
        return Err(format!(
            "Catalog Store schema {version} 不是当前 schema {CATALOG_VERSION}。"
        ));
    }
    verify_tables(connection)
}

fn verify_tables(connection: &Connection) -> Result<(), String> {
    for name in [
        "workspaces",
        "projects",
        "project_workspace_bindings",
        "session_catalog",
    ] {
        let present: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                params![name],
                |row| row.get(0),
            )
            .map_err(|error| format!("验证 Catalog Store 失败：{error}"))?;
        if !present {
            return Err(format!("Catalog Store 缺少 {name} 表。"));
        }
    }
    Ok(())
}

fn catalog_connection(path: &FsPath) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
        .map_err(|error| error.to_string())?;
    verify_version(&connection)?;
    Ok(connection)
}

fn sqlite_is_empty(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查 Catalog Store 失败：{error}"))
}

fn validate_title(value: &str) -> Result<(), String> {
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err("名称必须是 1 到 120 个可显示字符。".to_string());
    }
    Ok(())
}

fn validate_record_id(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(format!("{field} 不是有效本地标识。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Store(PathBuf);
    impl Store {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "deepcode-catalog-{}",
                format!(
                    "{}-{}-{}",
                    std::process::id(),
                    crate::now_millis(),
                    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                )
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn path(&self) -> PathBuf {
            self.0.join("catalog.sqlite3")
        }
    }
    impl Drop for Store {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn session(id: &str) -> ConversationSessionRecord {
        ConversationSessionRecord {
            id: id.into(),
            title: id.into(),
            workspace_bindings: vec![],
            project_id: None,
            profile_id: None,
            created_at: "now".into(),
            updated_at: "now".into(),
        }
    }
    fn workspace(id: &str, root: &FsPath, owner: Option<&str>) -> ConversationWorkspaceRecord {
        ConversationWorkspaceRecord {
            workspace_id: id.into(),
            display_name: id.into(),
            canonical_root: root.to_string_lossy().into(),
            owner_session_id: owner.map(str::to_string),
            session_workdir: false,
            created_at: "now".into(),
        }
    }

    #[test]
    fn updating_a_session_preserves_bindings_and_unrelated_records_after_reopen() {
        let store = Store::new();
        let path = store.path();
        let mut catalog = ConversationCatalog::load(&path).unwrap();
        let mut target = session("session:one");
        target
            .workspace_bindings
            .push(WorkspaceBindingDisplayRecord {
                workspace_id: "workspace:one".into(),
                display_name: "workspace:one".into(),
            });
        let bindings = target.workspace_bindings.clone();
        catalog
            .write_rows(
                &path,
                vec![workspace("workspace:one", &store.0, None)],
                Some(ConversationProjectRecord {
                    id: "project:one".into(),
                    title: "One".into(),
                    workspace_ids: vec![],
                    created_at: "now".into(),
                    updated_at: "now".into(),
                }),
                Some(target.clone()),
            )
            .unwrap();
        catalog
            .write_rows(&path, vec![], None, Some(session("session:unrelated")))
            .unwrap();
        let unrelated = catalog.public_value()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["id"] == "session:unrelated")
            .unwrap()
            .clone();
        target.title = "Updated title".into();
        target.project_id = Some("project:one".into());
        target.profile_id = Some("profile:new".into());
        target.updated_at = "later".into();
        catalog
            .write_rows(&path, vec![], None, Some(target))
            .unwrap();
        let reopened = ConversationCatalog::load(&path).unwrap();
        assert_eq!(catalog.public_value(), reopened.public_value());
        let updated = reopened.session("session:one").unwrap();
        assert_eq!(updated.workspace_bindings, bindings);
        assert_eq!(updated.title, "Updated title");
        assert_eq!(updated.project_id.as_deref(), Some("project:one"));
        assert_eq!(updated.profile_id.as_deref(), Some("profile:new"));
        assert_eq!(updated.updated_at, "later");
        assert!(reopened.public_value()["sessions"]
            .as_array()
            .unwrap()
            .contains(&unrelated));
    }

    #[test]
    fn failed_write_keeps_memory_and_disk_unchanged() {
        let store = Store::new();
        let path = store.path();
        let mut catalog = ConversationCatalog::load(&path).unwrap();
        catalog
            .write_rows(&path, vec![], None, Some(session("session:one")))
            .unwrap();
        let before = catalog.management_value();
        let mut invalid = session("session:one");
        invalid.project_id = Some("project:missing".into());
        assert!(catalog
            .write_rows(
                &path,
                vec![workspace("workspace:new", &store.0, None)],
                None,
                Some(invalid)
            )
            .is_err());
        assert_eq!(catalog.management_value(), before);
        assert_eq!(
            ConversationCatalog::load(&path).unwrap().management_value(),
            before
        );
    }

    #[test]
    fn deleting_session_removes_only_its_owned_attachment_workspaces() {
        let store = Store::new();
        let path = store.path();
        let mut catalog = ConversationCatalog::load(&path).unwrap();
        catalog
            .write_rows(
                &path,
                vec![
                    workspace("workspace:shared", &store.0.join("shared"), None),
                    workspace(
                        "workspace:attachment",
                        &store.0.join("attachment"),
                        Some("session:one"),
                    ),
                ],
                None,
                Some(session("session:one")),
            )
            .unwrap();
        catalog.remove_session(&path, "session:one").unwrap();
        let reopened = ConversationCatalog::load(&path).unwrap();
        assert!(reopened.session("session:one").is_none());
        assert!(reopened.workspace("workspace:shared").is_some());
        assert!(reopened.workspace("workspace:attachment").is_none());
        assert_eq!(catalog.management_value(), reopened.management_value());
    }

    #[test]
    fn public_catalog_omits_absent_optional_session_fields() {
        let mut catalog = ConversationCatalog::default();
        catalog.insert_session(session("session:standalone"));
        let public = catalog.public_value();
        assert!(public["sessions"][0].get("projectId").is_none());
        assert!(public["sessions"][0].get("profileId").is_none());
    }

    #[test]
    fn unsupported_catalog_schema_is_rejected() {
        let store = Store::new();
        let path = store.path();
        ConversationCatalog::load(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", CATALOG_VERSION + 1)
            .unwrap();
        assert!(ConversationCatalog::load(&path)
            .unwrap_err()
            .contains("schema"));
    }

    #[test]
    fn automatic_conversation_title_marks_clipped_first_lines() {
        assert_eq!(automatic_conversation_title("简短标题"), "简短标题");
        let exact_limit = "长".repeat(48);
        assert_eq!(automatic_conversation_title(&exact_limit), exact_limit);
        let over_limit = "长".repeat(49);
        assert_eq!(
            automatic_conversation_title(&over_limit),
            format!("{}…", "长".repeat(48))
        );
        assert_eq!(
            automatic_conversation_title("第一行标题\n第二行内容"),
            "第一行标题"
        );
    }
}
