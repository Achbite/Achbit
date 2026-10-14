import { decodeAgentConfiguration, decodeAgentContribution, type AgentConfiguration, type AgentContributionSelection } from './localAgent.js';
import { isLlmReasoningEffort, type LlmReasoningEffort } from './llm.js';
import { validatePermissionPatches } from './permissions.js';
import type { UserSettings } from './userSettings.js';

/** Declarative Session creation defaults. Executable components must already be installed. */
export interface AgentRecipe {
  profileId?: string;
  reasoningEffort?: LlmReasoningEffort;
  configuration?: AgentConfiguration;
  runner?: AgentContributionSelection;
  permissions?: UserSettings;
  permissionPolicy?: AgentContributionSelection;
  workspaceSandbox?: { backendId: string; requireIsolatedProcesses?: boolean };
}

export function decodeAgentRecipe(value: unknown): AgentRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent_recipe_invalid');
  const item = value as AgentRecipe;
  if (Object.keys(item).some(key => !['profileId', 'reasoningEffort', 'configuration', 'runner', 'permissions', 'permissionPolicy', 'workspaceSandbox'].includes(key))
    || item.profileId !== undefined && (typeof item.profileId !== 'string' || !item.profileId.trim())
    || item.reasoningEffort !== undefined && !isLlmReasoningEffort(item.reasoningEffort)) throw new Error('agent_recipe_invalid');
  if (item.configuration !== undefined) decodeAgentConfiguration(item.configuration);
  if (item.runner !== undefined) decodeAgentContribution(item.runner);
  if (item.permissions !== undefined) validatePermissionPatches(item.permissions);
  if (item.permissionPolicy !== undefined) {
    decodeAgentContribution(item.permissionPolicy);
    permissionPolicyConstraints(item.permissionPolicy);
  }
  if (item.workspaceSandbox !== undefined) {
    const sandbox = item.workspaceSandbox;
    if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)
      || Object.keys(sandbox).some(key => !['backendId', 'requireIsolatedProcesses'].includes(key))
      || typeof sandbox.backendId !== 'string' || !sandbox.backendId.trim() || sandbox.backendId !== sandbox.backendId.trim()
      || sandbox.requireIsolatedProcesses !== undefined && typeof sandbox.requireIsolatedProcesses !== 'boolean') throw new Error('agent_sandbox_invalid');
  }
  return structuredClone(item);
}

/** Declarative constraints; only the Kernel can grant an execution. */
export function permissionPolicyConstraints(selection: AgentContributionSelection = { id: 'local-standard' }) {
  if (!['local-standard', 'workspace-only'].includes(selection.id)) throw new Error(`permission_policy_unavailable:${selection.id}`);
  const parameters = selection.parameters ?? {};
  if (Object.entries(parameters).some(([key, value]) => !['allowHostExecution', 'allowExternalTools'].includes(key) || typeof value !== 'boolean')) {
    throw new Error('permission_policy_parameters_invalid');
  }
  if (selection.id === 'workspace-only' && Object.values(parameters).some(value => value === true)) throw new Error('permission_policy_parameters_invalid');
  return { allowHostExecution: selection.id === 'local-standard' && parameters.allowHostExecution !== false,
    allowExternalTools: selection.id === 'local-standard' && parameters.allowExternalTools !== false };
}

/** Child presets can narrow constraints, including when they select another policy. */
export function inheritAgentRecipe(parent: AgentRecipe | undefined, selected: AgentRecipe): AgentRecipe {
  const result = decodeAgentRecipe({ ...selected,
    permissionPolicy: selected.permissionPolicy ?? parent?.permissionPolicy ?? { id: 'local-standard' },
    workspaceSandbox: selected.workspaceSandbox ?? parent?.workspaceSandbox ?? { backendId: 'platform-default' } });
  const effective = (recipe?: AgentRecipe) => recipe?.workspaceSandbox?.requireIsolatedProcesses
    ? { allowHostExecution: false, allowExternalTools: false } : permissionPolicyConstraints(recipe?.permissionPolicy);
  const limits = effective(parent);
  const requested = effective(result);
  if (!limits.allowHostExecution && requested.allowHostExecution || !limits.allowExternalTools && requested.allowExternalTools
    || parent?.workspaceSandbox?.requireIsolatedProcesses && !result.workspaceSandbox?.requireIsolatedProcesses) {
    throw new Error('agent_policy_not_grantable');
  }
  return result;
}
