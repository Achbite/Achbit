# GUI component management

These rules supplement the repository's parent `AGENTS.md`.

- Before adding a UI control, inspect `src/ui-components/index.ts` and its README. Reuse the catalog's existing component and variants first; compose it for a specialized use. Register genuinely new reusable controls in that same catalog rather than copying JSX/CSS or subclassing React components.
- Feature code imports registered primitives through `ui-components`. Implementation files inside that layer may directly compose each other. Preserve existing component identities, refs, accessibility, owner/action attributes and callback semantics.
- Primitive appearance belongs to the shared component styles and semantic tokens. Feature styles own placement and content layout. Keep localized labels and business decisions with the feature owner.
- Replaceable business regions continue to use `UiRegion` / `UiPluginRuntime`. `ui-plugins/slots.ts` owns the existing region declaration list. Do not turn every DOM node into a plugin or expand a public slot interface without the required decision.
- `useUiOwner` is diagnostic identity, not a component factory or a state store. Do not add a parallel registry of mounted business state.
- Keep GUI typechecks, builds and tests in the verified project development container. Preserve the existing behavior checks when moving native controls behind shared components.
