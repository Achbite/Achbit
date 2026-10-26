# Plugin development

[简体中文](README.zh-CN.md) · [Project README](../../README.md#plugins) · [Product operations](../product/operations.md#settings-and-extensions)

[Boundaries](#boundaries) · [Artifacts and import](#artifacts-and-import) · [Discovery](#discovery) · [CLI tools](#cli-tools) · [Hosted services](#hosted-services) · [UI and Skills](#ui-and-skills) · [Provider files and conversations](#provider-files-and-conversations) · [Validation](#validation)

This guide specifies the existing extension contracts. Examples are protocol templates, not additions to the built-in plugin catalog. An extension that fits one of these contracts is distributed as its own files and imported through Settings; it does not require a new Host interface, model registration or changes to the Agent Loop.

## Boundaries

| Owner | Responsibility |
| --- | --- |
| Session | The single Agent Loop, context assembly, Provider calls, cancellation, journal and semantic projection. |
| Kernel | Available tool bindings, effects, permissions, execution results and attempt-owned resources. |
| Host | Discovering artifacts, storing settings/secrets, owning service processes and transporting events. |
| Plugin | Its declared operation or service implementation and cleanup of its own resources. |
| UI | Rendering shared facts and collecting user input. |

Task composition selects the callable tools before the model request. A read-only task receives its reading task and read tools. Unavailable optional capabilities contribute neither callable bindings nor lists of disabled framework features. Guidance about delegation is included only when delegation is part of the task's capabilities. This is context assembly; tool execution still checks the relevant permission boundary.

Managed Shell activity, containers and plugin activation have their own resource owners. Completion reaches Session through events; the parent model need not repeatedly ask whether a child has finished. Closing a Reader releases its subscription, not the child task. Removing an optional capability must leave the core Loop and remaining tools usable.

## Artifacts and import

Keep a plugin in a stable directory. In **Settings → Plugins → Add**, select the directory or the exact manifest file. Inspection reads metadata and validates the entry; it does not execute plugin code. A directory with multiple recognized manifests requires choosing the specific file. An archive must be unpacked first; ZIP files are not directly imported.

| Kind | Recognized file | Saved setting | Activation |
| --- | --- | --- | --- |
| CLI tool | `achbit-tool.json` | `plugins.sources` | Selected tool contributions are activated for a task; each call runs a process. |
| Hosted service | `achbit-service.json` | `plugins.services` | Enabling starts the owned process; disabling/removing stops it. |
| Display | `achbit-ui.json` | `workbench.uiPlugins` | Enabling applies the module to its declared slots. |
| Skill | `SKILL.md` | `skills.mounts` | Guidance is selected/read for a task. |
| External MCP | Configure the server in Settings | `mcp.servers` | Existing MCP discovery and activation. No new Achbit manifest is needed. |

Import stores a reference to the local source; it does not copy the source into the application or make it built-in. Keep the directory present after import. A logical plugin ID identifies the source, not a running process, tool attempt or conversation. Updating an artifact under that ID does not authorize new effects. If its ID changes, remove the old registration and import the new one.

Package the manifest, compiled entry and required assets/dependencies. Keep login data, API keys, state directories, runtime logs and test conversations outside the distributable. For a service restricted to experiments, set `debugOnly: true`; normal builds will reject activation. Do not add experimental plugins to the built-in catalog or normal package.

## Discovery

`name` identifies an extension to the user; `description` briefly explains its reusable capability and appropriate use. A tool's description explains its operation, inputs and meaningful constraints. Keep descriptions task-independent: no benchmark questions, sample expected answers, enabled/disabled inventories, login state or framework startup instructions. Lifecycle status belongs to Host/UI state. Detailed methods belong in a Skill or documentation.

`plugin.search` discovers the available tool/Skill catalog without starting processes. Keywords match the recorded capability text; an omitted query browses the catalog. `plugin.activate` selects an enabled result by its exact URI and makes its contributions available to subsequent requests. Discovery, user enablement, task activation and execution permission are separate actions. Activation is not installation, permission approval or model registration. UI/service plugins are managed by their user settings; starting a service does not automatically publish model-callable tools.

For local CLI tools, the catalog URI is `plugin://<id>@cli`. The manifest's tool names become `<id>.<name>` in Achbit. The plugin receives its original local tool name. Reuse the URI and schema returned by discovery rather than constructing instance IDs or guessing arguments.

## CLI tools

`achbit-tool.json` describes a single-file executable bundle:

```json
{
  "id": "plugin-id",
  "name": "Plugin name",
  "description": "Describe the reusable capability and when to use it.",
  "command": "node",
  "entry": "entry.mjs",
  "args": [],
  "tools": [{
    "name": "operation",
    "description": "Describe this operation and its input contract.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
  }]
}
```

- `id` and tool names are nonempty ASCII letters/digits, `.`, `_` or `-`; names are unique within the manifest.
- `name`, `description`, `command`, `entry` and a nonempty `tools` array are required. `args` defaults to `[]`. Omitted `inputSchema` defaults to `{"type":"object"}`; when supplied it must be an object.
- `entry` is one filename in the plugin directory, not a nested path. Bundle dependencies into this file; it is captured and copied into the execution attempt's archive. Its size must be between 1 byte and 4 MiB. The UTF-8 JSON manifest is limited to 64 KiB.
- Invocation is `command <archived-entry> ...args`, without a shell. `command` must resolve in the Host process environment or be an absolute executable path. The CLI contract does not install dependencies or promise bundled interpreters. Hosted Node services use the separate contract below.
- Working directory is the bound workspace when present. Do not resolve assets relative to the original source directory: execution uses the captured single-file bundle.

One invocation reads one JSON value from stdin until EOF:

```json
{"name":"operation","arguments":{},"context":{"deepcode":{"outputDirectory":"/absolute/attempt-output"}}}
```

`name` and `arguments` are the operation's input. `context` is Host-supplied execution metadata; `context.deepcode.outputDirectory`, when present, is the attempt's output location. `deepcode` is the existing wire key. It is not a system instruction or model message.

Write exactly one JSON result to stdout and exit. Return structured failure as `{"error":{"code":"operation_failed","message":"Concrete cause"}}`; nonzero exit, invalid JSON, cancellation and timeout are also failures. Use stderr for diagnostics. Current limits are 60 seconds, 4 MiB stdout and 64 KiB stderr. The Host owns and terminates the process tree. Do not leave a background service behind a tool call; use a hosted service for that lifetime.

Artifact registration/delivery is owned by Kernel/Session. A path printed in tool output is not automatically an archived artifact or a final delivery. Use existing resource contracts for that purpose; preserve original failure results.

## Hosted services

`achbit-service.json` is a Node service artifact. Dependencies may remain alongside the entry because the service runs in its own source directory using Achbit's resolved Node runtime.

```json
{
  "schema": "achbit.service-plugin.v1",
  "id": "plugin-id",
  "name": "Plugin name",
  "description": "Describe the service capability and its endpoint protocol.",
  "entry": "entry.mjs",
  "args": [],
  "debugOnly": false
}
```

All fields except `args` and `debugOnly` are required; those default to `[]` and `false`. Unknown fields are rejected. ID length is 1–128 ASCII characters, starts with a letter/digit, and otherwise permits letters/digits, `.`, `_`, `-`. The manifest is at most 64 KiB. `entry` must resolve to an existing file inside the plugin directory; relative subdirectories are supported.

The Host starts `node <entry> ...args` and writes one newline-terminated initialization object to stdin:

```json
{"protocol":"achbit.service-plugin.v1","stateDirectory":"/absolute/host-owned/plugin-state"}
```

After successfully binding its endpoint, the service writes one newline-terminated ready object to stdout within 10 seconds:

```json
{"protocol":"achbit.service-plugin.v1","baseUrl":"http://127.0.0.1:17632/v1","pageUrl":"http://127.0.0.1:17632"}
```

`pageUrl` is optional. The URLs require HTTP, `127.0.0.1`, and an explicit port, without credentials, query or fragment. They may include a path. The ready line is limited to 64 KiB; stdout is reserved for the handshake, and diagnostics go to stderr (`runtime.log` under the supplied state directory). Never include credentials in the handshake or a URL.

EOF on stdin means the Host is stopping the service. Stop accepting work, cancel in-flight requests, close listeners and child resources, then exit promptly. Disable, removal, source replacement and Host shutdown use this owner-controlled path. The Host gives graceful shutdown one second, then terminates the owned process tree. Unexpected exit clears published endpoints, preserves a failure and notifies subscribers; reading the plugin list is not required to notice the exit. There is no implicit restart loop. Re-enable explicitly after resolving the failure.

Persistent service data belongs in `stateDirectory`. Stopping/restarting the process preserves this directory; removing registration does not imply logout or deletion of credentials. The plugin implements explicit account/logout operations. Source files and transient process IDs are not persistence stores.

The endpoint's application protocol belongs to the plugin. A service offering a compatible LLM API can be entered in the existing model connection settings, just like any local endpoint. Hosting it does not change the Agent Loop or register a new model type. API authentication remains separate from the lifecycle handshake.

## UI and Skills

UI plugins export `default { apply(context) }` from one standalone browser ES module, declare supported slots in `achbit-ui.json`, and register renderers with `context.register`. Renderers consume published inputs/actions and return `update`/`dispose`; `apply` may return cleanup. Use scoped disposal and cancellation for listeners, styles, subscriptions and work. Replacement waits for cleanup and restores built-in presentation on disable. See the complete [UI slot, capability and action contract](../product/ui-plugins.md).

Skills use a `SKILL.md` with `name` and `description` front matter and Markdown guidance. Put supporting assets and references in the same package, use relative links, and keep operating instructions scoped to the capability. A Skill is guidance, not an executable service, permission grant or second Loop. Register it with `skills.mounts`; read its content/resources through the existing Skill mechanism.

MCP integrations use `mcp.servers` and the existing transport. Give the server a capability description for discovery; keep tool schemas/results in MCP. A local CLI manifest, MCP server and hosted service are different execution lifetimes, not aliases for one another.

## Provider files and conversations

These rules apply only to a plugin exposing a compatible model endpoint:

- Declare supported image/file input in the existing model profile. `fileInputMediaTypes` controls native file transport; it does not assert that every document will be parsed accurately.
- Images use `image_url`; original documents use a `file` content part with `filename` and `file_data` (a data URL) in chat-completion requests. Preserve bytes and media type. An unsupported provider returns an error. Host transport must not silently convert a document into text or an image.
- Chat Completions transport supplies `X-Achbit-Session-Id` and `X-Achbit-Request-Purpose` headers for conversation-associated requests. They are transport metadata, not model context. A plugin can use them to own remote-chat mapping and continuation cursors without changing the Loop.
- Reuse a remote conversation only when the retained client history matches a confirmed checkpoint; send only the appended messages/attachments. History edits, compaction or a new Session can require a new remote conversation. Keep account and request purpose separate. Auxiliary title requests (`conversationTitle`) must not advance the main conversation. If unsupported, return an explicit error; the Host retains its initial message-derived title and records that failure.
- A provider adapter must propagate cancellation and preserve upstream errors. Unknown completion after cancellation/failure is not a confirmed cursor. Do not silently replay requests as successful continuations.

Native upload and local document operations are distinct. Local PDF reading/export uses its own plugin tools; Documents PDF export takes Typst source and uses Rust Typst, while HTML/Markdown keep their respective source formats. See [document input/output rules](../../skills/achbit-documents/references/formats.md). Website parsing accuracy is an upstream result, not proof of transport correctness.

## Validation

Build the plugin entry with its own dependencies, then import the actual directory or manifest into an isolated Achbit Debug instance. Check discovery, one real invocation or service handshake, and disable/removal cleanup. Verify failure/cancellation where the plugin owns work. A service test should confirm that its port is released and any intended persistent state survives restart. Do not require unrelated platform matrices or new model tools for a plugin using an existing protocol.

For changes to Achbit itself, use the repository's [development and test entrypoints](../development.md#checks) and provide a TCR when changing tests. Keep unit tests, Debug loading, a real Provider conversation and release packaging as separate evidence. For UI/service lifecycle testing, use [Debug control](../debug-control.md).

The implementation owners are [tool manifest](../../crates/achbit-kernel-abi/src/tool_plugin.rs), [service manifest](../../crates/achbit-kernel-abi/src/service_plugin.rs), [import inspection](../../crates/achbit-host-web/src/ui_plugins.rs), [CLI invocation](../../crates/achbit-kernel-daemon/src/local_agent_cli.rs), [tool discovery](../../crates/achbit-kernel-daemon/src/local_agent_mcp.rs), [service supervision](../../crates/achbit-kernel-daemon/src/service_plugins.rs) and [task activation](../../userspace/session-core/src/local-agent/pluginActivation.ts).
