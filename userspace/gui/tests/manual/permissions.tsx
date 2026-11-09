// Production permission control with isolated stores and captured writes; no backend or user session.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, permissionSettings } from '@achbit/protocol';
import { emptySessionState, projectSession } from '../../../session-core/src/local-agent/reducer';
import { ComposerPermissionControl } from '../../src/components/local-agent/ComposerPermissionControl';
import { useAgentComposer } from '../../src/components/local-agent/useAgentComposer';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/theme/builtinFonts.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/settings-center/settingsCenter.css';

installPaletteDefaults();
const query = new URLSearchParams(location.search);
const language = query.get('language') === 'en-US' ? 'en-US' : 'zh-CN';
const sessionId = 'session:permission-preview';
const initial = permissionSettings({ 'agent.permissions.networkRead': 'ask',
  'agent.permissions.workspaceMutation': 'review', 'agent.permissions.engineeringDecisions': 'delegate' });
const writes: { owner: string; patches: object }[] = [];
useSettingsStore.setState({ effectiveSettings: { ...useSettingsStore.getState().effectiveSettings, ...initial, 'workbench.language': language },
  patchUserSettingsBatch: async patches => {
    writes.push({ owner: 'defaults', patches });
    useSettingsStore.setState(state => ({ effectiveSettings: { ...state.effectiveSettings, ...patches } }));
    return 'immediate';
  } });
useLocalAgentStore.setState({ sessionId: query.has('defaultOnly') ? null : sessionId,
  projection: query.has('defaultOnly') ? null : { ...projectSession(emptySessionState(sessionId)), effectivePermissions: initial },
  setPermissions: async patches => {
    writes.push({ owner: 'session', patches });
    if (query.has('reject')) {
      useLocalAgentStore.setState({ error: 'fixture_permission_rejected' });
      throw new Error('fixture_permission_rejected');
    }
    useLocalAgentStore.setState(state => ({ projection: { ...state.projection!, effectivePermissions: { ...state.projection!.effectivePermissions, ...patches } } }));
    return { schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted', commandId: 'command:fixture', sessionId, revision: writes.length };
  } });

function Preview() {
  const composer = useAgentComposer(language, () => {});
  const permissions = useLocalAgentStore(state => state.projection?.effectivePermissions);
  const defaults = useSettingsStore(state => state.effectiveSettings);
  const error = useLocalAgentStore(state => state.error);
  return <>
    <style>{`body{margin:0;background:var(--ac-surface);color:var(--ac-foreground);font:14px/1.5 var(--ac-font-ui)}main.fixture{display:block;box-sizing:border-box;padding:24px;height:auto;width:100%}.fixture pre{white-space:pre-wrap;overflow-wrap:anywhere}`}</style>
    <main className="local-agent fixture">
      <h1>权限入口检查</h1>
      <ComposerPermissionControl language={language} composer={composer} />
      <pre data-testid="permission-state">{JSON.stringify({ permissions, defaults: permissionSettings(defaults), writes, error }, null, 2)}</pre>
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
