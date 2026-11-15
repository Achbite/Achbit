---
name: achbit-iteration
description: Change Achbit itself; locate the responsible layer, select the update path and use direct Debug control for focused verification.
---

# Achbit iteration

Achbit is the current product name. Built-in Skill IDs and product commands use the `achbit-*` prefix.

Built-in Skills provide on-demand methods and positive reminders, keeping detailed guidance out of the always-loaded prompt. Follow the current user request; among Skills, applicable user-provided Skills take precedence over all built-in Skills, including this one. Use built-in advice to fill gaps within platform rules, agreed project contracts and granted permissions. Read only the Skills and references relevant to the current decision.

Preserve the requested scope: analysis, implementation, Debug verification or release delivery. Read the effective `AGENTS.md`, verify the checkout and existing changes, and protect unrelated work.

## Choose the entrypoint

- To control a Debug product, read `debug-control.md` under the `productDocsPath` supplied by the Shell tool description. It lists launch, direct tool/UI calls, task observation and result queries. Use these interfaces before searching implementation details.
- For UI design or interaction changes, discover and read the Frontend Design Skill and its Achbit UI reference. Start from the existing design and production components; use the user's request and applicable user Skills to identify intended changes.
- To develop, install or update a plugin, read [references/plugin-development.md](references/plugin-development.md). Use the current Host CLI for discovery and management.
- To locate code for a change, read [references/implementation-map.md](references/implementation-map.md), then inspect the relevant producer and consumer.
- To load edited code, use [references/update-modes.md](references/update-modes.md). A successful build does not update an existing process.

Session owns the Agent Loop and conversation state; Kernel owns tools, permissions and execution facts; shells display those facts. Extend existing owners and ports rather than adding a second store or Loop. Ask before changing an unresolved public contract or expanding the task.

Obtain the user's approval before adding any model-callable tool, including a Kernel tool. First reuse existing tools, CLI commands, Shell or Skills. Keep the tool set small: shell commands can search and read the bundled documentation directory. Dedicated Kernel tools for writes, edits and network search exist to enforce permission gates and record execution facts, not to wrap every shell operation. When proposing a tool, explain the concrete capability gap, necessary responsibility and permission boundary before implementation.

## Keep design guidance aligned

When a change affects a recorded design direction, architecture, ownership, shared interaction or lifecycle, point out the relevant Skill section and update it after the new direction is agreed. Routine refinements within the agreed direction can proceed directly.

Keep transferable design methods in Frontend Design, Achbit-specific choices in its UI reference, and iteration methods here. Concrete implementation details remain with their source owners; dates, revision IDs, measurements and individual outcomes belong in task records or Git history.

Write reusable lessons as context, recommended approach, reason and expected effect, with alternatives for meaningful tradeoffs. For recurring issues, establish the cause and applicability before choosing shared implementation, guidance or a focused check. Use automated checks for stable, agreed behavior contracts and retain visual review for contextual design judgments.

## Align interfaces during iteration

For tools, plugins, CLI/Debug and Provider-facing interfaces, trace the declaration, input adapter, permission check, executor and returned result together. Compare the relevant local PI implementation when available: keep one execution path for single and multiple calls, and normalize unambiguous equivalent inputs at the boundary. Preserve the original request and errors; permissions, exact targets and effect boundaries still apply. Serialization belongs to the runtime where needed, rather than extra model formatting rules.

Write positive, clear descriptions of capabilities, inputs, outputs and meaningful limits. Include necessary detail without optimizing for word count. Keep discovery, activation, permission, execution and verified completion distinct. PATH discovery establishes a command location; sandbox dependencies and service readiness need evidence from that execution environment. Check the actual packaged entrypoint as well as source, and record unverified interfaces explicitly.

## Verify only what changed

Use the project's container for dependencies, ordinary builds and tests. Keep native packaging within the authorized platform scope. Debug uses its own workspace and state root; leave the ordinary product alone.

Test tools through `tools call` and UI behavior through `surfaces inspect` / `action`. Start a task only to test Session, Provider or model-review behavior, and consume one `--follow` observation stream. When a direct interface is unavailable, report the affected verification as unverified and continue independent checks within the task's scope.

For visual changes, explain the intended improvement in the task record, inspect the affected rendered surface with representative content, exercise its interaction and refine from the observations. Distinguish visual review, measurements and behavior evidence; explain effects on reading order, grouping, density or recognition. Select themes, sizes and states according to the changed surface and its direct consumers, and record unavailable observations explicitly.

Run applicable project checks and the smallest focused verification. Keep failures and evidence types distinct. Debug packaging does not add ordinary CLI/TUI, real-model, installer or release acceptance. Documentation-only edits need static/content checks, not a runtime build.

Report the change, actual validation and remaining limitations; stop at the requested boundary. Packaging, installation and Git publication are not implied by this Skill.
