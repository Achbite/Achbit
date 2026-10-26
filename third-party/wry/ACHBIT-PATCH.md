# Wry 0.55.1 local patches

Source: the published wry 0.55.1 crate, upstream tag https://github.com/tauri-apps/wry/tree/wry-v0.55.1 . Upstream Apache-2.0 / MIT licenses are retained.

The local patches retain the pinned dependency version:

- [achbit-focus.patch](achbit-focus.patch): `src/wkwebview/mod.rs` honors `WebViewAttributes.focused` before calling `NSApplication.activate` on macOS. Achbit creates embedded pages with `focused(false)`; primary window creation retains the upstream default. No OS activation interception is involved.
- [achbit-warnings.patch](achbit-warnings.patch): replaces deprecated macOS modifier-key constants with the equivalent `NSEventModifierFlags` values and reads dropped file URLs through `NSPasteboard.readObjectsForClasses:options:` with the file-only option. Multiple file paths remain supported. It also scopes the `NSObject` import to its consumers, keeps the download error available to debug logging, and removes redundant `unsafe` blocks. Compiler warnings remain enabled.

The warnings patch also replaces Linux `run_javascript` calls with `evaluate_javascript`, preserving the default script world and JSON callback results. Its WebKitGTK feature requirement is explicit at `v2_40`, matching Achbit's existing Tauri 2.11 requirement; no dependency version or product platform requirement is raised. API references: [Apple pasteboard reading](https://developer.apple.com/documentation/appkit/nspasteboard/readobjects(forclasses:options:)), [WebKitGTK script evaluation](https://webkitgtk.org/reference/webkit2gtk/stable/method.WebView.evaluate_javascript.html).

The GUI manifest uses a Cargo path patch so normal and Debug native builds use the same fixes. Remove this copy when the pinned upstream release provides equivalent behavior. Apply the patches in the order above; both patches use zero context and require `git apply --unidiff-zero`. Other source files remain upstream code. `SECURITY.md` has one trailing space removed.
