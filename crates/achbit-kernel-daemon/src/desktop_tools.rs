//! Native desktop execution belongs to the shared Host, independently of GUI windows.
use crate::browser_tools::NativeError;
use achbit_kernel_runtime::executors::KernelToolExecutionContext;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

pub(crate) trait DesktopExecutor: Send + Sync {
    fn call(&self, binding: &Value, input: &Value) -> Result<Value, String>;
    fn stop(&self) -> Result<(), String>;
    fn try_call_existing(&self, binding: &Value, input: &Value) -> Result<Option<Value>, String> {
        self.call(binding, input).map(Some)
    }
    fn call_existing(&self, binding: &Value, input: &Value) -> Result<Value, String> {
        self.try_call_existing(binding, input)?
            .ok_or_else(|| "computer_component_busy".into())
    }
}

#[cfg(any(target_os = "macos", windows))]
impl DesktopExecutor for achbit_host_connection::computer_use::ComputerUseHost {
    fn call(&self, binding: &Value, input: &Value) -> Result<Value, String> {
        self.call(binding, input)
    }
    fn stop(&self) -> Result<(), String> {
        self.stop()
    }
    fn try_call_existing(&self, binding: &Value, input: &Value) -> Result<Option<Value>, String> {
        self.try_call_existing(binding, input)
    }
    fn call_existing(&self, binding: &Value, input: &Value) -> Result<Value, String> {
        self.call_existing(binding, input)
    }
}

pub(crate) struct DesktopHost {
    instance_id: String,
    executor: Result<Arc<dyn DesktopExecutor>, String>,
    runs: Mutex<HashSet<(String, String)>>,
}

impl DesktopHost {
    #[cfg(test)]
    pub(crate) fn for_test(instance_id: &str, executor: Arc<dyn DesktopExecutor>) -> Arc<Self> {
        Arc::new(Self {
            instance_id: instance_id.into(),
            executor: Ok(executor),
            runs: Mutex::new(HashSet::new()),
        })
    }

