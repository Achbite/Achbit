---
name: achbit-product
description: Find Achbit operation, configuration and troubleshooting guidance without searching the implementation first.
---

# Achbit product guidance

Achbit is the current product name. Built-in Skill IDs and product commands use the `achbit-*` prefix.

`Achbit product resources` accompanies the originating selection message or successful plugin activation/Skill read result and supplies `productDocsPath` for the bundled Markdown guides. Use the shell to search with `grep`/`rg` and read the relevant file with `cat`, `sed` or PowerShell equivalents:

| Need | File |
| --- | --- |
| Tools, plugins, Plans, delegation, Reader, delivery | `operations.md` |
| Shell, sandbox, Docker, WSL or SSH | `execution-environments.md` |
| Models, authentication, context, usage or images | `model-services.md` |
| Display plugin interface and hot replacement | `ui-plugins.md` |
| Isolated development control | `debug-control.md` |

For an existing conversation, call `session.read` directly with the complete ID; no Skill is prerequisite. For missing executable capabilities, use `plugin.search`, then activate relevant exact URIs. Documentation and activation do not grant execution permission.

When those resources include `achbitCli`, submit its commands through Host Shell with `requestHostPermission`, a specific reason and `--host-data-dir hostDataDirectory`. Read-only queries such as `plugins status` use this same Host scope. The active permission policy handles authorization; if Host execution is disabled, the management CLI is unavailable in that session.

Distinguish missing commands, denied access and failed connections using the returned error. Windows-specific hints: [references/windows-environment.md](references/windows-environment.md). Inspect source only when the documented interface and recorded facts leave a concrete question unresolved.

For changing Achbit, use `achbit-iteration`; for requested cleanup/documentation work, use `achbit-release-audit`. These are separate scopes, not a chain to invoke for every product question.
