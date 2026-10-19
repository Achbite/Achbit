# Development and validation

Use the Docker development environment for dependencies, shared TypeScript, GUI resources, tests, and general builds. The macOS packaging stage delegates native compilation and signing to the Mac host. Start with the [English](../README.md#build-from-source) or [简体中文](../README.zh-CN.md#从源码构建) build instructions.

## Development container

On the host, run `make shell` from the checkout you intend to build. It evaluates `Dockerfile.dev`, builds changed image layers, creates or reuses the configured container, and opens a shell in `/workspace`. The checkout is mounted into that directory. Dependencies and compiler caches use Docker volumes; `bin/` contains the outputs visible on the host.

For a separate worktree, select a distinct container name and unused host port to keep an existing development container intact:

```bash
make shell CONTAINER_NAME=deepcode-my-task CONTAINER_HOSTNAME=deepcode-my-task DEEPCODE_HOST_PORT=31346
```

Reuse those settings for host-side entrypoints. `make docker-info` prints the selected checkout, container, port, and cache volume names. macOS `make shell` also prepares the checkout's native build bridge.

## Build and update

Inside the container:

```bash
bash ./build.sh --stage package-macos
# Or: --stage package-windows / --stage package-linux
# All available targets:
bash ./build.sh
```

Unavailable targets are reported explicitly; a failed build returns an error. Windows builds run in the Docker toolchain, and Linux packages match the container's architecture. Native macOS packaging needs an Apple Silicon Mac and the host requirements described in the README.

For macOS local development, including forks, run `bash scripts/setup-macos-signing.sh` once on the Mac before packaging. It prepares a persistent signing identity in your login Keychain. It does not require an Apple Developer account or put the private key in the repository or package. An existing identity can be selected with `DEEPCODE_MACOS_SIGN_IDENTITY`. See [macOS signing](product/operations.md#macos-signing).

To update only GUI resources in an existing package, run this on the host after preparing its container:

```bash
make ui-update UI_PACKAGE=bin/macos-arm64
```

For a separate worktree, also pass its `CONTAINER_NAME`. Select `bin/win64` or the generated Linux directory for those packages. macOS resource replacement runs on the host so signing can access its Keychain. Reload with **Cmd+Shift+R** on macOS or **Ctrl+Shift+R** elsewhere.

A GUI resource update does not replace TUI, Session, Kernel, or native launchers. Changes to those components or bundled product documentation need the corresponding build and a restart. See [update behavior](distribution.md#更新与功能配置).

## Debug control for iteration

Build the isolated Windows or macOS product through the same container/native packaging entrypoint:

```bash
bash ./build.sh -debug
# Select Windows explicitly:
bash ./build.sh -debug --stage package-windows
```

The default selects available Windows and macOS targets. Windows writes `bin/debug/win64` and a ZIP containing `DeepCode-Debug.exe` and `deepcode-debug.cmd`; macOS writes `bin/debug/macos-arm64` and its archive containing `DeepCode-Debug.app` and `deepcode-debug`. Both use a distinct application identity and user root and generate no installer or global command. Linux Debug stages explicitly report unsupported. Normal builds retain their ordinary output directories and installers. Building either output does not update an already running application or Host.

Use the [Debug CLI guide](debug-control.md) to launch with an explicit test workspace and state root. Prefer direct CLI tool/UI actions for targeted tests and one pushed observation stream for Agent tasks. Ordinary Session timing and the execution-process duration display are not gated by the Debug build; only the external control and detailed query interfaces are.

DeepCode can read the [English product guide](product/debug-control.md) through `doc.read` with `name="debug-control.md"`; `deepcode-iteration` links the workflow to that document. Built-in Skills/references and the `doc.read` document list are embedded by `local_agent_product_tools.rs`, while packaging also copies `docs/product` into runtime resources. A new Markdown file is not automatically a readable built-in document: update the existing manifest when adding an entry, then rebuild/restart the owning Host. Keep long-lived guidance separate from task receipts.

## Checks

Run these inside the development container:

```bash
bash ./test.sh required   # Rust, build behavior, shared TS, TUI launchers, Session, GUI contracts/types
bash ./test.sh cli        # Required checks plus CLI → Session → Kernel integration
bash ./test.sh full       # Complete registered suite, including shared shells and document output
```

`bash ./test.sh static` checks shell syntax and Git whitespace and can run on the host. A container snapshot without accessible host-owned Git metadata reports that diff check as skipped; run it on the host separately. Skipped checks are not passing checks.

The end-to-end suite uses local fixture providers. It verifies the registered source and runtime chains, but does not establish real-provider connectivity, native desktop behavior, or acceptance of a downloadable package. For a package delivery, use the target package for a real CLI conversation and confirm that TUI and GUI open on that platform.

The native GUI has a separate Cargo workspace at `shells/deepcode-gui/src-tauri/Cargo.toml`. Windows dedicated-console font verification requires an interactive Windows desktop: set `DEEPCODE_TEST_TUI_FONTS` to the extracted terminal TTF directory and `DEEPCODE_TEST_TUI_RESULT` to a new receipt path, then run `cargo test -p deepcode-tui windows_terminal::tests -- --include-ignored --test-threads=1`. It creates its own console and checks the bundled families and system font; ignored tests or an earlier receipt do not establish a new result.

## Contributing

Read the effective project instructions before changing source or tests. Keep changes scoped to their behavior and run the relevant registered checks. Public development changes enter `dev-main` through a task-branch PR; stable-source updates enter `main` through a separate PR. Both use merge commits. Product operation details belong in the [product documentation](product/operations.md), while version changes belong in [Release notes](https://github.com/Achbite/DeepCode/releases).
