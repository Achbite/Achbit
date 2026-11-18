# Development and validation

Use the Docker development environment for dependencies, shared TypeScript, GUI resources, tests, and general builds. The macOS packaging stage delegates native compilation and signing to the Mac host. Start with the [build instructions](../README.md#build-from-source).

## Development container

On the host, run `make shell` from the checkout you intend to build. It checks and updates the development image, creates or reuses the configured container, and opens a shell in `/workspace`. The checkout is mounted into that directory. Dependencies and compiler caches use Docker volumes; `bin/` contains the outputs visible on the host.

`make shell` uses Docker's incremental build checks: changes to `Dockerfile.dev`, `entrypoint.sh` or image build arguments automatically rebuild affected layers; unchanged layers use the existing cache. Ordinary application source changes are not image inputs. Image build failures stop entry into the container. APT downloads are retained in a BuildKit cache mount for reuse when a dependency layer needs rebuilding. Mirror overrides can be set in the local, ignored `.achbit-worktree.mk` using `ACHBIT_APT_MIRROR` and `ACHBIT_APT_SECURITY_MIRROR`.

For a separate worktree, select a distinct container name and unused host port to keep an existing development container intact:

```bash
make shell CONTAINER_NAME=achbit-my-task CONTAINER_HOSTNAME=achbit-my-task ACHBIT_HOST_PORT=31346
```

Reuse those settings for host-side entrypoints. `make docker-info` prints the selected checkout, container, port, and cache volume names. macOS `make shell` also prepares the checkout's native build bridge.

### Routine cache maintenance

Between builds and tests, run `bash scripts/clean-caches.sh --maintenance` inside the selected project development container to preview cleanup, then add `--yes` to execute it. This removes disposable Vite, test, npm download and APT archive caches and old Kernel test scratch directories. Cargo targets (including incremental and sccache), installed dependencies, shared dependency stores, packaged products and task receipts remain available. The ordinary build lock serializes execution with packaging. Run the command as needed.

## Version updates and delivery

The product version is owned by `Cargo.toml` under `[workspace.package].version`. Required package manifests are synchronized mirrors. Use the version command inside the development container:

```bash
python3 scripts/version.py show             # Read the canonical version
python3 scripts/version.py set <next-version>
python3 scripts/version.py sync             # After editing the canonical field directly
python3 scripts/version.py check            # Read-only consistency check
```

Replace `<next-version>` with the intended semantic version, without a `v` prefix. `set` changes the canonical field and synchronizes the mirrors; `sync` uses the value already in that field. These are alternative update paths. Repeating either with an already synchronized version leaves files unchanged. `show` and `check` also work on the host.

`scripts/version.py` owns the mirror list: package JSON versions, the separate GUI Cargo manifest, Tauri configuration, citation metadata, and local Achbit packages in the GUI Cargo lockfile. It uses `cargo update --workspace --offline` to refresh that lockfile while retaining unrelated locked dependencies. The root Cargo lockfile is generated and ignored. Dependency constraints, protocol versions and historical release text retain their own versions. If Cargo fails, its error remains visible and the metadata changes remain available for review; resolve the reported cause and run `sync` again.

Build and package producers read the canonical version. `package-updates.py manifest` also defaults to it; an explicit `--version` remains available when preparing a feed for an isolated Debug build or an existing release. `ACHBIT_BUILD_VERSION` applies only to isolated Debug builds and leaves source metadata unchanged.

A version edit changes source metadata; Git operations, builds and publication remain separate authorized actions. Existing tags and published releases retain their historical identity. Release notes describe solved problems and user-visible changes; engineering evidence belongs in the development receipt.

### Daily source saves and pushes

Release means publishing product artifacts, not an ordinary code save. A request to commit, push or change the version does not implicitly request tests, compilation, a PR, merge, tag or Release.

For daily saves, use normal Git operations on the authorized development branch. Review all intended changes, group complete source changes by responsibility, stage explicit paths or reviewed hunks, inspect the staged diff, and write clear commit messages. Keep packages, logs, credentials and task-local inputs out of source commits. Synchronize a requested version with `scripts/version.py` in the development container and review its owned mirrors; a separate version commit keeps source changes reviewable.

Push only with explicit authorization, to the verified remote and branch, without force. Preserve existing work and hooks. Remote divergence requires an integration decision rather than an automatic rebase or merge. Report the commit/push range, final status and version separately from package or publication results.

If the user explicitly excludes tests or builds for a source save, honor that scope. Git scope checks and version consistency do not imply a test/build suite. Do not change test profiles or assertions, and do not present unexecuted validation as passed. Existing development validation and its failures retain their own evidence; a source save alone does not repeat them or rebuild a running installation.

### Automated submission and release

For an explicitly requested validated automation or artifact-publication workflow, use the host entrypoint `bash scripts/release.sh`. The agent fills in UTF-8 JSON text; `scripts/release.py` owns staging, grouped commits, version synchronization, tests, compilation and the selected remote operations within that activation. Do not manually duplicate those activated stages. This entrypoint is optional for daily source saves, and its `local` mode is not a no-test, no-build commit route.

| `mode` | Effects after `--confirm` |
| --- | --- |
| `local` | Grouped local commits, optional version commit, `test.sh required`, `build.sh --stage code`; no remote access |
| `pr` | Local flow, push to `origin`, create/update the matching open PR; no merge |
| `merge` | PR flow, merge commit, fast-forward the selected local source branch; no tag or Release |
| `release` | Merge flow, package explicit platforms from the merged commit, sign/feed, tag, draft/upload, publish and verify |

Prepare the development container with the existing `make shell` entrypoint. The script reads `container` and `workdir` from `make docker-info` (including `.achbit-worktree.mk`), then verifies the running container's exact source mount. Tests and general builds run inside that container with the installed Cargo/pnpm PATH; macOS packaging uses its existing host bridge. Remote modes require an authenticated `gh` and access to `origin`. The script does not install dependencies on the host, start replacement containers or restart applications.

A minimal local input is:

```json
{
  "mode": "local",
  "branch": "fix/my-change",
  "commits": [
    {
      "message": "docs: clarify the development workflow",
      "paths": ["docs/development.md"]
    }
  ]
}
```

`branch` must be the current non-protected branch. Each `paths` item is an exact repository-relative file, not a directory, glob or hunk. Groups must cover all current non-ignored changes exactly once; an existing staged index or unlisted change is rejected rather than silently included. Renames are represented by old and new paths. Use `"commits": []` for already committed, clean source. Optional `version` and `version_message` delegate synchronization to `version.py` and produce a separate version commit only if its owned files change.

For `pr`, `merge` or `release`, also fill in `base` and `pr`:

```json
{
  "base": "main",
  "pr": {
    "title": "Release <version>: <user-visible changes>",
    "body": "## 变更\n<changes>\n\n## 验证\n<completed checks and planned automated checks>\n\n## 发布\n<intended scope>"
  }
}
```

This fragment is merged into the same input object; replace placeholders with the authorized version and actual changes. `release` mode additionally requires:

```json
{
  "release": {
    "title": "Release <version>",
    "notes": "<solved problems and user-visible changes>",
    "platforms": ["macos", "windows", "linux"],
    "prerelease": false
  }
}
```

Select only requested platforms; every selected platform must build successfully. PR and Release text are passed as actual UTF-8 files to `gh`, then read back and compared. Do not describe the workflow's future checks as already passed. The supplied PR title/body also provide the merge commit text. Public notes exclude test counts, TCRs and build receipts.

```bash
# Read-only plan: no version writes, commits, container work or remote requests.
bash scripts/release.sh --input .task-artifacts/submission.json

# Execute only the scope authorized in that input.
bash scripts/release.sh --input .task-artifacts/submission.json --confirm
# Optional: --output .task-artifacts/my-submission (must not already exist)
```

`--confirm` activates local effects too; it does not grant authority beyond the user's request. There are no `--skip-tests`, `--from` or `--resume` flags. One activation owns one `required` run and one code build; do not duplicate them manually. Reuse separately completed package acceptance without expanding it into a new full suite, real-model conversation or all-platform acceptance matrix. For ordinary source saves that exclude validation/builds, use the daily Git route above instead of activating this workflow. If the user explicitly requests this automated workflow while forbidding one of its mandatory stages, explain that capability conflict rather than inventing a skip flag or interrupting the run to simulate one.

The program uses merge commits, never force-pushes or bypasses repository checks. The remote base must already be an ancestor of the source. The pushed head is pinned for merging; if GitHub queues the merge rather than completing it, the workflow stops before packaging/tagging. If the actual merge tree differs from the validated source tree, it also stops. Packages are built after the merge from that exact merge commit, not relabeled pre-merge binaries. Only the selected local source branch is advanced; unrelated local branches/worktrees are untouched.

By default, source branches are retained. If repository policy deletes the remote source branch on merge, the program requires explicit authorization via `"allow_remote_branch_deletion": true`; it never deletes the local source branch. Temporary test-branch cleanup is a separate, explicitly authorized action.

Each activation writes `input.json`, per-stage logs and `receipt.json` under a new `.task-artifacts/submission-<timestamp>/` directory. Release output is isolated in its `bin/`, not the running application's `bin/`. A failure preserves local commits, remote effects and the original exit status; it does not roll back or blindly replay. An existing output directory is rejected. Inspect the receipt and resolve the failed operation before defining another authorized invocation; this initial entrypoint does not resume partial remote releases. Interrupts stop owned host/container processes; an unconfirmed container cleanup retains its PID evidence and release lock for diagnosis.

Publication first uploads the complete requested asset set to a draft, compares names/sizes and stored notes, then publishes and downloads the feed for comparison. Stable releases are checked against the remote latest-release record; prereleases are not marked latest. A passed fixture test or successful build does not establish live GitHub delivery, signing, native GUI startup or real-provider acceptance. Report those evidence levels separately. Preserve existing installations, auto-update preferences and unrelated sessions; cache cleanup is not a release requirement.

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

For macOS local development, including forks, run `bash scripts/setup-macos-signing.sh` once on the Mac before packaging. It prepares a persistent signing identity in your login Keychain. It does not require an Apple Developer account or put the private key in the repository or package. An existing identity can be selected with `ACHBIT_MACOS_SIGN_IDENTITY`. For a dedicated development keychain, configure the Mac-host signing profile described in [macOS signing](product/operations.md#macos-signing); setup then validates that profile, and subsequent native signing unlocks and explicitly selects its keychain.

Daily runtime builds reuse that identity and the existing application identifiers. They sign updated contents automatically and refuse to replace an existing App signed with a different certificate; they do not generate or rotate certificates, change keychain items or access policies, or reset system permissions. A configured dedicated signing keychain is unlocked before use.

To update only GUI resources in an existing package, run this on the host after preparing its container:

```bash
make ui-update UI_PACKAGE=bin/macos-arm64
```

For a separate worktree, also pass its `CONTAINER_NAME`. Select `bin/win64` or the generated Linux directory for those packages. macOS resource replacement runs on the host so signing can access its Keychain. Reload with **Cmd+Shift+R** on macOS or **Ctrl+Shift+R** elsewhere.

A GUI resource update does not replace TUI, Session, Kernel, or native launchers. Changes to those components or bundled product documentation need the corresponding build and a restart. See [update behavior](distribution.md#updates-and-configuration-changes).


## Automatic application updates

The native GUI uses `tauri-plugin-updater` with a static GitHub Releases feed. The public verification key is compiled into `shells/achbit-gui/src-tauri/tauri.conf.json`; its production endpoint is `https://github.com/Achbite/Achbit/releases/latest/download/latest.json`. No application server is required. The first updater-enabled version must be installed manually by clients running 0.6.62 or earlier.

Package stages retain the normal archives/installers and add the updater's installation units:

| Feed target | Updater asset | Initial installation |
| --- | --- | --- |
| `darwin-aarch64` | `Achbit-<version>-macos-arm64.app.tar.gz` | Current-user PKG or an App in a writable directory |
| `windows-x86_64` | `Achbit-<version>-win64-setup.exe` | Per-user NSIS Setup |
| `linux-aarch64` / `linux-x86_64` | Corresponding `.AppImage` | Executable AppImage in a writable directory |

On macOS, Tauri checks, downloads and verifies the signed archive; Achbit stages the complete App beside its installation and owns bundle replacement. A failed replacement restores the previous App before restarting. If restoration fails, the backup and both errors are retained, and further updates and automatic restart stop until the installation is recovered. No administrator prompt is needed for the supported writable installation.

The Mac App contains the separately signed Computer Use helper in `Contents/Helpers`. The PKG installs in `~/Applications`, with wrappers in `~/.local/bin`. NSIS accepts Tauri's silent update and relaunch arguments; it waits for the installation lease and replaces only entries in `package-files.json`. Linux tar archives remain manual-update products. GTK/WebKitGTK and other existing system-library requirements still apply.

After building the intended release targets, sign their updater assets and create the feed on the host (the signer delegates to the configured Docker container). The following example includes the Linux architecture produced by an ARM64 development container:

```bash
release_version=$(python3 scripts/version.py show)
python3 scripts/package-updates.py sign \
  "bin/Achbit-${release_version}-macos-arm64.app.tar.gz" \
  "bin/Achbit-${release_version}-win64-setup.exe" \
  "bin/Achbit-${release_version}-linux-arm64.AppImage"

python3 scripts/package-updates.py manifest \
  --base-url "https://github.com/Achbite/Achbit/releases/download/${release_version}" \
  --artifact "darwin-aarch64=bin/Achbit-${release_version}-macos-arm64.app.tar.gz" \
  --artifact "windows-x86_64=bin/Achbit-${release_version}-win64-setup.exe" \
  --artifact "linux-aarch64=bin/Achbit-${release_version}-linux-arm64.AppImage" \
  --output bin/latest.json
```

For Linux AppImage creation, `package-updates.py` first uses `ACHBIT_APPIMAGE_RUNTIME` when explicitly set, otherwise an architecture-matching `.build-cache/*/runtime-<arch>` file if present. With neither, appimagetool retains its normal download behavior. An invalid explicit path fails instead of silently selecting another runtime. For host activation of the submission script, the explicit runtime must be inside the mounted checkout; the script maps it to its container path.

Keep the private signing key outside the checkout. The local signing command reads `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`; its macOS default is `~/Library/Application Support/Achbit-build/updater.key`. CI can supply the same key and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through secrets. Back up the existing key: changing the compiled public key does not make already-installed clients trust a new private key.

Prepare a draft Release, upload every initial installer/archive plus updater asset, its `.sig`, and `latest.json`, then publish and mark it as the latest stable Release. The feed must name only available platform assets. Its version and URLs identify the new product; publishing an empty or partially uploaded feed is not a completed release. Signing and manifest creation do not themselves push or publish anything.

The GUI checks after startup and every 30 minutes when the saved `gui.autoUpdate` preference is enabled (the default). Turning it off prevents scheduled checks and automatic installation; manual checks remain available from About Achbit. After verifying the download, it waits for input in the Achbit window to be idle for 15 seconds and for unsaved settings to be resolved. Activity in other applications does not reset the timer. Clicking the ready update arrow requests installation immediately. If the Host reports active Session or Kernel work, the GUI asks for confirmation before stopping it; unresolved settings and IME input also require confirmation. Cancelling the dialog leaves the task running. Confirmation uses the normal Session cancellation and settlement path, drains owned resources, and restarts into the downloaded update. Transient GUI loading flags and a persistent Host do not silently block a confirmed manual update. Automatic Host preparation gates new external work and checks Session activity, Kernel work and connected clients. Manual preparation still gates admission and rechecks actual work before shutdown. A filesystem lease covers other CLI/TUI/Host processes using the same installation, even with different user roots. Manual updates stop the owned Host before waiting for its clients to release that lease; an independent instance that keeps the installation open is reported explicitly. Automatic installation is owned by a local GUI with a managed Host. SSH and connect-only windows do not initiate an installation; close them before updating the local installation. A persistent Host blocks automatic installation until explicitly stopped. Only after preparation and a confirmed Host shutdown does the updater replace program files. Drafts and view state are restored before React mounts; Session facts are reloaded from the existing store.

For a local macOS Debug upgrade, build two distinct versions through the existing Docker/native bridge:

```bash
release_version=$(python3 scripts/version.py show)
ACHBIT_BUILD_VERSION="${release_version}-debug.1" bash ./build.sh -debug --stage package-macos
# Preserve this bin/debug/macos-arm64 in a separate test installation.
ACHBIT_BUILD_VERSION="${release_version}-debug.2" bash ./build.sh -debug --stage package-macos
```

Sign the second App archive and serve it with a generated static feed from a loopback-only HTTP server. Start the first Debug App with explicit `ACHBIT_USER_ROOT`, `ACHBIT_DEFAULT_WORKSPACE` and `ACHBIT_DEBUG_UPDATE_URL`, then use `achbit-debug attach` with that state root and an absolute test-workspace path. This exercises the normal GUI-owned automatic Host lifetime. `achbit-debug launch` intentionally creates a persistent Host and therefore is unsuitable for an automatic idle-shutdown acceptance run; a confirmed manual update can stop that Host. Debug updates are disabled unless the loopback endpoint is explicitly supplied; production builds do not read that override. Current local Debug packaging supports this updater chain on macOS; Windows Debug ZIPs are not NSIS update assets.

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

Function-tool usage travels with the active wire declaration and its prepared binding. A selected Host product component can contribute stable text to that declaration with `SessionProductComponent.toolGuidance`. On-demand resources use a `contributionId` to join the originating user message or tool result; the journal model view freezes that contribution once sent. Skill entry paths follow the same message/result path, so selecting or reading a Skill does not rewrite core tool declarations. The contributor receives the tools in the current stage and is shared by the main request and compaction. Tool availability, schemas and authorization remain owned by their existing producers.

Product guides are ordinary Markdown files under `productDocsPath`. When selected, the product operations component contributes an on-demand documentation index using the run’s actual product guide directory, including the plugin interface guide under `../plugins/README.md`. The component also supplies Shell resource details after the product or iteration Skill is selected or read. Search and read the guides with Shell; packaging copies `docs/product` into runtime resources. Built-in Skills/references remain registered in `local_agent_product_tools.rs`. Rebuild/restart the owning Host after changing bundled resources. Keep long-lived guidance separate from task receipts.

### Loop assembly

The standard driver follows the request → tools → follow-up/settlement shape of [PI's agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts). `local-agent/loop.ts` owns orchestration and terminal recovery. `loopProvider.ts` owns stream interpretation, `loopTools.ts` owns Kernel dispatch/cancellation, `loopTurn.ts` owns control and answer settlement, and `loopContext.ts` owns request budgets and optional summaries. `loopCapabilities.ts` owns per-turn implementation leases. Existing journal facts, execution identities and resource ownership remain authoritative.

`SessionConfigurationRegistry` instantiates only the selected context, controls and compaction implementations. `AgentLoopRegistry` selects installed drivers; it does not load code from model-supplied paths. This follows the service ownership and explicit composition separation in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md), using Achbit's existing registries rather than another plugin runtime.

A minimal read-only `AgentRecipe` is:

```json
{
  "runner": { "id": "standard", "parameters": { "toolExecution": "parallel" } },
  "configuration": {
    "context": { "id": "coding" },
    "compaction": { "id": "none" },
    "controls": { "id": "none" }
  },
  "tools": { "kernel": ["fs.read"], "controls": [], "plugins": false },
  "productComponents": []
}
```

Add the available shell, `fs.edit` and `fs.write` to the selected Kernel tools when the task needs them; the existing permissions still apply. The coding context exposes their actual read/shell/edit/write wire names and generates guidance only for the declared tools, following [PI's tool-aware prompt assembly](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts). Add `controls: {"id":"standard","parameters":{"optionalTools":["todo.update"]}}` and select `todo.update` in `tools.controls` for progress. Select `compaction: {"id":"summary"}` for context summaries. The default product assembly also includes the existing Plan, interaction, Session, artifact and agent components according to the recipe and permissions. Context admission, cancellation and durable recovery remain active in the minimal assembly. The minimal preset uses `controls=none`, `compaction=none` and `productComponents=[]`; manual Plan requires explicitly installing its controls. The standard driver's `toolExecution=parallel` policy follows PI's batch scheduling: ordinary calls may overlap, only same-file mutations queue, and a failed predecessor does not skip its successor. Omitted `toolExecution` retains the full product's bounded, ordered file phases.

All contexts use one ordered system-prompt composer: preamble, tools/rules, docs, selected response/product/environment additions, project_context and cwd. The core factory, tool guidance and documentation index each own shared base sentences; full-context details are inserted between those sentences or sections rather than replacing a minimal prompt with another copy. Coding context selects the base, while individual product and callable-tool capabilities can still insert their own contributions independently. Each selected product retains its contribution identity. Extension tool guidance stays in its tool declaration, and Skill locations stay with their originating selection/activation messages; dynamic activation does not rewrite the system prefix. Project contents use the same wrapper, with scope guidance inserted for the full context. Achbit identity, actual paths, captured Kernel scope descriptions and parameter limits remain authoritative. Both contexts project tools through the same binding-to-model path: captured Kernel operation text and schema, actual Shell scope/platform facts, then coding field aliases or full optional fields. Disabled Host execution removes its request field; an ungranted but requestable scope remains available. Third-party descriptions and dynamic guidance retain their existing owners.

Provider wire policy is resolved from the captured protocol/provider/model, never the context strategy. Responses routes use their supported instruction role, stateless and cache metadata; DeepSeek retains system-role authority and omits its documented ignored metadata. Session's coding codec, not a Provider wire flag, selects coding-only truncation feedback. Native Anthropic content keeps individual thinking/signature, redacted and tool-use blocks in the existing Provider turn and journal. Tool outcome is separate from text and maps to the protocol's error indicator where available. Actual reasoning output counts are optional subsets of total output, with aggregate coverage; missing counts remain unknown. Shared thinking rules in `userspace/protocol/src/modelThinkingPolicies.json` drive the existing model selectors and Kernel controls, including manual/adaptive Anthropic modes and Ollama levels. Unknown/unsupported choices retain errors rather than being silently clamped.

A coding Agent response truncated with identifiable tool calls records a failed attempt and failed turn with rejected raw inputs; none execute. Their error results feed a fresh request. Text-only truncation and other failures retain ordinary termination. This is a new logical request, not a transport retry or a claim that the truncated response completed.

For focused configuration debugging, `context-management.test.mjs` exercises bare read → result → answer, then adds controls and summaries through the same registry. `provider-stages.test.mjs` checks narrowed tool stages; `subagent-configuration.test.mjs` checks recipe propagation. Inspect `context.composed`, `provider.attempt`, tool results and `run.finishing`/`run.settled` in that order. A live managed process continues to belong to its owner; an assistant answer does not transfer process ownership or prove that the run has finished.

### Shared UI components and regions

Built-in GUI controls are registered in `userspace/gui/src/ui-components/index.ts`. Feature code imports from that catalog, first reusing existing controls and variants, then composing specialized controls, and only then registering new primitives. Registration retains the original React component identity. Geometry and interaction states belong to shared styles; business callbacks, localized copy and `useUiOwner` identities remain with their existing owners. See the [component guide](../userspace/gui/src/ui-components/README.md).

`userspace/gui/src/ui-plugins/slots.ts` is the declaration source for existing replaceable regions; the region type and built-in registrations derive from it. It does not replace the display-plugin runtime or expand its public contract. A shared primitive is not a new plugin slot.

### UI ownership declarations

New independently owned GUI controls use `useUiOwner('stable.semantic.name')` and spread `identity.part('trigger')` (or another local part) onto existing DOM elements. Keep the same instance on Portal roots, use different part names for distinct controls, and do not insert layout wrappers for diagnostics. Owners are not plugin slots or Session identities. Existing `UiRegion` / `UiPluginSlotView` boundaries are marked without changing their replacement scope; unmarked plugin internals inherit the region identity but explicitly report `plugin-internal-unmapped` implementation coverage, along with the current renderer identity. Build-time source extraction validates unique explicit owner declarations; repeated mounted instances are legal. Debug uses the existing registry and surface actions, not a second business store or model tool.

## Checks

TCRs, per-run acceptance reports and temporary preview/export scripts belong in ignored task output directories such as `.build-cache/` or `.task-artifacts/`. Keep them out of versioned product documentation and build tooling. Before a necessary test change, document its purpose and coverage in a TCR; preserve the existing assertions and failure semantics.

Run these inside the development container:

```bash
bash ./test.sh required   # Rust, build behavior, shared TS, TUI launchers, Session, GUI contracts/types
bash ./test.sh cli        # Required checks plus CLI → Session → Kernel integration
bash ./test.sh full       # Complete registered suite, including shared shells and document output
```

`bash ./test.sh static` checks version consistency, shell syntax and Git whitespace and can run on the host. A container snapshot without accessible host-owned Git metadata reports that diff check as skipped; run it on the host separately. Skipped checks are not passing checks.

On Windows, `node --test scripts/tests/windows-installer.test.mjs` executes the replacement script with Windows PowerShell 5.1 against disposable installations. It covers fresh installation, upgrades, ownership preservation, and rollback. The cross-volume case requires the checkout and TEMP to be on different volumes; otherwise that case reports a skip.

The end-to-end suite uses local fixture providers; its results do not establish real-provider connectivity or native desktop behavior. For explicitly requested standard-package/installer acceptance, use the target package for a real CLI conversation and TUI/GUI startup. A Debug test package alone does not require those checks. Documentation-only changes use static and content/link checks without rebuilding the runtime.

The native GUI has a separate Cargo workspace at `shells/achbit-gui/src-tauri/Cargo.toml`. Windows dedicated-console font verification requires an interactive Windows desktop: set `ACHBIT_TEST_TUI_FONTS` to the extracted terminal TTF directory and `ACHBIT_TEST_TUI_RESULT` to a new receipt path, then run `cargo test -p achbit-tui windows_terminal::tests -- --include-ignored --test-threads=1`. It creates its own console and checks the bundled families and system font; ignored tests or an earlier receipt do not establish a new result.

### Plugin checks

Build the plugin entry with its own dependencies, then import its directory or manifest into an isolated Debug instance using the [plugin interfaces](plugins/README.md). Exercise discovery, the affected invocation or service handshake, and owned-resource cleanup. For service lifecycle changes, check port release and the intended persistent state across restart. Use [Debug control](debug-control.md) for direct tool/UI operations; a plugin using an existing protocol does not require unrelated platform checks.

### Windows desktop checks

Choose the capture, UI Automation or physical-input route affected by the change. Record the initial state, action and resulting state before a reload or another driver changes the target. CDP reads may corroborate desktop input; CDP mutations do not exercise Windows mouse or keyboard input. Check preview feedback or stop/release behavior only when it is part of the change.

For an external Chrome experiment, use an owned instance with a unique profile and task-scoped temporary directory. A browser that outlives a Shell call must not depend on that call's TEMP/TMP directory. Inspect the exact instance and page before CDP commands, retain its PID, and close only the instance created for the check.

PowerShell verification scripts should stop on errors and check native command exit codes. Distinguish a rejected action from dispatched input followed by an observation failure; preserve the original result before deciding whether another action is appropriate. A foreground query after activating a window cannot establish which window had focus before activation.

## Contributing

Read the effective project instructions before changing source or tests. Keep changes scoped to their behavior and run the relevant registered checks. Use the current agreed branch, PR and merge policy for the intended delivery; the [version and delivery workflow](#version-updates-and-delivery) separates source synchronization from package publication. Product operation details belong in the [product documentation](product/operations.md), while version changes belong in [Release notes](https://github.com/Achbite/Achbit/releases).
