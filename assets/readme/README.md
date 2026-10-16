# README screenshots

`workspace-en.jpg` and `workspace-zh.jpg` show real GUI tasks using the fictional delivery data in [`examples/delivery-dashboard`](../../examples/delivery-dashboard). They are general product demonstrations, not proof of a particular model connection. The older review images remain available as supporting assets.

The following screenshots were captured on macOS Apple Silicon on 2026-10-17 using the DeepCode 0.6.50 package:

- `tui-task-en.png`: a real DeepSeek task reading this repository's README, with completed file and Bash tools.
- `tui-rendering-zh.png`: a later message in the same conversation, displaying Chinese, English identifiers, a Rust code block, and a Markdown table.
- [`docs/product/assets/deepseek-settings-en.png`](../../docs/product/assets/deepseek-settings-en.png): the actual GUI model editor after saving the DeepSeek configuration.

The TUI images show the native packaged `deepcode-tui` running in a live PTY. Its terminal output was displayed with xterm.js and the packaged DeepCode terminal font, then captured without altering the conversation or tool results. These images demonstrate the TUI output; they do not establish the macOS Terminal app's window or font behavior. The GUI image was captured from the native app.

The TUI header shows the saved profile ID `deepseek-v4-flash-openai`. Actual provider requests used `deepseek-flash`, the Responses API, `reasoning.effort: "max"`, and `max_output_tokens: 384000`. The configuration ID and API model name serve different purposes.

No API keys or credentials are included in these images. See the [English](../../docs/product/deepseek.md) or [简体中文](../../docs/product/deepseek.zh-CN.md) guide to reproduce the connection and task workflow.
