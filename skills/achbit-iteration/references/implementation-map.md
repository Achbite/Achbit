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

## Extension choice

| Need | Existing form |
| --- | --- |
| Presentation | `achbit-ui.json`; `ui-plugins.md` in `productDocsPath`; `ui-plugins/` examples |
| Task instructions | `SKILL.md`, `skills.mounts` |
| Local executable tool | `achbit-tool.json`; `examples/plugins/cli-text/` |
| External tool server | `mcp.servers`, existing MCP adapter |
| Core behavior | Existing Kernel/Session service port, not a display plugin |

Session owns conversation semantics; Kernel owns permission/execution facts; UI displays them. Check producer and consumer when changing a contract. Keep request snapshots and lifecycle ownership where required. Registration, activation and permission are separate. A public plugin API can have consumers outside this repository.
