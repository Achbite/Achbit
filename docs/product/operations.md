# Product operations

Quick directions for using Achbit. Read only the section needed for the task; current tool schemas and returned availability determine callable operations.

## Tools and validation

- Use CLI/MCP for program operations and GUI tools for interface actions or visual confirmation. A program having a GUI does not make all its operations GUI tasks.
- File tools operate on bound workspaces. Use `fs.read` for UTF-8 files or the immediate contents of a bound directory (`.` lists its root). Use the returned cursor for the next page; use file tools for project edits and deletion. Use the project's declared environment for commands.
- Ordinary tools support a single call or multiple calls in a Provider response; each retains its own input, permission check and result. Use one `fs.edit` call for related replacements in the same file. Its input adapter accepts an edits array, a single edit object, JSON-encoded edit data, or a top-level `oldText`/`newText` pair and normalizes them before execution. Exact matching, atomicity and access checks stay the same.
- Preserve actual results: rejected input was not executed; approval is not execution; a dispatched action with a failed observation is not a fully verified action. Correct the reported cause instead of repeating an unchanged failure.
- A complete file or Skill read returns its text as-is (including an empty file). Directory listings and partial reads return entries or text with the continuation cursor. Successful tool replies contain the operation result; errors retain the cause and any known partial effect. Permission decisions remain in the journal. The working agent receives denial reasons and newly granted scopes when relevant.
- Live output is bounded. Inspect the returned full-output paths when needed; do not rerun a command just to recover its log.
- For Achbit Debug control, read [Debug control](debug-control.md). Direct tool/UI operations do not need an Agent task.

Computer Use is an optional plugin. Embedded browser tools need the originating GUI; desktop control needs its native helper and reported OS permissions. Inspect before acting, reuse the returned target identities, and use foreground observation for coordinate input. Unsupported actions do not automatically switch input methods. Never replay dispatched input solely because its screenshot failed.

Paste PNG, JPEG, GIF or WebP images into the GUI composer to add removable thumbnail attachments (up to 8 MiB each, within the shared eight-attachment limit). Upload occurs when the message is sent, including image-only messages; a failed upload preserves the draft for retry.

User images and GUI observations supply pixels for one successful request. Later requests retain references; `session.read` with `view: images` and exact current-session image IDs reopens them. A live thumbnail, file path or presented artifact is not model visual input.

## Settings and extensions

For self-development and installation, use the current Host CLI: `plugins capabilities`, then the needed `plugins guide` / `plugins template`; `plugins inspect`, `install`, `update`, `enable`, `disable`, `remove`, and `status` share the Settings operations. Target an existing instance with `--host-data-dir`. Read both registration and actual application state. New registrations enter discovery at the next model request in the same run; installation does not grant task activation or permission. The built-in `achbit-iteration` Skill includes the complete development/update workflow.

Discover a missing capability with `plugin.search`, using a short product/capability query. All keywords must match. Zero matches means that query did not match; shorten it or browse without `query`. Follow `nextOffset` only when more results are needed.

Activate relevant enabled results with `plugin.activate` alone, using their exact URIs. Tools and guidance enter the next request. Search does not start programs; activation neither installs/enables plugins nor grants permissions. User `@` mentions are optional. Read current schemas rather than guessing names or arguments.

| Source | Registration |
| --- | --- |
| Local CLI tools | `plugins.sources`, `achbit-tool.json` |
| Hosted services | `plugins.services`, `achbit-service.json`; enabled processes are owned and stopped by Host |
| External MCP | `mcp.servers`; include a useful capability `description` |
| Custom Skills | `skills.mounts`; folder or `SKILL.md` |
| Display plugins | `workbench.uiPlugins`, `achbit-ui.json`; see [UI plugins](ui-plugins.md) |

For importable artifacts, manifest fields, invocation and cleanup rules, see [Plugin development](../plugins/README.md).

Settings switches/selections save immediately; numeric fields commit with Enter. Text edits and new connections retain Save/Create. Saved runtime configuration generally applies to the next run; selected Skill/CLI-plugin content is refreshed before the next request. In-flight calls keep their captured bindings. Relevant permission revocation is checked before execution.

## Execution approval

