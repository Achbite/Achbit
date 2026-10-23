use crate::local_agent_permissions::KernelPermissionModel;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

const SESSION_STORE_SCHEMA: &str = include_str!("../../../contracts/agent-runtime/session.sql");
const EVENT_VERSION: &str = "deepcode.session-event.v5";
const COMMAND_VERSION: &str = "deepcode.command.v3";
const REPLY_VERSION: &str = "deepcode.command-reply.v3";

#[derive(Debug, Clone)]
pub(crate) struct LocalAgentStoreError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl LocalAgentStoreError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalAgentJournal {
    connection: Arc<Mutex<Connection>>,
    permissions: Arc<RwLock<KernelPermissionModel>>,
}

#[derive(Debug)]
struct ValidatedNewEvent<'a>(&'a Value);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalEvent<Payload> {
    schema_version: &'static str,
    event_id: String,
    session_id: String,
    sequence: i64,
    occurred_at: String,
    #[serde(rename = "type")]
    event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    call_id: Option<String>,
    payload: Payload,
}

#[derive(serde::Serialize)]
pub(crate) struct JournalEventPublication {
    value: Vec<JournalEvent<Box<serde_json::value::RawValue>>>,
    permissions: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunProviderRuntime {
    pub(crate) provider_runtime_ref: String,
    pub(crate) profile_id: String,
    pub(crate) reasoning_effort_override: Option<String>,
    pub(crate) context_window_tokens: u64,
    pub(crate) max_output_tokens: u32,
    pub(crate) api_surface: String,
    pub(crate) hosted_web_search: String,
    pub(crate) web_search_owner: String,
}

impl LocalAgentJournal {
    pub(crate) fn open(path: &Path) -> Result<Self, LocalAgentStoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                LocalAgentStoreError::new(
                    "session_store_directory_failed",
                    format!("创建 Session Store 目录失败：{error}"),
                )
            })?;
        }
        let existed = path.exists();
        let connection = Connection::open(path).map_err(sql_open_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(sql_error("session_store_busy_timeout_failed"))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
            .map_err(sql_error("session_store_pragma_failed"))?;
        if !existed || sqlite_is_empty(&connection)? {
            connection
                .execute_batch(SESSION_STORE_SCHEMA)
                .map_err(sql_error("session_store_schema_create_failed"))?;
        }
        verify_session_store(&connection)?;
        let mut permissions = KernelPermissionModel::default();
        {
            let observed_types = encode_json(
                &json!(KernelPermissionModel::observed_event_types().collect::<Vec<_>>()),
                "permission_model_restore_failed",
            )?;
            // Do not allocate/decode historical model contexts and tool outputs
            // merely to discard them. The live model owns the event selection;
            // rowid retains cross-session causality. Keep corrupt JSON in the
            // result so the original decoder still reports startup failures.
            let mut statement = connection.prepare(
                "SELECT session_id,event_type,payload_json,run_id,call_id,sequence FROM session_events
                 WHERE event_type IN (SELECT value FROM json_each(?1)) OR NOT json_valid(payload_json)
                 ORDER BY rowid",
            ).map_err(sql_error("permission_model_restore_failed"))?;
            let rows = statement
                .query_map([observed_types], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })
                .map_err(sql_error("permission_model_restore_failed"))?;
            for row in rows {
                let (session, kind, payload, run, call, sequence) =
                    row.map_err(sql_error("permission_model_restore_failed"))?;
                let mut event = json!({"sessionId":session,"type":kind,
                    "runId":run,"callId":call,"sequence":sequence});
                event["payload"] = decode_json(&payload, "permission_model_restore_failed")?;
                if KernelPermissionModel::observes(&event) {
                    permissions.restore(&event)?;
                }
            }
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            permissions: Arc::new(RwLock::new(permissions)),
        })
    }

    #[cfg(test)]
    pub(crate) fn create_session(
        &self,
        session_id: &str,
        display_title: &str,
        workspace_bindings: &Value,
        profile_id: Option<&str>,
        agent_context: Option<&Value>,
    ) -> Result<Value, LocalAgentStoreError> {
        self.create_session_with_recipe(
            session_id,
            display_title,
            workspace_bindings,
            profile_id,
            agent_context,
            None,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create_session_with_recipe(
        &self,
        session_id: &str,
        display_title: &str,
        workspace_bindings: &Value,
        profile_id: Option<&str>,
        agent_context: Option<&Value>,
        recipe: Option<&Value>,
        subagent_settings: Option<&Value>,
    ) -> Result<Value, LocalAgentStoreError> {
        if let Some(settings) = subagent_settings {
            validate_subagent_settings(settings)?;
        }
        if let Some(recipe) = recipe {
            crate::local_agent_recipe::AgentRecipe::decode(recipe)
                .map_err(|error| LocalAgentStoreError::new("agent_recipe_invalid", error))?;
        }
        validate_id("sessionId", session_id)?;
        validate_display_title(display_title)?;
        if let Some(profile_id) = profile_id {
            validate_id("profileId", profile_id)?;
        }
        if let Some(context) = agent_context {
            validate_agent_context(context, session_id)?;
        }
        let bindings = validate_workspace_bindings(workspace_bindings)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(sql_error("session_create_transaction_failed"))?;
        transaction
            .execute(
                "INSERT INTO sessions(session_id, display_title, initial_profile_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, display_title, profile_id, crate::now_text()],
            )
            .map_err(sql_error("session_create_failed"))?;
        for (position, binding) in bindings.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO session_workspace_bindings(
                         session_id, position, workspace_id, display_name
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        session_id,
                        position as i64,
                        binding["workspaceId"].as_str(),
                        binding["displayName"].as_str(),
                    ],
                )
                .map_err(sql_error("session_binding_create_failed"))?;
        }
        let event = json!({
            "type": "session.created",
            "sessionId": session_id,
            "payload": {
                "displayTitle": display_title,
                "workspaceBindings": bindings,
                "profileId": profile_id,
                "agentContext": agent_context,
                "recipe": recipe,
                "subagentSettings": subagent_settings,
            }
        });
        let event = strip_null_object_fields(event);
        let committed = insert_event(&transaction, validate_new_event(&event, true)?)?;
        self.commit_with_permissions(
            transaction,
            std::slice::from_ref(&committed),
            "session_create_commit_failed",
        )?;
        Ok(committed)
    }

    pub(crate) fn agent_recipe(
        &self,
        session_id: &str,
    ) -> Result<crate::local_agent_recipe::AgentRecipe, LocalAgentStoreError> {
        let connection = self.lock()?;
        let encoded = connection.query_row(
            "SELECT payload_json FROM session_events WHERE session_id=?1 AND event_type='session.created'",
            [session_id], |row| row.get::<_, String>(0),
        ).optional().map_err(sql_error("session_creation_read_failed"))?
            .ok_or_else(|| LocalAgentStoreError::new("session_not_found", "Session creation fact is missing"))?;
        let payload = decode_json(&encoded, "session_creation_corrupt")?;
        crate::local_agent_recipe::AgentRecipe::decode(payload.get("recipe").unwrap_or(&json!({})))
            .map_err(|error| LocalAgentStoreError::new("agent_recipe_invalid", error))
    }

    pub(crate) fn agent_context(
        &self,
        session_id: &str,
    ) -> Result<Option<Value>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let connection = self.lock()?;
        let encoded = connection.query_row(
            "SELECT payload_json FROM session_events WHERE session_id=?1 AND event_type='session.created'",
            [session_id], |row| row.get::<_, String>(0),
        ).optional().map_err(sql_error("session_creation_read_failed"))?
            .ok_or_else(|| LocalAgentStoreError::new("session_not_found", "Session creation fact 不存在。"))?;
        let payload = decode_json(&encoded, "session_creation_corrupt")?;
        let context = payload.get("agentContext").cloned();
        if let Some(context) = context.as_ref() {
            validate_agent_context(context, session_id)?;
        }
        Ok(context)
    }

    pub(crate) fn append(&self, event: &Value) -> Result<Value, LocalAgentStoreError> {
        let mut committed = self.append_batch(std::slice::from_ref(event))?;
        Ok(committed.remove(0))
    }

    pub(crate) fn append_batch(
        &self,
        events: &[Value],
    ) -> Result<Vec<Value>, LocalAgentStoreError> {
        if events.is_empty() {
            return Err(LocalAgentStoreError::new(
                "session_event_batch_empty",
                "Session Event batch 不能为空。",
            ));
        }
        let validated_events = events
            .iter()
            .map(|event| validate_new_event(event, false))
            .collect::<Result<Vec<_>, _>>()?;
        let session_id = required_string(&events[0], "sessionId")?;
        if events
            .iter()
            .any(|event| event.get("sessionId").and_then(Value::as_str) != Some(session_id))
        {
            return Err(LocalAgentStoreError::new(
                "session_event_batch_identity_mismatch",
                "同一原子 batch 的事件必须属于同一 Session。",
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(sql_error("session_event_transaction_failed"))?;
        let mut committed = Vec::with_capacity(events.len());
        for event in validated_events {
            committed.push(insert_event(&transaction, event)?);
        }
        self.commit_with_permissions(transaction, &committed, "session_event_commit_failed")?;
        Ok(committed)
    }

    pub(crate) fn first_input_command_id(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        self.lock()?
            .query_row(
                "SELECT json_extract(payload_json, '$.commandId') FROM session_events
             WHERE session_id=?1 AND event_type='input.accepted' ORDER BY sequence LIMIT 1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_read_failed"))
    }

    #[cfg(test)]
    pub(crate) fn read_events(
        &self,
        session_id: &str,
        after: u64,
    ) -> Result<Vec<Value>, LocalAgentStoreError> {
        self.read_event_rows::<Value>(session_id, after).map(|rows| {
            rows.into_iter().map(|row| {
                let mut event = json!({"schemaVersion": row.schema_version,
                    "eventId": row.event_id, "sessionId": row.session_id,
                    "sequence": row.sequence, "occurredAt": row.occurred_at, "type": row.event_type});
                event["payload"] = row.payload;
                if let Some(run) = row.run_id { event["runId"] = json!(run); }
                if let Some(call) = row.call_id { event["callId"] = json!(call); }
                event
            }).collect()
        })
    }

    pub(crate) fn read_events_publication(
        &self,
        session_id: &str,
        after: u64,
    ) -> Result<JournalEventPublication, LocalAgentStoreError> {
        // Stored payloads are already JSON. Validate their syntax and serialize
        // them directly, without constructing and re-encoding a second tree.
        let value = self.read_event_rows(session_id, after)?;
        let permissions = self.permission_model()?.publication(session_id, true);
        Ok(JournalEventPublication { value, permissions })
    }

    fn read_event_rows<Payload: serde::de::DeserializeOwned>(
        &self,
        session_id: &str,
        after: u64,
    ) -> Result<Vec<JournalEvent<Payload>>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let connection = self.lock()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?1)",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_read_failed"))?;
        if !exists {
            return Err(LocalAgentStoreError::new(
                "session_not_found",
                "Session 不存在。",
            ));
        }
        let mut statement = connection
            .prepare(
                "SELECT sequence, event_id, event_type, occurred_at, run_id, call_id, payload_json
                 FROM session_events
                 WHERE session_id=?1 AND sequence>?2 ORDER BY sequence ASC",
            )
            .map_err(sql_error("session_event_read_prepare_failed"))?;
        let after = i64::try_from(after).unwrap_or(i64::MAX);
        let rows = statement
            .query_map(params![session_id, after], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(sql_error("session_event_read_failed"))?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, event_id, event_type, occurred_at, run_id, call_id, payload) =
                row.map_err(sql_error("session_event_read_failed"))?;
            events.push(JournalEvent {
                schema_version: EVENT_VERSION,
                event_id,
                session_id: session_id.to_owned(),
                sequence,
                occurred_at,
                event_type,
                run_id,
                call_id,
                payload: serde_json::from_str(&payload).map_err(|error| {
                    // RawValue's syntax scanner may phrase a malformed JSON
                    // error differently. Decode only that failed row for the
                    // established diagnostic; valid history keeps the fast path.
                    decode_json(&payload, "session_event_corrupt")
                        .err()
                        .unwrap_or_else(|| {
                            LocalAgentStoreError::new(
                                "session_event_corrupt",
                                format!("JSON 解码失败：{error}"),
                            )
                        })
                })?,
            });
        }
        Ok(events)
    }

    /// Resource field projection only. Membership, grants and edited visibility
    /// are reduced by Session using the same rules as its full projection.
    pub(crate) fn read_resources(
        &self,
        session_id: &str,
        record_ids: &[String],
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let record_ids = serde_json::to_string(record_ids).map_err(|error| {
            LocalAgentStoreError::new("session_resource_query_invalid", error.to_string())
        })?;
        let connection = self.lock()?;
        let revision: i64 = connection
            .query_row(
                "SELECT (SELECT COALESCE(MAX(sequence),0) FROM session_events WHERE session_id=?1)
                 FROM sessions WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_read_failed"))?
            .ok_or_else(|| LocalAgentStoreError::new("session_not_found", "Session 不存在。"))?;
        // Never materialize model context or unrelated tool outputs. Requested
        // records and artifact sources stay intact for Session's shared decoder.
        let mut statement = connection.prepare(
            "SELECT sequence,event_type,run_id,call_id,
             CASE
               WHEN event_type='session.created' THEN json_object('workspaceBindings',json_extract(payload_json,'$.workspaceBindings'))
               WHEN event_type='session.workspaces.updated' THEN json_object('baseBindings',json_extract(payload_json,'$.baseBindings'),
                 'workspaceBindings',json_extract(payload_json,'$.workspaceBindings'))
               WHEN event_type='session.directory-index.attached' THEN json_object('workspaceBinding',json_extract(payload_json,'$.workspaceBinding'))
               WHEN event_type='session.directory-index.detached' THEN json_object('workspaceId',json_extract(payload_json,'$.workspaceId'))
               WHEN event_type='message.committed' THEN json_object('filesystemReferences',coalesce(json_extract(payload_json,'$.filesystemReferences'),json('[]')))
               WHEN event_type='approval.requested' THEN json_object('approvalId',json_extract(payload_json,'$.approvalId'),
                 'preview',json_patch(json_object('summary',json_extract(payload_json,'$.preview.summary')),
                   CASE WHEN json_type(payload_json,'$.preview.authorizationContext') IS NULL THEN '{}'
                   ELSE json_object('authorizationContext',json_extract(payload_json,'$.preview.authorizationContext')) END))
               WHEN event_type='approval.resolved' THEN json_patch(json_object('approvalId',json_extract(payload_json,'$.approvalId'),
                 'decision',json_extract(payload_json,'$.decision'),'authorityId',json_extract(payload_json,'$.authorityId')),
                   CASE WHEN json_type(payload_json,'$.authorizationScope') IS NULL THEN '{}'
                   ELSE json_object('authorizationScope',json_extract(payload_json,'$.authorizationScope')) END)
               WHEN event_type='approval.revoked' THEN json_object('authorityId',json_extract(payload_json,'$.authorityId'))
               WHEN event_type='conversation.revised' THEN json_object('fromSequence',json_extract(payload_json,'$.fromSequence'),
                 'throughSequence',json_extract(payload_json,'$.throughSequence'))
               WHEN event_type='tool.completed' THEN
                 CASE WHEN json_type(payload_json,'$.record.output.artifacts') IS NOT NULL
                   OR json_extract(payload_json,'$.record.recordId') IN (SELECT value FROM json_each(?2)) THEN payload_json ELSE '{}' END
               WHEN event_type='process.updated' THEN json_object('job',json_object('callId',json_extract(payload_json,'$.job.callId')))
               ELSE '{}'
             END
             FROM session_events WHERE session_id=?1 AND sequence<=?3 AND
               (event_type IN ('session.created','session.workspaces.updated','session.directory-index.attached','session.directory-index.detached',
                 'message.committed','approval.requested','approval.resolved','approval.revoked','run.settled','conversation.revised',
                 'tool.completed','tool.input-rejected','tool.not-executed')
                OR (json_array_length(?2)>0 AND event_type='process.updated')) ORDER BY sequence",
        ).map_err(sql_error("session_resource_read_prepare_failed"))?;
        let rows = statement
            .query_map(params![session_id, record_ids, revision], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(sql_error("session_resource_read_failed"))?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, kind, run_id, call_id, payload) =
                row.map_err(sql_error("session_resource_read_failed"))?;
            let mut event = json!({"sessionId":session_id,"sequence":sequence,"type":kind});
            event["payload"] = decode_json(&payload, "session_event_corrupt")?;
            if let Some(run_id) = run_id {
                event["runId"] = json!(run_id);
            }
            if let Some(call_id) = call_id {
                event["callId"] = json!(call_id);
            }
            events.push(event);
        }
        let mut result = json!({"sessionId":session_id,"revision":revision});
        result["events"] = Value::Array(events);
        Ok(result)
    }

    /// Project journal fields only. Run status semantics belong to Session.
    pub(crate) fn read_run_lifecycle(
        &self,
        session_id: &str,
        after: u64,
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let connection = self.lock()?;
        let revision: i64 = connection
            .query_row(
                "SELECT (SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id=?1)
                 FROM sessions WHERE session_id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_read_failed"))?
            .ok_or_else(|| LocalAgentStoreError::new("session_not_found", "Session 不存在。"))?;
        // Extract before materialization: runtime snapshots, messages, tool results
        // and display text are never decoded or returned by this read path.
        let mut statement = connection.prepare(
            "SELECT sequence, event_type, run_id, call_id,
             CASE
               WHEN event_type='run.waiting' THEN json_object('reason', json_extract(payload_json, '$.reason'))
               WHEN event_type='run.settled' THEN json_object('outcome', json_extract(payload_json, '$.outcome'))
               WHEN event_type='interaction.requested' THEN
                 CASE WHEN json_type(payload_json, '$.mode') IS NULL
                 THEN json_object('interactionId', json_extract(payload_json, '$.interactionId'))
                 ELSE json_object('interactionId', json_extract(payload_json, '$.interactionId'), 'mode', json_extract(payload_json, '$.mode')) END
               WHEN event_type='interaction.resolved' THEN json_object('interactionId', json_extract(payload_json, '$.interactionId'))
               WHEN event_type IN ('plan.published','plan.review.requested','plan.confirmed','plan.revision.requested','plan.cancelled','plan.invalidated')
                 THEN json_object('planId', json_extract(payload_json, '$.planId'), 'revision', json_extract(payload_json, '$.revision'))
               WHEN event_type='approval.requested' THEN json_object('approvalId', json_extract(payload_json, '$.approvalId'))
               WHEN event_type='approval.resolved' THEN
                 json_patch(json_object('approvalId', json_extract(payload_json, '$.approvalId'),
                   'decision', json_extract(payload_json, '$.decision'), 'authorityId', json_extract(payload_json, '$.authorityId')),
                   CASE WHEN json_type(payload_json, '$.authorizationScope') IS NULL THEN '{}'
                   ELSE json_object('authorizationScope', json_extract(payload_json, '$.authorizationScope')) END)
               WHEN event_type='approval.revoked' THEN json_object('authorityId', json_extract(payload_json, '$.authorityId'))
               WHEN event_type='conversation.revised' THEN json_object('fromSequence', json_extract(payload_json, '$.fromSequence'), 'throughSequence', json_extract(payload_json, '$.throughSequence'))
               ELSE '{}'
             END
             FROM session_events WHERE session_id=?1 AND sequence>?2 AND sequence<=?3
             AND event_type IN ('run.started','run.waiting','run.finishing','run.runtime.release_failed','run.runtime.released','run.settled',
               'interaction.requested','interaction.resolved','plan.published','plan.review.requested','plan.confirmed','plan.revision.requested','plan.cancelled','plan.invalidated',
               'approval.requested','approval.resolved','approval.revoked','tool.completed','tool.input-rejected','tool.not-executed','session.permissions.updated','conversation.revised')
             ORDER BY sequence ASC",
        ).map_err(sql_error("session_lifecycle_read_prepare_failed"))?;
        let after = i64::try_from(after).unwrap_or(i64::MAX);
        let rows = statement
            .query_map(params![session_id, after, revision], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(sql_error("session_lifecycle_read_failed"))?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, event_type, run_id, call_id, payload) =
                row.map_err(sql_error("session_lifecycle_read_failed"))?;
            let mut event = json!({"sessionId":session_id, "sequence":sequence,
                "type":event_type, "payload":decode_json(&payload, "session_event_corrupt")?});
            if let Some(run_id) = run_id {
                event["runId"] = json!(run_id);
            }
            if let Some(call_id) = call_id {
                event["callId"] = json!(call_id);
            }
            events.push(event);
        }
        Ok(json!({"sessionId":session_id, "revision":revision, "events":events}))
    }

    /// Read compact Provider receipts only; Session owns aggregation and cache coverage.
    pub(crate) fn read_provider_usage(
        &self,
        session_id: &str,
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let connection = self.lock()?;
        let revision: i64 = connection
            .query_row(
                "SELECT (SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id=?1)
             FROM sessions WHERE session_id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_read_failed"))?
            .ok_or_else(|| LocalAgentStoreError::new("session_not_found", "Session 不存在。"))?;
        let mut statement = connection.prepare(
            "SELECT sequence, event_type, run_id,
             CASE WHEN event_type='provider.turn.settled'
               THEN json_object('providerRequestId', json_extract(payload_json, '$.providerRequestId'))
               ELSE payload_json END
             FROM session_events WHERE session_id=?1 AND sequence<=?2
               AND event_type IN ('provider.turn.settled','context.updated') ORDER BY sequence ASC",
        ).map_err(sql_error("session_usage_read_prepare_failed"))?;
        let rows = statement
            .query_map(params![session_id, revision], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(sql_error("session_usage_read_failed"))?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, event_type, run_id, payload) =
                row.map_err(sql_error("session_usage_read_failed"))?;
            events.push(
                json!({"sessionId":session_id,"sequence":sequence,"type":event_type,
                "runId":run_id,"payload":decode_json(&payload, "session_event_corrupt")?}),
            );
        }
        Ok(json!({"sessionId":session_id,"revision":revision,"events":events}))
    }

    /// Project journal fields only. Agent relationship semantics belong to Session.
    pub(crate) fn read_agent_lifecycle(
        &self,
        session_id: &str,
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let connection = self.lock()?;
        let revision: i64 = connection
            .query_row(
                "SELECT (SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id=?1)
                 FROM sessions WHERE session_id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_read_failed"))?
            .ok_or_else(|| LocalAgentStoreError::new("session_not_found", "Session 不存在。"))?;
        // Extract before materialization: runtime snapshots, messages, tool results
        // and task request/result bodies are never decoded or returned by this read path.
        let mut statement = connection.prepare(
            "SELECT sequence, event_type, run_id, call_id,
             CASE
               WHEN event_type='session.created' THEN
                 CASE WHEN json_type(payload_json, '$.agentContext') IS NULL THEN '{}'
                 ELSE json_object('agentContext', json_extract(payload_json, '$.agentContext')) END
               WHEN event_type='agent.task.created' THEN json_remove(payload_json, '$.text')
               WHEN event_type='agent.task.completed' THEN json_object('taskId', json_extract(payload_json, '$.taskId'),
                 'result', json_object('outcome', json_extract(payload_json, '$.result.outcome')))
               ELSE payload_json
             END
             FROM session_events WHERE session_id=?1 AND sequence<=?2
             AND event_type IN ('session.created','agent.task.created','agent.task.started','agent.task.completed','agent.closed')
             ORDER BY sequence ASC",
        ).map_err(sql_error("session_agent_lifecycle_read_prepare_failed"))?;
        let rows = statement
            .query_map(params![session_id, revision], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(sql_error("session_agent_lifecycle_read_failed"))?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, event_type, run_id, call_id, payload) =
                row.map_err(sql_error("session_agent_lifecycle_read_failed"))?;
            let mut event = json!({"sessionId":session_id, "sequence":sequence,
                "type":event_type, "payload":decode_json(&payload, "session_event_corrupt")?});
            if let Some(run_id) = run_id {
                event["runId"] = json!(run_id);
            }
            if let Some(call_id) = call_id {
                event["callId"] = json!(call_id);
            }
            events.push(event);
        }
        Ok(json!({"sessionId":session_id, "revision":revision, "events":events}))
    }

    pub(crate) fn read_command(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<Option<Value>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("commandId", command_id)?;
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT command_json, reply_json FROM session_commands
                 WHERE session_id=?1 AND command_id=?2",
                params![session_id, command_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(sql_error("session_command_read_failed"))?
            .map(|(command, reply)| {
                Ok(json!({
                    "command": decode_json(&command, "session_command_corrupt")?,
                    "reply": decode_json(&reply, "session_command_reply_corrupt")?,
                }))
            })
            .transpose()
    }

    #[cfg(test)]
    pub(crate) fn commit_command(&self, input: &Value) -> Result<Value, LocalAgentStoreError> {
        Ok(self.commit_command_with_events(input)?["reply"].clone())
    }

    pub(crate) fn commit_command_with_events(
        &self,
        input: &Value,
    ) -> Result<Value, LocalAgentStoreError> {
        let object = exact_object(input, &["command", "events", "reply"], &[])?;
        let command = object.get("command").expect("required command");
        let events = object
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new("session_command_invalid", "events 必须是数组。")
            })?;
        let reply = object.get("reply").expect("required reply");
        validate_command(command)?;
        validate_reply(reply)?;
        let session_id = required_string(command, "sessionId")?;
        let command_id = required_string(command, "commandId")?;
        if required_string(reply, "sessionId")? != session_id
            || required_string(reply, "commandId")? != command_id
            || events
                .iter()
                .any(|event| event.get("sessionId").and_then(Value::as_str) != Some(session_id))
        {
            return Err(LocalAgentStoreError::new(
                "session_command_identity_mismatch",
                "命令、事件与回复身份不一致。",
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(sql_error("session_command_transaction_failed"))?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT command_json FROM session_commands WHERE session_id=?1 AND command_id=?2",
                params![session_id, command_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_command_read_failed"))?;
        if existing.is_some() {
            return Err(LocalAgentStoreError::new(
                "session_command_already_recorded",
                "commandId 已经提交。",
            ));
        }
        let mut committed = Vec::with_capacity(events.len());
        for event in events {
            committed.push(insert_event(
                &transaction,
                validate_new_event(event, false)?,
            )?);
        }
        let revision: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_command_revision_failed"))?;
        let mut admitted = reply.clone();
        admitted["revision"] = json!(revision);
        transaction
            .execute(
                "INSERT INTO session_commands(
                     session_id, command_id, command_json, reply_json,
                     committed_revision, committed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    session_id,
                    command_id,
                    encode_json(command, "session_command_encode_failed")?,
                    encode_json(&admitted, "session_command_reply_encode_failed")?,
                    revision,
                    crate::now_text(),
                ],
            )
            .map_err(sql_error("session_command_append_failed"))?;
        self.commit_with_permissions(transaction, &committed, "session_command_commit_failed")?;
        Ok(json!({"reply": admitted, "events": committed}))
    }

    pub(crate) fn is_descendant_session(
        &self,
        parent: &str,
        target: &str,
    ) -> Result<bool, LocalAgentStoreError> {
        let mut current = target.to_owned();
        let mut visited = std::collections::HashSet::new();
        while let Some(context) = self.agent_context(&current)? {
            if !visited.insert(current) {
                return Err(LocalAgentStoreError::new(
                    "agent_lineage_cycle",
                    "Agent 父子关系存在循环。",
                ));
            }
            current = context["parentSessionId"]
                .as_str()
                .expect("validated agent context")
                .to_owned();
            if current == parent {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(crate) fn run_workspace_binding_ids(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Vec<String>, LocalAgentStoreError> {
        self.run_workspace_binding_ids_at(session_id, run_id, i64::MAX)
    }

    fn run_workspace_start(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<(i64, Vec<String>), LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        let connection = self.lock()?;
        let (sequence, encoded): (i64, String) = connection
            .query_row(
                "SELECT sequence, payload_json FROM session_events
                 WHERE session_id=?1 AND run_id=?2 AND event_type='run.started'",
                params![session_id, run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql_error("session_run_workspace_snapshot_read_failed"))?
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_run_workspace_snapshot_missing",
                    "run.started 缺少初始 workspace bindings。",
                )
            })?;
        let payload = decode_json(&encoded, "session_run_workspace_snapshot_corrupt")?;
        let bindings =
            validate_workspace_bindings(payload.get("workspaceBindings").ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_run_workspace_snapshot_corrupt",
                    "run.started 没有 workspaceBindings。",
                )
            })?)?;
        Ok((
            sequence,
            bindings
                .into_iter()
                .filter_map(|binding| binding["workspaceId"].as_str().map(str::to_string))
                .collect(),
        ))
    }

    /// Session directory facts update the active Run, never its historical requests.
    fn run_workspace_binding_ids_at(
        &self,
        session_id: &str,
        run_id: &str,
        through_sequence: i64,
    ) -> Result<Vec<String>, LocalAgentStoreError> {
        let (started, mut bindings) = self.run_workspace_start(session_id, run_id)?;
        let connection = self.lock()?;
        let base: String = connection.query_row(
            "SELECT payload_json FROM session_events WHERE session_id=?1 AND sequence<=?2
             AND event_type IN ('session.created','session.workspaces.updated') ORDER BY sequence DESC LIMIT 1",
            params![session_id, started], |row| row.get(0),
        ).map_err(sql_error("session_run_workspace_snapshot_read_failed"))?;
        let base = decode_json(&base, "session_run_workspace_snapshot_corrupt")?;
        let mut base_ids = validate_workspace_bindings(
            base.get("baseBindings")
                .unwrap_or(&base["workspaceBindings"]),
        )?
        .into_iter()
        .map(|binding| {
            binding["workspaceId"]
                .as_str()
                .expect("validated binding")
                .to_string()
        })
        .collect::<Vec<_>>();
        let mut statement = connection.prepare(
            "SELECT event_type, payload_json FROM session_events
             WHERE session_id=?1 AND sequence>?2 AND sequence<=?3
               AND event_type IN ('session.directory-index.attached','session.directory-index.detached','session.workspaces.updated')
               AND sequence<COALESCE((SELECT MIN(sequence) FROM session_events
                 WHERE session_id=?1 AND run_id=?4 AND event_type IN ('run.finishing','run.settled')),9223372036854775807)
             ORDER BY sequence",
        ).map_err(sql_error("session_run_workspace_snapshot_read_failed"))?;
        let events = statement
            .query_map(
                params![session_id, started, through_sequence, run_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(sql_error("session_run_workspace_snapshot_read_failed"))?;
        for event in events {
            let (kind, encoded) =
                event.map_err(sql_error("session_run_workspace_snapshot_read_failed"))?;
            let payload = decode_json(&encoded, "session_run_workspace_snapshot_corrupt")?;
            if kind == "session.workspaces.updated" {
                base_ids = validate_workspace_bindings(&payload["baseBindings"])?
                    .into_iter()
                    .map(|binding| {
                        binding["workspaceId"]
                            .as_str()
                            .expect("validated binding")
                            .to_string()
                    })
                    .collect();
                bindings = validate_workspace_bindings(&payload["workspaceBindings"])?
                    .into_iter()
                    .map(|binding| {
                        binding["workspaceId"]
                            .as_str()
                            .expect("validated binding")
                            .to_string()
                    })
                    .collect();
            } else if kind == "session.directory-index.attached" {
                let id = required_string(&payload["workspaceBinding"], "workspaceId")?.to_string();
                if !bindings.contains(&id) {
                    bindings.push(id);
                }
            } else {
                let id = required_string(&payload, "workspaceId")?;
                if !base_ids.iter().any(|base| base == id) {
                    bindings.retain(|binding| binding != id);
                }
            }
        }
        Ok(bindings)
    }

    /// Validate the exact address view at the original Provider request boundary.
    pub(crate) fn provider_workspace_binding_ids(
        &self,
        session_id: &str,
        run_id: &str,
        provider_request_id: &str,
    ) -> Result<Vec<String>, LocalAgentStoreError> {
        let (started, mut expected) = self.run_workspace_start(session_id, run_id)?;
        let connection = self.lock()?;
        let (sequence, encoded): (i64, String) = connection
            .query_row(
                "SELECT sequence, payload_json FROM session_events
             WHERE session_id=?1 AND run_id=?2 AND event_type='context.composed'
             AND json_extract(payload_json, '$.providerRequestId')=?3",
                params![session_id, run_id, provider_request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql_error("session_request_workspace_read_failed"))?
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_request_workspace_missing",
                    "Provider 请求缺少已提交的资源视图。",
                )
            })?;
        drop(connection);
        let mut available = self.run_workspace_binding_ids_at(session_id, run_id, sequence)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT input.event_type, input.payload_json FROM session_events input
             WHERE input.session_id=?1 AND input.sequence<?2 AND (
               (input.event_type IN ('session.directory-index.attached','session.workspaces.updated') AND input.sequence>?3)
               OR (input.event_type='message.committed' AND json_extract(input.payload_json, '$.role')='user'
                 AND NOT EXISTS (SELECT 1 FROM session_events revision
                   WHERE revision.session_id=input.session_id AND revision.event_type='conversation.revised'
                   AND revision.sequence<?2
                   AND input.sequence BETWEEN json_extract(revision.payload_json, '$.fromSequence')
                     AND json_extract(revision.payload_json, '$.throughSequence'))))
             ORDER BY input.sequence",
            )
            .map_err(sql_error("session_input_resources_read_failed"))?;
        let inputs = statement
            .query_map(params![session_id, sequence, started], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sql_error("session_input_resources_read_failed"))?;
        for input in inputs {
            let (kind, encoded) =
                input.map_err(sql_error("session_input_resources_read_failed"))?;
            let input = decode_json(&encoded, "session_input_resources_invalid")?;
            if kind == "session.workspaces.updated" {
                for binding in validate_workspace_bindings(&input["workspaceBindings"])? {
                    let id = required_string(&binding, "workspaceId")?.to_string();
                    if !expected.contains(&id) {
                        expected.push(id);
                    }
                }
            } else if kind == "session.directory-index.attached" {
                let id = required_string(&input["workspaceBinding"], "workspaceId")?.to_string();
                if !expected.contains(&id) {
                    expected.push(id);
                }
            } else if let Some(references) = input["filesystemReferences"].as_array() {
                for reference in references {
                    let id = required_string(reference, "workspaceId")?.to_string();
                    if !available.contains(&id) {
                        available.push(id.clone());
                    }
                    if !expected.contains(&id) {
                        expected.push(id);
                    }
                }
            }
        }
        expected.retain(|id| available.contains(id));
        let receipt = decode_json(&encoded, "session_request_workspace_invalid")?;
        let bindings = receipt["workspaceBindings"].as_array().ok_or_else(|| {
            LocalAgentStoreError::new("session_request_workspace_invalid", "请求资源视图无效。")
        })?;
        let actual = bindings
            .iter()
            .map(|binding| required_string(binding, "itemId").map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()?;
        if actual != expected {
            return Err(LocalAgentStoreError::new(
                "session_request_workspace_mismatch",
                "请求资源视图与项目目录及已接纳的资源引用不一致。",
            ));
        }
        Ok(actual)
    }

    pub(crate) fn latest_workspace_addresses(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Vec<String>, LocalAgentStoreError> {
        let request: Option<String> = self
            .lock()?
            .query_row(
                "SELECT json_extract(payload_json,'$.providerRequestId') FROM session_events
             WHERE session_id=?1 AND run_id=?2 AND event_type='context.composed'
             AND json_extract(payload_json,'$.purpose')='agent' ORDER BY sequence DESC LIMIT 1",
                params![session_id, run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_request_workspace_read_failed"))?;
        match request {
            Some(request) => self.provider_workspace_binding_ids(session_id, run_id, &request),
            None => Ok(Vec::new()),
        }
    }

    /// Current formal scope and each committed request scope remain valid independently.
    pub(crate) fn has_workspace_binding_view(
        &self,
        session_id: &str,
        run_id: &str,
        bindings: &[String],
    ) -> Result<bool, LocalAgentStoreError> {
        if self.run_workspace_binding_ids(session_id, run_id)? == bindings {
            return Ok(true);
        }
        let request_ids = {
            let connection = self.lock()?;
            let mut statement = connection.prepare(
                "SELECT json_extract(payload_json, '$.providerRequestId') FROM session_events
                 WHERE session_id=?1 AND run_id=?2 AND event_type='context.composed' ORDER BY sequence DESC",
            ).map_err(sql_error("session_request_workspace_read_failed"))?;
            let rows = statement
                .query_map(params![session_id, run_id], |row| row.get::<_, String>(0))
                .map_err(sql_error("session_request_workspace_read_failed"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(sql_error("session_request_workspace_read_failed"))?
        };
        for request_id in request_ids {
            if self.provider_workspace_binding_ids(session_id, run_id, &request_id)? == bindings {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(crate) fn run_provider_runtime(
        &self,
        session_id: &str,
        run_id: &str,
        purpose: &str,
    ) -> Result<RunProviderRuntime, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        let connection = self.lock()?;
        run_provider_runtime_from_connection(&connection, session_id, run_id, purpose)
    }

    pub(crate) fn run_is_settled(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<bool, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        Ok(self
            .permission_model()?
            .authorities
            .settled(session_id, run_id))
    }
    pub(crate) fn active_plan_authorities(
        &self,
        session_id: &str,
    ) -> Result<Option<Vec<Value>>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let model = self.permission_model()?;
        let mut authorities = model.authorities.active_plan(session_id);
        if let Some(authorities) = &mut authorities {
            retain_authorities(authorities, &model);
        }
        Ok(authorities)
    }
    pub(crate) fn delegated_plan_authorities(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Vec<Value>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        delegated_authorities(&*self.permission_model()?, session_id, run_id)
    }
    pub(crate) fn non_workspace_authority_is_committed(
        &self,
        session_id: &str,
        run_id: &str,
        call_id: &str,
        authority_id: &str,
        decision: &str,
    ) -> Result<bool, LocalAgentStoreError> {
        for (field, value) in [
            ("sessionId", session_id),
            ("runId", run_id),
            ("callId", call_id),
            ("authorityId", authority_id),
        ] {
            validate_id(field, value)?;
        }
        if !matches!(decision, "allow" | "deny") {
            return Ok(false);
        }
        Ok(self
            .permission_model()?
            .authorities
            .grant(session_id, authority_id)
            .is_some_and(|grant| {
                grant.run == run_id
                    && grant.call == call_id
                    && grant.payload["decision"] == decision
            }))
    }
    pub(crate) fn session_browser_authority(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        Ok(self.permission_model()?.authorities.browser(session_id))
    }

    /// Attach the owner's current publication at a write/bootstrap boundary.
    /// Transport can reorder responses; each view carries the producer revision.
    pub(crate) fn publication(
        &self,
        value: Value,
        session_id: &str,
        descendants: bool,
    ) -> Result<Value, LocalAgentStoreError> {
        let permissions = self
            .permission_model()?
            .publication(session_id, descendants);
        // Move the journal result into its envelope; do not deep-copy large
        // event arrays through json!'s Serialize implementation for Value.
        Ok(Value::Object(Map::from_iter([
            ("value".into(), value),
            ("permissions".into(), permissions),
        ])))
    }

    pub(crate) fn event_publication(
        &self,
        value: Value,
        events: &[Value],
    ) -> Result<Value, LocalAgentStoreError> {
        if let Some(event) = events.iter().find(|event| {
            matches!(
                event["type"].as_str(),
                Some("session.created" | "run.started" | "session.permissions.updated")
            )
        }) {
            return self.publication(value, required_string(event, "sessionId")?, true);
        }
        Ok(Value::Object(Map::from_iter([
            ("value".into(), value),
            ("permissions".into(), Value::Object(Map::new())),
        ])))
    }

    pub(crate) fn effective_permissions(
        &self,
        session_id: &str,
    ) -> Result<Arc<crate::local_agent_kernel::LocalAgentPermissionPolicy>, LocalAgentStoreError>
    {
        self.permission_model()?.effective(session_id)
    }

    pub(crate) fn permissions_for_run(
        &self,
        session_id: &str,
        defaults: &Value,
    ) -> Result<Value, LocalAgentStoreError> {
        self.permission_model()?.for_run(session_id, defaults)
    }

    /// Publish Kernel-owned fields at the projection boundary. The Session's
    /// historical run snapshot is not the current inherited permission model.
    pub(crate) fn project_permissions(
        &self,
        session_id: &str,
        projection: &mut Value,
    ) -> Result<(), LocalAgentStoreError> {
        let model = self.permission_model()?;
        if projection["run"].is_object() {
            projection["effectivePermissions"] = model.effective(session_id)?.settings.clone();
        }
        if let Some(grants) = projection["shellAuthorizations"].as_array_mut() {
            grants.retain(|grant| {
                !grant["authorityId"]
                    .as_str()
                    .is_some_and(|id| model.revoked(session_id, id))
            });
        }
        Ok(())
    }

    pub(crate) fn run_permission_settings(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Value, LocalAgentStoreError> {
        let exists = self
            .permission_model()?
            .authorities
            .has_run(session_id, run_id);
        if !exists {
            return Err(LocalAgentStoreError::new(
                "session_run_fact_missing",
                "Delegating run is missing.",
            ));
        }
        Ok(self.effective_permissions(session_id)?.settings.clone())
    }

    fn permission_model(
        &self,
    ) -> Result<std::sync::RwLockReadGuard<'_, KernelPermissionModel>, LocalAgentStoreError> {
        self.permissions.read().map_err(|_| {
            LocalAgentStoreError::new(
                "kernel_permission_model_poisoned",
                "Kernel permission model lock is poisoned.",
            )
        })
    }

    fn commit_with_permissions(
        &self,
        transaction: Transaction<'_>,
        events: &[Value],
        code: &'static str,
    ) -> Result<(), LocalAgentStoreError> {
        if !events.iter().any(KernelPermissionModel::observes) {
            return transaction.commit().map_err(sql_error(code));
        }
        // Lock order is journal connection -> model. Admission reads only the model.
        // Keep readers out until both the durable facts and their projection agree.
        let mut model = self.permissions.write().map_err(|_| {
            LocalAgentStoreError::new(
                "kernel_permission_model_poisoned",
                "Kernel permission model lock is poisoned.",
            )
        })?;
        let mut next = model.clone();
        for event in events {
            if event["type"] == "plan.confirmed"
                && event["payload"]["source"] == "agent"
                && !delegated_authorities(
                    &next,
                    required_string(event, "sessionId")?,
                    required_string(event, "runId")?,
                )?
                .is_empty()
            {
                return Err(LocalAgentStoreError::new(
                    "plan_delegation_missing",
                    "An inherited Plan must retain its original parent authority.",
                ));
            }
            next.apply(event)?;
        }
        transaction.commit().map_err(sql_error(code))?;
        *model = next;
        Ok(())
    }

    pub(crate) fn delete_archive(
        &self,
        session_store_path: &Path,
        tool_record_store_path: &Path,
        session_id: &str,
    ) -> Result<usize, LocalAgentStoreError> {
        let _connection = self.lock()?;
        let mut model = self.permissions.write().map_err(|_| {
            LocalAgentStoreError::new(
                "kernel_permission_model_poisoned",
                "Kernel permission model lock is poisoned.",
            )
        })?;
        let mut next = model.clone();
        next.remove(session_id)?;
        let count = delete_session_archive(session_store_path, tool_record_store_path, session_id)?;
        *model = next;
        Ok(count)
    }

    pub(crate) fn file_authorizations(
        &self,
        session_id: &str,
        run_id: &str,
        environment: &Value,
    ) -> Result<Vec<Value>, LocalAgentStoreError> {
        Ok(self
            .permission_model()?
            .authorities
            .files(session_id, run_id, environment))
    }
    pub(crate) fn authority_revoked(
        &self,
        session_id: &str,
        _run_id: &str,
        authority_id: &str,
    ) -> Result<bool, LocalAgentStoreError> {
        Ok(self.permission_model()?.revoked(session_id, authority_id))
    }
    pub(crate) fn approval_matches_request(
        &self,
        session_id: &str,
        run_id: &str,
        call_id: &str,
        authority_id: &str,
        tool_name: &str,
        input: &Value,
        context: Option<&Value>,
    ) -> Result<bool, LocalAgentStoreError> {
        Ok(self
            .permission_model()?
            .authorities
            .grant(session_id, authority_id)
            .is_some_and(|grant| {
                grant.run == run_id
                    && grant.call == call_id
                    && grant.tool["toolName"] == tool_name
                    && grant.tool["input"] == *input
                    && !grant.requested.is_null()
                    && context.is_none_or(|context| {
                        grant.requested["preview"]["authorizationContext"] == *context
                    })
            }))
    }
    pub(crate) fn approval_has_review(
        &self,
        session_id: &str,
        authority_id: &str,
        decision: &str,
    ) -> Result<bool, LocalAgentStoreError> {
        Ok(self
            .permission_model()?
            .authorities
            .grant(session_id, authority_id)
            .is_some_and(|grant| grant.review.as_deref() == Some(decision)))
    }
    pub(crate) fn approval_source(
        &self,
        session_id: &str,
        authority_id: &str,
    ) -> Result<String, LocalAgentStoreError> {
        self.permission_model()?
            .authorities
            .grant(session_id, authority_id)
            .map(|grant| {
                grant.payload["source"]
                    .as_str()
                    .unwrap_or("user")
                    .to_owned()
            })
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "approval_authority_fact_read_failed",
                    "Approval authority is missing.",
                )
            })
    }
    pub(crate) fn execution_authority(
        &self,
        session_id: &str,
        run_id: &str,
        scope: &str,
        context: &Value,
    ) -> Result<Option<Value>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        Ok(self
            .permission_model()?
            .authorities
            .execution(session_id, run_id, scope, context))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, LocalAgentStoreError> {
        self.connection.lock().map_err(|_| {
            LocalAgentStoreError::new("session_store_lock_failed", "Session Store 锁已损坏。")
        })
    }
}

fn retain_authorities(authorities: &mut Vec<Value>, model: &KernelPermissionModel) {
    authorities.retain(|authority| {
        !model.revoked(
            authority["sessionId"].as_str().unwrap_or(""),
            authority["authorityId"].as_str().unwrap_or(""),
        )
    });
}
fn delegated_authorities(
    model: &KernelPermissionModel,
    session_id: &str,
    run_id: &str,
) -> Result<Vec<Value>, LocalAgentStoreError> {
    let mut authorities = model.authorities.delegated(session_id, run_id)?;
    retain_authorities(&mut authorities, model);
    Ok(authorities)
}

/// Explicit Session deletion is the sole lifecycle operation that removes
/// retained Kernel records. Both databases use rollback journals, so the
/// Session archive and its ToolRecords are removed in one SQLite transaction
/// spanning the attached owner databases.
pub(crate) fn delete_session_archive(
    session_store_path: &Path,
    tool_record_store_path: &Path,
    session_id: &str,
) -> Result<usize, LocalAgentStoreError> {
    validate_id("sessionId", session_id)?;
    if session_store_path == tool_record_store_path {
        return Err(LocalAgentStoreError::new(
            "session_archive_store_identity_invalid",
            "Session Store 与 ToolRecord Store 不能使用同一路径。",
        ));
    }
    let tool_store_path = tool_record_store_path.to_str().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_archive_store_path_invalid",
            "ToolRecord Store 路径不是有效 UTF-8。",
        )
    })?;
    let mut connection = Connection::open(session_store_path).map_err(sql_open_error)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(sql_error("session_archive_busy_timeout_failed"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
        .map_err(sql_error("session_archive_pragma_failed"))?;
    connection
        .execute(
            "ATTACH DATABASE ?1 AS tool_archive",
            params![tool_store_path],
        )
        .map_err(sql_error("session_archive_tool_store_attach_failed"))?;
    let tool_table_present: bool = connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM tool_archive.sqlite_schema
                 WHERE type='table' AND name='tool_records'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error("session_archive_tool_store_verify_failed"))?;
    if !tool_table_present {
        return Err(LocalAgentStoreError::new(
            "session_archive_tool_store_incomplete",
            "ToolRecord Store 缺少 tool_records 表。",
        ));
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error("session_archive_delete_transaction_failed"))?;
    let tool_record_count = transaction
        .execute(
            "DELETE FROM tool_archive.tool_records WHERE session_id=?1",
            params![session_id],
        )
        .map_err(sql_error("session_archive_tool_records_delete_failed"))?;
    let session_count = transaction
        .execute(
            "DELETE FROM main.sessions WHERE session_id=?1",
            params![session_id],
        )
        .map_err(sql_error("session_delete_failed"))?;
    if session_count == 0 {
        return Err(LocalAgentStoreError::new(
            "session_not_found",
            "Session 不存在。",
        ));
    }
    transaction
        .commit()
        .map_err(sql_error("session_archive_delete_commit_failed"))?;
    Ok(tool_record_count)
}

fn insert_event(
    transaction: &Transaction<'_>,
    event: ValidatedNewEvent<'_>,
) -> Result<Value, LocalAgentStoreError> {
    let ValidatedNewEvent(event) = event;
    validate_event_references(transaction, event)?;
    let session_id = required_string(event, "sessionId")?;
    let event_type = required_string(event, "type")?;
    let sequence: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(sql_error("session_event_sequence_failed"))?;
    let event_id = random_id("event")?;
    let occurred_at = crate::now_text();
    let payload = event.get("payload").expect("validated payload");
    transaction
        .execute(
            "INSERT INTO session_events(
                 session_id, sequence, event_id, event_type, run_id, call_id,
                 payload_json, occurred_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                session_id,
                sequence,
                event_id,
                event_type,
                event.get("runId").and_then(Value::as_str),
                event.get("callId").and_then(Value::as_str),
                encode_json(payload, "session_event_encode_failed")?,
                occurred_at,
            ],
        )
        .map_err(sql_error("session_event_append_failed"))?;
    let mut committed = event.clone();
    committed["schemaVersion"] = json!(EVENT_VERSION);
    committed["eventId"] = json!(event_id);
    committed["sequence"] = json!(sequence);
    committed["occurredAt"] = json!(occurred_at);
    Ok(committed)
}

