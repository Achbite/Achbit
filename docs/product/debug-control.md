# Debug interfaces and CLI reference

Use `achbit-debug` to control an isolated Debug build directly. Tool and UI actions need no model or Agent Loop. Use task commands only when the behavior under test involves Session, Provider or model review. A Debug package does not imply ordinary CLI/TUI, installer or release acceptance.

## Package and arguments

Build inside the project's Docker environment with `bash ./build.sh -debug --stage package-macos` or `--stage package-windows`. Packages are under `bin/debug/macos-arm64` and `bin/debug/win64`, without Setup/PKG or global command installation. Linux Debug builds are unsupported. The native macOS stage uses the existing build bridge.

Run the package's `./achbit-debug` on macOS or `.\achbit-debug.cmd` on Windows. Keep the package's relative paths intact. `launch --artifact` accepts the package directory (or the Debug `.app` on macOS), and checks its `BUILDINFO.json` for the Debug build kind. Rebuilding does not update running processes; restart the target GUI and Host before checking changed code.

| Argument | Meaning |
| --- | --- |
| `--state-root DIR` | Explicit isolated data root; overrides `ACHBIT_USER_ROOT`. Required for connected commands. |
| `--workspace DIR` | Existing directory for `launch` or `attach`; direct tools and Session operations use this scope. |
| `--control-id ID` | Override the local attachment receipt for an already attached controller. |
| `--params JSON` or `--params @FILE` | Structured parameters; an object is required. Explicit command options override matching fields. |
| `--input`, `--args`, `--command`, `--query`, `--plugin-selections`, `--recipe` | JSON or `@FILE`, parsed into structured values. |
| `--wait-ms`, `--event-sequence`, `--input-budget-tokens`, `--offset`, `--limit`, `--from-ms`, `--to-ms`, `--expected-pid` | Integer values. Other named options become strings; kebab-case becomes camelCase. |
| `--follow`, `--headless`, `--no-wait` | Flags interpreted by the relevant CLI command. |

Use `--params @request.json` for nested parameters or to avoid PowerShell JSON quoting. In PowerShell, set the root with `$env:ACHBIT_USER_ROOT = 'E:\debug-state'`. Debug state is separate from the ordinary application; launch does not copy credentials.

JSON results go to stdout. Errors go to stderr as JSON with a nonzero exit. The CLI retains failed result receipts on stdout where available. Observation streams and metrics export use JSONL. A timeout does not cancel a task or operation.

## Instance and GUI lifecycle

Run from the package directory; the test workspace must already exist:

```sh
./achbit-debug launch --artifact . --workspace /absolute/test-workspace --state-root /absolute/debug-state
export ACHBIT_USER_ROOT=/absolute/debug-state
./achbit-debug inspect
./achbit-debug gui ready
# At the end, close this launch's GUI and persistent Host:
./achbit-debug stop
```

| Command | Ownership and completion |
| --- | --- |
| `launch --artifact DIR --workspace DIR --state-root DIR [--headless]` | Creates a persistent Host and records ownership. Normal launch also creates a GUI and waits for the loaded workbench and connected Host; headless launch creates no GUI. Refuses an already running Host in that root. |
| `instances` / `inspect` | Inspect the selected state root, not all processes on the computer. With a live Host, both return its Debug snapshot. With no Host, `instances` returns `{"instances":[]}` and `inspect` fails. |
| `attach --workspace DIR` | Attaches to the discovered Debug Host. Does not acquire process ownership. Only one controller can be attached at a time. |
| `detach` | Releases the controller, direct-tool catalog and observation subscriptions. Active direct-tool operations must finish or be cancelled first. Session tasks continue. |
| `gui ready [--target main] [--gui-host-id ID]` | Reads GUI readiness, including document, bridge, Host connection and loaded component facts. A connected endpoint alone does not mean the workbench is ready. |
| `gui stop --expected-pid PID [--gui-host-id ID]` | Requests shutdown of the exact GUI, then waits up to 30 seconds for OS process exit. Success includes `exited:true`. Does not shut down a separately owned persistent Host. |
| `stop [--gui-host-id ID]` | Requires this receipt to own the current Host. Confirms the recorded GUI has exited before requesting Host shutdown; succeeds only on the matching Host's completed cleanup receipt. |

`surfaces list` publishes `guiPid` and `guiHostId` from the actual GUI process. Use those values for `gui stop`; `inspect.identity.pid` is the **Host** PID. If several GUIs are connected, select `--gui-host-id` from `inspect.guiHosts` for GUI commands. The local receipt is `<state-root>/data/agent-runtime/debug-controller.json`. Attaching to another instance does not carry over ownership; reattaching to the same launch retains it. Failed cleanup retains the receipt for diagnosis.

For a GUI started separately, attach to its state root, inspect surfaces, then close that exact GUI if authorized:

