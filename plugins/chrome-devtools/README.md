# Chrome page control (macOS)

The packaged macOS runtime includes the official Google Chrome DevTools MCP server, pinned in package.json. Kernel discovers it as `plugin://chrome-devtools@builtin` using the existing MCP activation, permission, tool catalog and run disposal path. Windows integration is separate and is not enabled by this contribution.

The server uses `--autoConnect` to attach to the running Chrome profile through Chrome's supported remote debugging consent flow (Chrome 144 or later). Enable remote debugging at `chrome://inspect/#remote-debugging`; Chrome presents its own connection approval. An unavailable browser or denied connection remains an execution error, never an implicit switch to desktop input.

Page operations use the official tool's explicit `pageId`. New pages default to `background=true`; foreground selection is explicit. Browser contents receive no injected control badge or pointer overlay. The server detaches at run disposal and does not own the user's browser process.

Upstream: https://github.com/ChromeDevTools/chrome-devtools-mcp