fn validate_new_event(
    event: &Value,
    allow_creation: bool,
) -> Result<ValidatedNewEvent<'_>, LocalAgentStoreError> {
    let object = exact_object(
        event,
        &["type", "sessionId", "payload"],
        &["runId", "callId"],
    )?;
    let session_id = required_string(event, "sessionId")?;
    let event_type = required_string(event, "type")?;
    validate_id("sessionId", session_id)?;
    if !object.get("payload").is_some_and(Value::is_object) {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Session Event payload 必须是对象。",
        ));
    }
    let allowed = [
        "conversation.revised",
        "session.created",
        "session.model-settings.updated",
        "session.permissions.updated",
        "session.workspaces.updated",
        "session.directory-index.attached",
        "session.directory-index.detached",
        "input.accepted",
        "input.queued",
        "run.tools.prepared",
        "run.host.rebound",
        "run.started",
        "message.committed",
        "message.feedback.updated",
        "narrative.committed",
        "interaction.requested",
        "interaction.resolved",
        "plan.published",
        "plan.review.requested",
        "plan.reviewed",
        "plan.confirmed",
        "plan.revision.requested",
        "plan.superseded",
        "plan.cancelled",
        "plan.invalidated",
        "todo.updated",
        "artifacts.presented",
        "tool.requested",
        "tool.started",
        "approval.requested",
        "approval.resolved",
        "approval.revoked",
        "approval.reviewed",
        "tool.completed",
        "process.updated",
        "tool.input-rejected",
        "tool.interrupted",
        "tool.not-executed",
        "session.subagent-settings.updated",
        "session.control.rejected",
        "session.plugins.activated",
        "agent.task.created",
        "agent.task.started",
        "agent.task.completed",
        "agent.closed",
        "agent.control.completed",
        "session.control.completed",
        "wake.scheduled",
        "wake.cancelled",
        "wake.triggered",
        "agent.message.received",
        "context.compaction.scheduled",
        "context.compaction.requested",
        "context.compacted",
        "context.composed",
        "provider.attempt.updated",
        "run.timing.updated",
        "run.failure.recorded",
        "provider.turn.settled",
        "context.updated",
        "run.waiting",
        "run.finishing",
        "run.runtime.released",
        "run.runtime.release_failed",
        "run.settled",
    ];
    if !allowed.contains(&event_type) || event_type == "session.created" && !allow_creation {
        return Err(LocalAgentStoreError::new(
            "session_event_type_invalid",
            format!("当前 Session 合同不接受事件：{event_type}"),
        ));
    }
    let needs_run = !matches!(
        event_type,
        "session.created"
            | "conversation.revised"
            | "session.model-settings.updated"
            | "session.subagent-settings.updated"
            | "session.permissions.updated"
            | "session.workspaces.updated"
            | "session.directory-index.attached"
            | "session.directory-index.detached"
            | "input.accepted"
            | "message.committed"
            | "message.feedback.updated"
            | "agent.closed"
            | "context.compaction.scheduled"
    );
    let needs_call = matches!(
        event_type,
        "interaction.requested"
            | "plan.published"
            | "plan.review.requested"
            | "plan.reviewed"
            | "plan.confirmed"
            | "plan.revision.requested"
            | "plan.cancelled"
            | "tool.requested"
            | "tool.started"
            | "approval.requested"
            | "approval.resolved"
            | "approval.reviewed"
            | "tool.completed"
            | "process.updated"
            | "tool.input-rejected"
            | "tool.interrupted"
            | "tool.not-executed"
            | "session.control.rejected"
            | "session.plugins.activated"
            | "artifacts.presented"
            | "agent.task.created"
            | "agent.control.completed"
            | "session.control.completed"
    );
    if needs_run {
        validate_id("runId", required_string(event, "runId")?)?;
    } else if let Some(run_id) = event.get("runId") {
        validate_id(
            "runId",
            run_id.as_str().ok_or_else(|| {
                LocalAgentStoreError::new("session_event_invalid", "runId 无效。")
            })?,
        )?;
    }
    let progress_call = event_type == "todo.updated"
        && event
            .get("payload")
            .and_then(|payload| payload.get("providerCallId"))
            .is_some();
    if event_type == "todo.updated" && event.get("callId").is_some() != progress_call {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Todo control 调用必须同时携带 callId 和 providerCallId。",
        ));
    }
    if needs_call || progress_call {
        validate_id("callId", required_string(event, "callId")?)?;
    }
    if matches!(
        event_type,
        "interaction.requested"
            | "plan.published"
            | "tool.requested"
            | "session.control.rejected"
            | "session.plugins.activated"
            | "artifacts.presented"
            | "agent.control.completed"
            | "session.control.completed"
    ) || progress_call
    {
        let payload = event.get("payload").expect("validated payload");
        let provider_call_id = required_string(payload, "providerCallId")?;
        validate_id("providerCallId", provider_call_id)?;
        let logical_call_id = required_string(event, "callId")?;
        if provider_call_id == logical_call_id {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Session LogicalCallId 不能复用 providerCallId。",
            ));
        }
        if event_type == "interaction.requested" {
            let interaction_id = required_string(payload, "interactionId")?;
            validate_id("interactionId", interaction_id)?;
            if interaction_id == logical_call_id || interaction_id == provider_call_id {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "InteractionId、LogicalCallId 与 providerCallId 必须互不复用。",
                ));
            }
        }
        if event_type == "plan.published" {
            let plan_id = required_string(payload, "planId")?;
            validate_id("planId", plan_id)?;
            if plan_id == logical_call_id || plan_id == provider_call_id {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "PlanId、LogicalCallId 与 providerCallId 必须互不复用。",
                ));
            }
        }
    }
    match event_type {
        "agent.task.created" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &[
                    "taskId",
                    "agentSessionId",
                    "capabilities",
                    "createsAgent",
                    "displayName",
                    "text",
                    "delivery",
                ],
                &[],
            )?;
            for field in ["taskId", "agentSessionId"] {
                validate_id(field, required_string(payload, field)?)?;
            }
            required_string(payload, "displayName")?;
            required_string(payload, "text")?;
            validate_agent_capabilities(&payload["capabilities"])?;
            if !payload["createsAgent"].is_boolean()
                || !matches!(payload["delivery"].as_str(), Some("wait" | "async"))
            {
                return Err(LocalAgentStoreError::new(
                    "agent_task_invalid",
                    "Agent 任务创建标记或交付方式无效。",
                ));
            }
        }
        "agent.task.started" => {
            let payload = &event["payload"];
            exact_object(payload, &["taskId", "childRunId"], &[])?;
            for field in ["taskId", "childRunId"] {
                validate_id(field, required_string(payload, field)?)?;
            }
        }
        "agent.task.completed" => {
            let payload = &event["payload"];
            exact_object(payload, &["taskId", "result"], &[])?;
            validate_id("taskId", required_string(payload, "taskId")?)?;
            let result = &payload["result"];
            exact_object(
                result,
                &["outcome"],
                &["content", "error", "finalMessageId"],
            )?;
            if !matches!(
                result["outcome"].as_str(),
                Some("completed" | "failed" | "cancelled" | "indeterminate")
            ) || result
                .get("content")
                .is_some_and(|content| !content.is_string())
            {
                return Err(LocalAgentStoreError::new(
                    "agent_task_result_invalid",
                    "Agent 任务结果无效。",
                ));
            }
            if let Some(error) = result.get("error") {
                validate_local_agent_error(error)?;
            }
            if result.get("finalMessageId").is_some() {
                validate_id("finalMessageId", required_string(result, "finalMessageId")?)?;
            }
        }
        "agent.closed" => {
            let payload = &event["payload"];
            exact_object(payload, &["agentSessionId"], &[])?;
            validate_id(
                "agentSessionId",
                required_string(payload, "agentSessionId")?,
            )?;
        }
        "agent.control.completed" | "session.control.completed" => {
            let payload = &event["payload"];
            exact_object(payload, &["providerCallId", "operation", "result"], &[])?;
            if !payload["operation"].is_object() || !payload["result"].is_object() {
                return Err(LocalAgentStoreError::new(
                    "agent_control_result_invalid",
                    "Agent control 的操作与结果必须是对象。",
                ));
            }
        }
        "agent.message.received" => {
            let payload = &event["payload"];
            exact_object(payload, &["sourceSessionId", "text"], &[])?;
            validate_id(
                "sourceSessionId",
                required_string(payload, "sourceSessionId")?,
            )?;
            required_string(payload, "text")?;
        }
        "wake.scheduled" | "wake.cancelled" | "wake.triggered" => {
            let payload = &event["payload"];
            let fields = match event_type {
                "wake.scheduled" => vec!["scheduleId", "dueAt", "text"],
                "wake.triggered" => vec!["scheduleId", "text"],
                _ => vec!["scheduleId"],
            };
            exact_object(payload, &fields, &[])?;
            validate_id("scheduleId", required_string(payload, "scheduleId")?)?;
            if event_type != "wake.cancelled" {
                required_string(payload, "text")?;
            }
            if event_type == "wake.scheduled" {
                required_u64(payload, "dueAt")?;
            }
        }
        "session.created" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &["displayTitle", "workspaceBindings"],
                &["profileId", "agentContext", "recipe", "subagentSettings"],
            )?;
            if let Some(settings) = payload.get("subagentSettings") {
                validate_subagent_settings(settings)?;
            }
            if let Some(recipe) = payload.get("recipe") {
                crate::local_agent_recipe::AgentRecipe::decode(recipe)
                    .map_err(|error| LocalAgentStoreError::new("agent_recipe_invalid", error))?;
            }
            validate_display_title(required_string(payload, "displayTitle")?)?;
            validate_workspace_bindings(&payload["workspaceBindings"])?;
            if let Some(profile_id) = payload.get("profileId") {
                validate_id(
                    "profileId",
                    profile_id.as_str().ok_or_else(|| {
                        LocalAgentStoreError::new("session_event_invalid", "profileId 无效。")
                    })?,
                )?;
            }
            if let Some(context) = payload.get("agentContext") {
                validate_agent_context(context, session_id)?;
            }
        }
        "provider.attempt.updated" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &[
                    "providerRequestId",
                    "providerAttemptId",
                    "attempt",
                    "purpose",
                    "phase",
                ],
                &["error", "retryAt", "timing"],
            )?;
            for field in ["providerRequestId", "providerAttemptId"] {
                validate_id(field, required_string(payload, field)?)?;
            }
            let phase = required_string(payload, "phase")?;
            if !payload["attempt"]
                .as_u64()
                .is_some_and(|n| (1..=5).contains(&n))
                || !matches!(
                    payload["purpose"].as_str(),
                    Some("agent" | "contextCompaction" | "approvalReview")
                )
                || !matches!(phase, "started" | "completed" | "failed" | "retryWaiting")
                || matches!(phase, "failed" | "retryWaiting") != payload.get("error").is_some()
                || (phase == "retryWaiting") != payload.get("retryAt").is_some()
            {
                return Err(LocalAgentStoreError::new(
                    "provider_attempt_invalid",
                    "Provider 尝试字段无效。",
                ));
            }
            if let Some(timing) = payload.get("timing") {
                validate_session_timing(timing, false)?;
            }
            if let Some(error) = payload.get("error") {
                validate_local_agent_error(error)?;
            }
            if payload.get("retryAt").is_some() {
                required_string(payload, "retryAt")?
                    .parse::<u64>()
                    .map_err(|_| {
                        LocalAgentStoreError::new("provider_retry_time_invalid", "重试时刻无效。")
                    })?;
            }
        }
        "run.timing.updated" => {
            validate_session_timing(&event["payload"], true)?;
        }
        "run.failure.recorded" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &[
                    "revision",
                    "phase",
                    "error",
                    "providerAttemptIds",
                    "toolRecordIds",
                    "pendingCallIds",
                    "queuedMessageIds",
                    "planRef",
                ],
                &["providerRequestId", "lastMessageId"],
            )?;
            if !payload["revision"].is_u64() {
                return Err(LocalAgentStoreError::new(
                    "failure_snapshot_invalid",
                    "失败快照 revision 无效。",
                ));
            }
            required_string(payload, "phase")?;
            validate_local_agent_error(&payload["error"])?;
            for field in [
                "providerAttemptIds",
                "toolRecordIds",
                "pendingCallIds",
                "queuedMessageIds",
            ] {
                validate_unique_ids(payload, field)?;
            }
            for field in ["providerRequestId", "lastMessageId"] {
                if payload.get(field).is_some() {
                    validate_id(field, required_string(payload, field)?)?;
                }
            }
            if !payload["planRef"].is_null() {
                exact_object(&payload["planRef"], &["planId", "revision"], &[])?;
                validate_id("planId", required_string(&payload["planRef"], "planId")?)?;
                if !payload["planRef"]["revision"]
                    .as_u64()
                    .is_some_and(|n| n > 0)
                {
                    return Err(LocalAgentStoreError::new(
                        "failure_snapshot_invalid",
                        "计划 revision 无效。",
                    ));
                }
            }
        }
        "process.updated" => {
            let job = &event["payload"]["job"];
            if !job.is_object()
                || job["sessionId"] != event["sessionId"]
                || job["runId"] != event["runId"]
                || job["callId"] != event["callId"]
                || job["revision"].as_u64().is_none_or(|v| v == 0)
                || !matches!(
                    job["status"].as_str(),
                    Some("active" | "completed" | "failed" | "cancelled")
                )
            {
                return Err(LocalAgentStoreError::new(
                    "managed_process_snapshot_invalid",
                    "Managed process identity or status is invalid.",
                ));
            }
            validate_id("jobId", required_string(job, "jobId")?)?;
        }
        "tool.started" => {
            let payload = &event["payload"];
            exact_object(payload, &["attemptId", "startedAt"], &[])?;
            validate_id("attemptId", required_string(payload, "attemptId")?)?;
            required_string(payload, "startedAt")?
                .parse::<u64>()
                .map_err(|_| {
                    LocalAgentStoreError::new(
                        "tool_started_invalid",
                        "startedAt 必须是 Kernel epoch 毫秒。",
                    )
                })?;
        }
        "tool.not-executed" => {
            let payload = &event["payload"];
            exact_object(payload, &["attemptId", "reason"], &["predecessorCallId"])?;
            validate_id("attemptId", required_string(payload, "attemptId")?)?;
            let reason = required_string(payload, "reason")?;
            if !matches!(reason, "cancelled" | "dependencyFailed")
                || (reason == "dependencyFailed") != payload.get("predecessorCallId").is_some()
            {
                return Err(LocalAgentStoreError::new(
                    "tool_not_executed_invalid",
                    "未执行原因与前驱引用不一致。",
                ));
            }
            if let Some(id) = payload.get("predecessorCallId") {
                validate_id("predecessorCallId", id.as_str().unwrap_or_default())?;
            }
        }
        "session.subagent-settings.updated" => {
            let payload = &event["payload"];
            exact_object(payload, &["commandId", "settings"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_subagent_settings(&payload["settings"])?;
        }
        "tool.interrupted" => {
            let payload = &event["payload"];
            exact_object(payload, &["attemptId", "error"], &[])?;
            validate_id("attemptId", required_string(payload, "attemptId")?)?;
            validate_local_agent_error(&payload["error"])?;
            required_string(&payload["error"], "code")?;
            required_string(&payload["error"], "message")?;
        }
        "conversation.revised" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &["commandId", "messageId", "fromSequence", "throughSequence"],
                &[],
            )?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            let from = payload["fromSequence"].as_u64().unwrap_or(0);
            let through = payload["throughSequence"].as_u64().unwrap_or(0);
            if from < 2 || through < from || through > 9_007_199_254_740_991 {
                return Err(LocalAgentStoreError::new(
                    "conversation_revision_range_invalid",
                    "编辑重跑范围无效。",
                ));
            }
        }
        "session.model-settings.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["commandId", "settings"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_model_settings(&payload["settings"])?;
        }
        "tool.input-rejected" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["rejection"], &[])?;
            let rejection = &payload["rejection"];
            exact_object(
                rejection,
                &[
                    "sessionId",
                    "runId",
                    "extensionGenerationRef",
                    "kernelCatalogSnapshotRef",
                    "toolBindingRef",
                    "callId",
                    "attemptId",
                    "toolName",
                    "input",
                    "rejectedAt",
                    "error",
                ],
                &[],
            )?;
            for field in ["sessionId", "runId", "callId"] {
                if required_string(rejection, field)? != required_string(event, field)? {
                    return Err(LocalAgentStoreError::new(
                        "tool_rejection_identity_mismatch",
                        "工具参数拒绝身份与 Session 事件不一致。",
                    ));
                }
            }
            for field in [
                "extensionGenerationRef",
                "kernelCatalogSnapshotRef",
                "toolBindingRef",
                "attemptId",
                "toolName",
                "rejectedAt",
            ] {
                required_string(rejection, field)?;
            }
            validate_input_rejection_error(&rejection["error"])?;
            if !rejection["input"].is_object() {
                return Err(LocalAgentStoreError::new(
                    "tool_rejection_invalid",
                    "工具参数拒绝必须保留原始输入对象。",
                ));
            }
        }
        "input.accepted" | "input.queued" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["commandId", "messageId", "text"],
                if event_type == "input.queued" {
                    &[
                        "filesystemReferences",
                        "pluginSelections",
                        "pluginCatalogRevision",
                        "guidanceReferences",
                        "interactionId",
                    ]
                } else {
                    &["pluginSelections", "guidanceReferences"]
                },
            )?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            if payload.get("interactionId").is_some() {
                validate_id("interactionId", required_string(payload, "interactionId")?)?;
            }
            if !payload.get("text").is_some_and(Value::is_string) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "输入 text 必须是字符串；附件消息正文可以为空。",
                ));
            }
            if let Some(selections) = payload.get("pluginSelections") {
                validate_plugin_selection_list(selections)?;
            }
            if let Some(references) = payload.get("filesystemReferences") {
                validate_filesystem_references(references, "session_event_invalid")?;
            }
        }
        "session.workspaces.updated" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &["commandId", "baseBindings", "workspaceBindings"],
                &[],
            )?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_workspace_bindings(&payload["baseBindings"])?;
            validate_workspace_bindings(&payload["workspaceBindings"])?;
        }
        "session.directory-index.attached" => {
            let payload = event.get("payload").expect("validated payload");
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_workspace_bindings(&Value::Array(vec![payload
                .get("workspaceBinding")
                .cloned()
                .ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_event_invalid",
                        "directory-index attached 缺少 workspaceBinding。",
                    )
                })?]))?;
        }
        "session.directory-index.detached" => {
            let payload = event.get("payload").expect("validated payload");
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("workspaceId", required_string(payload, "workspaceId")?)?;
        }
        "run.tools.prepared" | "run.host.rebound" => {
            let payload = event.get("payload").expect("validated payload");
            if event_type == "run.host.rebound" {
                exact_object(
                    payload,
                    &["commandId", "previousBinding", "hostBinding", "toolView"],
                    &[],
                )?;
                validate_id("commandId", required_string(payload, "commandId")?)?;
                for name in ["previousBinding", "hostBinding"] {
                    let binding = &payload[name];
                    exact_object(binding, &["hostInstanceId", "windowLabel"], &[])?;
                    validate_id(
                        "hostInstanceId",
                        required_string(binding, "hostInstanceId")?,
                    )?;
                    validate_id("windowLabel", required_string(binding, "windowLabel")?)?;
                }
            } else {
                exact_object(payload, &["toolView"], &[])?;
            }
            exact_object(
                &payload["toolView"],
                &[
                    "extensionGenerationRef",
                    "kernelCatalogSnapshotRef",
                    "instructions",
                    "tools",
                    "toolPromptContributions",
                    "providerToolAliases",
                    "selectedPlugins",
                ],
                &[],
            )?;
        }
        "run.started" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["inputMessageId", "workspaceBindings", "runtimeSnapshot"],
                &[],
            )?;
            validate_id(
                "inputMessageId",
                required_string(payload, "inputMessageId")?,
            )?;
            validate_workspace_bindings(payload.get("workspaceBindings").ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "run.started 缺少 workspaceBindings。",
                )
            })?)?;
            validate_run_runtime_snapshot(
                payload
                    .get("runtimeSnapshot")
                    .expect("validated runtime snapshot"),
            )?;
        }
        "message.committed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["messageId", "role", "content"],
                &[
                    "filesystemReferences",
                    "pluginSelections",
                    "guidanceReferences",
                    "providerRequestId",
                ],
            )?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            let role = required_string(payload, "role")?;
            if !matches!(role, "user" | "assistant" | "tool" | "system") {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "message.committed role 无效。",
                ));
            }
            if role == "assistant" {
                validate_id("runId", required_string(event, "runId")?)?;
                validate_runtime_identity(
                    "providerRequestId",
                    required_string(payload, "providerRequestId")?,
                )?;
            } else if payload.get("providerRequestId").is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "只有 Provider 生成的 assistant message 可以携带 providerRequestId。",
                ));
            }
            if payload.get("content").and_then(Value::as_str).is_none() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "message.committed content 必须是字符串。",
                ));
            }
            if let Some(references) = payload.get("filesystemReferences") {
                validate_filesystem_references(references, "session_event_invalid")?;
            }
            if let Some(selections) = payload.get("pluginSelections") {
                validate_plugin_selection_list(selections)?;
            }
        }
        "narrative.committed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["narrativeId", "content", "providerRequestId"],
                &[],
            )?;
            validate_id("narrativeId", required_string(payload, "narrativeId")?)?;
            validate_runtime_identity(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if payload.get("content").and_then(Value::as_str).is_none() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "narrative.committed content 必须是字符串。",
                ));
            }
        }
        "message.feedback.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["commandId", "messageId", "feedback"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            validate_feedback(payload.get("feedback").expect("validated feedback"))?;
        }
        "plan.review.requested" | "plan.reviewed" => {
            let payload = &event["payload"];
            if event_type == "plan.review.requested" {
                exact_object(payload, &["planId", "revision", "providerRequestId"], &[])?;
            } else {
                exact_object(
                    payload,
                    &[
                        "planId",
                        "revision",
                        "providerRequestId",
                        "decision",
                        "reason",
                    ],
                    &["error"],
                )?;
                if !matches!(payload["decision"].as_str(), Some("allow" | "deny" | "ask")) {
                    return Err(LocalAgentStoreError::new(
                        "plan_review_invalid",
                        "计划审批结论无效。",
                    ));
                }
                required_string(payload, "reason")?;
                if let Some(error) = payload.get("error") {
                    validate_local_agent_error(error)?;
                }
            }
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
        }
        "plan.published" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerCallId",
                    "planId",
                    "revision",
                    "title",
                    "summary",
                    "steps",
                    "mutationManifest",
                ],
                &["workspaceRequests"],
            )?;
            if let Some(requests) = payload.get("workspaceRequests") {
                let requests = requests
                    .as_array()
                    .filter(|items| !items.is_empty())
                    .ok_or_else(|| {
                        LocalAgentStoreError::new(
                            "plan_workspace_request_invalid",
                            "待加入目录无效。",
                        )
                    })?;
                let mut ids = std::collections::HashSet::new();
                for request in requests {
                    exact_object(request, &["workspaceId", "rootPath"], &[])?;
                    let id = required_string(request, "workspaceId")?;
                    validate_id("workspaceId", id)?;
                    if !ids.insert(id)
                        || !Path::new(required_string(request, "rootPath")?).is_absolute()
                    {
                        return Err(LocalAgentStoreError::new(
                            "plan_workspace_request_invalid",
                            "待加入目录必须为不重复的绝对路径。",
                        ));
                    }
                }
            }
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_display_text(payload, "title", 240)?;
            required_string(payload, "summary")?;
            validate_plan_steps(payload.get("steps").expect("validated steps"))?;
            validate_plan_operations(
                payload
                    .get("mutationManifest")
                    .expect("validated mutation manifest"),
            )?;
        }
        "session.permissions.updated" => {
            let payload = &event["payload"];
            exact_object(payload, &["commandId", "patches"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_permission_patches(&payload["patches"])?;
        }
        "approval.revoked" => {
            let payload = &event["payload"];
            exact_object(payload, &["commandId", "authorityId"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("authorityId", required_string(payload, "authorityId")?)?;
        }
        "approval.reviewed" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &["approvalId", "providerRequestId", "decision", "reason"],
                &["error"],
            )?;
            validate_id("approvalId", required_string(payload, "approvalId")?)?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if !matches!(
                required_string(payload, "decision")?,
                "allow" | "deny" | "ask"
            ) {
                return Err(LocalAgentStoreError::new(
                    "approval_review_invalid",
                    "审查结果无效。",
                ));
            }
            required_string(payload, "reason")?;
            if let Some(error) = payload.get("error") {
                validate_local_agent_error(error)?;
            }
        }
        "plan.confirmed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "planId",
                    "revision",
                    "commandId",
                    "decisionId",
                    "authorities",
                ],
                &["source"],
            )?;
            if payload.get("source").is_some_and(|source| {
                !matches!(
                    source.as_str(),
                    Some("user" | "agent" | "parent" | "sessionWorkdir")
                )
            }) {
                return Err(LocalAgentStoreError::new(
                    "plan_source_invalid",
                    "Plan 确认来源无效。",
                ));
            }
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("decisionId", required_string(payload, "decisionId")?)?;
            validate_plan_authorities(payload, session_id, required_string(event, "runId")?)?;
        }
        "plan.revision.requested" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["planId", "revision", "commandId", "text"], &[])?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            required_string(payload, "text")?;
        }
        "plan.superseded" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "planId",
                    "revision",
                    "supersededByPlanId",
                    "supersededByRevision",
                ],
                &[],
            )?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id(
                "supersededByPlanId",
                required_string(payload, "supersededByPlanId")?,
            )?;
            required_positive_revision(payload, "supersededByRevision")?;
        }
        "plan.cancelled" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["planId", "revision", "commandId"], &[])?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
        }
        "plan.invalidated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["planId", "revision", "reason", "sourceFactRef"],
                &[],
            )?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            required_string(payload, "reason")?;
            validate_id("sourceFactRef", required_string(payload, "sourceFactRef")?)?;
        }
        "todo.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["revision", "items"], &["providerCallId"])?;
            required_positive_revision(payload, "revision")?;
            validate_todo_items(payload.get("items").expect("validated todo items"))?;
        }
        "session.plugins.activated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["providerCallId", "pluginUris", "kernelCatalogSnapshotRef"],
                &[],
            )?;
            required_string(payload, "kernelCatalogSnapshotRef")?;
            let uris = payload["pluginUris"].as_array().ok_or_else(|| {
                LocalAgentStoreError::new("session_event_invalid", "pluginUris 必须是数组。")
            })?;
            let mut seen = std::collections::HashSet::new();
            if uris.is_empty()
                || uris.iter().any(|uri| {
                    uri.as_str()
                        .is_none_or(|uri| !uri.starts_with("plugin://") || !seen.insert(uri))
                })
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "pluginUris 必须包含至少一个不重复的插件 URI。",
                ));
            }
        }
        "artifacts.presented" => {
            let payload = &event["payload"];
            exact_object(payload, &["providerCallId", "items"], &[])?;
            let items = payload["items"]
                .as_array()
                .filter(|items| !items.is_empty())
                .ok_or_else(|| {
                    LocalAgentStoreError::new("session_event_invalid", "交付项必须是非空数组。")
                })?;
            let mut deliveries = std::collections::HashSet::new();
            let mut artifacts = std::collections::HashSet::new();
            for item in items {
                exact_object(item, &["artifactId", "deliveryId", "label"], &[])?;
                let artifact = required_string(item, "artifactId")?;
                let delivery = required_string(item, "deliveryId")?;
                validate_id("artifactId", artifact)?;
                validate_id("deliveryId", delivery)?;
                if required_string(item, "label")?.trim().is_empty()
                    || !deliveries.insert(delivery)
                    || !artifacts.insert(artifact)
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "交付项身份不能重复，名称不能为空。",
                    ));
                }
            }
        }
        "session.control.rejected" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["providerCallId", "toolName", "input", "error"],
                &[],
            )?;
            if !matches!(
                required_string(payload, "toolName")?,
                "interaction.request"
                    | "plan.publish"
                    | "todo.update"
                    | "plugin.activate"
                    | "artifact.present"
                    | "agent"
                    | "session"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "session.control.rejected toolName 不是 Session control。",
                ));
            }
            if !payload.get("input").is_some_and(Value::is_object) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "session.control.rejected input 必须是对象。",
                ));
            }
            let error = payload.get("error").expect("validated error");
            validate_local_agent_error(error)?;
            required_string(error, "code")?;
            required_string(error, "message")?;
        }
        "context.compaction.scheduled" => {
            let payload = &event["payload"];
            exact_object(
                payload,
                &["compactionId", "requestedBySessionId"],
                &["focus"],
            )?;
            validate_id("compactionId", required_string(payload, "compactionId")?)?;
            validate_id(
                "requestedBySessionId",
                required_string(payload, "requestedBySessionId")?,
            )?;
            if payload.get("focus").is_some() {
                validate_focus_text(required_string(payload, "focus")?)?;
            }
            if event.get("runId").is_some() || event.get("callId").is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Scheduled compaction is a Session request, not a running call.",
                ));
            }
        }
        "context.compaction.requested" => {
            let payload = event.get("payload").expect("validated payload");
            let trigger = required_string(payload, "trigger")?;
            match trigger {
                "pressure" => {
                    exact_object(
                        payload,
                        &[
                            "compactionId",
                            "providerRequestId",
                            "trigger",
                            "coveredThroughSequence",
                        ],
                        &[],
                    )?;
                    if event.get("callId").is_some() {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "Pressure compaction 不能携带 callId。",
                        ));
                    }
                }
                "automatic" | "agent" => {
                    exact_object(
                        payload,
                        &[
                            "compactionId",
                            "providerRequestId",
                            "trigger",
                            "coveredThroughSequence",
                        ],
                        &["focus"],
                    )?;
                    if payload.get("focus").is_some() {
                        validate_focus_text(required_string(payload, "focus")?)?;
                    }
                    if event.get("callId").is_some() {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "Context compaction cannot carry callId.",
                        ));
                    }
                }
                "userFocus" => {
                    exact_object(
                        payload,
                        &[
                            "compactionId",
                            "providerRequestId",
                            "trigger",
                            "coveredThroughSequence",
                            "focus",
                            "commandId",
                        ],
                        &[],
                    )?;
                    validate_id("commandId", required_string(payload, "commandId")?)?;
                    validate_focus_text(required_string(payload, "focus")?)?;
                    if event.get("callId").is_some() {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "User focus compaction 不能携带 callId。",
                        ));
                    }
                }
                _ => {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "context.compaction.requested trigger 无效。",
                    ))
                }
            }
            validate_id("compactionId", required_string(payload, "compactionId")?)?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            required_u64(payload, "coveredThroughSequence")?;
        }
        "context.compacted" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "compactionId",
                    "providerRequestId",
                    "trigger",
                    "coveredThroughSequence",
                    "summary",
                ],
                &[],
            )?;
            validate_id("compactionId", required_string(payload, "compactionId")?)?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if !matches!(
                required_string(payload, "trigger")?,
                "pressure" | "userFocus" | "automatic" | "agent"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.compacted trigger 无效。",
                ));
            }
            required_u64(payload, "coveredThroughSequence")?;
            let summary = required_string(payload, "summary")?;
            if summary.trim().is_empty() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.compacted summary 不能为空。",
                ));
            }
            if event.get("callId").is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.compacted 不能携带 callId。",
                ));
            }
        }
        "context.composed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerRequestId",
                    "purpose",
                    "responseConstraint",
                    "dynamicInstructionBytes",
                    "messages",
                    "workspaceBindings",
                    "tools",
                    "partitions",
                ],
                &["kernelCatalogSnapshotRef", "modelView", "reviewInput"],
            )?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if !matches!(
                required_string(payload, "purpose")?,
                "agent" | "contextCompaction" | "approvalReview"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.composed purpose 无效。",
                ));
            }
            if !matches!(
                required_string(payload, "responseConstraint")?,
                "normal" | "answerOnly"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.composed responseConstraint 无效。",
                ));
            }
            required_u64(payload, "dynamicInstructionBytes")?;
            validate_context_messages(payload.get("messages").expect("validated messages"))?;
            validate_context_items(
                payload
                    .get("workspaceBindings")
                    .expect("validated workspace bindings"),
                "workspaceBindings",
            )?;
            validate_context_tools(payload.get("tools").expect("validated tools"))?;
            validate_context_partitions(payload.get("partitions").expect("validated partitions"))?;
            if let Some(view) = payload.get("modelView") {
                validate_context_model_view(view)?;
            }
            if let Some(input) = payload.get("reviewInput") {
                exact_object(input, &["instructions", "content"], &[])?;
                let instructions = required_string(input, "instructions")?;
                let content = required_string(input, "content")?;
                if payload["purpose"] != "approvalReview"
                    || instructions.chars().count() + content.chars().count() > 18000
                {
                    return Err(LocalAgentStoreError::new("approval_review_input_invalid",
                        "Approval input must belong to an independent review and fit its input budget."));
                }
            }
        }
        "provider.turn.settled" => {
            let payload = event.get("payload").expect("validated payload");
            validate_runtime_identity(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if !matches!(
                required_string(payload, "purpose")?,
                "agent" | "contextCompaction" | "approvalReview"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider.turn.settled purpose 无效。",
                ));
            }
            validate_runtime_identity(
                "providerRuntimeRef",
                required_string(payload, "providerRuntimeRef")?,
            )?;
            match required_string(payload, "outcome")? {
                "completed" => {
                    exact_object(
                        payload,
                        &[
                            "providerRequestId",
                            "purpose",
                            "providerRuntimeRef",
                            "outcome",
                            "orderedCallIds",
                        ],
                        &[
                            "reasoningContent",
                            "reasoningSignature",
                            "hostedWebSearchCalls",
                            "orderedOutputBlocks",
                            "toolCallInputs",
                        ],
                    )?;
                    let ordered_call_ids = payload
                        .get("orderedCallIds")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            LocalAgentStoreError::new(
                                "session_event_invalid",
                                "provider.turn.settled orderedCallIds 必须是数组。",
                            )
                        })?;
                    let mut seen = std::collections::HashSet::with_capacity(ordered_call_ids.len());
                    for value in ordered_call_ids {
                        let call_id = value.as_str().ok_or_else(|| {
                            LocalAgentStoreError::new(
                                "session_event_invalid",
                                "provider.turn.settled orderedCallIds 必须只包含标识。",
                            )
                        })?;
                        validate_runtime_identity("orderedCallId", call_id)?;
                        if !seen.insert(call_id) {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "provider.turn.settled orderedCallIds 不能重复。",
                            ));
                        }
                    }
                    for field in ["reasoningContent", "reasoningSignature"] {
                        if let Some(value) = payload.get(field) {
                            let text = value
                                .as_str()
                                .filter(|text| !text.trim().is_empty())
                                .ok_or_else(|| {
                                    LocalAgentStoreError::new(
                                        "session_event_invalid",
                                        format!("provider.turn.settled {field} 必须是非空字符串。"),
                                    )
                                })?;
                            if text.contains('\0') {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    format!("provider.turn.settled {field} 包含无效字符。"),
                                ));
                            }
                        }
                    }
                    if payload.get("reasoningSignature").is_some()
                        && payload.get("reasoningContent").is_none()
                    {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "provider.turn.settled reasoningSignature 缺少 reasoningContent。",
                        ));
                    }
                    if let Some(calls) = payload.get("hostedWebSearchCalls") {
                        if required_string(payload, "purpose")? != "agent" {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "只有普通 Agent turn 可以记录 Provider hosted search。",
                            ));
                        }
                        let calls = calls
                            .as_array()
                            .filter(|calls| !calls.is_empty())
                            .ok_or_else(|| {
                                LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "provider.turn.settled hostedWebSearchCalls 必须是非空数组。",
                                )
                            })?;
                        let mut seen = std::collections::HashSet::with_capacity(calls.len());
                        for call in calls {
                            if !crate::llm_transport::valid_responses_hosted_search_item(call) {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "Provider hosted search item 结构无效。",
                                ));
                            }
                            let call_id = required_string(call, "id")?;
                            validate_runtime_identity("providerHostedSearchCallId", call_id)?;
                            if !seen.insert(call_id) {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "Provider hosted search call id 不能重复。",
                                ));
                            }
                        }
                    }
                    if let Some(calls) = payload.get("toolCallInputs") {
                        if required_string(payload, "purpose")? != "agent"
                            || payload.get("orderedOutputBlocks").is_some()
                        {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "聚合工具输入只能属于普通 Agent turn，不能与有序原生项混用。",
                            ));
                        }
                        let calls = calls
                            .as_array()
                            .filter(|calls| !calls.is_empty())
                            .ok_or_else(|| {
                                LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "toolCallInputs 必须是非空数组。",
                                )
                            })?;
                        let mut ids = std::collections::HashSet::new();
                        let mut provider_ids = std::collections::HashSet::new();
                        let mut accepted = Vec::new();
                        for call in calls {
                            exact_object(
                                call,
                                &["callId", "providerCallId", "toolName", "arguments"],
                                &["error", "thoughtSignature"],
                            )?;
                            if call.get("thoughtSignature").is_some() {
                                required_string(call, "thoughtSignature")?;
                            }
                            let id = required_string(call, "callId")?;
                            let provider_id = required_string(call, "providerCallId")?;
                            validate_id("callId", id)?;
                            validate_runtime_identity("providerCallId", provider_id)?;
                            required_string(call, "toolName")?;
                            if !call["arguments"].is_string()
                                || !ids.insert(id)
                                || !provider_ids.insert(provider_id)
                            {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "toolCallInputs 参数类型或调用身份无效。",
                                ));
                            }
                            if let Some(error) = call.get("error") {
                                validate_input_rejection_error(error)?;
                            } else {
                                accepted.push(json!(id));
                            }
                        }
                        if accepted != *ordered_call_ids {
                            return Err(LocalAgentStoreError::new(
                                "provider_turn_call_order_mismatch",
                                "通过校验的输入必须与调用事实同序一致。",
                            ));
                        }
                    }
                    if let Some(blocks) = payload.get("orderedOutputBlocks") {
                        if required_string(payload, "purpose")? != "agent" {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "只有普通 Agent turn 可以记录 orderedOutputBlocks。",
                            ));
                        }
                        validate_provider_turn_output_blocks(
                            blocks,
                            payload
                                .get("orderedCallIds")
                                .expect("validated orderedCallIds"),
                        )?;
                    }
                }
                "cancelled" => {
                    exact_object(
                        payload,
                        &[
                            "providerRequestId",
                            "purpose",
                            "providerRuntimeRef",
                            "outcome",
                        ],
                        &[],
                    )?;
                }
                "failed" | "indeterminate" => {
                    exact_object(
                        payload,
                        &[
                            "providerRequestId",
                            "purpose",
                            "providerRuntimeRef",
                            "outcome",
                            "error",
                        ],
                        &[],
                    )?;
                    validate_local_agent_error(payload.get("error").expect("validated error"))?;
                }
                _ => {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "provider.turn.settled outcome 无效。",
                    ))
                }
            }
        }
        "context.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerRequestId",
                    "providerRuntimeRef",
                    "inputTokens",
                    "outputTokens",
                    "contextWindowTokens",
                ],
                &["cacheReadInputTokens", "cacheMissInputTokens"],
            )?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            validate_runtime_identity(
                "providerRuntimeRef",
                required_string(payload, "providerRuntimeRef")?,
            )?;
            let input_tokens = required_u64(payload, "inputTokens")?;
            let output_tokens = required_u64(payload, "outputTokens")?;
            let context_window_tokens = required_u64(payload, "contextWindowTokens")?;
            if context_window_tokens == 0
                || input_tokens
                    .checked_add(output_tokens)
                    .is_none_or(|total| total > context_window_tokens)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.updated token 用量超过上下文窗口。",
                ));
            }
            let cache_read = payload.get("cacheReadInputTokens");
            let cache_miss = payload.get("cacheMissInputTokens");
            if cache_read.is_some() != cache_miss.is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.updated 缓存读取和未命中字段必须同时存在。",
                ));
            }
            if cache_read.is_some() {
                let read = required_u64(payload, "cacheReadInputTokens")?;
                let miss = required_u64(payload, "cacheMissInputTokens")?;
                if read
                    .checked_add(miss)
                    .is_none_or(|total| total != input_tokens)
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "context.updated 缓存 token 必须完整划分输入 token。",
                    ));
                }
            }
        }
        "run.finishing" | "run.settled" => {
            validate_run_settlement(event.get("payload").expect("validated payload"))?;
        }
        "run.runtime.released" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "runRuntimeSnapshotRef",
                    "extensionGenerationRef",
                    "kernelCatalogSnapshotRef",
                    "providerRuntimeRef",
                    "pluginInstanceRefs",
                    "alreadyReleased",
                ],
                &[],
            )?;
            for field in [
                "runRuntimeSnapshotRef",
                "extensionGenerationRef",
                "kernelCatalogSnapshotRef",
                "providerRuntimeRef",
            ] {
                validate_runtime_identity(field, required_string(payload, field)?)?;
            }
            validate_unique_ids(payload, "pluginInstanceRefs")?;
            if !payload
                .get("alreadyReleased")
                .is_some_and(Value::is_boolean)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "run.runtime.released alreadyReleased 必须是布尔值。",
                ));
            }
        }
        "run.runtime.release_failed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "runRuntimeSnapshotRef",
                    "extensionGenerationRef",
                    "kernelCatalogSnapshotRef",
                    "providerRuntimeRef",
                    "error",
                ],
                &[],
            )?;
            for field in [
                "runRuntimeSnapshotRef",
                "extensionGenerationRef",
                "kernelCatalogSnapshotRef",
                "providerRuntimeRef",
            ] {
                validate_runtime_identity(field, required_string(payload, field)?)?;
            }
            validate_local_agent_error(payload.get("error").expect("validated error"))?;
        }
        _ => {}
    }
    Ok(ValidatedNewEvent(event))
}

