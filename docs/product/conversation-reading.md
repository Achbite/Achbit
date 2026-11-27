# Opening a saved conversation

The desktop reads the selected Session’s ordered timeline in one request. For archived Sessions it also receives the latest individual context-window measurement and the matching partition estimates from the same replay. The same ordered timeline supplies messages, navigation targets, current run controls, model binding and the parent panel’s tasks and outputs. Reading up or down and selecting a distant message operate on this local document. The saved row and its viewport offset belong to the Session’s catalog identity. Opening without a bookmark follows the latest message.

The six most recently visited Sessions retain their desktop reading views in memory. Returning to a settled conversation can present its cached history immediately. Journal changes, a lost Host observation or a replacement Session invalidate the affected cache. A visited history keeps its mounted reading surface alongside that cached projection. Switching back reuses decoded images, expanded content and interactive preview frames. Leaving the cache releases the surface and its resources. A live conversation reconciles against its current snapshot while the visible conversation stays mounted. An ordinary idle send appears in the transcript immediately, even while its first Session is being created. This local row has no journal sequence or message actions. A committed user message from the same Session takes its place by `commandId`; matching text alone is never sufficient. The authenticated command receipt releases the composer, independently of the display read. During a run, supplements appear in the actual queue and enter history only when consumed. Rejection restores the submitted draft or keeps it separately if the user has already typed something else. A display read failure after acceptance is not a failed send.

While preparing a cold conversation, the desktop shows loading until it has the selected projection and model information. Image attachments already occupy their ordered slots. Visible thumbnails and file details load separately. Child outputs with information still outstanding show a loading status in the output panel. Actual read failures retain their source error.

## Markdown text, footnotes and images

Conversation messages and Markdown files use the same emphasis rules: for example, `**标签：**正文` emphasizes the label and colon, not the following text. Each rendered document owns its footnotes, including links back to repeated citations. A question option keeps its paragraphs and image descriptions readable as text; selecting it still submits the option ID.

In a Markdown file, a relative image path starts in that file’s directory. Images are read through the source Session’s existing workspace or directory grant. Picking a single file does not grant access to its neighbors; an archived document without a directory does not borrow the current workspace. Use an explicit image resource or an HTTP(S) URL in those cases.

## Folded Shell results

A completed Shell row displays its command and status immediately. Opening the row loads its captured standard output and error by the original completion event and record identity. Reopening the row reuses the loaded text while the reading view is retained. Failed, cancelled and active operations continue to carry their existing diagnostics. A historical edit that removes the original completion also removes its detail from subsequent reads.

Desktop clients request this representation with `Accept: application/vnd.achbit.desktop-history.v1+json` on the projection endpoint. Ordinary projection reads and exports retain full activities. An installed activity renderer that consumes complete records shares one full projection read for that desktop view.

## Explicit transcript readers

Clients using `POST /api/conversation/sessions/:id/read` with `view: "transcript"` can request the tail or a page around a sequence. The response carries the reading range, adjacent positions, navigation, and the records referenced by its timeline. The last group in a turn carries the file summary. Current controls accompany the latest page. Large turns can split after 24 rows at an independent source group.

## Explicit revision-window clients

A successful `GET /api/conversation/statuses` may include `x-achbit-reading-window: 1`. This advertises support for an explicit revision-bound read. The response body is the status array.

```
POST /api/conversation/sessions/:id/read
{"view":"readingWindow","throughSequence":8898,"limit":12}
```

`throughSequence` is the **current exact revision**, not an upper cutoff into archived history. `limit` is 1–24 rows (default 12). Omit `anchorKey` for the tail, or supply an actual transcript row key for a window containing that row. For messages this is `timeline.streamId ?? message.messageId`, not the timeline ID. `before`, offsets and detail selectors are not supported on this view. Other read views retain their original semantics.

The original read envelope has `sessionId`, `revision`, `view`, `items: []`, `nextBefore: null` and one additional field:

- `readingWindow.kind: "ready"` includes `anchorKey`, zero-based `startIndex`, `totalRows`, `rows` and `navigation: {keys,labels}`. Each row carries `key`, `timelineId`, `sequence`, optional `streamId` and the **complete** canonical `message`. The navigation lists every user row in transcript order. Rendering uses the normal message component; a page is not a complete projection and carries no mutation authority.
- `readingWindow.kind: "requiresProjection"` contains no partial body. Mixed or dependent surfaces, non-completed runs, empty histories and out-of-budget windows use the ordinary projection. The v1 server bounds replies to 256 KiB and at most 4,096 user navigation entries; it never abbreviates the body to meet that budget.
- `conversation_read_revision_changed` requires a fresh current status. `conversation_read_anchor_not_found` denotes a missing named row in a supported timeline. A rejected request, malformed stream, inconsistent lineage, denied read or broken history is not a successful fallback.

A relationship-only journal read can reject a family as ineligible without constructing its transcript. Explicit snapshot reads validate the history and current child state. The Session caches up to two version-checked archive snapshots, regardless of serialized size. An idle snapshot expires after 30 seconds, and an auxiliary child read preserves retained roots. Explicit transcript readers can reuse a split turn and its most recent neighbor while their journal tips match. Both caches live in the Session service process. When retained data changes, the service records entry counts and serialized bytes for each cache in `session-cache.log` in the Host log directory. Byte totals measure retained buffers; process memory also includes working data used to read, decode and display a conversation.

The Session can negotiate `application/vnd.achbit.reading-facts-v1+json-seq` in addition to the old `application/json-seq` on its private, service-authenticated complete journal read. This reduces transport of identical leading context message descriptors, not the available facts. Only whole byte-identical leading JSON elements in the immediately previous context of this read can be referenced; all metadata and divergent suffixes remain in the stream. The Session reconstructs every logical event, checks sequence/identity and the terminal count/permissions, then uses the ordinary reducer. A continuing Actor receives independent nested request records and reuses its single recovered state when it opens; no Provider input is shortened. Older Kernels return the full stream or envelope. The journal remains the durable source. A SQLite index accelerates permission replay at startup.
