//! An installation lease protects program files, independently of user-data roots.
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Installation {
    root: Option<PathBuf>,
    lease: Mutex<Option<File>>,
}

impl Installation {
    pub fn current() -> io::Result<Self> {
        let executable = std::env::current_exe()?;
        let directory = executable
            .parent()
            .ok_or_else(|| io::Error::other("Executable has no parent"))?;
        let resources = crate::runtime_root(directory)?;
        // Cargo/dev-server programs do not participate in installed-product updates.
        let root = if !resources.join("BUILDINFO.json").is_file() {
            None
        } else if cfg!(target_os = "macos") {
            Some(
                directory
                    .parent()
                    .and_then(Path::parent)
                    .ok_or_else(|| io::Error::other("Application bundle path is invalid"))?
                    .to_path_buf(),
            )
        } else if cfg!(target_os = "linux") {
            Some(
                std::env::var_os("APPIMAGE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| directory.to_path_buf()),
            )
        } else {
            Some(directory.to_path_buf())
        };
        let installation = Self {
            root,
            lease: Mutex::new(None),
        };
        installation.resume()?;
        Ok(installation)
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    fn file(&self, kind: &str) -> io::Result<Option<File>> {
        let Some(root) = &self.root else {
            return Ok(None);
        };
        let parent = root
            .parent()
            .ok_or_else(|| io::Error::other("Installation parent is missing"))?;
        let name = root
            .file_name()
            .ok_or_else(|| io::Error::other("Installation name is missing"))?
            .to_string_lossy();
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(parent.join(format!(".{name}.{kind}.lock")))
            .map(Some)
    }

    pub fn resume(&self) -> io::Result<()> {
        let mut lease = self
            .lease
            .lock()
            .map_err(|_| io::Error::other("Installation lease poisoned"))?;
        if lease.is_some() {
            return Ok(());
        }
        if let Some(file) = self.file("runtime")? {
            FileExt::try_lock_shared(&file)?;
            *lease = Some(file);
        }
        Ok(())
    }

    pub fn release(&self) -> io::Result<()> {
        self.lease
            .lock()
            .map_err(|_| io::Error::other("Installation lease poisoned"))?
            .take();
        Ok(())
    }

    pub fn exclusive(&self) -> io::Result<File> {
        let file = self
            .file("runtime")?
            .ok_or_else(|| io::Error::other("This is not an installed runtime"))?;
        FileExt::try_lock_exclusive(&file)?;
        Ok(file)
    }

    pub fn update_owner(&self) -> io::Result<File> {
        let file = self
            .file("update")?
            .ok_or_else(|| io::Error::other("This is not an installed runtime"))?;
        FileExt::try_lock_exclusive(&file)?;
        Ok(file)
    }
}

pub fn wait_for_process_exit(pid: u32, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        #[cfg(unix)]
        let running = {
            // A shared Host can still be our OS child after its Child handle is
            // released. Reap that exact child before testing a detached Host.
            let result = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
            if result > 0 {
                false
            } else if result == 0 {
                true
            } else {
                let error = io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::ECHILD) => {
                        (unsafe { libc::kill(pid as i32, 0) }) == 0
                            || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
                    }
                    Some(libc::EINTR) => continue,
                    _ => return Err(error),
                }
            }
        };
        #[cfg(windows)]
        let running = {
            use windows_sys::Win32::{
                Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
            };
            let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if process.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32) {
                    return Err(error);
                }
                false
            } else {
                let result = unsafe { WaitForSingleObject(process, 0) };
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(process);
                }
                match result {
                    WAIT_OBJECT_0 => false,
                    WAIT_TIMEOUT => true,
                    _ => return Err(error),
                }
            }
        };
        if !running {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Host did not exit before update",
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn update_wait_reaps_the_shared_host_child_after_its_handle_is_released() {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        drop(child);
        wait_for_process_exit(pid, Duration::from_secs(2)).unwrap();
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}
