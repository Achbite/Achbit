# Achbit UI design guidance

Use this reference for Achbit GUI work and display plugins. Source paths are relative to the selected checkout. For plugin authoring from an installed product, use the documentation path supplied by that runtime.

## Product design direction

Start from the current Achbit interface and the user's applied appearance settings. Inherit its design language for ordinary changes; use the current request and applicable user Skills to identify intentional departures. The general Skill supplies design methods, while this reference connects them to Achbit's existing owners and agreed interactions.

- **Task-centered workspace:** organize conversation, reading, editing and settings around their actual content and actions. Keep supporting controls near their context, and use disclosure when details are useful on demand.
- **Typography and density:** use the existing interface, reading and code typography roles and respect user font/size settings. Adjust grouping and layout to the information load while retaining readable text and usable controls.
- **Shared appearance:** compose the existing control variants, icons and geometry. Compare related controls in their actual surroundings, including hit targets, borders and focus states; use the source owners below for concrete values.
- **Semantic color:** inherit the applied palette and existing surface, text, action and state roles. Review the actual color combinations affected by a change, including selected, disabled and error states where relevant.
- **Useful content:** use concise localized labels and layout to explain routine actions. Add helper text for unresolved questions or meaningful consequences, while keeping real status, errors and permission scope at the point of action. Put design/implementation commentary in development material and longer guidance in on-demand help; apply the same content discipline to previews.
- **Continuity:** preserve drafts, selection, reading position and ongoing operations as panels, menus and Sessions change. Use the interaction lessons below to choose relevant observations.

## Existing owners

| Concern | Source owner | Preferred approach |
| --- | --- | --- |
| Shared controls and icons | `userspace/gui/src/ui-components/index.ts`, its sibling README, `userspace/gui/src/icons/registry.tsx` | Reuse `UI_COMPONENTS` and its typed exports. Register useful reusable controls with a purpose and composition `base` where applicable. Preserve component identity and native props. |
| Geometry, typography and colors | `userspace/gui/src/ui-components/controls.css`, `userspace/gui/src/achbit-gui/styles/achbitDesignTokens.css`, `userspace/gui/src/theme/typography.ts`; `config/ui/palette.json` | Use semantic tokens and shared control styles; keep feature placement in its owning stylesheet. |
| Replaceable business regions | `userspace/gui/src/ui-plugins/slots.ts` and its sibling `UiRegion.tsx` / `builtinRegions.mjs` | Extend `UI_REGION_SLOTS` and its derived consumers for an agreed public region. Other content/settings slots follow `userspace/gui/src/ui-plugins/types.ts`. |
| Display-plugin lifecycle | `userspace/gui/src/ui-plugins/runtime.ts` and its sibling `UiPlugins.tsx` / `source.ts` | Reuse `UiPluginRuntime`, published inputs/actions, registration handling and module/view disposal. |
| Diagnostic identity | `userspace/gui/src/ui-ownership/useUiOwner.ts` | Retain instance/part/action markers on actual controls, with business state remaining at its feature owner. |
| Shared interactions | `userspace/gui/src/ui-components/README.md`, `userspace/gui/src/components/shared/useDismissibleLayer.ts` | Follow `interactionFocus` and the shared dismissal hook. Let the feature own open state and supply its anchor and portal roots. |
| Locale and facts | `config/i18n`, the feature's existing store and Session projection | Localize labels at their owner and render shared facts, including operation errors, permission ownership and configuration activation timing. |

Start with `userspace/gui/src/ui-components/README.md` for the complete ownership map. Use the shared catalog for reusable controls, slots for replaceable regions, and local components for ordinary feature layout.

## Unified display-plugin management

The existing path is:

`achbit-ui.json` → shared Settings/CLI management → `workbench.uiPlugins` → `UiPluginRuntime` → declared renderer → owned cleanup.

Read `docs/product/ui-plugins.md` and `docs/plugins/README.md` for the interface details.

- Keep shared component implementations, extension slots, live plugin instances and diagnostic identities distinct, with business state at its existing feature owner. Derive types and consumer lists from the published declarations where supported.
- Export the supported standalone module with `apply(context)` and register its declared non-theme slots during activation. Let the runtime own registration lifetime.
- Give renderers `update(input)` and `dispose()`. Use the supplied `signal`, `onDispose`, `addStyle` and `reportError` for owned effects and their cleanup.
- Compose through public data and actions. Await asynchronous actions and surface their results. Use `scope.regions.mount` for published child regions so their Host-owned drafts, routing, scroll and native pages remain continuous.
- Match each slot's declared replacement or composition behavior. Surface duplicate IDs, conflicting owners and cleanup failures through the existing error path.
- Update the managed installation through the existing plugin operation. Distinguish installed, enabled, active and rendered states in feedback. Release owned styles, listeners, subscriptions, timers and asynchronous work with the owning view or module.

