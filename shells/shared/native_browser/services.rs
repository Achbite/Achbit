use achbit_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree_checked, OwnedHostProcess,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    path::PathBuf,
    process::{Command, Stdio},
};

pub(super) struct DevelopmentService {
    process: OwnedHostProcess,
    stopped: bool,
    pub(super) description: Value,
}

impl DevelopmentService {
    fn status(&mut self) -> Result<Value, String> {
        if let Some(status) = self
            .process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
        {
            self.description["status"] = json!("exited");
            self.description["exitCode"] = json!(status.code());
            self.stop()?;
        }
        Ok(self.description.clone())
    }

    pub(super) fn stop(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        terminate_owned_process_tree_checked(&mut self.process)
            .map_err(|error| error.to_string())?;
        self.stopped = true;
        Ok(())
    }
}

impl Drop for DevelopmentService {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("Development service cleanup failed: {error}");
        }
    }
}

pub(super) fn execute(
    services: &mut HashMap<String, DevelopmentService>,
    directory: PathBuf,
    session_id: Option<&str>,
    input: &Value,
) -> Result<Value, String> {
    let action = super::string(input, "action")?;
    if action == "serviceStart" {
        let executable = super::string(input, "command")?;
        let root = PathBuf::from(super::string(input, "directory")?)
            .canonicalize()
            .map_err(|error| format!("Development directory: {error}"))?;
        if !root.is_dir() {
            return Err("Development directory is not a directory.".into());
        }
        let url = super::page_url(input)?;
        if !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
            return Err("An owned development service requires a loopback URL.".into());
        }
        // The project command owns listener admission. A Docker port forward can
        // accept TCP before any server exists, so a connection cannot prove an owner.
        let args = input["args"]
            .as_array()
            .ok_or("args must be an array of strings")?
            .iter()
            .map(|value| value.as_str().ok_or("args must be an array of strings"))
            .collect::<Result<Vec<_>, _>>()?;
        let id = format!(
            "development-{}",
            super::PAGE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let log_path = directory.join(format!("{id}.log"));
        let log = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&log_path)
            .map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|error| error.to_string())?)
            .stderr(log);
        let process = spawn_owned_host_process(&mut command)
            .map_err(|error| format!("Development service start failed: {error}"))?;
        let description = json!({"serviceId":id,"owner":"host","sessionId":session_id,"url":url.as_str(),
            "directory":root,"command":executable,"args":input["args"],"pid":process.child.id(),"status":"started","logPath":log_path});
        services.insert(
            id,
            DevelopmentService {
                process,
                stopped: false,
                description: description.clone(),
            },
        );
        return Ok(description);
    }
    if action == "serviceList" {
        let mut rows = Vec::new();
        for service in services.values_mut() {
            if session_id.is_none() || service.description["sessionId"].as_str() == session_id {
                rows.push(service.status()?);
            }
        }
        return Ok(json!({"services":rows}));
    }
    let id = super::string(input, "serviceId")?;
    let service = services
        .get_mut(id)
        .ok_or("Development service is not owned by this Host.")?;
    if session_id.is_some() && service.description["sessionId"].as_str() != session_id {
        return Err("native_browser_service_session_mismatch".into());
    }
    if action == "serviceStatus" {
        return service.status();
    }
    if action != "serviceStop" {
        return Err("Unsupported development service action.".into());
    }
    service.stop()?;
    services.remove(id);
    Ok(json!({"serviceId":id,"status":"stopped","owner":"host"}))
}
