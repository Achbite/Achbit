//! Single-invocation Linux worker used by an explicitly selected WSL project.
use achbit_kernel_abi::KernelErrorEnvelope;
use achbit_kernel_runtime::{
    executors::*,
    wsl_execution::{WorkerFrame, WorkerRequest},
};
use achbit_kernel_tools::KernelToolRegistry;
use serde_json::Value;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) fn run() -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("The WSL Kernel worker requires Linux.".into());
    }
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    let request: WorkerRequest = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    let result = match request {
        WorkerRequest::Describe { settings } => {
            crate::session_environment::prepare(&settings, None, false)?
        }
        WorkerRequest::Execute {
            invocation,
            mut context,
            distribution,
            shell,
            execution_path,
        } => {
            let tool_id = invocation.input.tool_id().as_str();
            if tool_id != "bash" && !tool_id.starts_with("fs.") {
                return Err("WSL worker accepts workspace filesystem and Bash tools only.".into());
            }
            invocation
                .input
                .validate()
                .map_err(|error| error.to_string())?;
            let cancellation = context.cancellation.clone();
            context.progress = KernelProgressSink::new(|progress| {
                let _ = write_frame(&WorkerFrame::Progress { progress });
            });
            std::thread::spawn(move || {
                for line in std::io::stdin().lock().lines() {
                    match line {
                        Ok(line)
                            if serde_json::from_str::<Value>(&line)
                                .ok()
                                .is_some_and(|value| value["cancel"] == true) =>
                        {
                            break
                        }
                        Err(_) => break,
                        _ => {}
                    }
                }
                cancellation.cancel();
            });
            let invocation_id = invocation.id.clone();
            let result: Result<KernelToolExecutionResult, KernelErrorEnvelope> = (|| {
                let translate = |path: &str| translate_path(path, &distribution);
                let host_archive = context.output_directory.clone();
                context.workspace_root = context
                    .workspace_root
                    .as_deref()
                    .map(translate)
                    .transpose()?;
                context.private_resolved_targets = context
                    .private_resolved_targets
                    .iter()
                    .map(|path| translate(path))
                    .collect::<Result<_, _>>()?;
                context.output_directory = context
                    .output_directory
                    .as_ref()
                    .map(|path| translate(&path.to_string_lossy()).map(PathBuf::from))
                    .transpose()?;
                if let Some(targets) = context.workspace_write_targets.as_mut() {
                    for target in targets {
                        target.path = translate(&target.path.to_string_lossy())?.into();
                    }
                }
                translate_file_access(&mut context.file_access, &distribution)?;
                // Windows admission cannot inspect the selected Linux runtime.
                // Apply the same startup read roots as native Linux execution.
                context
                    .file_access
                    .read
                    .extend(achbit_kernel_runtime::file_access::system_read_paths());
                let mut runtime_roots = std::env::split_paths(&execution_path)
                    .filter(|path| path.is_absolute() && path.is_dir())
                    .collect::<Vec<_>>();
                if tool_id == "bash" {
                    runtime_roots.extend(
                        achbit_kernel_runtime::shell_environment::toolchain_homes()
                            .into_iter()
                            .map(|(_, path)| path),
                    );
                }
                for path in runtime_roots {
                    context.file_access.read.push(path.clone());
                    context.file_access.best_effort_read.push(path);
                }
                let registry = KernelToolRegistry::new();
                let executors = KernelExecutorRegistry::from_executors(builtin_executors(
                    &registry,
                    KernelExecutorConfig {
                        shell_program: Some(shell),
                        execution_path: Some(execution_path),
                        ..KernelExecutorConfig::default()
                    },
                    Arc::new(EmptySecretProvider),
                ));
                let linux_archive = context.output_directory.clone();
                let mut result = executors
                    .invoke(invocation, context)
                    .map_err(|error| KernelErrorEnvelope::from(&error))?;
                if let (Some(linux), Some(host)) = (linux_archive, host_archive) {
                    map_archive_references(&mut result.output, &linux, &host.to_string_lossy())?;
                }
                Ok(result)
            })();
            let result = result.unwrap_or_else(|error| KernelToolExecutionResult {
                invocation_id,
                outcome: KernelToolExecutionOutcome::Failed,
                output: error.args.unwrap_or(Value::Null),
                error: Some(KernelToolExecutionFailure {
                    code: error.code,
                    message: error.message,
                }),
            });
            serde_json::to_value(result).map_err(|error| error.to_string())?
        }
    };
    write_frame(&WorkerFrame::Reply { reply: result })
}

