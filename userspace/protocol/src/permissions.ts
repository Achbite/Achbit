import type { UserSettings, UserSettingValue } from './userSettings.js';

export type ShellApprovalMode = 'ask' | 'review' | 'allow';
const SHELL_AUTHORIZATION_SCOPE_PAIRS = [
  ['runCommand', 'sessionCommand'], ['runHostShell', 'sessionHostShell'],
  ['runNetwork', 'sessionNetwork'], ['runContainer', 'sessionContainer'], ['runFiles', 'sessionFiles'],
] as const;
export const SHELL_AUTHORIZATION_SCOPES = SHELL_AUTHORIZATION_SCOPE_PAIRS.flat();
export type ShellAuthorizationScope = typeof SHELL_AUTHORIZATION_SCOPES[number];
export function isShellAuthorizationScope(value: unknown): value is ShellAuthorizationScope {
  return typeof value === 'string' && (SHELL_AUTHORIZATION_SCOPES as readonly string[]).includes(value);
}
export function isSessionAuthorizationScope(scope: ShellAuthorizationScope): boolean {
  return SHELL_AUTHORIZATION_SCOPE_PAIRS.some(([, session]) => session === scope);
}
export function sessionAuthorizationScope(scope: ShellAuthorizationScope): ShellAuthorizationScope | undefined {
  return SHELL_AUTHORIZATION_SCOPE_PAIRS.find(([run]) => run === scope)?.[1];
}

/** Resource bindings come from the Kernel preview, never from an inferred UI path. */
export interface ShellCommandRule {
  decision: 'allow' | 'ask' | 'deny';
  context: Record<string, unknown>;
}

export const PERMISSION_DEFAULTS: UserSettings = {
  'agent.permissions.workspaceMutation': 'plan',
  'agent.permissions.engineeringDecisions': 'ask',
  'agent.permissions.shell': 'ask',
  'agent.permissions.shellAccess': 'workspace',
  'agent.permissions.runtimeReadRoots': [],
  'agent.permissions.networkRead': 'allow',
  'agent.permissions.external': 'ask',
  'agent.permissions.commandDenylist': ['rm -rf /'],
  'agent.permissions.commandRules': '[]',
};

export function permissionSettings(settings: UserSettings): UserSettings {
  const result: UserSettings = {};
  for (const [key, value] of Object.entries(PERMISSION_DEFAULTS)) result[key] = settings[key] === undefined ? value : settings[key]!;
  validatePermissionPatches(result);
  return result;
}

export function validatePermissionPatches(value: unknown): asserts value is Record<string, UserSettingValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('permission_settings_invalid');
  const choices: Record<string, readonly string[]> = {
    'agent.permissions.workspaceMutation': ['plan', 'review', 'allow'],
    'agent.permissions.engineeringDecisions': ['ask', 'delegate'],
    'agent.permissions.shell': ['ask', 'review', 'allow'],
    'agent.permissions.shellAccess': ['workspace', 'full'],
    'agent.permissions.networkRead': ['allow', 'ask', 'deny'],
    'agent.permissions.external': ['allow', 'ask', 'deny'],
  };
  for (const [key, setting] of Object.entries(value)) {
    if (choices[key]) {
      if (typeof setting !== 'string' || !choices[key].includes(setting)) throw new Error('permission_setting_invalid:' + key);
    } else if (key === 'agent.permissions.commandDenylist') {
      if (!Array.isArray(setting) || setting.length > 256 || setting.some(item => typeof item !== 'string' || !item.trim())) throw new Error('command_denylist_invalid');
    } else if (key === 'agent.permissions.commandRules') {
      decodeShellCommandRules(setting);
    } else if (key === 'agent.permissions.runtimeReadRoots') {
      if (!Array.isArray(setting) || setting.some(path => typeof path !== 'string' || !path.trim())) throw new Error('runtime_read_roots_invalid');
    } else throw new Error('permission_setting_unknown:' + key);
  }
}

export function decodeShellCommandRules(value: unknown): ShellCommandRule[] {
  if (typeof value !== 'string') throw new Error('command_rules_invalid');
  const rules: unknown = JSON.parse(value);
  if (!Array.isArray(rules) || rules.length > 256) throw new Error('command_rules_invalid');
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).some(key => !['decision', 'context'].includes(key))
      || !['allow', 'ask', 'deny'].includes(rule.decision)
      || !rule.context || typeof rule.context !== 'object' || Array.isArray(rule.context)
      || typeof rule.context.command !== 'string' || !rule.context.command.trim()
      || rule.context.command.length > 16384 || typeof rule.context.workspaceId !== 'string'
      || !rule.context.workspaceId || !rule.context.environment || typeof rule.context.environment !== 'object'
      || Array.isArray(rule.context.environment)) throw new Error('command_rule_invalid');
  }
  return rules;
}
