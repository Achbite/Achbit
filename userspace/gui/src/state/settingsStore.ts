import { create } from 'zustand';
import {
  DEFAULT_USER_SETTINGS,
  agentSettingsIndex,
  shellPreferenceSettingsIndex,
  type SettingCatalogEntry,
  type SettingsSurface,
  type GetUserSettingsResult,
  type UserSettingsActivation,
  type UserSettingValue,
  type UserSettings,
} from '@achbit/protocol';
import {
  getUserSettings,
  patchUserSettings,
} from '../services/runtimeAdapter';
import {
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
} from '../theme/achbitGuiTheme';
import { activeT, settingText } from '../i18n';

export type SettingSource = 'default' | 'user';

export type SettingControlType = 'boolean' | 'number' | 'text' | 'textarea' | 'select';

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  group:
    | 'editor'
    | 'files'
    | 'keyboard'
    | 'explorer'
    | 'workbench'
    | 'terminal'
    | 'agent'
    | 'gui'
    | 'skills'
    | 'mcp';
  control: SettingControlType;
  options?: Array<{ label: string; value: string }>;
  catalog?: SettingCatalogEntry;
}

type SettingDefinitionSchema = Omit<
  SettingDefinition,
  'label' | 'description' | 'options' | 'catalog'
> & {
  options?: string[];
};



interface SettingsStateData {
  environment: Record<string, unknown> | null;
  userSettings: UserSettings;
  effectiveSettings: UserSettings;
  sources: Record<string, SettingSource>;
  overriddenKeys: string[];
  storePath: string | null;
  loading: boolean;
  pendingNextRunActivation: boolean;
  errorMessage: string | null;
}

interface SettingsActions {
  loadUserSettings: () => Promise<void>;
  patchUserSetting: (
    key: string,
    value: UserSettingValue,
  ) => Promise<UserSettingsActivation | null>;
  patchUserSettingsBatch: (
    patches: Record<string, UserSettingValue>,
  ) => Promise<UserSettingsActivation | null>;
  resetUserSetting: (key: string) => Promise<UserSettingsActivation | null>;
}

type SettingsStore = SettingsStateData & SettingsActions;

const SETTING_DEFINITION_SCHEMAS: SettingDefinitionSchema[] = [
  { key: 'gui.showReasoning', group: 'gui', control: 'boolean' },
  { key: 'gui.completionSound.foreground', group: 'gui', control: 'boolean' },
  { key: 'gui.defaultFileOpen', group: 'gui', control: 'select', options: ['reader', 'vscode'] },
  { key: 'gui.showRuntimeFiles', group: 'gui', control: 'boolean' },
  {
    key: 'workbench.language',
    group: 'workbench',
    control: 'select',
    options: [
      'zh-CN',
      'en-US',
    ],
  },
  {
    key: 'workbench.styleTokenOverrides',
    group: 'workbench',
    control: 'text',
  },
  {
    key: 'gui.colorTheme',
    group: 'gui',
    control: 'select',
    options: [
      'system',
      'light',
      'dark',
    ],
  },
  {
    key: 'gui.accentColor',
    group: 'gui',
    control: 'select',
    options: [
      'blue',
      'purple',
      'green',
    ],
  },
  {
    key: 'gui.navigationDensity',
    group: 'gui',
    control: 'select',
    options: [
      'comfortable',
      'compact',
    ],
  },
  {
    key: 'gui.showContextRail',
    group: 'gui',
    control: 'boolean',
  },
  { key: 'gui.usageWidget.currency', group: 'gui', control: 'select', options: ['USD', 'CNY'] },
  { key: 'gui.usageWidget.enabled', group: 'gui', control: 'boolean' },
  { key: 'gui.usageWidget.visibility', group: 'gui', control: 'select', options: ['summary', 'collapsed', 'hidden'] },
  { key: 'agent.contextManagement.enabled', group: 'agent', control: 'boolean' },
  { key: 'agent.contextManagement.thresholdTokens', group: 'agent', control: 'number' },
  { key: 'agent.windows.shell', group: 'agent', control: 'select', options: ['auto', 'powershell7', 'windowsPowerShell', 'gitBash'] },
  { key: 'agent.windows.gitBashPath', group: 'agent', control: 'text' },
  {
    key: 'agent.responseLanguage',
    group: 'agent',
    control: 'select',
    options: ['auto', 'zh-CN', 'en-US'],
  },
  {
    key: 'agent.systemPrompt',
    group: 'agent',
    control: 'textarea',
  },
  {
    key: 'agent.permissions.workspaceMutation',
    group: 'agent',
    control: 'select',
    options: ['plan', 'allow'],
  },
  {
    key: 'agent.permissions.engineeringDecisions',
    group: 'agent',
    control: 'select',
    options: ['ask', 'delegate'],
  },
  {
    key: 'agent.permissions.shell', group: 'agent', control: 'select', options: ['ask', 'review', 'allow'],
  },
  {
    key: 'agent.permissions.shellAccess', group: 'agent', control: 'select', options: ['workspace', 'full'],
  },
  {
    key: 'agent.permissions.networkRead',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptionValues(),
  },
  {
    key: 'agent.permissions.external',
    group: 'agent',
    control: 'select',
    options: permissionPolicyOptionValues(),
  },
  {
    key: 'agent.web.search.endpointTemplate',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.web.search.authHeaderName',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'agent.web.search.authSecretRef',
    group: 'agent',
    control: 'text',
  },
  {
    key: 'skills.mounts',
    group: 'skills',
    control: 'text',
  },
  {
    key: 'mcp.servers',
    group: 'mcp',
    control: 'text',
  },
];