Delegated execution review may read the current conversation and related files in its bound workspaces before deciding. It uses the existing `session.read` and `fs.read` tools, including project rules and earlier user corrections; recorded preferences help interpret the task but do not grant permission. Other sessions, write tools, desktop control and network tools are unavailable to the reviewer. A read that needs additional permission remains unexecuted and is reported as missing evidence, without recursive approval.

Reviews make at most six evidence rounds, then return allow, deny or ask for the specific missing evidence. Their input budget follows the configured reviewer model's context window and output reserve. Repetitive accessibility errors are grouped with a reference to the original tool record; the complete user instructions and proposed operation are retained. A manual decision or permission change stops obsolete review work. Plan approval remains a separate decision.

For long original text, use `session.read` with `view: messages` plus `messageId`, or `view: tools` plus `recordId`, and follow the selected field's `nextOffset`. List excerpts remain bounded; a truncated excerpt does not prove that the omitted content was checked.

## Plans and task progress

Plan approval may be manual, delegated or off. Use a Plan when project changes need new or expanded authorization; existing authorization does not need to be reconfirmed for every implementation detail. Plan approval, execution permission and engineering decisions are separate. In normal work, the default engineering setting asks the user to choose between materially different routes. Delegating the route still leaves missing requirements with the user. Read-only investigation needs no Plan. Session-managed drafts have their existing file access.

Workspace Shell keeps project files read-only; declare test/output directories in Plan `writablePaths`. Host Shell has broader host-user access. With an active Plan or Plan approval enabled, each Host call needs its own approval; a Plan or reusable grant does not replace it. See [execution environments](execution-environments.md).

Delegated execution review uses the original authorization, exact operation and bounded evidence. The Kernel may offer `runFiles` for an additional read-only file scope: approval then permits that exact scope in the same task and file environment, including later file reads or Workspace Shell commands, until revoked or the task ends. It does not authorize sibling paths, writes, network or Host execution. Other delegated approvals remain call-only. Neither kind approves a Plan or answers a question. Preserve review errors; unavailable or uncertain review requires human handling. Mandatory user constraints and the complete operation take priority over optional history. A preparation failure means the review model was not called.

For meaningful multi-step progress, `todo.update` replaces the complete list of `pending`, `inProgress`, `completed` or `blocked` items. Skip trivial or unchanged updates. Todo grants no permission and does not gate completion; retain unfinished items honestly.

Use `interaction.request` alone to ask a necessary question. `mode: continue` permits independent work; confirmations wait. Silence is not a choice, and unanswered questions keep the run pending.

## Agent delegation and Reader

Call `agent` with `action: models` for the current operation schemas. When enabled, delegate useful independent work with enough context, scope and expected evidence; keep short or coupled work local. Use collaboration for communicating teammates and assign one writer per shared file.

The fixed templates are `analysis` (read exact file references and return findings; no messaging controls) and `collaboration` (communicate with teammates). Permissions and runtime configuration inherit from the parent within each template's tool selection. The main conversation can configure templates and customize a child within its authority; ordinary members select those templates and cannot override permissions or Loop configuration.

Await final results and verify them. Completed tasks release execution automatically; `close` retires an idle member, not an active task. Use `cancel` for owned active work. `send` delivers a message, not authorization or a new assignment.

Disabling delegation prevents new spawns/assignments while existing tasks may continue, communicate or be cancelled. Conversation settings saves also update future-conversation defaults, not other existing conversations. Child Plan/approval decisions belong to that child's Session.

Reader's Subagents view inspects recorded work without resuming it. Closing that view does not cancel the task. Review a child's actual pending decision rather than treating its report as approval.

## Host lifetime

```sh
achbit-cli sessions
achbit-cli read --session 'session:...'
achbit-cli resume 'session:...'
achbit-cli new -C /absolute/workspace
achbit-cli start-host
achbit-cli stop-host
```

GUI, CLI and TUI share the Host. An automatically started Host stays alive while clients or unfinished tasks need it, including tasks waiting for decisions. A persistent Host started with `start-host` needs explicit shutdown. Reading history does not resume execution or recover lost runtime bindings.

