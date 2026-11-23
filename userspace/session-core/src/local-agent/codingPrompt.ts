import type { PreparedToolDescriptor, RunRuntimeSnapshot } from '@achbit/protocol';
import { codingToolInstruction, codingToolNames } from './codingTools.js';
import { USER_SYSTEM_PROMPT_ID } from './coreInstructions.js';
import { environmentInstruction, primaryWorkingDirectory } from './sessionEnvironment.js';

/** One ordered composition path: shared sections plus capability-owned insertions. */
export function codingPromptInstructions(runtime: RunRuntimeSnapshot, tools: readonly PreparedToolDescriptor[],
  aliases: ReadonlyMap<string, string>, primaryId?: string): RunRuntimeSnapshot['instructions'] {
  const expanded = !runtime.codingTools;
  const section = (name: string, text: string) => ({ id: `achbit.coding.${name}`, text: `<${name}>\n${text}\n</${name}>` });
  // Core sentences are selected once by the shared factory at run preparation, not replaced here.
  const instructions = runtime.instructions.filter(item => item.id === 'achbit.coding-agent');
  const guide = codingToolInstruction(tools, aliases, expanded);
  if (guide) instructions.push(guide);
  const docs = runtime.instructions.find(item => item.id === 'achbit.product-docs');
  if (docs) instructions.push(docs);
  const owned = new Set(['achbit.coding-agent', 'achbit.reply-format', 'achbit.coding-tools',
    'achbit.session-environment', 'achbit.project-instructions', 'achbit.product-docs', 'achbit.workspace-autonomy', USER_SYSTEM_PROMPT_ID]);
  if (expanded) instructions.push(...runtime.instructions.filter(item => item.id === 'achbit.reply-format'));
  // Preserve each selected component's identity; coding context may also opt into individual components.
  instructions.push(...runtime.instructions.filter(item => !owned.has(item.id)).sort((a, b) => a.id.localeCompare(b.id, 'en')));
  if (expanded && runtime.instructions.some(item => item.id === 'achbit.session-environment')) {
    instructions.push(environmentInstruction(runtime.environment, tools.filter(tool => tool.availability === 'callable').map(tool => tool.name)));
  }
  // Append the user's preference after built-in guidance and before path-scoped project rules.
  const addendum = runtime.instructions.find(item => item.id === USER_SYSTEM_PROMPT_ID);
  if (addendum) instructions.push(addendum);
  const project = runtime.instructions.find(item => item.id === 'achbit.project-instructions');
  if (project) instructions.push(section('project_context', project.text));
  // Skill locations and extension guidance stay with their originating messages/results and declarations.
  const cwd = primaryWorkingDirectory(runtime, primaryId);
  if (cwd && tools.some(tool => tool.availability === 'callable' && tool.origin === 'coreBuiltin' && codingToolNames.has(tool.name))) {
    instructions.push(section('cwd', cwd.replace(/\\/gu, '/')));
  }
  return instructions;
}
