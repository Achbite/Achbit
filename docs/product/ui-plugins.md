# Display plugins and UI updates

Display plugins replace named GUI regions or add supported settings panels. They use published inputs/actions, not the Agent Loop, permission store or arbitrary Session commands. For controlling an existing Debug GUI, use [Debug control](debug-control.md), not a new display plugin.

## Use a plugin

Settings → Plugins → Add: select a local folder or `achbit-ui.json`. Only load JavaScript intended to run in the application window. The source is stored in `workbench.uiPlugins`, independently of tool/Skill activation.

Saving the enabled compiled entry or manifest hot-replaces that plugin. TypeScript must first be compiled to its declared entry. Refresh list reconnects the source watch; Reload in plugin details reloads only that module. Disabling removes its effects and restores built-in presentation. Errors stay visible; none of these actions requires restarting the conversation.

## Manifest and module

```json
{
  "id": "example.message",
  "name": "Plain message",
  "entry": "index.js",
  "slots": ["message.plain"]
}
```

Export `default { apply(context) }` from one standalone browser ES module. Bundle imports/dependencies into it; relative imports from its Blob URL are unsupported. Start effects in `apply` or mounts, not at module top level.

```js
export default {
  apply(context) {
    context.register('message.plain', (container, input, scope) => {
      const text = document.createElement('p');
      container.append(text);
      const update = next => { text.textContent = next.text; };
      update(input);
      return { update, dispose() { text.remove(); } };
    });
  }
};
```

`apply` registers every declared non-theme slot before resolving and may return cleanup. Renderers return `update(input)` and `dispose()`; disposal may be asynchronous. Replacement waits for old cleanup. Use `scope.signal`, `onDispose(fn)`, `addStyle(css)` and `reportError(error)` for owned work. Preserve original errors and release timers/listeners/subscriptions.

## Slots and capabilities

| Slot | Input / responsibility |
| --- | --- |
| `message.plain`, `message.markdown` | Committed text, format, locale, theme |
| `document.html`, `document.markdown`, `document.pdf` | Document Blob, filename, format, locale, theme; Host retains download/dialog |
| `theme` | Owned CSS via `addStyle` |
| `tool.result` | Original activity for required manifest `toolId`; no status rewriting |
| `settings.models.overview` | Public connection/adapter catalog |
| `settings.connection.detail` | Redacted connection; optional manifest `adapterId` |
| `settings.usage.panel` | Current query/report and Session attribution |
| `workbench.layout`, `navigation`, `conversation.header` | Layout, navigation and selected conversation |
| `activity.row`, `activity.summary`, `activity.detail` | Existing activities and disclosure state |
| `composer.layout`, `composer.model`, `composer.attachments`, `composer.actions` | Draft, selection, attachments and send/stop availability |
| `task.panel`, `artifact.panel` | Todo and explicitly delivered resources |
| `reader.layout`, `reader.toolbar`, `reader.tree` | Tabs, controls and actual resource roots |
| `settings.navigation`, `usage.widget` | Settings navigation or current usage display |

Replacement slots have one owner (`tool.result` per operation); settings panel contributions compose. Conflicts are errors, not an implicit priority order.

Declare only supported capabilities:

- `usage.read`: `scope.usage.query(query, signal)` for supported usage/settings views.
- `quota.read`: selected-connection quota in `usage.widget`, not login authority.
- `connection.auth`: login/cancel/logout/quota in `settings.connection.detail`, bound to that connection. Secrets never enter plugin inputs; disposal cancels owned login flows.

