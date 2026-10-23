use super::{
    finish,
    os::*,
    profile::{Capabilities, Profile},
    token,
};
use crate::executors::windows_job::ProcessJob;
use std::fs::File;
use std::os::windows::io::FromRawHandle;
use std::process::Command;
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{Console::*, Pipes::CreatePipe, Threading::*},
};

pub(crate) struct Child {
    process: Handle,
    job: ProcessJob,
    console: Option<Console>,
    pub(crate) stdin: Option<File>,
    pub(crate) stdout: Option<File>,
    pub(crate) stderr: Option<File>,
    active: bool,
}
impl Child {
    pub(crate) fn poll(&self) -> Result<Option<i32>, String> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == 0 {
                    return Err(error("Read sandbox exit code"));
                }
                Ok(Some(code as i32))
            }
            _ => Err(error("Poll sandbox process")),
        }
    }

    pub(crate) fn stop(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        self.job.terminate().map_err(|error| error.to_string())?;
        if unsafe { WaitForSingleObject(self.process.0, 30_000) } != WAIT_OBJECT_0 {
            return Err(error("Reap sandbox process"));
        }
        self.job.wait_empty().map_err(|error| error.to_string())?;
        self.active = false;
        Ok(())
    }

    /// Output readers must already be running: ClosePseudoConsole drains output.
    pub(crate) fn close_console(&mut self) {
        self.console.take();
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("{error}");
        }
    }
}

struct Console(HPCON);
impl Drop for Console {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}

struct Attributes {
    _storage: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(count: u32) -> Result<Self, String> {
        let mut size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size);
        }
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let pointer = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(pointer, count, 0, &mut size) } == 0 {
            return Err(error("Initialize LPAC process attributes"));
        }
        Ok(Self {
            _storage: storage,
            pointer,
        })
    }
    fn add(&self, key: u32, value: *const std::ffi::c_void, size: usize) -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.pointer,
                0,
                key as usize,
                value,
                size,
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(error(&format!("Set LPAC process attribute {key:#x}")));
        }
        Ok(())
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

fn pipe() -> Result<(Handle, Handle), String> {
    let (mut read, mut write) = (null_mut(), null_mut());
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(error("Create sandbox pipe"));
    }
    Ok((Handle(read), Handle(write)))
}
fn as_file(handle: Handle) -> File {
    let raw = handle.0;
    std::mem::forget(handle);
    unsafe { File::from_raw_handle(raw) }
}

