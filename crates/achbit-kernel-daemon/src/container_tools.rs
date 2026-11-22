//! Optional Docker execution adapter. Admission and records remain Kernel-owned.
use achbit_kernel_runtime::executors::{
    execute_cli_command, KernelToolExecutionContext, KernelToolExecutionFailure,
    KernelToolExecutionOutcome, KernelToolExecutionResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    pub action: String,
    pub container: Option<String>,
    pub image: Option<String>,
    pub network: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub timeout: Option<u64>,
    pub reason: Option<String>,
}

pub(crate) fn input_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
        "action":{"type":"string","enum":["create","exec","inspect"]},
        "container":{"type":"string","minLength":1,"description":"Existing container name or full ID returned by create. Required for exec/inspect."},
        "image":{"type":"string","minLength":1,"description":"Linux image for create. /project is read-only; /work is writable."},
        "network":{"type":"string","minLength":1,"description":"Docker network for create; defaults to bridge. Use none for offline tests."},
        "command":{"type":"string","minLength":1,"description":"Shell command for exec. Scope is the approved container, including its existing mounts."},
        "cwd":{"type":"string","description":"Absolute container directory for exec. Omit to use the container's configured directory."},
        "timeout":{"type":"integer","minimum":1,"maximum":4294967295u64,"description":"Optional total runtime limit in seconds. Omit for no time limit."},
        "reason":{"type":"string","minLength":1,"description":"Brief purpose of this access or temporary test environment."}
    }})
}

pub(crate) fn parse(value: Value) -> Result<Input, String> {
    let input: Input = serde_json::from_value(value).map_err(|e| e.to_string())?;
    for value in [
        &input.container,
        &input.image,
        &input.network,
        &input.reason,
    ] {
        if value
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.contains('\0') || s.len() > 4096)
        {
            return Err(
                "Use a nonempty container/image/network/reason, at most 4096 bytes.".into(),
            );
        }
    }
    if input
        .timeout
        .is_some_and(|n| n == 0 || n > u64::from(u32::MAX))
    {
        return Err("timeout must be 1..4294967295 seconds".into());
    }
    if input
        .cwd
        .as_ref()
        .is_some_and(|s| !s.starts_with('/') || s.contains('\0'))
    {
        return Err("cwd must be an absolute container path".into());
    }
    match input.action.as_str() {
        "create" if input.image.is_some() && input.container.is_none() && input.command.is_none() && input.cwd.is_none() => {},
        "exec" if input.container.is_some() && input.image.is_none() && input.network.is_none() && input.command.as_ref().is_some_and(|s| !s.trim().is_empty() && !s.contains('\0') && s.len() <= 65536) => {},
        "inspect" if input.container.is_some() && input.image.is_none() && input.network.is_none() && input.command.is_none() && input.cwd.is_none() => {},
        _ => return Err("create needs image; exec needs container and command; inspect needs container. Creation settings cannot be changed by exec.".into()),
    }
    Ok(input)
}

// Publish the real PGID before running caller code. Close descendants before they
// can hold Docker's output transport open; only the independent verifier removes the marker.
const EXEC_GROUP: &str = r#"command -v setsid >/dev/null || { echo 'container exec requires setsid' >&2; exit 127; }
setsid /bin/sh -c '
    (umask 077; printf "%s\n" "$$" > "$2") || exit 1
    exec /bin/sh -c "$1"
' achbit "$1" "$2" &
wait "$!"; status=$?
if ! stop_group "$2"; then printf '%s\n' 'container exec initial cleanup unconfirmed; awaiting independent verification' >&2; fi
exit "$status""#;

