import type { AgentRecipe, SessionMode } from '@achbit/protocol';

/** A run-local narrowing of the immutable creation recipe; never a permission preset. */
export function recipeForMode(base: AgentRecipe | undefined, mode: SessionMode): AgentRecipe {
  const recipe = structuredClone(base ?? {});
  if (mode === 'full') return recipe;
  const coding = ['fs.read', 'bash', 'powershell', 'fs.edit', 'fs.write'];
  return {
    ...recipe,
    tools: { kernel: coding.filter(name => !recipe.tools?.kernel || recipe.tools.kernel.includes(name)),
      controls: [], plugins: false },
    productComponents: [],
    configuration: { context: { id: 'coding' }, controls: { id: 'none' }, compaction: { id: 'none' } },
    runner: { id: 'standard', parameters: { toolExecution: 'parallel' } },
  };
}
