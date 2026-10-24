# Update and verification entrypoints

Use the actual checkout, container mount and running target. Choose one update path appropriate to the change; this is not a sequence to run in full.

| Change | Update path |
| --- | --- |
| GUI source | `make dev-achbit-gui`; open its actual development URL and retain that page for Vite HMR |
| TypeScript display plugin | `make ui-plugin UI_PLUGIN=<repo-relative-dir>` or `make ui-plugin-watch`; the enabled compiled entry is hot-replaced |
| Display manifest or compiled module | Save the selected source; the Host replaces that module |
| Packaged GUI resources | `make ui-update UI_PACKAGE=<actual-package-dir>`, then reload that interface |
| Selected external Skill / CLI plugin content | Captured before the next model request; existing calls retain their binding |
| Saved runtime configuration | Captured by the next run; permission revocation still applies before execution |
| Session, Kernel, native shell or compiled-in docs/Skills | Build the affected runtime and restart only the authorized target |

Interface reload uses Cmd+Shift+R on macOS, Ctrl+Shift+R elsewhere, or `browser.page` with `action: refreshInterface`. `scheduled` is queued; `needsUser` requires user handling of unsaved changes. `openSelf` opens packaged resources, not source HMR.

## Debug verification

Through the project container, use `bash ./build.sh -debug --stage package-macos` or `--stage package-windows`. Control the resulting isolated package with `achbit-debug`; read `debug-control.md` in `productDocsPath` for commands.

- Tool behavior: direct `tools call` and its operation result.
- GUI behavior: `surfaces inspect`, `action`, a relevant result condition and screenshots only when needed.
- Session/Provider/reviewer behavior: a minimal `task submit --follow` scenario, or follow an existing task.
- Historical evidence and timing: `result read`, `task inspect`, `metrics query`; avoid status polling.

Verify the target GUI/Host loaded rebuilt code. Reopening a GUI can reconnect to an old Host. Release only test-owned resources.

## Check scope

For code changes, run the applicable project checks; the baseline is `bash ./test.sh required` in the development container. Select `cli` or `full` only when those paths are affected or explicitly requested. Preserve the project's test-change rules.

For documentation-only changes, use static, link and command/schema checks. Compiled-in guidance takes effect after a later runtime rebuild/restart; that fact does not authorize building now.

A Debug test package is not a standard installer delivery. Real CLI conversation and TUI/GUI package smoke checks belong to explicitly requested standard-package acceptance or changes to those entrypoints. A fixture proves its controlled scenario, not real-model connectivity. Missing broader evidence is not a requirement to expand the task. Stop after the agreed behavior is established.