// Shared by the in-container wrapper and the post-client verification attempt.
// A subshell keeps cleanup's exit/diagnostics separate from the workload's exit code.
const GROUP_CONTROL: &str = r#"stop_group() (
export LC_ALL=C
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ -f "$1" ] || fail 'container exec group marker missing; exit unconfirmed'
IFS= read -r pgid < "$1" || fail 'could not read container exec group marker'
case "$pgid" in ''|0*|1|*[!0-9]*) fail 'invalid container exec group marker';; esac
[ "$pgid" -le 2147483647 ] || fail 'invalid container exec group ID'
# A permission error is not proof of absence. Accept only ESRCH from a signal-0
# probe in the C locale; unfamiliar diagnostics are explicit cleanup failures.
group_alive() {
    cause=$(kill -0 "-$pgid" 2>&1) && return 0
    case "$cause" in *[Nn]o\ such\ process*) return 1;; esac
    fail "cannot confirm container exec group $pgid exit: $cause"
}
signal_group() {
    signal_error=$(kill "-$1" "-$pgid" 2>&1) && return 0
    if group_alive; then fail "cannot signal container exec group $pgid ($1): $signal_error"; fi
}
if group_alive; then
    signal_group TERM
    if group_alive; then signal_group KILL; fi
    attempts=0
    while group_alive; do
        [ "$attempts" -lt 40 ] || fail "container exec group $pgid still present after KILL"
        sleep 0.05 || fail 'failed waiting for container exec group exit'
        attempts=$((attempts + 1))
    done
fi
)"#;

const CLEANUP_GROUP: &str = r#"stop_group "$1" && rm -f -- "$1""#;

pub(crate) struct Containers {
    executable: PathBuf,
    // The Kernel run owns this adapter across replaceable tool catalog views.
    // Only resources requested through this adapter are owned here.
    owned: Mutex<BTreeMap<String, OwnedContainer>>,
}
struct OwnedContainer {
    context: String,
    engine: Value,
    id: String,
}