fn validate_event_references(
    transaction: &Transaction<'_>,
    event: &Value,
) -> Result<(), LocalAgentStoreError> {
    let session_id = required_string(event, "sessionId")?;
    if let Some(run_id) = event.get("runId").and_then(Value::as_str) {
        if event["type"] != "run.started" {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND run_id=?2 AND event_type='run.started')",
                params![session_id, run_id], |row| row.get(0),
            ).map_err(sql_error("session_event_reference_read_failed"))?;
            if !exists {
                return Err(LocalAgentStoreError::new(
                    "session_event_run_missing",
                    "Session event references an unknown run.",
                ));
            }
        }
    }
    if matches!(
        event["type"].as_str(),
        Some(
            "tool.started"
                | "tool.completed"
                | "process.updated"
                | "tool.input-rejected"
                | "tool.interrupted"
                | "tool.not-executed"
                | "approval.requested"
                | "approval.resolved"
                | "plan.confirmed"
                | "plan.revision.requested"
                | "plan.cancelled"
        )
    ) {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND run_id=?2 AND call_id=?3)",
            params![session_id, event["runId"].as_str(), event["callId"].as_str()], |row| row.get(0),
        ).map_err(sql_error("session_event_reference_read_failed"))?;
        if !exists {
            return Err(LocalAgentStoreError::new(
                "session_event_call_missing",
                "Session event references an unknown call.",
            ));
        }
    }
    if event["type"] == "interaction.resolved"
        || event["type"] == "input.queued" && event["payload"].get("interactionId").is_some()
    {
        let interaction_id = required_string(&event["payload"], "interactionId")?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND run_id=?2
             AND event_type='interaction.requested' AND json_extract(payload_json, '$.interactionId')=?3)",
            params![session_id, event["runId"].as_str(), interaction_id], |row| row.get(0),
        ).map_err(sql_error("session_event_reference_read_failed"))?;
        if !exists {
            return Err(LocalAgentStoreError::new(
                "session_event_interaction_missing",
                "Session event references an unknown interaction.",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_permission_patches(value: &Value) -> Result<(), LocalAgentStoreError> {
    let settings = value.as_object().ok_or_else(|| {
        LocalAgentStoreError::new("permission_settings_invalid", "权限设置必须是对象。")
    })?;
    let allowed = crate::settings_api::permission_settings(&json!({}));
    if settings.keys().any(|key| allowed.get(key).is_none()) {
        return Err(LocalAgentStoreError::new(
            "permission_setting_unknown",
            "未知权限设置。",
        ));
    }
    if let Some(value) = settings.get("agent.permissions.engineeringDecisions") {
        if !matches!(value.as_str(), Some("ask" | "delegate")) {
            return Err(LocalAgentStoreError::new(
                "permission_settings_invalid",
                "工程路线委托无效。",
            ));
        }
    }
    crate::local_agent_kernel::LocalAgentPermissionPolicy::from_settings(value)
        .map_err(|error| LocalAgentStoreError::new("permission_settings_invalid", error.message))?;
    Ok(())
}

pub(crate) fn validate_subagent_settings(value: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(
        value,
        &[
            "enabled",
            "profileId",
            "reasoningEffort",
            "maxConcurrent",
            "maxCallsPerRun",
            "maxMembersPerSession",
            "allowMemberAnalysis",
            "allowFullConfiguration",
            "presets",
        ],
        &[],
    )?;
    let profile_id = value["profileId"].as_str().ok_or_else(|| {
        LocalAgentStoreError::new("agent_settings_invalid", "profileId 必须是字符串。")
    })?;
    if profile_id.trim() != profile_id
        || profile_id.chars().any(char::is_control)
        || !matches!(
            value["reasoningEffort"].as_str(),
            Some("" | "low" | "medium" | "high" | "xhigh" | "max")
        )
        || ["enabled", "allowMemberAnalysis", "allowFullConfiguration"]
            .iter()
            .any(|key| !value[key].is_boolean())
        || ["maxConcurrent", "maxCallsPerRun", "maxMembersPerSession"]
            .iter()
            .any(|key| {
                !value[key]
                    .as_u64()
                    .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
            })
        || !serde_json::from_str::<Value>(required_string(value, "presets")?)
            .is_ok_and(|presets| presets.is_array())
    {
        return Err(LocalAgentStoreError::new(
            "agent_settings_invalid",
            "子代理设置无效。",
        ));
    }
    Ok(())
}

fn validate_command(command: &Value) -> Result<(), LocalAgentStoreError> {
    let object = command.as_object().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_command_invalid",
            "Conversation command 必须是对象。",
        )
    })?;
    if object.get("schemaVersion").and_then(Value::as_str) != Some(COMMAND_VERSION) {
        return Err(LocalAgentStoreError::new(
            "session_command_version_invalid",
            "只接受 deepcode.command.v3。",
        ));
    }
    validate_id("sessionId", required_string(command, "sessionId")?)?;
    validate_id("commandId", required_string(command, "commandId")?)?;
    let command_type = required_string(command, "type")?;
    if ![
        "session.model-settings.set",
        "session.subagent-settings.set",
        "session.permissions.set",
        "approval.revoke",
        "session.workspaces.set",
        "session.directory-index.attach",
        "session.directory-index.detach",
        "message.submit",
        "message.edit",
        "context.focus",
        "message.feedback.set",
        "run.cancel",
        "run.host.rebind",
        "interaction.respond",
        "approval.respond",
        "plan.respond",
    ]
    .contains(&command_type)
    {
        return Err(LocalAgentStoreError::new(
            "session_command_type_invalid",
            format!("当前 Session 合同不接受命令：{command_type}"),
        ));
    }
    if command_type == "session.workspaces.set" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "workspaceBindings",
            ],
            &[],
        )?;
        validate_workspace_bindings(&command["workspaceBindings"])?;
    }
    if command_type == "run.host.rebind" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "runId",
                "expectedHostBinding",
                "hostBinding",
            ],
            &[],
        )?;
        validate_id("runId", required_string(command, "runId")?)?;
        for name in ["expectedHostBinding", "hostBinding"] {
            let binding = &command[name];
            exact_object(binding, &["hostInstanceId", "windowLabel"], &[])?;
            validate_id(
                "hostInstanceId",
                required_string(binding, "hostInstanceId")?,
            )?;
            validate_id("windowLabel", required_string(binding, "windowLabel")?)?;
        }
    }
    if command_type == "session.permissions.set" {
        exact_object(
            command,
            &["schemaVersion", "type", "commandId", "sessionId", "patches"],
            &[],
        )?;
        validate_permission_patches(&command["patches"])?;
    }
    if command_type == "approval.revoke" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "runId",
                "authorityId",
            ],
            &[],
        )?;
        validate_id("runId", required_string(command, "runId")?)?;
        validate_id("authorityId", required_string(command, "authorityId")?)?;
    }
    if matches!(
        command_type,
        "session.model-settings.set" | "session.subagent-settings.set"
    ) {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "settings",
            ],
            &[],
        )?;
        if command_type == "session.subagent-settings.set" {
            validate_subagent_settings(&command["settings"])?;
        } else {
            validate_model_settings(&command["settings"])?;
        }
    }
    if command_type == "message.edit" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "messageId",
                "expectedRevision",
                "text",
            ],
            &["hostBinding"],
        )?;
        validate_id("messageId", required_string(command, "messageId")?)?;
        if !command["text"].is_string()
            || !command["expectedRevision"]
                .as_u64()
                .is_some_and(|revision| revision > 0 && revision <= 9_007_199_254_740_991)
        {
            return Err(LocalAgentStoreError::new(
                "session_command_invalid",
                "编辑正文或会话 revision 无效。",
            ));
        }
        if let Some(binding) = command.get("hostBinding") {
            exact_object(binding, &["hostInstanceId", "windowLabel"], &[])?;
            validate_id(
                "hostInstanceId",
                required_string(binding, "hostInstanceId")?,
            )?;
            validate_id("windowLabel", required_string(binding, "windowLabel")?)?;
        }
    }
    if command_type == "message.feedback.set" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "messageId",
                "feedback",
            ],
            &[],
        )?;
        validate_id("messageId", required_string(command, "messageId")?)?;
        validate_feedback(command.get("feedback").expect("validated feedback"))?;
    }
    if matches!(command_type, "message.submit" | "context.focus") {
        let text_field = if command_type == "message.submit" {
            "text"
        } else {
            "task"
        };
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                text_field,
            ],
            &[
                "runId",
                "filesystemReferences",
                "profileId",
                "reasoningEffortOverride",
                "pluginCatalogRevision",
                "pluginSelections",
                "guidanceReferences",
                "hostBinding",
            ],
        )?;
        if let Some(references) = command.get("guidanceReferences") {
            let references = references.as_array().ok_or_else(|| {
                LocalAgentStoreError::new(
                    "guidance_references_invalid",
                    "Guidance references must be an array.",
                )
            })?;
            for reference in references {
                exact_object(
                    reference,
                    &["referenceId", "uri", "label", "toolName", "name"],
                    &[],
                )?;
                for field in ["referenceId", "uri", "label", "name"] {
                    required_string(reference, field)?;
                }
                if !matches!(
                    reference["toolName"].as_str(),
                    Some("skill.read" | "doc.read")
                ) {
                    return Err(LocalAgentStoreError::new(
                        "guidance_reference_invalid",
                        "Unsupported guidance reader.",
                    ));
                }
            }
        }
        if let Some(binding) = command.get("hostBinding") {
            exact_object(binding, &["hostInstanceId", "windowLabel"], &[])?;
            validate_id(
                "hostInstanceId",
                required_string(binding, "hostInstanceId")?,
            )?;
            validate_id("windowLabel", required_string(binding, "windowLabel")?)?;
        }
        if let Some(run_id) = command.get("runId") {
            if command_type != "message.submit" {
                return Err(LocalAgentStoreError::new(
                    "session_command_invalid",
                    "只有普通消息可指定排队目标 runId。",
                ));
            }
            validate_id(
                "runId",
                run_id.as_str().ok_or_else(|| {
                    LocalAgentStoreError::new("session_command_invalid", "runId 无效。")
                })?,
            )?;
        }
        let text = command
            .get(text_field)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                LocalAgentStoreError::new("session_command_invalid", "消息正文必须是字符串。")
            })?;
        let has_references = command
            .get("filesystemReferences")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        if text.trim().is_empty() && (command_type == "context.focus" || !has_references) {
            return Err(LocalAgentStoreError::new(
                "session_command_invalid",
                format!("{command_type} {text_field} 不能为空。"),
            ));
        }
        if let Some(profile_id) = command.get("profileId") {
            validate_id(
                "profileId",
                profile_id.as_str().ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_command_invalid",
                        "message.submit profileId 无效。",
                    )
                })?,
            )?;
        }
        if let Some(references) = command.get("filesystemReferences") {
            validate_filesystem_references(references, "session_command_invalid")?;
        }
        if let Some(effort) = command.get("reasoningEffortOverride") {
            validate_reasoning_override(effort)?;
        }
        validate_plugin_selections(
            command.get("pluginCatalogRevision"),
            command.get("pluginSelections"),
        )?;
    }
    if command_type == "plan.respond" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "runId",
                "planId",
                "revision",
                "response",
            ],
            &[],
        )?;
        validate_id("runId", required_string(command, "runId")?)?;
        validate_id("planId", required_string(command, "planId")?)?;
        required_positive_revision(command, "revision")?;
        let response = command.get("response").ok_or_else(|| {
            LocalAgentStoreError::new("session_command_invalid", "plan.respond 缺少 response。")
        })?;
        match required_string(response, "kind")? {
            "confirm" | "cancel" => {
                exact_object(response, &["kind"], &[])?;
            }
            "requestRevision" => {
                exact_object(response, &["kind", "text"], &[])?;
                if required_string(response, "text")?.trim().is_empty() {
                    return Err(LocalAgentStoreError::new(
                        "session_command_invalid",
                        "Plan revision text 不能为空。",
                    ));
                }
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    "session_command_invalid",
                    "plan.respond response kind 无效。",
                ))
            }
        }
    }
    Ok(())
}

