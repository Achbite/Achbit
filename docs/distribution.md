# Achbit installation and user files

Achbit provides a GUI, CLI, and TUI. All three share model settings, conversation history, and the background service. Packages include Node and the required application resources; no development toolchain is needed.

## macOS

The application supports macOS 12 and later. Native desktop capture and interaction require macOS 15.2 or later. On macOS 12–15.1, Achbit reports the requirement before enabling desktop control; chat, file tools, and browser tools remain available.

Open `Achbit-<version>-macos-arm64.pkg` to install for the current user. The app is installed at `~/Applications/Achbit.app`; `achbit`, `achbit-cli`, and `achbit-tui` are installed in `~/.local/bin`. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file, then open a new terminal. The current user owns the application directory, so automatic updates do not require administrator privileges.

For the portable archive, open `Achbit.app`, `Achbit-CLI.command`, or `Achbit-TUI.command`. Keep their relative locations when moving the package. User files are stored separately, as listed below.

The macOS TUI uses the effective GUI selection under **Appearance → Font details → Terminal and code**. Double-clicking `Achbit-TUI.command` reuses an open Terminal window. Its dedicated tab closes after the shell exits successfully. When the `.command` launcher is run from an existing terminal, it restores that tab's original font and title on exit. The installed `achbit-tui` command opens a dedicated window and closes it on normal exit. Windows containing other tabs or processes are retained. Failed launches and nonzero exits leave the diagnostic window open. Other terminal windows and their defaults are unchanged.

