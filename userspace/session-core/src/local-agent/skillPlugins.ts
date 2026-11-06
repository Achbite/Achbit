import { permissionSettings, validatePermissionPatches } from '@achbit/protocol';
import type { UserSettings, RunRuntimeSnapshot } from '@achbit/protocol';

/** A selected entry is a location, not a file grant. Advertise it only with a callable reader. */
export function mountedSkillEntries(plugins: RunRuntimeSnapshot['selectedPlugins']['plugins'], tools: RunRuntimeSnapshot['tools']) {
  if (!plugins.length || !tools.some(tool => tool.name === 'fs.read' && tool.availability === 'callable')) return [];
  return plugins.flatMap(plugin => plugin.skillEntryPath ? [{ uri: plugin.uri, path: plugin.skillEntryPath }] : []);
}

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

export function runtimeInstructions(instructions: readonly InstructionContribution[]): readonly InstructionContribution[] {
  const seen = new Set<string>();
  for (const instruction of instructions) {
    if (!isIdentifier(instruction.id) || !instruction.text.trim() || seen.has(instruction.id)) {
      throw new Error('run_instruction_invalid');
    }
    seen.add(instruction.id);
  }
  return Object.freeze([...instructions]
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
