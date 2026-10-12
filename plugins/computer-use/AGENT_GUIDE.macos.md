## Desktop control (macOS)

Native screenshots and `computer.control` require macOS. Observation and input require Accessibility and Screen Recording; pure capture needs only Screen Recording. Missing access is reported, not changed by the tool. `status` reports the actual executor permissions.

Identify the target with `listApps` / `listWindows`. `app` is the exact bundle identifier, such as `com.google.Chrome`, not the display name. For pixels only, `capture` takes exactly one `windowId` or `display=primary` and does not create an actionable observation. For interaction, `observe` requires `app`; an exact `windowId` defaults to background mode. App-only observe uses the focused window in foreground mode. Explicit `mode=foreground` permits focus restoration.

Every input action requires `app` and a fresh `observationId`. `press` also needs an exact `elementId`; `setValue` needs `elementId` and `text` and replaces the AX value rather than typing. These AX actions do not inject global input or fall back to mouse/keyboard events. `click`, `type`, `key`, `scroll` and `drag` require a foreground observation and their action-specific fields. Coordinates are pixels in the returned window screenshot. Actions use the observed app process, window and run; changed or ambiguous targets require another observation.