Switching conversations changes the view, not the previous task. Reopening a GUI does not retarget a waiting run; **Continue in this window** explicitly rebinds future requests. Earlier pending calls retain their original target. Observe again after rebinding.

## Models and context

Use [model services](model-services.md) for profiles, authentication, images, context settings and usage. The selected model/environment is captured for a run. A slow request alone does not prove a stuck Loop; inspect its Provider/tool result and original error.

To read another conversation from an Agent task, include its exact `session:…` ID in your message. For a caller-assigned ID use `sessionId="..."`. The history reader targets those user references. Archived images and child workdir resources have their own scoped views.

For diagnostics of the current task, explicitly select **Session Diagnostics** in the composer plugin picker, or start the task with `achbit-cli ask --plugin plugin://session-diagnostics@builtin "Inspect this conversation's context"`. Its `session.diagnostics` operation uses the current session. Normal tasks do not advertise that operation. CLI, GUI and Debug user-facing inspection use the Session query API directly.

Use `/plan <task>` to request a plan for one task. Read the proposed work and confirm, request changes, or cancel. Confirmation continues the same task and keeps its other tool permissions. The next task uses the saved Plan preference.

The composer’s **Workflow & permissions** menu groups Plan confirmation and engineering decisions under **Workflow**. **Tool access** covers reads in bound directories, command approval, execution scope, network reads, and external actions. Active grants can be revoked from the menu. In Settings, change the workflow defaults under **Agent behavior**, and change tool policies or command rules under **Tool permissions**.

Use `/focus <task>` after completion to summarize prior work and continue. Compression does not delete history. Read historical facts with `session.read`, starting from summary and narrowing to messages, tools or context; check truncation and pagination instead of repeatedly requesting full snapshots.

Summary/tools views include input rejections and permission-review decisions. Use an exact `providerRequestId` in the context view for recorded review details. `contextPrepared: false` identifies a preparation failure, not a model response. Approval resolution still needs the linked execution record to establish the tool outcome.

## Attachments, file links and notices

A submitted directory becomes a workspace binding when consumed; a file attachment identifies only that file. Neither grants writes or binds the file's parent directory. Local references point to original files; pasted text and archived artifacts are snapshots. Supplemental input reaches the current task after the applicable request/tool boundary.

Use readable exact file links with optional line/column. Relative paths belong to a bound root; ambiguous roots require a choice. For another Agent, prefer an explicit reference or absolute path. A copied path is not an access grant.

The Reader tree supports right-click/Shift+F10 to preview, copy name/relative/absolute path, reveal, open in VS Code or add a draft reference, subject to Host capabilities. These actions do not wait for preview loading. References are not automatically sent. New, rename and delete are not tree actions.

Resource subscriptions are shared per Session; one unavailable file does not fail unrelated resources. Reload re-establishes a failed watch/read. Collapsing Reader retains tabs; closing a browser tab closes that page. Image thumbnails use the image content, not empty viewport background; HTML thumbnails have bounded dimensions without resizing the operating page.

## Reading and appearance

Settings → Appearance controls fonts, sizes and colors. Preset changes apply immediately; custom font text needs confirmation. TUI `/font` lists choices and `/font follow` rereads the shared preference. `achbit-tui --in-place` uses the current terminal rather than opening a dedicated window.

CLI chat/TUI use `/sessions`, `/resume <number|full-id>` and `/new`. Numbers refer to the last list in that process. TUI `/reply` answers a decision, `/decision` shows details, `/tool <activity-id>` opens full output and `/error` shows the original error.

The execution disclosure opens intermediate text/tools and shows measured response-to-settlement duration when available, in both normal and Debug builds. Missing historical timing is not estimated. HTML/Markdown document readers are read-only; ordinary HTML document preview does not run scripts. Explicit `achbit-preview` fences render archived HTML components interactively in the conversation, with source, reload and sidebar controls. Read `achbit-documents` → `references/interactive-previews.md` for the reference format. Complete applications and live sites use the native browser.

File-tool arrows open the preview in one step. Edits show changed lines with nearby context; large changes use a bounded preview. Read tools preview the current file, labeled as such. Click the filename in the tool heading or preview header to open it in the right-hand Reader; deleted files open their recorded comparison. Expanding or collapsing keeps the clicked heading in place, and scrolling past a preview's top or bottom continues through the conversation.

