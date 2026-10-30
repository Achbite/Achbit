# Workbench Controls Example

Add this directory in **Settings → Plugins**, then enable it to replace the conversation header, settings navigation, and file tree presentation. The example is not installed by default. Import creates a Host-managed copy. After editing the source `index.mjs`, choose **Update** in plugin details and select this directory again, or run `plugins update <id|installed-path> <source-directory>`. The current GUI loads the updated module without rebuilding the entire application.

The example consumes the existing owners' view data and actions for three slots. It does not read file APIs, send Session commands, or keep additional page state.

| Slot | input.data.kind | Main data | scope.actions |
| --- | --- | --- | --- |
| conversation.header | conversationHeader | sessionId, title, project, reader | toggleReader, toggleReaderExpanded, toggleTree |
| settings.navigation | settingsNavigation | pages, activePage, searchQuery | selectSettingsPage, setSettingsSearch |
| reader.tree | resourceTree | items, filter, showRuntime, selectedId, watchError, visible | setTreeFilter, setTreeRuntimeVisible, setTreeItemExpanded, openTreeItem, openTreeItemMenu |

The `heading` and `reader` regions in `conversation.header` can mount existing controls. This example renders its own heading and calls `scope.regions.mount('reader', container)` to retain Reader tabs and controls. Mount `heading` to retain the original title.

File-tree node IDs are opaque values supplied by the owner. Expand and open actions accept only currently displayed nodes; do not derive paths from IDs. Directories use expansion, files use opening, and unavailable nodes retain their errors with actions disabled. Filtering matches loaded nodes, with the same semantics as the built-in tree.

To validate the example, open a file before replacing the plugin and check that Reader tabs still work. Enter a settings draft, navigate away and back, and check that it remains. Expand, filter, and open tree entries, then edit and reinstall the example through Update. Confirm that the same tree owner still supplies state. Verify physical mouse input, focus, and native window layout in the running GUI.
