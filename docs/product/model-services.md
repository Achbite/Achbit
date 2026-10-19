# Connections, models and usage

Settings → Models & services groups **API connections** and **Coding Plans**. A connection owns its endpoint and credential reference; model profiles point to it and retain independent model and context settings. Connection details open directly into configuration. For an existing model, switches and selections save immediately, and numeric fields save on Enter. Text edits and new model/connection creation retain an explicit save/create action. Updating a choice does not submit unconfirmed text or remount the model editor; saving one model leaves the others intact. The model last used for a submitted task remains the default for new conversations. Reasoning effort is chosen in the conversation selector and remembered per model; new conversations inherit that choice. A running request keeps its captured connection/model configuration.

The execution approval model has separate provider/model and reasoning selections. Leaving the model blank uses the conversation model; leaving reasoning blank uses that model's captured effort. The review runs with independent, compact context and the selected model's configured output budget. Saved changes apply to the next run. It reviews execution access, not Plan confirmations or user questions. Chrome review receives matching recorded page and element facts from structured snapshots, including all UIDs referenced by the prepared operation. These facts supplement the existing review context; they neither authorize the action nor guarantee an allow decision. The standard effort choices are low, medium, high, xhigh and max; provider-specific choices follow the adapter's supported settings.

Coding Plan is a service category. The first adapter is OpenAI Codex. DeepCode implements browser PKCE and device-code authentication through the Host, independent of an installed Codex CLI. Credentials stay in the existing local secret store. The GUI receives account labels and flow state; cancelling or leaving authentication releases the flow. Logout removes that connection's credential and cancels its login. Requests use the subscription's dedicated Responses transport, while API keys use the API connection's endpoint.

Codex requests use the existing Session ID as their stable `session-id` header and `prompt_cache_key`. The Provider runtime retains the first `x-codex-turn-state` returned during a run and sends it with subsequent requests, including retries. This routing state is separate for approval reviews and is released with the run; it does not create another conversation history or change earlier input. These Codex conventions are not sent to ordinary API connections. Cache availability remains a provider fact, not a guaranteed hit rate.

Ordinary turns append messages and tool results. Background process updates append snapshots at model-request boundaries rather than rewriting the original tool result. Plugin activation changes the supplied tool catalog and can reduce prefix reuse; a new screenshot also adds uncached input. A conversation's total cache ratio therefore need not match its last request's ratio. The GUI total adds the current session and all descendant Agent sessions, including closed members, with each session counted once across repeated tasks. It divides accumulated cached input tokens by accumulated input tokens. Current-context estimates remain scoped to the last settled Agent request; own-session usage and cost reports retain their separate scopes. Missing usage remains unavailable or partial.

`/focus <task>` summarizes prior work before starting the supplied task. The summary request shares the conversation composer, retains current tool definitions, and appends its summarization instruction. Session rejects any tool call without executing it or committing a checkpoint. For DeepSeek Responses summaries containing only function tools, the transport keeps automatic tool selection: `tool_choice: none` changes the provider's input rendering and breaks reuse of the normal conversation prefix. Codex, other adapters and summaries containing hosted tools retain API-side prohibition with `tool_choice: none` (Anthropic uses its object form). Approval reviews retain an empty tool catalog. An adapter that cannot prohibit calls with retained definitions reports an error; the Ollama adapter currently has that limitation. Only a successful summary commits a context checkpoint. Later Agent requests use the checkpoint and subsequent facts, while the original journal remains available. Compression changes the prefix by design; continuing from the smaller context can build cache reuse again.

## Context management

Settings > Agent behavior controls automatic compaction. It is **off by default**, with a configurable **500000-token** soft threshold. The switch saves immediately; confirm the numeric threshold with Enter rather than a separate Save button. Settings are captured for the next run. The threshold counts estimated current input, including cached tokens and schemas, not accumulated billing usage. Automatic checks run before a new run's first Agent request and at task completion with no pending input, questions or child work; they do not interrupt a task merely because it passes the threshold. Capacity-pressure compaction remains active and reserves output space. The shared summary path above also applies to automatic and parent-requested compaction, including adapter restrictions, recorded usage and error behavior. The original journal remains readable through `session.read`; check excerpt truncation rather than assuming every call returns an entire historical record.

### Child context configuration

Call `agent` with `action: "models"` for the available operation and contribution schemas. Creating a child requires no context-specific arguments: its context budget and compaction rules inherit from the parent's effective run configuration. The child receives the assigned task, not the parent's conversation history. Retained instances keep their captured rules on later assignments. Where full configuration is enabled, the following overrides are optional, and unspecified parameters retain inherited values:

- `context: {id: "journal", parameters: {maxTokens: ...}}`: context budget including output reserve. The effective budget cannot exceed the selected model's window and must leave room for its configured output.
- `loop.compaction: {id: "summary", parameters: {...}}`: `enabled` controls automatic task-boundary management; `thresholdTokens` sets its positive-integer soft threshold. `pressureRatio` optionally starts capacity-pressure compaction at a fraction of the effective context budget (greater than zero and at most one; default one).
- Turning `enabled` off does not disable capacity-pressure compaction. There is no requirement to override either contribution or to match a prescribed child size.

For example, only when a smaller child context is useful:

```json
{
  "action": "spawn",
  "name": "Review",
  "task": "Review the selected module and report concrete findings.",
  "delivery": "async",
  "context": {"id": "journal", "parameters": {"maxTokens": 200000}},
  "loop": {"compaction": {"id": "summary", "parameters": {"enabled": true, "thresholdTokens": 100000}}}
}
```

