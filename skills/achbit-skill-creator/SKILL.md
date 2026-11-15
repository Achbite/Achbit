---
name: Skill Creator
description: Create a Skill only when the user explicitly requests it. Use the requested language and provide a full bilingual comparison when it differs from the user's usual language. Includes experience, design and workflow templates.
---

# Skill Creator

Help the reader make useful decisions and take the next action. Shape each Skill around its purpose, applicable context and the knowledge worth reusing. Use concise, positive guidance with enough detail to apply it.

## User-directed invocation

Start this workflow only after the user explicitly asks to create a Skill, including a request to turn experience or an agreed approach into a new Skill. During ordinary coding, analysis, review or maintenance, continue the requested task and keep useful observations in its record. When a new Skill could help, propose it and wait for the user's creation instruction.

Treat plugin availability and inherited selection as capability context. Apply the same user-request condition to each task, and scope related maintenance to the user's approval within that creation work.

## Start from the goal

Read the requested outcome and relevant existing Skills. Identify the audience, recurring decision or task, and available material such as project code, agreed choices or documented experience. Infer routine details from that context; ask about missing choices when they materially change the result.

Choose between extending an existing section and creating a focused Skill. Keep related guidance with its current owner when that makes it easier to discover and maintain.

Match the requested stage. For a review draft, present the proposed files and leave application to other Skills and installation for the user's decision. For an approved update, edit the agreed scope and preserve surrounding content.

## Language and bilingual delivery

Write the Skill and its supporting prose in the language the user specifies. An explicit language choice takes precedence over template language or project defaults. When no language is specified, use the user's usual language established by their preference or conversation; ask briefly if that preference is unclear.

When the requested language differs from the user's usual language, deliver the requested-language Skill together with a complete bilingual comparison in the requested and usual languages. Align corresponding sections and include the guidance, examples and supporting references being delivered. Keep identifiers, commands, paths and protocol fields unchanged. Present the comparison as review material alongside the requested-language Skill package.

When the requested language matches the user's usual language, provide that version directly. Adapt template headings, explanatory placeholders and descriptions to the selected language while preserving the Skill format.

## Choose purpose and scope

| Primary purpose | What to capture | Useful structure |
| --- | --- | --- |
| Experience | Lessons distilled from encountered problems and useful solutions. | Situation → boundary condition → cause or mechanism → suggested approach → expected behavior. |
| Design | General design approaches and product directions agreed with the user. | Goal → principles → agreed direction → responsibilities and composition → tradeoffs → maintenance triggers. |
| Workflow | Guidance for completing a recurring operation. | Goal → necessary inputs → steps → results and meaningful branches → maintenance triggers. |

Choose the scope separately: **general** guidance transfers across projects; **project-specific** guidance names the product's owners, interfaces and agreed choices. A Skill may combine purposes, with a clear primary purpose and supporting references. For example, a UI design Skill can link to experience-based interaction checks.

Purpose and scope guide the writing. Express them in the introduction using the target system's existing Skill format. Read the relevant section of [templates](references/templates.md) as a starting point and adapt its headings to the material.

## Turn material into guidance

1. **Find the reusable part.** Explain the condition, mechanism or choice that helps a future task. Use source entrypoints for implementation detail and task records for dates, revision IDs, measurements and individual outcomes.
2. **Separate proposals from decisions.** Present a candidate route as a proposal with its tradeoffs. Incorporate product choices as the agreed direction after the user confirms them. Describe reusable experience at the scope supported by the source material.
3. **Organize for discovery.** Give the Skill a clear name and a description explaining its capability and when to use it. Keep the main guidance in `SKILL.md`; use linked references for detailed examples, project mappings or reusable templates.
4. **Write the helpful action.** Say what to use, where the responsibility belongs, why the approach helps and when to adjust it. Keep interface names, permission scope and activation timing precise when they affect the task.
5. **Review with a representative use.** Read the draft against an ordinary task and a relevant boundary case. Check whether the reader can choose an approach and act on it. Present uncertainties or product choices for review at their actual scope.

## Positive, contextual wording

Prefer a recommended approach with a reason and an applicability condition. Give alternatives when they offer a meaningful tradeoff, and keep examples adaptable to the target project.

Examples:

- “For state shared across views, use the existing state owner and pass published values and actions to consumers.”
- “When a request can finish after the visible selection changes, retain its initiating owner so the result reaches the appropriate view.”
- “For a short document, begin with clear typography and spacing; add navigation when the content benefits from it.”

Use the project's established instructions for execution, testing and delivery. Let the Skill add domain insight, useful choices and focused examples. Link to the owning procedure when an exact operation is needed.

## Reuse boundary lessons

Where boundary behavior matters, use a common review format:

**Interaction or operation type → Starting state and action → Boundary condition → Expected behavior → Observed result**

Choose the types relevant to the task. The Skill keeps reusable conditions, recommended approaches and expected behavior; the task record keeps the actual observations. See the [boundary example](references/templates.md#boundary-review-example) for a compact starting point.

## Maintain Skills with the product

When a change affects a recorded direction, responsibility, interaction, interface, dependency or workflow, point out the affected Skill section and the reason to revisit it. Align new product choices with the user, then update the guidance within the agreed scope. Routine wording and organization improvements can proceed within the existing direction.

When updating an existing Skill, preserve its useful decisions and examples, consolidate overlapping guidance at its owner, and replace superseded advice with the newly agreed approach. Keep stable identifiers and references where they still serve their consumers.

## Package and hand off

Use `SKILL.md` with the target system's supported front matter; Achbit uses `name` and `description`. Keep supporting references in the same package and link them relatively. Author with the existing file tools, and use the product's plugin-management workflow when installation or update is requested.

Deliver the Skill in the requested language, with the complete bilingual comparison when it differs from the user's usual language. Explain the chosen purpose and scope, and highlight any remaining product decisions. Report source authoring and installed availability separately. For a review-only request, deliver the draft for review.
