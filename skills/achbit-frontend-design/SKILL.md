---
name: Frontend Design
description: Design frontend pages, UI components and interactive HTML/CSS previews. 前端页面、组件与交互预览。
---

# Frontend design

Use this Skill for reusable UI lessons, design approaches and agreed product direction. Start from the target application's components, tokens, icons and interaction policies, then adapt them to the user's goal.

For Achbit GUI work or display plugins, read [Achbit UI design guidance](references/achbit-ui.md). For inline previews, read `achbit-documents` → `references/interactive-previews.md` with `skill.read`. Choose the references relevant to the task.

## Development approach

1. **Start with the owner.** Read the affected component, a nearby screen and their styles. Trace shared state to its producer and identify the consumers a change can affect.
2. **Reuse and compose.** Look through the shared catalog and extension points. Compose existing controls for specialized uses, register useful reusable controls in the existing catalog, and keep feature-specific layout with its feature.
3. **Design the complete interaction.** Consider drafts, selection, scroll, focus, loading, errors and disabled states together. Give asynchronous work a clear owner and preserve that ownership when the visible selection changes.
4. **Try it in context.** Inspect the assembled page and its neighbors, exercise the affected interaction, and refine the result. Choose checks according to the change's impact.

## Components, registration and lifetime

- Give shared implementations, extension slots, live plugin instances and diagnostic identities their own clear roles. Use the existing catalog, runtime and state owners for those roles.
- Reuse published inputs and actions when composing features. Derive types and consumer lists from existing declarations where the framework supports it.
- Register contributions in the framework's activation scope and connect cleanup to the owning view or module. Follow the framework's documented registration API.
- Release owned styles, listeners, subscriptions, timers and asynchronous work during replacement, disablement or unmount. Keep registration, action and cleanup errors available to their owner.
- Use the existing plugin-management path and distinguish installed, enabled, active and rendered states in its feedback.

## Visual and content decisions

- Put the task and its primary action first. Group related content through spacing, alignment and subtle surfaces. Keep secondary controls nearby and disclose details when useful. Stack panes on narrow screens.
- Reuse the page's typography, geometry, colors and icons. Compare related controls at actual size, including their borders, hit targets and focus indicators across states.
- Use short localized labels, tooltips and accessible names. Show status, errors, permission scope and meaningful consequences where people act. Put implementation explanations in development material or on-demand help.
- Preserve keyboard focus and reading position. Give long code, tables, diagrams and images suitable scroll or zoom behavior while keeping surrounding controls reachable.

## Boundary review by interaction type

Select the interaction types affected by the change and use one review format:

**Interaction type → Starting state and action → Boundary condition → Expected behavior → Observed result**

The examples below turn recurring UI problems into reusable review prompts. Choose relevant boundaries and record what actually happened, including any issue or scene left to inspect.

| Interaction type | Typical boundary conditions | Expected behavior to look for |
| --- | --- | --- |
| Input and editing | IME composition, empty/long text, neighboring rerenders, switching a model or opening a menu while typing. | Draft, caret and composition remain continuous; focus follows the user's action and text fits its editing area. |
| Menus, popovers and dialogs | Portal clicks, outside clicks with stopped propagation, nested Escape, Tab leaving, removed/disabled anchors, viewport edges, reopen. | The intended layer closes or remains open, focus returns appropriately, and controls stay reachable. |
| Selection, sliders and toggles | Minimum/maximum value, a single or empty option set, unavailable choices, rapid toggling and combined states. | Displayed value, available actions, hit targets and feedback follow the same owning state. |
| Disclosure and scrolling | Long commands/tables, expansion above the viewport, streaming while reading history, inner scroll reaching either end. | Reading position remains useful; inner and surrounding scrolling connect naturally; details remain available when reopened. |
| Zoom and rich-content viewers | Oversized or small content, constrained windows, zoom/reset, close/reopen and changed content. | Content fits or scrolls as intended, with reachable controls and coherent fit/reset behavior. |
| Asynchronous actions and decisions | Repeated activation, delayed or failed responses, changing Session/selection before completion, closing the initiating view. | Results and permission decisions stay with their initiating owner; pending and error feedback reflects the operation. |
| Plugin activation and replacement | Input update, hot replacement, disable/re-enable, conflicting registration or failed cleanup. | Published inputs reach the active view, owned effects follow its lifetime, and available restoration/error feedback is clear. |
| Responsive and theme changes | Narrow containers, long localized labels, theme/zoom changes and shared-control variants. | Content remains readable, focus and state distinctions remain visible, and primary actions stay accessible. |

Production-component fixtures help isolate interactions; the assembled application shows their behavior in context. Record the observation scope with the result. Keep reusable boundaries and expected behavior in this Skill, and the task's observations in its work record. Follow the project's existing test and delivery workflow with effort proportionate to the change.

## Keep this Skill aligned

When a change affects the design direction, component ownership, shared interactions or plugin lifecycle, point out the affected Skill section. Resolve any new product decision with the user, then update the guidance to the agreed direction. Routine refinements within that direction can proceed directly.

Keep durable lessons and reusable choices here, with application-specific guidance in the reference. Use concise, positive advice and state when it applies. Keep dates, revision IDs, one-off measurements and acceptance results in task records or Git history.
