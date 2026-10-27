import type { UiIconName } from '../../icons/registry';

// These are shortcuts to existing GUI actions. Session commands still use the
// same store and Host API as the corresponding buttons.
export const composerCommands = [
  { id: 'focus', icon: 'activity' },
  { id: 'new', icon: 'compose' },
  { id: 'model', icon: 'server' },
  { id: 'context', icon: 'info' },
  { id: 'permissions', icon: 'shield' },
  { id: 'attach', icon: 'paperclip' },
  { id: 'plugins', icon: 'extension' },
  { id: 'agents', icon: 'subagents' },
  { id: 'cancel', icon: 'stop' },
  { id: 'help', icon: 'question' },
] as const satisfies readonly { id: string; icon: UiIconName }[];

export type ComposerCommand = typeof composerCommands[number]['id'];

export function suggestComposerCommands(draft: string) {
  if (!/^\/[a-z]*$/u.test(draft)) return [];
  return composerCommands.filter(command => `/${command.id}`.startsWith(draft));
}

export function parseComposerCommand(draft: string): { name: ComposerCommand; argument: string } | null {
  // Leading whitespace explicitly sends ordinary text, before any normalization.
  const match = draft.trimEnd().match(/^\/([a-z-]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return null;
  const command = composerCommands.find(item => item.id === match[1]);
  const argument = match[2]?.trim() ?? '';
  if (!command || (argument && command.id !== 'focus')) return null;
  return { name: command.id, argument };
}
