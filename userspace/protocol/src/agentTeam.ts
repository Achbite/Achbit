import { decodeAgentRecipe, type AgentRecipe } from './agentRecipe.js';

/** A coordinator's menu for one worker. Each entry is a template with task-local overrides. */
export interface AgentHelperSpec {
  id: string;
  preset: string;
  maxCalls: number;
  recipe?: AgentRecipe;
  helpers?: AgentHelperSpec[];
}
export const teamKeyPattern = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$';
export function teamKey(value: unknown): string {
  if (typeof value !== 'string' || !new RegExp(teamKeyPattern, 'u').test(value)) throw new Error('agent_team_key_invalid');
  return value;
}
export function decodeAgentHelpers(value: unknown, depth = 1): AgentHelperSpec[] {
  if (!Array.isArray(value) || value.length > 16 || depth > 4) throw new Error('agent_helpers_invalid');
  const seen = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(k => !['id','preset','maxCalls','recipe','helpers'].includes(k))
      || typeof entry.preset !== 'string' || !entry.preset.trim() || entry.preset !== entry.preset.trim()
      || !Number.isSafeInteger(entry.maxCalls) || entry.maxCalls < 1) throw new Error('agent_helpers_invalid');
    const id = teamKey(entry.id);
    if (seen.has(id)) throw new Error('agent_helper_duplicate');
    seen.add(id);
    return { id, preset: entry.preset, maxCalls: entry.maxCalls,
      ...(entry.recipe !== undefined ? {recipe:decodeAgentRecipe(entry.recipe)} : {}),
      ...(entry.helpers !== undefined ? {helpers:decodeAgentHelpers(entry.helpers, depth+1)} : {}) };
  });
}
