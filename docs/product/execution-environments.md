# Execution environments

Use the run's recorded target, shell and PATH, plus the project's build instructions. `commandPaths` lists commands found on that PATH, not every installed program. Command-not-found, access denial and an unreachable service are different failures. Host permission changes access, not the selected execution target or shell.

## Workspace Shell

| Need | Interface or rule |
| --- | --- |
| Read/edit project files | File tools and the current workspace/Plan scope |
| Test/build outputs | Plan `writablePaths` for specific output directories, not the project root |
| Persistent scratch | Session workspace; each shell call's TMPDIR/TMP/TEMP is removed afterward |
| Additional outside files | `requestFileAccess` with exact paths and a reason |
| Network in the sandbox | `requestNetworkPermission`; file scope stays unchanged |
| Host execution | `requestHostPermission`; obtain approval before executing |

Project files remain read-only to workspace Shell even when file-tool edits are allowed. Session-managed drafts already have file access; that does not approve independent Shell effects. Writable ancestors of protected subtrees such as `.git` are rejected: request narrower output directories.

Workspace Shell HOME is session-managed; it is not the application configuration root. For Achbit configuration, use the reported `achbitCli --host-data-dir hostDataDirectory instance`, then `services`, `connections` or `models`; request Host execution when needed instead of guessing paths under HOME.

Workspace Shell is offline by default, including loopback access. Network grants can be per call, task or conversation as offered by the decision. Explicit command deny/ask rules still apply. Host execution uses real host-user permissions, including network and writes outside the sandbox; a working directory is not isolation. With Plan approval enabled or an active Plan, each Host call requires separate approval. An approval or a failed command does not authorize an automatic broader retry.

Backends: macOS `sandbox-exec`; Linux/WSL2 Bubblewrap; native Windows LPAC. Backend startup failures retain their actual reason. Bubblewrap requires supported namespaces; WSL1 does not provide them. Do not switch execution scope to work around a denial.

## Native Windows

Settings → Execution environment selects PowerShell 7, Windows PowerShell or Git Bash. Automatic prefers PowerShell 7, then Windows PowerShell 5.1. An explicit choice does not silently fall back. `System32/bash.exe` is WSL, not Git Bash.

When automatic selection falls back to 5.1, the settings page shows an installation prompt for PowerShell 7. After installation, select **Refresh environment**; subsequent runs use the newly detected shell.

Use the recorded shell dialect. PowerShell 5.1 has no `&&` / `||`; after a native command, capture `$LASTEXITCODE` and explicitly return it. Achbit runs PowerShell scripts as temporary UTF-8 files without changing machine execution policy.

For `*_workspace_sandbox_unavailable`, inspect `workspaceSandbox.reason` or use **Check Windows support** in settings. This tests LPAC support, not service readiness. An installed Docker command does not prove daemon access. Preserve startup errors, including nested Store PowerShell failures, rather than treating them as syntax errors or reinstalling automatically.

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

Use PowerShell syntax on Windows; Windows PowerShell 5.1 lacks && and ||. Preserve $LASTEXITCODE for native commands and pipeline failures in Bash. The shell output tail is bounded to 2000 lines or 50 KiB; inspect returned fullOutput paths for omitted sections without repeating effects. A terminal supplies bounded stdin once to a temporary PTY and must terminate; omitted terminal closes stdin.

For long commands, dependency waits, one-time review and cancellation, read [managed processes](managed-processes.md).
