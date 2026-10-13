# Display plugins and UI updates

DeepCode UI plugins customize workbench regions, input controls, activity rows, document readers, usage widgets, themes and supported settings panels. Replacing a plugin releases its registrations, styles and effects. Plugins receive the published display inputs; they do not control conversation execution or permissions.

## Use a plugin

In **Settings → Plugins → Add**, choose a local folder or manifest file containing `deepcode-ui.json`. Add the folder through the normal file picker, or enter its absolute path. Only add JavaScript you intend to run in the application window.

The Host checks the selected files while the window is connected and publishes changed contents. Saving the entry bundle or manifest replaces that plugin in the open window; no UI reload, Rust build, daemon restart or new conversation is required. **Refresh list** reconnects the source watch; **Reload** in one plugin’s details reloads only that module. Disabling or removing a plugin releases its resources and restores the built-in renderer for its slots.

The source list is stored in the existing user setting `workbench.uiPlugins` and used by the GUI. It is independent of Skill/MCP activation. A broken source or renderer shows its own error in the settings page and affected slot. A disconnected watch is visible and can be reconnected with Refresh; it does not silently reload the application.

## Manifest and module

```json
{
  "id": "example.reader",
  "name": "My Reader",
  "entry": "index.js",
  "slots": ["document.html", "theme"]
}
```

The entry is one standalone browser ES module, exporting `default { apply(context) }`. It can use DOM directly or bundle its own rendering library. Build imports, styles and dependencies into this entry; relative imports from the generated Blob URL are not a supported module graph. Do not start timers, fetches or listeners at module top level. Module top level defines code; `apply` and renderer mounts own effects.

Supported slots:

| Slot | Input and owner |
| --- | --- |
| `message.plain`, `message.markdown` | Committed message text, format, locale and theme. Session still owns the text and message status. |
| `document.html`, `document.markdown`, `document.pdf` | The actual document Blob, filename, format, locale and theme. Host retains the dialog and download operation. |
| `theme` | CSS registered through `context.addStyle`. It is removed when the module unloads. |
| `settings.models.overview` | Public connection and adapter catalog. Multiple contributions appear in configured order. |
| `settings.connection.detail` | The current redacted connection; optional `adapterId` scopes the contribution. |
| `settings.usage.panel` | Current query and usage report, including Session attribution. |
| `tool.result` | Original activity projection, selected by the manifest's required `toolId` (tool operation). Tool status and failures remain outside this renderer. |

One selected plugin may own each replacement slot, including the theme; `tool.result` ownership is per operation. Settings contributions compose in configured order. Conflicting replacements report an error; there is no implicit priority chain. Only named presentation regions are replaceable. Core services, the Session projection, permission decisions and native page ownership stay with their existing owners. `settings.navigation` is a replacement slot; the three settings panel slots are additive contributions.

Settings manifests can declare `capabilities: ["usage.read"]` to receive `scope.usage.query(query, signal)`. Usage panels render the supplied usage report and retain its query interval and Session attribution. `connection.auth` provides login, cancellation, logout and quota operations only in `settings.connection.detail`, bound to that connection. Tokens and keys never enter these inputs. A view can read or cancel only the auth flows it started; disposal cancels pending flows. Message/document renderers retain their display-only boundary.

```js
export default {
  apply(ctx) {
    ctx.register('message.plain', (container, input, scope) => {
      const paragraph = document.createElement('p');
      container.append(paragraph);
      const update = (next) => { paragraph.textContent = next.text; };
      update(input);
      return { update, dispose() { paragraph.remove(); } };
    });
  }
};
```

`apply` registers every declared non-theme slot before it returns or its Promise resolves. It may return one cleanup function, including an asynchronous function. Replacement aborts the old scope, waits for its child views and module cleanup, then applies the next module. Cleanup errors remain visible. Each renderer returns `update(input)` and `dispose()`; `dispose()` may return a Promise. `update` handles changed display inputs without restarting a module. Both module and mount scopes expose:

- `signal`: aborted when the scope ends; pass it to asynchronous work and event listeners.
- `onDispose(fn)`: release subscriptions, timers or custom resources.
- `addStyle(css)`: append an owned stylesheet that is removed automatically.
- `reportError(error)`: report asynchronous failures for this plugin; the error is displayed and its active presentation is released.