fn validate_feedback(value: &Value) -> Result<(), LocalAgentStoreError> {
    if value.is_null() || matches!(value.as_str(), Some("up" | "down")) {
        return Ok(());
    }
    Err(LocalAgentStoreError::new(
        "local_agent_message_invalid",
        "feedback 必须是 up、down 或 null。",
    ))
}

fn validate_reasoning_override(value: &Value) -> Result<(), LocalAgentStoreError> {
    if value.is_null()
        || matches!(
            value.as_str(),
            Some("low" | "medium" | "high" | "xhigh" | "max")
        )
    {
        return Ok(());
    }
    Err(LocalAgentStoreError::new(
        "session_model_settings_invalid",
        "推理强度必须是 low、medium、high、xhigh、max 或 null。",
    ))
}

fn validate_model_settings(value: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(value, &["profileId", "reasoningEffortOverride"], &[])?;
    validate_id("profileId", required_string(value, "profileId")?)?;
    validate_reasoning_override(&value["reasoningEffortOverride"])
}

fn required_positive_revision(value: &Value, field: &str) -> Result<u64, LocalAgentStoreError> {
    let revision = required_u64(value, field)?;
    if revision == 0 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            format!("{field} 必须是正整数。"),
        ));
    }
    Ok(revision)
}

fn validate_display_text(
    value: &Value,
    field: &str,
    max_chars: usize,
) -> Result<(), LocalAgentStoreError> {
    let text = required_string(value, field)?;
    if text.trim() != text || text.chars().count() > max_chars || text.chars().any(char::is_control)
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            format!("{field} 不是有效的可显示文本。"),
        ));
    }
    Ok(())
}

fn validate_focus_text(text: &str) -> Result<(), LocalAgentStoreError> {
    if text.trim() != text || text.chars().count() > 16_384 || text.contains('\0') {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "context focus 不是有效任务文本。",
        ));
    }
    Ok(())
}

fn validate_plan_steps(value: &Value) -> Result<(), LocalAgentStoreError> {
    let steps = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "Plan steps 必须是数组。")
    })?;
    if steps.is_empty() {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Plan 必须包含至少一个阶段。",
        ));
    }
    let mut step_ids = std::collections::HashSet::with_capacity(steps.len());
    for step in steps {
        exact_object(step, &["stepId", "title", "details"], &["verification"])?;
        let step_id = required_string(step, "stepId")?;
        validate_id("stepId", step_id)?;
        if !step_ids.insert(step_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan stepId 不能重复。",
            ));
        }
        validate_display_text(step, "title", 240)?;
        required_string(step, "details")?;
        if let Some(verification) = step.get("verification") {
            let items = verification.as_array().ok_or_else(|| {
                LocalAgentStoreError::new("session_event_invalid", "Plan verification 必须是数组。")
            })?;
            if items
                .iter()
                .any(|item| item.as_str().is_none_or(|text| text.trim().is_empty()))
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Plan verification 无效。",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_plan_operations(value: &Value) -> Result<(), LocalAgentStoreError> {
    let operations = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "Plan mutationManifest 必须是数组。",
        )
    })?;
    for operation in operations {
        let name = required_string(operation, "operation")?;
        if matches!(name, "bash" | "powershell") {
            exact_object(
                operation,
                &["workspaceId", "operation", "writablePaths"],
                &["command", "terminal"],
            )?;
            {
                let paths = operation
                    .get("writablePaths")
                    .and_then(Value::as_array)
                    .filter(|paths| !paths.is_empty())
                    .ok_or_else(|| {
                        LocalAgentStoreError::new(
                            "session_event_invalid",
                            "Shell Plan 必须声明 writablePaths。",
                        )
                    })?;
                for target in paths {
                    exact_object(target, &["path", "kind"], &[])?;
                    let path = required_string(target, "path")?;
                    if !valid_logical_path(path)
                        || path == "."
                        || !matches!(required_string(target, "kind")?, "file" | "directory")
                    {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "Bash 可写范围必须是工作区内的文件或目录。",
                        ));
                    }
                }
            }
            let valid_command = operation.get("command").is_none_or(|value| {
                value.as_str().is_some_and(|command| {
                    !command.is_empty() && command.len() <= 16_384 && !command.contains('\0')
                })
            });
            if !valid_command {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Shell Plan command 必须是非空字符串且不超过 16384 bytes。",
                ));
            }
            if let Some(terminal) = operation.get("terminal") {
                exact_object(terminal, &["stdin"], &[])?;
                let stdin = terminal
                    .get("stdin")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        LocalAgentStoreError::new(
                            "session_event_invalid",
                            "bash Plan operation terminal.stdin 必须是字符串。",
                        )
                    })?;
                if stdin.len() > 65_536 {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "bash Plan operation terminal.stdin 超过 65536 bytes。",
                    ));
                }
            }
        } else if name == "fs.delete" {
            exact_object(
                operation,
                &["workspaceId", "operation", "target", "targetKind"],
                &[],
            )?;
            if !matches!(
                required_string(operation, "targetKind")?,
                "file" | "directoryTree"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "fs.delete Plan operation 的 targetKind 无效。",
                ));
            }
        } else {
            exact_object(
                operation,
                &["workspaceId", "operation", "target"],
                &["targetKind"],
            )?;
            if operation
                .get("targetKind")
                .is_some_and(|value| !matches!(value.as_str(), Some("file" | "directoryTree")))
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "文件写入范围的 targetKind 必须是 file 或 directoryTree。",
                ));
            }
            if !matches!(
                name,
                "fs.write" | "fs.edit" | "document.render" | "browser.capture"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Plan operation 不属于闭合 mutation 集合。",
                ));
            }
        }
        validate_id("workspaceId", required_string(operation, "workspaceId")?)?;
        if !matches!(name, "bash" | "powershell") {
            let target = required_string(operation, "target")?;
            if target.trim() != target
                || target.starts_with('/')
                || target.contains('\\')
                || target.contains('\0')
                || target
                    .split('/')
                    .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Plan target 必须是 normalized workspace-relative path。",
                ));
            }
        }
    }
    Ok(())
}

fn validate_plan_authorities(
    payload: &Value,
    session_id: &str,
    run_id: &str,
) -> Result<(), LocalAgentStoreError> {
    let plan_id = required_string(payload, "planId")?;
    let revision = required_positive_revision(payload, "revision")?;
    let decision_id = required_string(payload, "decisionId")?;
    let authorities = payload
        .get("authorities")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "plan.confirmed authorities 必须是数组。",
            )
        })?;
    let mut workspace_ids = std::collections::HashSet::with_capacity(authorities.len());
    if payload["source"] == "sessionWorkdir" && !authorities.is_empty() {
        return Err(LocalAgentStoreError::new(
            "workdir_plan_authority_invalid",
            "SessionWorkdir 准入使用既有目录权限，不能生成 Plan authority。",
        ));
    }
    for authority in authorities {
        exact_object(
            authority,
            &[
                "authorityId",
                "planId",
                "revision",
                "decisionId",
                "sessionId",
                "runId",
                "workspaceId",
                "coveredOperations",
            ],
            &[],
        )?;
        for field in [
            "authorityId",
            "planId",
            "decisionId",
            "sessionId",
            "runId",
            "workspaceId",
        ] {
            validate_id(field, required_string(authority, field)?)?;
        }
        required_positive_revision(authority, "revision")?;
        if payload["source"] == "parent" && authority["sessionId"] == session_id {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "父 Plan 引用不能生成当前子会话的新授权。",
            ));
        }
        if payload["source"] != "parent"
            && (required_string(authority, "planId")? != plan_id
                || required_positive_revision(authority, "revision")? != revision
                || required_string(authority, "decisionId")? != decision_id
                || required_string(authority, "runId")? != run_id)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan authority identity 与 confirmation 不一致。",
            ));
        }
        let workspace_id = required_string(authority, "workspaceId")?;
        if !workspace_ids.insert(workspace_id) && payload["source"] != "parent" {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "每个 workspace 只能有一个 Plan authority。",
            ));
        }
        let operations = authority.get("coveredOperations").ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan authority 缺少 coveredOperations。",
            )
        })?;
        validate_plan_operations(operations)?;
        if operations.as_array().is_some_and(|items| {
            items.iter().any(|operation| {
                operation.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
            })
        }) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan authority 只能覆盖自己的 workspace。",
            ));
        }
    }
    Ok(())
}

fn validate_todo_items(value: &Value) -> Result<(), LocalAgentStoreError> {
    let items = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "Todo items 必须是数组。")
    })?;
    for item in items {
        exact_object(item, &["text", "status"], &[])?;
        if required_string(item, "text")?.trim().is_empty()
            || !matches!(
                required_string(item, "status")?,
                "pending" | "inProgress" | "completed" | "blocked"
            )
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Todo text 或 status 无效。",
            ));
        }
    }
    Ok(())
}

fn validate_context_model_view(value: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(value, &["throughSequence", "additions"], &[])?;
    required_u64(value, "throughSequence")?;
    let additions = value["additions"].as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "modelView additions 必须是数组。")
    })?;
    for contribution in additions {
        exact_object(
            contribution,
            &[
                "contributionId",
                "contributionKind",
                "label",
                "sourceSequence",
                "message",
            ],
            &[],
        )?;
        for field in ["contributionId", "contributionKind", "label"] {
            required_string(contribution, field)?;
        }
        required_u64(contribution, "sourceSequence")?;
        // Shape only: Session admission owns source selection and immutability.
        serde_json::from_value::<crate::local_agent_api::LocalProviderMessage>(
            contribution["message"].clone(),
        )
        .map_err(|error| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                format!("modelView message 无效：{error}"),
            )
        })?;
    }
    Ok(())
}

fn validate_context_messages(value: &Value) -> Result<(), LocalAgentStoreError> {
    let messages = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "context messages 必须是数组。")
    })?;
    let mut contribution_ids = std::collections::HashSet::new();
    let mut call_ids = std::collections::HashSet::new();
    for (message_index, message) in messages.iter().enumerate() {
        exact_object(
            message,
            &[
                "messageIndex",
                "contributionId",
                "contributionKind",
                "label",
                "role",
                "blocks",
                "filesystemReferences",
            ],
            &[],
        )?;
        if required_u64(message, "messageIndex")? != message_index as u64 {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context messageIndex 必须与 Provider request 消息顺序一致。",
            ));
        }
        let contribution_id = required_string(message, "contributionId")?;
        validate_id("contributionId", contribution_id)?;
        if !contribution_ids.insert(contribution_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context contributionId 不能重复。",
            ));
        }
        if ![
            "instructions",
            "workspaceBindings",
            "sessionControls",
            "journalMessages",
            "contextProviders",
        ]
        .contains(&required_string(message, "contributionKind")?)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context contributionKind 无效。",
            ));
        }
        required_string(message, "label")?;
        let role = required_string(message, "role")?;
        if !["system", "user", "assistant", "tool"].contains(&role) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context message role 无效。",
            ));
        }
        let blocks = message
            .get("blocks")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context message blocks 必须是数组。",
                )
            })?;
        let mut result_count = 0usize;
        let mut hosted_search_ids = std::collections::HashSet::new();
        for (block_index, block) in blocks.iter().enumerate() {
            if required_u64(block, "blockIndex")? != block_index as u64 {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context blockIndex 必须连续并保持消息内顺序。",
                ));
            }
            match required_string(block, "kind")? {
                "text" => {
                    exact_object(block, &["blockIndex", "kind"], &[])?;
                    if role == "tool" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "tool message 只能投影 toolResult block。",
                        ));
                    }
                }
                "reasoning" => {
                    exact_object(block, &["blockIndex", "kind"], &[])?;
                    if role != "assistant" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "reasoning block 只能属于 assistant message。",
                        ));
                    }
                }
                "toolCall" => {
                    exact_object(block, &["blockIndex", "kind", "callId", "toolName"], &[])?;
                    if role != "assistant" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "toolCall block 只能属于 assistant message。",
                        ));
                    }
                    let call_id = required_string(block, "callId")?;
                    validate_id("callId", call_id)?;
                    if !call_ids.insert(call_id) {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "context tool callId 不能重复。",
                        ));
                    }
                    required_string(block, "toolName")?;
                }
                "toolResult" => {
                    exact_object(block, &["blockIndex", "kind", "resultForCallId"], &[])?;
                    if role != "tool" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "toolResult block 只能属于 tool message。",
                        ));
                    }
                    let result_for_call_id = required_string(block, "resultForCallId")?;
                    validate_id("resultForCallId", result_for_call_id)?;
                    if !call_ids.contains(result_for_call_id) {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "context toolResult 缺少此前同请求中的 toolCall。",
                        ));
                    }
                    result_count += 1;
                }
                "hostedWebSearch" => {
                    exact_object(block, &["blockIndex", "kind", "providerCallId"], &[])?;
                    if role != "assistant" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "hostedWebSearch block 只能属于 assistant message。",
                        ));
                    }
                    let call_id = required_string(block, "providerCallId")?;
                    validate_runtime_identity("providerHostedSearchCallId", call_id)?;
                    if !hosted_search_ids.insert(call_id) {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "context hosted search call id 不能重复。",
                        ));
                    }
                }
                _ => {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "context message block kind 无效。",
                    ))
                }
            }
        }
        if role == "tool" && (blocks.len() != 1 || result_count != 1) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "tool message 必须且只能包含一个 toolResult block。",
            ));
        }
        validate_context_items(
            message
                .get("filesystemReferences")
                .expect("validated filesystem references"),
            "filesystemReferences",
        )?;
        if role != "user"
            && message
                .get("filesystemReferences")
                .and_then(Value::as_array)
                .is_some_and(|references| !references.is_empty())
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context filesystemReferences 只能属于 user message。",
            ));
        }
    }
    Ok(())
}

