# Skill / MCP integration inputs

See the [project README](../../README.md) for product versions and plugin usage. This source-distributed directory has no independent product version.

It contains two original inputs that tests can assemble temporarily:

- `skills/text-echo-declarative/SKILL.md` contributes instructions only. It does not grant Kernel tools, workspace, shell, network, or secret permissions.
- `mcp/mcp-text-tools/server.py` is a local stdio MCP server using line-delimited JSON-RPC and providing `text.reverse`. Tests register it through temporary settings; the Kernel owns and reclaims its process.

Tests should drive tool recognition and execution with structured Provider fixtures rather than fixed natural-language questions or keywords. Selected Skill content is prepared again before the next model request; selected CLI plugins follow the same update boundary. Existing requests, pending approvals, and running calls retain their generation and bindings. CLI registrations, Skill mounts, and MCP configuration refresh before the next model request in the current run. Model and execution-environment settings apply to the next run. Registration refresh does not reload external MCP service code or replace an existing call's connection.

These files are not plugin descriptors, runtime contracts, release manifests, or a second source of truth.

An external MCP registration may include a task-oriented `description` for `plugin.search`; the selected MCP service still supplies the actual tools. Structured Provider fixtures verify discovery, activation, and execution, not whether a real model autonomously chooses a capability from an ordinary task. Observe that behavior separately with tasks that omit plugin names, tool names, and activation steps, and record the actual choices.
