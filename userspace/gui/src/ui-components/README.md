# Shared GUI components

`index.ts` is the built-in component catalog and import entrypoint. `UI_COMPONENTS` pairs each name with its actual implementation, purpose and optional composition base. Named exports resolve those same functions; registration adds no React wrapper, global instance store or lifecycle. Existing modal, select, switch, resize and icon implementations are reused rather than copied.

## Reuse before adding

1. Look up `UI_COMPONENTS` before writing a control. Import components from `ui-components`, not their implementation files.
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

## Validation

`tests/ui-components.test.mjs` verifies registration identity, composition, native attributes, accessible labels, owner callbacks and region selection. It also rejects feature imports that bypass the catalog for registered shared controls. Run the existing GUI tests and typechecks in the development container; migrated controls retain their feature-level behavior tests. `tests/manual/ui-components.html` is a backend-free catalog fixture using the registered production components for desktop/narrow layout, button states, form submission, modal dismissal and focus return.
