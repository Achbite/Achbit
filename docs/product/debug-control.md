# DeepCode Debug control

The Debug CLI controls an isolated DeepCode development product. A controlling Agent can invoke a tool, operate the GUI, observe a task and query measurements through structured commands. Direct actions do not start another Agent Loop. A task uses DeepCode's existing Session Loop and Kernel permissions.

## Build and launch

Run `bash ./build.sh -debug` through the repository's Docker build entrypoint to select available Windows x64 and macOS Apple Silicon targets. Use `--stage package-windows` or `--stage package-macos` to select one explicitly. Linux Debug stages fail explicitly. Windows uses the existing GNU cross toolchain; macOS native compilation and signing use the existing packaging bridge.

Windows produces `bin/debug/win64` and a ZIP under `bin/debug`, containing `DeepCode-Debug.exe`, its runtime and `deepcode-debug.cmd`. macOS produces `bin/debug/macos-arm64` and its archive, containing `DeepCode-Debug.app` and `deepcode-debug`. Keep their relative paths intact. Debug produces no Setup/PKG and installs no global command. Normal builds retain their ordinary output directories, applications and installers without the Debug control interface.

The Debug app has a separate application identity and default user root: `%LOCALAPPDATA%\DeepCode-Debug` on Windows, `~/Library/Application Support/DeepCode-Debug` on macOS. CLI launch requires an explicit independent state root and an existing test workspace:

```sh
./deepcode-debug launch --artifact . \
  --workspace /absolute/test-workspace --state-root /absolute/debug-state
export DEEPCODE_USER_ROOT=/absolute/debug-state
./deepcode-debug inspect
./deepcode-debug --help
```

In Windows PowerShell, use `.\deepcode-debug.cmd launch --artifact . --workspace 'E:\test-workspace' --state-root 'E:\debug-state'`, then `$env:DEEPCODE_USER_ROOT = 'E:\debug-state'`. Use `.\deepcode-debug.cmd` for the following commands. WebView2 awaits asynchronous dispatch and captures the actual target viewport.

Every connected command requires that state root, either through `--state-root` or the explicit environment variable. `launch --headless` starts only the Host. `inspect` reports the current instance and registered GUI hosts; GUI actions require an available GUI. Configure models in the independent product as needed; launch does not copy credentials from the ordinary product.

GUI launch waits up to 20 seconds for the process to remain alive, the control endpoint to register, and the main workbench to load with its Host connected. The `gui` result reports readiness and elapsed time. An early exit or readiness failure exits nonzero and retains the owned-instance receipt for explicit `stop`; a spawned PID alone is not readiness.

Use `attach --workspace ...` to control an existing Debug instance. `detach` releases the control attachment; it is not a task-cancellation command. `stop` closes only the GUI/Host owned by the launch receipt and confirms their lifecycle result. Rebuilding a package does not replace a running process. A newly opened GUI can use an existing Host, so verify the loaded process and Host when testing changed Session, Kernel or compiled-in guidance. Keep ordinary-product installation and replacement separate from Debug iteration.

## Direct tools and plugin components

```sh
./deepcode-debug tools list
./deepcode-debug tools inspect --tool fs.read
./deepcode-debug tools call --tool fs.read --input '{"path":"one.txt"}'
./deepcode-debug tools call --tool fs.read --input '{"path":"two.txt"}' --no-wait
./deepcode-debug operation inspect --operation-id OPERATION_ID --wait-ms 180000
./deepcode-debug components list
```

`tools call` creates an independent Kernel operation with its own identity, permission result, cancellation and timing. It does not create a Session, call a Provider or fabricate a model message. Without `--no-wait`, the CLI makes a bounded wait for the result. A waiting or admitted operation is not a completed execution.

Each `fs.read` input still names one file. Submit separate operations concurrently, or submit several with `--no-wait`, to exercise multiple reads. The shared execution scheduling permits up to four reads in flight; there is no special read pool or multi-path read schema. Ordinary Agent scheduling also allows consecutive independent reads to run concurrently while preserving write/other-tool ordering boundaries. For a task that needs a batch shell read, use the shell tool through its normal permissions.

An operation requiring approval returns its operation and decision identities. Use `operation respond --operation-id ... --decision-id ... --decision allow|deny` within the user's existing delegation, or `operation cancel --operation-id ...`. Direct operations use Kernel permissions and their own approval; they do not borrow another Session's Plan or bypass workspace restrictions.

`components list`, `components inspect` and `components activate --plugin-selections JSON` use the existing plugin catalog. Inspect available contributions and their arguments before activation. GUI component instance actions are a separate part of the surface inspection below.

## GUI and embedded pages

```sh
./deepcode-debug surfaces list
./deepcode-debug surfaces inspect --target main
./deepcode-debug action --target main --name click --args '{"selector":"OBSERVED_SELECTOR"}'
```

Use the returned surface IDs for embedded pages and frames; do not assume an old page or component ID is still mounted. DOM actions include `click`, `type`, `select`, `key`, `scroll`, `focus` and bounded `wait`. A click checks its real hit target and reports `debug_element_covered` when another element covers it. Keyboard dispatch does not claim native editing defaults.

