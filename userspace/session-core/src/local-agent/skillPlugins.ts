import { permissionSettings, validatePermissionPatches } from '@achbit/protocol';
import type { UserSettings, RunRuntimeSnapshot } from '@achbit/protocol';
import type { SessionControlWireNames } from './sessionControls.js';

export type InstructionContribution = RunRuntimeSnapshot['instructions'][number];

export interface RunPluginConfig {
  extensionGenerationRef: string;
  permissions: UserSettings;
  selectedPlugins: readonly {
    uri: string;
    displayName: string;
    capabilitySummary: string;
  }[];
}

export function decodeRunPluginConfig(value: unknown): RunPluginConfig {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'extensionGenerationRef',
      'permissions',
      'selectedPlugins',
    ])
    || !isIdentifier(value.extensionGenerationRef)
    || !Array.isArray(value.selectedPlugins)
  ) {
    throw new Error('run_plugin_config_invalid');
  }
  validatePermissionPatches(value.permissions);
  const seen = new Set<string>();
  const selectedPlugins = value.selectedPlugins.map((item) => {
    if (
      !isRecord(item)
      || !hasExactKeys(item, ['uri', 'displayName', 'capabilitySummary'])
      || typeof item.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(item.uri)
      || seen.has(item.uri)
      || typeof item.displayName !== 'string'
      || !item.displayName.trim()
      || item.displayName.length > 160
      || typeof item.capabilitySummary !== 'string'
      || !item.capabilitySummary.trim()
    ) {
      throw new Error('run_selected_plugin_config_invalid');
    }
    seen.add(item.uri);
    return {
      uri: item.uri,
      displayName: item.displayName,
      capabilitySummary: item.capabilitySummary,
    };
  });
  return {
    extensionGenerationRef: value.extensionGenerationRef,
    permissions: permissionSettings(value.permissions),
    selectedPlugins,
  };
}

export function runtimeInstructions(
  stableCore: readonly InstructionContribution[],
  config: RunPluginConfig,
  controlNames: SessionControlWireNames = {
    interactionRequest: 'interaction_request',
    planPublish: 'plan_publish',
    todoUpdate: 'todo_update',
    pluginActivate: 'plugin_activate',
    artifactPresent: 'artifact_present',
  },
): readonly InstructionContribution[] {
  const instructions: InstructionContribution[] = [
    ...stableCore.map((instruction) => ({ ...instruction })),
    {
      id: 'deepcode.workspace-autonomy',
      text: permissionInstructionText(config.permissions, controlNames.interactionRequest, controlNames.planPublish),
    },
    ...config.selectedPlugins.map((plugin) => ({
      id: `plugin.${instructionId(plugin.uri)}`,
      text: `The \`${plugin.displayName}\` plugin is loaded for this request. User mentions and Agent-requested activation are independent ways to select capabilities.

Available capabilities:
${plugin.capabilitySummary}

Call the tools listed for this request; use the plugin name to identify its capabilities, not as a tool name.`,
    })),
  ];
  const seen = new Set<string>();
  for (const instruction of instructions) {
    if (!isIdentifier(instruction.id) || !instruction.text.trim() || seen.has(instruction.id)) {
      throw new Error('run_instruction_invalid');
    }
    seen.add(instruction.id);
  }
  return Object.freeze(instructions
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
    .map((instruction) => Object.freeze({ ...instruction })));
}

function instructionId(uri: string): string {
  return uri.replace(/^plugin:\/\//u, '').replace('@', '.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value)
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u.test(value);
}

export function permissionInstructionText(settings: UserSettings, interactionRequest = 'interaction_request', planPublish = 'plan_publish'): string {
  const workspaceAutonomyInstruction = settings['agent.permissions.workspaceMutation'] === 'allow'
    ? 'Work directly within the bound workspaces. Separate execution permissions still apply.'
    : settings['agent.permissions.workspaceMutation'] === 'review'
      ? `For project changes outside confirmed scope, call ${planPublish}. An independent Plan reviewer decides the proposed scope; you do not approve your own Plan. Reuse confirmed scope for related work. Shell execution approval is separate.`
    : `For project changes outside confirmed scope, call ${planPublish} and wait for confirmation. Proceed directly with related work inside confirmed scope, including delegated parent scope. Project reads need no Plan.`;
  const engineeringDecisionInstruction = settings['agent.permissions.engineeringDecisions'] === 'delegate'
    ? `Engineering decisions are delegated. Choose the smallest sound approach; use ${interactionRequest} for missing facts or decisions outside the task.`
    : `Choose local implementation details within the agreed approach. Use ${interactionRequest} before materially changing requirements, public contracts, fact ownership or that approach.`;
  return `${workspaceAutonomyInstruction}\nSession working directories hold editable drafts and previews; changes there need no Plan.\n${engineeringDecisionInstruction}`;
}
