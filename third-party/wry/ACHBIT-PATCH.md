# Wry 0.55.1 local focus fix

Source: the published wry 0.55.1 crate, upstream tag https://github.com/tauri-apps/wry/tree/wry-v0.55.1 . Upstream Apache-2.0 / MIT licenses are retained.

Only behavior change: src/wkwebview/mod.rs honors WebViewAttributes.focused before calling NSApplication.activate on macOS. Achbit creates embedded pages with focused(false); primary window creation retains the upstream default. No dependency version upgrade or OS activation interception is involved.

The GUI manifest uses a Cargo path patch so normal and Debug native builds use the same fix. Remove this copy when the pinned upstream release provides the same behavior. See achbit-focus.patch for the small source delta; the other code files remain upstream source. SECURITY.md has one trailing space removed. The zero-context patch can be applied with git apply --unidiff-zero.