Surface inspection also lists mounted UI components and their allowed callback signatures. Invoke a listed callback with `--name plugin.action --args '{"componentId":"OBSERVED_ID","action":"OBSERVED_ACTION","arguments":[]}'`, supplying the actual argument list. A component handler returning or resolving is not proof that its asynchronous business operation has finished. Submitting a message through the UI still follows the normal Session path.

Component owners can publish current `availability`, its `reason`, and the business completion they verify. Undeclared availability/completion remains explicit; the registry does not infer Session facts. Availability is checked again at invocation. Navigation refreshes the actual catalog for an externally created conversation and verifies its loaded projection before returning `session-loaded`.

For a state observation, pass `waitFor` with an inspected DOM `selector` plus `text`, `value`, `visible` or `absent`; or with an inspected `componentId`, an input `path` array and `equals`. `timeoutMs` is bounded to 15 seconds. For example, `{"componentId":"OBSERVED_ID","path":["data","activeSessionId"],"equals":"SESSION_ID"}` observes the owner's projected input. This condition does not assert that an Agent run settled.

Action receipts contain before/after state where available, native-dialog state, an operation ID, screenshot reference and measured phases. Read the original error and terminal status even when a later observation shows a side effect. The CLI retains the failed receipt and exits nonzero for failed terminal actions. Screenshots observe the real target; they are not automatically model input or published artifacts.

Inspection reports text/element truncation and each DOM control's supported actions and disabled/read-only state. A timed-out condition preserves the action result, error and subsequent observation. Missing render, truncated observation, unavailable measurements or missing screenshot produces `status: partial` and `observationFailures`; the CLI exits nonzero without replaying the action. Read the original `screenshot.contentRef` to use that capture as visual input. Component timing records collected with an action retain their own identities and are not a causal breakdown of the action.

### Product-owned native file selectors

On Windows, the product-owned file picker runs in its own COM apartment so GUI inspection remains available. Inspection exposes actual UI Automation nodes, `nodePath`, supported actions and attribute errors. Use `dialog.press` with the published `Invoke` action, `dialog.setValue` with `value`, or `dialog.selectRow` for a selectable node. Include the observed `dialogId`; actions do not directly fabricate paths. The original picker completion publishes `nativeDialogs.lastResult` as `selected`, `cancelled` or `failed`. Capture covers only that picker. Native menu items are separately listed by `surfaces list`; `menu.select` takes the observed `itemPath`. System permission and external login windows remain outside this surface.

On macOS, open the selector through the product's attachment or directory-selection UI. `surfaces inspect --target native-dialog` describes the active product-owned sheet and its actual accessibility nodes. On both platforms, `dialog.inspect` with `nodePath` can query an already observed subtree. A root query has a 512-node budget; `truncated` and `coverage` report partial observations, and individual attribute errors remain in `attributeErrors`. The following accessibility actions describe macOS:

- `dialog.selectRow` takes the actual `collectionPath` of a list and `nodePath` of its direct row child, using writable `AXSelectedChildren`. For a directly selectable sidebar row, use its `nodePath` with writable `AXSelected`.
- `dialog.press` takes `nodePath` and an optional published action, defaulting to `AXPress`. Select an item, then press the actual confirmation button. `AXOpen` can confirm a choice; it is not a directory-navigation shortcut.
- `dialog.setValue` changes a writable control's actual value. `dialog.cancel` cancels the current sheet. Include the observed `dialogId` when retaining a node path across calls.

The native completion callback is authoritative: `nativeDialogs.lastResult.status` is `selected` with the real paths, or `cancelled`. Dispatch alone does not establish that result. The screenshot captures only the product-owned sheet. System permission panels, Keychain and external login windows require human handling. Native sheet capture uses macOS 14.2 or later; unsupported APIs and actual permission failures are reported without substituting a full-desktop capture.

## Observe task trajectories

```sh
./deepcode-debug task submit --text 'Read one.txt and report its contents' --follow
# Or subscribe to future observations of an existing task:
./deepcode-debug observe subscribe --session-id SESSION_ID
./deepcode-debug observe --subscription-id SUBSCRIPTION_ID --follow --wait-ms 180000
```

Task submission installs its observation subscription before execution. Existing-task subscriptions cover future events, not a reconstructed history. The existing input queue still accepts `task message --session-id ... --text ...` while work is running; follow-up input reaches the next applicable Session request boundary. Use `task cancel --session-id ... --run-id ...` for explicit cancellation and `task respond --session-id ... --command JSON` for an existing decision's actual command schema.

`--follow` prints the original terminal receipt and exits nonzero when the observed task's own `run.settled` reports failure. A normally closed observation stream does not establish task success.

One `--follow` connection streams JSONL groups pushed by the target. It delivers the first visible text and text after tools at a complete fragment or the one-second aggregation window, with the preceding tool facts. Continuous tools accumulate until the default 100,000 estimated-token budget or 180-second age boundary. Necessary decisions and terminal state are delivered immediately. A smaller `--input-budget-tokens` on subscription/task submission limits groups to the receiver's available context. These estimates describe delivery size, not billed Provider usage.