function permissionPolicyOptionValues(): string[] {
  return ['allow', 'ask', 'deny'];
}

function settingDefinitionFromSchema(schema: SettingDefinitionSchema): SettingDefinition {
  const text = settingText('en-US', schema.key);
  if (!text?.label || !text.description) {
    throw new Error(`setting_i18n_text_missing:${schema.key}`);
  }
  const options = schema.options?.map((value) => {
    const label = text.options?.[value];
    if (!label) throw new Error(`setting_i18n_option_missing:${schema.key}:${value}`);
    return { label, value };
  });
  return {
    ...schema,
    label: text.label,
    description: text.description,
    options,
  };
}

export const SETTING_DEFINITIONS: SettingDefinition[] =
  SETTING_DEFINITION_SCHEMAS.map(settingDefinitionFromSchema);

const SETTING_DEFINITION_BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

export function agentSettingDefinitions(): SettingDefinition[] {
  return definitionsForCatalog(agentSettingsIndex());
}

export function shellPreferenceSettingDefinitions(surface: SettingsSurface): SettingDefinition[] {
  return definitionsForCatalog(shellPreferenceSettingsIndex(surface));
}

function definitionsForCatalog(entries: readonly SettingCatalogEntry[]): SettingDefinition[] {
  return entries.flatMap((entry) => {
    const definition = SETTING_DEFINITION_BY_KEY.get(entry.key);
    return definition ? [{ ...definition, catalog: entry }] : [];
  });
}

const KNOWN_SETTING_KEYS = new Set(Object.keys(DEFAULT_USER_SETTINGS));

function isSupportedSettingValue(value: unknown): value is UserSettingValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) ||
    value === null
  );
}

function getDefaultValue(key: string): UserSettingValue {
  return DEFAULT_USER_SETTINGS[key] ?? null;
}

function normalizeSettingValue(key: string, value: unknown): UserSettingValue {
  const defaultValue = getDefaultValue(key);
  if (key === 'gui.colorTheme') {
    return normalizeGuiThemePreference(value);
  }
  if (key === 'gui.accentColor') {
    return normalizeGuiAccentColor(value);
  }
  if (Array.isArray(defaultValue)) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      throw new Error(activeT('settings.commandDenylist.invalid'));
    }
    return value;
  }
  if (typeof defaultValue === 'boolean') return Boolean(value);
  if (typeof defaultValue === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : defaultValue;
  }
  if (typeof defaultValue === 'string') {
    return typeof value === 'string' ? value : String(value ?? defaultValue);
  }
  return isSupportedSettingValue(value) ? value : defaultValue;
}

function buildEffectiveSettings(
  userSettings: UserSettings,
  overriddenKeys: string[]
): Pick<SettingsStateData, 'effectiveSettings' | 'sources'> {
  const normalizedUserSettings = Object.fromEntries(
    Object.entries(userSettings).map(([key, value]) => [
      key,
      KNOWN_SETTING_KEYS.has(key) ? normalizeSettingValue(key, value) : value,
    ])
  ) as UserSettings;
  const effectiveSettings: UserSettings = {
    ...DEFAULT_USER_SETTINGS,
    ...normalizedUserSettings,
  };
  const sources: Record<string, SettingSource> = {};
  for (const key of Object.keys(effectiveSettings)) {
    if (overriddenKeys.includes(key)) {
      sources[key] = 'user';
    } else {
      sources[key] = 'default';
    }
  }
  return { effectiveSettings, sources };
}

