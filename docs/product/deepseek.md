[English](deepseek.md) | [简体中文](deepseek.zh-CN.md) · [Achbit](https://github.com/Achbite/DeepCode)

# Use DeepSeek with Achbit (Achbite)

[Achbit](https://github.com/Achbite/DeepCode) is an MIT-licensed, local-first coding agent with GUI, TUI, and CLI interfaces. This guide connects **DeepSeek Flash** through the **Responses API** to read a project, run tools, and continue the conversation.

## 1. Install and open Achbit

Download a package offered for your platform from [Achbit Releases](https://github.com/Achbite/DeepCode/releases). Read that release's platform notes before choosing an installer or portable archive.

| Platform | Open the GUI | Portable terminal launchers |
| --- | --- | --- |
| macOS Apple Silicon | Install the PKG and open `/Applications/Achbit.app`, or open `Achbit.app` in the extracted archive. | `./Achbit-CLI.command`, `./Achbit-TUI.command` |
| Windows x64 | Install Windows Setup and use the Start menu, or open the portable `Achbit.exe`. | `.\achbit-cli.bat`, `.\achbit-tui.bat` |
| Linux x64 / ARM64 | Extract the matching archive and run `./Achbit`. | `./achbit-cli`, `./achbit-tui` |

Packages include their runtime. Windows portable packages require WebView2; Linux GUI requires GTK/WebKitGTK. See [installation details](../distribution.md).

For a source build, install Docker and GNU Make; on Windows use WSL2 with Docker integration. macOS packaging also requires Xcode Command Line Tools, the repository's Rust toolchain, and Node.js on the Mac host.

**On the host:**

```bash
git clone --branch main https://github.com/Achbite/DeepCode.git
cd DeepCode
# macOS only, once before packaging; skip on Windows and Linux:
bash scripts/setup-macos-signing.sh
make shell
```

`make shell` builds or updates the development image, creates or reuses the checkout's container, and enters it. On macOS it also starts the native build bridge. **Inside the container**, run the matching command:

| Target | Build command | Output |
| --- | --- | --- |
| macOS Apple Silicon | `bash ./build.sh --stage package-macos` | `bin/macos-arm64/` |
| Windows x64 | `bash ./build.sh --stage package-windows` | `bin/win64/` |
| Linux, matching the container architecture | `bash ./build.sh --stage package-linux` | `bin/linux-x64/` or `bin/linux-arm64/` |

Run `exit` after a successful build. **Back on the host**, open the GUI or terminal launcher from that output directory; for example, `open bin/macos-arm64/Achbit.app` on macOS. Open Windows outputs from Windows, not inside the Linux build container. See [build details](https://github.com/Achbite/DeepCode#build-from-source) for all launch commands.

## 2. Save a DeepSeek connection and model

Get an API key from the [DeepSeek Platform](https://platform.deepseek.com/).

1. Open **Settings → Models & services → API connections**.
2. Open the existing **DeepSeek** connection. If absent, choose **Add connection → API connection** and select **DeepSeek** as the service.
3. Set the API address to `https://api.deepseek.com`, enter your API key, and save.
4. Open its model, or choose **Add model**, enter these settings, and click **Save model**:

| Setting | Value |
| --- | --- |
| Display name | `DeepSeek Flash` |
| Model | `deepseek-flash` |
| API protocol | Responses API |
| Context window | `1000000` |
| Maximum output | `384000` |
| More options → Thinking | Enabled |
| More options → Reasoning effort | `max` |
| More options → Image input | Enabled |
| Web search | Off |

Use `deepseek-flash` as the API model name. DeepSeek's [October 17, 2026 update](https://api-docs.deepseek.com/updates/) routes that name to V4.1 Flash-1017 without changing the API address or model name. `DeepSeek Flash` is the display label.

DeepSeek documents a **1M-token context window** and **up to 384K output tokens**. The settings above are Achbit's token budgets. Context includes both input and generated output, and a maximum output budget does not request that many output tokens. The built-in preset enables Thinking and image input and sets reasoning effort to `max`. Existing saved profiles retain their settings. See [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/).

The model editor's **Web search** option controls the Responses API's built-in tool. Flash [ignores that tool](https://api-docs.deepseek.com/guides/responses_api/), so this preset leaves it off. Achbit's separate `web.search` tool uses the [DeepSeek Search API](https://api-docs.deepseek.com/guides/search/): `POST https://api.deepseek.com/v1/tools/search`. With an official DeepSeek API connection and no explicit search override, it reuses that connection's API key automatically. It returns search results and summaries directly, without an additional model request. Queries support the service's search operators and must contain at most 128 Unicode characters; the tool's result limit remains 1–10. Search calls follow the existing web-access permissions and are billed separately from model tokens; see [pricing](https://api-docs.deepseek.com/quick_start/pricing/).

![Achbit model editor with DeepSeek V4.1 Flash, Responses API, and Max saved](assets/deepseek-settings-en.png)

*The saved settings in the macOS GUI. The screenshot contains no API key.*

The model editor's **Test** action sends a short connection probe and uses API quota. A successful probe confirms that request; continue with a real task below.

## 3. Run a first task, then continue

Select your project folder and the saved DeepSeek model in the conversation's model selector. Select **`max`** there as well: an explicit conversation effort takes precedence over the model profile, and Achbit remembers that choice for the model.

Send:

> Read this project's README and explain its purpose, entry points, and how to run it. Cite the files you actually read. Do not modify files.

Then send a second message in the same conversation:

> Read one source file related to the entry point you identified. Explain how it connects to the README, with a short code excerpt and a table. Do not modify files.

Review any access requests shown by Achbit. The execution history shows which tools ran and what they returned. Keep the same conversation for the second message so the agent can use the first task's context.

## 4. Use the connection in CLI or TUI

GUI, CLI, and TUI share saved model connections. After installing with the macOS PKG or Windows Setup, use `achbit-cli` and `achbit-tui`; reopen the Windows terminal to load the updated PATH. For portable packages, replace these names with the launchers in the installation table.

```bash
achbit-cli connections
achbit-cli --model <profile-id> chat -C /path/to/project
```

Copy `<profile-id>` from the DeepSeek model shown by `connections`. It is the saved Achbit configuration ID, not the API name `deepseek-flash`. Send both prompts in this CLI chat and use `/quit` when finished.

For TUI:

```bash
achbit-tui -C /path/to/project
```

Use `/model` to choose the saved DeepSeek model, or `/model <profile-id>` to select it directly. Its saved `max` profile setting applies when the conversation has no explicit effort override. Use `/sessions` and `/resume` to reopen an existing conversation, and `/` to see available commands. See [terminal window and font behavior](../distribution.md).

Use `/language en-US` or `/language zh-CN` to change the TUI interface language immediately and save the shared preference. Asking the model to answer in English changes its reply, not the interface. You can also start with `achbit-tui --language en-US` to override the saved language for that launch.

## References

- [Achbit models, connections, and usage](model-services.md)
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Current models and prices](https://api-docs.deepseek.com/quick_start/pricing/)
