//! Live Session invalidations. Durable content remains in the Session journal/projection.
use crate::{ApiResponse, ReadyState};
use axum::response::{sse::Event, IntoResponse, Response, Sse};
use serde::Deserialize;
use serde_json::json;
use std::convert::Infallible;
use tokio::sync::broadcast;

const EVENT_CAPACITY: usize = 256;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum SessionNotification {
    Change {
        session_id: String,
    },
    Settled {
        session_id: String,
        run_id: String,
        event_sequence: u64,
        outcome: RunOutcome,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RunOutcome {
    Completed,
    Failed,
    Cancelled,
    Indeterminate,
}

pub(crate) struct SessionEvents {
    sender: broadcast::Sender<SessionNotification>,
}

impl Default for SessionEvents {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(EVENT_CAPACITY);
        Self { sender }
    }
}

impl SessionEvents {
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<SessionNotification> {
        self.sender.subscribe()
    }

    pub(crate) fn publish(&self, notification: SessionNotification) {
        // No receivers is a normal idle GUI state. Each slow receiver owns its gap.
        let _ = self.sender.send(notification);
    }
}

pub(crate) async fn conversation_events(ReadyState(state): ReadyState) -> Response {
    match state.session_service.subscribe_events() {
        Ok(receiver) => events_response(receiver),
        Err(error) => ApiResponse::error(error.code, error.message).into_response(),
    }
}

fn events_response(mut receiver: broadcast::Receiver<SessionNotification>) -> Response {
    let stream = async_stream::stream! {
        let shutdown = crate::wait_for_host_shutdown();
        tokio::pin!(shutdown);
        // The receiver exists before ready. Baseline reads cannot hide later settlements.
        yield Ok::<_, Infallible>(Event::default().event("ready").data("{}"));
        loop {
            let received = tokio::select! {
                biased;
                _ = &mut shutdown => break,
                received = receiver.recv() => received,
            };
            let notification = match received {
                Ok(notification) => notification,
                Err(broadcast::error::RecvError::Lagged(count)) => SessionNotification::Error {
                    code: "session_events_lagged".into(),
                    message: format!("Session event stream missed {count} live notifications. Reconnect and read current Session facts; completion notifications are not replayed."),
                },
                Err(broadcast::error::RecvError::Closed) => SessionNotification::Error {
                    code: "session_events_closed".into(),
                    message: "Session event stream closed. Reconnect after Session Service is available.".into(),
                },
            };
            let (name, data, terminal) = match notification {
                SessionNotification::Change { session_id } => (
                    "change", json!({"sessionId": session_id}), false,
                ),
                SessionNotification::Settled { session_id, run_id, event_sequence, outcome } => (
                    "settled", json!({"sessionId": session_id, "runId": run_id,
                        "eventSequence": event_sequence, "outcome": outcome}), false,
                ),
                SessionNotification::Error { code, message } => (
                    "error", json!({"code": code, "message": message}), true,
                ),
            };
            yield Ok(Event::default().event(name).data(data.to_string()));
            if terminal { break; }
        }
        // Dropping the HTTP body also drops this receiver, with no per-client Host task.
    };
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(session_id: &str) -> SessionNotification {
        SessionNotification::Change {
            session_id: session_id.into(),
        }
    }

    async fn body(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn live_stream_covers_fast_settlement_and_idle_child_changes_without_replaying_history() {
        let events = SessionEvents::default();
        events.publish(SessionNotification::Settled {
            session_id: "old".into(),
            run_id: "old-run".into(),
            event_sequence: 9,
            outcome: RunOutcome::Completed,
        });
        let receiver = events.subscribe();
        events.publish(change("child"));
        events.publish(change("new"));
        events.publish(SessionNotification::Settled {
            session_id: "new".into(),
            run_id: "new-run".into(),
            event_sequence: 7,
            outcome: RunOutcome::Completed,
        });
        drop(events);
        let body = body(events_response(receiver)).await;
        let frames: Vec<_> = body
            .split("\n\n")
            .filter(|frame| !frame.is_empty())
            .map(|frame| {
                let mut lines = frame.lines();
                let event = lines.next().unwrap().strip_prefix("event: ").unwrap();
                let data: serde_json::Value =
                    serde_json::from_str(lines.next().unwrap().strip_prefix("data: ").unwrap())
                        .unwrap();
                (event.to_string(), data)
            })
            .collect();
        assert_eq!(frames[0], ("ready".into(), json!({})));
        assert!(!body.contains("old-run"));
        assert!(frames.contains(&("change".into(), json!({"sessionId":"child"}))));
        assert!(frames.contains(&(
            "settled".into(),
            json!({"eventSequence":7,"outcome":"completed","runId":"new-run","sessionId":"new"})
        )));
        assert_eq!(frames.last().unwrap().1["code"], "session_events_closed");
    }

    #[tokio::test]
    async fn lag_is_explicit_and_a_disconnected_receiver_does_not_interrupt_other_consumers() {
        let events = SessionEvents::default();
        let slow = events.subscribe();
        let mut live = events.subscribe();
        for _ in 0..=EVENT_CAPACITY {
            events.publish(change("active"));
            assert_eq!(live.recv().await.unwrap(), change("active"));
        }
        let body = body(events_response(slow)).await;
        assert!(body.contains("event: error\n"));
        assert!(body.contains("session_events_lagged"));
        assert_eq!(events.sender.receiver_count(), 1);
        events.publish(change("after-disconnect"));
        assert_eq!(live.recv().await.unwrap(), change("after-disconnect"));
        drop(live);
        assert_eq!(events.sender.receiver_count(), 0);
    }
}