Reloading the plugin replaces its own DOM and effects; conversation state, drafts and scroll containers remain owned by the shell. Plugin-owned internal view state can reset on replacement.

## Workbench regions and user actions

The built-in regions and selected external modules share the same runtime. The Host provides `scope.regions.mount(name, element)` for placing named child regions. The mount target must belong to the plugin container. Host-owned React content stays in stable mount nodes when a module reloads; a module never receives React objects, the app store, command dispatch or a native WebView.

Region inputs include the current Host view state and the existing shared Session values for tool activity, tasks and artifacts. Navigation receives the current catalog. Composer views receive the draft, attachment choices and send/stop availability; Reader views receive the current tab labels and selection. Scoped actions use the existing controllers for complete model selection, attachment intake, draft submission, stopping the current run, selecting a session or Reader tab, and disclosure. They do not accept arbitrary commands. The same controller enforces the explicit model/effort choice regardless of the renderer.

The usage slot is bounded by the main page. Opening Reader temporarily collapses the widget at the conversation's right edge without changing the saved visibility preference or reserving space below Reader. A full-workspace Reader hides it until the conversation is visible again. The built-in summary can be dragged within those bounds; collapse docks at the same vertical center. The docked handle is a regular clickable button and cannot be dragged. Clicking the summary opens details; the focused summary also supports arrow-key movement. Expanded details and context menus stay within the same bounds and use the existing native-overlay contract. Hiding the widget clears its query and timer; disabling removes the module and disposes its view.


| Slots | Host-owned content |
| --- | --- |
| `workbench.layout`, `navigation`, `conversation.header` | Titlebar, navigation and main surface; routing and selected conversation remain in the Host. |
| `activity.row`, `activity.summary`, `activity.detail` | Shared Session activities and manual disclosure state. Group summaries do not aggregate individual failures. |
| `composer.layout`, `composer.model`, `composer.attachments`, `composer.actions` | Draft, attachment intake and one complete model/effort choice. |
| `task.panel`, `artifact.panel` | Session Todo items and explicitly presented deliverables (latest version and Session ordering). |
| `reader.layout`, `reader.toolbar`, `reader.tree` | Mounted pages, toolbar, real resource roots and active-file reveal. |
| `settings.navigation` | Settings navigation and current page. |
| `usage.widget` | Current connection, model, visibility, expansion state, localized `labels` and `costDisplay` (`currency`, `usdRate`) for display estimates. |

Region inputs identify their slot and available child names. `composer.model` additionally receives redacted profiles, connections, the confirmed selection and busy state. Scope actions only contain operations supplied by that controller, such as `selectModel(profileId, effort)`, `pickAttachments()`, `setExpanded(boolean)` and `toggleTree()`. Selecting a model is a form operation; it submits the existing shared `session.model-settings.set` command once the full choice is available. CLI and TUI retain their existing parameter/default semantics and consume the same projection.

`usage.widget` can declare `usage.read` and `quota.read`. Quota reads are bound to the selected connection and carry no login/logout authority. The built-in widget is an ordinary standalone display module. Its enable and visibility settings are separate: disabling disposes the view and its requests; hiding also stops reads and can be reversed in Settings. The arrow collapses to a handle, the body opens details, and the context menu opens settings or hides the widget. The widget settings dialog selects USD or CNY for the widget and usage details. CNY uses a fixed estimate of 1 USD = 7 CNY; stored usage costs remain USD. API values are estimates from locally recorded calls, filtered by connection and requested model for the local calendar day; incomplete pricing stays visible. Codex quotas show remaining percentages and provider reset times. Missing data and errors are never presented as zero consumption.

