# Connections, models and usage

## Configure a model

Settings → Models & services contains API connections and Coding Plans. A connection owns the endpoint and credential; profiles select its model, context window, output budget and capabilities. Text edits/new entries need Save/Create; switches save immediately and numeric fields commit with Enter. A run keeps its captured configuration.

The last profile used for a submitted task becomes the new-conversation default. Reasoning effort is selected in the conversation picker and remembered per model. The execution approval model has separate settings; an empty selection uses the run's model in an independent review context. It reviews an execution request, not a Plan or user question.

Codex Coding Plan supports browser or device authentication through the Host, without requiring an installed Codex CLI. Credentials stay in the local secret store. Login is a user action; do not copy credentials between ordinary and Debug instances without authorization.

```sh
achbit-cli connections
achbit-cli auth login openai-codex browser
achbit-cli auth login CONNECTION_ID device
achbit-cli auth status
achbit-cli auth logout CONNECTION_ID
achbit-cli quota CONNECTION_ID
achbit-cli --model PROFILE_ID ask "Explain this code."
```

TUI `/model` or `/connection` opens selection; `/model PROFILE_ID` selects directly. For DeepSeek setup, see the [English](deepseek.md) or [Chinese](deepseek.zh-CN.md) guide.

## API and Coding Plan selection

Choose **API connection** or **Coding Plan** directly in Models & services. The connection form also lets you switch between these modes. Select the service and region, enter its key (or sign in when account authentication is supported), and choose the first model before creating the connection. Models remain editable afterward. GUI, TUI and CLI share the saved connection and model list.

| Service | API | Coding Plan | Authentication / protocol |
| --- | --- | --- | --- |
| OpenAI / Codex | OpenAI API | Codex | API Key / browser or device-code login; Responses |
| Anthropic Claude | Claude API | No direct subscription login supplied | API Key; Messages |
| Google Gemini | Gemini API | No Google account subscription login supplied | API Key; OpenAI-compatible Chat Completions |
| DeepSeek | DeepSeek API | — | API Key; Responses, Chat Completions or Messages |
| GLM / Z.ai | China and global API | China and global Coding Plan | Separate plan keys and endpoints; Chat Completions |
| Moonshot / Kimi | Moonshot API | Kimi Code China and global | Separate plan keys and endpoints; Chat Completions |
| MiniMax | China and global API | China Token Plan and global M / Coding Plan | API Key or Subscription Key; Messages |
| Alibaba Cloud | DashScope API | Coding Plan and Token Plan | Dedicated plan key and endpoint; Chat Completions |
| Volcengine | Ark API | Coding Plan | Dedicated plan key and endpoint; Chat Completions |
| OpenRouter, xAI, Mistral, Groq, SiliconFlow | API presets | — | API Key; Chat Completions |
| Ollama | Local service | — | No key; Ollama protocol |
| Custom | Editable endpoint | — | API Key; Responses, Chat Completions or Messages |

Plan billing does not imply OAuth. API-key plans never enter the Codex login flow. Choose a key and endpoint from the same provider, region and plan. Provider tool eligibility and account permissions still apply; this client does not impersonate another coding tool. Claude, Cursor, GitHub Copilot and Google consumer subscriptions are not interchangeable API credentials and are not advertised as direct subscription integrations here.

Templates are starting configurations, not a live model inventory. Enter the model ID your account offers when no model is prefilled. Newly added presets start with a conservative 128,000-token context and 16,000-token output budget; adjust these to the model and plan limits. Image input must be enabled for a model that supports it. The **Test** button sends a real short request and reports its error unchanged. Protocol tests do not prove account access, quota or every model-specific feature.

Codex exposes a provider quota snapshot. Other plan presets show recorded request/token usage; absence of a quota API is not a zero balance. Plan usage does not display a made-up per-token bill. Gemini tool-call thought signatures are retained through the journal and sent back on subsequent Chat Completions requests.

Endpoint references (checked 2026-10-23): [GLM](https://docs.bigmodel.cn/cn/coding-plan/quick-start), [Z.ai](https://zcode.z.ai/en/docs/configuration), [Kimi Code](https://www.kimi.com/code/docs/en/), [MiniMax Global](https://platform.minimax.io/docs/m-plan/other-tools), [MiniMax China](https://platform.minimax.cn/docs/api-reference/text-anthropic-api), [Alibaba Cloud](https://help.aliyun.com/en/model-studio/base-url), [Volcengine](https://docs.volcengine.com/docs/ark/coding-plan-personal-faq?lang=zh), [Gemini](https://ai.google.dev/gemini-api/docs/openai), [Claude API](https://platform.claude.com/docs/en/api/overview).

## Context management

- `/focus <task>` summarizes previous work before continuing. A failed summary does not replace history; compaction cannot execute tools.
- Settings → Agent behavior: `agent.contextManagement.enabled` defaults to off; `agent.contextManagement.thresholdTokens` defaults to `500000`. The threshold measures estimated next input, not cumulative billing tokens.
- Automatic checks occur at task boundaries, not on every turn past the soft threshold. Capacity-pressure compaction still applies when automatic management is off and reserves output space.
- Compaction changes the context prefix and may reduce cache reuse. Original history remains queryable through `session.read`. Ollama currently cannot use the retained-tool-definition summary path.

### Child context configuration

Read `agent` → `models` for current schemas. Children inherit context/compaction defaults; no override is required. A child receives its assigned context, not the full parent conversation.

For the main conversation, optional overrides are `context: {id:"journal", parameters:{maxTokens:...}}` and `loop.compaction: {id:"summary", parameters:{enabled:..., thresholdTokens:..., pressureRatio:...}}`. Budget must fit the model window and output reserve; `pressureRatio` is greater than zero and at most one. Disabling automatic management does not disable pressure compaction.

For an existing child:

```json
{"action":"compact","agentId":"RETURNED_CHILD_ID","focus":"Preserve unresolved findings and evidence."}
```

This schedules compaction at a safe boundary; it does not launch an idle task or answer a pending decision. A scheduled receipt is not completion.

## Usage

```sh
achbit-cli usage all 30
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
