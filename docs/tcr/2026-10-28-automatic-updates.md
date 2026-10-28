# Automatic updates TCR

## Purpose and scope

Implement the user-selected Tauri updater, adjusted distribution layouts, and automatic idle restart. The user authorized local Debug-package chain acceptance. Tests cover the update chain and GUI product behavior, not implementation mirrors or stress matrices.

## Behavior and pass boundaries

- Active or waiting Sessions and other Host clients defer installation. Preparing an update blocks new user work; abort restores admission.
- Unsent composer content and the current conversation survive a real process restart. Unsaved settings and current input defer restart.
- A local static feed and signed package drive the real Tauri updater from one Debug version to another, including download, verification, installation and automatic relaunch. Receipts use actual versions, PIDs and restored content.
- Invalid signatures and failed preconditions do not replace the running product and retain the original error.

## Execution record

The entries below distinguish source checks, local update-chain acceptance and unaccepted platform/release behavior.

Packaging-chain fixtures now assert the nested, independently signed macOS helper and current-user Installer domain, and retain CLI argument/user-directory propagation. The native build invocation fixture loads the real updater configuration generator. Existing Windows Setup compilation remains required. These changes follow the approved distribution contract; no existing behavior assertion is removed.

The first native upgrade retained version A and restored the draft after Host-exit waiting timed out. The shared Host releases its Rust Child handle after startup, so the updater must reap its exact OS child before checking detached processes. A real subprocess lifecycle regression test now covers that handoff; it does not mock the exit condition or weaken the shutdown receipt.

## Local verification (2026-10-29)

- `CARGO_BUILD_JOBS=1 bash ./test.sh required`: PASS, zero entrypoint skips. Includes the Rust workspace and Debug contracts, 43 packaging tests, GUI-resource publication, 351 Session tests, 312 GUI tests, GUI/manual typechecks and TUI launcher contracts.
- Final focused checks: updater Debug/native Linux and Windows GNU compilation, GUI typecheck, three update-state GUI tests and 43 packaging tests: PASS.
- Windows Host installation-lease code compiles for `x86_64-pc-windows-gnu`. The real NSIS compiler accepts the updated Setup script. This does not establish Windows installation or automatic relaunch behavior.
- The new real-subprocess regression passes after fixing exact-child reaping. Windows wait failures now propagate instead of being interpreted as process exit.
- Actual signed macOS Debug update `0.6.63-debug.3 -> 0.6.63-debug.4`: PASS. GUI PID `23826 -> 23954`; Host PID `23827 -> 23962`. The restarted GUI reported connected, package metadata and bundle version were `0.6.63-debug.4`, the original unsent draft was restored, and the consumed restart snapshot was removed. Deep/strict code-sign verification passed after replacement.
- A real pending approval and a real `bash` sleep operation deferred installation; there were zero main-provider requests. A corrupted package signature was rejected without replacement. The first native attempt exposed the Host zombie-wait defect; it stopped replacement, relaunched the original version and restored the draft. The defect was fixed and the complete upgrade rerun.
- `Achbit-0.6.63-linux-arm64.AppImage` was built through the real packaging entrypoint. Running the actual AppImage with `--appimage-extract-and-run --cli --help` and `--tui --smoke` succeeded with an isolated user root. This does not establish native Linux GUI or self-update acceptance.
- Some Debug UI action receipts reported incomplete animation-frame observation while the window was in the background. Subsequent structured inspection and the original screenshot confirmed the resulting draft/update state. No action was replayed merely to obtain a screenshot.
- The initial parallel Rust link was killed by the container memory limit; its log was retained and the same required profile passed with one build job. The first appimagetool URL was obsolete; it was corrected to the official 1.9.1 release, downloaded completely and digest-checked before execution.

Receipts and original logs are in ignored `.build-cache/updater-acceptance/`, including `acceptance.json`, `surface-d.json`, `identity-c.json`, `identity-d.json`, `gui.log` and `gui-fixed.log`. Check summaries are in `.build-cache/updater-required-tests.log`, `updater-final-focused.log`, `updater-child-wait-tests.log` and `updater-appimage-smoke.log`.

The updater can only commit with a managed local Host. SSH/connect-only windows do not initiate product installation and retain an installation lease until closed. The final source guard was checked in the native builds; no remote Host was stopped for this task.

This is local update-chain acceptance. It does not include a real-provider CLI conversation, Windows/Linux native GUI upgrade, installing the new PKG into the user's home, macOS notarization, or GitHub release publication. The existing standard macOS GUI/Host were preserved. Only task-owned Debug processes and the loopback feed are cleaned up; the stable private updater key remains outside the repository.

### Final packaged-source upgrade

The final generated manifest and signed artifact were exercised in a second successful real upgrade, `0.6.63-debug.4 -> 0.6.63-debug.5`. GUI PID `24441 -> 24513`; Host PID `24447 -> 24515`. The final native application reconnected, recognized itself as current, restored `Final updater acceptance: this draft must survive.`, consumed the restart snapshot and passed deep/strict signature verification. The structured receipt is `.build-cache/updater-acceptance/acceptance-final.json`; the final build log is `.build-cache/updater-debug-final-build.log`. Final test GUI/Host processes and the loopback server were stopped. The runnable final Debug package is `bin/debug/macos-arm64`, with the full archive and signed updater App archive in `bin/debug`.

### Release UI refinement (2026-10-29)

The user approved the sidebar download indicator above Settings after viewing an isolated frontend preview, and requested a circular progress ring only while downloading. The ring consumes the native downloaded/total facts; unknown totals use an indeterminate ring. Ready state returns to the plain download glyph. Failure details and retry remain accessible from the indicator. No test assertions or registered test profiles were changed for this visual refinement. The user explicitly waived repeat tests for the 0.6.63 release; frontend/native package builds and publication integrity checks are reported separately from the earlier acceptance above.