Use supplied usage totals, pricing and coverage; do not rebuild them from visible rows. [Usage scopes](model-services.md#usage) distinguish Session totals from connection/model costs.

## Workbench actions

Region inputs have `{ kind: 'region', slot, regionNames, data, locale, theme }`. `data` is a read-only view of the current owner. `scope.regions.mount(name, element)` mounts a name from `regionNames` into an element inside the plugin container. Keep mounted children attached; the Host retains their drafts, routing, scroll positions and native pages. Most slots publish `content`; `conversation.header` publishes `heading` and `reader` separately.

Actions are supplied only by the corresponding slot. Use current input IDs and availability fields; actions returning a Promise must be awaited and failures sent to `scope.reportError(error)`.

| Slot | Published data and actions |
| --- | --- |
| `navigation` | `data.kind = 'navigation'`: `projects`, `sessions`, `activeSessionId`, `busy`; `activateSession(sessionId: string): Promise<void>` |
| `conversation.header` | `data.kind = 'conversationHeader'`: `sessionId`, `title`, `project`, `reader: { visible, expanded, treeVisible, canOpen }`; `toggleReader()`, `toggleReaderExpanded()`, `toggleTree()` |
| `composer.layout`, `composer.attachments`, `composer.actions` | `data.kind = 'composer'`: `draft`, `canSend`, `canStop`, `attachments`; `updateDraft(text: string)`, `pickAttachments()`, `addAttachments(files: { path: string, kind: 'file' \| 'directory' }[]): Promise<void>`, `submitDraft(): Promise<void>`, `stopRun(): Promise<void>` |
| `composer.model` | Specialized `input.kind = 'composer.model'`: `profiles`, `connections`, `selectedProfileId`, `reasoningEffort`, `confirmed`, `busy`; `selectModel(profileId: string, effort: LlmReasoningEffort \| null): Promise<void>`. Use an effort supported by the selected profile. |
| `activity.row`, `artifact.panel` | Current activities or artifacts and `expanded`; `setExpanded(expanded: boolean)` |
| `reader.layout`, `reader.toolbar` | `data.kind = 'reader'`: `tabs`, `activeId`, `visible`, `expanded`, `treeVisible`; `selectReaderTab(tabId: string)`, `toggleReaderExpanded()`, `toggleTree()` |
| `reader.tree` | `data.kind = 'resourceTree'`: `items`, `filter`, `showRuntime`, `selectedId`, `watchError`, `visible`; `setTreeFilter(filter: string)`, `setTreeRuntimeVisible(visible: boolean)`, `setTreeItemExpanded(itemId: string, expanded: boolean)`, `openTreeItem(itemId: string)`, `openTreeItemMenu(itemId: string)` |
| `settings.navigation` | `data.kind = 'settingsNavigation'`: `pages`, `activePage`, `searchQuery`; `selectSettingsPage(pageId: string)`, `setSettingsSearch(query: string)` |

Tree items contain `{ id, parentId?, name, kind, depth, expanded, selected, error? }`, where `kind` is `directory`, `file` or `unavailable`. IDs are opaque: expand directories, open files and retain errors on unavailable entries. Filtering matches already loaded items. Actions without an indicated return value return `void`.

For example, set the manifest's `slots` to `["conversation.header"]` and use this standalone module to replace the title while preserving the Host's Reader controls:

```js
export default {
  apply(context) {
    context.register('conversation.header', (container, input, scope) => {
      container.style.display = 'contents';
      const heading = document.createElement('strong');
      container.append(heading);
      scope.regions.mount('reader', container);
      const update = next => { heading.textContent = next.data.title; };
      update(input);
      return { update, dispose() { heading.remove(); } };
    });
  }
};
```

## Preview surfaces

- Reader collapse retains tabs; closing a browser tab closes the page. Closing Subagents only closes its view, not the task.
- The tree menu supports right-click/Shift+F10: preview, copy name/relative/absolute path, reveal, open in VS Code, add a draft reference. `openTreeItemMenu(itemId)` opens that same menu. Path/reference actions do not depend on preview loading, grant access or send a message.
- Resource watches are shared per Session, including hidden tabs. An unavailable resource does not fail unrelated subscriptions; Reload restarts failed watch/read work.
- Pure-image thumbnails use the image rectangle; HTML thumbnails have a separate height bound. Thumbnail presentation does not resize or scroll the operating WebView.
- Browser DOM operations need the originating GUI. Native viewport capture is supported on macOS/Windows, not Linux. Desktop control separately needs its available native helper and permissions.
- Browser Annotate adds selected element/region evidence and a comment to the draft; it does not send automatically. Frame contents can use region selection. Annotations include marked captures on macOS; other platforms retain selection metadata.

Plugin details include a labeled component preview. It demonstrates rendering, not real Provider or installed-product acceptance. For application resource reloads and core process restarts, see [update timing](operations.md#updates).
