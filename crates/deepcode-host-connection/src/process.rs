//! Platform process ownership shared by every Host shell.
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use std::process::{Child, Command};
use std::time::{Duration, Instant};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

pub struct OwnedHostProcess {
    pub child: Child,
    #[cfg(unix)]
    pub process_group_id: libc::pid_t,
    #[cfg(windows)]
    pub job: WindowsKillOnCloseJob,
}
#[cfg(windows)]
pub struct WindowsKillOnCloseJob {
    handle: Option<OwnedHandle>,
}
pub fn wait_for_child_exit(process: &mut OwnedHostProcess, attempts: usize) -> bool {
    for _ in 0..attempts {
        match process.child.try_wait() {
            Ok(Some(_)) => {
                return true;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

#[cfg(unix)]
fn owned_process_group_exists(process_group_id: libc::pid_t) -> bool {
    if unsafe { libc::kill(-process_group_id, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(unix)]
fn wait_for_owned_process_group_exit(process: &mut OwnedHostProcess, attempts: usize) -> bool {
    for _ in 0..attempts {
        let _ = process.child.try_wait();
        if !owned_process_group_exists(process.process_group_id) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !owned_process_group_exists(process.process_group_id)
}

pub fn terminate_owned_process_tree(process: &mut OwnedHostProcess) {
    let _ = terminate_owned_process_tree_checked(process);
}

pub fn terminate_owned_process_tree_checked(process: &mut OwnedHostProcess) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        signal_owned_process_group(process, libc::SIGTERM)?;
        if !wait_for_owned_process_group_exit(process, 20) {
            signal_owned_process_group(process, libc::SIGKILL)?;
        }
    }
    #[cfg(windows)]
    {
        process.job.close_checked()?;
    }
    process.child.wait().map(|_| ())
}

/// Startup retries may only proceed after the previous owned tree has disappeared.
pub fn terminate_owned_process_tree_until(
    process: &mut OwnedHostProcess,
    deadline: Instant,
) -> std::io::Result<()> {
    #[cfg(unix)]
    signal_owned_process_group(process, libc::SIGKILL)?;
    #[cfg(windows)]
    process.job.close_checked()?;
    loop {
        let child_exited = process.child.try_wait()?.is_some();
        #[cfg(unix)]
        let tree_exited = !owned_process_group_exists(process.process_group_id);
        #[cfg(not(unix))]
        let tree_exited = child_exited;
        if child_exited && tree_exited {
            return Ok(());
        }
        let left = crate::startup::remaining(deadline)?;
        std::thread::sleep(Duration::from_millis(10).min(left));
    }
}

#[cfg(unix)]
fn signal_owned_process_group(
    process: &mut OwnedHostProcess,
    signal: libc::c_int,
) -> std::io::Result<()> {
    // A group containing only an unreaped child returns EPERM on macOS.
    process.child.try_wait()?;
    if unsafe { libc::kill(-process.process_group_id, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    // The child can exit between the nonblocking wait and the signal.
    process.child.try_wait()?;
    if owned_process_group_exists(process.process_group_id) {
        Err(error)
    } else {
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn stopping_an_exited_owned_child_reaps_its_process_group() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 0"]);
        let mut process = spawn_owned_host_process(&mut command).unwrap();
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        // Observe exit without reaping, just as an unattended service can exit.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                process.child.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
        terminate_owned_process_tree_checked(&mut process).unwrap();
        assert_eq!(process.child.wait().unwrap().code(), Some(0));
        assert!(!owned_process_group_exists(process.process_group_id));
    }
}

pub fn spawn_owned_host_process(command: &mut Command) -> std::io::Result<OwnedHostProcess> {
    #[cfg(unix)]
    {
        command.process_group(0);
        let mut child = command.spawn()?;
        let pid = child.id() as libc::pid_t;
        let process_group_id = unsafe { libc::getpgid(pid) };
        if process_group_id <= 0 || process_group_id != pid {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other(
                "spawned Host child did not enter its exact owned process group",
            ));
        }
        return Ok(OwnedHostProcess {
            child,
            process_group_id,
        });
    }
    #[cfg(windows)]
    {
        let job = WindowsKillOnCloseJob::new()?;
        command.creation_flags(0x0800_0200);
        let mut child = command.spawn()?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        return Ok(OwnedHostProcess { child, job });
    }
}

#[cfg(windows)]
impl WindowsKillOnCloseJob {
    pub fn new() -> std::io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            handle: Some(handle),
        })
    }

    pub fn release_on_close(&self) -> std::io::Result<()> {
        let handle = self
            .handle
            .as_ref()
            .ok_or_else(|| std::io::Error::other("Kernel Job Object is closed"))?;
        let information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn assign(&self, child: &Child) -> std::io::Result<()> {
        let Some(handle) = self.handle.as_ref() else {
            return Err(std::io::Error::other("Host Job Object is closed"));
        };
        let process_handle = child.as_raw_handle() as HANDLE;
        if unsafe { AssignProcessToJobObject(handle.as_raw_handle() as HANDLE, process_handle) }
            == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn close(&mut self) {
        let _ = self.close_checked();
    }

    fn close_checked(&mut self) -> std::io::Result<()> {
        if let Some(handle) = self.handle.as_ref() {
            let terminated = unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    handle.as_raw_handle() as HANDLE,
                    1,
                )
            };
            if terminated == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        drop(self.handle.take());
        Ok(())
    }
}
