# Product operations

Quick directions for using Achbit. Read only the section needed for the task; current tool schemas and returned availability determine callable operations.

## Tools and validation

- Use CLI/MCP for program operations and GUI tools for interface actions or visual confirmation. A program having a GUI does not make all its operations GUI tasks.
- Without a `workspace` override, relative paths use the default working directory: the project's first configured source folder, or the session directory for a new conversation without source folders. Attachments supplement that project. Use an attachment's listed handle and path to work with it; later calls still default to the original directory. See [working directories and attachments](execution-environments.md#bindings-and-update-timing).
- `fs.read` offers paged UTF-8 text and bound directory listings (`.` lists the root); the available workspace Shell can also search or read multiple files in one command. Choose according to the task and the current permissions. Read a supplied path directly in its referenced workspace. Resolve a file-relative link from the referring file, not the shell's current directory; a repository's display name is not a path prefix. For an unknown path, list a known bound directory or search the selected workspace first, then use that result for a read in a later batch. A `NotFound` describes that lookup, not permission denial or evidence to try a different root. Use the returned cursor for the next page; use file tools for project edits and deletion. Use the project's declared environment for commands.
- Ordinary tools support a single call or multiple calls in a Provider response; each retains its own input, permission check and result. Use one `fs.edit` call for related replacements in the same file. Its input adapter accepts an edits array, a single edit object, JSON-encoded edit data, or a top-level `oldText`/`newText` pair and normalizes them before execution. Exact matching, atomicity and access checks stay the same.
- One or more `agent` → `send` calls may share a turn with ordinary tools and up to one `todo.update`; `agent` → `models` also allows ordinary tools. Each call keeps its own result and checks. A failed delivery does not block a valid file read, and a failed read does not resend a message. Async `spawn` and `assign` do not mix with ordinary tools; an exclusive control must run alone. An incompatible batch or a second Todo update rejects the whole turn’s calls before execution. Nothing splits or retries it automatically.
- Preserve actual results: rejected input was not executed; approval is not execution; a dispatched action with a failed observation is not a fully verified action. Correct the reported cause instead of repeating an unchanged failure.
- A complete file or Skill read returns its text as-is (including an empty file). Directory listings and partial reads return entries or text with the continuation cursor. Successful tool replies contain the operation result; errors retain the cause and any known partial effect. Permission decisions remain in the journal. The working agent receives denial reasons and newly granted scopes when relevant.
- Live output is bounded. Inspect the returned full-output paths when needed; do not rerun a command just to recover its log.
- For Achbit Debug control, read [Debug control](debug-control.md). Direct tool/UI operations do not need an Agent task.

**Default tool composition.** Minimal mode uses four slots: Read, the selected platform Shell, Edit and Write. Either Read or Shell can inspect files under its own permissions. New Full runs use the same core names and working rules, with the additional operations of their recipe; this does not grant every tool. `read` takes `offset`/`limit` for lines or directory entries and `startByte` for file continuation. Its Kernel text window defaults to 256 KiB and 2,000 lines, explicitly up to 1 MiB and 5,000 lines. File access requests, Shell permission fields and model budgets follow the actual binding and policy. Shell command text and each `oldText`/`newText` are limited to 16 KiB of UTF-8, not 16,384 arbitrary characters. A single exact-edit transaction admits up to 128 items; the entire normalized core call must fit in 1 MiB. Related edits are not split automatically. The eight underlying Kernel operation names are `fs.read`, `fs.write`, `fs.edit`, `fs.delete`, `bash`, `powershell`, `web.fetch` and `web.search`. The canonical file names in this guide and the journal do not create a second set of model-callable tools. Six additional runtime tools are `process`, `plugin.search`, `skill.read`, `session.read`, `artifact.prepare` and `artifact.preview`. The phase, workspace and prepared capabilities determine what the model actually sees. Deletion and known-URL fetching remain distinct operations with their own effect checks.

**Search for a newly prepared run.** Excluding `web.search` in the recipe or denying network reads leaves no search tool. When permitted, the run has one search executor: supported Provider-hosted search with direct network-read permission, or a callable Kernel adapter; otherwise none. The model profile’s hosted-search switch does not disable an independently configured Kernel adapter. `web.fetch` reads a supplied URL, not search results; Shell networking has its own permissions and is not a fallback for denied search.

Choose **Computer Use** for a page in Achbit’s Reader or a native window. Reader tools need the originating GUI; desktop control needs its helper and OS permissions. Inspect the target first. Native coordinate input needs a foreground observation; if input was dispatched but its screenshot failed, observe again rather than repeating it. For a tab already open in the user’s Chrome, choose **Chrome** instead: allow Chrome’s connection prompt if intended, then identify the tab by its returned `pageId`.

Paste PNG, JPEG, GIF or WebP images into the GUI composer to add removable thumbnail attachments (up to 8 MiB each, within the shared eight-attachment limit). Upload occurs when the message is sent, including image-only messages; a failed upload preserves the draft for retry.

User images and GUI observations supply pixels for one successful request. Later requests retain references; `session.read` with `view: images` and exact current-session image IDs reopens them. A live thumbnail, file path or presented artifact is not model visual input.

## Settings and extensions

In Achbit, **global prompt** (全局提示词) means the user's saved **Settings → Agent behavior → System prompt** (设置 → Agent 行为 → 系统提示词), key `agent.systemPrompt`, unless the user specifies otherwise. To review or shorten it, run `achbit-cli --host-data-dir <hostDataDirectory> instance` and read just that field from the returned `settingsPath`. The saved text is appended to the built-in instructions of the next main-agent task in full or minimal mode. Editing or clearing it does not change a run already in progress. It is not copied into delegated agents or used for permission decisions. Project `AGENTS.md` and Skills remain separate.

For self-development and installation, use the current Host CLI: `plugins capabilities`, then the needed `plugins guide` / `plugins template`; `plugins inspect`, `install`, `update`, `enable`, `disable`, `remove`, and `status` share the Settings operations. Target an existing instance with `--host-data-dir`. Read both registration and actual application state. New registrations enter discovery at the next model request in the same run; installation does not grant task activation or permission. See [plugin development and updates](plugin-development.md) for installation and verification.

Use `plugin.search` for enabled task plugins and file-backed Skills. Project Skills declared in a bound workspace under `.achbit/skills` or `.agents/skills` are part of the same catalog: each bound directory and its ancestors are scanned, the nearest directory wins, `.achbit/skills` wins over `.agents/skills` in one directory, and a Skill is a `<name>/SKILL.md` bundle or a flat `<name>.md` whose frontmatter declares `name` and `description`. The header must be closed YAML with top-level text fields. Entries marked `disable-model-invocation: true`, symbolic links and invalid entries are not offered for model activation. A matching explicit mount keeps its mounted URI; disabling that mount does not expose the file under a project URI. A flat file (including a collection's own `SKILL.md`) grants read access to that file only; a selected bundle can include its own references. Changing bound directories updates discovery for the next request, not the already-issued request or the run's frozen `AGENTS.md`. Project-only entries have no settings or `@` picker entry. For specialized tasks, use an already callable tool or search for the format or operation before building a replacement or installing a helper. Shell, including batch file reads, remains subject to its own permissions; a denied action does not become authorized via Shell. All keywords must match the same entry; if none of the results does the job, even when others matched, shorten the query or browse without `query`. Follow `nextOffset` only when needed. Core tools such as [`process`](managed-processes.md) and [`session.read`](#models-and-context) have no plugin to install or activate: check the current task’s tool declarations.

Introduce Documents, PDF, GitHub, arXiv, Containers and other discoverable capabilities when the task needs them, not as a list in every request. Use `plugin.activate` alone with exact discovered URIs. Its result names prepared capabilities; use the next request’s actual declarations for call names and arguments. Search does not start programs, and activation is neither permission nor execution. Explicit selections and supported link or attachment readers keep their existing paths. Session Diagnostics requires an explicit first user selection; Chrome and Computer Use remain separate.

In the GUI, type `@` in a message (including directly after Chinese text), or choose **+ → Plugins**. Search by name and select an item by clicking it or pressing Enter. Its chip confirms the draft contains a reference; it does not grant permission. A compiled-in reference such as `achbit-documents` names the Skill to read with `skill.read`; selecting it does not load its text. A file-backed Skill instead supplies an entry path to read after activation. Typing or pasting a name without selecting a candidate does not create a reference. The picker lists installed registrations; project Skills stay out of it and are reachable through `plugin.search`.

| Source | Registration |
| --- | --- |
| Local CLI tools | `plugins.sources`, `achbit-tool.json` |
| Hosted services | `plugins.services`, `achbit-service.json`; manage in Settings → Plugins, not in the task picker. Host owns the process while enabled. |
| External MCP | `mcp.servers`; include a useful capability `description` |
| Custom Skills | `skills.mounts`; folder or `SKILL.md` |
| Project Skills | `<workspace>/.achbit/skills`, `<workspace>/.agents/skills`; discovered per bound workspace, no registration |
| Display plugins | `workbench.uiPlugins`, `achbit-ui.json`; see [UI plugins](ui-plugins.md) |

For importable artifacts, manifest fields, invocation and cleanup rules, see [Plugin development](../plugins/README.md).

Settings switches/selections save immediately; numeric fields commit with Enter. Text edits and new connections retain Save/Create. Saved runtime configuration generally applies to the next run; selected Skill/CLI-plugin content is refreshed before the next request. In-flight calls keep their captured bindings. Relevant permission revocation is checked before execution.

## Execution approval

The **Review for me** preset allows network reads directly, keeps Shell execution scoped to the workspace, and delegates commands needing additional permission and external actions to the approval model. Plan settings, engineering decisions and command rules stay independent. Custom network policies can still ask, delegate review or deny. Existing saved settings are not migrated automatically. Web-tool access does not grant Shell networking or Host execution.

Delegated execution review may read the current conversation and related files in its bound workspaces before deciding. It uses the existing `session.read` and `fs.read` tools, including project rules and earlier user corrections. File evidence identifies the workspace and relative path together; a missing path in one workspace is not evidence that it is missing elsewhere. Recorded preferences help interpret the task but do not grant permission. Other sessions, write tools, desktop control and network tools are unavailable to the reviewer. A read that needs additional permission remains unexecuted and is reported as missing evidence, without recursive approval.

Reviews make at most six evidence rounds, then return allow, deny or ask for the specific missing evidence. Their input budget follows the configured reviewer model's context window and output reserve. Repetitive accessibility errors are grouped with a reference to the original tool record; the complete user instructions and proposed operation are retained. A manual decision or permission change stops obsolete review work. Plan approval remains a separate decision.

For long original text, use `session.read` with `view: messages` plus `messageId`, or `view: tools` plus `recordId`, and follow the selected field's `nextOffset`. List excerpts remain bounded; a truncated excerpt does not prove that the omitted content was checked.

## Plans and task progress

Plan approval may be manual, delegated or off. Use a Plan when project changes need new or expanded authorization; existing authorization does not need to be reconfirmed for every implementation detail. Plan approval, execution permission and engineering decisions are separate. In normal work, the default engineering setting asks the user to choose between materially different routes. Delegating the route still leaves missing requirements with the user. Read-only investigation needs no Plan. Session-managed drafts have their existing file access.

Workspace Shell keeps project files read-only; declare test/output directories in Plan `writablePaths`. Host Shell has broader host-user access. With an active Plan or Plan approval enabled, each Host call needs its own approval; a Plan or reusable grant does not replace it. See [execution environments](execution-environments.md).

Delegated execution review uses the original authorization, exact operation and bounded evidence. The Kernel may offer `runFiles` for an additional read-only file scope: approval then permits that exact scope in the same task and file environment, including later file reads or Workspace Shell commands, until revoked or the task ends. It does not authorize sibling paths, writes, network or Host execution. Other delegated approvals remain call-only. Neither kind approves a Plan or answers a question. Preserve review errors; unavailable or uncertain review requires human handling. Mandatory user constraints and the complete operation take priority over optional history. A preparation failure means the review model was not called.

For meaningful multi-step progress, `todo.update` replaces the complete list of `pending`, `inProgress`, `completed` or `blocked` items. Skip trivial or unchanged updates. Todo grants no permission and does not gate completion; retain unfinished items honestly.

Use `interaction.request` alone to ask a necessary question. `mode: continue` permits independent work; confirmations wait. Silence is not a choice, and unanswered questions keep the run pending.

## Agent delegation and Reader

Call `agent` with `action: models` for the current operation schemas. When enabled, delegate useful independent work with enough context, scope and expected evidence; keep short or coupled work local. Use collaboration for communicating teammates and assign one writer per shared file. For an independent review, spawn a new analysis member with only the evidence it needs; assigning an existing member keeps that member’s context. Neither selection grants access beyond the task’s permissions.

The built-in templates are `analysis` (read exact file references, return findings, and send questions to its task owner) and `collaboration` (also communicate with teammates). Permissions and runtime configuration inherit from the parent within each template's tool selection. Per-task tool, permission and Loop overrides require **Full configuration** in the main conversation; ordinary members select configured templates and cannot override permissions or Loop configuration.

For task-local teams, the root can give direct peers a shared `peerGroup` and a worker a closed `helpers` menu with per-template limits. `fileScope` narrows the permitted workspace file effects; it never grants writes. See [task-local teams](model-services.md#task-local-teams) for a front-end/back-end example. Quality review is ordinary delegated work, not execution approval.

Use `spawn` with `delivery: async` to overlap independent work after child startup, or `delivery: wait` when the next step depends on the child. A child can send findings or questions with `agent` → `send`, continue independent work, or use `session` → `wait` when it needs a reply. Messages interrupt result waits; final results arrive automatically at a model request boundary. Do not repeatedly query status to drive collaboration.

Await final results and verify them. Completed tasks release execution automatically; the coordinator uses `assign` to give an idle retained member another task with its original Session, model and configuration. `close` retires an idle member, not an active task. Use `cancel` for owned active work. `send` delivers a message to an active task, not authorization or a new assignment.

**Temporary subagent capacity.** If `spawn` or `assign` would exceed a limit, supply `requestCapacity` with the reason this assignment cannot wait or reuse an idle member. Within budget it runs normally. Above budget a single approval shows the affected limits, current usage and requested totals. With **Review for me**, an independent, tool-free reviewer decides allow, deny or ask, with a reason. Uncertain, invalid or unavailable review goes to the original human approval; other permission presets ask the user directly. An approval applies only to that dispatch. Session rechecks the limits before startup; it does not change saved settings, override a helper limit or authorize tools, Shell or a Plan.

Each root conversation retains its own model, reasoning effort and subagent settings. A new conversation copies the last explicitly edited configuration. Viewing, resuming, sending a message or using `/focus` in an older conversation does not replace that default. Changing one conversation does not rewrite its peers. A running task keeps its captured declarations, quotas and delegation settings. Changing the conversation selection takes effect on its next task, without cancelling existing subtasks or removing history.

The main conversation presents a subagent’s question or confirmation in its normal composer question panel, including a question that allows the child’s other work to continue. The panel names the child. If you are composing a message or handling your own decision, the **Pending decisions** button lets you choose when to open the child item. **Review later** returns to the main composer without answering. Messages between agents are not user decisions.

If a subagent needs execution permission, the main composer displays the original child request with the same permission controls as a main-session request, rather than opening a modal. With delegated review, the configured approval model acts first; only a request handed back for human review needs attention. Allow or deny addresses that exact child operation and its offered scope. Postponing does neither. Child Plan review retains its separate dialog. A coordinator’s message can confirm that work is ready, but cannot grant execution permission.

In the CLI or TUI, `/reply 1` allows a single pending human approval and `/reply 2` denies it. If several approvals are pending, use `/reply --approval <approvalId> <decision>` with the ID shown beside the operation. A model review is not a pending human decision. If the selected request changed, inspect the current decision before replying.

In the conversation, routine subagent updates are folded into a summary. Expand it to see the original events in order or open an agent in Reader. The count is of distinct agents, not update messages; pending decisions remain actionable.

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

GUI, CLI and TUI share the Host. After a local desktop window connects, closing the window or quitting the GUI leaves that Host running. Reopening the app reconnects to it. To stop both the desktop and its local shared Host, choose **Settings → About Achbit → Quit Achbit**. If work is active or settings edits are unsaved, confirm before exiting; this affects other clients of that Host too. The action does not shut down a remote SSH Host. `achbit-cli stop-host` also explicitly stops the selected Host.

A Host used only by ordinary CLI/TUI clients still exits after the last client disconnects and no work remains. Running tasks, in-flight cleanup and tasks waiting for decisions remain work. A recorded cleanup failure by itself does not keep an automatic Host alive or count as a successful release. An explicitly persistent `start-host` still requires explicit shutdown. Reading history does not resume execution or recover lost runtime bindings.

**Settings → General → Prevent idle sleep during tasks** (`workbench.preventIdleSleep`, on by default) applies to work from all clients sharing the Host. Achbit requests that the system stay awake during execution and timed waits. Idle sessions and tasks only waiting for your input do not keep it awake. Turning the setting off releases Achbit’s request without stopping a task; turning it back on applies to work already in progress. It does not keep the display on or change the system’s power settings.

[Opening a saved conversation](conversation-reading.md) describes the desktop’s complete local timeline, cached reading positions and previews, and the explicit transcript and revision-window APIs.

Switching conversations changes the view, not the previous task. Reopening a GUI does not retarget a waiting run; **Continue in this window** explicitly rebinds future requests. Earlier pending calls retain their original target. Observe again after rebinding.

## Models and context

Use [model services](model-services.md) for profiles, authentication, images, context settings and usage. The selected model/environment is captured for a run. A slow request alone does not prove a stuck Loop; inspect its Provider/tool result and original error.

To read another conversation from an Agent task, include its exact `session:…` ID in your message. For a caller-assigned ID use `sessionId="..."`. The history reader targets those user references. Archived images and child workdir resources have their own scoped views.

For diagnostics of the current task, explicitly select **Session Diagnostics** in the composer plugin picker, or start the task with `achbit-cli ask --plugin plugin://session-diagnostics@builtin "Inspect this conversation's context"`. Its `session.diagnostics` operation uses the current session. The model cannot discover this plugin by itself. After the user selects it, later plugin-enabled runs in the same conversation inherit the selection while it remains enabled. Other conversations do not inherit it. CLI, GUI and Debug user-facing inspection use the Session query API directly.

Continue in the same conversation with an ordinary message. For example, after a review, “apply the proposed fix” asks the agent to edit within that scope. Other constraints still apply. If a formal Plan or tool approval is pending, use its decision controls; ordinary messages do not resolve it.

Use `/plan <work>` when you want a plan before execution. Confirm the proposal, request changes, or cancel. Confirmation continues the same run without changing other tool permissions. The next run uses the saved Plan preference.

The composer’s **Workflow & permissions** menu groups Plan confirmation and engineering decisions under **Workflow**. **Tool access** covers reads in bound directories, command approval, execution scope, network reads, and external actions. Active grants can be revoked from the menu. In Settings, change the workflow defaults under **Agent behavior**, and change tool policies or command rules under **Tool permissions**.

Use `/focus <topic>` after a run ends if you want to summarize earlier context around what comes next. Ordinary follow-ups need no `/focus`. Compression does not delete history or grant the model new read access. For the current conversation use the diagnostics or user-facing read interface above. When `session.read` offers a historical target, start with its summary and use the returned IDs and cursors for the relevant messages or tool results.

Summary/tools views include input rejections and permission-review decisions. Use an exact `providerRequestId` in the context view for recorded review details. `contextPrepared: false` identifies a preparation failure, not a model response. Approval resolution still needs the linked execution record to establish the tool outcome.

## Attachments, file links and notices

In the composer, choose **Files and folders** to attach several folders in one selection. Select files separately if you want both kinds in the same message. Each folder counts as one of the eight attachments; its contents are not uploaded.

File and folder attachments have separate open and remove controls. Click a folder to open that directory in the system file manager. Click an image to enlarge it over the current conversation; Escape closes it without opening a Reader tab or editor. Other files, including HTML and PDF, follow **Settings → General → Open files with** (Reader or VS Code). In Reader, ordinary HTML is read-only and PDFs support paging. Previewing a draft attachment does not send it or create a Session.

A submitted directory becomes a workspace binding when consumed; a file attachment identifies only that file. Neither grants writes or binds the file's parent directory. Local references point to original files; pasted text and archived artifacts are snapshots. Supplemental input reaches the current task after the applicable request/tool boundary.

Use readable exact file links with optional line/column. Relative paths belong to a bound root; ambiguous roots require a choice. For another Agent, prefer an explicit reference or absolute path. A copied path is not an access grant.

The Reader tree supports right-click/Shift+F10 to preview, copy name/relative/absolute path, reveal, open in VS Code or add a draft reference, subject to Host capabilities. These actions do not wait for preview loading. References are not automatically sent. New, rename and delete are not tree actions.

Resource subscriptions are shared per Session; one unavailable file does not fail unrelated resources. Reload re-establishes a failed watch/read. Collapsing Reader retains tabs; closing a browser tab closes that page. Image thumbnails use the image content, not empty viewport background; HTML thumbnails have bounded dimensions without resizing the operating page.

## Reading and appearance

Settings → Appearance controls fonts, sizes and colors. Preset changes apply immediately; custom font text needs confirmation. TUI `/font` lists choices and `/font follow` rereads the shared preference. `achbit-tui --in-place` uses the current terminal rather than opening a dedicated window.

CLI chat/TUI use `/sessions`, `/resume <number|full-id>` and `/new`. Numbers refer to the last list in that process. TUI `/reply` answers a decision, `/decision` shows details, `/tool <activity-id>` opens full output and `/error` shows the original error.

The execution disclosure opens intermediate text/tools and shows measured response-to-settlement duration when available, in both normal and Debug builds. Missing historical timing is not estimated. HTML/Markdown document readers are read-only; ordinary HTML document preview does not run scripts. Explicit `achbit-preview` fences render archived HTML components interactively in the conversation, with source, reload and sidebar controls. See [interactive previews](interactive-previews.md) for the reference format. Complete applications and live sites use the native browser.

File-tool arrows open the preview in one step. Edits show changed lines with nearby context; large changes use a bounded preview. Read tools preview the current file, labeled as such. Click the filename in the tool heading or preview header to open it in the right-hand Reader; deleted files open their recorded comparison. Expanding or collapsing keeps the clicked heading in place, and scrolling past a preview's top or bottom continues through the conversation.

For an existing PDF, search for `pdf` and select **PDF Reader** for page text. Use the attachment’s logical path or a verified PDF path in a bound workspace. A link alone is not a local file: obtain it through an authorized download before reading it. For diagrams, scanned pages or layout, inspect the relevant page visually; a screenshot or empty text layer does not establish the full document’s contents.

## Document output

Mermaid diagrams and Markdown tables can appear directly in replies. For frontend pages, components and interactive previews, search for `frontend`, activate the Frontend Design Skill, then read its returned entry with the file reader. Apply the target project's existing design first. For an inline component, use the interactive preview contract above.

For HTML/PDF/Markdown creation, use the document design Skill and [document delivery guide](document-delivery.md). Use `document.render` (activate `plugin://documents@builtin` first) with the requested format and workspace destination. PDF content is self-contained Typst source rendered by the bundled Rust renderer; HTML content remains complete HTML, and Markdown content remains Markdown. No Python environment is needed. Renderer errors remain errors, not a different-format delivery.

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

A Mac can isolate an existing development identity in a dedicated file-based keychain. Keep the same certificate and private key, grant `/usr/bin/codesign` access and the `apple-tool:,apple:` partition list, and configure `~/Library/Application Support/Achbit-build/macos-signing.json`:

```json
{
  "identity": "<existing certificate SHA-1 fingerprint>",
  "keychain": "/absolute/path/to/development.keychain-db",
  "passwordFile": "/absolute/path/to/development-keychain.password"
}
```

The password file contains one nonempty line, must belong to the current user, and must grant no permissions to group or other users; mode `0600` is recommended. Use a separate random development-keychain password; keep both files outside the checkout and container. Native packaging, Computer Use packaging and UI updates read this host profile at invocation time, unlock that keychain through `security` stdin, and restrict identity lookup and signing to it. `ACHBIT_MACOS_SIGN_IDENTITY` still overrides the profile's identity selector. Missing or invalid configured files, unlock failures and missing identities stop the build; they do not fall back to the login keychain. Without a profile, the existing default-keychain workflow is unchanged. Running setup with a profile validates the configured identity instead of creating another certificate. This isolates signing from login-keychain state; it does not change macOS screen-unlock settings.

Keep signer and bundle identity stable across updates. The Computer Use helper has its own Accessibility/Screen Recording grants. Use its `status` to inspect the actual running helper and permission error; do not reset OS permissions or replace unrelated apps as a generic fix. From a source checkout, `bash ./build.sh` updates the local runnable product; `bash ./build.sh --stage package-macos` explicitly builds the macOS distribution package. For isolated Debug builds, use [Debug control](debug-control.md).

## Completion reminders

While the desktop GUI is open, each observed successful task completion plays the selected sound when Achbit is in the background. Foreground playback is controlled by **Settings → General → Play completion sound in foreground** (`gui.completionSound.foreground`), which defaults to off.

Background completions also show a separate Achbit window at the bottom-right of its monitor, above the taskbar or Dock, without taking keyboard focus. Click it to open the conversation, dismiss it, or let it hide after 8 seconds. The card leads with the conversation title; the completion status and Session ID remain visible below it. The desktop shell passes the main interface’s current appearance when delivering the reminder. Older shells that do not provide appearance use the system light/dark preference. This does not use system notifications or require notification permission. Loading completed history, cancellation and failure do not send success reminders. Closing the GUI stops its reminders. Playback follows the current system output device and volume.

Transient conversation notifications use one notice layer: each Session keeps at most three entries, which can be dismissed and leave after 8 seconds. A newly observed completed model handoff (for example “已切换至 …”) uses this layer; loading history, revisiting a conversation, and refreshing a model name do not repeat it. Local success feedback such as saving or importing uses the same default lifetime. Copy feedback stays on its button for 1.5 seconds. Failures (including input and attachment errors), approvals and recovery panels keep their actionable state until resolved or explicitly dismissed.

In **Settings → General → Task completion reminders**, preview the sound, choose a WAV (up to 30 seconds / 8 MiB), or restore the default. Preview plays regardless of the foreground preference. The override lives at `<local config directory>/user/local/sounds/completion.wav`; settings displays the exact local path, including in Debug or SSH mode. The GUI reads the file anew for every playback, so replacing it directly takes effect on the next reminder. Invalid replacements and playback errors are reported; they do not silently substitute a different sound.

For exact historical records, pagination and usage queries, see [session query](session-query.md). Earlier installations offered the product and session guides as Skills. Their public instructions now live here. Self-maintenance guidance is provided by local Skills.
