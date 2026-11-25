use super::*;

/// Return only the identities that join a GUI send to Session's actual journal facts.
impl SessionCatalogReader {
    pub(crate) fn debug_input_trace(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("commandId", command_id)?;
        let connection = self.lock()?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(sql_error("debug_command_read_failed"))?;
        let command = transaction
            .query_row(
                "SELECT committed_revision, json_extract(reply_json,'$.status'),
                        json_extract(command_json,'$.type') FROM session_commands
                 WHERE session_id=?1 AND command_id=?2",
                params![session_id, command_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(sql_error("debug_command_read_failed"))?;
        let mut result = json!({"kind":"session","source":"sessionJournal","sessionId":session_id,
            "commandId":command_id,"coverage":"command-not-found","records":[]});
        let Some((revision, status, kind)) = command else {
            return Ok(result);
        };
        result["replyRevision"] = json!(revision);
        result["status"] = json!(status);
        if status == "rejected" || kind != "message.submit" {
            result["coverage"] = json!(if status == "rejected" {
                "rejected"
            } else {
                "not-message-submit"
            });
            return Ok(result);
        }
        // The receipt's exact revision is at the end of the admitted command batch.
        // SQLite seeks backwards from that boundary and returns no message payloads.
        let first = transaction.query_row(
            "SELECT sequence, json_extract(payload_json,'$.messageId') FROM session_events
             WHERE session_id=?1 AND sequence<=?2 AND event_type IN ('input.accepted','input.queued')
               AND json_extract(payload_json,'$.commandId')=?3
             ORDER BY sequence DESC LIMIT 1",
            params![session_id, revision, command_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        ).optional().map_err(sql_error("debug_command_read_failed"))?;
        let Some((sequence, message_id)) = first else {
            result["coverage"] = json!("input-not-observed");
            return Ok(result);
        };
        let mut query = transaction.prepare(
            "SELECT sequence,event_type,event_id,occurred_at,run_id FROM session_events
             WHERE session_id=?1 AND sequence>=?2 AND (
               (event_type IN ('input.accepted','input.queued') AND json_extract(payload_json,'$.commandId')=?3
                AND json_extract(payload_json,'$.messageId')=?4)
               OR (event_type='message.committed' AND json_extract(payload_json,'$.role')='user'
                AND json_extract(payload_json,'$.messageId')=?4))
             ORDER BY sequence",
        ).map_err(sql_error("debug_command_read_failed"))?;
        let rows = query
            .query_map(
                params![session_id, sequence, command_id, message_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .map_err(sql_error("debug_command_read_failed"))?;
        let mut events = Vec::new();
        let mut coverage = "commit-not-observed";
        for row in rows {
            let (sequence, event, event_id, time, run_id) =
                row.map_err(sql_error("debug_command_read_failed"))?;
            events.push(json!({"event":event,"eventId":event_id,"sequence":sequence,"occurredAt":time,"runId":run_id,
                "sessionId":session_id,"commandId":command_id,"messageId":message_id}));
            if event == "message.committed" {
                coverage = "user-message-committed";
                break;
            }
        }
        result["coverage"] = json!(coverage);
        result["records"] = json!(events);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_input_trace_joins_only_matching_admission_and_commit_without_content() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SESSION_STORE_SCHEMA).unwrap();
        let session = "session:debug";
        conn.execute(
            "INSERT INTO sessions(session_id,display_title,created_at) VALUES(?1,'test','now')",
            [session],
        )
        .unwrap();
        for (id, revision, status) in [
            ("cmd:a", 2, "accepted"),
            ("cmd:b", 4, "accepted"),
            ("cmd:c", 4, "rejected"),
            ("cmd:d", 4, "accepted"),
        ] {
            conn.execute(
                "INSERT INTO session_commands VALUES(?1,?2,?3,?4,?5,'now')",
                params![
                    session,
                    id,
                    json!({"type":"message.submit","text":"private"}).to_string(),
                    json!({"status":status}).to_string(),
                    revision
                ],
            )
            .unwrap();
        }
        let journal = SessionCatalogReader(Arc::new(Mutex::new(conn)));
        let add = |seq, kind, payload: Value| {
            journal
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO session_events VALUES(?1,?2,?3,?4,NULL,NULL,?5,'now')",
                    params![session, seq, format!("e{seq}"), kind, payload.to_string()],
                )
                .unwrap();
        };
        add(1, "session.created", json!({}));
        add(
            2,
            "input.queued",
            json!({"commandId":"cmd:a","messageId":"a","text":"private"}),
        );
        add(
            3,
            "input.accepted",
            json!({"commandId":"cmd:b","messageId":"b","text":"private"}),
        );
        add(
            4,
            "message.committed",
            json!({"role":"user","messageId":"b","content":"private"}),
        );
        assert_eq!(
            journal.debug_input_trace(session, "unknown").unwrap()["coverage"],
            "command-not-found"
        );
        assert_eq!(
            journal.debug_input_trace(session, "cmd:c").unwrap()["coverage"],
            "rejected"
        );
        let missing = journal.debug_input_trace(session, "cmd:d").unwrap();
        assert_eq!(missing["coverage"], "input-not-observed");
        assert_eq!(missing["records"], json!([]));
        let immediate = journal.debug_input_trace(session, "cmd:b").unwrap();
        assert_eq!(immediate["coverage"], "user-message-committed");
        assert_eq!(immediate["records"][0]["sequence"], 3);
        assert_eq!(immediate["records"][1]["sequence"], 4);
        assert!(immediate["records"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["messageId"] == "b" && r["commandId"] == "cmd:b"));
        let pending = journal.debug_input_trace(session, "cmd:a").unwrap();
        assert_eq!(pending["coverage"], "commit-not-observed");
        assert_eq!(pending["records"].as_array().unwrap().len(), 1);
        add(
            5,
            "input.accepted",
            json!({"commandId":"cmd:a","messageId":"a","text":"private"}),
        );
        add(
            6,
            "message.committed",
            json!({"role":"user","messageId":"a","content":"private"}),
        );
        let trace = journal.debug_input_trace(session, "cmd:a").unwrap();
        assert_eq!(trace["coverage"], "user-message-committed");
        let rows = trace["records"].as_array().unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| r["sequence"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![2, 5, 6]
        );
        assert!(rows
            .iter()
            .all(|r| r["messageId"] == "a" && r["commandId"] == "cmd:a"));
        assert!(!trace.to_string().contains("private"));
    }
}
