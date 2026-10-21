# Connections, models and usage

## Configure a model

Settings → Models & services contains API connections and Coding Plans. A connection owns the endpoint and credential; profiles select its model, context window, output budget and capabilities. Text edits/new entries need Save/Create; switches save immediately and numeric fields commit with Enter. A run keeps its captured configuration.

The last profile used for a submitted task becomes the new-conversation default. Reasoning effort is selected in the conversation picker and remembered per model. The execution approval model has separate settings; an empty selection uses the run's model in an independent review context. It reviews an execution request, not a Plan or user question.

Codex Coding Plan supports browser or device authentication through the Host, without requiring an installed Codex CLI. Credentials stay in the local secret store. Login is a user action; do not copy credentials between ordinary and Debug instances without authorization.

```sh
deepcode-cli connections
deepcode-cli auth login openai-codex browser
deepcode-cli auth login CONNECTION_ID device
deepcode-cli auth status
deepcode-cli auth logout CONNECTION_ID
deepcode-cli quota CONNECTION_ID
deepcode-cli --model PROFILE_ID ask "Explain this code."
```

TUI `/model` or `/connection` opens selection; `/model PROFILE_ID` selects directly. For DeepSeek setup, see the [English](deepseek.md) or [Chinese](deepseek.zh-CN.md) guide.

## Context management

- `/focus <task>` summarizes previous work before continuing. A failed summary does not replace history; compaction cannot execute tools.
- Settings → Agent behavior: `agent.contextManagement.enabled` defaults to off; `agent.contextManagement.thresholdTokens` defaults to `500000`. The threshold measures estimated next input, not cumulative billing tokens.
- Automatic checks occur at task boundaries, not on every turn past the soft threshold. Capacity-pressure compaction still applies when automatic management is off and reserves output space.
- Compaction changes the context prefix and may reduce cache reuse. Original history remains queryable through `session.read`. Ollama currently cannot use the retained-tool-definition summary path.

### Child context configuration

Read `agent` → `models` for current schemas. Children inherit context/compaction defaults; no override is required. A child receives its assigned context, not the full parent conversation.

Optional overrides are `context: {id:"journal", parameters:{maxTokens:...}}` and `loop.compaction: {id:"summary", parameters:{enabled:..., thresholdTokens:..., pressureRatio:...}}`. Budget must fit the model window and output reserve; `pressureRatio` is greater than zero and at most one. Disabling automatic management does not disable pressure compaction.

For an existing child:

```json
{"action":"compact","agentId":"RETURNED_CHILD_ID","focus":"Preserve unresolved findings and evidence."}
```

This schedules compaction at a safe boundary; it does not launch an idle task or answer a pending decision. A scheduled receipt is not completion.

## Usage

```sh
deepcode-cli usage all 30
```

The GUI defaults to the last 30 local dates, not a calendar month. CLI date ranges use UTC. Usage records count physical Provider calls, including known retry usage; missing usage or unknown prices remain unavailable/partial, not zero.

| Quantity | Scope |
| --- | --- |
| Cache hit rate | `cacheReadInputTokens / inputTokens`; output tokens are excluded |
| Context indicator | Last settled Agent request |
| GUI total cache indicator | Current Session and descendants, counted once each, including closed members |
| Own-session usage | This Session only; do not add it to a child-inclusive total |
| Quota | Timestamped provider response, not a local token estimate |

Title generation, reviews and compaction may have their own Provider usage. Tool activation, images and compression can change prefix reuse. A low cache ratio alone does not diagnose a Loop failure.

Prices are local per-call estimates from the configured catalog, not invoices. Unknown models/endpoints remain unpriced. Subscription fees and provider tool charges are not included. Stored costs are USD; the optional CNY display uses a fixed 1 USD = 7 CNY estimate. Historical calls retain their price snapshot.

## Diagnose requests

Use `session.read` → `context` with an exact `providerRequestId` for recorded request/usage or review details. Inspect the original attempt/error before retrying. A long request is not evidence that the Loop stopped. The product retries classified transient network failures; protocol errors, tool errors and cancellations are different outcomes.

Hosted search citations need a source-to-URL mapping. An unresolved `[?]` cannot be repaired by inventing a URL; obtain source evidence if needed. Original Provider output remains in the recorded history.

## Image attachments

Attach supported PNG/JPEG/WebP/GIF files through Files and folders or CLI `--file`. The profile must support image input; enable the capability for a custom model only when its service supports it. The local limit is 8 MiB per image; encoded data also counts toward request size.

Pixels enter one successful logical request, including its retries. Later requests carry archived references; reopen exact current-session images with `session.read` → `images` for comparison. A filename, live preview or archived resource alone is not visual evidence. File attachment does not grant access to its parent directory.
