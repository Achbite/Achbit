# Connections, models and usage

## Configure a model

Settings → Models & services contains API connections and Coding Plans. A connection owns the endpoint and credential; profiles select its model, context window, output budget and capabilities. In a connection, **Add model** opens its searchable provider catalog. Select a row and confirm, or choose **Custom model** and enter a model ID and display name. Adding a model does not change the new-conversation default. **Save changes** saves pending text and numeric edits together. Enter in a numeric field saves that field; Enter in a text field saves the text edits. Switches and selectors still save immediately without submitting other drafts. A run keeps its captured configuration.

Choose a model and reasoning effort in the conversation picker. Each root conversation remembers its own settings. Explicitly changing its model, effort or subagent settings makes that conversation’s complete selection the default for new conversations. Reading or sending a message in an older conversation, including `/focus`, does not change this default. The execution approval model has separate settings; an empty selection uses the run's model in an independent review context. It reviews an execution request, not a Plan or user question.

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

In the TUI, `/model` or `/connection` opens the terminal picker; `/model PROFILE_ID` selects directly. CLI chat and TUI `/model` select the profile to send with subsequent input in that terminal conversation. Neither this terminal override nor `--model … ask` is an edit to the new-conversation default. To explicitly change the default profile from the CLI, use `models default PROFILE_ID`. For DeepSeek setup, see the [DeepSeek setup guide](deepseek.md).

## Configure through the CLI

The configuration CLI uses Host execution under the current permission policy. The `achbit.product-operations` component supplies its executable and `hostDataDirectory` with the successful built-in file read of operations.md from the installed Product guides directory. These resources remain in the sent conversation history without changing the Shell tool declaration. Both paths follow Host permissions. If the session disables Host execution, this CLI is unavailable in that session. `--host-data-dir` attaches to that existing Host and never starts another instance. It overrides inherited ACHBIT_API_URL/ACHBIT_PORT and selects the actual Host data directory even when Shell HOME is task-local. `ACHBIT_USER_ROOT` remains the way to start/select an independent instance outside a task.

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

`achbit-cli --help` and `achbit-cli models --help` show commands and input shapes without connecting to a Host. The packaged CLI still acquires its installation lease at startup. Submit task Shell calls with `requestHostPermission` and a specific reason, including read-only management queries. Apply the same `--host-data-dir` to subsequent commands. `instance` reports the connected process, API address and actual config/data/profile/secret paths without secret contents. `services` lists installed service plugins and their current status, endpoint and state directory; `plugin.search` searches callable tools and is not this service inventory.

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