fn validate_provider_turn_output_blocks(
    value: &Value,
    ordered_call_ids: &Value,
) -> Result<(), LocalAgentStoreError> {
    let blocks = value
        .as_array()
        .filter(|blocks| !blocks.is_empty())
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "provider.turn.settled orderedOutputBlocks 必须是非空数组。",
            )
        })?;
    let expected_call_ids = ordered_call_ids
        .as_array()
        .expect("validated orderedCallIds")
        .iter()
        .map(|value| value.as_str().expect("validated orderedCallId"))
        .collect::<Vec<_>>();
    let mut previous_output_index = None;
    let mut call_ids = Vec::new();
    let mut all_call_ids = std::collections::HashSet::new();
    let mut provider_call_ids = std::collections::HashSet::new();
    let mut projection_refs = std::collections::HashSet::new();
    let mut final_message_count = 0usize;
    for block in blocks {
        let output_index = block
            .get("outputIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider output block 缺少非负整数 outputIndex。",
                )
            })?;
        if previous_output_index.is_some_and(|previous| output_index <= previous) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "provider output blocks 没有按 outputIndex 递增。",
            ));
        }
        previous_output_index = Some(output_index);
        let kind = required_string(block, "kind")?;
        let item = block
            .get("item")
            .filter(|item| item.is_object())
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider output block 缺少原生 item。",
                )
            })?;
        match kind {
            "reasoning" => {
                exact_object(block, &["outputIndex", "kind", "item"], &[])?;
                if item.get("type").and_then(Value::as_str) != Some("reasoning") {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "reasoning block 与原生 item 类型不一致。",
                    ));
                }
            }
            "narrative" => {
                exact_object(block, &["outputIndex", "kind", "narrativeId", "item"], &[])?;
                let id = required_string(block, "narrativeId")?;
                validate_id("narrativeId", id)?;
                if item.get("type").and_then(Value::as_str) != Some("message")
                    || !projection_refs.insert(("narrative", id))
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "narrative block 无效或重复。",
                    ));
                }
            }
            "finalMessage" => {
                exact_object(block, &["outputIndex", "kind", "messageId", "item"], &[])?;
                let id = required_string(block, "messageId")?;
                validate_id("messageId", id)?;
                final_message_count += 1;
                if item.get("type").and_then(Value::as_str) != Some("message")
                    || !projection_refs.insert(("message", id))
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "finalMessage block 无效或重复。",
                    ));
                }
            }
            "toolCall" | "toolCallRejected" => {
                let mut fields = vec![
                    "outputIndex",
                    "kind",
                    "callId",
                    "providerCallId",
                    "toolName",
                    "item",
                ];
                if kind == "toolCallRejected" {
                    fields.push("error");
                    validate_input_rejection_error(&block["error"])?;
                }
                exact_object(block, &fields, &[])?;
                let call_id = required_string(block, "callId")?;
                let provider_call_id = required_string(block, "providerCallId")?;
                validate_id("callId", call_id)?;
                validate_runtime_identity("providerCallId", provider_call_id)?;
                required_string(block, "toolName")?;
                required_string(item, "name")?;
                if item.get("type").and_then(Value::as_str) != Some("function_call")
                    || item.get("call_id").and_then(Value::as_str) != Some(provider_call_id)
                    || !item.get("arguments").is_some_and(Value::is_string)
                    || !all_call_ids.insert(call_id)
                    || !provider_call_ids.insert(provider_call_id)
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "toolCall block 与原生 item 不一致。",
                    ));
                }
                if kind == "toolCall" {
                    call_ids.push(call_id);
                }
            }
            "providerHosted" => {
                exact_object(
                    block,
                    &[
                        "outputIndex",
                        "kind",
                        "activityId",
                        "providerCallId",
                        "providerToolType",
                        "item",
                    ],
                    &[],
                )?;
                let activity_id = required_string(block, "activityId")?;
                let provider_call_id = required_string(block, "providerCallId")?;
                validate_id("activityId", activity_id)?;
                validate_runtime_identity("providerCallId", provider_call_id)?;
                if required_string(block, "providerToolType")? != "web_search"
                    || item.get("id").and_then(Value::as_str) != Some(provider_call_id)
                    || !crate::llm_transport::valid_responses_hosted_search_item(item)
                    || !provider_call_ids.insert(provider_call_id)
                    || !projection_refs.insert(("activity", activity_id))
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "providerHosted block 与原生 item 不一致。",
                    ));
                }
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider output block kind 无效。",
                ));
            }
        }
    }
    let narratives = blocks
        .iter()
        .filter(|block| block.get("kind").and_then(Value::as_str) == Some("narrative"))
        .collect::<Vec<_>>();
    let commentary_only = !narratives.is_empty()
        && narratives.iter().all(|block| {
            block
                .get("item")
                .and_then(|item| item.get("phase"))
                .and_then(Value::as_str)
                == Some("commentary")
        });
    if call_ids != expected_call_ids
        || final_message_count > 1
        || all_call_ids.is_empty() && final_message_count != 1 && !commentary_only
        || !all_call_ids.is_empty() && final_message_count != 0
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "provider output blocks 与完成事实不一致。",
        ));
    }
    Ok(())
}

fn validate_context_items(value: &Value, field: &str) -> Result<(), LocalAgentStoreError> {
    let items = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            format!("context {field} 必须是数组。"),
        )
    })?;
    let mut item_ids = std::collections::HashSet::new();
    for item in items {
        exact_object(item, &["itemId", "label"], &[])?;
        let item_id = required_string(item, "itemId")?;
        validate_id("itemId", item_id)?;
        if !item_ids.insert(item_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                format!("context {field} itemId 不能重复。"),
            ));
        }
        required_string(item, "label")?;
    }
    Ok(())
}

fn validate_context_tools(value: &Value) -> Result<(), LocalAgentStoreError> {
    let tools = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "context tools 必须是数组。")
    })?;
    let mut canonical_names = std::collections::HashSet::new();
    let mut wire_names = std::collections::HashSet::new();
    for tool in tools {
        let has_plugin_uri = tool.get("pluginUri").is_some();
        exact_object(
            tool,
            &[
                "itemId",
                "label",
                "canonicalName",
                "wireName",
                "origin",
                "availability",
            ],
            if has_plugin_uri { &["pluginUri"] } else { &[] },
        )?;
        let item_id = required_string(tool, "itemId")?;
        let label = required_string(tool, "label")?;
        let canonical_name = required_string(tool, "canonicalName")?;
        let wire_name = required_string(tool, "wireName")?;
        validate_id("canonicalName", canonical_name)?;
        validate_id("wireName", wire_name)?;
        if item_id != canonical_name || label != wire_name {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context tool itemId/label 必须精确映射 canonicalName/wireName。",
            ));
        }
        if !canonical_names.insert(canonical_name) || !wire_names.insert(wire_name) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context tool canonicalName 和 wireName 不能重复。",
            ));
        }
        let origin = required_string(tool, "origin")?;
        if !matches!(
            origin,
            "coreBuiltin" | "extension" | "sessionControl" | "providerHosted"
        ) || required_string(tool, "availability")? != "callable"
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context tool origin 或 availability 无效。",
            ));
        }
        if origin == "providerHosted"
            && (canonical_name != "web.search" || wire_name != "web_search" || has_plugin_uri)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Provider hosted context tool 必须是 web_search。",
            ));
        } else if origin == "extension" {
            let plugin_uri = required_string(tool, "pluginUri")?;
            if !plugin_uri.starts_with("plugin://")
                || plugin_uri.split('@').count() != 2
                || plugin_uri.chars().any(char::is_whitespace)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "extension context tool 缺少合法 pluginUri。",
                ));
            }
        } else if has_plugin_uri {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "core/session control context tool 不能携带 pluginUri。",
            ));
        }
    }
    Ok(())
}

fn validate_context_partitions(value: &Value) -> Result<(), LocalAgentStoreError> {
    const ORDER: [&str; 7] = [
        "instructions",
        "sessionControls",
        "tools",
        "workspaceBindings",
        "contextProviders",
        "journalMessages",
        "filesystemReferences",
    ];
    let partitions = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "context partitions 必须是数组。")
    })?;
    if partitions.len() != ORDER.len() {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "context partitions 必须包含七个固定顺序分区。",
        ));
    }
    let mut total_shape_units = 0_u64;
    for (index, partition) in partitions.iter().enumerate() {
        exact_object(partition, &["kind", "itemCount", "requestShapeUnits"], &[])?;
        if required_string(partition, "kind")? != ORDER[index] {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context partitions 顺序或 kind 无效。",
            ));
        }
        required_u64(partition, "itemCount")?;
        total_shape_units = total_shape_units
            .checked_add(required_u64(partition, "requestShapeUnits")?)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context partition requestShapeUnits 溢出。",
                )
            })?;
    }
    if total_shape_units == 0 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "context partition requestShapeUnits 不能全部为零。",
        ));
    }
    Ok(())
}

fn validate_reply(reply: &Value) -> Result<(), LocalAgentStoreError> {
    if reply.get("schemaVersion").and_then(Value::as_str) != Some(REPLY_VERSION) {
        return Err(LocalAgentStoreError::new(
            "session_reply_version_invalid",
            "只接受 deepcode.command-reply.v3。",
        ));
    }
    let status = required_string(reply, "status")?;
    if !["accepted", "rejected"].contains(&status) {
        return Err(LocalAgentStoreError::new(
            "session_reply_status_invalid",
            "持久化回复必须是 accepted 或 rejected。",
        ));
    }
    Ok(())
}

fn validate_agent_capabilities(value: &Value) -> Result<(), LocalAgentStoreError> {
    let fields = ["messaging", "continuation", "delegation"];
    exact_object(value, &fields, &[])?;
    if fields.iter().any(|field| {
        !value[*field].is_boolean() && !(*field == "messaging" && value[*field] == "parent")
    }) {
        return Err(LocalAgentStoreError::new(
            "agent_capabilities_invalid",
            "continuation/delegation 必须是布尔值，messaging 可以是布尔值或 parent。",
        ));
    }
    Ok(())
}

pub(crate) fn validate_agent_context(
    value: &Value,
    session_id: &str,
) -> Result<(), LocalAgentStoreError> {
    exact_object(
        value,
        &[
            "capabilities",
            "ownerSessionId",
            "parentSessionId",
            "parentRunId",
            "parentCallId",
        ],
        &["configuration", "model"],
    )?;
    if let Some(model) = value.get("model") {
        exact_object(
            model,
            &[
                "profileId",
                "model",
                "reasoningEffort",
                "thinking",
                "parameters",
            ],
            &[],
        )?;
        validate_id("profileId", required_string(model, "profileId")?)?;
        required_string(model, "model")?;
        crate::local_agent_provider_runtime::validate_instance_parameters(&model["parameters"])
            .map_err(|cause| {
                LocalAgentStoreError::new("agent_model_configuration_invalid", cause)
            })?;
        if !model["reasoningEffort"].is_null()
            && !matches!(
                model["reasoningEffort"].as_str(),
                Some("low" | "medium" | "high" | "xhigh" | "max")
            )
            || !model["thinking"].is_null()
                && !matches!(model["thinking"].as_str(), Some("enabled" | "disabled"))
        {
            return Err(LocalAgentStoreError::new(
                "agent_model_configuration_invalid",
                "子代理模型配置无效。",
            ));
        }
    }
    if let Some(configuration) = value.get("configuration") {
        exact_object(configuration, &["context", "compaction", "controls"], &[])?;
        for kind in ["context", "compaction", "controls"] {
            let selection = &configuration[kind];
            exact_object(selection, &["id"], &["parameters"])?;
            validate_id("contributionId", required_string(selection, "id")?)?;
            if selection
                .get("parameters")
                .is_some_and(|parameters| !parameters.is_object())
            {
                return Err(LocalAgentStoreError::new(
                    "agent_configuration_invalid",
                    "贡献参数必须是对象。",
                ));
            }
        }
    }
    validate_agent_capabilities(&value["capabilities"])?;
    for field in [
        "ownerSessionId",
        "parentSessionId",
        "parentRunId",
        "parentCallId",
    ] {
        validate_id(field, required_string(value, field)?)?;
    }
    if value["ownerSessionId"] == session_id || value["parentSessionId"] == session_id {
        return Err(LocalAgentStoreError::new(
            "agent_context_invalid",
            "子会话不能以自身作为 owner 或 parent。",
        ));
    }
    Ok(())
}

fn validate_workspace_bindings(value: &Value) -> Result<Vec<Value>, LocalAgentStoreError> {
    let values = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_binding_invalid", "workspaceBindings 必须是数组。")
    })?;
    let mut seen = std::collections::HashSet::new();
    let mut bindings = Vec::with_capacity(values.len());
    for value in values {
        let object = exact_object(value, &["workspaceId", "displayName"], &[])?;
        let workspace_id = required_string(value, "workspaceId")?;
        validate_id("workspaceId", workspace_id)?;
        validate_display_title(required_string(value, "displayName")?)?;
        if !seen.insert(workspace_id) {
            return Err(LocalAgentStoreError::new(
                "session_binding_duplicate",
                "workspaceBindings 不能重复。",
            ));
        }
        bindings.push(Value::Object(object.clone()));
    }
    Ok(bindings)
}

fn validate_filesystem_references(
    value: &Value,
    error_code: &'static str,
) -> Result<(), LocalAgentStoreError> {
    let references = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new(error_code, "filesystemReferences 必须是数组。")
    })?;
    if references.len() > 8 {
        return Err(LocalAgentStoreError::new(
            error_code,
            "单条消息最多包含八个文件系统引用。",
        ));
    }
    let mut reference_ids = std::collections::HashSet::new();
    let mut targets = std::collections::HashSet::new();
    for reference in references {
        let kind = required_string(reference, "kind")?;
        let required = [
            "referenceId",
            "workspaceId",
            "logicalPath",
            "displayName",
            "kind",
        ];
        match kind {
            "file" => {
                exact_object(reference, &required, &["mediaType", "byteLength", "source"])?;
                if reference
                    .get("source")
                    .is_some_and(|source| source != "pastedText")
                {
                    return Err(LocalAgentStoreError::new(
                        error_code,
                        "文件引用 source 无效。",
                    ));
                }
                let media_type = required_string(reference, "mediaType")?;
                if !valid_media_type(media_type) {
                    return Err(LocalAgentStoreError::new(
                        error_code,
                        "文件引用 mediaType 无效。",
                    ));
                }
                required_u64(reference, "byteLength")?;
            }
            "directory" => {
                exact_object(reference, &required, &[])?;
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    error_code,
                    "文件系统引用 kind 无效。",
                ))
            }
        }
        let reference_id = required_string(reference, "referenceId")?;
        let workspace_id = required_string(reference, "workspaceId")?;
        let logical_path = required_string(reference, "logicalPath")?;
        validate_id("referenceId", reference_id)?;
        validate_id("workspaceId", workspace_id)?;
        validate_display_title(required_string(reference, "displayName")?)?;
        if !valid_logical_path(logical_path)
            || (kind == "directory" && logical_path != ".")
            || (kind == "file" && logical_path == ".")
        {
            return Err(LocalAgentStoreError::new(
                error_code,
                "文件系统引用 logicalPath 无效。",
            ));
        }
        if !reference_ids.insert(reference_id) || !targets.insert((workspace_id, logical_path)) {
            return Err(LocalAgentStoreError::new(
                error_code,
                "文件系统引用 identity 或 target 不能重复。",
            ));
        }
    }
    Ok(())
}

fn valid_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.contains('\\') {
        return false;
    }
    value == "."
        || !value.starts_with('/')
            && !value.ends_with('/')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

fn valid_media_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && value.len() <= 128
        && kind.chars().chain(subtype.chars()).all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                )
        })
}

fn validate_plugin_selections(
    revision: Option<&Value>,
    selections: Option<&Value>,
) -> Result<(), LocalAgentStoreError> {
    let Some(selections) = selections else {
        if let Some(revision) = revision {
            validate_id(
                "pluginCatalogRevision",
                revision.as_str().ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "plugin_selection_invalid",
                        "pluginCatalogRevision 必须是字符串。",
                    )
                })?,
            )?;
        }
        return Ok(());
    };
    let selections = selections.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("plugin_selection_invalid", "pluginSelections 必须是数组。")
    })?;
    if !selections.is_empty() {
        validate_id(
            "pluginCatalogRevision",
            revision.and_then(Value::as_str).ok_or_else(|| {
                LocalAgentStoreError::new(
                    "plugin_selection_invalid",
                    "非空 pluginSelections 必须包含 pluginCatalogRevision。",
                )
            })?,
        )?;
    }
    validate_plugin_selection_list(&Value::Array(selections.clone()))
}

fn validate_plugin_selection_list(selections: &Value) -> Result<(), LocalAgentStoreError> {
    let selections = selections.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("plugin_selection_invalid", "pluginSelections 必须是数组。")
    })?;
    let mut selection_ids = std::collections::HashSet::new();
    let mut uris = std::collections::HashSet::new();
    for selection in selections {
        exact_object(selection, &["selectionId", "uri", "label"], &[])?;
        let selection_id = required_string(selection, "selectionId")?;
        validate_id("selectionId", selection_id)?;
        let uri = required_string(selection, "uri")?;
        if !valid_plugin_uri(uri) {
            return Err(LocalAgentStoreError::new(
                "plugin_selection_invalid",
                "Plugin URI 必须是 source-qualified plugin://name@source。",
            ));
        }
        let label = required_string(selection, "label")?;
        validate_display_title(label)?;
        if !selection_ids.insert(selection_id) || !uris.insert(uri) {
            return Err(LocalAgentStoreError::new(
                "plugin_selection_invalid",
                "pluginSelections 的 selectionId 和 uri 不能重复。",
            ));
        }
    }
    Ok(())
}

fn valid_plugin_uri(value: &str) -> bool {
    let Some(identity) = value.strip_prefix("plugin://") else {
        return false;
    };
    let Some((name, source)) = identity.split_once('@') else {
        return false;
    };
    !name.is_empty()
        && !source.is_empty()
        && !name.contains('@')
        && name.chars().chain(source.chars()).all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

fn run_provider_runtime_from_connection(
    connection: &Connection,
    session_id: &str,
    run_id: &str,
    purpose: &str,
) -> Result<RunProviderRuntime, LocalAgentStoreError> {
    let mut statement = connection
        .prepare(
            "SELECT payload_json FROM session_events
             WHERE session_id=?1 AND run_id=?2 AND event_type='run.started'
             ORDER BY sequence ASC",
        )
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?;
    let mut rows = statement
        .query(params![session_id, run_id])
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?;
    let encoded = rows
        .next()
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_run_runtime_snapshot_missing",
                "run.started 缺少冻结的 Provider runtime snapshot。",
            )
        })?
        .get::<_, String>(0)
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?;
    if rows
        .next()
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?
        .is_some()
    {
        return Err(LocalAgentStoreError::new(
            "session_run_runtime_snapshot_ambiguous",
            "同一 run 存在多个 run.started runtime snapshot。",
        ));
    }
    let payload = decode_json(&encoded, "session_run_runtime_snapshot_corrupt")?;
    let runtime_snapshot = payload.get("runtimeSnapshot").ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_run_runtime_snapshot_corrupt",
            "run.started 缺少 runtimeSnapshot。",
        )
    })?;
    let provider = validate_run_runtime_snapshot(runtime_snapshot)?;
    if purpose == "approvalReview" {
        if let Some(error) = runtime_snapshot.get("approvalReviewerError") {
            return Err(LocalAgentStoreError::new(
                "approval_reviewer_prepare_failed",
                required_string(error, "message")?,
            ));
        }
        if let Some(reviewer) = runtime_snapshot.get("approvalReviewer") {
            return validate_provider_runtime_snapshot(reviewer);
        }
    }
    Ok(provider)
}

