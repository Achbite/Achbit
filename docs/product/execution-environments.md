# Execution environments

## SSH remote Hosts

The GUI connection dialog selects the remote operating system. Keep macOS / Linux for POSIX login shells; select Windows (OpenSSH) for a Windows Host using the default cmd.exe or PowerShell shell. Existing connection profiles default to POSIX. Supply the remote `deepcode-cli` executable path and, optionally, a remote user-data root. The local and remote operating systems can differ.

CLI onboarding uses `deepcode-cli ssh configure --host user@host --remote-shell windows --remote-cli 'C:\Program Files\DeepCode\deepcode-cli.exe' --output windows-host.json` (example quoted for PowerShell or a POSIX shell), then `deepcode-cli ssh connect --profile windows-host.json`. JSON profiles store `remoteShell` as `posix` or `windows`. Direct GUI launches accept `--ssh user@host --remote-shell windows --remote-cli <path>` as well. Passwords and key passphrases are entered through the GUI's existing SSH prompts.

## Native Windows

Settings > Execution environment contains the global Windows Shell preference. Automatic selection prefers PowerShell 7 (`pwsh.exe`), then built-in Windows PowerShell 5.1 when PowerShell 7 is absent. Explicit PowerShell 7, Windows PowerShell and Git Bash choices do not switch to another shell on failure. Git Bash can use a custom executable path. The WSL launcher `System32/bash.exe` is not a Git Bash candidate.

PowerShell user scripts are passed as temporary UTF-8 BOM `.ps1` files, with no profile and UTF-8 output. The temporary file is removed after execution. The script-file transport avoids the Windows command-line length limit and preserves Unicode, quotes and multiline text. Process-scoped execution policy allows this generated script; machine policy is not changed. Native executable exit codes should be reported explicitly using `$LASTEXITCODE`.

## Explicit WSL projects

Open the project menu > Manage workspace > Runtime shell. Choose WSL, name the distribution and specify the Linux package's `deepcode-kernel` executable installed inside it, for example `/opt/deepcode/deepcode-kernel` (an absolute path or a command on that distribution's PATH). Set this field to the actual installed executable. Use a Linux package built from the current implementation; a Windows `.exe` cannot be used as the Linux worker.

Workspace filesystem tools and Bash execute in a single-invocation Linux Kernel worker through `wsl.exe --distribution ... --exec ... --kernel-tool-worker`. The worker does not create a Session, start a Provider, open a service port or write a second journal. The Windows Host and shared Session continue to own conversation identity, Plan admission, tool records and progress. Native Windows paths are translated using `wslpath`; a WSL UNC project must belong to the selected distribution. Output archives remain in the Session-owned storage directory.

The distribution, Kernel executable and project files must already be available. An unavailable worker or invalid project path is reported as an error; DeepCode does not install a distribution, move files or switch to native execution automatically.

## Stable context

Each new run captures the selected operating system, architecture, locale, shell and command search path. A running or restored run keeps its prepared facts. On macOS, the Host reads PATH from the user's login shell at initialization or explicit environment refresh; tool invocations do not reload profiles. Discovery and execution use that same prepared PATH. Windows and WSL use the selected execution endpoint's environment.

Execution target, project build requirements and sandbox permissions are separate. Read project files to identify the build/test environment; a native shell may invoke Docker for a Linux build. `commandPaths` records commands found on `executionPath`, not an inventory of installed software. A missing command, sandbox denial or unreachable socket cannot establish that the host lacks a tool or a service is stopped. The Kernel selects Shell permissions from the approved Plan, user settings and call approval, not model input. Host permission changes access, not the selected target, shell or prepared PATH. Required approval happens before execution; the Kernel does not retry failed commands automatically. Service readiness is checked on demand in the intended scope.

Workspace bindings define the project's and Session's managed working directories. A directory submitted with a user message becomes a formal Session binding when that input is consumed; explicitly adding a workspace directory uses the same binding facts. Project workspace changes update all of that project's existing conversations, not just creation defaults. During an active run, added directories become available to subsequent requests and Plans without starting a new run; changes in other projects do not apply. A known directory needed by a Plan is shown as a workspace-access decision when it has not yet been included. Confirming that decision adds the displayed directory and authorizes the declared Plan; cancelling adds nothing. The original run-start record and each in-flight request's address snapshot remain unchanged. Binding a directory does not approve mutations: Plan scope and Shell execution permissions still apply. A file attachment remains a resource reference and does not bind its parent directory. Kernel resolves the actual bound root when applying workspace permissions, even when the same path is addressed through a file attachment; outside file references retain their normal external read/write requirements.

## Workspace Shell

Shell selection and workspace isolation are separate capabilities. macOS uses sandbox-exec. Linux and WSL2 use Bubblewrap; the Linux package includes its helper. A system installation needs the `bubblewrap` package and permission to create user, mount, PID and network namespaces. WSL1 does not provide these namespaces. Container policies may restrict them even when Bubblewrap is installed.

Root and child Agents can select installed Loop components and workspace isolation through a persisted Agent recipe. The two child presets supply defaults. Component selection never grants new file authority: children inherit the parent's admitted mutation scope, and each file modification still passes Kernel admission. CLI `--recipe` selects these creation defaults for `ask` and `chat`.

