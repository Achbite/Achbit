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

## Choose an interface

| Goal | Command |
| --- | --- |
| Inspect tools | `tools list`, `tools inspect --tool NAME` |
| Execute directly | `tools call --tool NAME --input JSON`; add `--no-wait` for asynchronous submission |
| Wait for a result | `operation inspect --operation-id ID --wait-ms 180000` |
| Respond to tool authorization | `operation respond --operation-id ID --decision-id ID --decision allow\|deny` |
| Inspect the plugin catalog | `components list`, `components inspect --uri URI`, `components activate --plugin-selections JSON` |
| Inspect the interface | `surfaces list`, `surfaces inspect --target main` |
| Operate the interface | `action --target TARGET --name ACTION --args JSON` |
| Validate an Agent task | `task submit --text TEXT --follow` |
| Follow an existing task | `observe subscribe --session-id ID`, then `observe --subscription-id ID --follow` |
| Read original results | `result read --operation-id ID`, `--record-id ID`, or `--session-id ID --event-sequence N` |
| Query timing or usage | `metrics query --kind tool\|ui\|component\|session\|provider` |
| Clean up this instance | `stop`; `detach` releases control without cancelling tasks |

Append these commands to `./achbit-debug`. Arguments can use `@JSON-file`. Inspect first to obtain actual selectors, component IDs, action signatures, and availability; do not guess names.

Direct tool context does not currently provide run-owned browser or desktop bindings. Activating Computer Use does not make all its tools callable. Use GUI surface/action interfaces when applicable. Report a missing entrypoint rather than creating a simulated Provider just to construct interface state.

UI actions can use `waitFor` for DOM or component state. Returning from an action does not establish business completion. `partial` results and nonzero exits retain original errors and observation gaps; do not replay already-executed actions. When visual confirmation is needed, read the screenshot from the original receipt. Archiving or presenting an image does not load its pixels into the model.

Use one `--follow` connection for task observation. It receives batches of text, tools, decisions, and terminal state without status polling. Determine success from the task's terminal state, not from the observation stream closing.

See [Debug control](product/debug-control.md) for full arguments and examples. Inside the product, read the same file under `productDocsPath` through the shell. Building does not update running processes. Restart target GUI/Host instances only within the authorized scope; keep the standard installation independent.
