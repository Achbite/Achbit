//! Own the descendants of this invocation, including on timeout/cancellation.
//! A Job Object controls process lifetimes, not filesystem permissions.
use achbit_kernel_abi::{KernelError, KernelResult};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::Debug::{
            SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
        },
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenProcess, OpenThread, ResumeThread, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
            THREAD_SUSPEND_RESUME,
        },
    },
};

/// Tool processes have no person to dismiss a dialog. Windows hard-error and
/// crash dialogs (missing DLL, unhandled exception) would block a call until its
/// timeout; with this mode they fail immediately. Children inherit the mode.
pub fn suppress_error_dialogs() {
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

/// Resume a process created with CREATE_SUSPENDED once its Job owns it.
pub fn resume_suspended(pid: u32) -> KernelResult<()> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(last_error("enumerate suspended process threads"));
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = 0;
        let mut more = Thread32First(snapshot, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    if ResumeThread(thread) != u32::MAX {
                        resumed += 1;
                    }
                    CloseHandle(thread);
                }
            }
            more = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        if resumed == 0 {
            return Err(last_error("resume suspended invocation process"));
        }
        Ok(())
    }
}

pub(crate) struct ProcessJob(HANDLE);

impl ProcessJob {
    pub fn terminate(&self) -> KernelResult<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(last_error("terminate invocation process job"));
        }
        Ok(())
    }

    pub(crate) fn wait_empty(&self) -> KernelResult<()> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION =
                unsafe { std::mem::zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(last_error("query invocation process job"));
            }
            if accounting.ActiveProcesses == 0 {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(KernelError::Other(
                    "Invocation descendants did not exit within 30 seconds".into(),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    pub fn attach(pid: u32) -> KernelResult<Self> {
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(last_error("open invocation process"));
            }
            let result = Self::attach_handle(process);
            CloseHandle(process);
            result
        }
    }

    pub fn attach_handle(process: HANDLE) -> KernelResult<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(last_error("create process job"));
            }
            let guard = Self(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            // An unhandled exception ends the process instead of waiting on a
            // Windows Error Reporting dialog nobody will answer.
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(last_error("configure process job"));
            }
            let result = AssignProcessToJobObject(job, process);
            let error = (result == 0).then(|| last_error("attach invocation process to job"));
            if let Some(error) = error {
                return Err(error);
            }
            Ok(guard)
        }
    }
}

fn last_error(operation: &str) -> KernelError {
    KernelError::Other(format!("{operation}: {}", std::io::Error::last_os_error()))
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