function hasPendingNextRunActivation(
  saved: UserSettings,
  runtime: UserSettings,
): boolean {
  const keys = new Set([...Object.keys(saved), ...Object.keys(runtime)]);
  for (const key of keys) {
    const savedValue = saved[key];
    const runtimeValue = runtime[key];
    if (Array.isArray(savedValue) && Array.isArray(runtimeValue)) {
      if (savedValue.length !== runtimeValue.length
        || savedValue.some((value, index) => value !== runtimeValue[index])) return true;
    } else if (!Object.is(savedValue, runtimeValue)) return true;
  }
  return false;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  const initialEffective = buildEffectiveSettings(DEFAULT_USER_SETTINGS, []);

  const applyCanonicalSettings = (
    snapshot: GetUserSettingsResult,
    overriddenKeys = snapshot.overriddenKeys,
  ) => {
    const next = buildEffectiveSettings(
      snapshot.settings,
      overriddenKeys,
    );
    set({
      environment: snapshot.environment ?? null,
      userSettings: snapshot.settings,
      overriddenKeys,
      storePath: snapshot.storePath,
      effectiveSettings: next.effectiveSettings,
      sources: next.sources,
      loading: false,
      pendingNextRunActivation: hasPendingNextRunActivation(
        snapshot.settings,
        snapshot.runtimeSettings,
      ),
      errorMessage: null,
    });
  };

  const performUserSettingsPatch = async (
    patches: Record<string, UserSettingValue>,
    fallbackError: string,
  ): Promise<UserSettingsActivation | null> => {
    const result = await patchUserSettings(patches);
    if (!result.ok || !result.data) {
      set({
        errorMessage: result.message ?? fallbackError,
      });
      return null;
    }
    if (result.data.activation !== 'immediate' && result.data.activation !== 'nextRun') {
      set({ errorMessage: fallbackError });
      return null;
    }

    const overridden = new Set(get().overriddenKeys);
    for (const key of result.data.changedKeys) {
      if (patches[key] === null) {
        overridden.delete(key);
      } else {
        overridden.add(key);
      }
    }
    const overriddenKeys = Array.from(overridden);
    const refreshed = await getUserSettings();
    if (refreshed.ok && refreshed.data) {
      applyCanonicalSettings(refreshed.data, overriddenKeys);
    } else {
      const next = buildEffectiveSettings(
        result.data.settings,
        overriddenKeys,
      );
      set({
        userSettings: result.data.settings,
        overriddenKeys,
        effectiveSettings: next.effectiveSettings,
        sources: next.sources,
        errorMessage: refreshed.message ?? activeT('settings.error.loadUser'),
      });
    }
    return result.data.activation;
  };

  // Serialize writes and their canonical readback so quick changes cannot publish stale snapshots.
  let pendingWrite = Promise.resolve();
  const applyUserSettingsPatch = (patches: Record<string, UserSettingValue>, error: string) => {
    const captured = structuredClone(patches);
    const result = pendingWrite.then(() => performUserSettingsPatch(captured, error));
    pendingWrite = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    environment: null,
    userSettings: DEFAULT_USER_SETTINGS,
    effectiveSettings: initialEffective.effectiveSettings,
    sources: initialEffective.sources,
    overriddenKeys: [],
    storePath: null,
    loading: false,
    pendingNextRunActivation: false,
    errorMessage: null,

    loadUserSettings: async () => {
      if (get().loading) return;
      set({ loading: true, errorMessage: null });
      const result = await getUserSettings();
      if (!result.ok || !result.data) {
        set({
          loading: false,
          errorMessage: result.message ?? activeT('settings.error.loadUser'),
        });
        return;
      }
      try {
        applyCanonicalSettings(result.data);
      } catch (reason) {
        set({ loading: false, errorMessage: reason instanceof Error ? reason.message : String(reason) });
      }
    },

    patchUserSetting: async (key, value) => {
      const normalized = normalizeSettingValue(key, value);
      return applyUserSettingsPatch(
        { [key]: normalized },
        activeT('settings.error.saveUser', { key }),
      );
    },

    patchUserSettingsBatch: async (patches) => {
      const normalized = Object.fromEntries(
        Object.entries(patches).map(([key, value]) => [
          key,
          value === null ? null : normalizeSettingValue(key, value),
        ]),
      ) as Record<string, UserSettingValue>;
      const keys = Object.keys(normalized).join(', ');
      return applyUserSettingsPatch(
        normalized,
        activeT('settings.error.saveUser', { key: keys }),
      );
    },

    resetUserSetting: async (key) => {
      return applyUserSettingsPatch(
        { [key]: null },
        activeT('settings.error.resetUser', { key }),
      );
    },

  };
});
