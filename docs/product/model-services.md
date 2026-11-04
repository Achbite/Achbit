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

TUI `/model` or `/connection` opens selection; `/model PROFILE_ID` selects directly. For DeepSeek setup, see the [DeepSeek setup guide](deepseek.md).

## Configure through the CLI

The configuration CLI uses Host execution under the current permission policy. The `achbit.product-operations` component supplies its executable and `hostDataDirectory` in the active Shell tool after the product or iteration Skill is selected or read. Both paths follow Host permissions. If the session disables Host execution, this CLI is unavailable in that session. `--host-data-dir` attaches to that existing Host and never starts another instance. It overrides inherited ACHBIT_API_URL/ACHBIT_PORT and selects the actual Host data directory even when Shell HOME is task-local. `ACHBIT_USER_ROOT` remains the way to start/select an independent instance outside a task.

```sh
"/absolute/path/achbit-cli" --host-data-dir "/actual/instance/data" instance
achbit-cli services
achbit-cli connections list
achbit-cli models list
achbit-cli connections set --input connection.json --api-key-file /absolute/path/api-key
achbit-cli models set --input profile.json
achbit-cli models default PROFILE_ID
achbit-cli models probe PROFILE_ID
```

`achbit-cli --help` and `achbit-cli models --help` show commands and input shapes without connecting to a Host. Apply the same `--host-data-dir` to subsequent commands when using a task Shell. `instance` reports the connected process, API address and actual config/data/profile/secret paths without secret contents. `services` lists installed service plugins and their current status, endpoint and state directory; `plugin.search` searches callable tools and is not this service inventory.

`connection.json` is `{ "connection": { "id": "local-web", "name": "Local Web", "adapterId": "custom", "billingMode": "metered", "baseUrl": "http://127.0.0.1:17632/v1", "credentialKind": "apiKey" } }`. Use the actual endpoint returned by `services`. Optional `profile` in the same file creates the first profile atomically with a new connection. Updating an existing connection preserves its credential unless `--api-key-file` is supplied; adapter and authentication kind follow the Host's existing edit rules.

`profile.json` contains one full profile object, for example `{ "id": "local-web-chat", "connectionId": "local-web", "name": "Local Web Chat", "model": "MODEL_ID_FROM_SERVICE", "kind": "openaiCompatible", "providerFlavor": "openai", "enabled": true, "contextWindowTokens": 128000, "maxOutputTokens": 16000, "imageInput": false }`. Choose protocol, limits and capabilities supported by the service; the numbers here are examples, not detected limits. `models set` creates or replaces that profile by ID. `connections remove ID` and `models remove ID` use the same validation and reference rules as the GUI.

`--input -` reads JSON from a pipe. `--api-key-file -` reads a key from a pipe without echoing it; JSON and key cannot both consume stdin. Keys are stored by the Host, never printed. Saving a key only establishes local configuration. `models probe` makes the same real request as the GUI Test button, prints the original result and exits nonzero on failure. Settings take effect for new runs; an active run retains its snapshot. Do not edit live settings/secrets files to bypass this update path.

## API and Coding Plan selection

Choose **API connection** or **Coding Plan** directly in Models & services. The connection form also lets you switch between these modes. Select the service and region, enter its key (or sign in when account authentication is supported), and choose the first model before creating the connection. Models remain editable afterward. GUI, TUI and CLI share the saved connection and model list.

