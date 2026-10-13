# Session queries

Use the complete `sessionId`, such as `session:...`. The default view is `summary`. Items are ordered by event sequence, with the latest page returned first. `revision` is the journal sequence at read time; `sequence`, `eventId` and `recordId` identify evidence.

| View | Contents | Optional selectors |
| --- | --- | --- |
| summary | Persisted state, last request/reply, Todo, Plan, cumulative usage and recent tools | limit |
| messages | User, assistant and progress messages | before, limit |
| tools | Tool inputs, outputs, errors and record IDs | recordId, before, limit |
| plans | Plan and Todo events | before, limit |
| context | Input structure and per-request usage | providerRequestId, before, limit |
| reasoning | Recorded reasoning pages, when available | providerRequestId, offset, limit |
| images | Archived image references | imageIds, before, limit |

`before` is an exclusive backward cursor. Pass `nextBefore` to the next read; null means there are no earlier matching events. `limit` ranges from 1 to 50. Text excerpts report `truncated` and their original `totalBytes`. An excerpt is not the complete text and cannot establish that omitted content does not exist. `recordId` is for the tools view; `providerRequestId` selects context or reasoning. Queries cover only the current configuration root.

For images, omit `imageIds` to list references without loading pixels. To inspect earlier pictures in the current conversation, call `session.read` with `view: "images"` and the exact `referenceId` or `artifactId` values needed in `imageIds`. Include all images needed for a visual comparison. The selected pixels enter one successful Agent request, then only their archived references remain; `imageIds: []` releases the current selection. Do not combine `imageIds` with pagination. Image-list pages keep images from the same source message together. Historical references remain readable after their pixels leave the current input.

For the current installation, use the `runtimeExecutables.cli` path in the run's execution context when present. Otherwise locate `deepcode-cli` on the prepared PATH and verify the result. Do not guess an application bundle name or treat an absent PATH entry as proof that the CLI is not installed. Reading or executing an installation path still uses the ordinary execution-permission flow.

The CLI uses the same read-only interface and returns JSON:

```sh
deepcode-cli read --session 'session:...'
deepcode-cli read --session 'session:...' --view tools --limit 5
deepcode-cli read --session 'session:...' --view messages --before 120
deepcode-cli read --session 'session:...' --view tools --record 'record:...'
```

Input cache hit rate is `cacheReadInputTokens / inputTokens`; output tokens do not belong in the denominator. The context indicator describes the last settled request; the GUI total indicator divides cumulative cached input tokens by cumulative input tokens across this session and all descendant Agent sessions, including closed members and counting each session once across continued tasks. The own-session usage returned by a session query remains a separate scope. Different ratios across scopes are expected. If Provider usage is unavailable, retain the unavailable state instead of treating it as zero.