Use `/font` to inspect the four bundled fonts and the system default, `/font compact` to change the current window, or `/font follow` to reload the GUI selection. Bundled terminal fonts preserve one cell for Latin characters and two for CJK characters. Custom terminal fonts must be monospaced. First launch may request permission to control Terminal; denial is reported. Launch diagnostics distinguish font preparation, window creation, font application, and the first TUI frame. `achbit-tui --in-place`, pipes, help, and `--smoke` use the current terminal without opening another window. See [Reading and appearance](product/operations.md#reading-and-appearance).

The macOS package contains `Achbit.app` and its separately signed helper, `Contents/Helpers/Achbit Computer Use.app`. Complete application updates replace the main app, helper, and runtime resources together. The helper performs desktop capture and interaction and needs Accessibility and Screen Recording permissions on first use. `computer.control status` reports the actual executing process. `bash build.sh --stage computer-use` updates the helper separately; before the next call, the Host shared by GUI, CLI, and TUI stops the old helper and starts the new one. Obtain new observations after replacement. Tool definitions and built-in guides are provided by the Kernel build.

Use the same signing identity for macOS updates to retain the helper's permissions. First installation or a change from an ad-hoc signature may require authorization once. Routine updates should not reset permissions. Permission retention is separate from macOS reminders to continue allowing capture: the system may show another reminder for direct window capture without a signature failure. See [macOS signing](product/operations.md#macos-signing).

## Windows

Run `Achbit-<version>-win64-setup.exe`. The default application directory is `%LOCALAPPDATA%\Programs\Achbit`. Setup creates Start menu entries and adds the application to the user PATH. Open a new terminal to use `achbit`, `achbit-cli`, and `achbit-tui`.

The GUI requires WebView2 Evergreen Runtime. Setup downloads and runs Microsoft's installer when WebView2 is missing and reports any installation failure. The portable archive uses the same user directories; launch `Achbit.exe`, `achbit-cli.bat`, or `achbit-tui.bat`. Uninstallation removes program files and the PATH entry added by this installation, while retaining user files.

`Achbit-Computer-Use.exe` performs desktop capture and interaction. The shared Host starts it on first use and reclaims it on shutdown. Closing one GUI window does not end work owned by other clients. Windows does not require separate Accessibility or Screen Recording permissions. An Achbit process running without administrator privileges cannot observe or control applications running as administrator. After the helper is replaced, the Host stops the old instance and starts the replacement before the next call; obtain new observations.

The Windows TUI opens a dedicated console and uses the GUI's terminal font and code size. `/font` selects one of four bundled fonts or the system monospace font; `/font follow` reloads the GUI choice, and `--font compact` selects a startup font. Normal exit closes the console; failure retains diagnostics and waits for Enter. `--in-place`, pipes, help, and `--smoke` preserve the current terminal and font. Bundled fonts load for the current login session. Custom fonts must be installed, monospaced, and supported by the Windows console; failures are reported.

## Linux

For automatic updates, download the `.AppImage` for your architecture, place it in a directory writable by your user, make it executable, and run it. Add `--cli` or `--tui` for terminal entrypoints. The tar.gz archive provides `Achbit`, `achbit-cli`, and `achbit-tui` and is updated by manual replacement. The desktop environment still needs GTK, WebKitGTK, and ALSA (`libasound2`, for completion sounds). AppImage contains the application update unit, not a complete set of system desktop libraries. See [Execution environments](product/execution-environments.md) for workspace shell requirements.

## User directories

| Purpose | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Configuration | `~/Library/Application Support/Achbit/config` | `%APPDATA%\Achbit\config` | `${XDG_CONFIG_HOME:-~/.config}/Achbit` |
| Persistent data | `~/Library/Application Support/Achbit/data` | `%LOCALAPPDATA%\Achbit\Data` | `${XDG_DATA_HOME:-~/.local/share}/Achbit` |
| Cache | `~/Library/Caches/Achbit` | `%LOCALAPPDATA%\Achbit\Cache` | `${XDG_CACHE_HOME:-~/.cache}/Achbit` |
| Temporary files | `Achbit` under the system user temporary directory | `%TEMP%\Achbit` | `Achbit` under the system temporary directory |
| Logs | `~/Library/Logs/Achbit` | `%LOCALAPPDATA%\Achbit\Logs` | `${XDG_STATE_HOME:-~/.local/state}/Achbit/log` |

Within the configuration directory, `user/local/settings` stores settings and model profiles; `user/local/secrets` stores local credentials. The persistent data directory's `agent-runtime` contains conversation databases, attachments, tool records, and session work directories. Referenced previews, screenshots, and generated files remain with the session and are not disposable cache. On macOS and Windows, Chrome file tools use the session's private work directory as their root and process working directory. Relative screenshot paths resolve there. Project and attachment directories are not automatically added as roots; the upstream system temporary directory remains available.

Cache contains regenerable content. macOS WebKit website storage uses the system Library location. Each shell call has its own temporary directory, removed when the call and its children finish. Save files needed later to the session work directory or an authorized project directory. GUI startup diagnostics are under `host-startup` in the log directory; a CLI-started background service writes `achbit-kernel.log`.

Set `ACHBIT_USER_ROOT` to use an isolated user root. Achbit then places configuration, persistent data, cache, temporary files, and logs in its `config`, `data`, `cache`, `tmp`, and `logs` subdirectories. Clients intended to share state must use the same value. Without it, the platform defaults above apply. Applications and launchers locate program resources automatically; no global internal resource variables are needed.

## Configuration preparation and backups

Installation or first launch creates the required user directories. macOS uses the actual launching user's directories; Windows Setup uses those of the installing user.

When configuration conflicts are found, Achbit saves the original files and validation errors under `config-backups/<record>` in persistent data, then removes obsolete permission fields and fills missing permission defaults. Invalid model configuration is restored to the built-in template, after which model services must be configured again. Valid permissions and other settings, local secret files, and conversation data are preserved.

Valid files are not rewritten, and repeated launches do not repeat backups. Malformed JSON, read failures, and invalid default model selections retain their original errors. Backup or write failures are reported. Installation configuration preparation cannot run concurrently against an in-use application data directory.

## Updates and configuration changes

Local GUI builds from 0.6.63 support complete application updates. **Settings → General → Automatic updates** is enabled by default: the GUI checks after startup and every 30 minutes. Disabling it stops automatic checks and installation; a download already in progress may finish. Manual checks remain available under **Settings → About Achbit**. SSH and connect-only windows do not install updates; close them before updating the local installation.

Updates are downloaded from GitHub Releases and verified against their update signature. Automatic installation waits for all tasks, approvals, and background work to finish, other clients using the same installation to close, settings to be saved, and 15 seconds without input in the Achbit window. Activity in other applications does not reset this timer. Once an update is ready, click the sidebar update arrow or **Install update and restart** in About Achbit to attempt installation immediately. This skips the input grace period; IME composition, unsaved settings, unfinished tasks, and other clients still prevent restart. The update arrow's tooltip shows the reason for waiting. Unsent drafts and the current view are restored after restart. The updater does not launch the GUI while it is closed.

Clients at 0.6.62 or earlier need one manual installation of a version containing the updater. New macOS packages install under `~/Applications`. Previous `/Applications` copies and old launchers are not removed automatically. Start the new copy and put `~/.local/bin` first in your terminal PATH. Both locations use the same user data; do not open both copies together.

A persistent Host started with `achbit-cli start-host` blocks automatic installation until stopped with `achbit-cli stop-host`. Finish tasks and close all clients before running an installer or replacing a portable package manually. Settings, sessions, and attachments are in separate user directories and are not included in or overwritten by the program package. Download, signature, and installation failures are reported and can be retried.

If Windows Setup cannot replace program files, it retains the previous application or its recovery files and writes the original error to `%LOCALAPPDATA%\Achbit\Logs\installer-error.log`. The error dialog shows this path.

| Change | When it takes effect |
| --- | --- |
| Saved GUI fonts, sizes, and colors | Immediately in the GUI. Use `/font follow` in an existing macOS TUI window; new windows read the current selection. |
| Compiled UI plugin entrypoint or manifest at its installed path | The current GUI reloads it after saving. Source-directory changes require reinstalling through the plugin's Update action. TypeScript must be compiled to the declared JavaScript entrypoint. |
| Selected Skill or CLI plugin content | Prepared again before the next model request. In-flight requests, pending approvals, and executing calls retain their original content and bindings. |
| CLI plugin registration, Skill mounts, MCP configuration, and tool plugin enablement | Refreshed before the next model request in the current run. Already-issued calls retain their bindings. |
| Model defaults, permission defaults, and execution environment settings | The next run. |
| Subagent delegation toggle | New delegation and continuation use the latest value. Disabling it does not cancel active or waiting tasks or remove history. |
| Updated GUI resources | Reload with Cmd+Shift+R on macOS or Ctrl+Shift+R elsewhere. |
| TUI binary, bundled terminal fonts, or native launcher scripts | Update the platform package and reopen the TUI. Reloading the GUI does not replace a running TUI. |
| Session, Kernel, native programs, or built-in product guides | Install the corresponding build and restart the affected processes. Source edits do not change the running application. |

Skills, CLI plugins, and run settings follow these boundaries across GUI, CLI, and TUI; UI plugins affect the GUI only. Reopen Achbit after a complete program update. See [UI plugins](product/ui-plugins.md) and [Model services](product/model-services.md).

PDF reading uses the bundled web reader and local Rust PDF plugin. The Documents plugin exports PDFs through the bundled Rust Typst renderer with self-contained Typst input. HTML and Markdown exports preserve their formats. Users do not need to install or configure Python.

## Product identity and data directories

The product is Achbit, with the AC icon and main entrypoint `Achbit.app`, `Achbit.exe`, or `Achbit`. Commands are `achbit`, `achbit-cli`, and `achbit-tui`. macOS portable packages include `Achbit-CLI.command` and `Achbit-TUI.command`; Debug control uses `achbit-debug`. The Computer Use helper is `Achbit Computer Use.app` or `Achbit-Computer-Use.exe`.

From 0.6.61, user directories, Debug data directories, environment variables, communication protocols, application identifiers, and the default local signing name use Achbit. A default first launch uses the directories listed above and does not discover, import, or migrate earlier product data. Existing data and credentials are not deleted. Custom launch scripts, remote Hosts, and external integrations should use the current `ACHBIT_*` variables and `achbit.*` interfaces. On macOS, `ACHBIT_MACOS_SIGN_IDENTITY` can select an existing certificate fingerprint. Consult repository Releases for available downloads and publication status.
