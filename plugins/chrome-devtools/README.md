# Chrome page control (macOS and Windows)

The packaged macOS and Windows runtimes include the official Google Chrome DevTools MCP server, pinned in package.json. Kernel discovers it as `plugin://chrome-devtools@builtin` using the existing MCP activation, permission, tool catalog and run disposal path. Windows uses the bundled node.exe; macOS uses the bundled node executable.

The server uses `--autoConnect` to attach to the running Chrome profile through Chrome's supported remote debugging consent flow (Chrome 144 or later). Enable remote debugging at `chrome://inspect/#remote-debugging`; Chrome presents its own connection approval. An unavailable browser or denied connection remains an execution error, never an implicit switch to desktop input.

Page operations use the official tool's explicit `pageId`. New pages default to `background=true`; foreground selection is explicit. Browser contents receive no injected control badge or pointer overlay. The server detaches at run disposal and does not own the user's browser process.

For file operations, Host resolves the current session's existing private working directory and freezes its canonical path for the run. It passes that directory through the upstream `--workspace` option and uses it as the MCP process cwd. Relative screenshot `filePath` values therefore resolve there; absolute paths in the same directory are also accepted. Project directories and read-only attachment snapshots are not added as roots. The upstream server still includes the operating system's temporary directory. Local upload file parameters use the same roots, while `new_page` / `navigate_page` URLs do not use that file-path check; this is not a restriction on browser `file://` navigation. Saving a screenshot does not automatically present it as a deliverable.

The structured snapshot producer is enabled. Delegated execution review can use recorded observations matching the exact session, run, Chrome plugin instance and page, including every UID referenced by the requested operation. Navigation, page closure, newer snapshots and instance changes invalidate earlier evidence as appropriate. This supplies facts to the existing approval decision; it does not grant permission, perform an extra observation or guarantee automatic approval. Page-list responses, including the list returned by `new_page`, can contain titles and URLs of other open Chrome tabs.

Connection and tool errors retain their original diagnostics. Host bounds each MCP request to 30 seconds and reclaims the MCP process on timeout; further calls to that stopped instance fail. This does not close the user's Chrome process. A new run prepares a new instance. Plugin activation and tool listing alone do not prove that browser connection, page actions or screenshot saving succeeded.

Upstream: https://github.com/ChromeDevTools/chrome-devtools-mcp
