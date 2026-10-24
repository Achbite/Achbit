# README screenshots

`achbit-workspace.png` and `achbit-model-services.png` are unedited viewport captures of the 2026-10-23 macOS Achbit Debug build. They show the AC branding and API / Coding Plan form using the current UI. No account login or provider completion is implied. Older images below retain their original DeepCode branding and are historical demonstrations.

`workspace-en.jpg` and `workspace-zh.jpg` show real GUI tasks using the fictional delivery data in [`examples/delivery-dashboard`](../../examples/delivery-dashboard). They are general product demonstrations, not proof of a particular model connection. The older review images remain available as supporting assets.

`tui-native-zh.png` is the maintainer-provided screenshot of an actual DeepCode terminal window, supplied on 2026-10-17. It shows a completed conversation with Chinese text and mathematical notation. The original pixels are preserved. The screenshot illustrates the rendering at that time, including any literal notation visible in the response; it is not a claim of complete LaTeX support.

The TUI header displays the saved profile ID `deepseek-v4-flash-openai` and the highest effort setting. A profile ID is distinct from the API model name. This screenshot does not itself prove the transmitted request parameters. The separately completed integration verification used `deepseek-flash`, the Responses API, `reasoning.effort: "max"`, and `max_output_tokens: 384000` with real file/tool calls and continued conversation.

[`docs/product/assets/deepseek-settings-en.png`](../../docs/product/assets/deepseek-settings-en.png) shows the actual macOS GUI model editor after saving that configuration on 2026-10-17.

No API keys or credentials are included in these images. See the [English](../../docs/product/deepseek.md) or [简体中文](../../docs/product/deepseek.zh-CN.md) guide to reproduce the connection and task workflow.

`tui-localized-en.png` is an English documentation illustration produced with the built-in imagegen tool from the maintainer's second native screenshot (English response, Chinese interface). Only interface-label translation was requested; the image was inspected for the original formulas, response text, model profile, and usage numbers. It is not an unedited capture of the English UI and is not used as runtime acceptance evidence.

Earlier READMEs used [`tui-borderless-en.png`](tui-borderless-en.png) and [`tui-borderless-zh.png`](tui-borderless-zh.png), edited with the built-in imagegen tool from `tui-localized-en.png` and `tui-native-zh.png`, respectively. The edit removes the light outer border and pale areas outside the bottom corners, extending the dark terminal background to the image edges. These are edited documentation illustrations, not unedited screenshots or runtime acceptance evidence. Both source images remain available above; `tui-native-zh.png` retains its original pixels.