fn validate_run_runtime_snapshot(
    value: &Value,
) -> Result<RunProviderRuntime, LocalAgentStoreError> {
    exact_object(
        value,
        &[
            "runRuntimeSnapshotRef",
            "extensionGenerationRef",
            "kernelCatalogSnapshotRef",
            "provider",
            "webSearch",
            "instructions",
            "tools",
            "toolPromptContributions",
            "providerToolAliases",
            "selectedPlugins",
            "environment",
            "permissions",
            "agentCapabilities",
            "contextManagement",
        ],
        &[
            "approvalReviewer",
            "approvalReviewerError",
            "agentToolsEnabled",
        ],
    )?;
    validate_agent_capabilities(&value["agentCapabilities"])?;
    let context = &value["contextManagement"];
    exact_object(context, &["enabled", "thresholdTokens"], &[])?;
    if !context["enabled"].is_boolean()
        || context["thresholdTokens"]
            .as_u64()
            .is_none_or(|n| n == 0 || n > 9_007_199_254_740_991)
    {
        return Err(LocalAgentStoreError::new(
            "context_management_settings_invalid",
            "Context management requires a boolean switch and a positive integer threshold.",
        ));
    }
    if value
        .get("agentToolsEnabled")
        .is_some_and(|enabled| !enabled.is_boolean())
    {
        return Err(LocalAgentStoreError::new(
            "run_agent_tools_invalid",
            "Agent runtime 工具开关必须是布尔值。",
        ));
    }
    validate_permission_patches(&value["permissions"])?;
    let run_runtime_snapshot_ref = required_string(value, "runRuntimeSnapshotRef")?;
    let extension_generation_ref = required_string(value, "extensionGenerationRef")?;
    let kernel_catalog_snapshot_ref = required_string(value, "kernelCatalogSnapshotRef")?;
    for (field, identity) in [
        ("runRuntimeSnapshotRef", run_runtime_snapshot_ref),
        ("extensionGenerationRef", extension_generation_ref),
        ("kernelCatalogSnapshotRef", kernel_catalog_snapshot_ref),
    ] {
        validate_runtime_identity(field, identity)?;
    }
    if run_runtime_snapshot_ref == extension_generation_ref
        || run_runtime_snapshot_ref == kernel_catalog_snapshot_ref
        || extension_generation_ref == kernel_catalog_snapshot_ref
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Run runtime、Extension generation 与 Kernel catalog snapshot 身份必须分离。",
        ));
    }

    let mut runtime = validate_provider_runtime_snapshot(&value["provider"])?;
    if let Some(error) = value.get("approvalReviewerError") {
        validate_local_agent_error(error)?;
        if value.get("approvalReviewer").is_some() {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "审批模型绑定与准备失败不能同时存在。",
            ));
        }
    }
    if let Some(reviewer) = value.get("approvalReviewer") {
        let reviewer = validate_provider_runtime_snapshot(reviewer)?;
        if reviewer.provider_runtime_ref == runtime.provider_runtime_ref
            || reviewer.hosted_web_search != "none"
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "审批模型必须使用独立且不含 hosted tools 的 Provider runtime。",
            ));
        }
    }

    let instructions = value
        .get("instructions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot instructions 必须是数组。",
            )
        })?;
    let mut instruction_ids = std::collections::HashSet::with_capacity(instructions.len());
    for instruction in instructions {
        exact_object(instruction, &["id", "text"], &[])?;
        let instruction_id = required_string(instruction, "id")?;
        validate_runtime_identity("instructionId", instruction_id)?;
        if !instruction_ids.insert(instruction_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot instruction id 不能重复。",
            ));
        }
        let text = required_string(instruction, "text")?;
        if text.contains('\0') {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot instruction text 包含无效字符。",
            ));
        }
    }

    let tools = value
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tools 必须是数组。",
            )
        })?;
    let mut tool_names = std::collections::HashSet::with_capacity(tools.len());
    let mut binding_refs = std::collections::HashSet::with_capacity(tools.len());
    let mut callable_tool_names = std::collections::HashSet::with_capacity(tools.len());
    let mut tool_prompt_targets = std::collections::HashMap::with_capacity(tools.len());
    for tool in tools {
        let has_plugin_uri = tool.get("pluginUri").is_some();
        exact_object(
            tool,
            &[
                "name",
                "description",
                "inputSchema",
                "possibleEffects",
                "availability",
                "toolBindingRef",
                "origin",
            ],
            &["pluginUri", "availabilityReason", "runtimeStatus"],
        )?;
        let name = required_string(tool, "name")?;
        let binding_ref = required_string(tool, "toolBindingRef")?;
        validate_runtime_identity("toolName", name)?;
        validate_runtime_identity("toolBindingRef", binding_ref)?;
        if !tool_names.insert(name) || !binding_refs.insert(binding_ref) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool name 与 toolBindingRef 必须分别唯一。",
            ));
        }
        let description = required_string(tool, "description")?;
        if description.trim().is_empty() || description.contains('\0') {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool description 无效。",
            ));
        }
        if !tool.get("inputSchema").is_some_and(Value::is_object) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool inputSchema 必须是对象。",
            ));
        }
        let effects = tool
            .get("possibleEffects")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool possibleEffects 必须是数组。",
                )
            })?;
        let mut seen_effects = std::collections::HashSet::with_capacity(effects.len());
        for effect in effects {
            let effect = effect.as_str().ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool possibleEffects 包含无效值。",
                )
            })?;
            if !matches!(
                effect,
                "localRead"
                    | "workspaceRead"
                    | "workspaceMutation"
                    | "process"
                    | "network"
                    | "external"
            ) || !seen_effects.insert(effect)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool possibleEffects 无效或重复。",
                ));
            }
        }
        let availability = required_string(tool, "availability")?;
        if let Some(reason) = tool.get("availabilityReason") {
            exact_object(reason, &["code", "message"], &[])?;
            required_string(reason, "code")?;
            required_string(reason, "message")?;
            if availability != "blocked" {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Only blocked tools carry an unavailability reason.",
                ));
            }
        }
        if tool
            .get("runtimeStatus")
            .is_some_and(|status| !status.is_object())
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Tool runtimeStatus must be an object.",
            ));
        }

        if !matches!(availability, "callable" | "blocked") {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool availability 无效。",
            ));
        }
        if availability == "callable" {
            callable_tool_names.insert(name);
        }
        let origin = required_string(tool, "origin")?;
        if !matches!(origin, "coreBuiltin" | "extension") {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool origin 无效。",
            ));
        }
        let plugin_uri = if origin == "extension" {
            let plugin_uri = required_string(tool, "pluginUri")?;
            if !plugin_uri.starts_with("plugin://")
                || plugin_uri.split('@').count() != 2
                || plugin_uri.chars().any(char::is_whitespace)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "extension runtimeSnapshot tool 缺少合法 pluginUri。",
                ));
            }
            Some(plugin_uri.to_string())
        } else if has_plugin_uri {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "core runtimeSnapshot tool 不能携带 pluginUri。",
            ));
        } else {
            None
        };
        tool_prompt_targets.insert(
            name.to_string(),
            (
                binding_ref.to_string(),
                availability.to_string(),
                origin.to_string(),
                plugin_uri,
            ),
        );
    }

    let tool_prompt_contributions = value
        .get("toolPromptContributions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot toolPromptContributions 必须是数组。",
            )
        })?;
    let mut prompt_contribution_refs =
        std::collections::HashSet::with_capacity(tool_prompt_contributions.len());
    let mut prompt_tool_names =
        std::collections::HashSet::with_capacity(tool_prompt_contributions.len());
    let mut prompt_binding_refs =
        std::collections::HashSet::with_capacity(tool_prompt_contributions.len());
    let mut prompt_plugin_uris = std::collections::HashSet::new();
    for contribution in tool_prompt_contributions {
        let has_plugin_uri = contribution.get("pluginUri").is_some();
        let has_prompt_snippet = contribution.get("promptSnippet").is_some();
        let mut optional = Vec::new();
        if has_plugin_uri {
            optional.push("pluginUri");
        }
        if has_prompt_snippet {
            optional.push("promptSnippet");
        }
        exact_object(
            contribution,
            &[
                "contributionRef",
                "preparedToolBindingRef",
                "canonicalToolName",
                "origin",
                "usageGuidelines",
            ],
            &optional,
        )?;
        let contribution_ref = required_string(contribution, "contributionRef")?;
        let prepared_binding_ref = required_string(contribution, "preparedToolBindingRef")?;
        let canonical_tool_name = required_string(contribution, "canonicalToolName")?;
        validate_runtime_identity("toolPromptContributionRef", contribution_ref)?;
        validate_runtime_identity("preparedToolBindingRef", prepared_binding_ref)?;
        validate_runtime_identity("toolPromptCanonicalName", canonical_tool_name)?;
        if !prompt_contribution_refs.insert(contribution_ref)
            || !prompt_tool_names.insert(canonical_tool_name)
            || !prompt_binding_refs.insert(prepared_binding_ref)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt contribution、tool 与 binding 必须分别唯一。",
            ));
        }
        let (tool_binding_ref, availability, tool_origin, tool_plugin_uri) = tool_prompt_targets
            .get(canonical_tool_name)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool prompt contribution 指向不存在的工具。",
                )
            })?;
        if availability != "callable" || tool_binding_ref != prepared_binding_ref {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt contribution 未绑定 callable prepared tool。",
            ));
        }
        let origin = required_string(contribution, "origin")?;
        if origin != tool_origin {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt contribution origin 与工具不一致。",
            ));
        }
        match origin {
            "coreBuiltin" if !has_plugin_uri && tool_plugin_uri.is_none() => {}
            "extension" => {
                let plugin_uri = required_string(contribution, "pluginUri")?;
                if tool_plugin_uri.as_deref() != Some(plugin_uri) {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "runtimeSnapshot tool prompt contribution pluginUri 与工具不一致。",
                    ));
                }
                prompt_plugin_uris.insert(plugin_uri.to_string());
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool prompt contribution origin 或 pluginUri 无效。",
                ))
            }
        }
        let prompt_snippet = contribution.get("promptSnippet").and_then(Value::as_str);
        if has_prompt_snippet
            && prompt_snippet.is_none_or(|text| !valid_tool_prompt_line(text, 512))
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt snippet 无效。",
            ));
        }
        let usage_guidelines = contribution
            .get("usageGuidelines")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool prompt usageGuidelines 必须是数组。",
                )
            })?;
        if usage_guidelines.len() > 8
            || usage_guidelines.iter().any(|guideline| {
                guideline
                    .as_str()
                    .is_none_or(|text| !valid_tool_prompt_line(text, 1_024))
            })
            || prompt_snippet.is_none() && usage_guidelines.is_empty()
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt guidelines 无效。",
            ));
        }
    }

    let aliases = value
        .get("providerToolAliases")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot providerToolAliases 必须是数组。",
            )
        })?;
    let mut alias_canonical_names = std::collections::HashSet::with_capacity(aliases.len());
    let mut alias_wire_names = std::collections::HashSet::with_capacity(aliases.len());
    for alias in aliases {
        exact_object(alias, &["canonicalName", "wireName"], &[])?;
        let canonical_name = required_string(alias, "canonicalName")?;
        let wire_name = required_string(alias, "wireName")?;
        if canonical_name.len() > 128
            || !canonical_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
            || wire_name.len() > 64
            || !wire_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
            || !alias_canonical_names.insert(canonical_name)
            || !alias_wire_names.insert(wire_name)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot providerToolAliases 包含无效或重复映射。",
            ));
        }
    }
    if callable_tool_names
        .iter()
        .any(|name| !alias_canonical_names.contains(*name))
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot providerToolAliases 缺少 callable 工具。",
        ));
    }

    let web_search = value.get("webSearch").ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot 缺少 webSearch binding。",
        )
    })?;
    let web_search_owner = required_string(web_search, "owner")?;
    let kernel_search_callable = callable_tool_names.contains("web.search");
    match web_search_owner {
        "providerHosted" => {
            exact_object(web_search, &["owner", "providerToolType"], &[])?;
            if required_string(web_search, "providerToolType")? != "web_search"
                || runtime.api_surface != "responses"
                || runtime.hosted_web_search != "web_search"
                || kernel_search_callable
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Provider hosted search binding 与 runtime capability 不一致。",
                ));
            }
        }
        "kernelAdapter" => {
            exact_object(web_search, &["owner", "toolName"], &[])?;
            if required_string(web_search, "toolName")? != "web.search" || !kernel_search_callable {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Kernel search adapter binding 缺少 callable web.search。",
                ));
            }
        }
        "unavailable" => {
            exact_object(web_search, &["owner"], &[])?;
            if kernel_search_callable {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Unavailable search binding 不能同时暴露 callable web.search。",
                ));
            }
        }
        _ => {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot webSearch owner 无效。",
            ));
        }
    }

    let selected_plugins = value.get("selectedPlugins").ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot 缺少 selectedPlugins。",
        )
    })?;
    exact_object(selected_plugins, &["catalogRevision", "plugins"], &[])?;
    validate_runtime_identity(
        "pluginCatalogRevision",
        required_string(selected_plugins, "catalogRevision")?,
    )?;
    let plugins = selected_plugins
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot selectedPlugins.plugins 必须是数组。",
            )
        })?;
    let mut plugin_uris = std::collections::HashSet::with_capacity(plugins.len());
    let mut plugin_instance_refs = std::collections::HashSet::with_capacity(plugins.len());
    for plugin in plugins {
        exact_object(
            plugin,
            &[
                "uri",
                "pluginArtifactRef",
                "pluginInstanceRef",
                "extensionGenerationRef",
                "capabilityRefs",
            ],
            &[],
        )?;
        let uri = required_string(plugin, "uri")?;
        if !uri.starts_with("plugin://")
            || uri.trim() != uri
            || uri.chars().any(char::is_whitespace)
            || !plugin_uris.insert(uri)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot selected plugin URI 无效或重复。",
            ));
        }
        for field in ["pluginArtifactRef", "pluginInstanceRef"] {
            validate_runtime_identity(field, required_string(plugin, field)?)?;
        }
        if !plugin_instance_refs.insert(required_string(plugin, "pluginInstanceRef")?) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot pluginInstanceRef 不能重复。",
            ));
        }
        if required_string(plugin, "extensionGenerationRef")? != extension_generation_ref {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot selected plugin generation 与 run 不一致。",
            ));
        }
        validate_unique_ids(plugin, "capabilityRefs")?;
    }
    if prompt_plugin_uris
        .iter()
        .any(|plugin_uri| !plugin_uris.contains(plugin_uri.as_str()))
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot extension tool prompt contribution 未绑定 selected plugin。",
        ));
    }

    runtime.web_search_owner = web_search_owner.to_string();
    Ok(runtime)
}

fn validate_provider_runtime_snapshot(
    provider: &Value,
) -> Result<RunProviderRuntime, LocalAgentStoreError> {
    exact_object(
        provider,
        &[
            "providerRuntimeRef",
            "profileId",
            "contextWindowTokens",
            "maxOutputTokens",
            "apiSurface",
            "hostedWebSearch",
        ],
        &["reasoningEffort", "reasoningEffortOverride", "thinking"],
    )?;
    let provider_runtime_ref = required_string(provider, "providerRuntimeRef")?;
    let profile_id = required_string(provider, "profileId")?;
    validate_runtime_identity("providerRuntimeRef", provider_runtime_ref)?;
    validate_runtime_identity("profileId", profile_id)?;
    let context_window_tokens = required_u64(provider, "contextWindowTokens")?;
    let max_output_tokens = required_u64(provider, "maxOutputTokens")?;
    let api_surface = required_string(provider, "apiSurface")?;
    let hosted_web_search = required_string(provider, "hostedWebSearch")?;
    for field in ["reasoningEffort", "reasoningEffortOverride"] {
        if let Some(effort) = provider.get(field) {
            if effort.is_null() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "冻结的推理强度不能为 null。",
                ));
            }
            validate_reasoning_override(effort)?;
        }
    }
    if let Some(thinking) = provider.get("thinking") {
        if !matches!(thinking.as_str(), Some("enabled" | "disabled")) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "冻结的推理模式无效。",
            ));
        }
    }
    if provider.get("reasoningEffortOverride").is_some()
        && (provider["reasoningEffortOverride"] != provider["reasoningEffort"]
            || provider["thinking"] == "disabled")
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "推理强度覆盖与冻结的 Provider 配置不一致。",
        ));
    }
    if !matches!(
        api_surface,
        "chatCompletions" | "responses" | "anthropicMessages" | "ollamaChat"
    ) || !matches!(hosted_web_search, "none" | "web_search")
        || hosted_web_search == "web_search" && api_surface != "responses"
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot Provider API surface 或 hosted search capability 无效。",
        ));
    }
    let max_output_tokens = u32::try_from(max_output_tokens).map_err(|_| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot maxOutputTokens 超出 Provider 预算范围。",
        )
    })?;
    if context_window_tokens == 0
        || max_output_tokens == 0
        || u64::from(max_output_tokens) >= context_window_tokens
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot 要求正数预算且 maxOutputTokens 小于 contextWindowTokens。",
        ));
    }

    Ok(RunProviderRuntime {
        reasoning_effort_override: provider
            .get("reasoningEffortOverride")
            .and_then(Value::as_str)
            .map(str::to_string),
        provider_runtime_ref: provider_runtime_ref.to_string(),
        profile_id: profile_id.to_string(),
        context_window_tokens,
        max_output_tokens,
        api_surface: api_surface.to_string(),
        hosted_web_search: hosted_web_search.to_string(),
        web_search_owner: "unavailable".to_string(),
    })
}

fn validate_runtime_identity(field: &str, value: &str) -> Result<(), LocalAgentStoreError> {
    validate_id(field, value)?;
    if value.trim() != value {
        return Err(LocalAgentStoreError::new(
            "local_agent_identity_invalid",
            format!("{field} 不是 canonical 标识。"),
        ));
    }
    Ok(())
}

fn valid_tool_prompt_line(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max_length
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn validate_local_agent_error(value: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(value, &["code", "message"], &["diagnostics"])?;
    if value
        .get("diagnostics")
        .is_some_and(|value| !crate::provider_transport::valid_diagnostics(value))
    {
        return Err(LocalAgentStoreError::new(
            "error_diagnostics_invalid",
            "错误诊断字段无效。",
        ));
    }
    let code = required_string(value, "code")?;
    let message = required_string(value, "message")?;
    if code.trim() != code || message.trim().is_empty() || message.contains('\0') {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "LocalAgentError code 或 message 无效。",
        ));
    }
    Ok(())
}

fn validate_input_rejection_error(error: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(error, &["code", "message", "issues"], &[])?;
    required_string(error, "code")?;
    required_string(error, "message")?;
    let issues = error["issues"]
        .as_array()
        .filter(|issues| !issues.is_empty())
        .ok_or_else(|| {
            LocalAgentStoreError::new("tool_rejection_invalid", "工具参数拒绝必须包含字段诊断。")
        })?;
    for issue in issues {
        exact_object(issue, &["path", "rule", "message"], &["expected"])?;
        for field in ["path", "rule", "message"] {
            required_string(issue, field)?;
        }
    }
    Ok(())
}

fn validate_run_settlement(value: &Value) -> Result<(), LocalAgentStoreError> {
    match required_string(value, "outcome")? {
        "completed" => {
            exact_object(value, &["outcome", "finalMessageId"], &[])?;
            validate_id("finalMessageId", required_string(value, "finalMessageId")?)?;
        }
        "failed" | "indeterminate" => {
            exact_object(value, &["outcome", "error"], &[])?;
            validate_local_agent_error(value.get("error").expect("validated error"))?;
        }
        "cancelled" => {
            exact_object(value, &["outcome"], &[])?;
        }
        _ => {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Run settlement outcome 无效。",
            ))
        }
    }
    Ok(())
}

fn validate_unique_ids(value: &Value, field: &str) -> Result<(), LocalAgentStoreError> {
    let values = value.get(field).and_then(Value::as_array).ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", format!("{field} 必须是数组。"))
    })?;
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    for candidate in values {
        let identity = candidate.as_str().ok_or_else(|| {
            LocalAgentStoreError::new("session_event_invalid", format!("{field} 必须只包含标识。"))
        })?;
        validate_runtime_identity(field, identity)?;
        if !seen.insert(identity) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                format!("{field} 不能重复。"),
            ));
        }
    }
    Ok(())
}

fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, LocalAgentStoreError> {
    let object = value.as_object().ok_or_else(|| {
        LocalAgentStoreError::new("local_agent_message_invalid", "消息必须是 JSON 对象。")
    })?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(LocalAgentStoreError::new(
            "local_agent_message_shape_invalid",
            "消息包含缺失或未声明字段。",
        ));
    }
    Ok(object)
}

fn strip_null_object_fields(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
        if let Some(payload) = object.get_mut("payload").and_then(Value::as_object_mut) {
            payload.retain(|_, value| !value.is_null());
        }
    }
    value
}

// Event kinds belong to validate_new_event, not a database-version gate. Older
// stores embedded an enum CHECK; expand only that constraint in one transaction.
// Keep the stored DDL, rowids, payload bytes, indexes and triggers unchanged otherwise.
fn verify_session_store(connection: &Connection) -> Result<(), LocalAgentStoreError> {
    // Probe the fields actually consumed by the journal. Neither SQL formatting,
    // additional columns nor a historical user_version imply incompatibility.
    for (table, columns) in [
        (
            "sessions",
            "session_id,display_title,initial_profile_id,created_at",
        ),
        (
            "session_workspace_bindings",
            "session_id,position,workspace_id,display_name",
        ),
        (
            "session_events",
            "session_id,sequence,event_id,event_type,run_id,call_id,payload_json,occurred_at",
        ),
        (
            "session_commands",
            "session_id,command_id,command_json,reply_json,committed_revision,committed_at",
        ),
    ] {
        connection
            .prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))
            .map_err(|error| {
                LocalAgentStoreError::new(
                    "session_store_schema_incomplete",
                    format!("Session Store 无法读取 {table} 的必需字段：{error}"),
                )
            })?;
    }
    Ok(())
}

fn sqlite_is_empty(connection: &Connection) -> Result<bool, LocalAgentStoreError> {
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error("session_store_empty_check_failed"))
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, LocalAgentStoreError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "local_agent_message_invalid",
                format!("{field} 必须是非空字符串。"),
            )
        })
}

fn required_u64(value: &Value, field: &str) -> Result<u64, LocalAgentStoreError> {
    value.get(field).and_then(Value::as_u64).ok_or_else(|| {
        LocalAgentStoreError::new(
            "local_agent_message_invalid",
            format!("{field} 必须是非负整数。"),
        )
    })
}

fn validate_display_title(value: &str) -> Result<(), LocalAgentStoreError> {
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err(LocalAgentStoreError::new(
            "local_agent_display_invalid",
            "显示名称必须是 1 到 120 个可显示字符。",
        ));
    }
    Ok(())
}

fn validate_id(field: &str, value: &str) -> Result<(), LocalAgentStoreError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(LocalAgentStoreError::new(
            "local_agent_identity_invalid",
            format!("{field} 不是有效标识。"),
        ));
    }
    Ok(())
}

fn random_id(prefix: &str) -> Result<String, LocalAgentStoreError> {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| {
        LocalAgentStoreError::new("local_agent_entropy_failed", "无法生成本地事件标识。")
    })?;
    let mut value = String::with_capacity(prefix.len() + 1 + entropy.len() * 2);
    value.push_str(prefix);
    value.push(':');
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

fn encode_json(value: &Value, code: &'static str) -> Result<String, LocalAgentStoreError> {
    serde_json::to_string(value)
        .map_err(|error| LocalAgentStoreError::new(code, format!("JSON 编码失败：{error}")))
}

fn decode_json(encoded: &str, code: &'static str) -> Result<Value, LocalAgentStoreError> {
    serde_json::from_str(encoded)
        .map_err(|error| LocalAgentStoreError::new(code, format!("JSON 解码失败：{error}")))
}

fn sql_open_error(error: rusqlite::Error) -> LocalAgentStoreError {
    LocalAgentStoreError::new(
        "session_store_open_failed",
        format!("打开 Session Store 失败：{error}"),
    )
}

