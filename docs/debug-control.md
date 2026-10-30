# Achbit Debug CLI quick reference

Debug provides isolated, targeted validation. Tool and UI operations call interfaces directly without a model or Agent Loop. Start a task only when validating Session, Provider, or model approval behavior. A Debug build does not establish acceptance of standard installers, CLI/TUI packages, or a release.

## Launch

Use the project's Docker build entrypoint: `bash ./build.sh -debug --stage package-macos`, or `--stage package-windows` for Windows. Outputs are in `bin/debug/macos-arm64` and `bin/debug/win64`. Debug builds do not produce Setup or PKG installers and are not supported on Linux.

Run from the artifact directory with an existing test workspace:

```sh
./achbit-debug launch --artifact . --workspace /absolute/test-workspace --state-root /absolute/debug-state
export ACHBIT_USER_ROOT=/absolute/debug-state
./achbit-debug inspect
```

On Windows, use `.\achbit-debug.cmd` and set `$env:ACHBIT_USER_ROOT = 'E:\debug-state'` in PowerShell. Each connection command requires an explicit state directory. Do not reuse standard application data or copy its credentials by default.

## Startup timing

To investigate startup latency, set `ACHBIT_STARTUP_TIMING=1` for the target process. The GUI and its Host emit `[startup-timing]` records to stderr with stage, PID, wall-clock microseconds, and elapsed process time. This is disabled by default and excludes connection tokens and user content. GUI records are in its stderr; Host records are in the instance's startup diagnostics directory, in `daemon.stderr.log`.

`gui.window_begin` to `gui.index_begin` covers native WebView creation and first navigation. `gui.index_begin` to `gui.index_end` covers only resolving and reading the entry HTML. Inspect WebView modules, requests, and visible controls separately; finishing resource reads does not establish that the first screen is usable.

Compare the external launch timestamp with `gui.entry` to identify waiting before entry, then compare `gui.daemon_start`, `kernel.entry`, `kernel.published`, `gui.daemon_ready`, and `gui.proxy_ready`. `kernel.execution_finished` marks the end of initialization; readiness and health results determine success. Intervals across threads and processes can overlap and must not simply be added. Record first artifact launch, repeated launch at the same path, and a cold launch after clearing system caches as separate observations.

## Commands and lifecycle

The [Debug interfaces and CLI reference](product/debug-control.md) is the canonical command inventory, including arguments, HTTP envelopes, direct tools, GUI actions, Session observation and metrics. It is also shipped under `productDocsPath` for shell-based discovery inside Achbit. `./achbit-debug --help` lists the implemented CLI command groups.

| Need | Entry point |
| --- | --- |
| Run one tool without a model | `tools list`, `tools inspect`, `tools call`, then `operation inspect/respond/cancel/release` |
| Inspect or operate GUI/components | `gui ready`, `surfaces list/inspect`, `action`, `components list/inspect/activate` |
| Run an Agent task | `task submit --follow`; `task inspect/message/respond/cancel` |
| Observe an existing task | `observe subscribe`, then one `observe --follow` connection; `observe status` for diagnosis |
| Read facts and timings | `result read`, `metrics query/export` |
| Close an owned launch | `stop`: GUI exit followed by persistent Host cleanup |
| Close a separately started GUI | `gui stop --expected-pid PID [--gui-host-id ID]`, using values from `surfaces list` |
| Release control while retaining tasks | `detach`, after active direct-tool operations finish |

`launch` creates a persistent controller-owned Host; `attach` does not acquire ownership. For update and GUI-owned Host lifecycle checks, start the normal Debug App and attach to that instance instead. `gui stop` confirms GUI process exit; it does not stop a persistent Host. `inspect.identity.pid` identifies the Host, while `surfaces list.guiPid` identifies the GUI. `instances` inspects only the explicitly selected state root. A test harness that keeps the GUI as its own child must reap it concurrently with the CLI shutdown wait; a terminated but unreaped child can still appear present to another process.

UI actions preserve dispatch versus observation: `partial` remains nonzero, and a menu/window action that closes its own surface may interrupt observation. Use `gui stop` for confirmed shutdown. Read actual selectors and action signatures first; do not replay a completed action merely to obtain another screenshot. Direct tools, GUI actions and observations do not start model requests. Direct tool context does not supply Session/run-owned browser or desktop bindings; see the shipped reference for the supported paths.

Building does not update running processes. Restart only the target GUI/Host within the authorized scope and keep the standard installation independent.
