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

## Regions and ownership

These are complementary mechanisms, not interchangeable registrations:

- `UI_COMPONENTS`: shared implementation and composition catalog.
- `UI_REGION_SLOTS` in `ui-plugins/slots.ts`: existing replaceable regions. Both `UiRegionSlot` and the built-in renderer list derive from it. Their external plugin inputs, actions and replacement behavior stay unchanged.
- `useUiOwner`: instance/part/action identity and diagnostics. Business owners keep their existing declarations; primitives preserve the attributes rather than minting another business owner.

A new public region still needs an explicit plugin-interface decision. Do not add a slot for every button or introduce a second plugin runtime to achieve ordinary reuse.

## Design ownership map

| Concern | Canonical owner | Consumption and lifetime |
| --- | --- | --- |
| Shared controls and icons | `UI_COMPONENTS`, `icons/registry.tsx` | Import through this directory. `controls.css` owns primitive appearance; aliases preserve function identity. |
| Semantic colors and named themes | `config/ui/palette.json`, `theme/palette.ts`, `theme/themeLibrary.ts` | `main.tsx` installs defaults once; `PaletteOverrides` reads the shared settings store. Theme selection derives from applied colors. |
| Fonts and content sizes | `theme/typography.ts`, `GuiTypography.tsx`, `theme/builtinFonts.css` | GUI typography applies and cleans up root variables. Feature headings may adjust emphasis while body and inline content inherit the reading size. |
| Geometry and feature layout | `achbitDesignTokens.css` plus the owning feature stylesheet | Shared controls use semantic geometry tokens. Reader tabs, tree guides, content canvas and composer placement stay with `documentPreview.css` / `localAgentPanel.css`; derived tree colors use palette variables. |
| Replaceable business regions | `ui-plugins/slots.ts`, `UiRegion`, `UiPluginRuntime` | Region types and built-ins derive from one list. Manifest-declared registration is validated; view/module scopes remove styles and effects on replacement or unmount. Other content/settings slots remain in `UiPluginSlot`. |
| Text and rich content | `config/i18n`, `BufferedMarkdown` / `streamingMarkdown` | Owners provide localized labels. Conversation and Reader share Markdown, emphasis, links and math rendering. |
| Diagnostic identity | `useUiOwner`, `ui-ownership-sources.mjs` | Source locations derive from owner/region declarations. Actions annotate the actual control; the mounted instance unregisters on cleanup. |

A feature-owned native tab, tree row, input or progress graphic does not become a public primitive merely because it renders UI. Reuse the existing catalog for ordinary shared chrome, retain feature semantics at their owner, and add a reusable entry only when a distinct reusable control is needed. Static component exports and replaceable region registration serve different purposes; neither requires a second mounted-state registry.

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