To request compaction of an existing child, use its returned exact ID:

```json
{"action": "compact", "agentId": "<returned child session ID>", "focus": "Preserve unresolved findings and their evidence references."}
```

`focus` is optional. The result reports a `compactionId`, `status: "scheduled"` and `boundary: "nextModelBoundary"` or `"nextRun"`. Session waits for the child's current model/tool work and required decisions; an idle child's request stays in its journal until it receives another task. This action does not launch work or grant permissions and remains a management operation when new delegation is disabled. Only a later successful checkpoint establishes completed compaction. Use current file/tool reads for present state; `session.read` retrieves historical evidence.

## Quota

Quota is a timestamped response from the provider, not an estimate from local tokens. Its windows retain the supplied reset time and used percentage. A failed refresh displays its error. Subscription fees and subscription usage are not counted as metered API cost.

## DeepSeek

For model defaults, search configuration, installation and first tasks, use the [English](deepseek.md) or [简体中文](deepseek.zh-CN.md) DeepSeek guide.

## Web search citations

For OpenAI API and Codex subscription Responses connections with hosted web search enabled, requests include the search source list. Native search actions and message annotations remain in the Provider record and Session journal. A search source list alone does not associate an internal citation ID with a particular URL.

Session derives one display text for CLI, TUI and GUI. When the Provider supplies a valid URL citation covering an internal citation marker, the display uses a clickable Markdown link. Ordinary Markdown links and local source-file links remain unchanged. An unresolved marker appears as `[?]` with a missing-source notice; DeepCode does not guess its URL. During streaming, text from an internal citation marker onward waits for the final annotations so terminals do not print identifiers that would need to be rewritten. Original response text remains available in the conversation data for inspection.

The GUI copy action copies the displayed answer. A stored response with no citation mapping cannot acquire that mapping from a display update; a fresh search is needed to obtain the missing sources.

## Usage

The default interval is **the last 30 days**, including today and the previous 29 local dates. The daily chart can drill into hourly usage; today and seven-day ranges are also available. It is not a calendar-month report.

The Host indexes physical Provider calls with connection, model, Session, run and attempt attribution. Repeated stream observations update one call, including usage reported before interruption. Missing usage and unrecognized prices remain unavailable or partial. The report includes its recording start; earlier dates are not fabricated as zero consumption. This is a reporting index, not another Session journal or reducer.

The bundled price catalog covers the configured OpenAI and DeepSeek API models at their official HTTPS endpoints. Rates and source URLs are recorded in `config/defaults/model-prices.json`. Each call keeps the applicable price snapshot, returned model, service tier and long-context rule. DeepSeek peak/off-peak rates use the physical request's start time in UTC; later price changes do not reprice recorded calls. Unknown model rates, nonofficial endpoints and adapters without a price entry remain unpriced. They still expose the tokens and calls reported by the provider.

Unknown cache-write usage does not silently become zero. The display is a local estimate of model tokens, not an account invoice; it excludes additional provider tool charges, taxes and subscription fees.

Responses usage preserves `input_tokens_details.cache_write_tokens` when supplied, including an explicit zero. Missing values remain unknown. Request archives retain the wire body and whether a Codex turn-state token was sent or received; they do not retain authentication headers or the opaque routing token.

The usage widget and cost details share a display currency preference. USD is the default; CNY estimates use a fixed rate of 1 USD = 7 CNY. The context menu opens a small widget settings dialog. Original usage records remain in USD.

Session cost details are optional via `settings.usage.panel` and the read-only usage port. Core Session token/context indicators remain available. See [UI plugins](ui-plugins.md).

## CLI and TUI

```sh
deepcode-cli connections
deepcode-cli auth login openai-codex browser
deepcode-cli auth login <connection-id> device
deepcode-cli auth status
deepcode-cli auth logout <connection-id>
deepcode-cli quota <connection-id>
deepcode-cli usage all 30
deepcode-cli --model <profile-id> ask "Explain this code."
```

CLI usage ranges use UTC dates explicitly. GUI queries send the local IANA timezone. TUI `/model` or `/connection` opens connection selection, then its enabled models. Arrow keys move, Enter selects, and Escape returns. `/model <profile-id>` selects directly. The shared Host owns configuration and authentication for both shells.

## Image attachments

Attach PNG, JPEG, WebP or GIF through the existing Files and folders control, or use CLI `--file`. The Host records a reference to the original file. Session carries its image reference alongside the message; the Provider boundary reads that file and encodes it as Responses `input_image`, Chat Completions `image_url`, Anthropic image blocks or Ollama images. The journal retains references, not base64 payloads. Attaching an image does not add its directory to the task's working directories or grant tools access to the file or its parent directory.

Attachment pixels enter one successful Agent request; retries of that logical request retain the same images. Later requests carry archived references instead of repeatedly appending old image bytes. The Agent can explicitly reopen exact images with `session.read` for another look or comparison. Supplemental images wait for a successful request that actually includes them. This lifecycle also applies to GUI observations and does not delete source files or archived tool images.

Built-in presets declare image input when the model supports it. Other/custom models can explicitly enable it under the model's advanced settings when supported by the service. An unsupported model reports an error instead of silently receiving filenames as images. The current local image read limit is 8 MiB per image. The request size limit includes the encoded image data.

Available service adapters are listed in Models and services. Display plugins can customize the supported settings panels; they do not add model transport or execution permissions.
