# DeepCode

### Build, inspect, and review your work in one agent workspace.

A local-first coding agent for the desktop and terminal. Work with your files, run tools, preview the result, and keep the conversation alongside it.

**[Quick start](#quick-start) · [Downloads](https://github.com/Achbite/DeepCode/releases) · [Product guide](docs/product/operations.md) · [中文](README.zh-CN.md)**

![DeepCode running an English dashboard task, with the conversation and live preview side by side](assets/readme/workspace-en.jpg)

*From a CSV to an interactive dashboard in the macOS app. Real task demonstration with fictional project data.*

## One place for the whole task

| Work with your project | See what changed | Keep control |
| --- | --- | --- |
| Read code, edit files, run commands, and inspect diffs. Use the desktop GUI, CLI, or TUI with shared conversations and model connections. | Open a live browser preview, inspect the page, and ask for another revision in the same conversation. Read Markdown, HTML, images, and PDFs alongside your work. | Review proposed changes and execution requests. Choose manual or delegated approval; uncertain execution requests return to you. |

### Start with a task. Refine the result.

> Build a delivery dashboard from `delivery-data.csv`. Include four key metrics, a weekly trend, project details, and a project filter. Open a preview, check it, and deliver a self-contained HTML file.

Try it with the [sample CSV](examples/delivery-dashboard/delivery-data.csv) in your own project folder.

The Agent can read the data, propose its changes, build the page, and use the browser to check its work. Continue with feedback in the same conversation; delivered files and previews stay available in the output panel.

![DeepCode reviewing an updated English dashboard in the same conversation](assets/readme/review-en.jpg)

*An actual follow-up revision. Observation screenshots and temporary logs remain in execution history; the output panel contains results explicitly delivered for review.*

### Choose the right interface for the job

- **CLI, MCP, or GUI:** use a program's CLI when it fits, an available MCP integration for structured operations, and visual interaction when the task needs the rendered interface. The Agent can discover and activate relevant installed plugins as it works.
- **Your model connection:** configure API services or supported subscription connections. Context estimates, provider-reported token usage, and cache usage remain visible.
- **Questions without losing momentum:** the Agent can ask a clarification question and continue independent work. Your reply joins the same task; unanswered questions remain available for a decision.
- **Results you can inspect:** delivered files, live previews, and fixed-version references stay with the conversation. Markdown and HTML have a read-only preview and source view; interactive HTML opens in the browser.

### In 0.6.50

- **Follow the controlled targets on macOS and Windows:** independent borderless previews show the current native window and embedded browser page. They start staggered and can overlap. Drag each image separately; click to reveal its exact target without sending a click to the controlled application. Dragging does not activate the target. Each preview adjusts to the conversation and Reader layout. On macOS, the blue virtual pointer also appears as its own system sharing item and follows the run's lifetime.
- **Open images and Agent work:** delivered images, Markdown images and Reader images open in the same original-image viewer, with scrolling, Close and Esc. The Reader's Subagents tab provides a list, task details and a back action, alongside the Agent's messages, tools and results.
- **Understand total cache usage:** the conversation's total includes its own calls and all descendant Agents, including closed members; continuing an existing Agent does not count that member twice. Current-request context and billing views keep their separate scopes.
- **Use progress and delegation when helpful:** Plans cover new or expanded workspace authorization; necessary changes within existing permission need no new Plan. Kernel blocks execution outside the granted scope; the Agent cannot authorize itself by declaring an action permitted. Todo is optional progress. Disabling delegation blocks new Agent tasks without cancelling existing work or deleting its history.
- **Save Chrome screenshots in the conversation:** on macOS and Windows, the Chrome integration binds file output and relative paths to the current session's private directory, retaining the upstream temporary root. It does not add project or attachment directories to those roots. Delegated review receives recorded evidence for the exact Chrome page and requested elements; uncertainty still returns to the user.

The demos use macOS and fictional data. Native desktop operations use a platform-specific helper; Windows has its own implementation and does not use macOS sharing controls. Each run reports which tools are actually available and why another tool is blocked. PDF export requires the [document runtime](skills/deepcode-documents/SKILL.md).

## Quick start

Build the current package using [Build from source](#build-from-source), or use a matching package from [Releases](https://github.com/Achbite/DeepCode/releases) when one is available. Choose an installer or a portable package:

| Platform            | Install or launch                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS Apple Silicon | Run `DeepCode-<version>-macos-arm64.pkg`, then open `/Applications/DeepCode-GUI.app`. The portable package contains `DeepCode-GUI.app`. |
| Windows x64         | Run `DeepCode-<version>-win64-setup.exe`, then open DeepCode from the Start menu. The portable package contains `DeepCode-GUI.exe`.     |
| Linux x64 / ARM64   | Extract the package for your architecture and run `./DeepCode-GUI`.                                                                     |

1. **Open DeepCode** from the installed or extracted package.
2. **Connect a model** in **Settings → Models and services**: add an API connection or sign in to a supported Coding Plan.
3. **Choose your project and describe the task.** Select a model, submit your request, and review proposed changes.

Use a project's **Manage workspace** menu to choose its folders and execution environment. Windows projects can select a local shell or WSL.

In the GUI, attach files or folders to a message, open artifacts and diffs, or ask the Agent to open an HTML preview. Browser annotations stay active until you leave with the toolbar button or Esc. New conversations inherit the last model used for a submitted task and its remembered reasoning level. Use **Cmd+Shift+R** on macOS or **Ctrl+Shift+R** elsewhere to reload the interface.

**Tune the reading experience** in **Settings → Appearance**. Gentle reading is the default; gentle and compact families each offer WenKai-style or sans-serif Chinese, alongside system and custom fonts. Choose one font for the whole interface, or expand font details to combine interface, content, and terminal/code fonts independently. Body text defaults to 14 px and code to 12 px. Color themes change colors only. See [reading and appearance](docs/product/operations.md#reading-and-appearance) for the font choices and terminal limits.

Completed turns collapse their execution process while keeping the final answer visible. Expand it to read the steps, then close it again; the disclosure stays in view. Conversation text remains centered, wider tables and code can use more horizontal room, and long command summaries stay within the reading column. Computer Use history retains action details and archived frames for review; opening that history does not reactivate the controlled page or application.

## Prefer the terminal?

The same package includes terminal interfaces:

```bash
# Linux; use DeepCode-CLI.command / DeepCode-TUI.command on macOS,
# or deepcode-cli.bat / deepcode-tui.bat on Windows.
./deepcode-cli connections
./deepcode-cli auth login openai-codex browser
./deepcode-cli ask -C /path/to/project "Explain this project"
./deepcode-cli sessions
./deepcode-cli resume session:<full-id>
./deepcode-cli new -C /path/to/project
./deepcode-tui -C /path/to/project
```

In both the TUI and CLI chat, use `/sessions` to list conversations, `/resume <number or full ID>` to open one, and `/new` to start one in the startup directory. The TUI picker supports arrow keys, Enter and Esc; numbers refer to the displayed list. Switching does not cancel background work or copy another session's directories or permissions.

Type `/` in the TUI for command suggestions; commands used recently and often move forward in the list for that TUI process. Help and detail views stop scrolling at their content boundaries. Tables have closed borders, supported LaTeX formulas render as terminal text layouts, and a running indicator appears above the input. Unsupported formulas retain their source and diagnostic.

On macOS, the TUI uses a dedicated Terminal window with the GUI's effective terminal/code font. Double-clicking `DeepCode-TUI.command` reuses its launch window; a normal exit closes that dedicated window once its launch shell ends. Ordinary terminal windows and their defaults remain unchanged. Use `/font` for built-in choices and `/font follow` to reread the GUI selection. Use `--in-place` to run with the current terminal's own font instead. Windows opens a dedicated console with the same GUI font settings and `/font` controls; `--in-place` preserves the current terminal. Linux uses its terminal application's configured font. See [installation and window behavior](docs/distribution.md).

After installation with PKG or Windows Setup, use `deepcode-cli` and `deepcode-tui` directly in a terminal; on Windows, open a new terminal so it receives the updated PATH.

`-C` explicitly selects a workspace. Omit it for an independent conversation, or use `--session <id>` to continue one. Run `--help` for more commands. Connection and subscription setup is covered in [Models and services](docs/product/model-services.md).

<details>
<summary>Platform dependencies, permissions, and local data</summary>

Windows Setup installs WebView2 Evergreen Runtime if it is missing; portable Windows packages require it to be installed separately. Linux GUI requires GTK/WebKitGTK. macOS builds and UI updates reuse a persistent signing identity so normal updates can retain Accessibility and Screen Recording authorization. Switching from an earlier ad-hoc build may require authorization once. The independent **DeepCode Computer Use** App owns desktop operations and requires its own initial system grants. macOS may still show a “Continue to Allow” reminder for direct screen access; keeping the signing identity stable does not disable that system reminder. Update it separately with `bash build.sh --stage computer-use`; verify the executor with `computer.control status`. Configuration, persistent data, caches, temporary files and logs use separate platform directories. See [installation and user files](docs/distribution.md).

</details>

## Extend your workspace

Add Skills, CLI tools, MCP connections, or UI plugins. Describe the operations an integration supports so the Agent can find it by capability. Registration makes a plugin discoverable; activation loads its tools and guidance, and execution follows the configured permissions.

- [Plugin discovery and configuration](docs/product/operations.md#settings-and-extensions)
- [Computer Use: browser and desktop control](plugins/computer-use/README.md)
- [Chrome page control and private screenshot output](plugins/chrome-devtools/README.md)
- [UI plugin API and example](docs/product/ui-plugins.md)
- [Models, subscriptions and usage](docs/product/model-services.md)
- [Workspace environments and permissions](docs/product/execution-environments.md)

## Under the hood

Session owns the Agent Loop and conversation state. Kernel owns tools and execution permissions. GUI, CLI, and TUI present their shared results. [Product operations](docs/product/operations.md) describes task progress, approval, context, resource delivery, and Host lifetime.

Workspace files and conversation journals are stored locally. Selected prompts, context, and images are sent to your configured model service; connected tools may also communicate with their own services. A local model connection keeps model requests on your machine.

## Build from source

Install Docker and GNU Make. On Windows, run the build commands in WSL2 with Docker integration enabled. macOS packaging additionally needs the host's Xcode Command Line Tools, Rust toolchain from `rust-toolchain.toml`, and Node.js.

The commands below build the stable release from `main`. Use `dev-main` for ongoing development.

```bash
git clone --branch main https://github.com/Achbite/DeepCode.git
cd DeepCode
make shell
```

`make shell` prepares the development container. On macOS it also starts the worktree's native build bridge.

The development container enables nested Bubblewrap with `SYS_ADMIN` and container-local AppArmor, seccomp, and system-path overrides. Existing containers without this setup are recreated while preserving dependency and build volumes. These settings apply to the development container; packaged runtimes retain their platform sandbox behavior.

Run the desired command inside that container, or from the host while it is running:

| Target                        | Command                                   | Output                                 |
| ----------------------------- | ----------------------------------------- | -------------------------------------- |
| macOS Apple Silicon           | `bash ./build.sh --stage package-macos`   | `bin/macos-arm64/`                     |
| Windows x64                   | `bash ./build.sh --stage package-windows` | `bin/win64/`                           |
| Linux, container architecture | `bash ./build.sh --stage package-linux`   | `bin/linux-x64/` or `bin/linux-arm64/` |
| All available platforms       | `bash ./build.sh`                         | The supported directories above        |

Shared TypeScript and GUI assets, Linux binaries, and Windows cross-compilation run in Docker. macOS native compilation and signing run on the Mac host through the bridge. Unsupported platforms are reported explicitly; build failures remain failures. Each package also produces a versioned archive under `bin/`; macOS adds a PKG installer and Windows adds a Setup executable. User configuration and sessions live outside the program directory and are excluded from packages.

For local macOS development, including forks, run `bash scripts/setup-macos-signing.sh` once in a Mac host terminal. Each developer keeps their own signing identity in their login keychain; branches and checkout directories reuse it for both package and UI updates. No Apple developer account is required for this local setup, and private keys are never stored in the repository or package. To select an existing signing identity, set `DEEPCODE_MACOS_SIGN_IDENTITY` to its name or certificate fingerprint. Missing identities stop the build before replacing the installed package. See [macOS signing](docs/product/operations.md#macos-signing).

For a frontend-only update to an existing package, run the following from the Mac host terminal when targeting macOS so signing can access the local keychain:

```bash
make ui-update UI_PACKAGE=bin/macos-arm64
```

Choose `bin/win64` or the Linux package directory for those platforms. This command builds and copies the GUI bundle; run macOS resource updates on the host for signing, then reload the interface. It does not replace the running TUI, Session or Kernel. TUI binaries and native launch scripts require a package update and a new TUI process. Changes to services or bundled product guidance require a corresponding service/package build and restart. Plugin update timing is described in [product operations](docs/product/operations.md#updates).

## Development checks

Run the checks inside `make shell`:

```bash
bash ./test.sh required   # Rust formatting/tests, shared TS, GUI contracts/types, build behavior
bash ./test.sh cli        # Required checks plus the CLI → Session → Kernel path
bash ./test.sh full       # Also covers the terminal/web shells and document output
```

`bash ./test.sh static` checks shell syntax and Git whitespace and can run on the host. End-to-end scripts use a local fixture Provider; they do not replace real model or native GUI acceptance. Native GUI tests have their own Cargo workspace: `shells/deepcode-gui/src-tauri/Cargo.toml`.

Tests protect current input/output contracts and data flow, including required failure and cleanup behavior. When a contract or path is retired, update its tests and fixtures in the same change; passing tests alone does not establish complete correctness. Maintained manual GUI previews are type-checked by `required`, but are not browser interaction tests or production build inputs.

On Windows, the two Computer Use helper lifecycle tests are explicitly ignored until a built helper is supplied. Set `DEEPCODE_TEST_COMPUTER_USE_HELPER` to its executable, then run `cargo test -p deepcode-host-connection computer_use::tests -- --include-ignored`. That explicit run fails if the helper is missing; an ignored test is not a passing runtime check.

The Windows dedicated-console font test also requires an interactive desktop. Set `DEEPCODE_TEST_TUI_FONTS` to the extracted terminal TTF directory and `DEEPCODE_TEST_TUI_RESULT` to a new receipt path, then run `cargo test -p deepcode-tui windows_terminal::tests -- --include-ignored --test-threads=1`. It opens its own console and checks the four bundled fonts and system font; an existing receipt is rejected.

## License

[MIT](LICENSE). See [attributions](ATTRIBUTION.md), [third-party notices](THIRD_PARTY_NOTICES.md), and [citation metadata](CITATION.cff).
