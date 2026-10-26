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
    ? "Work directly within the bound workspaces and the user's authorized scope; no additional Plan approval is required. Still clarify missing facts or material decisions. Separate execution permissions still apply."
    : settings['agent.permissions.workspaceMutation'] === 'review'
      ? `Submit a Plan with ${planPublish} for project changes outside confirmed scope. An independent Plan reviewer decides the proposed scope; you do not approve your own Plan. Reuse confirmed scope and submit again only when new or expanded authorization is needed. Project reads need no Plan.`
    : `Investigate as needed and propose a clearly scoped change. Before making project changes outside confirmed scope, call ${planPublish} and wait for confirmation. Then carry out related work within that scope autonomously, including delegated parent scope, without seeking approval again for ordinary implementation details. Request additional scope only when needed. Project reads need no Plan.`;
  const engineeringDecisionInstruction = settings['agent.permissions.engineeringDecisions'] === 'delegate'
    ? `Engineering decisions are delegated. Choose the smallest sound approach; use ${interactionRequest} for missing facts or decisions outside the task.`
    : `Choose local implementation details within the agreed approach. Use ${interactionRequest} before materially changing requirements, public contracts, fact ownership or that approach.`;
  return `${workspaceAutonomyInstruction}\nSession working directories may hold drafts and previews without a Plan. Follow the current engineering-decision setting independently of Plan approval. Plan authority, execution approval, and progress tracking serve different purposes; a Todo list grants no authority and does not prevent reporting a result.\n${engineeringDecisionInstruction}`;
}
