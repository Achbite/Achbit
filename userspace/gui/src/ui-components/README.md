# Shared GUI components

`index.ts` is the built-in component catalog and import entrypoint. `UI_COMPONENTS` pairs each name with its actual implementation, purpose and optional composition base. Named exports resolve those same functions; registration adds no React wrapper, global instance store or lifecycle. Existing modal, select, switch, resize and icon implementations are reused rather than copied.

## Reuse before adding

1. Look up `UI_COMPONENTS` before writing a control. Import components from `ui-components`, not their implementation files. Icon names, props and `UI_ICON_ROLES` are exported here too; the existing `AchbitShellIcon` name is an identity-preserving alias of the same `UiIcon`.
2. Use the existing props first: Button variants (`ghost`, `secondary`, `primary`, `danger`) and control sizes (`compact`, `standard`, `large`).
3. Compose a small specialized component when a semantic use needs fixed defaults. `CloseButton → IconButton → Button` is the example. Keep ordinary feature layout local; do not subclass React components or copy their chrome.
4. Register a genuinely new reusable component in `UI_COMPONENTS` and expose its typed named export. Register a composition's `base` when applicable. Component-local imports may use implementation files to avoid catalog cycles.

```tsx
import { CloseButton, PanelHeader } from '../../ui-components';

function DetailsHeader({ title, closeLabel, busy, onClose }: {
  title: string; closeLabel: string; busy: boolean; onClose(): void;
}) {
  return <PanelHeader>
    <h2>{title}</h2>
    <CloseButton aria-label={closeLabel} disabled={busy} onClick={onClose} />
  </PanelHeader>;
}
```

Labels and tooltips arrive localized from the owner. Icon-only controls require `aria-label`. Native refs, form attributes, event handlers and `data-ui-*` ownership/action markers pass through to the real control. The default button type is `button`; submitting forms opt into `type="submit"`.

A close glyph does not decide what closing means. The owning feature retains view dismissal, tab closure, plan cancellation, question skipping, resource cleanup and error handling. `ModalDialog` continues to own modal focus containment, return focus and busy dismissal rules. Primitives add no Session mutations or independent keyboard-dismissal layer.

Review each new or changed operation, including changes within existing files and author-controlled preview sources. Match its behavior to the catalog, compose existing controls where only their layout differs, and keep domain-specific state with its feature. Record the concrete reason for a distinct interaction when a reusable control does not cover it. A new reusable family has one typed entry in this catalog.

## Appearance

`controls.css` owns primitive geometry and states. `achbitDesignTokens.css` owns control size, icon size, spacing and radius variables; colors continue to come from the existing `config/ui/palette.json` semantics. Feature classes position controls and headers, but must not redefine their hit targets, glyphs or hover/focus/disabled chrome. Native window controls and content-specific image controls remain separate from ordinary panel actions.

`DisclosureSummary` renders a native `summary` with the shared decorative chevron for ordinary content disclosures. Its parent `details` retains open state and native keyboard/toggle behavior; refs, events, localized children and owner/action attributes pass through. Use `chevronPosition="leading"` when a compact settings label leads with the arrow. The default places it after the label. Feature styles retain placement and surrounding layout. Menus, tree navigation and already specialized disclosure controls keep their existing interaction policies.

## Framework layers and entry points

Start with the owner of the change. Source paths in this table are relative to `userspace/gui/src`.

