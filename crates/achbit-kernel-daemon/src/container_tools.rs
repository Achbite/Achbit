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

pub(crate) struct Containers {
    executable: PathBuf,
    // Only resources successfully requested through this prepared plugin are owned here.
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
        args.extend([container.into(),"/bin/sh".into(),"-c".into(),
            "command -v setsid >/dev/null || { echo 'container exec requires setsid' >&2; exit 127; }; setsid /bin/sh -c \"$1\" & child=$!; printf '%s' \"$child\" > \"$2\"; wait \"$child\"; status=$?; kill -TERM -\"$child\" 2>/dev/null || :; kill -KILL -\"$child\" 2>/dev/null || :; rm -f -- \"$2\"; exit \"$status\"".into(),
            "achbit".into(),input.command.clone().expect("validated command"),marker.clone()]);
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
        let cleanup = self.metadata(Some(docker_context), &["exec".into(),container.into(),"/bin/sh".into(),"-c".into(),
            "if [ -f \"$1\" ]; then read -r pid < \"$1\" || :; kill -TERM -\"$pid\" 2>/dev/null || :; kill -KILL -\"$pid\" 2>/dev/null || :; rm -f -- \"$1\"; fi".into(),"achbit".into(),marker]);
        if let Err(error) = cleanup {
            let cleanup = format!("container process cleanup: {error}");
            match &mut result {
                Ok(result) => {
                    result.outcome = KernelToolExecutionOutcome::Failed;
                    match &mut result.error {
                        Some(error) => error.message.push_str(&format!("; {cleanup}")),
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
