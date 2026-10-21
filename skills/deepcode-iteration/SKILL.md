---
name: deepcode-iteration
description: Change DeepCode itself; locate the responsible layer, select the update path and use direct Debug control for focused verification.
---

# DeepCode iteration

Preserve the requested scope: analysis, implementation, Debug verification or release delivery. Read the effective `AGENTS.md`, verify the checkout and existing changes, and protect unrelated work.

## Choose the entrypoint

- To control a Debug product, read `doc.read` with `name="debug-control.md"`. It lists launch, direct tool/UI calls, task observation and result queries. Use these interfaces before searching implementation details.
- To locate code for a change, read [references/implementation-map.md](references/implementation-map.md), then inspect the relevant producer and consumer.
- To load edited code, use [references/update-modes.md](references/update-modes.md). A successful build does not update an existing process.

Session owns the Agent Loop and conversation state; Kernel owns tools, permissions and execution facts; shells display those facts. Extend existing owners and ports rather than adding a second store or Loop. Ask before changing an unresolved public contract or expanding the task.

## Verify only what changed

Use the project's container for dependencies, ordinary builds and tests. Keep native packaging within the authorized platform scope. Debug uses its own workspace and state root; leave the ordinary product alone.

Test tools through `tools call` and UI behavior through `surfaces inspect` / `action`. Start a task only to test Session, Provider or model-review behavior, and consume one `--follow` observation stream. An unavailable direct interface is a limitation to report, not a reason to invent a Provider harness for unrelated UI checks.

Run applicable project checks and the smallest focused verification. Keep failures and evidence types distinct. Debug packaging does not add ordinary CLI/TUI, real-model, installer or release acceptance. Documentation-only edits need static/content checks, not a runtime build.

Report the change, actual validation and remaining limitations; stop at the requested boundary. Packaging, installation and Git publication are not implied by this Skill.
