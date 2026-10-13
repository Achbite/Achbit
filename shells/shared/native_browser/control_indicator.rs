//! Windows embedded-page feedback consumes Session run facts between page calls.
//! Native Computer Use resources are released separately by the Kernel.
use super::{publish, NativeBrowser};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ControlState {
    active_runs: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunKey {
    session_id: String,
    run_id: String,
}

#[derive(Default)]
struct Runs(HashMap<RunKey, usize>);

impl Runs {
    fn begin(&mut self, key: RunKey) {
        *self.0.entry(key).or_default() += 1;
    }
    fn returned(&mut self, key: &RunKey) {
        if let Some(count) = self.0.get_mut(key) {
            *count -= 1;
        }
    }
    fn retire(&mut self, tracked: &[RunKey], statuses: &[SessionStatus]) -> Vec<RunKey> {
        let finished = tracked
            .iter()
            .filter(|key| self.0.get(key) == Some(&0) && run_finished(key, statuses))
            .cloned()
            .collect::<Vec<_>>();
        for key in &finished {
            self.0.remove(key);
        }
        finished
    }
}

#[derive(Default)]
pub(super) struct ControlRuns {
    runs: Mutex<Runs>,
    changed: Condvar,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatus {
    session_id: String,
    run: Option<RunStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunStatus {
    run_id: String,
    status: String,
}

fn run_finished(key: &RunKey, statuses: &[SessionStatus]) -> bool {
    let Some(session) = statuses
        .iter()
        .find(|session| session.session_id == key.session_id)
    else {
        // An absent status is unknown, not proof of completion.
        return false;
    };
    let Some(run) = &session.run else {
        return true;
    };
    run.run_id != key.run_id
        || matches!(
            run.status.as_str(),
            "completed" | "failed" | "cancelled" | "indeterminate"
        )
}

pub(super) struct ControlIndicator {
    app: tauri::AppHandle,
    key: RunKey,
}

pub(super) fn publish_current(app: &tauri::AppHandle, preview_id: &str) -> Result<(), String> {
    let state = app.state::<NativeBrowser>();
    let pages = state
        .pages
        .lock()
        .map_err(|_| "native_browser_state_unavailable")?;
    publish(
        app,
        pages.get(preview_id).ok_or("native_browser_page_closed")?,
    );
    Ok(())
}

impl ControlIndicator {
    pub(super) fn begin(
        app: &tauri::AppHandle,
        binding: &Value,
        preview_id: Option<&str>,
    ) -> Result<Self, String> {
        let key: RunKey = serde_json::from_value(binding.clone())
            .map_err(|_| "native_control_run_binding_invalid")?;
        let state = app.state::<NativeBrowser>();
        let mut runs = state
            .controls
            .runs
            .lock()
            .map_err(|_| "native_control_state_unavailable")?;
        if let Some(id) = preview_id {
            let mut pages = state
                .pages
                .lock()
                .map_err(|_| "native_browser_state_unavailable")?;
            let page = pages.get_mut(id).ok_or("native_browser_page_closed")?;
            page.control.active_runs.insert(key.run_id.clone());
            publish(app, page);
        }
        runs.begin(key.clone());
        state.controls.changed.notify_one();
        Ok(Self {
            app: app.clone(),
            key,
        })
    }
}

impl Drop for ControlIndicator {
    fn drop(&mut self) {
        let state = self.app.state::<NativeBrowser>();
        match state.controls.runs.lock() {
            Ok(mut runs) => runs.returned(&self.key),
            Err(error) => eprintln!("native_control_call_cleanup_failed: {error}"),
        };
    }
}

/// Read Session facts independently of the selected GUI tab. Snapshot tracked
/// runs before reading; a late response never ends a newly added run.
pub(super) fn start(
    app: tauri::AppHandle,
    read_statuses: Box<dyn Fn(&[String]) -> Result<Value, String> + Send + Sync>,
) {
    std::thread::spawn(move || {
        let state = app.state::<NativeBrowser>();
        let mut last_error = None;
        while !state.stop.load(Ordering::Acquire) {
            let tracked = match state.controls.runs.lock().and_then(|runs| {
                state.controls.changed.wait_while(runs, |runs| {
                    runs.0.is_empty() && !state.stop.load(Ordering::Acquire)
                })
            }) {
                Ok(runs) => runs.0.keys().cloned().collect::<Vec<_>>(),
                Err(error) => {
                    eprintln!("native_control_state_unavailable: {error}");
                    return;
                }
            };
            if state.stop.load(Ordering::Acquire) {
                return;
            }
            let sessions = tracked
                .iter()
                .map(|key| key.session_id.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let result = read_statuses(&sessions).and_then(|value| {
                serde_json::from_value::<Vec<SessionStatus>>(value)
                    .map_err(|error| error.to_string())
            });
            match result {
                Ok(statuses) => {
                    last_error = None;
                    let finished = match state.controls.runs.lock() {
                        Ok(mut runs) => runs.retire(&tracked, &statuses),
                        Err(error) => {
                            eprintln!("native_control_state_unavailable: {error}");
                            return;
                        }
                    };
                    for key in finished {
                        if let Ok(mut pages) = state.pages.lock() {
                            for page in pages.values_mut() {
                                if page.control.active_runs.remove(&key.run_id) {
                                    publish(&app, page);
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    // An unreadable status is not evidence that a run completed.
                    if last_error.as_ref() != Some(&error) {
                        eprintln!("native_control_status_failed: {error}");
                    }
                    last_error = Some(error);
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

pub(super) fn wake_on_stop(state: &NativeBrowser) {
    let _runs = state.controls.runs.lock();
    state.controls.changed.notify_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn key(run: &str) -> RunKey {
        RunKey {
            session_id: "s".into(),
            run_id: run.into(),
        }
    }
    fn status(run: &str, status: &str) -> Vec<SessionStatus> {
        serde_json::from_value(json!([{"sessionId":"s","run":{"runId":run,"status":status}}]))
            .unwrap()
    }

    #[test]
    fn operations_and_thinking_keep_feedback_until_the_run_finishes() {
        for end in ["completed", "failed", "cancelled", "indeterminate"] {
            let mut runs = Runs::default();
            runs.begin(key("a"));
            runs.returned(&key("a"));
            for phase in ["running", "waiting", "releasing"] {
                assert!(
                    runs.retire(&[key("a")], &status("a", phase)).is_empty(),
                    "{phase}"
                );
            }
            runs.begin(key("a"));
            assert!(
                runs.retire(&[key("a")], &status("a", end)).is_empty(),
                "in-flight call"
            );
            runs.returned(&key("a"));
            assert_eq!(runs.retire(&[key("a")], &status("a", end)), vec![key("a")]);
        }
    }

    #[test]
    fn late_status_read_does_not_clear_new_or_concurrent_calls() {
        let mut runs = Runs::default();
        runs.begin(key("a"));
        runs.begin(key("a"));
        runs.returned(&key("a"));
        assert!(runs
            .retire(&[key("a")], &status("a", "completed"))
            .is_empty());
        runs.returned(&key("a"));
        let tracked = vec![key("a")];
        runs.begin(key("b"));
        runs.returned(&key("b"));
        assert_eq!(runs.retire(&tracked, &status("a", "completed")), tracked);
        assert!(runs.0.contains_key(&key("b")));
        assert_eq!(
            runs.retire(&[key("b")], &status("c", "running")),
            vec![key("b")]
        );
        runs.begin(key("c"));
        runs.returned(&key("c"));
        assert!(
            runs.retire(&[key("c")], &[]).is_empty(),
            "missing status is not a terminal fact"
        );
        let deleted: Vec<SessionStatus> =
            serde_json::from_value(json!([{"sessionId":"s","run":null}])).unwrap();
        assert_eq!(runs.retire(&[key("c")], &deleted), vec![key("c")]);
    }
}
