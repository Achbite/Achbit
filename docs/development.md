# Development and validation

Use the Docker development environment for dependencies, shared TypeScript, GUI resources, tests, and general builds. The macOS packaging stage delegates native compilation and signing to the Mac host. Start with the [English](../README.md#build-from-source) or [简体中文](../README.zh-CN.md#从源码构建) build instructions.

## Development container

On the host, run `make shell` from the checkout you intend to build. It checks and updates the development image, creates or reuses the configured container, and opens a shell in `/workspace`. The checkout is mounted into that directory. Dependencies and compiler caches use Docker volumes; `bin/` contains the outputs visible on the host.

`make shell` uses Docker's incremental build checks: changes to `Dockerfile.dev`, `entrypoint.sh` or image build arguments automatically rebuild affected layers; unchanged layers use the existing cache. Ordinary application source changes are not image inputs. Image build failures stop entry into the container. APT downloads are retained in a BuildKit cache mount for reuse when a dependency layer needs rebuilding. Mirror overrides can be set in the local, ignored `.achbit-worktree.mk` using `ACHBIT_APT_MIRROR` and `ACHBIT_APT_SECURITY_MIRROR`.

For a separate worktree, select a distinct container name and unused host port to keep an existing development container intact:

```bash
make shell CONTAINER_NAME=achbit-my-task CONTAINER_HOSTNAME=achbit-my-task ACHBIT_HOST_PORT=31346
```

Reuse those settings for host-side entrypoints. `make docker-info` prints the selected checkout, container, port, and cache volume names. macOS `make shell` also prepares the checkout's native build bridge.

## Build and update

Inside the container:

```bash
# Compile and update the local runnable product:
bash ./build.sh
# Explicitly build and package all available targets:
bash ./build.sh --stage package
# Or select a single package:
bash ./build.sh --stage package-macos
# Or: --stage package-windows / --stage package-linux
```

The default `runtime` stage compiles shared TypeScript and GUI resources, compiles native programs for the development host, and replaces its complete runnable product in `bin/`. On macOS it uses the native host bridge to compile and sign `bin/macos-arm64/Achbit.app` and the Computer Use helper. Windows/WSL updates `bin/win64`; Linux updates `bin/linux-arm64` or `bin/linux-x64`. The Docker entrypoint uses `ACHBIT_BUILD_HOST_OS`, supplied by `make shell`, to select the host rather than treating every container as a Linux desktop. An unavailable selected host fails explicitly. `runtime-macos`, `runtime-windows`, and `runtime-linux` select a runtime directly.

Daily builds include the current Kernel, Host, CLI/TUI, Session, GUI, runtime dependencies and product resources. They retain the existing release profile, compiler caches and user data, and generate no ZIP, tar.gz, PKG or Setup. Existing distribution archives remain from the last explicit package build. `make build` and `pnpm build` select this same path; `make package` and `pnpm package` select explicit full packaging.

After building on macOS, open `bin/macos-arm64/Achbit.app` from this checkout. A copy installed in `~/Applications` is a separate product. Building does not restart a running GUI/Host; quit and reopen the checkout's App to load the new native code and resources.

For compiler outputs alone, use `bash ./build.sh --stage code`. It compiles shared TypeScript, GUI resources, the Linux Rust workspace and native GUI shell in Docker, without updating `bin/`. Outputs remain in `userspace/*/dist`, `userspace/gui/dist-achbit-gui`, and the container's `CARGO_TARGET_DIR/release` (normally `/workspace/target/release`, backed by a Docker volume).

Package stages compile the selected targets before assembling complete runtime directories and distribution files. Unavailable targets are reported explicitly; a failed build returns an error. Windows builds run in the Docker toolchain, and Linux packages match the container's architecture. Native macOS packaging needs an Apple Silicon Mac and the host requirements described in the README.

For macOS local development, including forks, run `bash scripts/setup-macos-signing.sh` once on the Mac before packaging. It prepares a persistent signing identity in your login Keychain. It does not require an Apple Developer account or put the private key in the repository or package. An existing identity can be selected with `ACHBIT_MACOS_SIGN_IDENTITY`. See [macOS signing](product/operations.md#macos-signing).

Daily runtime builds reuse that identity and the existing application identifiers. They sign updated contents automatically and refuse to replace an existing App signed with a different certificate; they do not generate or rotate certificates, modify the Keychain, or reset system permissions.

To update only GUI resources in an existing package, run this on the host after preparing its container:

```bash
make ui-update UI_PACKAGE=bin/macos-arm64
```

For a separate worktree, also pass its `CONTAINER_NAME`. Select `bin/win64` or the generated Linux directory for those packages. macOS resource replacement runs on the host so signing can access its Keychain. Reload with **Cmd+Shift+R** on macOS or **Ctrl+Shift+R** elsewhere.

A GUI resource update does not replace TUI, Session, Kernel, or native launchers. Changes to those components or bundled product documentation need the corresponding build and a restart. See [update behavior](distribution.md#更新与功能配置).


## Automatic application updates

The native GUI uses `tauri-plugin-updater` with a static GitHub Releases feed. The public verification key is compiled into `shells/achbit-gui/src-tauri/tauri.conf.json`; its production endpoint is `https://github.com/Achbite/Achbit/releases/latest/download/latest.json`. No application server is required. The first updater-enabled version must be installed manually by clients running 0.6.62 or earlier.

Package stages retain the normal archives/installers and add the updater's installation units:

| Feed target | Updater asset | Initial installation |
| --- | --- | --- |
| `darwin-aarch64` | `Achbit-<version>-macos-arm64.app.tar.gz` | Current-user PKG or an App in a writable directory |
| `windows-x86_64` | `Achbit-<version>-win64-setup.exe` | Per-user NSIS Setup |
| `linux-aarch64` / `linux-x86_64` | Corresponding `.AppImage` | Executable AppImage in a writable directory |

The Mac App contains the separately signed Computer Use helper in `Contents/Helpers`. The PKG installs in `~/Applications`, with wrappers in `~/.local/bin`. NSIS accepts Tauri's silent update and relaunch arguments; it waits for the installation lease and replaces only entries in `package-files.json`. Linux tar archives remain manual-update products. GTK/WebKitGTK and other existing system-library requirements still apply.

After building the intended release targets, sign their updater assets and create the feed on the host (the signer delegates to the configured Docker container). The following example includes the Linux architecture produced by an ARM64 development container:

```bash
python3 scripts/package-updates.py sign \
  bin/Achbit-0.6.63-macos-arm64.app.tar.gz \
  bin/Achbit-0.6.63-win64-setup.exe \
  bin/Achbit-0.6.63-linux-arm64.AppImage

python3 scripts/package-updates.py manifest --version 0.6.63 \
  --base-url https://github.com/Achbite/Achbit/releases/download/0.6.63 \
  --artifact darwin-aarch64=bin/Achbit-0.6.63-macos-arm64.app.tar.gz \
  --artifact windows-x86_64=bin/Achbit-0.6.63-win64-setup.exe \
  --artifact linux-aarch64=bin/Achbit-0.6.63-linux-arm64.AppImage \
  --output bin/latest.json
```

Keep the private signing key outside the checkout. The local signing command reads `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`; its macOS default is `~/Library/Application Support/Achbit-build/updater.key`. CI can supply the same key and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through secrets. Back up the existing key: changing the compiled public key does not make already-installed clients trust a new private key.

Prepare a draft Release, upload every initial installer/archive plus updater asset, its `.sig`, and `latest.json`, then publish and mark it as the latest stable Release. The feed must name only available platform assets. Its version and URLs identify the new product; publishing an empty or partially uploaded feed is not a completed release. Signing and manifest creation do not themselves push or publish anything.

The GUI checks after startup and every 30 minutes. After verifying the download, it waits for UI input to be idle for 15 seconds and for unsaved settings to be resolved. Host preparation gates new external work and checks Session activity, Kernel work and connected clients. A filesystem lease covers other CLI/TUI/Host processes using the same installation, even with different user roots. Automatic installation is owned by a local GUI with a managed Host. SSH and connect-only windows do not initiate an installation; close them before updating the local installation. A persistent Host blocks automatic installation until explicitly stopped. Only after preparation and a confirmed Host shutdown does the updater replace program files. Drafts and view state are restored before React mounts; Session facts are reloaded from the existing store.

For a local macOS Debug upgrade, build two distinct versions through the existing Docker/native bridge:

```bash
ACHBIT_BUILD_VERSION=0.6.63-debug.1 bash ./build.sh -debug --stage package-macos
# Preserve this bin/debug/macos-arm64 in a separate test installation.
ACHBIT_BUILD_VERSION=0.6.63-debug.2 bash ./build.sh -debug --stage package-macos
```

Sign the second App archive and serve it with a generated static feed from a loopback-only HTTP server. Start the first Debug App with explicit `ACHBIT_USER_ROOT`, `ACHBIT_DEFAULT_WORKSPACE` and `ACHBIT_DEBUG_UPDATE_URL`, then use `achbit-debug attach` with that state root and an absolute test-workspace path. This exercises the normal GUI-owned automatic Host lifetime. `achbit-debug launch` intentionally creates a persistent Host and therefore is unsuitable for an idle-shutdown acceptance run. Debug updates are disabled unless the loopback endpoint is explicitly supplied; production builds do not read that override. Current local Debug packaging supports this updater chain on macOS; Windows Debug ZIPs are not NSIS update assets.

## Debug control for iteration

Build the isolated Windows or macOS product through the same container/native packaging entrypoint:

```bash
bash ./build.sh -debug
# Select Windows explicitly:
bash ./build.sh -debug --stage package-windows
```

Explicit `-debug` mode selects available Windows and macOS targets when no stage is given. Windows writes `bin/debug/win64` and a ZIP containing `Achbit-Debug.exe` and `achbit-debug.cmd`; macOS writes `bin/debug/macos-arm64` and its archive containing `Achbit-Debug.app` and `achbit-debug`. Both use a distinct application identity and user root and generate no installer or global command. Linux Debug stages explicitly report unsupported. Normal package stages retain their ordinary output directories and installers. Building either output does not update an already running application or Host.

Use the [Debug CLI guide](debug-control.md) with an explicit test workspace and state root. Call tools and UI actions directly; use one pushed observation stream only for Session/Provider task tests. Debug verification does not automatically add real-model, ordinary CLI/TUI or installer acceptance. Ordinary Session timing is available in both normal and Debug builds.

For historical-session latency, measure process startup, navigation readiness and first session activation separately against the same isolated data snapshot. History replay uses the shared Session reducer with indexes scoped to that replay. Resource and artifact previews use the journal's resource fields and the same Session decoders and revision rules, without rereading model context or retaining a persistent projection cache. Concurrent identical previews share only the pending read; each caller receives independent output. Debug action completion and frame observations are distinct from a physical screen-paint measurement.

Product guides are ordinary Markdown files under the environment snapshot’s `productDocsPath`. Search and read them with Shell; packaging copies `docs/product` into runtime resources. Built-in Skills/references remain registered in `local_agent_product_tools.rs`. Rebuild/restart the owning Host after changing bundled resources. Keep long-lived guidance separate from task receipts.

## Checks

TCRs, per-run acceptance reports and temporary preview/export scripts belong in ignored task output directories such as `.build-cache/` or `.task-artifacts/`. Keep them out of versioned product documentation and build tooling. Before a necessary test change, document its purpose and coverage in a TCR; preserve the existing assertions and failure semantics.

Run these inside the development container:

```bash
bash ./test.sh required   # Rust, build behavior, shared TS, TUI launchers, Session, GUI contracts/types
bash ./test.sh cli        # Required checks plus CLI → Session → Kernel integration
bash ./test.sh full       # Complete registered suite, including shared shells and document output
```

`bash ./test.sh static` checks shell syntax and Git whitespace and can run on the host. A container snapshot without accessible host-owned Git metadata reports that diff check as skipped; run it on the host separately. Skipped checks are not passing checks.

The end-to-end suite uses local fixture providers; its results do not establish real-provider connectivity or native desktop behavior. For explicitly requested standard-package/installer acceptance, use the target package for a real CLI conversation and TUI/GUI startup. A Debug test package alone does not require those checks. Documentation-only changes use static and content/link checks without rebuilding the runtime.

The native GUI has a separate Cargo workspace at `shells/achbit-gui/src-tauri/Cargo.toml`. Windows dedicated-console font verification requires an interactive Windows desktop: set `ACHBIT_TEST_TUI_FONTS` to the extracted terminal TTF directory and `ACHBIT_TEST_TUI_RESULT` to a new receipt path, then run `cargo test -p achbit-tui windows_terminal::tests -- --include-ignored --test-threads=1`. It creates its own console and checks the bundled families and system font; ignored tests or an earlier receipt do not establish a new result.

### Plugin checks

Build the plugin entry with its own dependencies, then import its directory or manifest into an isolated Debug instance using the [plugin interfaces](plugins/README.md). Exercise discovery, the affected invocation or service handshake, and owned-resource cleanup. For service lifecycle changes, check port release and the intended persistent state across restart. Use [Debug control](debug-control.md) for direct tool/UI operations; a plugin using an existing protocol does not require unrelated platform checks.

### Windows desktop checks

Choose the capture, UI Automation or physical-input route affected by the change. Record the initial state, action and resulting state before a reload or another driver changes the target. CDP reads may corroborate desktop input; CDP mutations do not exercise Windows mouse or keyboard input. Check preview feedback or stop/release behavior only when it is part of the change.

For an external Chrome experiment, use an owned instance with a unique profile and task-scoped temporary directory. A browser that outlives a Shell call must not depend on that call's TEMP/TMP directory. Inspect the exact instance and page before CDP commands, retain its PID, and close only the instance created for the check.

PowerShell verification scripts should stop on errors and check native command exit codes. Distinguish a rejected action from dispatched input followed by an observation failure; preserve the original result before deciding whether another action is appropriate. A foreground query after activating a window cannot establish which window had focus before activation.

## Contributing

Read the effective project instructions before changing source or tests. Keep changes scoped to their behavior and run the relevant registered checks. Public development changes enter `dev-main` through a task-branch PR; stable-source updates enter `main` through a separate PR. Both use merge commits. Product operation details belong in the [product documentation](product/operations.md), while version changes belong in [Release notes](https://github.com/Achbite/Achbit/releases).