Questions, approvals and Plan decisions from running child tasks are also pushed immediately to their task owners' subscriptions. These entries retain `sourceSessionId`, the original event identity and `agentRoute`. Reply to or read the event using the child Session identity; the enclosing parent `sessionId` and `lastEventSequence` still describe the parent's journal. This notification does not wake the parent's business Loop or copy all child traces.

The first-message title request is separate from the Agent Loop. Provider metrics identify it as `purpose: conversationTitle` and retain reported tokens, `completedAt` and `durationMs`; it has no invented run or Session Provider attempt. Unfinished or cancelled requests without a completed measurement keep null completion fields.

`--wait-ms` is bounded to 180,000 ms of waiting for the next delivery. With `--follow`, a quiet interval emits `observation.wait_timeout` with current state and `modelInput: false`, then continues waiting on the same connection. Without `--follow`, one delivery or timeout returns control to the caller. Timeout does not cancel the task. Do not turn quiet-state records, individual stream fragments or repeated status queries into separate controlling-model turns.

Observation failure reports the original failure and missing coverage while the target task continues. There is no automatic reconnect or replay. Keep event/call/attempt identities and content references when consuming groups, and read the original fact when a detailed result is needed:

```sh
./deepcode-debug result read --operation-id OPERATION_ID
./deepcode-debug result read --record-id RECORD_ID
./deepcode-debug result read --session-id SESSION_ID --event-sequence SEQUENCE
```

Subagent configuration belongs to each Session. Read `subagentSettings` with `task inspect --session-id SESSION_ID`, edit the intended fields while retaining the complete object, then submit `task respond --session-id SESSION_ID --command @settings-change.json`, where the file contains `{"type":"session.subagent-settings.set","settings":{...}}`. An accepted settings change also replaces future-session defaults; it does not change another existing Session. A replayed command does not rewrite newer defaults. Disabling prevents new delegation while existing child tasks continue. New-conversation draft edits save defaults too; creation only copies configuration. These configuration operations do not start an LLM request. Enabled delegation encourages useful independent work within the user's authorized task.

## Usage and duration queries

```sh
./deepcode-debug metrics query --kind tool --tool fs.read --group-by tool,status
./deepcode-debug metrics query --kind ui --event click
./deepcode-debug metrics query --kind component --group-by component,event
./deepcode-debug metrics query --kind session --session-id SESSION_ID
./deepcode-debug metrics query --kind provider --session-id SESSION_ID
./deepcode-debug metrics export --kind tool > tool-metrics.jsonl
```

Use `--params JSON` or `--params @FILE` for structured filters. Tool records can be selected by operation, call, attempt, run, Session, source, status, binding and time. UI/component queries support component, event, surface, status and time. `fromMs` and `toMs` are epoch-millisecond bounds; returned metadata states the selected sample range. Export emits source records and a summary as JSONL.

| Measurement | Meaning and limits |
| --- | --- |
| Tool | Kernel records distinguish queue, preparation, permission wait and executor stages. Kernel timing fields use microseconds (`Us`). Read concurrency reports executor interval overlap, summed thread time and wall-span separately. Aggregates cover returned samples, not unobserved work. |
| UI/component | GUI receipts separate handler/observation, component rendering/callback and screenshot durations in milliseconds (`Ms`). Two animation frames are an observation boundary, not a physical-paint timestamp. Component measurements collected with an action are not necessarily all caused by that action. |
| Session | Run facts retain acceptance/start, first effective response and kind, first visible text, settlement, response elapsed time and total duration. Provider-attempt and text-segment timing remain separate stages. |
| Provider usage | Physical attempts come from the existing Provider usage store; unknown usage is reported alongside the reported subtotal. Session usage and usage including child Sessions are distinct scopes and must not be added as independent totals. The external controlling Agent's tokens are unavailable unless that controller supplies them separately. |

Compare durations only within their stated clock domains and units. Preserve unknown, partial and inapplicable values; do not substitute zero or sum overlapping spans into task wall time. The first effective response is the earlier of visible text and a complete executable tool call accepted by Session. Hidden reasoning, tool-argument fragments and heartbeats do not start that measurement.

Normal and Debug builds both record Session timing. The existing execution-process disclosure shows `responseElapsedMs`, from first effective response to settlement, when recorded. Clicking still opens intermediate text/tools; detailed timing remains in queries. Historical conversations without the fact receive no estimated duration.

## Verification boundaries

A successful CLI action, a component fixture, a real Provider task and a native application check prove different behavior. Fixtures may use production components with simulated transport; do not present that as an installed-product or Provider result. A build does not prove running code changed, and a GUI reconnect does not prove an existing Host restarted. Inspect the intended package/process, exercise the changed path, preserve original failures and release only resources owned by this test. Debug control availability is not a claim that every GUI state has already been exercised.
