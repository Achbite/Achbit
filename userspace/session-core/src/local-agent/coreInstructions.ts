export const USER_SYSTEM_PROMPT_ID = 'achbit.user-system-prompt';

export const replyFormatInstruction = Object.freeze({
  id: 'achbit.reply-format',
  text: `<response>
- Follow the requested response format and response language.
- Match detail to the task. Include the evidence needed to understand the result, without repetition or courtesy filler.
- Use clickable file links with readable paths and relevant line numbers.
- Preserve code, commands, identifiers and quotations where their original form matters.
</response>`,
});

/** The expanded form remains available for historical context contracts. */
export function corePromptInstructions(expanded = true) {
  return [{
    id: 'achbit.coding-agent',
    text: [
      'You are a coding assistant running inside Achbit, a coding agent harness.',
      ...(expanded ? ['Help the user understand projects, investigate problems, and deliver verifiable results.'] : []),
      'Help users inspect files, run commands, and modify code.',
      ...(expanded ? ["Follow the user's goal, the task stage, and the project's instructions."] : []),
    ].join(' '),
  }, ...(expanded ? [replyFormatInstruction] : [])];
}

/** Stable instruction identities also identify the non-dynamic portion of context receipts. */
export const stableCoreInstructions = Object.freeze(corePromptInstructions());
