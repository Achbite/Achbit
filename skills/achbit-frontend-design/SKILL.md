---
name: Frontend Design
description: Design or review frontend pages, reusable components and interactive previews, including layout, feedback and keyboard behavior. 前端页面、组件与交互预览设计。
---

# Frontend design

Start from the user's task, audience, content and input environment. Follow their requested direction and applicable user-provided Skills within the target project's contracts and the permissions granted. Read a nearby production screen, its component library and its design tokens when they exist.

## Visual hierarchy and containers

Use reading order, typography, spacing, contrast and alignment to make the primary task recognizable. Choose meaningful imagery, icons and motion for the content and audience. Keep labels and explanations where they help someone decide or act. For a redesign, explain the meaningful departure from the surrounding visual language.

Identify the container that actually determines the available space. Name the owner of sizing, overflow, scrolling and focus. A sidebar, split reader or dialog can change a component's width while the window stays the same. Let a wide table or long code block scroll within its intended bounds. Verify surrounding controls retain their position and hit area.

## Components and state

Use the project's existing component family and semantic variants. Compose shared controls for specialized actions. Promote a pattern when independent callers need the same behavior. Preserve native semantics, accessible names, refs, keyboard input and the identity that holds a draft or selection.

Let the feature own its data, labels and operation. For asynchronous work, identify its trigger, pending state, success, failure, cancellation and cleanup as applicable. Keep the result with its initiating object when the visible selection changes.

## Feedback and floating surfaces

Choose the surface from the affected object, the cost of missing the message, whether a response is required and where the user is working.

- Explain a control with a short description or tooltip. Make pointer-triggered additional content reachable by pointer, keyboard help available on focus and dismissal predictable. Put interactive help in a popover appropriate to its contents.
- Put field errors, retry actions and item-specific confirmations next to their owner. A toast or snackbar suits a brief outcome that can be recovered elsewhere. Keep an ongoing condition or announcement on an appropriate page or window surface.
- Keep progress with the operation until it settles. Explain a consequential choice in a dialog when the user must respond. Deliver background attention through the target platform's applicable mechanism.
- For each floating surface, identify its anchor, rendering host, collision behavior, focus policy and exit. Close the active child on Escape. Return focus to an appropriate live target. Let the user reach and finish any time-sensitive action.

## Review the experience

Use a component preview to compare an isolated interaction, the assembled application for its relationship with neighbors, and the actual platform for native windows or menus. Select a useful preview or file format supported by the target environment.

Exercise the action with representative content. Check the boundaries affected by the change, such as a narrow pane, long localized text, larger type, nested overlays, IME composition, delayed replies, rich content or restored views. Verify the selected object, what is actually visible, and the next action the user can take. Distinguish accepted input, committed state and visible output. Attach the observed result and its scope to the work record.