```sh
./achbit-debug attach --workspace /absolute/test-workspace
./achbit-debug surfaces list
./achbit-debug gui stop --expected-pid OBSERVED_GUI_PID --gui-host-id OBSERVED_GUI_HOST_ID
```

Use the normal Debug App startup followed by `attach` when validating GUI-owned Host lifecycle, including application updates. `launch` intentionally creates a persistent controller-owned Host, so it does not reproduce that ownership mode. Closing a GUI does not establish that every connected Host exited; check the appropriate owner. Do not close the ordinary product to validate Debug behavior.

## HTTP interface

Prefer the CLI for discovery, attachment receipts and lifecycle waits. The Debug Host also exposes these authenticated loopback interfaces:

| Endpoint | Request and response |
| --- | --- |
| `POST /api/debug/command` | `{"method":"tools.inspect","params":{"controlId":"ID","tool":"fs.read"}}`; returns the existing `{ok,data}` or `{ok:false,error,message}` envelope. CLI words map to dotted methods, such as `tools inspect` → `tools.inspect`; `action` remains `action`. |
| `POST /api/debug/observe` | `{"controlId":"ID","subscriptionId":"ID","follow":true,"waitMs":180000}`; returns `application/x-ndjson`, or the error envelope if the subscription cannot be opened. |
| `POST /api/host/shutdown` | Existing Host-shell lifecycle endpoint used by CLI `stop`, with `expectedIdentity`. Returns the same envelope with the Host shutdown receipt in `data`; `accepted` and `cleanupComplete` describe Host cleanup, not GUI exit. |

The two `/api/debug/*` routes are compiled only with `debug-control`. The Host connection comes from `<state-root>/data/agent-runtime/host-connection.json`; use its local address and the existing `x-achbit-host-shell-token` header. Do not include the token in diagnostics or example output.

`inspect`, `instances`, `attach`, and `gui.stop` do not require a controller ID. Other Debug commands use the active `controlId`. Raw `attach` also requires the discovered `instanceId`; raw `gui.stop` requires `expectedIdentity` and `expectedPid`. The CLI fills the current Host identity. The native `gui.stop` reply is only `{status:"accepted",pid,hostInstanceId}`: the CLI supplies the subsequent process-exit confirmation. Raw HTTP acceptance alone is not exit confirmation.

`launch` and `stop` are local CLI orchestration, not Debug RPC methods. `observe` uses the streaming endpoint. Internal `control.release` is invoked by `detach`, not exposed as a separate public command.

## Direct tools

```sh
./achbit-debug tools list
./achbit-debug tools inspect --tool fs.read
./achbit-debug tools call --tool fs.read --input '{"path":"one.txt"}'
./achbit-debug tools call --tool fs.read --input '{"path":"two.txt"}' --no-wait
./achbit-debug operation inspect --operation-id OPERATION_ID --wait-ms 180000
```

Each call is an independent Kernel operation with its own permissions and result. `fs.read` takes one file; submit separate calls for concurrent reads. For a pending decision, use `operation respond --operation-id ID --decision-id ID --decision allow|deny` within existing authorization, or `operation cancel --operation-id ID`. Acceptance or approval is not completion. `tools call` waits up to 180000 ms by default; `--no-wait` returns the submission immediately. Explicit `operation inspect` defaults to a snapshot, with `--wait-ms` capped at 180000. `operation release --operation-id ID` requires a terminal operation and returns its existing record; it does not cancel execution or delete stored results.

Optional plugins: `components list`, `components inspect --uri URI`, then `components activate --plugin-selections JSON` using the inspected catalog. Activation does not grant execution permission. Direct tool contexts currently lack the run-owned browser/desktop bindings; activating Computer Use alone does not make those tools callable. Use the GUI actions below when suitable. Report an unavailable path rather than starting a fixture Provider or Agent merely to manufacture GUI state.

## GUI actions

```sh
./achbit-debug surfaces list
./achbit-debug surfaces inspect --target main
./achbit-debug action --target main --name click --args '{"selector":"OBSERVED_SELECTOR"}'
./achbit-debug action --target main --name plugin.action --args '{"componentId":"OBSERVED_ID","action":"OBSERVED_ACTION","arguments":[]}'
```

Use current surface IDs, selectors, component signatures and availability from inspection. DOM actions: `click`, `type`, `select`, `key`, `scroll`, `focus`, `wait`. A component callback returning does not establish asynchronous business completion.

Add `waitFor` to `--args` to observe a result, with `timeoutMs` up to 15000:

```json
{"selector":"OBSERVED_SELECTOR","waitFor":{"selector":"RESULT_SELECTOR","visible":true,"text":"Expected text","timeoutMs":15000}}
```

Conditions also support `value` / `absent`, or `{"componentId":"ID","path":["data","activeSessionId"],"equals":"SESSION_ID"}`. A UI condition is not a task terminal state. Clicks check the real hit target; keyboard dispatch does not guarantee native editing defaults.

Native selectors use `surfaces inspect --target native-dialog`, then `action --target native-dialog` with observed `dialogId` and node paths:

| Action name | Arguments |
| --- | --- |
| `dialog.inspect` | `nodePath` for an observed subtree |
| `dialog.press` | `nodePath`, optional published `action` |
| `dialog.setValue` | `nodePath`, `value` |
| `dialog.selectRow` | `nodePath`; macOS collection selection also uses `collectionPath` |
| `dialog.cancel` | Current `dialogId` |

For a native menu, use `action --target main --name menu.select` with the `itemPath` returned by `surfaces list`. macOS dispatches the native action on the main queue after the Debug callback returns, so menu Quit can enter the normal application exit path without locking the callback. An action that closes its own GUI may lose the subsequent observation or connection; use `gui stop` when the goal is confirmed process shutdown.

Window actions use `window.focus`, `window.minimize`, `window.show`, `window.hide`, `window.maximize`, `window.unmaximize`, or `window.close`. `window.close` is a window action; use the lifecycle commands above for process cleanup.

Use published AX/UIA actions; the original `nativeDialogs.lastResult` confirms selection or cancellation. System permission and external login windows require human handling.

Receipts retain before/after observations, errors, operation identity, timings and `screenshot.contentRef`. Missing render/capture or truncated observation returns `partial` and a nonzero CLI exit. Inspect that receipt; do not replay an action just to obtain a screenshot. Load the original capture through an available image reader when visual evidence is needed; a path, archive or presentation alone does not load pixels.

## Session tasks and results

```sh
./achbit-debug task submit --text 'Read one.txt and report its contents' --follow
# Or follow future events of an existing task:
./achbit-debug observe subscribe --session-id SESSION_ID
./achbit-debug observe --subscription-id SUBSCRIPTION_ID --follow --wait-ms 180000
./achbit-debug task inspect --session-id SESSION_ID
./achbit-debug observe status --subscription-id SUBSCRIPTION_ID
```

`task submit` subscribes before execution. One `--follow` connection delivers grouped text/tool facts, decisions and terminal state. Quiet timeouts do not cancel work; keep that connection instead of repeatedly polling or analyzing each stream fragment. An existing-task subscription covers future events, not history. Read the task's own terminal result; a closed stream is not success. Without `--follow`, `observe` returns one frame; with it, quiet wait timeouts emit a status frame and continue on the same connection. Disconnecting a follow stream releases that subscription, not the task. `observe status` is a diagnostic snapshot of an existing subscription, not a replacement for pushed events.

To select plugins, read `components list` and supply `pluginSelections` in `task submit --params @request.json --follow`. Each selection contains `selectionId`, `uri` and `label`. The Host resolves selected URIs from its current catalog and reports unavailable or disabled plugins. The catalog revision remains part of the observed runtime snapshot; callers do not forward it with selections.

| Need | Command |
| --- | --- |
| Follow-up input | `task message --session-id ID --text TEXT` |
| Answer an existing decision | `task respond --session-id ID --command JSON` using its actual schema |
| Cancel a task | `task cancel --session-id ID --run-id ID` |
| Original operation result | `result read --operation-id ID` |
| Original tool record | `result read --record-id ID` |
| Original Session event | `result read --session-id ID --event-sequence N` |

Forwarded child decisions retain `sourceSessionId` and `agentRoute`; respond using the child's identity. To change delegation, inspect `subagentSettings`, retain the complete object, then respond with `{"type":"session.subagent-settings.set","settings":{...}}`. Disabling blocks new tasks, not existing ones. Settings commands do not start model requests.

## Measurements

```sh
./achbit-debug metrics query --kind tool --tool fs.read --group-by tool,status
./achbit-debug metrics query --kind ui --event click
./achbit-debug metrics query --kind component --group-by component,event
./achbit-debug metrics query --kind session --session-id SESSION_ID
./achbit-debug metrics query --kind provider --session-id SESSION_ID
./achbit-debug metrics export --kind tool > tool-metrics.jsonl
```

| Kind | Source |
| --- | --- |
| `tool` (default) | Independent Kernel tool operations and timing. |
| `component`, `ui`, `event` | GUI component/action measurements; these names route to the same GUI measurement interface. |
| `session`, `run` | Session timing for `sessionId`, optionally `runId`. |
| `provider` | Provider request measurements and usage. |
| `usage` | Existing usage query API; supply its structured query through `--query` or `--params`. |

`metrics export` writes each available record as a JSONL line and finishes with a `metrics.summary` line containing the remaining metadata. Use `--params JSON` or `@FILE` for filters; `fromMs` / `toMs` are epoch milliseconds. Kernel timing uses `Us`; UI/component timing uses `Ms`. Preserve coverage and unknown values; do not sum overlapping spans or mix Session-only and child-inclusive usage. External controller tokens are not measured by the target.

Stop when the requested behavior has sufficient evidence. Direct actions, fixtures, real-model tasks and native visual checks prove different things; they are not a checklist to run every time.