pub(super) fn spawn(
    command: &Command,
    terminal: bool,
    profile: &Profile,
    capabilities: &Capabilities,
    prepare: impl FnOnce(HANDLE) -> Result<(), String>,
) -> Result<Child, String> {
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let mut stderr = None;
    let mut stderr_child = None;
    let mut console = None;
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    let attributes = Attributes::new(3)?;
    let security = capabilities.security(profile);
    attributes.add(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        (&security as *const SECURITY_CAPABILITIES).cast(),
        std::mem::size_of_val(&security),
    )?;
    // LPAC opts out of ALL APPLICATION PACKAGES; ordinary AAP or Everyone
    // permissions must not turn into permission to read the user's other files.
    let opt_out: u32 = 1; // PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
    attributes.add(
        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        (&opt_out as *const u32).cast(),
        std::mem::size_of_val(&opt_out),
    )?;
    let mut flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
    let mut inherited = Vec::new();
    if terminal {
        // Prevent Windows from copying the worker's redirected std handles into
        // the ConPTY client. Null handles are supplied by the pseudoconsole.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        let mut raw = 0;
        let result = unsafe {
            CreatePseudoConsole(
                COORD { X: 120, Y: 30 },
                input_read.0,
                output_write.0,
                0,
                &mut raw,
            )
        };
        if result < 0 {
            return Err(format!("Create sandbox terminal: HRESULT {result:#x}"));
        }
        console = Some(Console(raw));
        attributes.add(
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            raw as *const _,
            std::mem::size_of::<HPCON>(),
        )?;
    } else {
        let (read, write) = pipe()?;
        stderr = Some(read);
        stderr_child = Some(write);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = input_read.0;
        startup.StartupInfo.hStdOutput = output_write.0;
        startup.StartupInfo.hStdError = stderr_child.as_ref().unwrap().0;
        inherited.extend([
            input_read.0,
            output_write.0,
            stderr_child.as_ref().unwrap().0,
        ]);
        attributes.add(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited.as_ptr().cast(),
            inherited.len() * std::mem::size_of::<HANDLE>(),
        )?;
        flags |= CREATE_NO_WINDOW;
    }
    startup.lpAttributeList = attributes.pointer;
    for handle in [Some(&input_write), Some(&output_read), stderr.as_ref()]
        .into_iter()
        .flatten()
    {
        if unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(error("Configure sandbox pipe inheritance"));
        }
    }
    // cmd.exe parses its own command line and reads "/System32/cmd.exe" in a
    // forward-slash program path as switches; pass the native spelling.
    let program: std::path::PathBuf = std::path::Path::new(command.get_program())
        .components()
        .collect();
    let mut argv = wide(
        std::iter::once(program.as_os_str())
            .chain(command.get_args())
            .map(|arg| quote(&arg.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(" "),
    );
    // The caller clears inherited environment and supplies the admitted snapshot.
    let mut entries = command
        .get_envs()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect::<Vec<_>>();
    entries.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut environment = Vec::new();
    for (key, value) in entries {
        let mut entry = key.to_os_string();
        entry.push("=");
        entry.push(value);
        environment.extend(wide(entry));
    }
    environment.push(0);
    let cwd = command
        .get_current_dir()
        .ok_or("Sandbox working directory is missing")?;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        CreateProcessW(
            wide(&program).as_ptr(),
            argv.as_mut_ptr(),
            null(),
            null(),
            i32::from(!terminal),
            flags,
            environment.as_ptr().cast(),
            process_path(cwd).as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    } == 0
    {
        return Err(error("Start LPAC Shell"));
    }
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);
    let job = match ProcessJob::attach_handle(process.0) {
        Ok(job) => job,
        Err(error) => return finish(Err(error.to_string()), terminate_suspended(process.0)),
    };
    // A packaged executable adds package identity to the actual token. Evaluate
    // runtime access with that token, then install invocation grants before any
    // Shell instruction runs.
    let prepared = token::verified(process.0).and_then(|token| prepare(token.0));
    if let Err(error) = prepared {
        return finish(Err(error), terminate_suspended(process.0));
    }
    // No instruction runs before the complete descendant lifetime is owned.
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        return finish(
            Err(error("Resume LPAC Shell")),
            terminate_suspended(process.0),
        );
    }
    drop(input_read);
    drop(output_write);
    drop(stderr_child);
    Ok(Child {
        process,
        job,
        console,
        stdin: Some(as_file(input_write)),
        stdout: Some(as_file(output_read)),
        stderr: stderr.map(as_file),
        active: true,
    })
}

fn terminate_suspended(process: HANDLE) -> Result<(), String> {
    if unsafe { TerminateProcess(process, 1) } == 0 {
        return Err(error("Terminate suspended Shell"));
    }
    if unsafe { WaitForSingleObject(process, 30_000) } != WAIT_OBJECT_0 {
        return Err(error("Reap suspended Shell"));
    }
    Ok(())
}

pub(super) fn probe(profile: &Profile, capabilities: &Capabilities) -> Result<(), String> {
    let system = std::env::var_os("SystemRoot").ok_or("SystemRoot is missing")?;
    let directory = std::path::PathBuf::from(&system).join("System32");
    let mut command = Command::new(directory.join("cmd.exe"));
    command
        .args(["/d", "/c", "exit", "0"])
        .current_dir(&directory)
        .env_clear()
        .env("SystemRoot", &system)
        // CreateProcess requires LOCALAPPDATA to initialize an AppContainer even
        // when the probe itself needs no writable files.
        .env(
            "LOCALAPPDATA",
            std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is missing")?,
        );
    let mut child = spawn(&command, false, profile, capabilities, |_| Ok(()))?;
    child.stdin.take();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = (|| loop {
        if let Some(code) = child.poll()? {
            return if code == 0 {
                Ok(())
            } else {
                Err(format!("LPAC support check exited with status {code}"))
            };
        }
        if Instant::now() >= deadline {
            return Err("LPAC support check timed out".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    })();
    finish(result, child.stop())
}