fn sql_error(code: &'static str) -> impl FnOnce(rusqlite::Error) -> LocalAgentStoreError {
    move |error| LocalAgentStoreError::new(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Store(std::path::PathBuf);
    impl Store {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(random_id("deepcode-store-test").unwrap().replace(':', "-"));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn path(&self) -> std::path::PathBuf {
            self.0.join("session.sqlite3")
        }
    }
    impl Drop for Store {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn runtime_snapshot() -> Value {
        json!({
            "agentCapabilities": {"messaging":true,"continuation":true,"delegation":true},
            "permissions": crate::settings_api::permission_settings(&json!({})),
            "contextManagement": {"enabled": false, "thresholdTokens": 500_000},
            "runRuntimeSnapshotRef": "run-runtime:test",
            "extensionGenerationRef": "extension-generation:test",
            "kernelCatalogSnapshotRef": "kernel-catalog:test",
            "provider": {
                "providerRuntimeRef": "provider-runtime:test",
                "profileId": "profile:test",
                "contextWindowTokens": 1000,
                "maxOutputTokens": 100,
                "apiSurface": "chatCompletions",
                "hostedWebSearch": "none"
            },
            "webSearch": {"owner":"unavailable"},
            "environment": {
                "os":"fixture", "arch":"fixture", "locale":null, "responseLanguage":null,
                "userShell":null, "executionTarget":{"kind":"native"},
                "shell":{"tool":"bash", "executable":"bash", "dialect":"bash"},
                "executionPath":"fixture-bin", "shellAvailable":true,
                "workspaceShellSupported":true, "developerCommands":[]
            },
            "instructions": [],
            "tools": [],
            "toolPromptContributions": [],
            "providerToolAliases": [
                {"canonicalName":"interaction.request","wireName":"interaction_request"},
                {"canonicalName":"plan.publish","wireName":"plan_publish"}
            ],
            "selectedPlugins": {
                "catalogRevision": "plugin-catalog:test",
                "plugins": []
            }
        })
    }

    #[test]
    fn history_read_preserves_payloads_cursor_and_corrupt_journal_errors() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        let session_id = "session:owned-history";
        let created = journal
            .create_session(session_id, "History", &json!([]), None, None)
            .unwrap();
        let committed = journal
            .append(&json!({
                "type": "message.committed", "sessionId": session_id,
                "payload": {"messageId": "message:history", "role": "user",
                    "content": "历史 \\\"quoted\\\"\n".repeat(1024)}
            }))
            .unwrap();
        assert_eq!(
            journal.read_events(session_id, 0).unwrap(),
            vec![created, committed.clone()]
        );
        assert_eq!(journal.read_events(session_id, 1).unwrap(), vec![committed]);
        assert!(journal.read_events(session_id, 2).unwrap().is_empty());
        assert_eq!(
            journal.read_events("session:missing", 0).unwrap_err().code,
            "session_not_found"
        );
        // A later read still consults the journal, including corruption without
        // a revision change. Optimization must not turn this into a cached success.
        {
            let connection = journal.lock().unwrap();
            connection
                .execute_batch("PRAGMA ignore_check_constraints = ON;")
                .unwrap();
            connection
                .execute(
                    "UPDATE session_events SET payload_json='{' WHERE session_id=?1 AND sequence=2",
                    [session_id],
                )
                .unwrap();
        }
        assert_eq!(
            journal.read_events(session_id, 0).unwrap_err().code,
            "session_event_corrupt"
        );
    }

    #[test]
    fn journal_publication_moves_owned_payload_without_changing_envelope() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        let session_id = "session:publication-move";
        let created = journal
            .create_session(session_id, "Publication", &json!([]), None, None)
            .unwrap();
        let permissions = journal
            .permission_model()
            .unwrap()
            .publication(session_id, true);
        // Exercise both bootstrap and ordinary event publication. Pointer
        // identity verifies the intended ownership transfer, not a timing budget.
        for bootstrap in [false, true] {
            let payload = json!([{"body": "nested history payload".repeat(1024),
                "values": [null, true, 123, {"text": "原始记录"}]}]);
            let expected = payload.clone();
            let body = payload[0]["body"].as_str().unwrap().as_ptr();
            let events = if bootstrap {
                vec![created.clone()]
            } else {
                vec![]
            };
            let publication = journal.event_publication(payload, &events).unwrap();
            assert_eq!(publication["value"], expected);
            assert_eq!(
                publication["value"][0]["body"].as_str().unwrap().as_ptr(),
                body,
                "an owned journal payload must not be deeply serialized again"
            );
            assert_eq!(
                publication["permissions"],
                if bootstrap {
                    permissions.clone()
                } else {
                    json!({})
                }
            );
            assert_eq!(publication.as_object().unwrap().len(), 2);
        }
    }

    #[test]
    fn cancelled_provider_turn_has_no_error_or_completed_call_facts() {
        let event = json!({"type":"provider.turn.settled", "sessionId":"session:cancel",
            "runId":"run:cancel", "payload":{"providerRequestId":"request:cancel", "purpose":"agent",
            "providerRuntimeRef":"provider-runtime:cancel", "outcome":"cancelled"}});
        validate_new_event(&event, false).unwrap();
        let mut invalid = event.clone();
        invalid["payload"]["error"] = json!({"code":"cancelled", "message":"Not a failure"});
        assert!(validate_new_event(&invalid, false).is_err());
        let mut invalid = event.clone();
        invalid["payload"]["orderedCallIds"] = json!([]);
        assert!(validate_new_event(&invalid, false).is_err());
        let mut failed = event;
        failed["payload"]["outcome"] = json!("failed");
        assert!(validate_new_event(&failed, false).is_err());
        failed["payload"]["error"] =
            json!({"code":"provider_failed", "message":"Original failure"});
        validate_new_event(&failed, false).unwrap();
    }

    #[test]
    fn session_subagent_settings_preserve_creation_and_isolate_updates() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        let settings = json!({"enabled":true,"profileId":"","reasoningEffort":"",
            "maxConcurrent":4,"maxCallsPerRun":8,"maxMembersPerSession":12,
            "allowMemberAnalysis":true,"allowFullConfiguration":false,"presets":"[]"});
        for id in ["session:first", "session:second"] {
            journal
                .create_session_with_recipe(id, id, &json!([]), None, None, None, Some(&settings))
                .unwrap();
        }
        let mut changed = settings.clone();
        changed["enabled"] = json!(false);
        let commit = json!({"command":{"schemaVersion":COMMAND_VERSION,"type":"session.subagent-settings.set",
            "sessionId":"session:first","commandId":"command:subagent-settings","settings":changed},
            "events":[{"type":"session.subagent-settings.updated","sessionId":"session:first",
                "payload":{"commandId":"command:subagent-settings","settings":changed}}],
            "reply":{"schemaVersion":REPLY_VERSION,"sessionId":"session:first","commandId":"command:subagent-settings",
                "status":"accepted","revision":0}});
        journal.commit_command(&commit).unwrap();
        let first = journal.read_events("session:first", 0).unwrap();
        let second = journal.read_events("session:second", 0).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0]["payload"]["subagentSettings"], settings);
        assert_eq!(first[1]["payload"]["settings"], changed);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["payload"]["subagentSettings"], settings);

        let mut invalid = commit;
        invalid["command"]["commandId"] = json!("command:invalid");
        invalid["command"]["settings"]["maxConcurrent"] = json!(0);
        assert!(journal.commit_command(&invalid).is_err());
        assert_eq!(journal.read_events("session:first", 0).unwrap().len(), 2);
        journal
            .create_session("session:missing", "Missing", &json!([]), None, None)
            .unwrap();
        assert!(
            journal.read_events("session:missing", 0).unwrap()[0]["payload"]
                .get("subagentSettings")
                .is_none()
        );
    }

    #[test]
    fn unified_agent_capabilities_preserve_lineage_and_require_explicit_facts() {
        let capabilities = json!({"messaging":true,"continuation":false,"delegation":false});
        let context = json!({
            "capabilities":capabilities,
            "ownerSessionId":"session:owner", "parentSessionId":"session:parent",
            "parentRunId":"run:parent", "parentCallId":"call:spawn"
        });
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:child", "Child", &json!([]), None, Some(&context))
            .unwrap();
        assert_eq!(
            journal.agent_context("session:child").unwrap(),
            Some(context.clone())
        );
        let mut missing = context.clone();
        missing["capabilities"]
            .as_object_mut()
            .unwrap()
            .remove("messaging");
        assert!(validate_agent_context(&missing, "session:child").is_err());
        let mut invalid = context.clone();
        invalid["capabilities"]["delegation"] = json!("false");
        assert_eq!(
            validate_agent_context(&invalid, "session:child")
                .unwrap_err()
                .code,
            "agent_capabilities_invalid"
        );
        let mut role = context;
        role["role"] = json!("analysis");
        assert!(validate_agent_context(&role, "session:child").is_err());

        let created = json!({
            "type":"agent.task.created", "sessionId":"session:owner", "runId":"run:parent", "callId":"call:spawn",
            "payload":{"taskId":"task:child","agentSessionId":"session:child","capabilities":capabilities,
                "createsAgent":false,"displayName":"Child","text":"Continue analysis","delivery":"async"}
        });
        validate_new_event(&created, false).unwrap();
        let mut missing_creation = created.clone();
        missing_creation["payload"]
            .as_object_mut()
            .unwrap()
            .remove("createsAgent");
        assert!(validate_new_event(&missing_creation, false).is_err());
        let mut invalid_creation = created;
        invalid_creation["payload"]["capabilities"]["continuation"] = json!(1);
        assert!(validate_new_event(&invalid_creation, false).is_err());
        validate_new_event(&json!({"type":"agent.closed","sessionId":"session:owner","payload":{"agentSessionId":"session:child"}}), false).unwrap();

        let mut runtime = runtime_snapshot();
        validate_run_runtime_snapshot(&runtime).unwrap();
        runtime["agentCapabilities"] = capabilities;
        validate_run_runtime_snapshot(&runtime).unwrap();
        let mut missing_runtime = runtime.clone();
        missing_runtime
            .as_object_mut()
            .unwrap()
            .remove("agentCapabilities");
        assert!(validate_run_runtime_snapshot(&missing_runtime).is_err());
        runtime["agentCapabilities"]["messaging"] = Value::Null;
        assert!(validate_run_runtime_snapshot(&runtime).is_err());
    }

    #[test]
    fn approval_review_uses_its_frozen_model_without_changing_the_conversation_model() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:review", "Review", &json!([]), None, None)
            .unwrap();
        let mut runtime = runtime_snapshot();
        runtime["approvalReviewer"] = json!({
            "providerRuntimeRef": "provider-runtime:review",
            "profileId": "profile:review",
            "contextWindowTokens": 4096,
            "maxOutputTokens": 1024,
            "apiSurface": "anthropicMessages",
            "hostedWebSearch": "none"
        });
        journal.append(&json!({"type":"run.started", "sessionId":"session:review", "runId":"run:review",
            "payload":{"inputMessageId":"message:review","workspaceBindings":[],"runtimeSnapshot":runtime}})).unwrap();
        let conversation = journal
            .run_provider_runtime("session:review", "run:review", "agent")
            .unwrap();
        let reviewer = journal
            .run_provider_runtime("session:review", "run:review", "approvalReview")
            .unwrap();
        assert_eq!(conversation.profile_id, "profile:test");
        assert_eq!(reviewer.profile_id, "profile:review");
        assert_eq!(reviewer.max_output_tokens, 1024);
        assert_eq!(reviewer.web_search_owner, "unavailable");
        runtime["approvalReviewer"]["providerRuntimeRef"] =
            runtime["provider"]["providerRuntimeRef"].clone();
        assert!(validate_run_runtime_snapshot(&runtime).is_err());
    }

    #[test]
    fn unavailable_reviewer_preserves_the_error_without_blocking_the_conversation() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session(
                "session:review-error",
                "Review error",
                &json!([]),
                None,
                None,
            )
            .unwrap();
        let mut runtime = runtime_snapshot();
        let error = json!({"code":"approval_reviewer_prepare_failed", "message":"Missing selected review profile"});
        runtime["approvalReviewerError"] = error.clone();
        journal.append(&json!({"type":"run.started", "sessionId":"session:review-error", "runId":"run:review-error",
            "payload":{"inputMessageId":"message:review-error","workspaceBindings":[],"runtimeSnapshot":runtime}})).unwrap();
        assert_eq!(
            journal
                .run_provider_runtime("session:review-error", "run:review-error", "agent")
                .unwrap()
                .profile_id,
            "profile:test"
        );
        let failure = journal
            .run_provider_runtime("session:review-error", "run:review-error", "approvalReview")
            .err()
            .unwrap();
        assert_eq!(failure.code, error["code"].as_str().unwrap());
        assert_eq!(failure.message, error["message"].as_str().unwrap());
        runtime["approvalReviewer"] = runtime["provider"].clone();
        runtime["approvalReviewer"]["providerRuntimeRef"] =
            json!("provider-runtime:separate-review");
        assert!(validate_run_runtime_snapshot(&runtime).is_err());
    }

    #[test]
    fn plan_authority_lasts_through_todo_updates_and_expires_on_run_finishing() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:scope", "Scope", &json!([]), None, None)
            .unwrap();
        journal.append(&json!({"type":"run.started", "sessionId":"session:scope", "runId":"run:scope",
            "payload":{"inputMessageId":"message:scope","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}})).unwrap();
        journal.append(&json!({"type":"plan.published", "sessionId":"session:scope", "runId":"run:scope", "callId":"call:plan",
            "payload":{"providerCallId":"provider:plan", "planId":"plan:scope", "revision":1,
                "title":"Write result", "summary":"Write the approved file.",
                "steps":[{"stepId":"write","title":"Write result","details":"Write result.txt"}],
                "mutationManifest":[{"workspaceId":"workspace:scope","operation":"fs.write","target":"result.txt"}]}})).unwrap();
        let confirmed = json!({
            "type":"plan.confirmed", "sessionId":"session:scope", "runId":"run:scope", "callId":"call:plan",
            "payload":{"planId":"plan:scope", "revision":1, "commandId":"command:confirm", "decisionId":"decision:scope", "authorities":[{
                "authorityId":"authority:scope", "planId":"plan:scope", "revision":1, "decisionId":"decision:scope",
                "sessionId":"session:scope", "runId":"run:scope", "workspaceId":"workspace:scope",
                "coveredOperations":[{"workspaceId":"workspace:scope", "operation":"fs.write", "target":"result.txt"}]
            }]}
        });
        journal.append(&confirmed).unwrap();
        let authorities = journal.active_plan_authorities("session:scope").unwrap();
        assert_eq!(
            authorities,
            Some(
                confirmed["payload"]["authorities"]
                    .as_array()
                    .unwrap()
                    .clone()
            )
        );
        journal
            .append(
                &json!({"type":"todo.updated", "sessionId":"session:scope", "runId":"run:scope",
            "payload":{"revision":1,"items":[{"text":"Done","status":"completed"}]}}),
            )
            .unwrap();
        assert_eq!(
            journal.active_plan_authorities("session:scope").unwrap(),
            authorities
        );
        journal
            .append(
                &json!({"type":"run.finishing", "sessionId":"session:scope", "runId":"run:scope",
            "payload":{"outcome":"cancelled"}}),
            )
            .unwrap();
        assert_eq!(
            journal.active_plan_authorities("session:scope").unwrap(),
            None
        );
        assert!(validate_todo_items(&json!([{"text":"Task","status":"invented"}])).is_err());
        validate_todo_items(&json!([])).unwrap();
        validate_todo_items(&json!([{"text":"Task","status":"blocked"}])).unwrap();
    }

    #[test]
    fn agent_lifecycle_reads_relationships_without_task_or_conversation_bodies() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        let session_id = "session:agent-lifecycle";
        journal
            .create_session(session_id, "Owner", &json!([]), None, None)
            .unwrap();
        journal
            .append(&json!({"type":"message.committed","sessionId":session_id,
            "payload":{"messageId":"message:input","role":"user","content":"Large request body"}}))
            .unwrap();
        journal.append(&json!({"type":"run.started","sessionId":session_id,"runId":"run:owner",
            "payload":{"inputMessageId":"message:input","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}})).unwrap();
        let created = json!({"type":"agent.task.created","sessionId":session_id,"runId":"run:owner","callId":"call:spawn",
            "payload":{"taskId":"task:child","agentSessionId":"session:child","displayName":"Child",
            "capabilities":{"messaging":false,"continuation":false,"delegation":false},"createsAgent":true,
            "delivery":"async","text":"Large task body"}});
        journal.append(&created).unwrap();
        journal
            .append(
                &json!({"type":"agent.task.started","sessionId":session_id,"runId":"run:owner",
            "payload":{"taskId":"task:child","childRunId":"run:child"}}),
            )
            .unwrap();
        journal.append(&json!({"type":"agent.task.completed","sessionId":session_id,"runId":"run:owner",
            "payload":{"taskId":"task:child","result":{"outcome":"completed","content":"Large result body","finalMessageId":"message:child"}}})).unwrap();
        journal.append(&json!({"type":"message.committed","sessionId":session_id,
            "payload":{"messageId":"message:owner","role":"user","content":"Large conversation body"}})).unwrap();
        let read = journal.read_agent_lifecycle(session_id).unwrap();
        assert_eq!(read["revision"], 7);
        assert_eq!(read["events"].as_array().unwrap().len(), 4);
        assert_eq!(
            read["events"][1]["payload"]["agentSessionId"],
            "session:child"
        );
        assert_eq!(read["events"][2]["payload"]["childRunId"], "run:child");
        assert_eq!(
            read["events"][3]["payload"]["result"],
            json!({"outcome":"completed"})
        );
        for excluded in [
            "Large",
            "\"text\"",
            "\"content\"",
            "finalMessageId",
            "occurredAt",
            "eventId",
        ] {
            assert!(
                !read.to_string().contains(excluded),
                "unexpected body field: {excluded}"
            );
        }
        assert_eq!(
            journal.read_events(session_id, 0).unwrap()[3]["payload"],
            created["payload"]
        );
        assert_eq!(
            journal
                .read_agent_lifecycle("session:missing")
                .unwrap_err()
                .code,
            "session_not_found"
        );
    }

    #[test]
    fn provider_usage_read_keeps_receipts_without_provider_or_conversation_bodies() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        let session_id = "session:provider-usage";
        journal
            .create_session(session_id, "Usage", &json!([]), None, None)
            .unwrap();
        journal.append(&json!({"type":"message.committed","sessionId":session_id,
            "payload":{"messageId":"message:input","role":"user","content":"Large conversation body"}})).unwrap();
        journal.append(&json!({"type":"run.started","sessionId":session_id,"runId":"run:usage",
            "payload":{"inputMessageId":"message:input","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}})).unwrap();
        journal.append(&json!({"type":"provider.turn.settled","sessionId":session_id,"runId":"run:usage",
            "payload":{"providerRequestId":"provider-request:usage","purpose":"agent",
                "providerRuntimeRef":"provider-runtime:test","outcome":"completed","orderedCallIds":[],
                "reasoningContent":"Large reasoning body","orderedOutputBlocks":[{"outputIndex":0,"kind":"reasoning",
                    "item":{"type":"reasoning","summary":[{"type":"summary_text","text":"Large output block"}]}},
                    {"outputIndex":1,"kind":"finalMessage","messageId":"message:final",
                    "item":{"type":"message","content":[{"type":"output_text","text":"Large final body"}]}}]}})).unwrap();
        let usage = json!({"providerRequestId":"provider-request:usage","providerRuntimeRef":"provider-runtime:test",
            "inputTokens":100,"outputTokens":20,"contextWindowTokens":128000});
        journal.append(&json!({"type":"context.updated","sessionId":session_id,"runId":"run:usage","payload":usage})).unwrap();
        let read = journal.read_provider_usage(session_id).unwrap();
        assert_eq!(read["revision"], 5);
        assert_eq!(read["events"].as_array().unwrap().len(), 2);
        assert_eq!(read["events"][0]["sequence"], 4);
        assert_eq!(
            read["events"][0]["payload"],
            json!({"providerRequestId":"provider-request:usage"})
        );
        assert_eq!(read["events"][1]["payload"], usage);
        for excluded in [
            "Large",
            "orderedOutputBlocks",
            "reasoningContent",
            "runtimeSnapshot",
            "occurredAt",
            "eventId",
        ] {
            assert!(
                !read.to_string().contains(excluded),
                "unexpected body field: {excluded}"
            );
        }
        assert_eq!(
            journal
                .read_provider_usage("session:missing")
                .unwrap_err()
                .code,
            "session_not_found"
        );
    }

    #[test]
    fn resource_read_selects_fields_and_requested_records_without_context_bodies() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        let id = "session:resource-fields";
        journal
            .create_session(id, "Resource fields", &json!([]), None, None)
            .unwrap();
        // This adapter test exercises stored JSON field selection; Session tests
        // separately validate resource lifecycle semantics against full replay.
        let wanted = json!({"record":{"recordId":"record:wanted","input":{"body":"selected input"},
            "output":{"fileChanges":[{"path":"a.txt"}],"body":"selected output"}}});
        let rows = [
            (
                "message.committed",
                json!({"content":"MESSAGE_BODY_NOT_NEEDED","filesystemReferences":[]}),
            ),
            ("tool.completed", wanted.clone()),
            (
                "tool.completed",
                json!({"record":{"recordId":"record:other","output":{"body":"UNRELATED_TOOL_BODY"}}}),
            ),
            (
                "context.composed",
                json!({"messages":"CONTEXT_BODY_NOT_NEEDED".repeat(1024)}),
            ),
            (
                "approval.requested",
                json!({"approvalId":"approval:files","preview":{"summary":"Read files", "authorizationContext":{"fileAccess":{"read":["/reference"],"write":[]}},"unrelated":"PREVIEW_BODY_NOT_NEEDED"}}),
            ),
        ];
        {
            let connection = journal.lock().unwrap();
            for (index, (kind, payload)) in rows.iter().enumerate() {
                connection.execute("INSERT INTO session_events(session_id,sequence,event_id,event_type,run_id,call_id,payload_json,occurred_at)
                    VALUES (?1,?2,?3,?4,'run:resource','call:resource',?5,'now')",
                    params![id,index as i64+2,format!("event:resource:{index}"),kind,payload.to_string()]).unwrap();
            }
        }
        let roots = journal.read_resources(id, &[]).unwrap();
        assert_eq!(roots["revision"], 6);
        assert_eq!(roots["events"].as_array().unwrap().len(), 5);
        assert_eq!(
            roots["events"][1]["payload"]["filesystemReferences"],
            json!([])
        );
        assert_eq!(roots["events"][2]["payload"], json!({}));
        assert_eq!(
            roots["events"][4]["payload"]["preview"]["authorizationContext"]["fileAccess"]["read"],
            json!(["/reference"])
        );
        let selected = journal
            .read_resources(id, &["record:wanted".into()])
            .unwrap();
        assert_eq!(selected["events"][2]["payload"], wanted);
        assert_eq!(selected["events"][3]["payload"], json!({}));
        for marker in [
            "MESSAGE_BODY_NOT_NEEDED",
            "UNRELATED_TOOL_BODY",
            "CONTEXT_BODY_NOT_NEEDED",
            "PREVIEW_BODY_NOT_NEEDED",
        ] {
            assert!(!selected.to_string().contains(marker));
        }
        let artifact = json!({"record":{"recordId":"record:artifact","output":{"artifacts":[
            {"artifactId":"artifact:preview","contentType":"image/png","contentMode":"fixed"}
        ]}}});
        journal.lock().unwrap().execute(
            "INSERT INTO session_events(session_id,sequence,event_id,event_type,run_id,call_id,payload_json,occurred_at)
             VALUES (?1,7,'event:artifact','tool.completed','run:resource','call:artifact',?2,'now')",
            params![id,artifact.to_string()],
        ).unwrap();
        let with_artifact = journal.read_resources(id, &[]).unwrap();
        assert_eq!(with_artifact["revision"], 7);
        assert_eq!(
            with_artifact["events"].as_array().unwrap().last().unwrap()["payload"],
            artifact
        );
        assert_eq!(with_artifact["events"][2]["payload"], json!({}));
        assert!(!with_artifact
            .to_string()
            .contains("CONTEXT_BODY_NOT_NEEDED"));
        assert_eq!(
            journal
                .read_resources("session:missing", &[])
                .unwrap_err()
                .code,
            "session_not_found"
        );
        {
            let connection = journal.lock().unwrap();
            connection
                .execute_batch("PRAGMA ignore_check_constraints=ON;")
                .unwrap();
            connection
                .execute(
                    "UPDATE session_events SET payload_json='{' WHERE session_id=?1 AND sequence=2",
                    [id],
                )
                .unwrap();
        }
        let error = journal.read_resources(id, &[]).unwrap_err();
        assert_eq!(error.code, "session_resource_read_failed");
        assert!(error.message.contains("malformed JSON"));
    }

    #[test]
    fn compact_run_lifecycle_projects_fields_and_preserves_journal_revision() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        let session_id = "session:compact-status";
        let run_id = "run:compact-status";
        journal
            .create_session(session_id, "Stored title", &json!([]), None, None)
            .unwrap();
        journal
            .append(&json!({"type":"message.committed","sessionId":session_id,
            "payload":{"messageId":"message:compact","role":"user","content":"Stored body"}}))
            .unwrap();
        let runtime = runtime_snapshot();
        let mut expected = Vec::new();
        let mut append = |event: Value, payload: Value| {
            let stored = journal.append(&event).unwrap();
            let mut narrow = json!({"sessionId":session_id,"sequence":stored["sequence"],
                "type":event["type"],"payload":payload});
            for key in ["runId", "callId"] {
                if let Some(value) = event.get(key) {
                    narrow[key] = value.clone();
                }
            }
            expected.push(narrow);
        };
        append(
            json!({"type":"run.started","sessionId":session_id,"runId":run_id,
            "payload":{"inputMessageId":"message:compact","workspaceBindings":[],"runtimeSnapshot":runtime}}),
            json!({}),
        );
        for (suffix, mode) in [("blocking", None), ("deferred", Some("continue"))] {
            let interaction_id = format!("interaction:{suffix}");
            let mut event = json!({"type":"interaction.requested","sessionId":session_id,"runId":run_id,
                "callId":format!("call:{suffix}"),"payload":{"interactionId":interaction_id,
                "providerCallId":format!("provider:{suffix}"),"kind":"question","prompt":"Stored prompt","allowFreeform":true}});
            let mut payload = json!({"interactionId":interaction_id});
            if let Some(mode) = mode {
                event["payload"]["mode"] = json!(mode);
                payload["mode"] = json!(mode);
            }
            append(event, payload);
        }
        append(
            json!({"type":"run.waiting","sessionId":session_id,"runId":run_id,
            "payload":{"reason":"userInput","detail":"Stored detail"}}),
            json!({"reason":"userInput"}),
        );
        append(
            json!({"type":"run.finishing","sessionId":session_id,"runId":run_id,
            "payload":{"outcome":"cancelled"}}),
            json!({}),
        );
        append(
            json!({"type":"run.runtime.released","sessionId":session_id,"runId":run_id,
            "payload":{"runRuntimeSnapshotRef":runtime["runRuntimeSnapshotRef"],
            "extensionGenerationRef":runtime["extensionGenerationRef"],"kernelCatalogSnapshotRef":runtime["kernelCatalogSnapshotRef"],
            "providerRuntimeRef":runtime["provider"]["providerRuntimeRef"],"pluginInstanceRefs":[],"alreadyReleased":false}}),
            json!({}),
        );
        append(
            json!({"type":"run.settled","sessionId":session_id,"runId":run_id,
            "payload":{"outcome":"cancelled"}}),
            json!({"outcome":"cancelled"}),
        );
        append(
            json!({"type":"conversation.revised","sessionId":session_id,
            "payload":{"commandId":"command:edit","messageId":"message:compact","fromSequence":2,"throughSequence":9}}),
            json!({"fromSequence":2,"throughSequence":9}),
        );
        journal.append(&json!({"type":"session.model-settings.updated","sessionId":session_id,
            "payload":{"commandId":"command:settings","settings":{"profileId":"profile:stored","reasoningEffortOverride":null}}})).unwrap();
        let read = journal.read_run_lifecycle(session_id, 0).unwrap();
        assert_eq!(
            read,
            json!({"sessionId":session_id,"revision":11,"events":expected})
        );
        let encoded = read.to_string();
        for excluded in [
            "Stored",
            "runtimeSnapshot",
            "kernelCatalogSnapshotRef",
            "occurredAt",
            "eventId",
            "profileId",
        ] {
            assert!(
                !encoded.contains(excluded),
                "unexpected full payload field: {excluded}"
            );
        }
        assert_eq!(
            journal.read_run_lifecycle(session_id, 8).unwrap(),
            json!({"sessionId":session_id,"revision":11,"events":expected[6..]})
        );
        assert_eq!(
            journal.read_run_lifecycle(session_id, 11).unwrap(),
            json!({"sessionId":session_id,"revision":11,"events":[]})
        );
        assert_eq!(
            journal
                .read_run_lifecycle("session:missing", 0)
                .unwrap_err()
                .code,
            "session_not_found"
        );
    }

    #[test]
    fn journal_records_explicit_gui_rebind_with_its_tool_view() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:rebind", "Rebind", &json!([]), None, None)
            .unwrap();
        let runtime = runtime_snapshot();
        journal.append(&json!({"type":"run.started","sessionId":"session:rebind","runId":"run:rebind",
            "payload":{"inputMessageId":"message:rebind","workspaceBindings":[],"runtimeSnapshot":runtime}})).unwrap();
        let binding = |host: &str| json!({"hostInstanceId":host,"windowLabel":"main"});
        let mut tool_view = serde_json::Map::new();
        for key in [
            "extensionGenerationRef",
            "kernelCatalogSnapshotRef",
            "instructions",
            "tools",
            "toolPromptContributions",
            "providerToolAliases",
            "selectedPlugins",
        ] {
            tool_view.insert(key.to_string(), runtime[key].clone());
        }
        let command = json!({"schemaVersion":COMMAND_VERSION,"type":"run.host.rebind","commandId":"command:rebind",
            "sessionId":"session:rebind","runId":"run:rebind","expectedHostBinding":binding("gui:old"),"hostBinding":binding("gui:new")});
        let event = json!({"type":"run.host.rebound","sessionId":"session:rebind","runId":"run:rebind",
            "payload":{"commandId":"command:rebind","previousBinding":binding("gui:old"),"hostBinding":binding("gui:new"),"toolView":tool_view}});
        let commit = json!({"command":command,"events":[event],"reply":{"schemaVersion":REPLY_VERSION,
            "commandId":"command:rebind","sessionId":"session:rebind","status":"accepted","revision":0}});
        assert_eq!(
            journal.commit_command(&commit).unwrap()["status"],
            "accepted"
        );
        assert_eq!(
            journal.read_events("session:rebind", 2).unwrap()[0]["payload"],
            event["payload"]
        );
        assert_eq!(
            journal.commit_command(&commit).unwrap_err().code,
            "session_command_already_recorded"
        );
    }

    #[test]
    fn journal_persists_explicit_delivery_and_accepts_task_sized_plugin_selection() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:delivery", "Delivery", &json!([]), None, None)
            .unwrap();
        journal.append(&json!({"type":"run.started", "sessionId":"session:delivery", "runId":"run:delivery",
            "payload":{"inputMessageId":"message:delivery","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}})).unwrap();
        let event = json!({"type":"artifacts.presented", "sessionId":"session:delivery", "runId":"run:delivery", "callId":"call:delivery",
            "payload":{"providerCallId":"provider:delivery","items":[{"artifactId":"artifact:report","deliveryId":"delivery:report","label":"Review report"}]}});
        let committed = journal.append(&event).unwrap();
        assert_eq!(
            journal.read_events("session:delivery", 2).unwrap(),
            vec![committed]
        );
        let mut duplicate = event.clone();
        duplicate["payload"]["items"]
            .as_array_mut()
            .unwrap()
            .push(event["payload"]["items"][0].clone());
        assert_eq!(
            journal.append(&duplicate).unwrap_err().code,
            "session_event_invalid"
        );
        let rejected = json!({"type":"session.control.rejected", "sessionId":"session:delivery", "runId":"run:delivery", "callId":"call:invalid",
            "payload":{"providerCallId":"provider:invalid","toolName":"artifact.present","input":{},"error":{"code":"artifact_not_found","message":"Unknown resource"}}});
        journal.append(&rejected).unwrap();
        let rejected_session = json!({"type":"session.control.rejected", "sessionId":"session:delivery", "runId":"run:delivery", "callId":"call:invalid-schedule",
            "payload":{"providerCallId":"provider:invalid-schedule","toolName":"session","input":{"action":"cancelSchedule","scheduleId":"schedule:missing"},"error":{"code":"schedule_not_pending","message":"The schedule is not pending"}}});
        let recorded = journal.append(&rejected_session).unwrap();
        assert_eq!(recorded["payload"], rejected_session["payload"]);
        let selections: Vec<Value> = (0..17).map(|index| json!({"selectionId":format!("selection:{index}"),"uri":format!("plugin://tool-{index}@local"),"label":format!("Tool {index}")})).collect();
        validate_plugin_selection_list(&json!(selections)).unwrap();
        journal.append(&json!({"type":"session.plugins.activated", "sessionId":"session:delivery", "runId":"run:delivery", "callId":"call:plugins",
            "payload":{"providerCallId":"provider:plugins","kernelCatalogSnapshotRef":"catalog:plugins","pluginUris":selections.iter().map(|item|item["uri"].clone()).collect::<Vec<_>>()}})).unwrap();
    }

    #[test]
    fn runtime_snapshot_requires_tool_prompt_to_match_a_callable_prepared_binding() {
        let mut runtime = runtime_snapshot();
        runtime["tools"] = json!([{
            "toolBindingRef": "tool-binding:read:test",
            "name": "fs.read",
            "description": "Read UTF-8 workspace text.",
            "inputSchema": {"type": "object"},
            "possibleEffects": ["workspaceRead"],
            "availability": "callable",
            "origin": "coreBuiltin"
        }]);
        runtime["providerToolAliases"]
            .as_array_mut()
            .expect("provider aliases")
            .push(json!({"canonicalName":"fs.read","wireName":"fs_read"}));
        runtime["toolPromptContributions"] = json!([{
            "contributionRef": "tool-prompt-contribution:read:test",
            "preparedToolBindingRef": "tool-binding:read:test",
            "canonicalToolName": "fs.read",
            "origin": "coreBuiltin",
            "promptSnippet": "Read known text files directly.",
            "usageGuidelines": ["Use bounded offsets when only a segment is needed."]
        }]);

        validate_run_runtime_snapshot(&runtime).expect("valid prepared prompt contribution");

        let mut stale_binding = runtime.clone();
        stale_binding["toolPromptContributions"][0]["preparedToolBindingRef"] =
            json!("tool-binding:read:stale");
        let error = validate_run_runtime_snapshot(&stale_binding)
            .expect_err("stale prompt binding must fail");
        assert_eq!(error.code, "session_event_invalid");

        let mut blocked = runtime;
        blocked["tools"][0]["availability"] = json!("blocked");
        let error = validate_run_runtime_snapshot(&blocked)
            .expect_err("blocked tools must not retain prepared prompt contributions");
        assert_eq!(error.code, "session_event_invalid");
    }

    fn append_model_settings_and_rejected_call(journal: &LocalAgentJournal) {
        let settings = json!({"profileId":"profile:test","reasoningEffortOverride":"high"});
        let result = journal
            .commit_command(&json!({
                "command": {
                    "schemaVersion": COMMAND_VERSION,
                    "type":"session.model-settings.set", "sessionId":"session:loop",
                    "commandId":"command:settings", "settings":settings
                },
                "events":[{
                    "type":"session.model-settings.updated", "sessionId":"session:loop",
                    "payload":{"commandId":"command:settings","settings":settings}
                }],
                "reply":{
                    "schemaVersion":REPLY_VERSION,"sessionId":"session:loop",
                    "commandId":"command:settings","status":"accepted","revision":0
                }
            }))
            .expect("save settings through the real SQLite command transaction");
        assert_eq!(result["status"], "accepted");
        journal.append(&json!({
            "type":"run.started", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{"inputMessageId":"message:loop","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}
        })).unwrap();
        journal.append(&json!({
            "type":"context.composed", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{
                "providerRequestId":"provider-request:loop","purpose":"agent","responseConstraint":"normal",
                "dynamicInstructionBytes":0,"messages":[],"workspaceBindings":[],"tools":[],
                "partitions":[
                    {"kind":"instructions","itemCount":0,"requestShapeUnits":1},
                    {"kind":"sessionControls","itemCount":0,"requestShapeUnits":0},
                    {"kind":"tools","itemCount":0,"requestShapeUnits":0},
                    {"kind":"workspaceBindings","itemCount":0,"requestShapeUnits":0},
                    {"kind":"contextProviders","itemCount":0,"requestShapeUnits":0},
                    {"kind":"journalMessages","itemCount":0,"requestShapeUnits":0},
                    {"kind":"filesystemReferences","itemCount":0,"requestShapeUnits":0}
                ]
            }
        })).unwrap();
        journal.append(&json!({
            "type":"tool.requested", "sessionId":"session:loop", "runId":"run:loop","callId":"call:loop",
            "payload":{
                "providerCallId":"provider-call:loop","attemptId":"attempt:loop","toolName":"bash",
                "input":{"command":"pwd","executionMode":"read"}
            }
        })).unwrap();
        journal.append(&json!({
            "type":"provider.turn.settled", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{
                "outcome":"completed","providerRequestId":"provider-request:loop","purpose":"agent",
                "providerRuntimeRef":"provider-runtime:test","orderedCallIds":["call:loop"]
            }
        })).unwrap();
        let event = journal.append(&json!({
            "type":"tool.input-rejected", "sessionId":"session:loop", "runId":"run:loop","callId":"call:loop",
            "payload":{"rejection":{
                "sessionId":"session:loop","runId":"run:loop","callId":"call:loop","attemptId":"attempt:loop",
                "extensionGenerationRef":"extension-generation:test","kernelCatalogSnapshotRef":"kernel-catalog:test",
                "toolBindingRef":"tool-binding:bash","toolName":"bash","rejectedAt":"2026-09-07T00:00:00Z",
                "input":{"command":"pwd","executionMode":"read"},
                "error":{"code":"tool_input_invalid","message":"Tool was not executed.","issues":[{
                    "path":"$.executionMode","rule":"additionalProperties","message":"Remove this undeclared field."
                }]}
            }}
        })).expect("persist the rejected input without an execution record");
        assert_eq!(event["type"], "tool.input-rejected");
    }

    #[test]
    fn request_resource_views_include_consumed_files_and_directories_and_keep_old_views() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:loop", "Resources", &json!([]), None, None)
            .unwrap();
        append_model_settings_and_rejected_call(&journal);
        let mut receipt = journal
            .read_events("session:loop", 0)
            .unwrap()
            .into_iter()
            .find(|event| event["type"] == "context.composed")
            .unwrap()["payload"]
            .clone();
        let reference = json!({"referenceId":"reference:image", "workspaceId":"workspace:image", "logicalPath":"screen.png",
            "displayName":"screen.png", "kind":"file", "mediaType":"image/png", "byteLength":8});
        let directory = json!({"referenceId":"reference:directory", "workspaceId":"workspace:directory", "logicalPath":".",
            "displayName":"Reference directory", "kind":"directory"});
        journal.append(&json!({"type":"input.queued", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{"commandId":"command:image", "messageId":"message:image", "text":"", "filesystemReferences":[reference, directory]}})).unwrap();
        assert_eq!(
            journal
                .provider_workspace_binding_ids("session:loop", "run:loop", "provider-request:loop")
                .unwrap(),
            Vec::<String>::new()
        );
        assert!(!journal
            .has_workspace_binding_view("session:loop", "run:loop", &["workspace:image".into()])
            .unwrap());
        journal.append(&json!({"type":"message.committed", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{"messageId":"message:image", "role":"user", "content":"", "filesystemReferences":[reference, directory]}})).unwrap();
        journal.append(&json!({"type":"session.directory-index.attached", "sessionId":"session:loop",
            "payload":{"commandId":"command:image", "workspaceBinding":{"workspaceId":"workspace:directory","displayName":"Reference directory"}}})).unwrap();
        assert_eq!(
            journal
                .run_workspace_binding_ids("session:loop", "run:loop")
                .unwrap(),
            vec!["workspace:directory"]
        );
        receipt["providerRequestId"] = json!("provider-request:image");
        receipt["workspaceBindings"] = json!([{"itemId":"workspace:image","label":"screen.png"}, {"itemId":"workspace:directory","label":"Reference directory"}]);
        journal.append(&json!({"type":"context.composed", "sessionId":"session:loop", "runId":"run:loop", "payload":receipt})).unwrap();
        assert_eq!(
            journal
                .provider_workspace_binding_ids(
                    "session:loop",
                    "run:loop",
                    "provider-request:image"
                )
                .unwrap(),
            vec!["workspace:image", "workspace:directory"]
        );
        assert!(journal
            .has_workspace_binding_view(
                "session:loop",
                "run:loop",
                &["workspace:image".into(), "workspace:directory".into()]
            )
            .unwrap());
        assert!(journal
            .has_workspace_binding_view("session:loop", "run:loop", &[])
            .unwrap());
        assert_eq!(
            journal
                .provider_workspace_binding_ids("session:loop", "run:loop", "provider-request:loop")
                .unwrap(),
            Vec::<String>::new()
        );
        assert!(!journal
            .has_workspace_binding_view(
                "session:loop",
                "run:loop",
                &["workspace:other-project".into()]
            )
            .unwrap());
    }

    #[test]
    fn directory_bindings_change_only_the_active_run_and_preserve_initial_facts() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:bindings", "Bindings", &json!([]), None, None)
            .unwrap();
        journal.append(&json!({"type":"run.started", "sessionId":"session:bindings", "runId":"run:bindings",
            "payload":{"inputMessageId":"message:bindings", "workspaceBindings":[{"workspaceId":"workspace:initial","displayName":"Initial"}],
            "runtimeSnapshot":runtime_snapshot()}})).unwrap();
        let added = journal.append(&json!({"type":"session.directory-index.attached", "sessionId":"session:bindings",
            "payload":{"commandId":"command:add", "workspaceBinding":{"workspaceId":"workspace:added","displayName":"Added"}}})).unwrap();
        let sequence = added["sequence"].as_i64().unwrap();
        assert_eq!(
            journal
                .run_workspace_binding_ids_at("session:bindings", "run:bindings", sequence - 1)
                .unwrap(),
            vec!["workspace:initial"]
        );
        assert_eq!(
            journal
                .run_workspace_binding_ids("session:bindings", "run:bindings")
                .unwrap(),
            vec!["workspace:initial", "workspace:added"]
        );
        journal
            .append(
                &json!({"type":"session.directory-index.detached", "sessionId":"session:bindings",
            "payload":{"commandId":"command:detach", "workspaceId":"workspace:added"}}),
            )
            .unwrap();
        assert_eq!(
            journal
                .run_workspace_binding_ids("session:bindings", "run:bindings")
                .unwrap(),
            vec!["workspace:initial"]
        );
        assert_eq!(
            journal
                .run_workspace_binding_ids_at("session:bindings", "run:bindings", sequence)
                .unwrap(),
            vec!["workspace:initial", "workspace:added"]
        );
        journal.append(&json!({"type":"run.finishing", "sessionId":"session:bindings", "runId":"run:bindings", "payload":{"outcome":"cancelled"}})).unwrap();
        journal.append(&json!({"type":"session.directory-index.attached", "sessionId":"session:bindings",
            "payload":{"commandId":"command:later", "workspaceBinding":{"workspaceId":"workspace:later","displayName":"Later"}}})).unwrap();
        assert_eq!(
            journal
                .run_workspace_binding_ids("session:bindings", "run:bindings")
                .unwrap(),
            vec!["workspace:initial"]
        );
        assert_eq!(
            journal.read_events("session:bindings", 0).unwrap()[1]["payload"]["workspaceBindings"],
            json!([{"workspaceId":"workspace:initial","displayName":"Initial"}])
        );
    }

    fn settings_commit(command_id: &str) -> Value {
        let settings = json!({"profileId":"profile:test","reasoningEffortOverride":"high"});
        json!({
            "command":{"schemaVersion":COMMAND_VERSION,"type":"session.model-settings.set",
                "sessionId":"session:loop","commandId":command_id,"settings":settings},
            "events":[{"type":"session.model-settings.updated","sessionId":"session:loop",
                "payload":{"commandId":command_id,"settings":settings}}],
            "reply":{"schemaVersion":REPLY_VERSION,"sessionId":"session:loop","commandId":command_id,
                "status":"accepted","revision":0}
        })
    }

    #[test]
    fn permission_commits_update_existing_descendants_atomically_and_restore_without_tools() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        let broad = json!({"agent.permissions.workspaceMutation":"allow", "agent.permissions.shell":"allow",
            "agent.permissions.shellAccess":"full", "agent.permissions.external":"allow"});
        for (id, parent) in [
            ("root", None),
            ("child", Some("root")),
            ("grandchild", Some("child")),
        ] {
            let context = parent.map(|parent| json!({"ownerSessionId":"session:root", "parentSessionId":format!("session:{parent}"),
                "parentRunId":"run:parent", "parentCallId":"call:spawn",
                "capabilities":{"messaging":true,"continuation":true,"delegation":true}}));
            journal
                .create_session_with_recipe(
                    &format!("session:{id}"),
                    id,
                    &json!([]),
                    None,
                    context.as_ref(),
                    Some(&json!({"permissions":broad})),
                    None,
                )
                .unwrap();
        }
        let old_child = journal.effective_permissions("session:child").unwrap();
        assert_eq!(
            old_child.settings["agent.permissions.workspaceMutation"],
            "allow"
        );
        let patches = json!({"agent.permissions.workspaceMutation":"plan", "agent.permissions.shell":"ask",
            "agent.permissions.shellAccess":"workspace"});
        let event = json!({"type":"session.permissions.updated","sessionId":"session:root",
            "payload":{"commandId":"command:tighten", "patches":patches}});
        let commit = json!({"command":{"schemaVersion":COMMAND_VERSION,"type":"session.permissions.set",
            "sessionId":"session:root", "commandId":"command:tighten", "patches":patches},
            "events":[event], "reply":{"schemaVersion":REPLY_VERSION,"sessionId":"session:root",
                "commandId":"command:tighten","status":"accepted","revision":0}});
        let mut invalid = commit.clone();
        invalid["events"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"run.finishing", "sessionId":"session:root",
            "runId":"run:missing", "payload":{"outcome":"cancelled"}}));
        assert!(journal.commit_command(&invalid).is_err());
        assert!(Arc::ptr_eq(
            &old_child,
            &journal.effective_permissions("session:child").unwrap()
        ));
        assert_eq!(journal.read_events("session:root", 0).unwrap().len(), 1);

        journal.commit_command(&commit).unwrap();
        for id in ["session:root", "session:child", "session:grandchild"] {
            let current = journal.effective_permissions(id).unwrap();
            assert_eq!(
                current.settings["agent.permissions.workspaceMutation"],
                "plan"
            );
            assert_eq!(
                current.settings["agent.permissions.shellAccess"],
                "workspace"
            );
        }
        assert!(!Arc::ptr_eq(
            &old_child,
            &journal.effective_permissions("session:child").unwrap()
        ));
        // A child update and a stale prepared run cannot restore the old ceiling.
        journal
            .append(
                &json!({"type":"session.permissions.updated","sessionId":"session:child",
            "payload":{"commandId":"command:child", "patches":broad}}),
            )
            .unwrap();
        let mut runtime = runtime_snapshot();
        runtime["permissions"] = crate::settings_api::permission_settings(&broad);
        journal.append(&json!({"type":"run.started","sessionId":"session:child","runId":"run:child",
            "payload":{"inputMessageId":"message:child","workspaceBindings":[],"runtimeSnapshot":runtime}})).unwrap();
        assert_eq!(
            journal
                .run_permission_settings("session:child", "run:child")
                .unwrap()["agent.permissions.workspaceMutation"],
            "plan"
        );
        assert_eq!(
            journal
                .permissions_for_run("session:grandchild", &broad)
                .unwrap()["agent.permissions.shell"],
            "ask"
        );

        drop(journal);
        let restored = LocalAgentJournal::open(&store.path()).unwrap();
        assert_eq!(
            restored
                .effective_permissions("session:grandchild")
                .unwrap()
                .settings["agent.permissions.workspaceMutation"],
            "plan"
        );
        assert_eq!(
            restored
                .effective_permissions("session:child")
                .unwrap()
                .settings["agent.permissions.shellAccess"],
            "workspace"
        );
    }

    #[test]
    fn encoded_history_publication_matches_decoded_events_and_preserves_read_errors() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        let id = "session:encoded-history";
        journal
            .create_session(id, "History", &json!([]), None, None)
            .unwrap();
        journal
            .append(&json!({"type":"message.committed", "sessionId":id,
            "payload":{"messageId":"message:text", "role":"user",
                "content":"引用 \\\"value\\\"\n🖼 ".repeat(1024)}}))
            .unwrap();
        for after in [0, 1, 2, u64::MAX] {
            let expected = journal
                .publication(
                    Value::Array(journal.read_events(id, after).unwrap()),
                    id,
                    true,
                )
                .unwrap();
            let encoded =
                serde_json::to_vec(&journal.read_events_publication(id, after).unwrap()).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&encoded).unwrap(), expected);
        }
        assert_eq!(
            journal
                .read_events_publication("session:missing", 0)
                .err()
                .unwrap()
                .code,
            journal.read_events("session:missing", 0).unwrap_err().code
        );
        let connection = Connection::open(store.path()).unwrap();
        connection
            .execute_batch("PRAGMA ignore_check_constraints=ON;")
            .unwrap();
        for payload in ["{", "[1,]", "{\"content\":\"broken\\q\"}"] {
            connection
                .execute(
                    "UPDATE session_events SET payload_json=?1 WHERE session_id=?2 AND sequence=2",
                    params![payload, id],
                )
                .unwrap();
            let decoded = journal.read_events(id, 0).unwrap_err();
            let encoded = journal.read_events_publication(id, 0).err().unwrap();
            assert_eq!(encoded.code, decoded.code);
            assert_eq!(encoded.message, decoded.message);
        }
    }

    #[test]
    fn startup_permission_replay_preserves_history_and_reports_unobserved_corruption() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        let id = "session:startup";
        journal
            .create_session(id, "Startup", &json!([]), None, None)
            .unwrap();
        let message = journal
            .append(&json!({"type":"message.committed", "sessionId":id,
                "payload":{"messageId":"message:large", "role":"user",
                    "content":"历史正文 \\\"quoted\\\"\n".repeat(8192)}}))
            .unwrap();
        let permissions = journal
            .append(&json!({"type":"session.permissions.updated", "sessionId":id,
                "payload":{"commandId":"command:permissions", "patches":{
                    "agent.permissions.shell":"ask", "agent.permissions.workspaceMutation":"plan"}}}))
            .unwrap();
        let history = journal.read_events(id, 0).unwrap();
        let expected = journal.effective_permissions(id).unwrap().settings.clone();
        assert!(!KernelPermissionModel::observes(&message));
        assert!(KernelPermissionModel::observes(&permissions));
        for kind in KernelPermissionModel::observed_event_types() {
            assert!(KernelPermissionModel::observes(&json!({"type":kind})));
        }
        drop(journal);
        let restored = LocalAgentJournal::open(&store.path()).unwrap();
        assert_eq!(
            restored.effective_permissions(id).unwrap().settings,
            expected
        );
        assert_eq!(restored.read_events(id, 0).unwrap(), history);
        drop(restored);

        // Filtering is not permission to hide corrupt history: both ignored
        // bodies and permission events must retain the original decoder error.
        let connection = Connection::open(store.path()).unwrap();
        connection
            .execute_batch("PRAGMA ignore_check_constraints=ON;")
            .unwrap();
        for event in [&message, &permissions] {
            let sequence = event["sequence"].as_i64().unwrap();
            connection
                .execute(
                    "UPDATE session_events SET payload_json='{' WHERE session_id=?1 AND sequence=?2",
                    params![id, sequence],
                )
                .unwrap();
            let error = LocalAgentJournal::open(&store.path())
                .err()
                .expect("corrupt history must fail startup");
            let original = decode_json("{", "permission_model_restore_failed").unwrap_err();
            assert_eq!(error.code, original.code);
            assert_eq!(error.message, original.message);
            connection
                .execute(
                    "UPDATE session_events SET payload_json=?3 WHERE session_id=?1 AND sequence=?2",
                    params![id, sequence, event["payload"].to_string()],
                )
                .unwrap();
        }
    }

    #[test]
    fn conversation_title_uses_only_the_first_accepted_input_identity() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        journal
            .create_session("session:title", "Title", &json!([]), None, None)
            .unwrap();
        assert_eq!(
            journal.first_input_command_id("session:title").unwrap(),
            None
        );
        for (command_id, message_id, text) in [
            (
                "command:first",
                "message:first",
                "Review the database product",
            ),
            ("command:next", "message:next", "Continue implementation"),
        ] {
            journal
                .append(
                    &json!({"type":"input.accepted", "sessionId":"session:title",
                "payload":{"commandId":command_id,"messageId":message_id,"text":text}}),
                )
                .unwrap();
        }
        assert_eq!(
            journal
                .first_input_command_id("session:title")
                .unwrap()
                .as_deref(),
            Some("command:first")
        );
        drop(journal);
        let reopened = LocalAgentJournal::open(&store.path()).unwrap();
        assert_eq!(
            reopened
                .first_input_command_id("session:title")
                .unwrap()
                .as_deref(),
            Some("command:first")
        );
    }

    #[test]
    fn journal_persists_events_and_command_receipts_without_duplicate_commits() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        journal
            .create_session(
                "session:loop",
                "Loop",
                &json!([]),
                Some("profile:test"),
                None,
            )
            .unwrap();
        append_model_settings_and_rejected_call(&journal);
        let events = journal.read_events("session:loop", 0).unwrap();
        let command = journal
            .read_command("session:loop", "command:settings")
            .unwrap();
        assert_eq!(
            journal
                .commit_command(&settings_commit("command:settings"))
                .unwrap_err()
                .code,
            "session_command_already_recorded"
        );
        assert_eq!(journal.read_events("session:loop", 0).unwrap(), events);
        assert_eq!(
            events
                .iter()
                .map(|event| event["sequence"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            (1..=events.len() as u64).collect::<Vec<_>>()
        );
        let ids = events
            .iter()
            .map(|event| event["eventId"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), events.len());
        let through = events[1]["sequence"].as_u64().unwrap();
        assert_eq!(
            journal.read_events("session:loop", through).unwrap(),
            events[2..]
        );
        drop(journal);
        let reopened = LocalAgentJournal::open(&store.path()).unwrap();
        assert_eq!(reopened.read_events("session:loop", 0).unwrap(), events);
        assert_eq!(
            reopened
                .read_command("session:loop", "command:settings")
                .unwrap(),
            command
        );
    }

    #[test]
    fn failed_event_and_command_batches_do_not_partially_write_or_consume_sequence() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:loop", "Loop", &json!([]), None, None)
            .unwrap();
        let before = journal.read_events("session:loop", 0).unwrap();
        let missing_run = json!({"type":"run.finishing","sessionId":"session:loop","runId":"run:missing","payload":{"outcome":"cancelled"}});
        let commit = settings_commit("command:atomic");
        let mut invalid = commit.clone();
        invalid["events"]
            .as_array_mut()
            .unwrap()
            .push(missing_run.clone());
        assert_eq!(
            journal.commit_command(&invalid).unwrap_err().code,
            "session_event_run_missing"
        );
        assert_eq!(journal.read_events("session:loop", 0).unwrap(), before);
        assert!(journal
            .read_command("session:loop", "command:atomic")
            .unwrap()
            .is_none());
        assert!(journal
            .append_batch(&[commit["events"][0].clone(), missing_run])
            .is_err());
        assert_eq!(journal.read_events("session:loop", 0).unwrap(), before);
        let saved = journal.commit_command(&commit).unwrap();
        assert_eq!(
            saved["revision"],
            before.last().unwrap()["sequence"].as_u64().unwrap() + 1
        );
    }

    #[test]
    fn interaction_resolution_uses_interaction_identity_without_a_tool_call() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        journal
            .create_session("session:loop", "Loop", &json!([]), None, None)
            .unwrap();
        journal.append(&json!({"type":"run.started","sessionId":"session:loop","runId":"run:loop",
            "payload":{"inputMessageId":"message:loop","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}})).unwrap();
        journal.append(&json!({"type":"interaction.requested","sessionId":"session:loop","runId":"run:loop","callId":"call:question",
            "payload":{"interactionId":"interaction:destination","providerCallId":"provider:question","kind":"confirmation",
                "prompt":"Choose a working directory", "options":[{"id":"draft","label":"Session working directory"}],"allowFreeform":false}})).unwrap();
        let resolved = json!({"type":"interaction.resolved","sessionId":"session:loop","runId":"run:loop",
            "payload":{"interactionId":"interaction:destination","commandId":"command:answer","response":"Session working directory"}});
        let mut missing = resolved.clone();
        missing["payload"]["interactionId"] = json!("interaction:missing");
        let before = journal.read_events("session:loop", 0).unwrap();
        assert_eq!(
            journal.append(&missing).unwrap_err().code,
            "session_event_interaction_missing"
        );
        assert_eq!(journal.read_events("session:loop", 0).unwrap(), before);
        journal.append(&resolved).unwrap();
        drop(journal);
        let reopened = LocalAgentJournal::open(&store.path()).unwrap();
        let events = reopened.read_events("session:loop", 0).unwrap();
        assert_eq!(events.last().unwrap()["type"], "interaction.resolved");
        assert!(events.last().unwrap().get("callId").is_none());
        assert_eq!(events.last().unwrap()["payload"], resolved["payload"]);
    }

    #[test]
    fn deferred_question_reply_keeps_its_identity_through_the_queue_and_storage() {
        let store = Store::new();
        let journal = LocalAgentJournal::open(&store.path()).unwrap();
        journal
            .create_session("session:loop", "Loop", &json!([]), None, None)
            .unwrap();
        journal.append(&json!({"type":"run.started","sessionId":"session:loop","runId":"run:loop",
            "payload":{"inputMessageId":"message:loop","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}})).unwrap();
        journal.append(&json!({"type":"interaction.requested","sessionId":"session:loop","runId":"run:loop","callId":"call:question",
            "payload":{"interactionId":"interaction:format","providerCallId":"provider:question","kind":"question","mode":"continue",
                "prompt":"Report format?","allowFreeform":true}})).unwrap();
        let queued = json!({"type":"input.queued","sessionId":"session:loop","runId":"run:loop",
            "payload":{"commandId":"command:answer","messageId":"message:answer","text":"Brief",
                "interactionId":"interaction:format"}});
        let mut missing = queued.clone();
        missing["payload"]["interactionId"] = json!("interaction:missing");
        assert_eq!(
            journal.append(&missing).unwrap_err().code,
            "session_event_interaction_missing"
        );
        let resolved = json!({"type":"interaction.resolved","sessionId":"session:loop","runId":"run:loop",
            "payload":{"interactionId":"interaction:format","commandId":"command:answer","response":"Brief"}});
        journal
            .append_batch(&[queued.clone(), resolved.clone()])
            .unwrap();
        drop(journal);
        let reopened = LocalAgentJournal::open(&store.path()).unwrap();
        let events = reopened.read_events("session:loop", 0).unwrap();
        assert_eq!(events[events.len() - 2]["payload"], queued["payload"]);
        assert_eq!(events.last().unwrap()["payload"], resolved["payload"]);
    }

    #[test]
    fn store_rejects_unknown_calls_and_duplicate_terminal_records() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session("session:loop", "Loop", &json!([]), None, None)
            .unwrap();
        journal.append(&json!({"type":"run.started","sessionId":"session:loop","runId":"run:loop",
            "payload":{"inputMessageId":"message:loop","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}})).unwrap();
        let started = json!({"type":"tool.started","sessionId":"session:loop","runId":"run:loop","callId":"call:missing",
            "payload":{"attemptId":"attempt:missing","startedAt":"1"}});
        assert_eq!(
            journal.append(&started).unwrap_err().code,
            "session_event_call_missing"
        );
        let finishing = json!({"type":"run.finishing","sessionId":"session:loop","runId":"run:loop","payload":{"outcome":"cancelled"}});
        journal.append(&finishing).unwrap();
        let before = journal.read_events("session:loop", 0).unwrap();
        assert!(journal.append(&finishing).is_err());
        assert_eq!(journal.read_events("session:loop", 0).unwrap(), before);
    }

    #[test]
    fn revised_conversation_excludes_browser_grants_but_keeps_journal_facts() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session(
                "session:loop",
                "Loop",
                &json!([]),
                Some("profile:test"),
                None,
            )
            .unwrap();
        journal.append(&json!({"type":"input.accepted","sessionId":"session:loop",
            "payload":{"commandId":"command:first","messageId":"message:loop","text":"First message"}})).unwrap();
        append_model_settings_and_rejected_call(&journal);
        let grant = |id: &str| {
            journal.append(&json!({"type":"tool.requested", "sessionId":"session:loop", "runId":"run:loop", "callId":id,
                "payload":{"providerCallId":format!("provider:{id}"),"attemptId":format!("attempt:{id}"),"toolName":"web.open","input":{}}})).unwrap();
            journal.append(&json!({"type":"approval.requested", "sessionId":"session:loop", "runId":"run:loop", "callId":id,
                "payload":{"approvalId":id,"preview":{"summary":"Use browser","effects":["external"],"logicalTargets":["browser:test"],"authorizationScope":"sessionBrowser"}}})).unwrap();
            journal.append(&json!({"type":"approval.resolved", "sessionId":"session:loop", "runId":"run:loop", "callId":id,
                "payload":{"approvalId":id,"commandId":id,"authorityId":id,"decision":"allow"}})).unwrap();
        };
        grant("call:before");
        let input = journal.append(&json!({"type":"input.accepted","sessionId":"session:loop",
            "payload":{"commandId":"command:input","messageId":"message:edit","text":"Edit this message"}})).unwrap();
        grant("call:after");
        assert_eq!(
            journal
                .session_browser_authority("session:loop")
                .unwrap()
                .as_deref(),
            Some("call:after")
        );
        let before = journal.read_events("session:loop", 0).unwrap();
        let edit_command = json!({"schemaVersion":COMMAND_VERSION,"type":"message.edit","sessionId":"session:loop",
            "commandId":"command:edit","messageId":"message:edit","expectedRevision":before.last().unwrap()["sequence"],"text":"Revised message"});
        journal.commit_command(&json!({"command":edit_command,
            "events":[{"type":"conversation.revised","sessionId":"session:loop",
                "payload":{"commandId":"command:edit","messageId":"message:edit","fromSequence":input["sequence"],"throughSequence":before.last().unwrap()["sequence"]}}],
            "reply":{"schemaVersion":REPLY_VERSION,"sessionId":"session:loop","commandId":"command:edit","status":"accepted","revision":0}
        })).unwrap();
        assert_eq!(
            journal
                .read_command("session:loop", "command:edit")
                .unwrap()
                .unwrap()["command"],
            edit_command
        );
        assert_eq!(
            journal
                .session_browser_authority("session:loop")
                .unwrap()
                .as_deref(),
            Some("call:before")
        );
        assert_eq!(
            &journal.read_events("session:loop", 0).unwrap()[..before.len()],
            before.as_slice()
        );
        let first_input = before
            .iter()
            .find(|event| event["type"] == "input.accepted")
            .unwrap();
        let latest = journal.read_events("session:loop", 0).unwrap();
        journal.append(&json!({"type":"conversation.revised","sessionId":"session:loop",
            "payload":{"commandId":"command:edit-first","messageId":first_input["payload"]["messageId"],"fromSequence":first_input["sequence"],"throughSequence":latest.last().unwrap()["sequence"]}})).unwrap();
        assert_eq!(
            journal.session_browser_authority("session:loop").unwrap(),
            None
        );
    }

    #[test]
    fn journal_uses_required_fields_instead_of_a_version_gate() {
        let store = Store::new();
        let path = store.path();
        let journal = LocalAgentJournal::open(&path).unwrap();
        journal
            .create_session("session:shape", "History", &json!([]), None, None)
            .unwrap();
        let before = journal.read_events("session:shape", 0).unwrap();
        assert_eq!(
            journal
                .lock()
                .unwrap()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            0
        );
        journal
            .lock()
            .unwrap()
            .execute_batch("PRAGMA user_version=8;")
            .unwrap();
        drop(journal);
        let reopened = LocalAgentJournal::open(&path)
            .expect("required fields remain readable independently of the informational marker");
        assert_eq!(reopened.read_events("session:shape", 0).unwrap(), before);
        assert_eq!(
            reopened
                .lock()
                .unwrap()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            8
        );
        reopened
            .lock()
            .unwrap()
            .execute_batch(
                "ALTER TABLE session_events RENAME COLUMN payload_json TO unavailable_payload;",
            )
            .unwrap();
        drop(reopened);
        let error = LocalAgentJournal::open(&path)
            .err()
            .expect("missing required column");
        assert_eq!(error.code, "session_store_schema_incomplete");
        assert!(error.message.contains("payload_json"));
    }

    #[test]
    fn provider_call_identity_is_required_and_distinct_from_logical_call_identity() {
        let event = json!({
            "type": "tool.requested",
            "sessionId": "session:identity",
            "runId": "run:identity",
            "callId": "call:logical",
            "payload": {
                "providerCallId": "provider-call:native",
                "attemptId": "attempt:one",
                "toolName": "fs.read",
                "input": {"workspaceId": "workspace:one", "path": "README.md"}
            }
        });
        validate_new_event(&event, false).expect("accept separated call identities");

        let mut missing = event.clone();
        missing["payload"]
            .as_object_mut()
            .expect("payload object")
            .remove("providerCallId");
        assert!(validate_new_event(&missing, false).is_err());

        let mut reused = event;
        reused["payload"]["providerCallId"] = json!("call:logical");
        let error = validate_new_event(&reused, false).expect_err("identity reuse must fail");
        assert_eq!(error.code, "session_event_invalid");
        assert!(error.message.contains("不能复用"));
    }
}

fn validate_session_timing(value: &Value, run: bool) -> Result<(), LocalAgentStoreError> {
    if run {
        exact_object(
            value,
            &["clockDomain", "acceptedAt", "coverage"],
            &[
                "startedAt",
                "firstResponseAt",
                "firstResponseKind",
                "firstResponseMs",
                "firstTextAt",
                "firstTextMs",
                "settledAt",
                "totalMs",
                "responseElapsedMs",
            ],
        )?;
        required_string(value, "acceptedAt")?;
        if !matches!(value["coverage"].as_str(), Some("complete" | "partial")) {
            return Err(LocalAgentStoreError::new(
                "run_timing_invalid",
                "计时覆盖范围无效。",
            ));
        }
    } else {
        exact_object(
            value,
            &["clockDomain", "startedAt"],
            &[
                "completedAt",
                "durationMs",
                "firstContentAt",
                "firstContentMs",
                "firstContentKind",
                "firstTextAt",
                "firstTextMs",
                "textSegments",
            ],
        )?;
    }
    if let Some(segments) = value.get("textSegments") {
        let segments = segments.as_array().ok_or_else(|| {
            LocalAgentStoreError::new("provider_timing_invalid", "文本段计时必须为数组。")
        })?;
        for segment in segments {
            exact_object(
                segment,
                &["outputItemId", "startedAt", "characters"],
                &["outputIndex", "endedAt", "durationMs", "outcome"],
            )?;
            required_string(segment, "outputItemId")?;
            required_string(segment, "startedAt")?;
            if !segment["characters"].is_u64()
                || segment
                    .get("outputIndex")
                    .is_some_and(|value| !value.is_u64())
                || segment
                    .get("durationMs")
                    .is_some_and(|value| !value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
                || segment.get("outcome").is_some_and(|value| {
                    !matches!(value.as_str(), Some("completed" | "interrupted"))
                })
            {
                return Err(LocalAgentStoreError::new(
                    "provider_timing_invalid",
                    "文本段计时字段无效。",
                ));
            }
            if segment.get("endedAt").is_some() {
                required_string(segment, "endedAt")?;
            }
        }
    }
    required_string(value, "clockDomain")?;
    if !run || value.get("startedAt").is_some() {
        required_string(value, "startedAt")?;
    }
    for field in [
        "firstResponseAt",
        "firstTextAt",
        "settledAt",
        "completedAt",
        "firstContentAt",
    ] {
        if value.get(field).is_some() {
            required_string(value, field)?;
        }
    }
    for field in [
        "firstResponseMs",
        "firstTextMs",
        "totalMs",
        "responseElapsedMs",
        "durationMs",
        "firstContentMs",
    ] {
        if let Some(number) = value.get(field) {
            if !number.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0) {
                return Err(LocalAgentStoreError::new(
                    "session_timing_invalid",
                    "计时时长必须是有限非负数。",
                ));
            }
        }
    }
    if value.get("firstResponseKind").is_some()
        && !matches!(value["firstResponseKind"].as_str(), Some("text" | "tool"))
        || value.get("firstContentKind").is_some()
            && !matches!(
                value["firstContentKind"].as_str(),
                Some("text" | "tool" | "reasoning")
            )
    {
        return Err(LocalAgentStoreError::new(
            "session_timing_invalid",
            "计时响应类型无效。",
        ));
    }
    Ok(())
}
