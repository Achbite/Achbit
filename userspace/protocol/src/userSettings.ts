import { PERMISSION_DEFAULTS } from './permissions.js';

export type UserSettingValue = string | number | boolean | null | string[];
export type UserSettings = Record<string, UserSettingValue>;
export type SettingsSurface = 'gui' | 'cli' | 'tui';

export type SettingCatalogDomain =
  | 'agent'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'workbench'
  | 'gui'
  | 'cli'
  | 'tui';

export interface SettingCatalogEntry {
  key: string;
  domain: SettingCatalogDomain;
  shellSurface: SettingsSurface[];
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  'workbench.language': 'zh-CN',
  'workbench.styleTokenOverrides': '{}',
  'workbench.uiPlugins': '[]',
  'gui.colorTheme': 'light',
  'gui.accentColor': 'blue',
  'gui.themeLibrary': '[]',
  'gui.fontFamily': 'warm-sans',
  'gui.interfaceFontFamily': 'inherit',
  'gui.contentFontFamily': 'inherit',
  'gui.terminalFontFamily': 'inherit',
  'gui.fontSize': 14,
  'gui.contentFontSize': 14,
  'gui.codeFontSize': 12,
  'gui.navigationDensity': 'comfortable',
  'gui.showContextRail': true,
  'gui.usageWidget.enabled': true,
  'gui.usageWidget.visibility': 'summary',
  'gui.usageWidget.currency': 'USD',
  'gui.showReasoning': false,
  'gui.defaultFileOpen': 'reader',
  'gui.showRuntimeFiles': false,
  'gui.sidebarOrder': '{"projects":[],"sessions":[]}',
  'agent.systemPrompt': '',
  'agent.approvalReview.profileId': '',
  'agent.approvalReview.reasoningEffort': '',
  'agent.subagents.enabled': false,
  'agent.subagents.profileId': '',
  'agent.subagents.reasoningEffort': '',
  'agent.subagents.maxConcurrent': 4,
  'agent.subagents.maxCallsPerRun': 16,
  'agent.subagents.maxMembersPerSession': 4,
  'agent.subagents.allowMemberAnalysis': true,
  'agent.subagents.allowFullConfiguration': true,
  'agent.subagents.presets': '[]',
  'agent.contextManagement.enabled': false,
  'agent.contextManagement.thresholdTokens': 500_000,
  'agent.responseLanguage': 'auto',
  'agent.windows.shell': 'auto',
  'agent.windows.gitBashPath': '',
  'agent.environmentRevision': 0,
  'agent.projectEnvironments': '{}',
  ...PERMISSION_DEFAULTS,
  'agent.web.search.endpointTemplate': '',
  'agent.web.search.authHeaderName': 'Authorization',
  'agent.web.search.authSecretRef': '',
  'agent.documents.pythonPath': '',
  'skills.autoLoad': true,
  'skills.mounts': '[]',
  'mcp.autoLoad': false,
  'mcp.servers': '[]',
  'plugins.sources': '[]',
  'plugins.disabled': '[]',
};

const SHARED_AGENT_PREFIX = 'agent.';
const PLUGIN_SETTING_PREFIXES = ['skills.', 'mcp.', 'plugins.'];
const NON_SHELL_SETTING_PREFIXES = [SHARED_AGENT_PREFIX, ...PLUGIN_SETTING_PREFIXES];

export const SETTING_CATALOG: readonly SettingCatalogEntry[] = Object.freeze(
  Object.keys(DEFAULT_USER_SETTINGS).map((key) => ({
    key,
    domain: domainForKey(key),
    shellSurface: surfacesForKey(key),
  })),
);

export function agentSettingsIndex(): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) => entry.key.startsWith(SHARED_AGENT_PREFIX));
}

export function shellPreferenceSettingsIndex(
  surface: SettingsSurface,
): readonly SettingCatalogEntry[] {
  return SETTING_CATALOG.filter((entry) =>
    !NON_SHELL_SETTING_PREFIXES.some((prefix) => entry.key.startsWith(prefix))
      && entry.shellSurface.includes(surface),
  );
}

function domainForKey(key: string): SettingCatalogDomain {
  const prefix = key.split('.')[0];
  return isDomain(prefix) ? prefix : 'agent';
}

function isDomain(value: string): value is SettingCatalogDomain {
  return [
    'agent', 'skills', 'mcp', 'plugins', 'workbench',
    'gui', 'cli', 'tui',
  ].includes(value);
}

function surfacesForKey(key: string): SettingsSurface[] {
  if (key === 'workbench.uiPlugins') return ['gui'];
  const domain = domainForKey(key);
  if (NON_SHELL_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return ['gui', 'cli', 'tui'];
  }
  if (domain === 'gui') return ['gui'];
  if (domain === 'cli') return ['cli'];
  if (domain === 'tui') return ['tui'];
  return ['gui'];
}

export interface GetUserSettingsResult {
  environment?: Record<string, unknown>;
  settings: UserSettings;
  runtimeSettings: UserSettings;
  overriddenKeys: string[];
  storePath: string;
}

export interface SkillSettingsItem {
  id: string;
  displayName: string;
  description: string;
  source: 'builtin' | 'mounted';
}

export interface PatchUserSettingsRequest {
  patches: Record<string, UserSettingValue>;
}

export type UserSettingsActivation = 'immediate' | 'nextRun';

export interface PatchUserSettingsResult {
  settings: UserSettings;
  changedKeys: string[];
  activation: UserSettingsActivation;
}