## Document output

Mermaid diagrams and Markdown tables can appear directly in replies. For frontend pages, components and interactive previews, search for `frontend`, activate the Frontend Design Skill, then read its returned entry with the file reader. Apply the target project's existing design first. For an inline component, use the interactive preview contract above.

For requested HTML/PDF/Markdown delivery, read `achbit-documents`. Use `document.render` (activate `plugin://documents@builtin` first) with the requested format and workspace destination. PDF content is self-contained Typst source rendered by the bundled Rust renderer; HTML content remains complete HTML, and Markdown content remains Markdown. No Python environment is needed. Renderer errors remain errors, not a different-format delivery.

Archive an existing file with `artifact.prepare`, or register a live URL with `artifact.preview`. Deliver selected results using `artifact.present`, then cite its returned URI. Preparing/registering alone does not deliver; registering a URL does not verify it. Re-prepare edited files and reuse the `deliveryId` for an update. Keep scripts, logs and observation screenshots intermediate unless requested.

## Updates

| Change | Effective boundary |
| --- | --- |
| GUI appearance | Immediately after saving |
| Enabled display plugin's compiled entry/manifest | Hot replacement of that module |
| Selected external Skill/CLI-plugin content | Next model request |
| Saved runtime configuration | Next run; revocation remains effective before execution |
| Packaged GUI resources | Interface reload: Cmd+Shift+R / Ctrl+Shift+R or `browser.page` → `refreshInterface` |
| Kernel, Session, native executable or compiled-in guidance | Corresponding build and process restart |

`scheduled` means a reload was queued; `needsUser` means unsaved state needs attention. A GUI reload does not replace an existing Host. Finish/cancel affected work before an authorized full update and stop only the intended Host. Debug iteration and standard installation remain separate scopes.

## macOS signing

Authorized macOS builds use a persistent signer, defaulting to `Achbit Local Development`; `ACHBIT_MACOS_SIGN_IDENTITY` selects another. Initial setup is `bash scripts/setup-macos-signing.sh` on the Mac. The private key stays in that user's keychain; system password/trust prompts require human handling.

Keep signer and bundle identity stable across updates. The Computer Use helper has its own Accessibility/Screen Recording grants. Use its `status` to inspect the actual running helper and permission error; do not reset OS permissions or replace unrelated apps as a generic fix. From a source checkout, `bash ./build.sh` updates the local runnable product; `bash ./build.sh --stage package-macos` explicitly builds the macOS distribution package. For isolated Debug builds, use [Debug control](debug-control.md).

## Completion reminders

While the desktop GUI is open, each observed successful task completion plays the selected sound when Achbit is in the background. Foreground playback is controlled by **Settings → General → Play completion sound in foreground** (`gui.completionSound.foreground`), which defaults to off.

Background completions also show a separate Achbit window at the bottom-right of its monitor, above the taskbar or Dock, without taking keyboard focus. Click it to open the conversation, dismiss it, or let it hide after 8 seconds. This does not use system notifications or require notification permission. Loading completed history, cancellation and failure do not send success reminders. Closing the GUI stops its reminders. Playback follows the current system output device and volume.

Transient conversation notifications use one notice layer: each Session keeps at most three entries, which can be dismissed and leave after 8 seconds. A newly observed completed model handoff (for example “已切换至 …”) uses this layer; loading history, revisiting a conversation, and refreshing a model name do not repeat it. Local success feedback such as saving or importing uses the same default lifetime. Copy feedback stays on its button for 1.5 seconds. Failures (including input and attachment errors), approvals and recovery panels keep their actionable state until resolved or explicitly dismissed.

In **Settings → General → Task completion reminders**, preview the sound, choose a WAV (up to 30 seconds / 8 MiB), or restore the default. Preview plays regardless of the foreground preference. The override lives at `<local config directory>/user/local/sounds/completion.wav`; settings displays the exact local path, including in Debug or SSH mode. The GUI reads the file anew for every playback, so replacing it directly takes effect on the next reminder. Invalid replacements and playback errors are reported; they do not silently substitute a different sound.
