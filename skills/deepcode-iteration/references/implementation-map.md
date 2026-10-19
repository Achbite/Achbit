# Ownership and plugin forms

Paths are relative to the current DeepCode Git root. They are navigation hints, not a second architecture contract; verify current callers and interfaces before changing them.

## Source entrypoints

| Behavior | Start with | Boundary to check |
| --- | --- | --- |
| GUI layout, Reader and settings | `userspace/gui/src/components/`, `src/deepcode-gui/`, `src/state/` under `userspace/gui` | Component state, shared projection and existing settings API |
| CLI/TUI input and presentation | `shells/cli/src/`, `shells/tui/src/`, `crates/deepcode-kernel-client/src/` | Shared Session semantics rather than shell-owned execution facts |
| Loop, prompts, context, delegated review | `userspace/session-core/src/local-agent/`: `loop.ts`, `actor.ts`, `contextComposer.ts`, `coreInstructions.ts`, `approvalReview.ts`, `reducer.ts` | Provider requests, interactions, journal and settlement |
| Clarification questions and explicit GUI rebinding | `sessionControls.ts`, `actor.ts`, `contextComposer.ts`, `reducer.ts` in Session; GUI `InteractionCard.tsx` and `HostRebind.tsx` | One Loop and input queue; pending decisions, captured call bindings and user-selected future target |
| Archived resources, visual input and user delivery | Kernel `artifact_resources.rs`, `tool_images.rs`; Session `visualContext.ts`, `deliverables.ts`; GUI `DeepCodeTaskPanel.tsx`, `RichContent.tsx` | Kernel archive, per-request image selection and explicit Session presentation are separate responsibilities |
| Tool definitions and execution | `crates/deepcode-kernel-tools/src/registrations/`, `crates/deepcode-kernel-runtime/src/`, `crates/deepcode-kernel-daemon/src/local_agent_kernel*` | Input schema, permission/effect, output and cancellation |
| Provider and extension adapters | `crates/deepcode-kernel-daemon/src/`: `provider_transport.rs`, `llm_transport.rs`, `local_agent_plugins.rs`, `local_agent_mcp.rs` | Actual service ports; a crate name alone does not establish business ownership |
| Shared contracts | `userspace/protocol/src/`, `contracts/agent-runtime/schema.json`, corresponding Rust interfaces | Current producers, decoders, reducer and shell consumers |
| Browser and interface refresh | `shells/shared/native_browser/`, `browser_tools.rs` in the daemon, `userspace/gui/src/services/nativeBrowser.ts` and `interfaceReload.ts` | Page binding, visibility, service ownership and refresh results |
| Debug build and CLI control | `build.sh`, `scripts/package-runtime.py`, `shells/cli/src/debug.rs`, daemon `debug_control.rs` / `debug_tools.rs` | Explicit build gate, separate output/data, current control attachment, existing Kernel/GUI execution ports |
| Observation and duration queries | Session `src/debug/observations.ts`, `local-agent/runTiming.ts`, `providerAttempts.ts`; Kernel `local_agent_kernel/debug_operations.rs`; `shells/shared/native_browser/debug.rs` | Original facts and measured clock domains; grouped delivery is not a second Loop or execution store |

## Distinctions that matter

- Execution-time access approval is separate from Plan or route confirmation. Delegated review uses its deliberately bounded request context and the selected review model; an allowed default may use the current model in a separate request. Preserve the exact operation, scope and reason. Do not stuff the full conversation into review or answer user questions through execution approval.
- Investigate apparent execution before approval using the matching request, decision, execution records and actual effects. A GUI row, queued call or Provider request count alone does not prove execution. A separate approval-model request is not a retry of the main request.
- Cross-conversation preferences require the existing persistent setting and its new-Session read path. Updating only the current component or Session projection does not prove persistence after restart.
- Missing citations, errors or process output must be traced to their producer. A renderer cannot recover nonexistent source URLs from opaque markers or replace missing facts with a success state.
- Shell, path, sandbox and browser behavior depend on the platform. macOS verification does not establish Windows/WSL support. Implement and report the platforms in the current task's scope.

## Choose the extension form

| Form | Existing entrypoints | Implementation focus |
| --- | --- | --- |
| Display plugin | `workbench.uiPlugins`; `ui-plugins/`; `userspace/gui/src/ui-plugins/{types,runtime,source}.ts`; product `ui-plugins.md` | `deepcode-ui.json`, standalone ES module, published slots/scoped actions, mount/update/dispose and owned effects |
| Text Skill | `skills.mounts`; `skills/`; bundled resources in `local_agent_product_tools.rs` | Guidance and readable references; discovery, reading and activation remain distinct |
| Local CLI plugin | `plugins.sources`; `examples/plugins/cli-text/`; `local_agent_plugins.rs` | `deepcode-tool.json`, actual argv/stdin/stdout/stderr, parsing and child-process lifetime |
| MCP plugin | `mcp.servers`; `local_agent_mcp.rs` | Connection/catalog, request binding, execution permission, cancellation and disposal |
| Built-in tool plugin | `plugins/`, `local_agent_first_party_plugins.rs`, tool registrations | Reuse the existing registration and Kernel execution chain |
| Kernel/Session core service plugin | Existing service ports and Host composition root | Trusted service assembly/replacement; distinct from presentation slots |

For display API details, use `doc.read` with `name: ui-plugins.md`. Preserve Host-owned drafts, routing, scroll containers and mounted pages while replacing presentation. A module's own internal view state can reset according to its documented lifecycle.

Search exact tool names, events, settings keys, wire strings and dynamic loading paths after a change. Public plugin ports can have consumers outside this repository. Registering files is not activation; adding a source does not authorize execution. Provider-callable tools must not acquire a plugin administration port through a display or tool change.