## Reusable interaction lessons

Review each newly introduced control, state or style in the changed code, including first-party previews. Look for an equivalent registered primitive or a composition, then describe the need for any distinct interaction. Mechanical checks enforce definite catalog and behavior contracts. Judge hierarchy, typography and novel compositions in the rendered layout. The GUI catalog README documents the incremental review and responsive browser commands.

Use the [interaction-type review format](../SKILL.md#boundary-review-by-interaction-type) with the relevant lessons below. Fill in the starting state, boundary condition and expected behavior for the affected surface, then record the actual observation in the task.

- **Focus and dismissal:** include portal roots in the interaction boundary. Give nested Escape handling a clear priority, return keyboard focus to the appropriate caller, and preserve editing and text selection during pointer cleanup. In Settings, Escape goes back one visible layer and closes Settings only from a top-level category; the Close settings button exits directly.
- **Stable inputs:** keep component identities and keys stable during neighboring updates. Preserve drafts, caret and IME composition through menu and model-selection transitions.
- **Async ownership:** keep permission decisions and directory/model responses attached to the initiating owner as the user changes selection or Session. For a delegated tool call or question, use the main composer’s regular permission or question panel, identify the child, and submit to that exact child request. Keep the current edit or decision available when a sibling publishes another item. Postponing returns to the original composer without answering or granting permission. Leave a configured model review uninterrupted until it hands the decision back; child Plan review remains separate.
- **Desktop lifetime:** distinguish closing a window from explicitly quitting the local shared Host. Place the one-shot Quit action in About, confirm active work or unsaved edits against the same Host, and leave remote Hosts alone.
- **Conversation preferences:** a new conversation copies the last explicitly edited model, effort and subagent configuration. Merely viewing or sending a message in an older conversation does not make it the new default. Reopening an existing conversation restores its own saved choices; never use the currently visible conversation as a write target for an older response.
- **Opening history:** Use the selected Session’s complete projection for continuous local scrolling and rail navigation. Open at the saved row and offset, or at the tail on a first visit. While the projection and model information load, show the conversation loading state. Place images in message order and load visible files in place. Reuse the mounted reading surface, decoded images and interactive previews when returning to a cached conversation. The output panel shows its own loading state while child deliveries are read. Keep drafts editable and restore received live text immediately, animating subsequent additions.
- **Conversation tool groups:** Keep consecutive calls in one disclosure within a run, including hosted searches as they move from live output to history. Keep visible text, plans, decisions and member notices in place. Use action descriptions without counts in the summary; preserve each call’s status, error and output in its detail. For an active background Shell, put one running marker immediately before the disclosure chevron. Only a Session-confirmed dependency wait moves that command’s status to the input area, with its output and single-command stop action; remove the duplicate row marker without moving the history or changing the draft.
- **Shared viewers:** coordinate image, Mermaid and table behavior for fit, zoom/reset, close/reopen and overflow. Keep continued scrolling connected to the surrounding conversation.
- **Combined states:** derive endpoints from actual capabilities and inspect meaningful combinations, such as highest effort with delegation on/off. Consider hit targets, contours and nearby controls together.
- **Previews in context:** use isolated previews to explore a treatment and production components to understand integration. Use the same shared controls in the preview’s own UI, including `DisclosureSummary` for expandable results. A preview of the current product imports the actual feature components and their styles. Supply fixture data and an isolated transport at their boundary. Keep an exploratory prototype and its proposed treatment identifiable.

## Maintaining the design direction

When the product's design direction, ownership, interactions or plugin-management choices change, flag the relevant Skill update and align the new direction with the user. Keep Achbit-specific choices and source entrypoints here, transferable design methods in the general Skill, and concrete token/component definitions at their existing owners.

Maintain the Skill in `skills/achbit-frontend-design/`; the product packaging process carries it and its references into the application. Keep build, test and runtime-update procedures in the project's development guides, and keep task-specific outcomes in the task record.
