# GUI component management

These rules supplement the repository's parent `AGENTS.md`.

- Before adding a UI control, inspect `src/ui-components/index.ts` and its README. Reuse the catalog's existing component and variants first; compose it for a specialized use. Register genuinely new reusable controls in that same catalog rather than copying JSX/CSS or subclassing React components.
- Feature code imports registered primitives through `ui-components`. Implementation files inside that layer may directly compose each other. Preserve existing component identities, refs, accessibility, owner/action attributes and callback semantics.
- Primitive appearance belongs to the shared component styles and semantic tokens. Feature styles own placement and content layout. Keep localized labels and business decisions with the feature owner.
- Replaceable business regions continue to use `UiRegion` / `UiPluginRuntime`. The shared `config/ui/plugin-slots.json` owns public IDs and slot roles. `ui-plugins/slots.ts` derives frontend types and the built-in region list. Do not turn every DOM node into a plugin or expand a public slot interface without the required decision.
- `useUiOwner` is diagnostic identity, not a component factory or a state store. Do not add a parallel registry of mounted business state.
- Use the [framework layers and naming guide](src/ui-components/README.md#framework-layers-and-entry-points) to place a component, hook, container or extension at its owner.
- For a change to scrolling, feedback or nested surfaces, use the container and interaction contracts in [the component guide](src/ui-components/README.md#containers-and-feedback). Check the normal user action and the owning surface together.
- Keep GUI typechecks, builds and tests in the verified project development container. Preserve the existing behavior checks when moving native controls behind shared components.