| Layer | Where to work | Registration or contract |
| --- | --- | --- |
| Theme and assets | [theme](../theme), [icons/registry.tsx](../icons/registry.tsx), [design tokens](../achbit-gui/styles/achbitDesignTokens.css) | `config/ui/palette.json` owns published color keys. Typography and palette settings own applied variables. `theme/nativeControls.css` styles native controls and scrollbars. Shared React control chrome is in [controls.css](controls.css). |
| Shared UI components | [index.ts](index.ts) and the implementation beside it | Ten current components in six families (action, input, disclosure, layout, dialog, icon). Use the exported name and family. `base` records composition. Glyph definitions live in the icon catalog. |
| Cross-feature interactions | [components/shared](../components/shared), [useDismissibleLayer](../components/shared/useDismissibleLayer.ts) | Focus modality, dismissal, resizing geometry and auto-dismiss are shared behaviors. Feature controls supply trigger, roots, timeouts, text and callbacks. |
| Workbench and containers | [AchbitWorkbenchLayout](../achbit-gui/layout/AchbitWorkbenchLayout.tsx), [workbench styles](../achbit-gui/styles/achbitWorkbench.css), [transcript viewport](../components/local-agent/useConversationViewport.ts) | The workbench owns the grid, sidebar, settings pane and layout regions. The feature viewport owns scrolling, restoration and bounds. Reader width and overflow belong to its pane. |
| Feature presentations | [conversation and Reader](../components/local-agent), [settings and model services](../components/settings-center), [folder selection](../components/workspace-open-dialog), [window controls](../components/window-controls) | Keep views, their local components, styles and hooks with the feature. Shared text rendering enters through [presentation](../presentation). |
| View state and services | [state](../state), [services](../services) | Stores own drafts, selections, cached reading state and transient notices. Services own requests, subscriptions and Host adapters. Session owns committed conversation facts. |
| Display extensions | [slot catalog](../../../../config/ui/plugin-slots.json), [React region mount](../ui-plugins/UiRegion.tsx), [runtime](../ui-plugins/runtime.ts) | The catalog drives Host admission and discovery, GUI types, built-in regions and settings contribution selection. Installation and rendering use the same public IDs. |
| Diagnostics | [useUiOwner](../ui-ownership/useUiOwner.ts), [Debug collector](../debug/registry.ts) | A mounted owner declares stable action/part identities. It supplies observations from the actual instance and unregisters on disposal. |

### Component and surface names

| Responsibility | Naming and example |
| --- | --- |
| Reusable control | PascalCase by interaction, e.g. `IconButton`, `NativeSelect`. Keep its implementation, styles, catalog entry and typed exports together. |
| Feature presentation | Name the subject and the interaction, e.g. [ModelSettingsHelp](../components/settings-center/model-services/ModelSettingsHelp.tsx) or [UsageCost](../components/settings-center/model-services/UsageCost.tsx). Standard control props carry focus, refs, accessible names and business callbacks. |
| Layout, pane, dialog and menu | `Layout` arranges regions. A pane or panel owns a bounded area. `Dialog` carries modal focus. `Menu` offers actions. For example `.achbit-gui-settings-panel` occupies a workbench grid cell and uses the existing native-overlay marker. `ModelPickerDialog` uses a native dialog inside settings. |
| Hooks and utilities | `use…` for a React lifecycle, e.g. `useSettingsHelp`. Describe the value or effect of pure helpers, e.g. [usageFormatting](../components/settings-center/model-services/usageFormatting.ts). Keep imported names explicit at a call site such as `requireServiceData(response)`. |
| Public and diagnostic identities | Slot IDs name extension points (`composer.model`, legacy `navigation`). Owner, action and DOM part IDs identify a mounted interaction. Preserve existing manifest, settings and Debug IDs when reorganizing implementation files. |

### Slot roles

Each key in the [shared catalog](../../../../config/ui/plugin-slots.json) is an existing public ID. Its single role defines how it participates. `region` gives a built-in replaceable region. `view` selects a display renderer. `settingsContribution` composes installed sections in order. `toolResult` selects per tool ID. `theme` applies scoped styles. The Host exposes the same ID order through development discovery. [slots.ts](../ui-plugins/slots.ts) derives the frontend types and region list. `useUiOwner` exposes diagnostics for actual mounts. New public extension points follow the [display plugin contract](../../../../docs/product/ui-plugins.md).

### Drawing order

[Workbench styles](../achbit-gui/styles/achbitWorkbench.css) define the ordering of the grid surface, titlebar, navigation and feedback inside the workbench. [Window layers](../theme/windowLayers.css) order body-level update notices, navigation and path menus, permission menus and appearance errors. Their names describe the presenting surface. Sticky table cells, card decorations and relative positions inside a component keep local stacking values. Native dialogs and manual popovers use the browser top layer and their actual opening order. A platform child WebView has a separate drawing surface. Declare an intersecting obstructing element with the existing `data-native-overlay` marker when it should cover that view. [Native view bounds](../components/local-agent/nativeBrowserLayout.ts).

## Containers and feedback

Identify the element that determines available width, the node that scrolls and the surface that owns focus. For a resizable pane, derive layout from its own bounds. Keep horizontally overflowing code or tables inside their content region. Recheck the same control with the sidebar, Reader or settings dialog open.