| Service | API | Coding Plan | Authentication / protocol |
| --- | --- | --- | --- |
| OpenAI / Codex | OpenAI API | Codex | API Key / browser or device-code login; Responses |
| Anthropic Claude | Claude API | No direct subscription login supplied | API Key; Messages |
| Google Gemini | Gemini API | No Google account subscription login supplied | API Key; OpenAI-compatible Chat Completions |
| DeepSeek | DeepSeek API | — | API Key; Responses, Chat Completions or Messages |
| GLM / Z.ai | China and global API | China and global Coding Plan | Separate plan keys and endpoints; Chat Completions |
| Moonshot / Kimi | Moonshot API (Chat Completions) | Kimi Code China and global | Separate plan keys and endpoints; Code supports Responses, Chat Completions and Messages |
| MiniMax | China and global API | China Token Plan and global M / Coding Plan | API Key or Subscription Key; Messages |
| Alibaba Cloud | DashScope API | Coding Plan and Token Plan | Dedicated plan key and endpoint; Chat Completions |
| Volcengine | Ark API | Coding Plan | Dedicated plan key and endpoint; Chat Completions |
| OpenRouter, xAI, Mistral, Groq, SiliconFlow | API presets | — | API Key; Chat Completions |
| Ollama | Local service | — | No key; Ollama protocol |
| Custom | Editable endpoint | — | API Key; Responses, Chat Completions or Messages |

Plan billing does not imply OAuth. API-key plans never enter the Codex login flow. Choose a key and endpoint from the same provider, region and plan. Provider tool eligibility and account permissions still apply; this client does not impersonate another coding tool. Claude, Cursor, GitHub Copilot and Google consumer subscriptions are not interchangeable API credentials and are not advertised as direct subscription integrations here.

Templates are starting configurations, not a live model inventory. Enter the model ID your account offers when no model is prefilled. Selecting a preset while adding a model applies its protocol, context, output budget, image support and thinking defaults together. Existing saved profiles are not rewritten when templates change. Account and plan limits may be lower than a model's full context capacity; adjust the context and output budget accordingly. Kimi and MiniMax presets use an editable 32K output budget, not a claimed server maximum. Templates without verified model specifications retain a conservative 128K context and 16K output budget.

- OpenAI API and Codex presets include GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra and GPT-6 Luna, using Responses for reasoning with tools. Codex's Sol preset uses its 500K default context. Astra and Sol require thinking; Terra and Luna allow disabling it. Temperature is omitted while GPT-6 reasoning is enabled.
- GLM-5.3 is available in the China/global API and Coding Plan entries, with text input, 1M context, and `low` / `high` / `max` effort. Thinking cannot be disabled. The dedicated plan endpoints remain separate from API endpoints.
- Kimi Code includes `k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `k3-256k`, `kimi-for-coding` (K2.8 Preview), and `kimi-for-coding-highspeed` (K2.7 Code Highspeed). New presets use native Responses and support images. K3.1 Pro requires thinking; the K3 and K2 Code variants route to K2.8 Preview without thinking when disabled. K2.7 Code Highspeed has no adjustable effort. Higher-tier plans are required for some models and 1M contexts. The metered API retains its separate `kimi-k3` model ID.
- MiniMax API and plan entries include M3.1 Flash and M3 with image input and 1M context. Messages sends adaptive thinking; M3.1 Flash requires thinking.

Thinking and effort selectors show the supported choices for these models. An incompatible saved selection remains visible with a warning until you change it. Title generation uses low effort for models that require thinking. The **Test** button sends a real short request and reports its error unchanged. Protocol tests do not prove account access, quota or every model-specific feature.

Codex exposes a provider quota snapshot. Other plan presets show recorded request/token usage; absence of a quota API is not a zero balance. Plan usage does not display a made-up per-token bill. Gemini tool-call thought signatures are retained through the journal and sent back on subsequent Chat Completions requests.

Model references (checked 2026-10-30): [OpenAI models](https://developers.openai.com/codex/models), [GPT-6 parameters](https://developers.openai.com/api/docs/guides/latest-model), [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3), [Kimi Code models](https://www.kimi.com/code/docs/en/kimi-code/models.html), [MiniMax models](https://platform.minimax.io/docs/guides/text-generation).

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
achbit-cli usage          # all connections, last 30 days
achbit-cli usage all 7    # all connections, last 7 days
achbit-cli usage my-connection 7
```