fn write_frame(frame: &WorkerFrame) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, frame).map_err(|error| error.to_string())?;
    stdout
        .write_all(b"\n")
        .and_then(|_| stdout.flush())
        .map_err(|error| error.to_string())
}

// These references are consumed by the Windows Host. Only Kernel-owned archive
// fields are translated; command output and logical workspace paths stay intact.
fn map_archive_references(
    output: &mut Value,
    linux_root: &Path,
    host_root: &str,
) -> Result<(), KernelErrorEnvelope> {
    let remap = |value: &mut Value| -> Result<(), KernelErrorEnvelope> {
        let path = value
            .as_str()
            .ok_or_else(|| path_error("Invalid archive reference."))?;
        let relative = Path::new(path)
            .strip_prefix(linux_root)
            .map_err(|_| path_error("Archive reference is outside the invocation directory."))?;
        *value = Value::String(format!(
            "{}\\{}",
            host_root.trim_end_matches(['\\', '/']),
            relative.to_string_lossy().replace('/', "\\")
        ));
        Ok(())
    };
    if let Some(streams) = output.get_mut("fullOutput").and_then(Value::as_object_mut) {
        for stream in streams.values_mut() {
            if let Some(path) = stream.get_mut("path") {
                remap(path)?;
            }
        }
    }
    if let Some(changes) = output.get_mut("fileChanges").and_then(Value::as_array_mut) {
        for change in changes {
            for side in ["before", "after"] {
                if let Some(path) = change
                    .get_mut(side)
                    .and_then(|value| value.get_mut("contentRef"))
                {
                    remap(path)?;
                }
            }
        }
    }
    Ok(())
}

fn translate_file_access(
    files: &mut achbit_kernel_runtime::file_access::FileAccessScope,
    distribution: &str,
) -> Result<(), KernelErrorEnvelope> {
    for path in files
        .read
        .iter_mut()
        .chain(&mut files.read_only)
        .chain(&mut files.best_effort_read)
        .chain(files.home.iter_mut())
        .chain(files.cache.iter_mut())
        .chain(files.write.iter_mut().map(|target| &mut target.path))
    {
        *path = translate_path(&path.to_string_lossy(), distribution)?.into();
    }
    Ok(())
}

