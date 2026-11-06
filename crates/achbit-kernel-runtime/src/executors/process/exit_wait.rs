//! Observe exit without reaping. The caller still owns the child, its exit status and cancellation.
use std::io;
use std::process::Child;
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

#[cfg(unix)]
pub(super) struct ChildExit(Option<OwnedFd>);

#[cfg(unix)]
impl ChildExit {
    pub(super) fn new(child: &Child) -> io::Result<Self> {
        watch_pid(child.id()).map(Self)
    }

    pub(super) fn wait(&self, interval: Duration) -> io::Result<()> {
        let Some(fd) = &self.0 else {
            // On systems without a process descriptor, keep the existing bounded wait.
            std::thread::sleep(interval);
            return Ok(());
        };
        let mut event = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // The descriptor becomes readable on exit. try_wait remains the source of status.
        if unsafe { libc::poll(&mut event, 1, wait_ms(interval) as i32) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        } else if event.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::from_raw_os_error(libc::EBADF));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn watch_pid(pid: u32) -> io::Result<Option<OwnedFd>> {
    let raw = unsafe { libc::kqueue() };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let change = libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    if unsafe { libc::kevent(raw, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) } < 0 {
        let error = io::Error::last_os_error();
        // A fast child may exit before registration. Its parent checks try_wait next.
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error);
    }
    Ok(Some(fd))
}

#[cfg(target_os = "linux")]
fn watch_pid(pid: u32) -> io::Result<Option<OwnedFd>> {
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0u32) };
    if raw < 0 {
        let error = io::Error::last_os_error();
        // Older kernels and syscall filters can lack pidfd_open. The process still runs.
        if matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EPERM)) {
            return Ok(None);
        }
        return Err(error);
    }
    Ok(Some(unsafe { OwnedFd::from_raw_fd(raw as i32) }))
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn watch_pid(_pid: u32) -> io::Result<Option<OwnedFd>> {
    Ok(None)
}

#[cfg(windows)]
pub(super) struct ChildExit(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl ChildExit {
    pub(super) fn new(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::AsHandle;
        child.as_handle().try_clone_to_owned().map(Self)
    }

    pub(super) fn wait(&self, interval: Duration) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::WaitForSingleObject,
        };
        match unsafe { WaitForSingleObject(self.0.as_raw_handle(), wait_ms(interval)) } {
            WAIT_OBJECT_0 | WAIT_TIMEOUT => Ok(()),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

// The caller bounds this interval to its cancellation check (10 ms).
fn wait_ms(interval: Duration) -> u32 {
    interval.as_nanos().div_ceil(1_000_000) as u32
}
