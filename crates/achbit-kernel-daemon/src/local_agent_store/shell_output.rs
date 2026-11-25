use super::*;

// The completion and its later edit visibility are checked in the same SQLite snapshot.
// The first lookup uses the journal primary key. The subquery visits indexed edit facts.
impl SessionCatalogReader {
    pub(crate) fn shell_output(
        &self,
        session: &str,
        sequence: i64,
        run: &str,
        call: &str,
        record_id: &str,
    ) -> Result<Value, LocalAgentStoreError> {
        for (field, id) in [
            ("sessionId", session),
            ("runId", run),
            ("callId", call),
            ("recordId", record_id),
        ] {
            validate_id(field, id)?;
        }
        let missing =
            || LocalAgentStoreError::new("shell_output_not_found", "Shell 输出记录不存在。");
        let encoded: String = self.lock()?.query_row(&format!(
            "SELECT payload_json FROM session_events
             WHERE session_id=?1 AND sequence=?2 AND event_type='tool.completed' AND run_id=?3 AND call_id=?4
             AND NOT EXISTS (SELECT 1 FROM session_events INDEXED BY session_events_permission_replay
                 WHERE ({INDEXED_EVENT_TYPE}) IN ('conversation.revised','') AND session_id=?1 AND sequence>?2
                 AND CASE WHEN json_valid(payload_json) THEN ?2 BETWEEN json_extract(payload_json,'$.fromSequence')
                 AND json_extract(payload_json,'$.throughSequence') ELSE 1 END)"
        ), params![session,sequence,run,call], |row| row.get(0)).optional()
            .map_err(sql_error("session_read_failed"))?.ok_or_else(missing)?;
        let payload = decode_json(&encoded, "session_read_failed")?;
        let record = &payload["record"];
        if record["recordId"] != record_id
            || record["sessionId"] != session
            || record["runId"] != run
            || record["callId"] != call
            || record["outcome"] != "completed"
            || !matches!(
                record["preparedEffect"]["operation"].as_str(),
                Some("bash" | "powershell")
            )
        {
            return Err(missing());
        }
        let output = &record["output"];
        let (Some(stdout), Some(stderr)) = (output["stdout"].as_str(), output["stderr"].as_str())
        else {
            return Err(LocalAgentStoreError::new(
                "shell_output_invalid",
                "Shell 输出记录损坏。",
            ));
        };
        Ok(
            json!({"sessionId":session,"sequence":sequence,"runId":run,"callId":call,
            "recordId":record_id,"stdout":stdout,"stderr":stderr}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_shell_output_requires_the_visible_completion_and_all_owners() {
        let j = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        let session = "session:reading";
        j.create_session(session, "Reading", &json!([]), None, None)
            .unwrap();
        let payload = json!({"record":{"recordId":"record:1","sessionId":session,"runId":"run:1","callId":"call:1",
            "outcome":"completed","preparedEffect":{"operation":"bash"},"output":{"stdout":"雪\u{0}end","stderr":"warn\n"}}});
        let insert = |sequence, kind, data: &Value| {
            j.reader.lock().unwrap().execute("INSERT INTO session_events(session_id,sequence,event_id,event_type,run_id,call_id,payload_json,occurred_at)
                VALUES(?1,?2,?3,?4,'run:1','call:1',?5,'now')",
                params![session, sequence, format!("event:{sequence}"), kind, data.to_string()]).unwrap();
        };
        insert(2, "tool.completed", &payload);
        let read = || {
            j.reader
                .shell_output(session, 2, "run:1", "call:1", "record:1")
        };
        let output = read().unwrap();
        assert_eq!(output["stdout"], "雪\u{0}end");
        assert_eq!(output["stderr"], "warn\n");
        for (id, seq, run, call, record) in [
            ("session:other", 2, "run:1", "call:1", "record:1"),
            (session, 1, "run:1", "call:1", "record:1"),
            (session, 2, "run:2", "call:1", "record:1"),
            (session, 2, "run:1", "call:2", "record:1"),
            (session, 2, "run:1", "call:1", "record:2"),
        ] {
            assert_eq!(
                j.reader
                    .shell_output(id, seq, run, call, record)
                    .unwrap_err()
                    .code,
                "shell_output_not_found"
            );
        }
        insert(3, "message.committed", &json!({}));
        insert(
            4,
            "conversation.revised",
            &json!({"fromSequence":3,"throughSequence":3}),
        );
        assert_eq!(read().unwrap(), output);
        insert(
            5,
            "conversation.revised",
            &json!({"fromSequence":2,"throughSequence":4}),
        );
        assert_eq!(read().unwrap_err().code, "shell_output_not_found");
    }
}
