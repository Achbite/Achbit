# Opening a saved conversation

The desktop can present a revision-bound reading window before restoring the complete Session projection. This is an authenticated, read-only GUI API, not an Agent tool. It does not resume a task, grant access to a resource, or change the journal. Ordinary `messages` pages are excerpts and cannot substitute for a reading window.

A successful `GET /api/conversation/statuses` may include `x-achbit-reading-window: 1`. This advertises the current Session service's support; the response body remains the original array. Without that header, use the existing projection path. The full snapshot remains authoritative for commands and dependent controls.

```
POST /api/conversation/sessions/:id/read
{"view":"readingWindow","throughSequence":8898,"limit":12}
```

`throughSequence` is the **current exact revision**, not an upper cutoff into archived history. `limit` is 1–24 rows (default 12). Omit `anchorKey` for the tail, or supply an actual transcript row key for a window containing that row. For messages this is `timeline.streamId ?? message.messageId`, not the timeline ID. `before`, offsets and detail selectors are not supported on this view. Other read views retain their original semantics.

The original read envelope has `sessionId`, `revision`, `view`, `items: []`, `nextBefore: null` and one additional field:

- `readingWindow.kind: "ready"` includes `anchorKey`, zero-based `startIndex`, `totalRows`, `rows` and `navigation: {keys,labels}`. Each row carries `key`, `timelineId`, `sequence`, optional `streamId` and the **complete** canonical `message`. The navigation lists every user row in transcript order. Rendering uses the normal message component; a page is not a complete projection and carries no mutation authority.
- `readingWindow.kind: "requiresProjection"` contains no partial body. Mixed or dependent surfaces, non-completed runs, empty histories and out-of-budget windows use the ordinary projection. The v1 server bounds replies to 256 KiB and at most 4,096 user navigation entries; it never abbreviates the body to meet that budget.
- `conversation_read_revision_changed` requires a fresh current status. `conversation_read_anchor_not_found` denotes a missing named row in a supported timeline. A rejected request, malformed stream, inconsistent lineage, denied read or broken history is not a successful fallback.

The Session can negotiate `application/vnd.achbit.reading-facts-v1+json-seq` in addition to the old `application/json-seq` on its private, service-authenticated complete journal read. This reduces transport of identical leading context message descriptors, not the available facts. Only whole byte-identical leading JSON elements in the immediately previous context of this read can be referenced; all metadata and divergent suffixes remain in the stream. The Session reconstructs every logical event, checks sequence/identity and the terminal count/permissions, then uses the ordinary reducer. Older Kernels return the full stream or envelope. There is no persistent materialized index and no new public journal route.