fn translate_path(path: &str, distribution: &str) -> Result<String, KernelErrorEnvelope> {
    // Environment facts such as productDocsPath originate in this worker and
    // are already Linux paths. wslpath -u treats them as Windows rooted paths.
    if path.starts_with('/') && !path.starts_with("//") {
        return Ok(path.into());
    }
    let normalized = path
        .strip_prefix(r"\\?\UNC\")
        .map(|suffix| format!(r"\\{suffix}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_string());
    for server in [r"\\wsl.localhost\", r"\\wsl$\"] {
        if let Some(suffix) = normalized.strip_prefix(server) {
            let (owner, rest) = suffix
                .split_once('\\')
                .ok_or_else(|| path_error("WSL UNC root has no project path."))?;
            if !owner.eq_ignore_ascii_case(distribution) {
                return Err(path_error(
                    "Workspace belongs to a different WSL distribution.",
                ));
            }
            return Ok(format!("/{}", rest.replace('\\', "/")));
        }
    }
    let output = std::process::Command::new("wslpath")
        .args(["-a", "-u", &normalized])
        .output()
        .map_err(|error| path_error(&format!("wslpath failed: {error}")))?;
    if !output.status.success() {
        return Err(path_error(&String::from_utf8_lossy(&output.stderr)));
    }
    let result =
        String::from_utf8(output.stdout).map_err(|error| path_error(&error.to_string()))?;
    let result = result.trim_end_matches(['\r', '\n']);
    if !result.starts_with('/') {
        return Err(path_error("wslpath returned a non-absolute path."));
    }
    Ok(result.into())
}

fn path_error(message: &str) -> KernelErrorEnvelope {
    KernelErrorEnvelope {
        code: "wsl_workspace_path_invalid".into(),
        message: message.into(),
        message_key: None,
        args: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_scope_translates_all_paths_without_changing_grants() {
        use achbit_kernel_runtime::file_access::FileAccessScope;
        let host_root = r"\\wsl.localhost\Ubuntu\home\dev\中文 project";
        let mut files = FileAccessScope {
            sandbox_backend: Some("bubblewrap".into()),
            network_access: false,
            read: vec![host_root.into(), "/mnt/e/runtime/docs/product".into()],
            read_only: vec![format!(r"{host_root}\.git").into()],
            write: vec![WorkspaceWriteTarget {
                path: format!(r"{host_root}\cache").into(),
                directory: true,
            }],
            home: Some(format!(r"{host_root}\home").into()),
            cache: Some(format!(r"{host_root}\cache").into()),
            best_effort_read: vec!["/mnt/e/runtime/docs/product".into()],
        };
        translate_file_access(&mut files, "Ubuntu").unwrap();
        assert_eq!(
            files.read,
            vec![
                PathBuf::from("/home/dev/中文 project"),
                PathBuf::from("/mnt/e/runtime/docs/product")
            ]
        );
        assert_eq!(
            files.read_only,
            vec![PathBuf::from("/home/dev/中文 project/.git")]
        );
        assert_eq!(files.home, Some("/home/dev/中文 project/home".into()));
        assert_eq!(files.cache, Some("/home/dev/中文 project/cache".into()));
        assert_eq!(
            files.write[0].path,
            PathBuf::from("/home/dev/中文 project/cache")
        );
        assert!(files.write[0].directory);
        assert_eq!(
            files.best_effort_read,
            vec![PathBuf::from("/mnt/e/runtime/docs/product")]
        );
        assert_eq!(files.sandbox_backend.as_deref(), Some("bubblewrap"));
        assert!(!files.network_access);
        assert!(translate_file_access(
            &mut FileAccessScope {
                cache: Some(r"\\wsl.localhost\Debian\home\dev\cache".into()),
                ..Default::default()
            },
            "Ubuntu"
        )
        .is_err());
    }
    #[test]
    fn archive_references_return_to_the_host_without_rewriting_command_output() {
        let mut output = serde_json::json!({
            "stdout": "/mnt/c/data/call/stdout.log is literal program output",
            "fullOutput": {"stdout": {"path": "/mnt/c/data/call/stdout.log", "bytes": 60000}},
            "fileChanges": [{"path":"src/main.rs", "before":{"exists":false}, "after":{"exists":true,"contentRef":"/mnt/c/data/call/change-0-after"}}]
        });
        map_archive_references(
            &mut output,
            Path::new("/mnt/c/data/call"),
            r"\\?\C:\data\call",
        )
        .unwrap();
        assert_eq!(
            output["fullOutput"]["stdout"]["path"],
            r"\\?\C:\data\call\stdout.log"
        );
        assert_eq!(
            output["fileChanges"][0]["after"]["contentRef"],
            r"\\?\C:\data\call\change-0-after"
        );
        assert_eq!(
            output["stdout"],
            "/mnt/c/data/call/stdout.log is literal program output"
        );
        assert_eq!(output["fileChanges"][0]["path"], "src/main.rs");
    }

    #[test]
    fn wsl_unc_paths_preserve_unicode_and_reject_another_distribution() {
        assert_eq!(
            translate_path(
                r"\\?\UNC\wsl.localhost\Ubuntu\home\dev\中文 project",
                "Ubuntu"
            )
            .unwrap(),
            "/home/dev/中文 project"
        );
        assert_eq!(
            translate_path(r"\\wsl$\Ubuntu\home\dev\project", "Ubuntu").unwrap(),
            "/home/dev/project"
        );
        assert_eq!(
            translate_path(r"\\wsl.localhost\Debian\home\dev\project", "Ubuntu")
                .unwrap_err()
                .code,
            "wsl_workspace_path_invalid"
        );
    }
}
