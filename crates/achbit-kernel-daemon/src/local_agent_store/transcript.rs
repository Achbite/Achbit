use super::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptFacts {
    tip: String,
    session_id: String,
    revision: i64,
    start: i64,
    end: i64,
    previous: Option<i64>,
    next: Option<i64>,
    navigation: Vec<Navigation>,
    compositions: Vec<Value>,
    events: Vec<JournalEvent<Box<serde_json::value::RawValue>>>,
}

#[derive(Serialize)]
struct Navigation {
    sequence: i64,
    key: String,
    label: String,
}

// Read each selected payload by its journal primary key, including sparse prior inputs.
const TRANSCRIPT_EVENTS_SQL: &str = "WITH selected AS (
    SELECT sequence FROM session_events WHERE session_id=?1 AND sequence BETWEEN ?2 AND ?3
    UNION ALL SELECT value FROM json_each(?4)
    UNION ALL SELECT sequence FROM session_events WHERE session_id=?1 AND (sequence<?2 OR sequence>?3)
    AND (event_type IN ('session.created','conversation.revised','agent.task.created','agent.task.started','agent.task.completed','agent.closed','message.feedback.updated')
      OR event_type LIKE 'plan.%'
      OR (sequence<?2 AND event_type='input.accepted' AND json_extract(payload_json,'$.messageId') IN (
          SELECT json_extract(m.payload_json,'$.messageId') FROM session_events m WHERE m.session_id=?1
          AND m.sequence BETWEEN ?2 AND ?3 AND m.event_type='message.committed' AND json_extract(m.payload_json,'$.role')='user'))
      OR (sequence<?2 AND event_type='run.settled' AND run_id IN (SELECT value FROM json_each(?5)))
      OR (sequence<?2 AND event_type IN ('session.workspaces.updated','session.directory-index.attached','session.directory-index.detached','session.model-settings.updated','session.subagent-settings.updated','session.mode.updated'))))
 SELECT e.sequence,e.event_id,e.event_type,e.occurred_at,e.run_id,e.call_id,
 CASE WHEN e.event_type='context.composed' THEN json_object('providerRequestId',json_extract(e.payload_json,'$.providerRequestId'),'purpose',json_extract(e.payload_json,'$.purpose'),'sequence',e.sequence,'runId',e.run_id)
 ELSE e.payload_json END
 FROM session_events e WHERE e.session_id=?1 AND e.sequence IN (SELECT sequence FROM selected) ORDER BY e.sequence";

