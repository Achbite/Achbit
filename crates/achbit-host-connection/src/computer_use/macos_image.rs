//! An App swap can preserve contents and mtime but unlink the running executable.
//! ScreenCaptureKit also needs its original launch path to stop existing streams.
use super::{ComputerUseHost, Connection};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs, io,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};

#[derive(Copy, Clone, PartialEq, Eq)]
pub(super) struct FileIdentity {
    device: u64,
    inode: u64,
    modified: SystemTime,
}
impl FileIdentity {
    pub(super) fn at(path: &Path) -> io::Result<Self> {
        let m = fs::metadata(path)?;
        Ok(Self {
            device: m.dev(),
            inode: m.ino(),
            modified: m.modified()?,
        })
    }
    fn for_process(pid: libc::pid_t) -> io::Result<Self> {
        let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let len = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as _) };
        if len <= 0 {
            return Err(io::Error::last_os_error());
        }
        Self::at(Path::new(OsStr::from_bytes(&path[..len as usize])))
    }
}

const EXECUTABLE: &str = "Contents/MacOS/Achbit-Computer-Use";
/// Process-lifetime launch material, not an installation, updated App or service.
/// Keep the existing signature/bundle identifier. The Host drops the private copy
/// with the connection after its exact exit watch fires; no updater is involved.
pub(super) struct LaunchImage {
    _directory: tempfile::TempDir,
    pub(super) app: PathBuf,
    source: PathBuf,
    installed: FileIdentity,
    launched: FileIdentity,
}
impl LaunchImage {
    pub(super) fn pin(source: &Path, installed: FileIdentity) -> Result<Self, String> {
        let pin = (|| -> io::Result<_> {
            // TCC may attribute a nested helper to its signed enclosing App. A
            // loose helper changes that authority; never synthesize/re-sign a parent.
            let container = source
                .ancestors()
                .skip(1)
                .find(|p| p.extension() == Some(OsStr::new("app")))
                .unwrap_or(source);
            let cache = crate::UserDirectories::resolve()?.cache_dir;
            fs::create_dir_all(&cache)?;
            let directory = tempfile::Builder::new()
                .prefix("achbit-computer-use-")
                .tempdir_in(cache)?;
            let root = directory.path().join(
                container
                    .file_name()
                    .ok_or_else(|| io::Error::other("invalid helper bundle path"))?,
            );
            let app = root.join(source.strip_prefix(container).expect("enclosing App"));
            // Use the same APFS copy-on-write clone as signed package publication.
            // Only the nested helper launches, not the cloned GUI or Host.
            let copied = Command::new("/bin/cp")
                .arg("-ac")
                .arg(container)
                .arg(&root)
                .output()?;
            if !copied.status.success() {
                return Err(io::Error::other(
                    String::from_utf8_lossy(&copied.stderr).into_owned(),
                ));
            }
            if FileIdentity::at(&source.join(EXECUTABLE))? != installed {
                return Err(io::Error::other(
                    "installed image changed during preparation; observe again",
                ));
            }
            let verified = Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&root)
                .output()?;
            if !verified.status.success() {
                return Err(io::Error::other(
                    String::from_utf8_lossy(&verified.stderr).into_owned(),
                ));
            }
            let launched = FileIdentity::at(&app.join(EXECUTABLE))?;
            Ok(Self {
                _directory: directory,
                app,
                source: source.to_owned(),
                installed,
                launched,
            })
        })();
        pin.map_err(|e| format!("computer_component_image_prepare_failed: {e}"))
    }
}

pub(super) struct ExecutorImage {
    pid: libc::pid_t,
    launch: LaunchImage,
    // A failed observation can still own a stream if only its screenshot failed.
    owners: HashSet<(String, String)>,
}
impl ExecutorImage {
    pub(super) fn new(pid: libc::pid_t, launch: LaunchImage) -> Self {
        Self {
            pid,
            launch,
            owners: HashSet::new(),
        }
    }
    pub(super) fn current(&self, installed: FileIdentity) -> Result<bool, String> {
        if self.launch.installed != installed {
            return Ok(false);
        }
        match FileIdentity::for_process(self.pid) {
            Ok(running) => Ok(running == self.launch.launched),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!(
                "computer_executor_image_unverifiable: pid {}: {e}; no input dispatched",
                self.pid
            )),
        }
    }
    fn key(binding: &Value) -> Option<(String, String)> {
        Some((
            binding["sessionId"].as_str()?.into(),
            binding["runId"].as_str()?.into(),
        ))
    }
    pub(super) fn owns(&self, binding: &Value) -> bool {
        Self::key(binding).is_some_and(|owner| self.owners.contains(&owner))
    }
    pub(super) fn acquire(&mut self, binding: &Value) {
        if let Some(key) = Self::key(binding) {
            self.owners.insert(key);
        }
    }
    pub(super) fn release(&mut self, binding: &Value) {
        if let Some(key) = Self::key(binding) {
            self.owners.remove(&key);
        }
    }
    pub(super) fn status(&self, result: &mut Value) {
        let location = if result["ok"] == true {
            &mut result["data"]["executor"]
        } else {
            &mut result["diagnostics"]["native"]["executor"]
        };
        if location.is_object() {
            location["installedBundlePath"] = json!(self.launch.source);
        }
    }
    fn facts(&self, action: &Value) -> Value {
        json!({"stage":"executorImage","reason":"executorImageReplaced","phase":action,"executorPid":self.pid,"dispatched":false})
    }
    pub(super) fn rejection(&self, action: &Value, detail: &str) -> Value {
        json!({"ok":false,"message":format!("Computer Use executor image replaced (pid {}); {detail}", self.pid),"diagnostics":self.facts(action)})
    }
}

/// Some(reply) refuses to dispatch the original request. None authorizes retirement,
/// never replay of a grounded action. Called under the physical execute channel lock.
pub(super) fn prepare_retirement(
    c: &mut Connection,
    binding: &Value,
    input: &Value,
) -> Result<Option<Value>, String> {
    let action = &input["action"];
    if !matches!(
        action.as_str(),
        Some(
            "computer:status"
                | "computer:observe"
                | "computer:capture"
                | "computer:listApps"
                | "computer:listWindows"
        )
    ) {
        return Ok(Some(c.image.rejection(
            action,
            "no input dispatched. Observe the exact window again before acting.",
        )));
    }
    if c.image.owners.is_empty() {
        return Ok(None);
    }
    if action == "computer:status" {
        // Catalog readiness does not drop an active share or authorize a new one.
        let mut status = ComputerUseHost::exchange(c, binding, input)?;
        if status["ok"] == true {
            status["data"]["executorImage"] = c.image.facts(action);
        }
        c.image.status(&mut status);
        return Ok(Some(status));
    }
    let owner = ExecutorImage::key(binding);
    if c.image.owners.iter().any(|key| Some(key) != owner.as_ref()) {
        return Ok(Some(c.image.rejection(action, "another run still owns sharing. Wait for its release, then observe again. No input dispatched.")));
    }
    if action != "computer:observe" {
        return Ok(Some(c.image.rejection(action, "use a fresh observe to replace this run's sharing, or finish the run. No input dispatched.")));
    }
    // Check the OS selection in the native operation that starts release.
    let released = ComputerUseHost::exchange(
        c,
        binding,
        &json!({"action":"computer:releaseRun", "forImageReplacement":true}),
    )?;
    if released["ok"] != true {
        return Ok(Some(released));
    }
    if released["data"]["released"] != true {
        return Err("computer_run_release_not_acknowledged".into());
    }
    c.image.release(binding);
    Ok(None)
}