Native Windows uses a Low Privilege AppContainer (LPAC) identity scoped to the DeepCode data root and network setting. Each invocation carries capabilities for the resources admitted by the Kernel. The support check launches a real child and verifies its AppContainer token and `WIN://NOALLAPPPKG` opt-out; its result is cached until the environment revision changes or setup runs again. Store PowerShell aliases resolve to the registered package executable. PowerShell receives the Windows runtime capabilities it needs for initialization; Git for Windows receives read access to its recognized installation directory, including helpers and libraries.

Known limitation: launching another Store PowerShell 7.6.6 process from inside an LPAC invocation can fail with Windows error 87. This is distinct from using PowerShell 7 as the main Shell. The cause remains undetermined; preserve the startup error rather than treating it as a command syntax problem or changing execution scope automatically.

The Windows backend applies the Kernel's file scope before resuming the child. Ancestors receive only traversal and attribute access, without directory listing or inheritance; admitted files and directories receive their scoped permissions. ACL checks use the actual child token, including package claims. Capability ACEs persist for reuse, but grant no access to invocations without the corresponding capability. The data-root ledger supports explicit cleanup with `--workspace-sandbox-reset` when DeepCode is closed, including during uninstall. Invocation scratch is removed after execution, and child processes remain owned by a Job Object. A failed support check reports the original error; it does not switch to Host execution.

Project files are read-only to workspace Shell, even when file-tool editing is allowed. Edit and delete project files through the file tools and the current Plan. Plan `writablePaths` grants test/output directories, including writing and removing their contents; it does not classify the commands inside them. Project-root and individual project-file Shell grants are rejected. Session working directories remain writable for probes and build results. Each Shell call also has its own TMPDIR/TMP/TEMP directory, removed after that call; use the session workspace for files needed later.

A Plan whose file targets all belong to the run's managed session working directory can use that existing access without a new project-file approval. Mixed Plans still evaluate their project targets. This does not expand the session directory to an attached path or authorize independent Shell effects; those keep their normal execution admission.

File, directory and network authority remains owned by the Kernel; Shell executes an admitted command with that scope. All workspace backends reject an admitted writable ancestor of a protected subtree (such as `.git`) before launch, because that exclusion cannot be implemented by Windows capability grants. Request narrower output directories instead. This is a scope-enforcement error, not command-text classification or an additional Shell approval system. Explicit resource grants inside protected trees retain their existing Kernel authorization rules.

Workspace Shell is offline by default. `requestNetworkPermission` requests network access for the prepared environment without broadening file writes. The approval can last for one operation, the current task (`runId`) or the conversation (`sessionId`). Network tools retain their separate network-read setting. Existing explicit command deny/ask rules still apply.

Shell approval and execution scope are separate settings. Ask waits for the user; Review invokes an independent context with no tools; Allow uses the permitted environment without further Shell review. A delegated reviewer decides only the current operation; each subsequent request is reviewed separately. Reusable grants require an explicit user decision. The selected review model or its configuration error is captured for the run. An unavailable reviewer leaves ordinary conversation usable and reports its error with a request for human approval when review is needed. Changing relevant permission settings or revoking a grant takes effect before the next execution.

The GUI's primary approval is “Allow this turn”; “Allow this conversation” is available on the left. Both apply to the environment or files named in the request. Explicit per-call rules offer only “Allow” for that operation. The browser retains its conversation-level approval. CLI and TUI use the same Kernel scopes through their text choices.

Explicit Host execution uses the host user's real permissions, including writes outside the project sandbox. Its approval can cover the exact command or the Host environment for this task/conversation. A working directory is not an isolation boundary. Core tools preserve the original command, approved target, authority, output and actual exit status; scripts and their children belong to the same invocation. There is no keyword-based proof of script effects or automatic retry with more authority.

## Docker test environments

Select the Containers plugin to inspect or execute in a particular Linux container, or create a temporary test container. The Kernel resolves the Docker context and full container ID before approval. Task and conversation grants bind that target; reusing a name for a different container requires another grant. The plugin uses the same execution archive, cancellation and Session projection as the other tools, and does not add a second Agent Loop.

A temporary test container mounts the selected project read-only at `/project` and a separate session directory at `/work`. Copy project files into `/work` when a build writes into its source tree. Choose the project's Docker network for multi-container tests, or `none` for offline work. Creation approval covers use and eventual cleanup. Only containers created by this plugin are removed at release; outputs retained in the session directory remain available to file tools and the file tree.

Existing development containers keep their users, mounts, capabilities and network. Granting access to one does not make its writable project mounts read-only. Keep reusable configuration in the project's Docker/Compose files; saved configuration is not an access grant. Arbitrary Docker commands through Host Shell still require Host authority. Linux images need `/bin/sh` and `setsid` for command-group cancellation. Docker must be available in the prepared execution PATH. The plugin does not start or replace the user's Docker service.

## Product docs and Skills

`doc.read` returns bundled English Markdown describing the product. `skill.read` returns workflow guidance for a relevant task. Plugins settings lists text Skills and their sources; documentation is not listed as an executable plugin or a Skill.