    pub(crate) fn new(instance_id: String, token: String) -> Self {
        #[cfg(any(target_os = "macos", windows))]
        let executor =
            achbit_host_connection::computer_use::ComputerUseHost::new(instance_id.clone(), token)
                .map(|executor| Arc::new(executor) as Arc<dyn DesktopExecutor>);
        #[cfg(not(any(target_os = "macos", windows)))]
        let executor = {
            let _ = token;
            Err("Native desktop control requires macOS or Windows.".into())
        };
        Self {
            instance_id,
            executor,
            runs: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn unbound() -> Self {
        Self {
            instance_id: String::new(),
            executor: Err("No desktop executor is attached to this Host.".into()),
            runs: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn run(self: &Arc<Self>, session: &str, run: &str) -> DesktopRun {
        DesktopRun {
            host: self.clone(),
            session: session.into(),
            run: run.into(),
        }
    }

    fn binding(&self, session: &str, run: &str) -> Value {
        json!({"hostInstanceId":self.instance_id,"sessionId":session,"runId":run})
    }

    fn call(&self, session: &str, run: &str, input: &Value) -> Result<Value, NativeError> {
        let executor = self.executor.as_ref().map_err(Clone::clone)?;
        // Retain before dispatch: a failed response may still have acquired resources.
        self.runs
            .lock()
            .map_err(|_| "computer_run_registry_unavailable")?
            .insert((session.into(), run.into()));
        decode(executor.call(&self.binding(session, run), input)?)
    }

    pub(crate) fn release_run(&self, session: &str, run: &str) -> Result<(), String> {
        let key = (session.into(), run.into());
        if !self
            .runs
            .lock()
            .map_err(|_| "computer_run_registry_unavailable")?
            .contains(&key)
        {
            return Ok(());
        }
        let executor = self.executor.as_ref().map_err(Clone::clone)?;
        let released = decode(executor.call(
            &self.binding(session, run),
            &json!({"action":"computer:releaseRun"}),
        )?)
        .map_err(String::from)?;
        if released["released"] != true {
            return Err("computer_run_release_not_acknowledged".into());
        }
        // Do not hold the ownership registry while waiting for physical release:
        // the independent preview reader must still report stopping/failure.
        self.runs
            .lock()
            .map_err(|_| "computer_run_registry_unavailable")?
            .remove(&key);
        Ok(())
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        if let Ok(executor) = &self.executor {
            executor.stop()?;
        }
        self.runs
            .lock()
            .map_err(|_| "computer_run_registry_unavailable")?
            .clear();
        Ok(())
    }

    /// A private GUI view of already-owned resources; no tool event or artifact
    /// is produced, and merely opening the floating preview acquires nothing.
    pub(crate) fn preview(
        &self,
        session: &str,
        run: &str,
        after_sequence: Option<u64>,
    ) -> Result<Value, NativeError> {
        if !self.owns_run(session, run)? {
            return Ok(json!({"state":"inactive"}));
        }
        let executor = self.executor.as_ref().map_err(Clone::clone)?;
        match executor.try_call_existing(
            &self.binding(session, run),
            &json!({
                "action":"computer:preview", "afterSequence":after_sequence,
            }),
        )? {
            Some(response) => decode(response),
            None => Ok(json!({"pending":true})),
        }
    }

    /// This navigation gesture raises only the currently shared window. The
    /// helper validates source generation before changing focus; no input fires.
    pub(crate) fn activate_target(
        &self,
        session: &str,
        run: &str,
        window: u32,
        generation: u64,
    ) -> Result<Value, NativeError> {
        if !self.owns_run(session, run)? {
            return Err("computer_run_not_active".into());
        }
        if window == 0 || generation == 0 {
            return Err("computer_preview_target_invalid".into());
        }
        let executor = self.executor.as_ref().map_err(Clone::clone)?;
        let response = executor.call_existing(
            &self.binding(session, run),
            &json!({
                "action":"computer:activateTarget", "windowId":window, "generation":generation,
            }),
        )?;
        decode(response)
    }

    fn owns_run(&self, session: &str, run: &str) -> Result<bool, NativeError> {
        Ok(self
            .runs
            .lock()
            .map_err(|_| "computer_run_registry_unavailable")?
            .contains(&(session.into(), run.into())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Executor {
        calls: Mutex<Vec<(Value, Value)>>,
        releases: Mutex<VecDeque<Value>>,
    }
    impl DesktopExecutor for Executor {
        fn call(&self, binding: &Value, input: &Value) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push((binding.clone(), input.clone()));
            if input["action"] == "computer:releaseRun" {
                return Ok(self
                    .releases
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected release"));
            }
            Ok(json!({"ok":true,"data":{"permissions":{"accessibility":true}}}))
        }
        fn stop(&self) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn native_run_release_is_scoped_idempotent_and_keeps_failed_ownership() {
        let executor = Arc::new(Executor {
            calls: Mutex::new(vec![]),
            releases: Mutex::new(VecDeque::from([
                json!({"ok":false,"message":"native stop failed","diagnostics":{"stage":"streamStop"}}),
                json!({"ok":true,"data":{"released":true}}),
                json!({"ok":true,"data":{"released":true}}),
            ])),
        });
        let host = DesktopHost::for_test("host:test", executor.clone());
        host.call("session:a", "run:a", &json!({"action":"computer:observe"}))
            .unwrap();
        host.call("session:a", "run:a", &json!({"action":"computer:observe"}))
            .unwrap();
        host.call("session:a", "run:b", &json!({"action":"computer:observe"}))
            .unwrap();
        assert_eq!(
            host.release_run("session:a", "run:a").unwrap_err(),
            "native stop failed"
        );
        assert!(host
            .runs
            .lock()
            .unwrap()
            .contains(&("session:a".into(), "run:a".into())));
        host.release_run("session:a", "run:a").unwrap();
        host.release_run("session:a", "run:a").unwrap();
        host.release_run("session:a", "unused").unwrap();
        host.release_run("other-session", "run:b").unwrap();
        assert!(host
            .runs
            .lock()
            .unwrap()
            .contains(&("session:a".into(), "run:b".into())));
        host.release_run("session:a", "run:b").unwrap();
        let calls = executor.calls.lock().unwrap();
        let released: Vec<_> = calls
            .iter()
            .filter(|(_, input)| input["action"] == "computer:releaseRun")
            .map(|(binding, _)| binding.clone())
            .collect();
        assert_eq!(
            released,
            vec![
                host.binding("session:a", "run:a"),
                host.binding("session:a", "run:a"),
                host.binding("session:a", "run:b")
            ]
        );
        assert!(calls
            .iter()
            .all(|(binding, _)| binding.as_object().unwrap().len() == 3));
        assert!(host.runs.lock().unwrap().is_empty());
    }

    #[test]
    fn native_errors_preserve_diagnostics_and_unbound_host_is_explicit() {
        let error = decode(
            json!({"ok":false,"message":"sharing_stopped","diagnostics":{"stage":"userStop"}}),
        )
        .unwrap_err();
        assert_eq!(error.message, "sharing_stopped");
        assert_eq!(error.diagnostics, json!({"stage":"userStop"}));
        assert_eq!(
            Arc::new(DesktopHost::unbound())
                .run("s", "r")
                .status()
                .unwrap_err()
                .message,
            "No desktop executor is attached to this Host."
        );
    }

    #[test]
    fn preview_and_focus_only_address_an_owned_run_through_presentation() {
        struct Presentation(Mutex<Vec<(Value, Value)>>);
        impl DesktopExecutor for Presentation {
            fn call(&self, _: &Value, _: &Value) -> Result<Value, String> {
                panic!("presentation must not acquire resources through tool execution")
            }
            fn stop(&self) -> Result<(), String> {
                Ok(())
            }
            fn try_call_existing(
                &self,
                binding: &Value,
                input: &Value,
            ) -> Result<Option<Value>, String> {
                assert_eq!(input["action"], "computer:preview");
                self.0
                    .lock()
                    .unwrap()
                    .push((binding.clone(), input.clone()));
                Ok(Some(json!({"ok":true,"data":{"state":"active"}})))
            }
            fn call_existing(&self, binding: &Value, input: &Value) -> Result<Value, String> {
                assert_eq!(input["action"], "computer:activateTarget");
                self.0
                    .lock()
                    .unwrap()
                    .push((binding.clone(), input.clone()));
                Ok(json!({"ok":true,"data":{"activated":true}}))
            }
        }
        let executor = Arc::new(Presentation(Mutex::new(vec![])));
        let host = DesktopHost::for_test("host:preview", executor.clone());
        assert_eq!(
            host.preview("s", "r", None).unwrap(),
            json!({"state":"inactive"})
        );
        assert_eq!(
            host.activate_target("s", "r", 7, 2).unwrap_err().message,
            "computer_run_not_active"
        );
        assert!(executor.0.lock().unwrap().is_empty());
        host.runs.lock().unwrap().insert(("s".into(), "r".into()));
        host.preview("s", "r", Some(19)).unwrap();
        host.activate_target("s", "r", 7, 2).unwrap();
        assert_eq!(
            host.activate_target("s", "r", 0, 2).unwrap_err().message,
            "computer_preview_target_invalid"
        );
        assert_eq!(
            host.preview("other", "r", None).unwrap(),
            json!({"state":"inactive"})
        );
        assert_eq!(
            *executor.0.lock().unwrap(),
            vec![
                (
                    json!({"hostInstanceId":"host:preview","sessionId":"s","runId":"r"}),
                    json!({"action":"computer:preview","afterSequence":19})
                ),
                (
                    json!({"hostInstanceId":"host:preview","sessionId":"s","runId":"r"}),
                    json!({"action":"computer:activateTarget","windowId":7,"generation":2})
                ),
            ]
        );
        assert_eq!(host.runs.lock().unwrap().len(), 1);
    }

    #[test]
    fn unavailable_presentation_preserves_the_native_failure() {
        struct Presentation;
        impl DesktopExecutor for Presentation {
            fn call(&self, _: &Value, _: &Value) -> Result<Value, String> {
                unreachable!()
            }
            fn stop(&self) -> Result<(), String> {
                Ok(())
            }
            fn try_call_existing(&self, _: &Value, _: &Value) -> Result<Option<Value>, String> {
                Err("computer_preview_disconnected".into())
            }
        }
        let host = DesktopHost::for_test("host:preview", Arc::new(Presentation));
        host.runs.lock().unwrap().insert(("s".into(), "r".into()));
        assert_eq!(
            host.preview("s", "r", None).unwrap_err().message,
            "computer_preview_disconnected"
        );
        assert_eq!(host.runs.lock().unwrap().len(), 1);
    }
}

fn decode(response: Value) -> Result<Value, NativeError> {
    match response["ok"].as_bool() {
        Some(true) => Ok(response["data"].clone()),
        Some(false) => Err(NativeError {
            message: response["message"]
                .as_str()
                .ok_or("Native failure is missing its message")?
                .into(),
            diagnostics: response["diagnostics"].clone(),
        }),
        None => Err("computer_component_response_invalid".into()),
    }
}

#[derive(Clone)]
pub(crate) struct DesktopRun {
    host: Arc<DesktopHost>,
    session: String,
    run: String,
}

impl DesktopRun {
    /// Read-only execution readiness; no capture, focus change or permission request.
    pub(crate) fn status(&self) -> Result<Value, NativeError> {
        // Preparation does not acquire run resources. The shared connection remains
        // Host-owned even if catalog installation later fails.
        let executor = self.host.executor.as_ref().map_err(Clone::clone)?;
        decode(executor.call(
            &self.host.binding(&self.session, &self.run),
            &json!({"action":"computer:status"}),
        )?)
    }

    pub(crate) fn execute(
        &self,
        mut input: Value,
        context: &KernelToolExecutionContext,
        invocation_id: &str,
    ) -> Result<Value, NativeError> {
        if context.cancellation.is_cancelled() {
            return Err("tool_cancelled".into());
        }
        let directory = context
            .output_directory
            .as_ref()
            .ok_or("artifact_storage_unavailable")?;
        input["action"] = json!(format!(
            "computer:{}",
            input["action"].as_str().ok_or("computer_action_missing")?
        ));
        input["captureDirectory"] = json!(directory);
        let mut result = self.host.call(&self.session, &self.run, &input)?;
        crate::browser_tools::attach_observation(&mut result, invocation_id);
        Ok(result)
    }
}