- OpenAI API and Codex presets include GPT-6.2 Astra and GPT-6.2 Sol alongside GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra and GPT-6 Luna, using Responses for reasoning with tools. The two 6.2 API presets start at 1,050,000 context tokens and medium effort. Codex 6.2 Astra and Sol start at 272,000 and 500,000 respectively, both at low effort. Direct requests support effort through `max`. Astra and Sol require thinking; Terra and Luna allow disabling it. Temperature is omitted while GPT-6 reasoning is enabled.
- GLM-5.3 is available in the China/global API and Coding Plan entries, with text input, 1M context, and `low` / `high` / `max` effort. Thinking cannot be disabled. The dedicated plan endpoints remain separate from API endpoints.
- Kimi Code includes `k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `k3-256k`, `kimi-for-coding` (K2.8 Preview), and `kimi-for-coding-highspeed` (K2.7 Code Highspeed). New presets use native Responses and support images. K3.1 Pro requires thinking; the K3 and K2 Code variants route to K2.8 Preview without thinking when disabled. K2.7 Code Highspeed has no adjustable effort. Higher-tier plans are required for some models and 1M contexts. The metered Moonshot API offers `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` and `kimi-k3` over Chat Completions.
- Anthropic API offers Claude Fable 5.2 and the Opus, Sonnet and Haiku 5.5 family with adaptive thinking over Messages.
- Gemini API offers 4 Carbon, Argon and Hydrogen over Chat Completions with a 1,048,576-token window and 65,536-token synchronous output limit. Carbon and Argon support low, medium and high effort. Hydrogen also supports xhigh.
- DashScope's metered API offers Qwen4-Max with image input, selectable thinking and low, high or xhigh effort. DeepSeek V4 Pro offers text and tools alongside the existing Flash preset.
- MiniMax API and plan entries include M3.1 Flash and M3 with image input and 1M context. Messages sends adaptive thinking; M3.1 Flash requires thinking.

Thinking and effort selectors show the supported choices for these models. Claude Messages distinguishes adaptive thinking from manual token budgets; an explicitly unsupported effort or disabled-thinking choice fails rather than being lowered. Ollama's known `gpt-oss` models use `low` / `medium` / `high` and cannot disable thinking; other Ollama models retain the boolean control rather than receiving an unsupported level. An incompatible saved selection remains visible with a warning until you change it. Title generation uses low effort for models that require thinking. The **Test** button sends a real short request and reports its error unchanged. Protocol tests do not prove account access, quota or every model-specific feature.

Codex exposes a provider quota snapshot. Other plan presets show recorded request/token usage; absence of a quota API is not a zero balance. Plan usage does not display a made-up per-token bill. Gemini tool-call thought signatures are retained through the journal and sent back on subsequent Chat Completions requests.

Model updates checked 2026-11-19. [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) · [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) · [Claude](https://platform.claude.com/docs/en/models/overview) · [Gemini](https://aistudio.google.com/docs/openai) · [Qwen4-Max](https://help.aliyun.com/zh/model-studio/qwen4-max) · [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing) · [Metered Kimi](https://platform.kimi.ai/docs/models).

Earlier model references (checked 2026-10-30): [OpenAI models](https://developers.openai.com/codex/models), [GPT-6 parameters](https://developers.openai.com/api/docs/guides/latest-model), [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3), [Kimi Code models](https://www.kimi.com/code/docs/en/kimi-code/models.html), [MiniMax models](https://platform.minimax.io/docs/guides/text-generation).

Endpoint references (checked 2026-10-23): [GLM](https://docs.bigmodel.cn/cn/coding-plan/quick-start), [Z.ai](https://zcode.z.ai/en/docs/configuration), [Kimi Code](https://www.kimi.com/code/docs/en/), [MiniMax Global](https://platform.minimax.io/docs/m-plan/other-tools), [MiniMax China](https://platform.minimax.cn/docs/api-reference/text-anthropic-api), [Alibaba Cloud](https://help.aliyun.com/en/model-studio/base-url), [Volcengine](https://docs.volcengine.com/docs/ark/coding-plan-personal-faq?lang=zh), [Gemini](https://ai.google.dev/gemini-api/docs/openai), [Claude API](https://platform.claude.com/docs/en/api/overview).

## Context management

- `/focus <task>` summarizes previous work before continuing. A failed summary does not replace history; compaction cannot execute tools.
- Settings → Agent behavior: `agent.contextManagement.enabled` defaults to off; `agent.contextManagement.thresholdTokens` defaults to `500000`. The threshold measures estimated next input, not cumulative billing tokens.
- Automatic checks occur at task boundaries, not on every turn past the soft threshold. Capacity-pressure compaction still applies when automatic management is off and reserves output space.
- Compaction changes the context prefix and may reduce cache reuse. Original history remains queryable through `session.read`. Ollama currently cannot use the retained-tool-definition summary path.

### Child context configuration

Read `agent` → `models` for current schemas. Children inherit context/compaction defaults; no override is required. A child receives its assigned context, not the full parent conversation.

With **Full configuration** enabled, the main conversation can pass optional overrides to `spawn`: `context: {id:"journal", parameters:{maxTokens:...}}` and `loop.compaction: {id:"summary", parameters:{enabled:..., thresholdTokens:..., pressureRatio:...}}`. `maxTokens` includes the output reserve and is capped by the selected model's context window; leave enough room for input. `pressureRatio` is greater than zero and at most one. Disabling automatic management does not disable pressure compaction.

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
| Models & services → Usage: cache hit | Cached input / input for calls that reported a cache-read count, including explicit zero hits. The selected period, each day and each hour use the same weighted rate. The chart uses compact units on the axis. Hover or focus a day or hour for exact token counts: input cache hits, input cache misses, and output. Input with unknown cache status stays separate from misses. |
| Context indicator | Single-window usage from an Agent request. If the latest response has no single-window measurement (for example, after hosted search), the GUI shows **Last measured** for the same run. Reopening a completed conversation restores that reading from its request history; without a measured request the indicator stays empty. |
| GUI total cache indicator | Current Session and descendants, counted once each, including closed members |
| Own-session usage | This Session only; do not add it to a child-inclusive total |
| Quota | Timestamped provider response, not a local token estimate |

When a Provider reports reasoning output tokens, the request receipt retains them as an optional subset of output tokens. Session totals retain the known subset and its reporting coverage; an absent count is unknown, not zero. Reasoning tokens are not added to total output or charged a second time. Not every Provider supplies this counter.

Title generation, reviews and compaction may have their own Provider usage. Tool activation, images and compression can change prefix reuse. A low cache ratio alone does not diagnose a Loop failure.

Prices are local per-call estimates from the configured catalog, not invoices. Unknown models/endpoints remain unpriced. Subscription fees and provider tool charges are not included. Stored costs are USD; the optional CNY display uses a fixed 1 USD = 7 CNY estimate. Historical calls retain their price snapshot.

## Diagnose requests

Use `session.read` → `context` with an exact `providerRequestId` for recorded request/usage or review details. Inspect the original attempt/error before retrying. A long request is not evidence that the Loop stopped. The Provider transport limits connection setup to 10 seconds and each idle read to 300 seconds, including response headers. Incoming data resets the read wait; there is no total generation deadline. The Session keeps retrying transient network failures and streams closed without a completion marker for the same logical request until recovery or cancellation. Network retry waits increase from one second to at most 60 seconds. For a temporary rate limit with Retry-After, Session waits until the upstream deadline and resends the original model context. Each send retains its error. Session discards partial drafts and preserves completed tool results. An explicit NO_MORE_RETRY ends that run. In the GUI, click Continue once to schedule a successor after the deadline. Stop cancels the scheduled run. Exhausted quota and incomplete output retain their original failure. Protocol errors, tool errors and cancellations remain separate outcomes. CLI waits have no default total deadline; ACHBIT_CLI_RUN_TIMEOUT_MS sets an explicit caller deadline.

Anthropic continuation preserves ordered native text, thinking/signature, redacted-thinking and tool-use blocks in the existing history. Those blocks cannot be replayed through a different protocol. Unsupported native block types or incomplete blocks retain their original protocol failure instead of being discarded. Tool-result error indicators follow recorded terminal outcomes, not interpretation of result text.

Hosted search citations need a source-to-URL mapping. An unresolved `[?]` cannot be repaired by inventing a URL; obtain source evidence if needed. Original Provider output remains in the recorded history.

## Image attachments

Attach supported PNG/JPEG/WebP/GIF files through Files and folders or CLI `--file`. The profile must support image input; enable the capability for a custom model only when its service supports it. Images up to and including 8 MiB keep their original bytes. For pasted and selected static images over 8 MiB and up to 32 MiB, the Host prepares a local copy: it preserves aspect ratio and transparency, caps the long edge at 2048 pixels, and reduces it further only if needed to fit 8 MiB. JPEG stays JPEG; other oversized static formats use PNG. Selected files are never overwritten. Oversized animations are rejected instead of silently dropping frames. Oversized images above 32 megapixels or 16384 pixels on either axis require manual resizing. These are attachment limits, not a change to tool output or the model’s total request budget.

Pixels enter one successful logical request, including its retries. Later requests carry archived references; reopen exact current-session images with `session.read` → `images` for comparison. A filename, live preview or archived resource alone is not visual evidence. File attachment does not grant access to its parent directory.

## Task tool selection

**Settings → Agent behavior → Minimal mode** (`agent.minimalMode`, off by default) selects a coding context for new conversations without an explicit recipe. The model sees `read`, `bash` (or `powershell`), `edit`, and `write`. Reads use one-based `offset` and `limit`. Shell commands run in the foreground and return command output or an error. The shared Loop executes the requested tools, returns their results, and settles when the model answers and no new user input is pending. The preset installs no Session controls or product guidance: `/plan` requires an explicit recipe with Plan controls. It installs no context compactor, managed process control or background title generator. Its standard Loop uses parallel tool batches, with same-file modifications queued in call order; a failed modification does not automatically skip later calls, which still pass their own permission checks. A truncated response with identifiable tool calls executes none of them and returns error results to the model for a new request. Plain-text truncation terminates with its original failure. Transport and rate-limit recovery use the shared Session policy. Kernel permissions and command rules still apply. Project and session working directories keep their existing lifecycles.

A recipe can combine the `coding` context with the `standard` controls, `summary` compaction or installed tools. The coding reader returns PNG, JPEG, GIF and WebP files to image-capable models through the existing one-request visual input channel. Each component contributes to the same Loop. Existing sessions retain their recorded tool aliases and model history.

A Session recipe may select `tools.kernel` (canonical built-in Kernel tool names), `tools.controls` (Session controls), and `tools.plugins` (a boolean allowing extension activation). Omitted groups keep the inherited selection; an empty array installs none. `tools.kernel` does not filter extension tools, and `tools.plugins` is not a per-plugin allowlist. A child may narrow this selection but cannot expand its parent's tools or plugin access. New children do not copy the parent's active plugin selections; discovery and activation remain separate. This selection does not grant filesystem, process or external permissions.

A recipe can select an independent list of Host-installed `productComponents`. Achbit installs `achbit.collaboration` (progress and communication), `achbit.work-method`, `achbit.verification`, `achbit.delivery`, and `achbit.rich-replies` (inline diagrams) as prompt contributions. `achbit.product-operations` attaches product paths to the result of reading the installed operations guide with the built-in file reader. `achbit.conversation-title` enables the separate background model request for naming new conversations. It adds no model instruction or tool. The standard product enables these components by default except `achbit.rich-replies`, which is opt-in. Inline diagram instructions can also be read on demand from the documents Skill. Ordinary coding requests receive the common reply format, guidance for the callable basic tools under their actual names, and the detected execution environment. Manual Plan adds its own stage contribution before publication and after confirmation. A recipe with `tools.plugins: false` defaults to none. An explicit list overrides these defaults independently of the tool selection. For example, `"productComponents": ["achbit.rich-replies"]` enables diagram guidance alone. `"productComponents": []` leaves only the coding core and applicable capability instructions. Child recipes inherit an explicit selection unless they supply another.

Ordinary requests project the current tool contracts directly. Run status, wait queues, timers, unpaired progress snapshots, and tool catalog changes stay in the journal. Actual user decisions and the results of requested operations are preserved.

The Host installs product contributions in the Session configuration registry. The Session freezes their selected text in the run snapshot and continues to compose the same stage-specific tool contracts and journal. Internal compaction uses the shared prefix and accepts only text. The Host checks the creation recipe before scheduling a model-generated title. Ordinary first-message and manual titles use the catalog directly.

The built-in `analysis` preset selects `{"kernel":["fs.read"],"controls":["agent","session"],"plugins":false}`. Give it a reading task and exact file references; it can send findings or questions to its task owner and wait for replies. An assignment, including one to a retained member, identifies the sender but does not grant access to that or any other conversation's history. Share task evidence through readable files or archived resources; only a human input that names a historical session selects it for `session.read`. Use `collaboration` for editing and teamwork with inherited installed capabilities. `fs.read` reads known paths.

A root conversation stores its subagent configuration alongside its model choice. New conversations start with the configuration from the last explicit edit. Sending a message in another conversation does not overwrite this default; that conversation continues to use its own saved selection. Each run freezes that conversation's configuration through later requests and delegation. A delegated child starts with its assigning run’s settings; child model/effort overrides do not write back to the user's new-conversation defaults.

Full subagent configuration is off by default. The model selects a template and an allowed profile. Enabling **Full configuration** (`agent.subagents.allowFullConfiguration`) exposes per-task model effort, context, controls, compaction, tools, capabilities, installed runner, product components, permission policy and sandbox choices to the coordinator through `agent` → `models`. This setting is independent of the **Full access** execution-permission preset. The built-in runner is `standard`; additional runners must already be installed, and recipes do not load executable code. Children retain the parent tool and permission limits. Explicit saved settings are preserved. Configuration catalogs and current contacts stay in discovery results; tool declarations remain stable while task progress changes.

### Task-local teams

With **Full configuration**, the root can use a template unchanged, override it for one `spawn`, or pass `preset: null` to compose a fresh instance. Omission still selects `analysis` for ordinary unscoped callers. Fresh instances inherit permitted components and default to owner messaging, continuation, and no delegation. No choice here edits saved templates.

Give root-created workers `capabilities.messaging: true` and the same `peerGroup` to open a direct channel for this root run. A grouped worker and an ungrouped or differently grouped peer cannot discover or message one another. Their helpers do not join the group. Contact with an actual task owner and management of owned work are separate. Independent `send` operations can accompany ordinary tools in one Provider turn, with at most one `todo.update`. Each delivery still checks the caller's current run, relationship and the destination's availability; it is not an assignment or authorization. Sending to an idle member still does not start a task. Start a new team for a new root run; reassigning an old member retains its recipe, not the old peer channel in a new run.

For example, create the front end with `preset: "collaboration"`, `peerGroup: "orders"`, and `helpers: []`. Spawn the back end with the same group and this additional field (use an actual inherited project `workspaceId` returned by `agent` → `models`):

```json
{"helpers":[{"id":"test-writer","preset":"collaboration","maxCalls":1,"recipe":{"tools":{"kernel":["fs.read","fs.write","fs.edit"],"controls":["agent","session"],"plugins":false},"fileScope":{"workspaceId":"workspace:example","read":["protocol","src"],"write":["tests"]}}}]}
```

Member delegation must be enabled to grant a nonempty `helpers` menu. The worker chooses `preset: "test-writer"` and supplies only a task, name and delivery. Discovery and admission use the same menu; its per-entry budget counts admitted creations for that worker run, including a later failed start. A helper contacts its task owner, not its owner's peers. It cannot create another helper unless its own entry has a nested menu. Existing family-wide capacity limits still apply. Omitting the menu preserves previous template behavior.

`fileScope` is a **ceiling, not a grant**. Paths are files or subtrees relative to one already bound workspace. `.` means its root; `[]` selects no paths. Writes also permit reading the selected targets. A scoped recipe uses only selected built-in file tools and no plugins, Shell or Host tools. Kernel checks the actual resolved target even if a broader Plan exists; inside the ceiling the ordinary permission, Plan, and revocation checks still apply. File paths and workspace bindings are not transferable permission receipts.

Kernel prepares only the selected callable bindings. Session sends those tools, the task, relevant file addresses and active usage guidance to the model. Unstarted modules, disabled tools, plugin registration lists and internal policy/runtime configuration remain diagnostic facts, not model instructions. Enabled delegation retains proactive delegation guidance. Managed process activity and plugin activation are optional Session contributions over the same Loop and journal; container and other extension tools use the existing Kernel catalog disposal lifecycle.
