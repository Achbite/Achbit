---
name: deepcode-product
description: Find DeepCode operation, configuration and troubleshooting guidance without searching the implementation first.
---

# DeepCode product guidance

Use current tool schemas and availability. Read only the document relevant to the question with `doc.read`:

| Need | name |
| --- | --- |
| Tools, plugins, Plans, delegation, Reader, delivery | `operations.md` |
| Shell, sandbox, Docker, WSL or SSH | `execution-environments.md` |
| Models, authentication, context, usage or images | `model-services.md` |
| Display plugin interface and hot replacement | `ui-plugins.md` |
| Isolated development control | `debug-control.md` |

For an existing conversation, call `session.read` directly with the complete ID; no Skill is prerequisite. For missing executable capabilities, use `plugin.search`, then activate relevant exact URIs. Documentation and activation do not grant execution permission.

Distinguish missing commands, denied access and failed connections using the returned error. Windows-specific hints: [references/windows-environment.md](references/windows-environment.md). Inspect source only when the documented interface and recorded facts leave a concrete question unresolved.

For changing DeepCode, use `deepcode-iteration`; for requested cleanup/documentation work, use `deepcode-release-audit`. These are separate scopes, not a chain to invoke for every product question.