impl Containers {
    pub fn new(execution_path: &str) -> Result<Self, String> {
        let executable = std::env::split_paths(execution_path)
            .map(|p| {
                p.join(if cfg!(windows) {
                    "docker.exe"
                } else {
                    "docker"
                })
            })
            .find(|p| p.is_file())
            .ok_or("Docker CLI is unavailable in the selected execution PATH")?;
        Ok(Self {
            executable,
            owned: Mutex::new(BTreeMap::new()),
        })
    }
    fn cli(&self, context: Option<&str>, args: &[String]) -> Command {
        let mut process = Command::new(&self.executable);
        if let Some(context) = context {
            process.args(["--context", context]);
        }
        process
            .args(args)
            .env_remove("DOCKER_HOST")
            .env_remove("DOCKER_CONTEXT");
        process
    }
    fn metadata(&self, docker_context: Option<&str>, args: &[String]) -> Result<String, String> {
        let archive = MetadataArchive(
            std::env::temp_dir()
                .join(crate::utils::new_runtime_ref("achbit-docker")?.replace(':', "-")),
        );
        let context = KernelToolExecutionContext {
            output_directory: Some(archive.0.clone()),
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: vec![],
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation: Default::default(),
            progress: Default::default(),
        };
        let result = execute_cli_command(
            "container-metadata".into(),
            self.cli(docker_context, args),
            Some(15),
            "docker",
            &context,
            None,
        )
        .map_err(|e| e.to_string())?;
        if let Some(error) = result.error {
            return Err(format!(
                "{}: {}",
                error.message,
                result.output["stderr"].as_str().unwrap_or("")
            ));
        }
        if result.output["truncated"] == true {
            return Err("Docker metadata exceeded output limit".into());
        }
        Ok(result.output["stdout"]
            .as_str()
            .ok_or("Docker stdout missing")?
            .trim()
            .into())
    }
    pub fn prepare(
        &self,
        input: &Input,
        workspace: &str,
        session_workdir: Option<&Path>,
    ) -> Result<Value, String> {
        let context = self.metadata(None, &["context".into(), "show".into()])?;
        let endpoint: Value = serde_json::from_str(&self.metadata(
            Some(&context),
            &["context".into(), "inspect".into(), context.clone()],
        )?)
        .map_err(|e| e.to_string())?;
        let host = endpoint[0]["Endpoints"]["docker"]["Host"]
            .as_str()
            .ok_or("Docker context has no endpoint")?;
        let engine = json!({"context":context,"endpoint":host});
        if input.action == "create" {
            let work = session_workdir
                .ok_or("Temporary containers need a bound session working directory")?;
            return Ok(
                json!({"engine":engine,"create":{"image":input.image,"network":input.network.as_deref().unwrap_or("bridge"),"project":workspace,"workRoot":work}}),
            );
        }
        let info: Value = serde_json::from_str(&self.metadata(
            Some(&context),
            &[
                "container".into(),
                "inspect".into(),
                "--".into(),
                input.container.clone().expect("validated container"),
            ],
        )?)
        .map_err(|e| e.to_string())?;
        let info = info
            .get(0)
            .ok_or("Container inspect returned no container")?;
        let id = info["Id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Container ID missing")?;
        // Docker does not promise a stable Mounts order across inspect calls.
        // Preserve every field while giving this set a deterministic representation
        // before it becomes part of the prepared authorization scope.
        let mut mounts = info["Mounts"]
            .as_array()
            .ok_or("Container mounts missing")?
            .clone();
        mounts.sort_by_cached_key(Value::to_string);
        Ok(
            json!({"engine":engine,"id":id,"name":info["Name"],"image":info["Image"],"mounts":mounts,
            "user":info["Config"]["User"],"networkMode":info["HostConfig"]["NetworkMode"],"privileged":info["HostConfig"]["Privileged"],
            "capAdd":info["HostConfig"]["CapAdd"],"devices":info["HostConfig"]["Devices"]}),
        )
    }
    pub fn owns(&self, target: &Value) -> bool {
        self.owned
            .lock()
            .expect("container ownership")
            .values()
            .any(|c| target["id"] == c.id && target["engine"] == c.engine)
    }
    pub fn invoke(
        &self,
        id: &str,
        input: &Input,
        target: &Value,
        context: &KernelToolExecutionContext,
    ) -> Result<KernelToolExecutionResult, String> {
        let docker_context = target["engine"]["context"]
            .as_str()
            .ok_or("Prepared Docker context missing")?;
        if input.action == "inspect" {
            return Ok(KernelToolExecutionResult {
                invocation_id: id.into(),
                outcome: achbit_kernel_runtime::executors::KernelToolExecutionOutcome::Completed,
                output: target.clone(),
                error: None,
            });
        }
        if input.action == "create" {
            return self.create(id, input, target, context);
        }
        let container = target["id"]
            .as_str()
            .ok_or("Prepared container ID missing")?;
        let marker = format!(
            "/tmp/{}",
            crate::utils::new_runtime_ref("achbit-exec")?.replace(':', "-")
        );
        let mut args = vec!["exec".into()];
        if let Some(cwd) = &input.cwd {
            args.extend(["--workdir".into(), cwd.clone()]);
        }
        // Command is an argument, not interpolated into the wrapper. Cancellation owns this group only.
        args.extend([
            container.into(),
            "/bin/sh".into(),
            "-c".into(),
            format!("{GROUP_CONTROL}\n{EXEC_GROUP}"),
            "achbit".into(),
            input.command.clone().expect("validated command"),
            marker.clone(),
        ]);
        let mut result = execute_cli_command(
            id.into(),
            self.cli(Some(docker_context), &args),
            input.timeout,
            "docker",
            context,
            None,
        )
        .map_err(|e| e.to_string());
        // Killing the Docker client doesn't stop docker exec on the daemon.
        let cleanup = self.metadata(
            Some(docker_context),
            &[
                "exec".into(),
                container.into(),
                "/bin/sh".into(),
                "-c".into(),
                format!("{GROUP_CONTROL}\n{CLEANUP_GROUP}"),
                "achbit".into(),
                marker,
            ],
        );
        if let Err(error) = cleanup {
            let cleanup = format!("container process cleanup: {error}");
            match &mut result {
                Ok(result) => {
                    result.outcome = KernelToolExecutionOutcome::Failed;
                    match &mut result.error {
                        Some(error) => {
                            if error.code == "tool_execution_cancelled" {
                                // The client exited; the in-container group is unconfirmed.
                                // Jobs recognises only a confirmed cancellation by this code.
                                error.message =
                                    format!("{}: {}; {cleanup}", error.code, error.message);
                                error.code = "container_cleanup_failed".into();
                            } else {
                                error.message.push_str(&format!("; {cleanup}"));
                            }
                        }
                        None => {
                            result.error = Some(KernelToolExecutionFailure {
                                code: "container_cleanup_failed".into(),
                                message: cleanup,
                            });
                        }
                    }
                }
                Err(error) => error.push_str(&format!("; {cleanup}")),
            }
        }
        if let Ok(result) = &mut result {
            result.output["container"] = target.clone();
            result.output["command"] = json!(input.command);
            result.output["cwd"] = json!(input.cwd);
        }
        result
    }
    fn create(
        &self,
        id: &str,
        input: &Input,
        target: &Value,
        context: &KernelToolExecutionContext,
    ) -> Result<KernelToolExecutionResult, String> {
        let docker_context = target["engine"]["context"]
            .as_str()
            .ok_or("Docker context missing")?;
        let name = crate::utils::new_runtime_ref("achbit-test")?.replace(':', "-");
        let work = Path::new(
            target["create"]["workRoot"]
                .as_str()
                .ok_or("Session work root missing")?,
        )
        .join(&name);
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let source = target["create"]["project"]
            .as_str()
            .ok_or("Project root missing")?;
        if source.contains(',') || work.to_string_lossy().contains(',') {
            return Err("Docker mount paths containing commas are unsupported".into());
        }
        let args = vec![
            "create".into(),
            "--name".into(),
            name.clone(),
            "--label".into(),
            format!("achbit.owner={name}"),
            "--init".into(),
            "--network".into(),
            target["create"]["network"]
                .as_str()
                .expect("prepared network")
                .into(),
            "--mount".into(),
            format!("type=bind,src={source},dst=/project,readonly"),
            "--mount".into(),
            format!("type=bind,src={},dst=/work", work.display()),
            "--workdir".into(),
            "/work".into(),
            "--entrypoint".into(),
            "/bin/sh".into(),
            input.image.clone().expect("validated image"),
            "-c".into(),
            "while :; do sleep 3600; done".into(),
        ];
        // Register before creation so a failed/aborted client cannot orphan a created container.
        self.owned
            .lock()
            .map_err(|_| "Container ownership lock failed")?
            .insert(
                name.clone(),
                OwnedContainer {
                    context: docker_context.into(),
                    engine: target["engine"].clone(),
                    id: name.clone(),
                },
            );
        let mut result = execute_cli_command(
            id.into(),
            self.cli(Some(docker_context), &args),
            input.timeout,
            "docker",
            context,
            None,
        )
        .map_err(|e| e.to_string())?;
        if result.error.is_some() {
            return Ok(result);
        }
        let container = result.output["stdout"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("Docker create returned no container ID")?
            .to_owned();
        self.owned
            .lock()
            .map_err(|_| "Container ownership lock failed")?
            .get_mut(&name)
            .expect("registered container")
            .id = container.clone();
        self.metadata(Some(docker_context), &["start".into(), container.clone()])?;
        result.output["containerId"] = json!(container);
        result.output["engine"] = target["engine"].clone();
        result.output["projectPath"] = json!("/project");
        result.output["workPath"] = json!("/work");
        result.output["sessionPath"] = json!(work);
        result.output["network"] = target["create"]["network"].clone();
        Ok(result)
    }
    pub fn dispose(&self) -> Result<(), String> {
        let mut owned = self
            .owned
            .lock()
            .map_err(|_| "Container ownership lock failed")?;
        let mut failures = Vec::new();
        owned.retain(|name, c| {
            let result = (|| {
                let ids = self.metadata(
                    Some(&c.context),
                    &[
                        "ps".into(),
                        "-aq".into(),
                        "--filter".into(),
                        format!("label=achbit.owner={name}"),
                    ],
                )?;
                if !ids.is_empty() {
                    for id in ids.lines() {
                        self.metadata(
                            Some(&c.context),
                            &["rm".into(), "-f".into(), "-v".into(), id.into()],
                        )?;
                    }
                }
                Ok::<_, String>(())
            })();
            if let Err(error) = result {
                failures.push(error);
                true
            } else {
                false
            }
        });
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}
struct MetadataArchive(PathBuf);
impl Drop for MetadataArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn container_preparation_ignores_mount_order_but_preserves_scope_changes() {
        let root = MetadataArchive(
            std::env::temp_dir().join(
                crate::utils::new_runtime_ref("container-mount-test")
                    .unwrap()
                    .replace(':', "-"),
            ),
        );
        std::fs::create_dir_all(&root.0).unwrap();
        let executable = root.0.join("docker");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
case "$*" in
  *"context show"*) echo test ;;
  *"context inspect"*) echo '[{"Endpoints":{"docker":{"Host":"unix:///test.sock"}}}]' ;;
  *"container inspect"*) cat "$(dirname "$0")/inspect.json" ;;
  *) exit 1 ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let containers = Containers::new(root.0.to_str().unwrap()).unwrap();
        let input =
            parse(json!({"action":"exec","container":"test","command":"printf verified"})).unwrap();
        let mounts = json!([
            {"Type":"bind","Source":"/project","Destination":"/workspace","RW":true,"Propagation":"rprivate"},
            {"Type":"volume","Name":"cache","Source":"/volumes/cache","Destination":"/cache","RW":false}
        ]);
        let prepare = |mounts: Value| {
            std::fs::write(root.0.join("inspect.json"), json!([{
                "Id":"container-id","Image":"image-id","Name":"/test","Mounts":mounts,
                "Config":{"User":"1000"},"HostConfig":{"NetworkMode":"bridge","Privileged":false}
            }]).to_string()).unwrap();
            containers.prepare(&input, "/project", None)
        };
        let first = prepare(mounts.clone()).unwrap();
        let mut reordered = mounts.clone();
        reordered.as_array_mut().unwrap().reverse();
        assert_eq!(first, prepare(reordered).unwrap());
        for (field, value) in [
            ("Source", json!("/other")),
            ("Destination", json!("/other")),
            ("RW", json!(false)),
        ] {
            let mut changed = mounts.clone();
            changed[0][field] = value;
            assert_ne!(
                first,
                prepare(changed).unwrap(),
                "{field} changes authority"
            );
        }
        let mut added = mounts.clone();
        added.as_array_mut().unwrap().push(mounts[0].clone());
        assert_ne!(first, prepare(added).unwrap(), "do not drop mount entries");
        assert!(prepare(Value::Null).unwrap_err().contains("mounts missing"));
    }

    #[test]
    fn container_create_pairs_the_returned_id_with_the_prepared_engine() {
        let root = tempfile::tempdir().unwrap();
        let docker = root.path().join("docker");
        std::fs::write(&docker, r#"#!/bin/sh
case "$*" in
  'context show') echo build-remote ;;
  '--context build-remote context inspect build-remote') echo '[{"Endpoints":{"docker":{"Host":"unix:///fixture.sock"}}}]' ;;
  '--context build-remote create '*) echo created-target ;;
  '--context build-remote start created-target'|'--context build-remote ps -aq --filter '*) ;;
  *) exit 1 ;;