impl SessionCatalogReader {
    /// A consistent cut of one human turn. Only its journal payloads and the compact facts
    /// that can affect it outside that range are materialized.
    pub(crate) fn transcript_facts(
        &self,
        id: &str,
        around: Option<i64>,
        known_tip: Option<&str>,
    ) -> Result<Option<TranscriptFacts>, LocalAgentStoreError> {
        validate_id("sessionId", id)?;
        let error = |e| sql_error("session_transcript_read_failed")(e);
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(&error)?;
        let (revision, event_id): (i64, String) = tx
            .query_row(
                "SELECT sequence,event_id FROM session_events WHERE session_id=?1 ORDER BY sequence DESC LIMIT 1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(&error)?
            .ok_or_else(|| LocalAgentStoreError::new("session_not_found", "Session 不存在。"))?;
        let anchor = around.unwrap_or(revision);
        if anchor < 1 || anchor > revision {
            return Err(LocalAgentStoreError::new(
                "conversation_read_anchor_not_found",
                "阅读位置超出会话范围。",
            ));
        }
        let tip = format!("{revision}:{event_id}");
        if known_tip == Some(tip.as_str()) {
            return Ok(None);
        }
        let ranges = {
            let mut q = tx.prepare("SELECT sequence,json_extract(payload_json,'$.fromSequence'),json_extract(payload_json,'$.throughSequence') FROM session_events WHERE session_id=?1 AND event_type='conversation.revised' ORDER BY sequence").map_err(&error)?;
            let rows = q
                .query_map([id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(&error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(&error)?
        };
        for (seq, from, through) in &ranges {
            if *from < 2 || from > through || *through != seq - 1 {
                return Err(LocalAgentStoreError::new(
                    "conversation_revision_range_invalid",
                    "会话修订范围无效。",
                ));
            }
        }
        let active = |seq: i64| !ranges.iter().any(|(_, lo, hi)| (*lo..=*hi).contains(&seq));
        let mut navigation = Vec::new();
        let mut starts = vec![1_i64];
        {
            let mut q = tx.prepare("SELECT sequence,run_id,json_extract(payload_json,'$.messageId'),
                       coalesce(nullif(substr(trim(json_extract(payload_json,'$.content')),1,180),''),json_extract(payload_json,'$.filesystemReferences[0].displayName'),'')
                    FROM session_events WHERE session_id=?1 AND event_type='message.committed'
                    AND json_extract(payload_json,'$.role')='user' ORDER BY sequence").map_err(&error)?;
            let mut rows = q.query([id]).map_err(&error)?;
            while let Some(r) = rows.next().map_err(&error)? {
                let seq = r.get(0).map_err(&error)?;
                if !active(seq) {
                    continue;
                }
                if r.get::<_, Option<String>>(1).map_err(&error)?.is_none() {
                    if navigation.is_empty() {
                        starts[0] = seq;
                    } else {
                        starts.push(seq);
                    }
                }
                navigation.push(Navigation {
                    sequence: seq,
                    key: r.get(2).map_err(&error)?,
                    label: r.get(3).map_err(&error)?,
                });
            }
        }
        let index = starts
            .partition_point(|seq| *seq <= anchor)
            .saturating_sub(1);
        let start = if index == 0 { 1 } else { starts[index] };
        let next = starts.get(index + 1).copied();
        let end = next.map_or(revision, |seq| seq - 1);
        let previous = index.checked_sub(1).map(|n| starts[n]);
        let mut events = Vec::new();
        let mut compositions = Vec::new();
        // The navigation scan already knows which user messages survived edits. Only
        // fetch old queue payloads and settlement receipts for outstanding messages.
        let mut queued = Vec::new();
        let mut queue_runs = std::collections::BTreeSet::new();
        if next.is_none() && start > 1 {
            let committed: std::collections::HashSet<_> =
                navigation.iter().map(|row| row.key.as_str()).collect();
            let mut q = tx.prepare("SELECT sequence,run_id,json_extract(payload_json,'$.messageId') FROM session_events
                WHERE session_id=?1 AND sequence<?2 AND event_type='input.queued'").map_err(&error)?;
            let mut rows = q.query(params![id, start]).map_err(&error)?;
            while let Some(row) = rows.next().map_err(&error)? {
                let seq: i64 = row.get(0).map_err(&error)?;
                let message: String = row.get(2).map_err(&error)?;
                if active(seq) && !committed.contains(message.as_str()) {
                    queued.push(seq);
                    queue_runs.insert(row.get::<_, String>(1).map_err(&error)?);
                }
            }
        }
        {
            let mut q = tx.prepare(TRANSCRIPT_EVENTS_SQL).map_err(&error)?;
            let mut rows = q
                .query(params![
                    id,
                    start,
                    end,
                    json!(queued).to_string(),
                    json!(queue_runs).to_string()
                ])
                .map_err(&error)?;
            let mut expected = start;
            while let Some(r) = rows.next().map_err(&error)? {
                let seq: i64 = r.get(0).map_err(&error)?;
                if (start..=end).contains(&seq) {
                    if seq != expected {
                        return Err(LocalAgentStoreError::new(
                            "session_event_sequence_gap",
                            "会话事件序列不连续。",
                        ));
                    }
                    expected += 1;
                }
                let payload: String = r.get(6).map_err(&error)?;
                let kind: String = r.get(2).map_err(&error)?;
                if kind == "context.composed" {
                    compositions.push(decode_json(&payload, "session_event_corrupt")?);
                    continue;
                }
                events.push(JournalEvent {
                    schema_version: EVENT_VERSION,
                    sequence: seq,
                    event_id: r.get(1).map_err(&error)?,
                    event_type: kind,
                    occurred_at: r.get(3).map_err(&error)?,
                    session_id: id.to_owned(),
                    run_id: r.get(4).map_err(&error)?,
                    call_id: r.get(5).map_err(&error)?,
                    payload: serde_json::from_str(&payload).map_err(|_| {
                        LocalAgentStoreError::new("session_event_corrupt", "会话事件 JSON 无效。")
                    })?,
                });
            }
            if expected != end + 1 {
                return Err(LocalAgentStoreError::new(
                    "session_event_sequence_gap",
                    "会话事件序列不连续。",
                ));
            }
        }
        Ok(Some(TranscriptFacts {
            tip,
            session_id: id.into(),
            revision,
            start,
            end,
            previous,
            next,
            navigation,
            compositions,
            events,
        }))
    }
}

impl SessionCatalogReader {
    /// Metadata only. The optional breakdown selects the composition of one measured Agent call.
    pub(crate) fn overview_facts(
        &self,
        id: &str,
        measurement: Option<i64>,
        run_input: Option<i64>,
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", id)?;
        let connection = self.lock()?;
        let error = |e| sql_error("session_overview_read_failed")(e);
        if let Some(sequence) = run_input {
            let input: Option<String> = connection.query_row(
                "SELECT json_object('messageId',json_extract(m.payload_json,'$.messageId'),
                   'content',json_extract(m.payload_json,'$.content'),'filesystemReferences',json((
                   SELECT json_group_array(json_object('displayName',json_extract(value,'$.displayName')))
                   FROM json_each(m.payload_json,'$.filesystemReferences'))))
                 FROM session_events r JOIN session_events m ON m.session_id=r.session_id AND m.sequence<r.sequence
                   AND m.event_type='message.committed' AND json_extract(m.payload_json,'$.role')='user'
                   AND json_extract(m.payload_json,'$.messageId')=json_extract(r.payload_json,'$.inputMessageId')
                 WHERE r.session_id=?1 AND r.sequence=?2 AND r.event_type='run.started'
                 ORDER BY m.sequence DESC LIMIT 1",params![id,sequence],|row|row.get(0)).optional().map_err(error)?;
            return decode_json(
                &input.ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "run_input_message_missing",
                        "缺少这次运行的用户输入。",
                    )
                })?,
                "session_event_corrupt",
            );
        }
        if let Some(sequence) = measurement {
            let receipt: Option<(i64,String)> = connection.query_row(
                "SELECT c.sequence,json_extract(c.payload_json,'$.partitions')
                 FROM session_events u JOIN session_events c ON c.session_id=u.session_id AND c.run_id=u.run_id
                 AND c.sequence<u.sequence AND c.event_type='context.composed'
                 AND json_extract(c.payload_json,'$.providerRequestId')=json_extract(u.payload_json,'$.providerRequestId')
                 WHERE u.session_id=?1 AND u.sequence=?2 AND u.event_type='context.updated'
                 ORDER BY c.sequence DESC LIMIT 1",params![id,sequence],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(error)?;
            let (sequence, partitions) = receipt.ok_or_else(|| {
                LocalAgentStoreError::new(
                    "provider_request_receipt_missing",
                    "缺少本次用量的请求收据。",
                )
            })?;
            return Ok(
                json!({"sequence":sequence,"partitions":decode_json(&partitions,"session_event_corrupt")?}),
            );
        }
        let revision: i64 = connection
            .query_row(
                "SELECT coalesce(max(sequence),0) FROM session_events WHERE session_id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(error)?;
        if revision == 0 {
            return Err(LocalAgentStoreError::new(
                "session_not_found",
                "Session 不存在。",
            ));
        }
        let mut stmt=connection.prepare("SELECT sequence,event_type,run_id,occurred_at,
            CASE event_type WHEN 'provider.turn.settled' THEN json_object('providerRequestId',json_extract(payload_json,'$.providerRequestId'),
              'purpose',json_extract(payload_json,'$.purpose'),'hosted',json(CASE WHEN coalesce(json_array_length(payload_json,'$.hostedWebSearchCalls'),0)>0
               OR EXISTS(SELECT 1 FROM json_each(payload_json,'$.orderedOutputBlocks') WHERE json_extract(value,'$.item.type')='web_search_call')
               THEN 'true' ELSE 'false' END))
              WHEN 'run.started' THEN json_object('boundary',json_extract(payload_json,'$.contextStart.historyThroughSequence'))
              WHEN 'run.settled' THEN json_object('outcome',json_extract(payload_json,'$.outcome'))
              WHEN 'message.committed' THEN '{}' ELSE payload_json END
            FROM session_events WHERE session_id=?1 AND sequence<=?2 AND (event_type IN
            ('provider.turn.settled','context.updated','run.started','run.settled','conversation.revised','todo.updated','artifacts.presented')
            OR (event_type='tool.completed' AND json_type(payload_json,'$.record.output.artifacts')='array')
            OR (event_type='message.committed' AND json_extract(payload_json,'$.role')='assistant')) ORDER BY sequence").map_err(error)?;
        let mut rows = stmt.query(params![id, revision]).map_err(error)?;
        let mut events = Vec::new();
        while let Some(r) = rows.next().map_err(error)? {
            let payload: String = r.get(4).map_err(error)?;
            events.push(json!({"sessionId":id,"sequence":r.get::<_,i64>(0).map_err(error)?,"type":r.get::<_,String>(1).map_err(error)?,
            "runId":r.get::<_,Option<String>>(2).map_err(error)?,"occurredAt":r.get::<_,String>(3).map_err(error)?,"payload":decode_json(&payload,"session_event_corrupt")?}));
        }
        Ok(json!({"sessionId":id,"revision":revision,"events":events}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_reads_only_outstanding_prior_inputs_and_their_settlements() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queue.sqlite");
        let journal = LocalAgentJournal::open(&path).unwrap();
        let id = "session:queue";
        journal
            .create_session(id, "Queue", &json!([]), None, None)
            .unwrap();
        let conn = Connection::open(&path).unwrap();
        let user = |id| json!({"messageId":id,"role":"user","content":id});
        for (index, (kind, run, payload)) in [
            ("message.committed", None, user("first")),
            ("input.queued", Some("old"), json!({"messageId":"applied"})),
            ("input.queued", Some("old"), json!({"messageId":"pending"})),
            ("message.committed", Some("old"), user("applied")),
            ("run.settled", Some("old"), json!({"outcome":"cancelled"})),
            ("message.committed", None, user("second")),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute("INSERT INTO session_events(session_id,sequence,event_id,event_type,occurred_at,run_id,payload_json)
                VALUES(?1,?2,?3,?4,'now',?5,?6)",params![id,index as i64+2,format!("q-{index}"),kind,run,payload.to_string()]).unwrap();
        }
        let reader = SessionCatalogReader::open(&path).unwrap();
        let tail = reader.transcript_facts(id, None, None).unwrap().unwrap();
        let prior: Vec<_> = tail
            .events
            .iter()
            .filter(|e| e.sequence < tail.start && e.sequence > 1)
            .map(|e| e.sequence)
            .collect();
        assert_eq!(prior, [4, 6]);
    }

    #[test]
    fn turn_boundary_includes_only_the_matching_prior_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("same.sqlite");
        let id = "session:same";
        let journal = LocalAgentJournal::open(&path).unwrap();
        journal
            .create_session(id, "Same", &json!([]), None, None)
            .unwrap();
        for mid in ["first", "second"] {
            journal.append(&json!({"type":"input.accepted","sessionId":id,"payload":{"messageId":mid,"commandId":format!("send:{mid}"),"text":"same"}})).unwrap();
            journal.append(&json!({"type":"message.committed","sessionId":id,"payload":{"messageId":mid,"role":"user","content":"same"}})).unwrap();
        }
        let facts = SessionCatalogReader::open(&path)
            .unwrap()
            .transcript_facts(id, None, None)
            .unwrap()
            .unwrap();
        let prior: Vec<_> = facts
            .events
            .iter()
            .filter(|e| e.event_type == "input.accepted")
            .collect();
        assert_eq!(prior.len(), 1);
        assert_eq!(prior[0].sequence, facts.start - 1);
        assert_eq!(
            serde_json::from_str::<Value>(prior[0].payload.get()).unwrap()["commandId"],
            "send:second"
        );
    }

    #[test]
    fn tail_query_work_grows_linearly_with_prior_events() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.sqlite");
        let journal = LocalAgentJournal::open(&path).unwrap();
        let conn = Connection::open(&path).unwrap();
        let steps = |count: i64| {
            let id = format!("session:tail-{count}");
            journal
                .create_session(&id, "History", &json!([]), None, None)
                .unwrap();
            conn.execute("WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<?2)
                INSERT INTO session_events(session_id,sequence,event_id,event_type,payload_json,occurred_at)
                SELECT ?1,n+1,?1 || '-' || n,'message.committed','{}','now' FROM history", params![id,count]).unwrap();
            let mut query = conn.prepare(TRANSCRIPT_EVENTS_SQL).unwrap();
            let sequences = query
                .query_map(params![id, count + 1, count + 1, "[]", "[]"], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(sequences, [1, count + 1]);
            query.get_status(rusqlite::StatementStatus::VmStep)
        };
        let small = steps(128);
        let large = steps(512);
        assert!(
            large < small * 6,
            "four times the history took {large} VM steps versus {small}"
        );
    }

    #[test]
    fn formal_page_cursors_enclose_complete_turns_and_keep_compact_composition_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.sqlite3");
        let journal = LocalAgentJournal::open(&path).unwrap();
        let id = "session:transcript-real";
        journal
            .create_session(id, "Read", &json!([]), None, None)
            .unwrap();
        let reader = SessionCatalogReader::open(&path).unwrap();
        for label in ["one", "two"] {
            journal.append(&json!({"type":"message.committed","sessionId":id,"payload":{"role":"user","messageId":label,"content":label}})).unwrap();
        }
        let connection = Connection::open(&path).unwrap();
        connection.execute("INSERT INTO session_events(session_id,sequence,event_id,event_type,occurred_at,run_id,payload_json)
         VALUES(?1,4,'receipt','context.composed','4','run',?2)",params![id,r#"{"providerRequestId":"req","purpose":"agent","messages":[{"content":"private-prompt"}]}"#]).unwrap();
        let tail = reader.transcript_facts(id, None, None).unwrap().unwrap();
        assert_eq!(
            (tail.start, tail.end, tail.previous, tail.next),
            (3, 4, Some(2), None)
        );
        assert_eq!(tail.navigation.len(), 2);
        assert!(reader
            .transcript_facts(id, None, Some(&tail.tip))
            .unwrap()
            .is_none());
        assert_eq!(
            tail.compositions[0],
            json!({"providerRequestId":"req","runId":"run","purpose":"agent","sequence":4})
        );
        assert!(!serde_json::to_string(&tail)
            .unwrap()
            .contains("private-prompt"));
        let first = reader
            .transcript_facts(id, tail.previous, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            (first.start, first.end, first.previous, first.next),
            (1, 2, None, Some(3))
        );
        assert_eq!(
            reader
                .transcript_facts(id, Some(5), None)
                .err()
                .unwrap()
                .code,
            "conversation_read_anchor_not_found"
        );
        connection
            .execute(
                "UPDATE session_events SET sequence=5 WHERE sequence=4 AND session_id=?1",
                [id],
            )
            .unwrap();
        assert_eq!(
            reader
                .transcript_facts(id, None, Some(&tail.tip))
                .err()
                .unwrap()
                .code,
            "session_event_sequence_gap"
        );
    }
}
