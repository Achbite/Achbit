[English](deepseek.md) | [简体中文](deepseek.zh-CN.md) · [DeepCode](../../README.md)

# Use DeepSeek with DeepCode (Achbite)

[DeepCode](https://github.com/Achbite/DeepCode) is an MIT-licensed, local-first coding agent with GUI, TUI, and CLI interfaces. This guide connects **DeepSeek V4.1 Flash** through the **Responses API** to read a project, run tools, and continue the conversation.

## 1. Install and open DeepCode

Download a package offered for your platform from [DeepCode Releases](https://github.com/Achbite/DeepCode/releases). Read that release's platform notes before choosing an installer or portable archive.

| Platform | Open the GUI | Portable terminal launchers |
| --- | --- | --- |
| macOS Apple Silicon | Install the PKG and open `/Applications/DeepCode-GUI.app`, or open `DeepCode-GUI.app` in the extracted archive. | `./DeepCode-CLI.command`, `./DeepCode-TUI.command` |
| Windows x64 | Install Windows Setup and use the Start menu, or open the portable `DeepCode-GUI.exe`. | `.\deepcode-cli.bat`, `.\deepcode-tui.bat` |
| Linux x64 / ARM64 | Extract the matching archive and run `./DeepCode-GUI`. | `./deepcode-cli`, `./deepcode-tui` |

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

Run `exit` after a successful build. **Back on the host**, open the GUI or terminal launcher from that output directory; for example, `open bin/macos-arm64/DeepCode-GUI.app` on macOS. Open Windows outputs from Windows, not inside the Linux build container. See [build details](../../README.md#build-from-source) for all launch commands.

## 2. Save a DeepSeek connection and model

Get an API key from the [DeepSeek Platform](https://platform.deepseek.com/).

1. Open **Settings → Models & services → API connections**.
2. Open the existing **DeepSeek** connection. If absent, choose **Add connection → API connection** and select **DeepSeek** as the service.
3. Set the API address to `https://api.deepseek.com`, enter your API key, and save.
4. Open its model, or choose **Add model**, enter these settings, and click **Save model**:

| Setting | Value |
| --- | --- |
| Display name | `DeepSeek V4.1 Flash` |
| Model | `deepseek-flash` |
| API protocol | Responses API |
| Context window | `1000000` |
| Maximum output | `384000` |
| More options → Thinking | Enabled |
| More options → Reasoning effort | `max` |
| Web search | Off |

Use `deepseek-flash` as the API model name, following the [current DeepSeek model documentation](https://api-docs.deepseek.com/quick_start/pricing/). `DeepSeek V4.1 Flash` is the display label. Some integration examples still use `deepseek-v4-flash`; use the current API name above for this setup.

DeepSeek documents a **1M-token context window** and **up to 384K output tokens**. The settings above are DeepCode's token budgets. Context includes both input and generated output, and a maximum output budget does not request that many output tokens. Keep Thinking enabled and explicitly save `max`; the built-in preset does not itself fix the effort to `max`. See [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/).

For `deepseek-flash`, the [Responses API](https://api-docs.deepseek.com/guides/responses_api/) ignores the built-in `web_search` tool, so leave it off in this Flash setup. The same API documents server-side web search for `deepseek-v4-pro`; that is a different model path. Separately configured web-search tools have their own availability.

![DeepCode model editor with DeepSeek V4.1 Flash, Responses API, and Max saved](../../assets/readme/deepseek-settings-en.png)

*The saved settings in the macOS GUI. The screenshot contains no API key.*

The model editor's **Test** action sends a short connection probe and uses API quota. A successful probe confirms that request; continue with a real task below.

## 3. Run a first task, then continue

Select your project folder and the saved DeepSeek model in the conversation's model selector. Select **`max`** there as well: an explicit conversation effort takes precedence over the model profile, and DeepCode remembers that choice for the model.

Send:

> Read this project's README and explain its purpose, entry points, and how to run it. Cite the files you actually read. Do not modify files.

Then send a second message in the same conversation:

> Read one source file related to the entry point you identified. Explain how it connects to the README, with a short code excerpt and a table. Do not modify files.

Review any access requests shown by DeepCode. The execution history shows which tools ran and what they returned. Keep the same conversation for the second message so the agent can use the first task's context.

## 4. Use the connection in CLI or TUI

GUI, CLI, and TUI share saved model connections. After installing with the macOS PKG or Windows Setup, use `deepcode-cli` and `deepcode-tui`; reopen the Windows terminal to load the updated PATH. For portable packages, replace these names with the launchers in the installation table.

```bash
deepcode-cli connections
deepcode-cli --model <profile-id> chat -C /path/to/project
```

Copy `<profile-id>` from the DeepSeek model shown by `connections`. It is the saved DeepCode configuration ID, not the API name `deepseek-flash`. Send both prompts in this CLI chat and use `/quit` when finished.

For TUI:

```bash
deepcode-tui -C /path/to/project
```

Use `/model` to choose the saved DeepSeek model, or `/model <profile-id>` to select it directly. Its saved `max` profile setting applies when the conversation has no explicit effort override. Use `/sessions` and `/resume` to reopen an existing conversation, and `/` to see available commands. See [terminal window and font behavior](../distribution.md).

## References

- [DeepCode models, connections, and usage](model-services.md)
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Current models and prices](https://api-docs.deepseek.com/quick_start/pricing/)