esac
"#).unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let containers = Containers::new(root.path().to_str().unwrap()).unwrap();
        let input = parse(json!({"action":"create", "image":"fixture"})).unwrap();
        let target = containers
            .prepare(&input, "/project", Some(root.path()))
            .unwrap();
        let context = KernelToolExecutionContext {
            output_directory: Some(root.path().join("output")),
            workspace_root: None,
            workspace_id: None,
            private_resolved_targets: vec![],
            workspace_write_targets: None,
            file_access: Default::default(),
            cancellation: Default::default(),
            progress: Default::default(),
        };
        let result = containers
            .invoke("create", &input, &target, &context)
            .unwrap();
        containers.dispose().unwrap();
        assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
        assert_eq!(result.output["containerId"], "created-target");
        assert_eq!(
            target["engine"],
            json!({"context":"build-remote", "endpoint":"unix:///fixture.sock"})
        );
        assert_eq!(result.output["engine"], target["engine"]);
    }

    #[test]
    fn container_exec_managed_cancel_requires_confirmed_cleanup() {
        use crate::managed_processes::Jobs;
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        use std::time::{Duration, Instant};

        // The fake client and the fixture-owned target have independent lifetimes, as
        // with Docker exec. Never use a daemon or signal a process outside this test.
        for mode in [
            "confirmed",
            "cleanup-unreachable",
            "no-marker",
            "signal-denied",
        ] {
            let root = MetadataArchive(
                std::env::temp_dir().join(
                    crate::utils::new_runtime_ref("container-cancel-test")
                        .unwrap()
                        .replace(':', "-"),
                ),
            );
            std::fs::create_dir_all(&root.0).unwrap();
            let docker = root.0.join("docker");
            std::fs::write(&docker, r#"#!/bin/sh
root=${0%/*}
if [ "$9" = owned-command ]; then
  echo original-stdout; echo original-stderr >&2
  : > "$root/client-ready"
  exec sleep 8
fi
case "$(cat "$root/mode")" in
  cleanup-unreachable) echo fixture-daemon-unreachable >&2; exit 9;;
  signal-denied) prefix='kill() { if [ "$1" = -0 ]; then command kill "$@"; else echo fixture-signal-denied >&2; return 1; fi; };';;
esac
# Run the actual container-side cleanup shell against an isolated path.
exec /bin/sh -c "$prefix $7" achbit "$root/marker"
"#).unwrap();
            std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::write(root.0.join("mode"), mode).unwrap();
            let target_process = if matches!(mode, "confirmed" | "signal-denied") {
                let mut child = Command::new("sleep")
                    .arg("5")
                    .process_group(0)
                    .spawn()
                    .unwrap();
                std::fs::write(root.0.join("marker"), format!("{}\n", child.id())).unwrap();
                Some(std::thread::spawn(move || child.wait().unwrap()))
            } else {
                None
            };
            let adapter = Containers::new(root.0.to_str().unwrap()).unwrap();
            let target = json!({"engine":{"context":"fixture"},"id":"fixture-container"});
            let input = parse(json!({"action":"exec","container":"fixture-container","command":"owned-command","timeout":8})).unwrap();
            let output = root.0.join("archive");
            let jobs = Jobs::default();
            jobs.start(json!({"jobId":"job:exec", "sessionId":"session:fixture", "runId":"run:fixture", "attemptId":"attempt:exec", "callId":"call:exec", "toolName":"container"}),
                move |cancellation, progress| adapter.invoke("attempt:exec", &input, &target, &KernelToolExecutionContext {
                    output_directory: Some(output), workspace_root: None, workspace_id: None, private_resolved_targets: vec![],
                    workspace_write_targets: None, file_access: Default::default(), cancellation, progress,
                })).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !root.0.join("client-ready").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            let job = jobs
                .control(
                    "session:fixture",
                    "run:fixture",
                    "job:exec",
                    "cancel",
                    Some(10),
                    &Default::default(),
                )
                .unwrap();
            jobs.release_run("session:fixture", "run:fixture").unwrap();
            let exit = target_process.map(|thread| thread.join().unwrap());
            assert!(
                root.0.join("client-ready").exists(),
                "{mode}: client never started"
            );
            assert_eq!(job["result"]["exitCode"], Value::Null);
            assert_eq!(job["result"]["timedOut"], false);
            assert_eq!(job["result"]["stdout"], "original-stdout\n");
            assert_eq!(job["result"]["stderr"], "original-stderr\n");
            assert!(job["result"]["fullOutput"]["stdout"]["path"].is_string());
            let message = job["error"]["message"].as_str().unwrap();
            assert!(message.contains("cancelled"), "{mode}: {message}");
            if mode == "confirmed" {
                assert_eq!(job["status"], "cancelled");
                assert_eq!(job["error"]["code"], "tool_execution_cancelled");
                assert!(
                    matches!(exit.unwrap().signal(), Some(15 | 9)),
                    "owned group did not receive a signal"
                );
            } else {
                assert_eq!(job["status"], "failed", "{mode}: {job}");
                assert_eq!(job["error"]["code"], "container_cleanup_failed");
                let cause = match mode {
                    "cleanup-unreachable" => "fixture-daemon-unreachable",
                    "signal-denied" => "fixture-signal-denied",
                    _ => "marker",
                };
                assert!(message.contains(cause), "{mode}: {message}");
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn container_exec_group_leader_preserves_direct_exit_and_timeout_facts() {
        let root = MetadataArchive(
            std::env::temp_dir().join(
                crate::utils::new_runtime_ref("container-exit-test")
                    .unwrap()
                    .replace(':', "-"),
            ),
        );
        std::fs::create_dir_all(&root.0).unwrap();
        let docker = root.0.join("docker");
        std::fs::write(
            &docker,
            r#"#!/bin/sh
root=${0%/*}
if [ "$#" -eq 10 ]; then
    read -r pid comm state ppid pgid rest < /proc/self/stat || exit 90
    [ "$pid" = "$pgid" ] || { echo 'fixture client not a process group leader' >&2; exit 91; }
    if [ "$9" = timeout-probe ]; then
        echo timed-output; echo timed-stderr >&2
        : > "$root/timed-out-client"
        exec sleep 4
    fi
    # Docker's output transport remains open until descendants close the pipes.
    # Start the actual wrapper as a PG leader; collect to EOF, not just its wait status.
    exec python3 -c '
import os, subprocess, sys
script, command, marker = sys.argv[1:]
check = "read -r pid comm state ppid pgid rest < /proc/self/stat && [ \"$pid\" = \"$pgid\" ] || exit 92\n"
p = subprocess.run(["/bin/sh", "-c", check + script, "achbit", command, marker], cwd=os.path.dirname(marker), start_new_session=True, capture_output=True, timeout=5)
sys.stdout.buffer.write(p.stdout); sys.stderr.buffer.write(p.stderr); sys.exit(p.returncode)
' "$7" "$9" "$root/marker"
fi
if [ -f "$root/timed-out-client" ]; then echo timeout-cleanup-unavailable >&2; exit 9; fi
exec /bin/sh -c "$7" achbit "$root/marker"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let adapter = Containers::new(root.0.to_str().unwrap()).unwrap();
        let target = json!({"engine":{"context":"fixture"},"id":"fixture-container"});
        for (i, code) in [Some(0), Some(7), None].into_iter().enumerate() {
            let cmd = code
                .map(|n| format!("(sleep 0.8; echo lingering-child; : > late-work) & sleep 0.05; echo done; echo diagnostic >&2; exit {n}"))
                .unwrap_or_else(|| "timeout-probe".into());
            let input = parse(json!({"action":"exec","container":"fixture-container","command":cmd,"timeout":if code.is_some() { 5 } else { 1 }})).unwrap();
            let result = adapter
                .invoke(
                    "direct",
                    &input,
                    &target,
                    &KernelToolExecutionContext {
                        output_directory: Some(root.0.join(format!("out-{i}"))),
                        workspace_root: None,
                        workspace_id: None,
                        private_resolved_targets: vec![],
                        workspace_write_targets: None,
                        file_access: Default::default(),
                        cancellation: Default::default(),
                        progress: Default::default(),
                    },
                )
                .unwrap();
            assert_eq!(result.output["exitCode"], json!(code));
            assert_eq!(result.output["timedOut"], code.is_none());
            if code.is_some() {
                assert_eq!(result.output["stdout"], "done\n");
                assert!(!root.0.join("late-work").exists(), "background work outlived the foreground command while Docker was draining its pipe");
                assert_eq!(result.output["stderr"], "diagnostic\n");
                assert!(
                    !root.0.join("marker").exists(),
                    "confirmed group marker was not removed"
                );
            }
            match code {
                Some(0) => assert!(result.error.is_none(), "{:?}", result.error),
                Some(_) => assert_eq!(result.error.unwrap().code, "process_exit_nonzero"),
                None => {
                    assert_eq!(result.output["stdout"], "timed-output\n");
                    assert_eq!(result.output["stderr"], "timed-stderr\n");
                    assert!(result.output["fullOutput"]["stdout"]["path"].is_string());
                    let error = result.error.unwrap();
                    assert_eq!(error.code, "process_timed_out");
                    assert!(
                        error.message.contains("1-second timeout")
                            && error.message.contains("timeout-cleanup-unavailable")
                    );
                }
            }
        }
    }

    #[test]
    fn container_cleanup_retains_execution_result() {
        let root = MetadataArchive(
            std::env::temp_dir().join(
                crate::utils::new_runtime_ref("container-cleanup-test")
                    .unwrap()
                    .replace(':', "-"),
            ),
        );
        std::fs::create_dir_all(&root.0).unwrap();
        let executable = root.0.join("docker");
        std::fs::write(
            &executable,
            "#!/bin/sh\nif [ \"$9\" = original-failure ]; then\n  echo original-output\n  echo original-error >&2\n  exit 7\nelif [ \"$9\" = original-success ]; then\n  echo original-output\n  exit 0\nfi\necho cleanup-error >&2\nexit 9\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let containers = Containers::new(root.0.to_str().unwrap()).unwrap();
        let target = json!({"engine":{"context":"test"},"id":"test-container"});
        for (command, original_failure) in [("original-failure", true), ("original-success", false)]
        {
            let input =
                parse(json!({"action":"exec","container":"test-container","command":command}))
                    .unwrap();
            let context = KernelToolExecutionContext {
                output_directory: Some(root.0.join(command)),
                workspace_root: None,
                workspace_id: None,
                private_resolved_targets: vec![],
                workspace_write_targets: None,
                file_access: Default::default(),
                cancellation: Default::default(),
                progress: Default::default(),
            };
            let result = containers
                .invoke(command, &input, &target, &context)
                .unwrap();
            assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
            assert_eq!(result.output["stdout"], "original-output\n");
            assert_eq!(
                result.output["exitCode"],
                if original_failure { 7 } else { 0 }
            );
            assert_eq!(result.output["container"], target);
            let error = result.error.unwrap();
            assert!(error.message.contains("container process cleanup"));
            assert!(error.message.contains("cleanup-error"));
            if original_failure {
                assert_eq!(error.code, "process_exit_nonzero");
                assert!(error.message.contains("status 7"));
                assert_eq!(result.output["stderr"], "original-error\n");
            } else {
                assert_eq!(error.code, "container_cleanup_failed");
            }
        }
    }
}
