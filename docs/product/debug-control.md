# Debug control quick reference

Use `achbit-debug` to control an isolated Debug build directly. Tool and UI actions need no model or Agent Loop. Use task commands only when the behavior under test involves Session, Provider or model review. A Debug package does not imply ordinary CLI/TUI, installer or release acceptance.

## Start and stop

Build through the project's Docker entrypoint: `bash ./build.sh -debug --stage package-macos` or `--stage package-windows`. Packages are under `bin/debug/macos-arm64` and `bin/debug/win64`, without Setup/PKG or global command installation. Linux Debug builds are unsupported.

Run from the package directory; the test workspace must already exist:

```sh
./achbit-debug launch --artifact . --workspace /absolute/test-workspace --state-root /absolute/debug-state
export ACHBIT_USER_ROOT=/absolute/debug-state
./achbit-debug inspect
./achbit-debug --help
# At the end, release this launch's GUI and Host:
./achbit-debug stop
```

On Windows use `.\achbit-debug.cmd` and `$env:ACHBIT_USER_ROOT = 'E:\debug-state'` in PowerShell. Keep the package's relative paths intact.

- Every connected command needs `--state-root DIR` or explicit `ACHBIT_USER_ROOT`. Keep Debug data separate from the ordinary product; credentials are not copied.
- `launch --headless` starts only the Host. Normal launch checks GUI readiness, not just a PID.
- `attach --workspace DIR` controls an existing Debug instance; `detach` releases the attachment, not its tasks. `stop` closes only launch-owned processes.
- Rebuilding does not update running code. Check the intended GUI and Host after a restart; do not stop the ordinary product for Debug validation.

## Direct tools

```sh
./achbit-debug tools list
./achbit-debug tools inspect --tool fs.read
./achbit-debug tools call --tool fs.read --input '{"path":"one.txt"}'
./achbit-debug tools call --tool fs.read --input '{"path":"two.txt"}' --no-wait
./achbit-debug operation inspect --operation-id OPERATION_ID --wait-ms 180000
```

Each call is an independent Kernel operation with its own permissions and result. `fs.read` takes one file; submit separate calls for concurrent reads. For a pending decision, use `operation respond --operation-id ID --decision-id ID --decision allow|deny` within existing authorization, or `operation cancel --operation-id ID`. Acceptance or approval is not completion.

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

For a native menu, use `action --target main --name menu.select` with the `itemPath` returned by `surfaces list`.

Use published AX/UIA actions; the original `nativeDialogs.lastResult` confirms selection or cancellation. System permission and external login windows require human handling.

Receipts retain before/after observations, errors, operation identity, timings and `screenshot.contentRef`. Missing render/capture or truncated observation returns `partial` and a nonzero CLI exit. Inspect that receipt; do not replay an action just to obtain a screenshot. Load the original capture through an available image reader when visual evidence is needed; a path, archive or presentation alone does not load pixels.

## Session tasks and results

```sh
./achbit-debug task submit --text 'Read one.txt and report its contents' --follow
# Or follow future events of an existing task:
./achbit-debug observe subscribe --session-id SESSION_ID
./achbit-debug observe --subscription-id SUBSCRIPTION_ID --follow --wait-ms 180000
./achbit-debug task inspect --session-id SESSION_ID
```

`task submit` subscribes before execution. One `--follow` connection delivers grouped text/tool facts, decisions and terminal state. Quiet timeouts do not cancel work; keep that connection instead of repeatedly polling or analyzing each stream fragment. An existing-task subscription covers future events, not history. Read the task's own terminal result; a closed stream is not success.

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

Use `--params JSON` or `@FILE` for filters; `fromMs` / `toMs` are epoch milliseconds. Kernel timing uses `Us`; UI/component timing uses `Ms`. Preserve coverage and unknown values; do not sum overlapping spans or mix Session-only and child-inclusive usage. External controller tokens are not measured by the target.

Stop when the requested behavior has sufficient evidence. Direct actions, fixtures, real-model tasks and native visual checks prove different things; they are not a checklist to run every time.
