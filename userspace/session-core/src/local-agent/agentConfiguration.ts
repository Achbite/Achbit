import { decodeAgentConfiguration, decodeAgentCapabilities, isLlmReasoningEffort, validatePermissionPatches } from '@deepcode/protocol';
import type { AgentCapabilities, AgentConfiguration, AgentOperation, AgentSettings, UserSettings } from '@deepcode/protocol';

export const DEFAULT_AGENT_CONFIGURATION: AgentConfiguration = {
  context: { id: 'journal' }, compaction: { id: 'summary' }, controls: { id: 'standard' },
};

export interface AgentPreset {
  id: string;
  name: string;
  capabilities: AgentCapabilities;
  profileId?: string;
  reasoningEffort?: import('@deepcode/protocol').LlmReasoningEffort;
  configuration?: AgentConfiguration;
  permissions?: UserSettings;
}

export function agentPresets(settings: AgentSettings): AgentPreset[] {
  const builtins: AgentPreset[] = [
    { id: 'analysis', name: 'Analysis', capabilities: { messaging: 'parent', continuation: true, delegation: false } },
    { id: 'collaboration', name: 'Collaboration', capabilities: { messaging: true, continuation: true, delegation: true } },
  ];
  const stored: unknown = JSON.parse(settings.presets ?? '[]');
  if (!Array.isArray(stored)) throw new Error('agent_presets_invalid');
  const ids = new Set(builtins.map(preset => preset.id));
  for (const item of stored) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'name', 'capabilities', 'profileId', 'reasoningEffort', 'configuration', 'permissions'].includes(key))
      || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim()
      || item.profileId !== undefined && (typeof item.profileId !== 'string' || !item.profileId.trim())
      || item.reasoningEffort !== undefined && !isLlmReasoningEffort(item.reasoningEffort)) throw new Error('agent_presets_invalid');
    ids.add(item.id);
    if (item.permissions !== undefined) validatePermissionPatches(item.permissions);
    builtins.push({ ...item, capabilities: decodeAgentCapabilities(item.capabilities),
      ...(item.configuration ? { configuration: decodeAgentConfiguration(item.configuration) } : {}) });
  }
  return builtins;
}

export function resolveAgentCapabilities(preset: AgentPreset, overrides: Partial<AgentCapabilities> | undefined,
  caller: AgentCapabilities, allowChildDelegation: boolean): AgentCapabilities {
  const capabilities = { ...preset.capabilities,
    messaging: !caller.messaging ? false : caller.messaging === 'parent' && preset.capabilities.messaging === true
      ? 'parent' as const : preset.capabilities.messaging,
    continuation: preset.capabilities.continuation && caller.continuation,
    delegation: preset.capabilities.delegation && caller.delegation && allowChildDelegation, ...overrides };
  for (const key of ['messaging', 'continuation', 'delegation'] as const) {
    if (capabilities[key] && (!caller[key] || key === 'delegation' && !allowChildDelegation)
      || key === 'messaging' && capabilities.messaging === true && caller.messaging === 'parent') {
      throw new Error('agent_capability_not_grantable');
    }
  }
  return capabilities;
}

/** Only restrictions of already granted policy can be chosen by the creating Agent. */
export function agentPermissions(parent: UserSettings, ...patches: Array<UserSettings | undefined>): UserSettings {
  const permissions = structuredClone(parent);
  const levels: Record<string, readonly string[]> = {
    'agent.permissions.workspaceMutation': ['plan', 'allow'],
    'agent.permissions.engineeringDecisions': ['ask', 'delegate'],
    'agent.permissions.shell': ['ask', 'review', 'allow'],
    'agent.permissions.shellAccess': ['workspace', 'full'],
    'agent.permissions.networkRead': ['deny', 'ask', 'allow'],
    'agent.permissions.external': ['deny', 'ask', 'allow'],
  };
  for (const patch of patches) {
    if (!patch) continue;
    validatePermissionPatches(patch);
    for (const [key, value] of Object.entries(patch)) {
      if (JSON.stringify(value) === JSON.stringify(permissions[key])) continue;
      const choices = levels[key];
      if (!choices || choices.indexOf(String(value)) > choices.indexOf(String(permissions[key]))) {
        throw new Error(`agent_permission_not_grantable:${key}`);
      }
      permissions[key] = value;
    }
  }
  return permissions;
}

export type AgentSpawn = Extract<AgentOperation, { action: 'spawn' }>;
