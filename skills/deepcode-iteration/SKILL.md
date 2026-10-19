---
name: deepcode-iteration
description: Iterate on DeepCode itself, including its UI, Session/Agent Loop, Kernel tools and plugins; choose the owning layer and the correct update workflow. Not for developing unrelated projects with DeepCode.
---

# DeepCode iteration

Use this Skill for changes to DeepCode itself. Preserve whether the user requested analysis, a prototype, implementation or acceptance. Existing authorization and confirmed decisions remain valid; reading this Skill does not approve a Plan, grant execution permission or authorize publication.

Establish the actual source checkout, branch and existing changes. Read the effective project `AGENTS.md`, including applicable instructions in an outer worktree directory. Do not assume a personal path, a particular branch or that the running application uses this checkout. Recent conversations can explain decisions; use exact supplied session IDs with `session.read` and verify historical claims against current code. Do not scan unrelated user data for history.

Read resources with `skill.read`, name `deepcode-iteration`, and only the relevant relative path:

- [references/implementation-map.md](references/implementation-map.md): ownership, source entrypoints and plugin forms.
- [references/update-modes.md](references/update-modes.md): edit/preview/update workflows and verification.

For controlling and measuring an isolated DeepCode development build, prefer its Debug CLI. Read `doc.read` with `name="debug-control.md"` for launch, direct tool/UI actions, grouped observation and metrics. The control interface exists only in the explicit Debug build; ordinary conversation timing is also available in normal builds. Do not use the running stable product as the test target merely because it is already open.

## Implement at the owning layer

Trace the input, producer, contract, consumer and state owner before editing. Session owns the single Loop, context, interactions and semantic projection; Kernel owns tools, permissions and execution facts; shells present shared results and collect input. Approved changes can span layers without another architecture decision. Present a concrete recommendation only when new evidence exposes an unresolved public contract or material behavior choice.

For UI customization, first inspect existing components and display slots. Use the plugin form suited to the requested change; extend a slot only with data and actions from its existing owner. Do not give a display plugin a second conversation store, permission model or settings source. Keep ordinary tool changes out of the Loop unless its contract actually needs to change.

For tools and plugins, follow registration, availability, activation, request binding, execution, output and disposal. Writing a plugin, adding a source and successfully running a contribution are distinct outcomes. Control external programs through the interface suited to the requested operation: an appropriate CLI, an available MCP tool, or GUI interaction. A program having a GUI does not make its ordinary operations GUI tasks; use Git CLI or a suitable MCP tool for Git operations. Use screenshots when the requested interaction or verification depends on the visible interface. Combine programmatic control and visual checks when the task needs both, without adding a screenshot after every CLI/MCP call.

Use the project's container for dependencies, normal builds and tests after checking its actual checkout mount. Host inspection needed to locate that environment still follows the current execution permission process; a read-only probe does not approve itself. Keep native packaging within the user's authorized platform scope.

## Make the change observable

Choose the update path from the reference: Vite HMR, UI plugin replacement, application interface reload, the next model request, the next run, or a core process restart. Edit, let the appropriate update occur, then observe the same target and exercise the changed behavior. A successful build alone does not establish that the current window or process loaded it.

Separate one action from a task trajectory. Direct tools and UI actions do not need an Agent Loop. For a task, consume the Debug CLI's pushed observation groups rather than repeatedly querying status or sending each token/tool fragment to the controlling model. Retain operation, call, attempt and run identities when querying the original results and measured durations.

Run the existing required checks and focused validation appropriate to the change. Follow the project's test-change rules before changing test assets. Keep prototype, fixture, real Provider, native GUI and other-platform evidence distinct; respect manual acceptance retained by the user.

Update directly affected user guidance or public plugin contracts. Report the behavior change, owning layer, update method, actual validation and relevant unverified items. Stop at the requested acceptance boundary. Whole-release cleanup and Git publication are separate scopes; proceed to them only when already requested.