| Interaction | Owner and observable result |
| --- | --- |
| Enter or revisit a conversation | The transcript viewport owns the body anchor, offset and distance to the tail. The navigation rail owns the visible range of ticks. Check both after a jump and after switching away and back. |
| Submit a message | Composer owns input and immediate feedback. Correlate the command receipt, Session commit, projection and matching message in view through their existing identities. Handle a reply after a switch in the originating session. |
| Show help inside settings | Short descriptions use the shared settings help surface. A pointer can cross to the text. Escape closes the innermost active layer. The containing dialog owns modal focus and its eventual return. Interactive help uses a surface with focusable content. |
| Report a result or condition | Use the affected control for local feedback, the session's existing event area for transient session notices and the workbench banner for a persistent application condition. A decision that blocks progress belongs to its existing decision owner. Each owner handles dismissal, replacement and cleanup. |

### Choosing a feedback surface

Choose by the affected object, whether the condition persists, and whether the user must respond. The examples below identify current production owners. A window-wide toast queue, announcement inbox or cross-launch read receipt would require its own product contract.

| Surface and trigger | Layer and container | Dismissal, focus and accessibility | Current implementation |
| --- | --- | --- | --- |
| Tooltip. The user hovers over or focuses a control with a short description. | Anchor the description to its control inside the active panel or dialog. Settings uses a manual popover in the browser top layer. | Associate the control via `aria-describedby` and the text via `role="tooltip"`. Allow pointer travel to the text. Escape closes the hint while the outer dialog remains open. Put interactive content in a popover. | [SettingsHelp](../components/settings-center/SettingsHelp.tsx), [model settings trigger](../components/settings-center/model-services/ModelSettingsHelp.tsx) |
| Popover, listbox or menu. The user opens choices or commands for a specific object. | Keep the anchor, popup and any portalled roots in the same dismissal boundary. The theme listbox uses a manual popover. The sidebar menu is portalled to the document body. | Match the keyboard interaction to the role. The sidebar menu supports arrows, Home and End. The theme picker tracks the selected option. Outside pointer, focus leaving, selection and Escape follow the active surface. A keyboard dismissal returns focus as appropriate. | [ThemePicker](../components/settings-center/ThemePicker.tsx), [SidebarMenu](../achbit-gui/layout/SidebarMenu.tsx), [dismissal hook](../components/shared/useDismissibleLayer.ts) |
| Auto-disappearing toast or session notice. An operation emits a recoverable informational, success or warning result. | The current delivery surface is a stack in the originating conversation transcript. The store deduplicates by session and business key. Use the initiating control for feedback that belongs only to that control. | The session stack announces politely with `role="status"`, keeps focus in place and exposes a named close button. It defaults to eight seconds and three visible items per scope. Required actions or persistent errors stay with an actionable owner. | [UiEvents](../state/uiEvents.ts), [UiEventStack](../components/local-agent/UiEventStack.tsx), [local expiry](../components/shared/useAutoDismiss.ts) |
| Persistent banner or announcement. A condition remains relevant across the workbench. | The current interface-update banner occupies the named window update-notice layer. Its service owns availability and errors. A new publication channel would also need an audience and an acknowledgement policy. | The update notice remains while the service reports the condition. It provides a status region, keyboard-accessible reload action and expandable error detail. Any subsequent reload confirmation has its own decision and focus boundary. | [InterfaceUpdateNotice](../components/shared/InterfaceUpdateNotice.tsx), [update state](../services/interfaceUpdates.ts), [reload confirmation](../components/shared/InterfaceReloadDialog.tsx) |
| Blocking modal. The user must act before the operation can proceed, such as deciding whether to restart with unsaved work. | Open `ModalDialog` in the window that owns the decision. The native dialog establishes its modal top layer. The feature owns pending state, consequences and confirm/cancel callbacks. | Give the dialog an accessible name, choose its initial focus, contain Tab, respect busy dismissal and restore focus on close. An inner tooltip handles the first Escape. Keep both the decision and its error available for as long as they matter. | [ModalDialog](ModalDialog.tsx), [product update decision](../components/shared/ProductUpdateNotice.tsx) |
| Native desktop reminder. A newly completed run settles while the user is away. | The feature consumes new Host settlement events and the desktop shell selects delivery according to foreground state. The background reminder has its own native window. In the foreground the user's setting controls completion sound. | The background reminder opens without taking focus. Its labelled open and dismiss actions target the originating session or hide the reminder. A generation-checked timer hides the current reminder after eight seconds. Keep the conversation result reachable after expiry. | [completion event consumer](../achbit-gui/layout/useCompletionNotifications.ts), [native reminder](../../../../shells/achbit-gui/src-tauri/src/notifications.rs) |