Pricing coverage, per-call snapshots and DeepSeek peak/off-peak estimates are described in [Models and services](model-services.md#usage). Display plugins consume those recorded costs without recalculating provider prices.

The conversation's total cache indicator consumes Session's `totalTokenUsage`, covering that session and its descendant Agents once each, including closed members. It is separate from the optional usage widget's connection/model cost report and from the current-request context indicator. Display modules preserve unavailable and partial usage instead of rebuilding totals from visible task rows.

Reader hosts documents, embedded browser pages and a single Subagents list/detail tab. The Agent overview and individual activity links select that existing tab; Back returns to its list. Image thumbnails and Reader images use the shared original-image dialog. The macOS controlled-target thumbnail is a borderless draggable overlay anchored to the visible conversation layout; its click action activates the exact target and does not dispatch input to it. These displays consume existing Session or Host facts and do not create another execution loop or permission state.

## Application updates

Editing an enabled UI plugin's compiled module updates that plugin in the current window and keeps the conversation draft intact. Rebuilt application UI resources take effect after an interface reload; Session, Kernel and native changes require the corresponding build and process restart. For complete application updates and persistent Host shutdown, see [update timing](operations.md#updates).

## Component preview and source template

Each display plugin’s details in Settings → Plugins includes a component preview using the actual message and HTML Reader components. The content is labeled as examples. It shows the currently loaded plugin generations and uses the same mount/update/dispose path as a conversation.

A plugin folder contains its manifest and declared standalone JavaScript module. TypeScript sources must be compiled to that module; the Host watches the finished module and manifest. Reader selection, scroll position, PDF page and zoom stay with the open window.

## Tool contributions and CLI preference

The same management list includes tool and guidance sources. Existing owners remain separate: `plugins.sources` owns local CLI bundles, `plugins.disabled` records disabled built-in tools, `mcp.servers` owns external protocol servers, `skills.mounts` owns task guidance, and `workbench.uiPlugins` owns display modules. Inventory reads these sources and the display runtime; it is not another activation database.

Local CLI bundles, MCP servers and text Skills can contribute capabilities. Registration, activation and execution permissions are separate: adding a source does not authorize its tools to access files or run commands.

A local CLI plugin uses a `deepcode-tool.json` manifest and its declared executable entry. The Host reads metadata before adding; it does not run the entry during inspection. See [plugin activation and update timing](operations.md#models-and-context) for user mentions, Agent activation and the distinction between source updates and saved configuration changes. Changing an interpreter, native binary or Host requires the corresponding process/package update.

## Preview surfaces

The conversation header's browser and preview button toggles the reader. Tabs retain loaded documents and native page instances while collapsed. The separator adjusts width; the upper-right expand/restore control fills the workspace and returns to split mode. Closing a browser tab closes that page; collapsing only hides it. Closing the Subagents Reader tab only closes its view and does not cancel an Agent task. The task panel shows phase descriptions and statuses, while the output panel lists only explicit Session deliveries. Runtime screenshots, logs and scratch files do not appear automatically. Artifact references use readable names while the reader exposes full locations on demand. Fixed references read archived bytes, including a historical version after the output panel has moved to its newer delivery. Inline review images have bounded compact and expanded widths and scroll when expanded.

Embedded browser tools follow the originating GUI window's capabilities. Page opening, DOM inspection and page interactions remain available on Windows, Linux and macOS. `browser.observe` and `browser.capture` require native viewport capture, supported on macOS (WKWebView) and Windows (WebView2); Linux Hosts mark these tools unavailable. `computer.control` separately requires the desktop executor: the independently signed macOS Computer Use App (updated with `bash build.sh --stage computer-use`) or `DeepCode-Computer-Use.exe` next to the Windows GUI. It follows the external permission setting (`allow`, `ask` or `deny`); `ask` sends each call to the configured execution reviewer. “Approve for me” can review these requests, while uncertainty or a failed review requires user input. Use `browser.page` with `action: act` and `operation: inspect` for DOM inspection without screenshot pixels.

The native browser's **Annotate / 批注** button sits immediately to the right of Refresh. Select a DOM element or draw a region, enter a comment and add it to the ordinary conversation draft. Page URL, selector, viewport and selected text are quoted as page evidence, separately from the comment. macOS also attaches the marked viewport capture using the existing image attachment path; other platforms retain region metadata because native capture is currently macOS-only. Frames are selectable as a box; use region selection for details inside a frame. Adding a comment keeps annotation mode active for another selection. Exit with the toolbar's close button or Escape. Resizing refreshes the selected element's geometry or clears the selection, without leaving annotation mode. While a page is hidden or loading, its overlay is removed; an active annotation mode resumes when that page is visible and ready. Closing a tab disposes that page and its annotation state. Nothing is automatically submitted to the model.

Dragging the reader separator suppresses text selection only for the drag lifetime. Pointer release, cancellation, loss of capture, window blur and unmount restore normal selection and copying.
