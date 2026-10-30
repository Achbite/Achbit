# Agent Runtime contract assets

See the [project README](../../README.md) for product release information. The product version, artifact `BUILDINFO.json`, and each owner's schema version are maintained independently. Releasing a new product version does not automatically increment database versions.

This directory contains the current local Agent Runtime machine contracts. It has no migration scripts, compatibility aliases, dual reads/writes, previous-root fallback, or alternate Session/Kernel execution path.

## Current contracts

| Fact owner | Database creation contract | Current `user_version` | Responsibilities |
| --- | --- | ---: | --- |
| Host Catalog | `catalog.sql` | 2 | Projects, Host-private workspaces, project directory-index templates, Session classification, original file/directory locations, and Session-owned text resources and work directories |
| Session | `session.sql` | 7 | Creation snapshots, journal, command replay, conversation directory index, cross-run Plan/Todo, Provider turn terminal state, control rejection, request receipts, usage, and run-runtime release receipts |
| Kernel | `tool-record.sql` | 1 | Immutable ToolRecords for the lifetime of a Session |

`schema.json` defines the current wire schema between UI, CLI, TUI, Host, Session, and Kernel. SQL constrains each store's persistence boundary; it does not replace the wire schema or authorize inferring facts across owners.

`ToolExecutionRecord.outcome=cancelled` means execution was cancelled, not that earlier side effects were rolled back. Optional `output` may retain output produced before cancellation; `error` remains prohibited. Cancellation before execution may have no output. The Linux built-in foreground workspace shell produces a cancelled record with output only after its controlled executor reclaims processes, archives output, cleans temporary resources, and returns explicit cancellation. Cleanup failure or an unknown result remains `indeterminate`. This extension does not change database versions or historical records. Consumers must accept optional output in cancelled records.

Model profiles and sidebar ordering are Host user configuration. Model configuration errors are retained and displayed through settings without preventing the Host from opening a valid Session store. Runs still require usable model configuration. GUI ordering does not change Catalog project ownership or Session semantics.

A configuration root has exactly one daemon owner at a time. Before reading authoritative configuration or opening the three business stores, the daemon must hold a process-lifetime lease on `<data_dir>/agent-runtime/root-owner.lock`. A second daemon for the same root fails explicitly with `config_root_already_owned`. `data_dir` is the Host persistent data directory; see [User directories](../../docs/distribution.md#user-directories) for platform locations and isolated roots. The file is an operating-system-backed ownership lease, not a fourth business store. Process exit or crash releases ownership.

Catalog owns mutable Session titles and Project classification. Session projection `display.creationTitle` retains only the immutable creation title and is not a second authority for current titles or classification. Host shells consume Session facts by pulling projection snapshots. The current contract has no projection subscription/SSE path; each shell may poll the same snapshot endpoint at its own presentation cadence.

Provider-native `callId` and Session `LogicalCallId` are distinct identities. For each Provider turn, Session generates independent LogicalCallIds without reusing native values. Journal payloads retain the native identity in `providerCallId`. Top-level `callId`, Interaction/Plan identities, Kernel requests, ToolRecords, and Session replay use LogicalCallId.

Session projection `tokenUsage` retains the current session's own accounting. `totalTokenUsage` follows existing Agent creation relationships to aggregate the current session and all descendants, counting each sessionId once, including closed members and their multiple tasks. Usage comes from existing Provider records, not GUI-visible task counts or a new usage fact table. Missing usage remains unavailable/partial. Context estimates and Host cost reports retain their existing accounting scopes.

Delegation changes enter existing Sessions as `agent.delegation.changed`, preserving notification order without starting an idle Loop. New and continued delegated tasks use the latest Host settings. Disabling delegation does not cancel running or waiting subtasks or delete messages, execution history, or usage. Plan expresses new or expanded authorization; Todo expresses optional progress. Neither replaces Kernel execution facts.

`message.submit.filesystemReferences` is the message-level logical reference for both files and directories. The Host registers original locations without copying files into the private Session directory. Session persists only `referenceId/workspaceId/logicalPath/displayName/kind` and file media metadata. References expand request resource lookup, without adding run working-directory bindings or granting tool access. Session freezes run directory bindings from its directory index at startup. Ordinary files reach the Provider as logical workspace handles and paths; content is read as needed through file tools under existing permissions. Session includes current-run PNG, JPEG, WebP, and GIF attachments as visual input, reading original bytes at the Provider boundary and requiring image input support. The journal retains image references, not base64. Host canonical paths do not enter the message contract. Pasted long text remains a Session-owned read-only snapshot. PDFs remain `kind=file` and are handled by a Skill plugin declaring activation for `application/pdf`.

## Opening rules

- If the file does not exist or the database is empty, execute its current creation contract.
- If `user_version` exactly matches the current version, validate required tables and open it.
- Reject every other version. Do not migrate, infer, poll, read an old root, or delete user data automatically.
- Each owner interprets its own `user_version`; one store's version says nothing about another's.

## Deletion and history boundaries

Deleting a Session is an aggregate operation: remove its Catalog entry, Session archive, private directory-index relationships, owned text resources and work directory, and ToolRecords together. References to these resources become invalid. Original external files and directories remain. Ordinary tool calls cannot arbitrarily modify or delete ToolRecords; only Host-coordinated Session aggregate purging may delete them.

Catalog, Session, and ToolRecord stores are under `<data_dir>/agent-runtime/`. The same directory contains the Host Provider usage-report index, `provider-usage.sqlite3`, which does not replace the Session journal or ToolRecords. `root-owner.lock` proves only the current daemon's ownership of the configuration root. Earlier directories and databases are outside the current runtime contract; there is no read-only historical entrypoint.

If an orphaned ToolRecord has no matching Session, preserve the original failure and investigate the lifecycle source. This contract does not authorize silent deletion through startup cleanup, background scans, or UI actions.
