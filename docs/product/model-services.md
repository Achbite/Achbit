# Connections, models and usage

Settings → Models and services groups **API connections** and **Coding Plans**. A connection owns its endpoint and credential reference; model profiles point to it and retain independent model and context settings. Connection details open directly into configuration. Saving one model leaves the others intact. The model last used for a submitted task remains the default for new conversations. Reasoning effort is chosen in the conversation selector and remembered per model; new conversations inherit that choice. A running request keeps its captured connection/model configuration.

The execution approval model has separate provider/model and reasoning selections. Leaving the model blank uses the conversation model; leaving reasoning blank uses that model's captured effort. The review runs with independent, compact context and the selected model's configured output budget. Saved changes apply to the next run. It reviews execution access, not Plan confirmations or user questions. Chrome review receives matching recorded page and element facts from structured snapshots, including all UIDs referenced by the prepared operation. These facts supplement the existing review context; they neither authorize the action nor guarantee an allow decision. The standard effort choices are low, medium, high, xhigh and max; provider-specific choices follow the adapter's supported settings.

Coding Plan is a service category. The first adapter is OpenAI Codex. DeepCode implements browser PKCE and device-code authentication through the Host, independent of an installed Codex CLI. Credentials stay in the existing local secret store. The GUI receives account labels and flow state; cancelling or leaving authentication releases the flow. Logout removes that connection's credential and cancels its login. Requests use the subscription's dedicated Responses transport, while API keys use the API connection's endpoint.

Codex requests use the existing Session ID as their stable `session-id` header and `prompt_cache_key`. The Provider runtime retains the first `x-codex-turn-state` returned during a run and sends it with subsequent requests, including retries. This routing state is separate for approval reviews and is released with the run; it does not create another conversation history or change earlier input. These Codex conventions are not sent to ordinary API connections. Cache availability remains a provider fact, not a guaranteed hit rate.

Ordinary turns append messages and tool results. Background process updates append snapshots at model-request boundaries rather than rewriting the original tool result. Plugin activation changes the supplied tool catalog and can reduce prefix reuse; a new screenshot also adds uncached input. A conversation's total cache ratio therefore need not match its last request's ratio. The GUI total adds the current session and all descendant Agent sessions, including closed members, with each session counted once across repeated tasks. It divides accumulated cached input tokens by accumulated input tokens. Current-context estimates remain scoped to the last settled Agent request; own-session usage and cost reports retain their separate scopes. Missing usage remains unavailable or partial.

`/focus <task>` summarizes prior work before starting the supplied task. The summary request shares the conversation composer, retains current tool definitions, and appends its summarization instruction. Session rejects any tool call without executing it or committing a checkpoint. For DeepSeek Responses summaries containing only function tools, the transport keeps automatic tool selection: `tool_choice: none` changes the provider's input rendering and breaks reuse of the normal conversation prefix. Codex, other adapters and summaries containing hosted tools retain API-side prohibition with `tool_choice: none` (Anthropic uses its object form). Approval reviews retain an empty tool catalog. An adapter that cannot prohibit calls with retained definitions reports an error; the Ollama adapter currently has that limitation. Only a successful summary commits a context checkpoint. Later Agent requests use the checkpoint and subsequent facts, while the original journal remains available. Compression changes the prefix by design; continuing from the smaller context can build cache reuse again.

Quota is a timestamped response from the provider, not an estimate from local tokens. Its windows retain the supplied reset time and used percentage. A failed refresh displays its error. Subscription fees and subscription usage are not counted as metered API cost.

## DeepSeek

The built-in **DeepSeek V4.1 Flash** preset uses the API model name `deepseek-flash`. Get an API key from the [DeepSeek Platform](https://platform.deepseek.com/) and open **Settings → Models and services → API connections**. Open the existing DeepSeek connection, or choose **Add API connection**, select **DeepSeek**, enter your key, and save the connection. Open its model or choose **Add model**, then save these settings:

| Setting | Value |
| --- | --- |
| API address | `https://api.deepseek.com` |
| Display name | `DeepSeek V4.1 Flash` |
| Model | `deepseek-flash` |
| API protocol | Responses API |
| Context window | `1000000` |
| Maximum output | `384000` |
| More options → Thinking | Enabled |
| More options → Reasoning effort | `max` |

The model's 1M context window and 384K output limit follow the [official model documentation](https://api-docs.deepseek.com/quick_start/pricing/). Context capacity includes the request and generated output; the maximum output is a budget, not a request to generate that many tokens. DeepSeek supports `low`, `high`, and `max` reasoning. Select this model and `max` in the conversation's model selector as well; a conversation's explicit choice takes precedence over its model profile. See [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) for the service's effort settings.

Select a project and ask: “Read this project's README and explain its purpose, entry points, and how to run it. Cite the files you read.” Continue in the same conversation with a request to inspect one relevant source file. Review any access requests shown by DeepCode. The model editor's **Test** action only sends a short connection probe using saved settings; it does not exercise a full Agent task and counts toward API usage.

CLI and TUI reuse the saved connection. For CLI, list the profiles and copy the ID shown under the DeepSeek connection:

```sh
deepcode-cli connections
deepcode-cli --model <profile-id> ask -C /path/to/project "Read the README and explain this project."
deepcode-cli --model <profile-id> chat -C /path/to/project
```

`<profile-id>` is the saved DeepCode configuration ID, not the API model name. Portable packages use the platform's CLI launcher instead of the installed `deepcode-cli` command; see [installation](../distribution.md). In TUI, use `/model` to select the saved model, or `/model <profile-id>` to select it directly.

DeepSeek's [Responses API](https://api-docs.deepseek.com/guides/responses_api/) currently ignores the built-in `web_search` tool. Set **Web search** to **Off** in this model's settings; web-search tools have their own availability and configuration. See the [official pricing page](https://api-docs.deepseek.com/quick_start/pricing/) for current API charges.

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

The built-in DeepSeek V4.1 Flash and GPT-6 Astra presets declare image input. Other/custom models can explicitly enable it under the model's advanced settings when supported by the service. An unsupported model reports an error instead of silently receiving filenames as images. The current local image read limit is 8 MiB per image. The request size limit includes the encoded image data.

Available service adapters are listed in Models and services. Display plugins can customize the supported settings panels; they do not add model transport or execution permissions.
