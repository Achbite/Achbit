import type { UserSettings } from '@achbit/protocol';

/** UI shortcuts over existing permission facts; workflow and command rules stay independent. */
export const PERMISSION_PRESETS = [
  { id: 'ask', label: 'agent.permission.ask', help: 'agent.permission.preset.askHelp', patches: {
    'agent.permissions.shell': 'ask', 'agent.permissions.shellAccess': 'workspace',
    'agent.permissions.networkRead': 'ask', 'agent.permissions.external': 'ask',
  } },
  { id: 'review', label: 'agent.permission.review', help: 'agent.permission.preset.reviewHelp', patches: {
    'agent.permissions.shell': 'review', 'agent.permissions.shellAccess': 'workspace',
    'agent.permissions.networkRead': 'allow', 'agent.permissions.external': 'review',
  } },
  { id: 'full', label: 'agent.permission.fullAccess', help: 'agent.permission.preset.fullHelp', patches: {
    'agent.permissions.shell': 'allow', 'agent.permissions.shellAccess': 'full',
    'agent.permissions.networkRead': 'allow', 'agent.permissions.external': 'allow',
  } },
] as const;

export function currentPermissionPreset(settings: UserSettings) {
  return PERMISSION_PRESETS.find(preset => Object.entries(preset.patches).every(([key, value]) => settings[key] === value));
}