The syntax is `usage [connection-id|all] [days]`. Both arguments are positional: put the connection ID or `all` before the number of days. Days defaults to 30 and accepts integers from 1 to 366; `days=7` and `--days 7` are not supported forms.

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

## Task tool selection

**Settings → Agent behavior → Minimal mode** (`agent.minimalMode`, off by default) selects a coding context for new conversations without an explicit recipe. The model sees `read`, `bash` (or `powershell`), `edit`, and `write`. Reads use one-based `offset` and `limit`. Shell commands run in the foreground and return command output or an error. The shared Loop executes the requested tools, returns their results, and settles when the model answers and no new user input is pending. The preset admits only the Plan publication control. It stays out of ordinary allow-mode requests. An explicit `/plan` turn exposes reading and publication until confirmation, then restores editing and verification within the approved scope. An explicit recipe with controls disabled still rejects manual Plan. The preset installs no context compactor, optional product prompt contributions, managed process control or background title generator. Kernel permissions and command rules still apply. Project and session working directories keep their existing lifecycles.

A recipe can combine the `coding` context with the `standard` controls, `summary` compaction or installed tools. The coding reader returns PNG, JPEG, GIF and WebP files to image-capable models through the existing one-request visual input channel. Each component contributes to the same Loop. Existing sessions retain their recorded tool aliases and model history.

A Session recipe may select `tools.kernel` (canonical Kernel tool names), `tools.controls` (Session controls), and `tools.plugins` (whether extension activation is part of this task). Omitted groups keep the inherited selection; an empty array installs none. A child may narrow this selection but cannot expand its parent's tools or plugin access. This selection does not grant filesystem, process or external permissions.

A recipe can select an independent list of Host-installed `productComponents`. Achbit installs `achbit.collaboration` (progress and communication), `achbit.work-method`, `achbit.verification`, `achbit.delivery`, and `achbit.rich-replies` (inline diagrams) as prompt contributions. `achbit.product-operations` contributes product paths to the Shell declaration when the corresponding Skill is in use. `achbit.conversation-title` enables the separate background model request for naming new conversations. It adds no model instruction or tool. The standard product enables these components by default except `achbit.rich-replies`, which is opt-in. Inline diagram instructions can also be read on demand from the documents Skill. Ordinary coding requests receive the common reply format, guidance for the callable basic tools under their actual names, and the detected execution environment. Manual Plan adds its own stage contribution before publication and after confirmation. A recipe with `tools.plugins: false` defaults to none. An explicit list overrides these defaults independently of the tool selection. For example, `"productComponents": ["achbit.rich-replies"]` enables diagram guidance alone. `"productComponents": []` leaves only the coding core and applicable capability instructions. Child recipes inherit an explicit selection unless they supply another.

Ordinary requests project the current tool contracts directly. Run status, wait queues, timers, unpaired progress snapshots, and tool catalog changes stay in the journal. Actual user decisions and the results of requested operations are preserved.

The Host installs product contributions in the Session configuration registry. The Session freezes their selected text in the run snapshot and continues to compose the same stage-specific tool contracts and journal. Internal compaction uses the shared prefix and accepts only text. The Host checks the creation recipe before scheduling a model-generated title. Ordinary first-message and manual titles use the catalog directly.

The built-in `analysis` preset selects `{"kernel":["fs.read"],"controls":[],"plugins":false}`. Give it a reading task and exact file references. Use `collaboration` when the work needs editing, messaging or other installed capabilities; explicit task selections can narrow that preset as well. `fs.read` does not search unknown paths.

Kernel prepares only the selected callable bindings. Session sends those tools, the task, relevant file addresses and active usage guidance to the model. Unstarted modules, disabled tools, plugin registration lists and internal policy/runtime configuration remain diagnostic facts, not model instructions. Enabled delegation retains proactive delegation guidance. Managed process activity and plugin activation are optional Session contributions over the same Loop and journal; container and other extension tools use the existing Kernel catalog disposal lifecycle.
