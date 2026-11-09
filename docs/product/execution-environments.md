# Execution environments

Use the run's recorded target, shell and PATH, plus the project's build instructions. The product operations Skill supplies `commandPaths` for executables found on that PATH. This is location discovery; actual command results establish runtime dependencies, sandbox access and service readiness. Command-not-found, access denial and an unreachable service are different failures. Host permission changes access, not the selected execution target or shell.

## Workspace Shell

| Need | Interface or rule |
| --- | --- |
| Read/edit project files | File tools and the current workspace/Plan scope |
| Test/build outputs | Plan `writablePaths` for specific output directories, not the project root | An explicit empty `writablePaths` grants no project write directory to the workspace shell.
| Optional temporary scripts and logs | The session working directory retains files across calls. Each shell call has its own temporary directory. |
| Additional outside files | `requestFileAccess` with exact paths and a reason |
| Network in the sandbox | `requestNetworkPermission`; file scope stays unchanged |
| Host execution | `requestHostPermission`; obtain approval before executing |

Under delegated review, an approved read-only `requestFileAccess` scope can be reused within the current task and file environment. A file grant covers only that file; a directory grant covers its descendants, not siblings or ancestors. Later calls may omit the request or repeat the covered paths without another file approval. Revocation, relevant permission changes and task completion end the grant. Writes, network and Host execution retain their separate gates.

Project files remain read-only to workspace Shell even when file-tool edits are allowed. The session owns its working directory outside the project. Tools can return their results directly or keep intermediate files there. Shell execution follows the active permission policy. Writable ancestors of protected subtrees such as `.git` are rejected: request narrower output directories.

Workspace Shell HOME is session-managed; it is not the application configuration root. After selection or use of the product or iteration Skill, `Achbit product resources` supplies `achbitCli` and `hostDataDirectory` with the originating message or successful activation/read result when permitted. Use `achbitCli --host-data-dir hostDataDirectory instance`, then the required management command. Submit the Shell call with `requestHostPermission` and a specific reason, including read-only commands such as `plugins status`; the current permission policy handles authorization. These Host paths do not grant workspace-sandbox access. The CLI is unavailable in sessions that disable Host execution.

Workspace Shell is offline by default, including loopback access. Network grants can be per call, task or conversation as offered by the decision. Explicit command deny/ask rules still apply. Host execution uses real host-user permissions, including network and writes outside the sandbox; a working directory is not isolation. With Plan approval enabled or an active Plan, each Host call requires separate approval. An approval or a failed command does not authorize an automatic broader retry.

On macOS, discovered commands contribute read-only access to their executable symlink chain. An entry inside an installed Node package also contributes that package's directory for sibling modules. This does not grant the enclosing `node_modules`, user home, writes or network. Other runtime dependencies retain the normal explicit file-access path. Normal runs and direct Debug tools use the same resolver.

Backends: macOS `sandbox-exec`; Linux/WSL2 Bubblewrap; native Windows LPAC. Backend startup failures retain their actual reason. Bubblewrap requires supported namespaces; WSL1 does not provide them. Do not switch execution scope to work around a denial.

## Native Windows

Settings → Execution environment selects PowerShell 7, Windows PowerShell or Git Bash. Automatic prefers PowerShell 7, then Windows PowerShell 5.1. An explicit choice does not silently fall back. `System32/bash.exe` is WSL, not Git Bash.

In automatic mode, the selector shows the detected shell name. After installing a shell, select **Refresh environment** to detect it.

Use the recorded shell dialect. PowerShell 5.1 has no `&&` / `||`; after a native command, capture `$LASTEXITCODE` and explicitly return it. Achbit runs PowerShell scripts as temporary UTF-8 files without changing machine execution policy.

The recorded `workspaceSandbox` status checks basic startup of the selected Windows shell inside LPAC. Changing the selected shell or refreshing the environment repeats the check. **Check Windows support** also checks the platform's LPAC launch support. Neither check establishes that every child tool or service is compatible. For `*_workspace_sandbox_unavailable`, inspect `workspaceSandbox.reason` and the command's actual error.

Some native tools require Windows object namespaces that LPAC does not expose. Stock Git Bash/MSYS can fail before executing a script with `NtCreateDirectoryObject` access denied. Native Git can fail resolving its current directory even when that directory is readable. Granting more project files does not resolve these namespace failures. Use an explicitly configured WSL project for Linux Bash/toolchains when needed; the application does not change targets or retry on the Host automatically. An installed Docker command likewise does not prove daemon access.

## Explicit WSL projects

Project → Manage workspace → Runtime shell: select WSL, the distribution, and its installed Linux `achbit-kernel` executable, for example `/opt/achbit/achbit-kernel`. The distribution, compatible Linux worker and files must already exist; a Windows `.exe` is not a Linux worker.

Filesystem tools and Bash use that distribution. Windows paths are translated; WSL UNC paths must belong to it. Conversation and permissions remain with the original Host. Missing workers or paths are errors, not permission to install WSL, move files or use native execution instead.

## Docker test environments

Use the Containers plugin's discovered schemas for container operations. Inspect the project's existing development container and mount before building. Access grants bind the resolved Docker context/container identity, not just a reusable name.

Temporary test containers mount the project read-only at `/project` and session output at `/work`; copy to `/work` when a build writes into its source tree. Select the required network or `none`. Creation approval includes eventual cleanup of that owned container, not unrelated containers.

Existing containers retain their actual mounts and permissions. The plugin does not start Docker; PATH discovery, socket access and service readiness must be distinguished. Arbitrary Docker commands through Host Shell retain Host approval requirements.

## SSH remote Hosts

In the GUI connection dialog, select POSIX for macOS/Linux or Windows (OpenSSH) for a Windows login shell. Supply the remote `achbit-cli` path and optional user-data root. Local and remote OS may differ.

```sh
achbit-cli ssh configure --host user@host --remote-shell windows --remote-cli 'C:\Program Files\Achbit\achbit-cli.exe' --output windows-host.json
achbit-cli ssh connect --profile windows-host.json
```

The quoting above fits PowerShell/POSIX shells. Profiles use `remoteShell: posix|windows`. Passwords and key passphrases belong in the existing authentication prompts, not logs.

## Bindings and update timing

A consumed directory attachment or explicit workspace addition becomes a binding; a file attachment does not bind its parent. Binding grants no write permission. Project directory changes apply to its conversations and subsequent requests; in-flight calls keep their captured paths. Use Session-provided logical workspace handles.

New runs capture runtime settings. On macOS the Host prepares PATH from the login shell at initialization or explicit environment refresh, not on every tool call. Do not change settings or reinstall tools merely because the current prepared PATH lacks a command.

## Shell diagnostics and output

Command-not-found describes the prepared PATH, not all installed software. Denied filesystem access and an unreachable socket do not prove a service is stopped. Check the actual error and required scope. Keep files needed by later calls in workspace paths; per-call temporary resources are cleaned.

Use PowerShell syntax on Windows; Windows PowerShell 5.1 lacks && and ||. Preserve $LASTEXITCODE for native commands and pipeline failures in Bash. The shell output tail is bounded to 2000 lines or 50 KiB. The model receives command output and its exit code. Timeouts, truncation and recoverable log paths are reported when applicable. Log paths accompany clipped output or a failed command whose archived streams contain additional bytes. The Kernel retains the full record. A terminal supplies bounded stdin once to a temporary PTY and must terminate; omitted terminal closes stdin.

For long commands, dependency waits, one-time review and cancellation, read [managed processes](managed-processes.md).
