# Skill starting points

Use these starting points after the user explicitly requests Skill creation. Choose the sections that help the intended reader, adapting the outlines to the subject's own structure.

Write in the user's specified language; when none is specified, use their usual language. Translate headings, descriptions and explanatory placeholders accordingly. When the requested language differs from the user's usual language, provide a complete section-aligned bilingual comparison of the delivered guidance and references. Preserve identifiers, commands, paths and protocol fields in both versions. Deliver that comparison as review material alongside the requested-language Skill package.

## Shared entry

```markdown
---
name: <Readable name>
description: <What the Skill helps with and when to use it.>
---

# <Title>

<The purpose, intended reader and applicable scope in a short introduction.>
```

For example, a design Skill may introduce a cross-project approach and link to a project's component mapping. An experience Skill may focus on one recurring class of problems. Keep the type and scope clear in the introduction.

## Experience template

```markdown
## When this helps

<Describe the recurring situation and conditions in which the lesson is useful.>

## Reusable lessons

| Situation or boundary | Underlying mechanism | Suggested approach | Expected behavior |
| --- | --- | --- | --- |
| <Condition that exposes the issue> | <Cause supported by the available evidence> | <Helpful action and its reason> | <Observable behavior> |

## Relevant entrypoints

<Link to the owning implementation or a concise reference when it helps apply the lesson.>

## Maintaining the lesson

<Describe what change in ownership, assumptions or behavior would make this guidance worth revisiting. Flag the affected Skill section when that happens.>
```

Write a short paragraph instead of a table when the lesson needs more explanation. For a cause that is still being investigated, retain the observed condition and describe the open question; add the mechanism as it becomes understood.

Example lesson:

> When directory loading can finish after a selection change, keep the request associated with the initiating selection. Apply its result to that owner's state so the visible directory continues to reflect the user's current choice.

## Design template

```markdown
## Goal and scope

<What the design helps achieve, where it applies and which product choices guide it.>

## Design principles

<Explain the preferred approach, its reason and useful alternatives.>

## Agreed direction

<Describe choices already aligned with the user. Keep candidate changes identifiable as proposals.>

## Responsibilities and composition

<Explain which existing owner handles each concern and how the parts work together.>

## Choices and tradeoffs

<Describe meaningful conditions for choosing or adapting the approach. Add an example where useful.>

## Maintaining the direction

<Identify changes that should prompt a Skill update. Align new product choices with the user, then update the relevant guidance.>
```

Example direction:

> Use the shared component catalog for reusable controls, declared slots for replaceable regions, and feature-local components for ordinary layout. This keeps reuse and extension aligned with their existing owners.

## Workflow template

```markdown
## Goal and necessary inputs

<Describe the operation, expected outcome and information needed to begin.>

## Main steps

1. <Start from the existing entrypoint and relevant context.>
2. <Perform the operation using its established interface.>
3. <Read the result and choose the appropriate next action.>

## Results and meaningful branches

<Explain useful success, pending, failure or cancellation outcomes and how to act on them.>

## References and resources

<Link to exact commands, templates or interface details maintained by their owner.>

## Maintaining the workflow

<Identify interface, dependency or lifecycle changes that should prompt an update to the affected steps.>
```

Keep operational facts such as commands, permission scope and result fields precise. Use the workflow's actual entrypoints and supported branches.

## Boundary review example

Use this format for a concrete task:

| Interaction or operation type | Starting state and action | Boundary condition | Expected behavior | Observed result |
| --- | --- | --- | --- | --- |
| Asynchronous selection | Start loading directory A, then select B. | A's response arrives after B is selected. | Each result remains associated with its initiating selection; the visible directory reflects B. | Record the actual result and observation scope in the task. |

Reusable Skills retain the relevant condition and expected behavior. Task records hold the observation, any remaining question and the next action. For UI work, choose relevant types such as editing, overlays, selection, scrolling, viewers, asynchronous decisions, plugin replacement or responsive changes.

## Supporting files

A small Skill may fit in one file. Add supporting resources as their content becomes useful:

```text
<skill-directory>/
  SKILL.md
  references/
    <relevant-topic>.md
  assets/
    <reusable-template>
```

The main entry explains when to read each reference. Keep general guidance and project-specific mappings distinguishable, and reuse the same advice through links when several workflows need it.
