---
name: deepcode-product
description: Explain DeepCode tools, Plans, execution environments, settings and plugins; diagnose Windows shell, missing developer tools and product issues using the recorded facts.
---

Session owns the single Agent Loop, context, interactions, Plan/Todo and terminal state. Kernel owns tool registration, permissions, execution and tool records. GUI, CLI and TUI consume the same Session projection.

Use the actual tool names, arguments and availability in the current run catalog. Basic session queries can call `session.read` directly; reading this Skill is not a prerequisite. When guidance is useful, use `skill.read` to load only the relevant entry or reference. Skill text enters history as an ordinary tool result; reading it does not activate a plugin or rebuild the current catalog. For querying or continuing existing work, see `deepcode-session`.

A Plan describes intended changes, scope and validation. Once confirmed, command details and edit methods for the same targets may change without another confirmation. Expanding authorized targets or deletion scope requires a user decision. Read-only investigation does not require a Plan.

Subagent settings belong to each conversation. The Settings center supplies new-conversation defaults; a conversation's explicit settings save also updates those defaults without changing other existing conversations. When enabled, actively delegate useful independent work within the user's authorized scope; no separate request to use subagents is needed. Keep short or tightly coupled work in the main conversation. Disabling new delegation does not cancel existing child tasks or remove their supported management operations.

The first user message can generate a short conversation title through a separate background model request. Later messages do not regenerate it, and a user-chosen title takes priority. This request does not block the task or enter its Agent Loop; its usage is recorded separately as `conversationTitle`.

Use Todo for multi-step work when it helps. Keep phases few and meaningful, merging related work; choose a count suited to the task. `todo.update` replaces the complete ordered list of descriptions and statuses without requiring a Plan or ToolRecord IDs. Skip trivial or unchanged updates. Progress neither grants tool permission nor gates the final answer; retain the actual status of unfinished or blocked work.

Ask clarification questions with `interaction.request` and `mode: continue` when independent work can proceed. Answers arrive at a later request boundary; silence does not select an option. After independent work and its response, unanswered questions keep the same run waiting. Confirmations, Plan approval and execution permission remain separate decisions.

Tool artifacts are archived resources. Use `artifact.present` to select requested results and review material for the output panel, then cite the returned resource URI in final prose. Use `artifact.prepare` for an existing file or `artifact.preview` for a live URL without an artifact ID. Temporary scripts, logs and observation screenshots stay intermediate unless requested as deliverables; presentation does not add pixels to model context.

Waiting for an answer or approval keeps the bound Host alive. Reopening the GUI does not silently retarget the run: the user can choose **Continue in this window** for subsequent requests. Observe again or reopen previews after rebinding; earlier calls keep their original target. For execution approval, “Approve for me” reviews the exact operation against original user authorization and recorded progress. Requester promises of safety do not establish authorization; uncertainty or review failure requires user input.

For product behavior and configuration, use `doc.read` with `name="operations.md"` or `name="execution-environments.md"`. Use `name="model-services.md"` for connections, models, Coding Plans, image input and usage pricing. Product docs are English Markdown and are separate from this workflow Skill.

For isolated DeepCode development control, read `doc.read` with `name="debug-control.md"`. The Debug CLI directly invokes tools and GUI actions, follows grouped task observations and queries recorded usage/durations. Only an explicit Debug build exposes those control/query endpoints. Normal builds still record conversation timing and show the measured response-to-settlement duration beside the existing execution-process disclosure when available; absent historical facts remain absent.

For UI display plugins and hot replacement, read `doc.read` with `name="ui-plugins.md"`. Write against the documented display slots and lifecycle; adding files does not activate a plugin. The user selects the plugin folder in Settings. Do not expose or replace the Agent Loop or underlying tools through a display plugin.

For developing DeepCode itself, read `deepcode-iteration` through `skill.read` when its workflow is relevant. For requested release preparation, code simplification or README/product documentation synchronization, read `deepcode-release-audit`. These Skills guide the requested work; reading them does not approve execution, confirm a Plan or authorize publication.

For Windows shell selection, missing developer tools and platform differences, read [references/windows-environment.md](references/windows-environment.md).
