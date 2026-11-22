# Source entrypoints

Use this map for implementation changes, not routine product control. Paths are relative to the current Git root. Start at the relevant entry and its direct consumers rather than searching the whole repository.

| Area | Start here |
| --- | --- |
| GUI layout, Reader, settings | `userspace/gui/src/components/`, `userspace/gui/src/achbit-gui/`, `userspace/gui/src/state/` |
| CLI / TUI | `shells/cli/src/`, `shells/tui/src/` |
| Loop, context, review | `userspace/session-core/src/local-agent/`: `loop.ts`, `contextComposer.ts`, `coreInstructions.ts`, `approvalReview.ts` |
| Session input and projection | Same directory: `actor.ts`, `sessionControls.ts`, `reducer.ts` |
| Tool definitions/execution | `crates/achbit-kernel-tools/src/registrations/`, `crates/achbit-kernel-runtime/src/`, daemon `local_agent_kernel*` |
| Provider / plugin adapters | `crates/achbit-kernel-daemon/src/`: `provider_transport.rs`, `llm_transport.rs`, `local_agent_plugins.rs`, `local_agent_mcp.rs` |
| Shared contracts | `userspace/protocol/src/`, `contracts/agent-runtime/schema.json` and corresponding Rust interfaces |
| Artifacts / visual input | Daemon `artifact_resources.rs`, `tool_images.rs`; Session `visualContext.ts`, `deliverables.ts` |
| Native browser | `shells/shared/native_browser/`, daemon `browser_tools.rs` |
| Debug control | `shells/cli/src/debug.rs`, daemon `debug_control.rs`, `debug_tools.rs`, `local_agent_kernel/debug_operations.rs` |
| Observation / timing | `userspace/session-core/src/debug/observations.ts`, `local-agent/runTiming.ts`, `providerAttempts.ts` |
| Built-in docs / Skills | `docs/product/`, `skills/`; embedded registry in daemon `local_agent_product_tools.rs` |
| Build / package | `build.sh`, `scripts/package-runtime.py` |

Here, “daemon” means `crates/achbit-kernel-daemon/src/`; “Session” means `userspace/session-core/src/local-agent/` unless a full path is given.

## Follow one request across the boundary

Use these paths relative to the **actual Git root**, not a project display name or the parent workspace. If the checkout is nested, list the bound workspace first and use the returned repository directory. For a moved source file, search for its declaration before reading a replacement path.

| Symptom | Source of the first relevant fact | Follow it to |
| --- | --- | --- |
| Model chooses a guessed path or reads two same-named files as if they were one | Session `codingTools.ts` supplies the shared Read/Shell rules; `contextComposer.ts` and `providerToolCodec.ts` record this request’s visible operations, aliases and workspace handles | Kernel `crates/achbit-kernel-runtime/src/executors/fs.rs` reports the actual target error. Session `modelToolResult.ts` returns the record’s error; do not turn `NotFound` into permission denial or try other paths invisibly. |
| A registered tool is missing from the model request | `crates/achbit-kernel-tools/src/registrations/mod.rs` lists the base tools; daemon `local_agent_tool_catalog.rs` constructs this run’s bindings | `contextComposer.ts` filters the current stage and `providerToolCodec.ts` maps callable names. Compare `context.composed` with the actual Provider request, not a global tool count. |
| Plugin appears in discovery but cannot run | Daemon `local_agent_plugins.rs` builds the catalog; Session `pluginActivation.ts` and `loopTurn.ts` process model activation separately from explicit user selection | `local_agent_api.rs` prepares the replacement view; `local_agent_kernel.rs` admits each requested effect. Look for the next request’s declaration, then the actual ToolRecord or rejection. A file-backed Skill adds a location, not an executable. |
| Tool call was displayed, but execution or its result is uncertain | `userspace/protocol/src/localAgent.ts` defines `KernelPort`; Session `httpPorts.ts` sends the fixed request; daemon `routes.rs` and `local_agent_api.rs` carry the execution reply | Kernel `local_agent_kernel.rs` owns the attempt outcome. Session `loopTools.ts` checks identity before the journal/reducer consumes it. An input rejection, a pending approval and a failed effect are different facts. |
| A child finished, but the coordinator has only a message | Session `agentManager.ts` manages member/task identities; `loopTurn.ts` handles control settlement | Compare child run settlement with the resulting parent task event. Delivery of a message alone neither completes work nor grants permission. |

## Extension choice

| Need | Existing form |
| --- | --- |
| Presentation | `achbit-ui.json`; `ui-plugins.md` in `productDocsPath`; `ui-plugins/` examples |
| Task instructions | `SKILL.md`, `skills.mounts` |
| Local executable tool | `achbit-tool.json`; `examples/plugins/cli-text/` |
| External tool server | `mcp.servers`, existing MCP adapter |
| Core behavior | Existing Kernel/Session service port, not a display plugin |

Session owns conversation semantics; Kernel owns permission/execution facts; UI displays them. Check producer and consumer when changing a contract. Keep request snapshots and lifecycle ownership where required. Registration, activation and permission are separate. A public plugin API can have consumers outside this repository.
