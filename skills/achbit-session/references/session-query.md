# Session query quick reference

Call `session.read` with the complete supplied `sessionId`. Start with `view: summary`; reading does not resume execution. Queries cover the current configuration root only.

| View | Use | Selectors |
| --- | --- | --- |
| `summary` | Persisted run, last messages, Todo/Plan, usage and recent tools | `limit` |
| `messages` | User/assistant/progress messages | `before`, `limit` |
| `tools` | Results, rejections and review decisions | `recordId`, `before`, `limit` |
| `plans` | Plan/Todo events | `before`, `limit` |
| `context` | Request structure/usage; exact review evidence | `providerRequestId`, `before`, `limit` |
| `reasoning` | Available recorded reasoning pages | `providerRequestId`, `offset`, `limit` |
| `images` | Archived image references | `imageIds` or pagination |
| `resources` | Managed workdir listing or bounded text | Exact returned `resource`, `startLine` / `startByte` |

Pages return newest matching events first, ordered within a page. Pass the exclusive `nextBefore` cursor for older results; null ends pagination. `limit` is 1–50. Check `truncated` and `totalBytes`; an excerpt is not a complete record. Retain sequence and record/request IDs to narrow follow-up reads rather than repeatedly scanning history.

For review details, query `context` with the exact `providerRequestId`. Recorded `reviewInput`, decision and resolution are not reconstructed from current code. `contextPrepared: false` means preparation failed before calling the reviewer. Approval does not prove execution; check the linked tool result.

For current-session images, list references first, then pass exact returned IDs in `imageIds` to load pixels for one successful request. Include comparison images together; `imageIds: []` releases them. Do not combine image selection with pagination. Arbitrary archived files are not necessarily entries in that image list.

For managed files, list `resources` and use its exact returned references, not guessed storage paths. Historical evidence does not establish current filesystem/process state.

## CLI alternative

Use a verified installed CLI path from the run context or prepared PATH; do not guess an application bundle.

```sh
achbit-cli read --session 'session:...'
achbit-cli read --session 'session:...' --view messages --before 120
achbit-cli read --session 'session:...' --view tools --record 'record:...'
```

`session_not_found` means absent from this configuration root. Ask for the correct ID/export rather than scanning unrelated user data or editing databases. For usage comparisons, distinguish own-session, descendant-inclusive and last-request scopes; missing usage is not zero.
