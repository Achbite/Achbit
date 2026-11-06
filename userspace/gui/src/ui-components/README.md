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

## Appearance

`controls.css` owns primitive geometry and states. `achbitDesignTokens.css` owns control size, icon size, spacing and radius variables; colors continue to come from the existing `config/ui/palette.json` semantics. Feature classes position controls and headers, but must not redefine their hit targets, glyphs or hover/focus/disabled chrome. Native window controls and content-specific image controls remain separate from ordinary panel actions.

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

## Validation

`tests/ui-components.test.mjs` verifies registration identity, composition, native attributes, accessible labels, owner callbacks and region selection. It also rejects feature imports and re-exports that bypass the catalog for registered shared controls or icons. Run the existing GUI tests and typechecks in the development container; migrated controls retain their feature-level behavior tests. `tests/manual/ui-components.html` is a backend-free catalog fixture using the registered production components for desktop/narrow layout, button states, form submission, modal dismissal and focus return.