Check keyboard and pointer input through the visible control. For cross-process diagnosis use the existing [Debug observation commands](../../../../docs/product/debug-control.md). An event without a DOM input has a programmatic source. When reporting that text was visible, combine the matching DOM geometry with an observation of the foreground window.

## Shared interaction policy

All application surfaces use the document-level `interactionFocus` policy (including portals). Pointer-opened panels focus a neutral container; genuine keyboard navigation keeps visible focus and restores its opener. After an outside pointer or Escape, only an unchanged, previously focused action is released. Editors, text selection, newer focus and business selection are not reset.

Transient, non-modal surfaces use `components/shared/useDismissibleLayer.ts`. The feature owns `open` and `onDismiss`; pass the anchor and every portal root in `roots`, plus `trigger` when Escape should restore it. The hook shares outside-pointer capture, focus-outside dismissal, Escape and listener cleanup; it adds no UI store or layer registry. Local nested-page/menu Escape handlers take priority via preventDefault/stopPropagation. Non-focusable hover help uses `escapeCapture: true` so its first Escape closes only the hint even while focus stays elsewhere. Native dialogs, IME composition and repeat Escape are not dismissed by a background layer.

| Surface | Owner / policy |
| --- | --- |
| Compact file-change card | `FileChanges`: explicit hover preview + pinned expansion; outside/Escape clears both. No CSS focus-within visibility. |
| Model and context usage | `SessionModelSelector`, `ContextUsageControl`: shared layer boundary; model subpage Escape remains local. |
| Attachments, permissions, plugin picker | `useAgentComposer`: include permission portal and plugin textarea in the corresponding boundary. |
| Hover/focus help | `SettingsHelp`: shared boundary with capture-priority Escape, no focus transfer. |
| Theme, diagram, file-tree and transcript path menus | Their feature owners use the shared hook; selection, errors, viewport layout and commands remain local. |
| Sidebar menus | `SidebarMenu`: shared dismissal, pointer/keyboard opening and arrow navigation. |
| Native modal dialogs / inputs / persistent content | `ModalDialog`, native editing controls and feature disclosure state; not outside-dismissed by the transient hook. |
| Standalone display plugins | Retain published plugin actions and owned listener/disposal lifetimes; do not import React internals into a plugin. |

For a new transient surface, check outside clicks (including stopped propagation), internal/portal clicks, Tab leaving, Escape priority, keyboard return, pointer cleanup, disabled/removed anchors and unmount cleanup. Visibility and `aria-expanded` must derive from the same state, never independently from `:focus-within`. Do not add per-feature document dismissal listeners or a blanket global blur to solve these cases.

## Validation

`tests/ui-components.test.mjs` verifies registration identity, composition, native attributes, accessible labels, owner callbacks and region selection. It also rejects feature imports and re-exports that bypass the catalog for registered shared controls or icons. The same import rule covers first-party manual fixtures. Run the existing GUI tests and typechecks in the development container; migrated controls retain their feature-level behavior tests. `tests/manual/ui-components.html` is a backend-free catalog fixture using the registered production components for desktop/narrow layout, button states, form submission, modal dismissal and focus return.

From the checkout in the development container, `pnpm --filter @achbit/client review:ui` lists changed controls, styles and nearby state changes against HEAD, including untracked GUI sources. Pass `--base <commit>` to review a branch delta and repeat `--source <absolute-source-file-or-directory>` to include author-controlled standalone previews. Each entry has a file and line for individual review. A catalog bypass fails the command. The remaining entries are design review prompts. Inspect the diff for deletion-only or nonliteral rendering changes.

Run `pnpm --filter @achbit/client test:ui-design` for the Chromium fixture suite. It exercises shared disclosure placement and native keyboard behavior, model drafts, and the inline/Reader preview at several pane widths, font sizes and zoom levels. Set `UI_EVIDENCE_DIR` to retain geometry and screenshots at a chosen path. Compare against the affected interaction’s contract and use the screenshots to judge hierarchy, type and spacing.

For a native Windows check, build the same fixtures in the container (`pnpm --filter @achbit/client exec vite build --config tests/manual/vite.config.ts`). In PowerShell, set `$env:CHROMIUM_BIN` to the Chrome or Edge executable and run `node userspace/gui/tests/manual/interaction-check.mjs` from the checkout. The runner defaults to `chromium` on PATH and uses a temporary browser profile.
