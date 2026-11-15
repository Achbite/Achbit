---
name: Frontend Design
description: Design frontend pages, UI components and interactive HTML/CSS previews. 前端页面、组件与交互预览。
---

# Frontend design

Built-in Skills provide reusable methods and positive reminders on demand, keeping detailed guidance out of the always-loaded prompt. Follow the current user request; among Skills, applicable user-provided Skills take precedence over all built-in Skills, including this one. Use built-in advice to fill gaps within platform rules, agreed project contracts and granted permissions. Read only the Skills and references needed for the current decision.

For Achbit GUI work or display plugins, read [Achbit UI design guidance](references/achbit-ui.md). For inline previews, read `achbit-documents` → `references/interactive-previews.md` with `skill.read`.

## Start from the task and existing design

- Understand the audience, primary task, content, usage frequency and input environment. Let these guide reading order, density and interaction choices.
- **Inherit the existing design first.** Read a nearby screen and the target application's components, tokens, typography, icons and interaction policies. Carry that visual language into the change. Treat departures requested by the user or applicable user Skills as intentional updates, preserving the surrounding design where it remains relevant.
- For a new interface or an agreed redesign, derive a coherent direction from the brief, content and audience. Coordinate layout, type, color, imagery and motion around that direction. Minimal, expressive, editorial, playful and other treatments can all use the foundations below.
- Explain meaningful design choices briefly in task discussion or development material. Resolve routine details from the project; discuss alternatives when they materially change the agreed direction.

## Visual foundations

- **Hierarchy:** arrange information around the user's task. Use position, scale, weight and contrast to establish a reading order and recognizable primary actions; keep supporting choices discoverable.
- **Typography:** give text roles a consistent, reusable hierarchy. Adjust size, line height and line length to the font, language and content. Inspect real headings, prose, labels and data at actual size, including longer localized text.
- **Alignment and spacing:** establish shared alignment lines and a repeatable spacing rhythm. Keep related elements close and separate distinct groups; use whitespace, dividers, surfaces or independent containers according to the relationship being expressed.
- **Proportion and balance:** distribute space and visual weight according to importance. Symmetry, asymmetry, open space and dense layouts are all useful when their relationships support the chosen direction.
- **Color and surfaces:** use clear roles for backgrounds, text, actions and states. Check foreground/background combinations where they actually appear. Let emphasis support the task or brand, with labels or shapes helping convey meaningful states.
- **Density and adaptation:** fit information to the task through grouping, layout and progressive disclosure. As space changes, preserve reading order and access to key actions. Give long code, tables, diagrams and images suitable scrolling or zoom while keeping their controls reachable.
- **Imagery and detail:** use images, icons and decoration for explanation, recognition, narrative or brand expression. Coordinate their proportions, cropping and visual language with the content and neighboring controls.
- **Motion and feedback:** explain actions and spatial changes with purposeful feedback. Adapt timing and movement to the interaction and its frequency, keep content usable at rest, and respect reduced-motion preferences.
- **Purposeful copy:** let concise labels, clear grouping and familiar controls explain routine actions. Add helper text where it resolves ambiguity, explains a consequence or supports a decision; each note should add information beyond the heading or control label. Put longer guidance in on-demand help and design/implementation commentary in development material. Apply this to demos and previews as well as production screens, keeping explanatory small print focused on genuine user needs.

Use the project's accessibility target for contrast, keyboard operation, focus visibility, target sizes and text scaling. Provide meaningful accessible names and short localized labels; keep errors, permission scope and consequences visible where people act. Use standards-based measurements for the requirements they establish, and explain visual choices through their effect on reading, recognition and use. Concrete fonts, colors, dimensions and durations belong to the target design system.

## Develop and compose

1. **Locate the owner.** Read the affected component and styles, trace shared state to its producer, and identify directly affected consumers.
2. **Reuse and compose.** Use existing controls, variants, icons and published inputs/actions. Add useful reusable controls to the project's catalog where it has one; keep feature-specific layout and decisions with their feature.
3. **Design the complete interaction.** Consider drafts, selection, scroll, focus, loading, empty, error and disabled states together. Preserve component identity, editing continuity and the initiating owner of asynchronous work as visible selection changes.
4. **Match effects to lifetime.** Use the framework's registration and cleanup paths for owned styles, listeners, subscriptions, timers and asynchronous work. Keep action and cleanup errors available to their owner; follow the application reference for plugin-specific responsibilities.

## Review the result in context

Inspect the assembled interface with representative content and neighboring controls, then exercise the affected interaction. Compare the result with the inherited design and intended change. Explain refinements through reading order, grouping, proportion, density or recognition rather than a style label alone.

Keep visual review and behavior evidence complementary: rendered views support layout observations, measurements support specific requirements, and actual actions establish interaction results. Choose relevant themes, window sizes, text scales and states according to the change's impact. Record what was observed and what remains unverified; use the project's existing checks for applicable behavior contracts.

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

When a change affects the design direction, component ownership, shared interactions or plugin lifecycle, point out the affected Skill section. Resolve new product decisions with the user, then update the guidance to the agreed direction. Routine refinements within that direction can proceed directly.

Capture transferable lessons here and agreed application choices in the relevant reference. Describe the context, recommended approach, reason and expected effect, with alternatives when they offer a meaningful tradeoff. For recurring issues, identify the cause and choose an appropriate improvement in shared implementation, guidance or focused checks. Keep dates, revision IDs, measurements and individual outcomes in task records or Git history.
