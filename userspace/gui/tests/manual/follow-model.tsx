// Isolated review fixture: real store, composer and viewport; only transport is simulated.
// Unrelated UI is deliberately blank. No daemon, Provider or user settings are accessed.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, SESSION_PROJECTION_VERSION, type ActivityProjection, type AgentSettings, type CommandReply, type LlmProviderProfile, type SessionProjection } from '@achbit/protocol';
import { ConversationComposer } from '../../src/components/local-agent/ConversationComposer';
import { ConversationSessionScope } from '../../src/components/local-agent/ConversationSessionScope';
import { FileChanges } from '../../src/components/local-agent/FileChanges';
import { useAgentComposer } from '../../src/components/local-agent/useAgentComposer';
import { useConversationViewport } from '../../src/components/local-agent/useConversationViewport';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/achbit-gui/styles/achbitShell.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/local-agent/richContent.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();
const sessionId = 'session:follow-model-preview';
// Only the fixture owns these files and responses; FileChanges still computes its real diff.
const changeFixtures = [
  { path: 'preview/composer.tsx', lines: 48 },
  { path: 'preview/layout.css', lines: 40 },
].map((file, index) => ({ ...file, recordId: `record:preview:${index}`, workspaceId: 'workspace:preview',
  before: '', after: Array.from({ length: file.lines }, (_, line) => `preview line ${line + 1}`).join('\n') + '\n' }));
const changeActivities: ActivityProjection[] = changeFixtures.map((file, index) => ({
  activityId: `activity:preview:${index}`, kind: 'tool', status: 'completed', label: 'Preview file change',
  runId: 'run:preview', sequence: index, tool: { operation: 'fs.write', resources: [], recordId: file.recordId,
    fileChanges: [{ workspaceId: file.workspaceId, path: file.path, kind: 'modify', before: { exists: true }, after: { exists: true } }] },
}));
let profiles = [
  { id: 'profile:a', connectionId: 'connection:preview', name: '模型 A', enabled: true, thinking: 'enabled', reasoningEffort: 'high' },
  { id: 'profile:b', connectionId: 'connection:preview', name: '模型 B', enabled: true, thinking: 'enabled', reasoningEffort: 'low' },
  { id: 'profile:unset', connectionId: 'connection:preview', name: '未设档位模型', enabled: true, thinking: 'enabled' },
  { id: 'profile:off', connectionId: 'connection:preview', name: '非推理模型', enabled: true, thinking: 'disabled' },
] as LlmProviderProfile[];
let subagentDefaults: AgentSettings = { enabled: false, profileId: '', reasoningEffort: '', maxConcurrent: 4,
  maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true, allowFullConfiguration: true, presets: '[]' };
const emptyUsage = () => ({ providerCallCount: 0, reportedCallCount: 0, inputTokens: 0, outputTokens: 0,
  cacheReadInputTokens: 0, cacheMissInputTokens: 0, cacheAvailable: false, cacheComplete: false, cacheHitRatio: null });
const emptyProjection = (): SessionProjection => ({ schemaVersion: SESSION_PROJECTION_VERSION, sessionId, revision: 1,
  display: { creationTitle: 'Preview' }, modelSettings: null, subagentSettings: { ...subagentDefaults },
  permissionOverrides: {}, effectivePermissions: null, shellAuthorizations: [], workspaceBindings: [], sessionDirectoryIndexes: [],
  timeline: [], messages: [], queuedInputs: [], narratives: [], assistantDraft: null, interactions: [], pendingInteraction: null,
  pendingApproval: null, plans: [], activePlanRef: null, pendingPlan: null, todoList: null, contextUsage: null,
  contextCompositions: [], tokenUsage: emptyUsage(), totalTokenUsage: emptyUsage(), tokenUsageHistory: [],
  run: null, activities: [], artifacts: [], deliverables: [], terminalError: null });
let currentProjection = emptyProjection();
const reply = (commandId: string): CommandReply => ({ schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted',
  commandId, sessionId, revision: currentProjection.revision });
window.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === `/api/conversation/sessions/${encodeURIComponent(sessionId)}/changes/read`) {
    const { recordId, index } = JSON.parse(String(init?.body));
    const file = changeFixtures.find(file => file.recordId === recordId);
    if (!file || index !== 0) throw new Error('Unexpected fixture file change');
    return Response.json({ ok: true, data: { workspaceId: file.workspaceId, path: file.path, before: file.before, after: file.after } });
  }
  if (url.pathname === '/api/llm/profiles') {
    if (init?.method === 'PATCH') {
      const { profile } = JSON.parse(String(init.body));
      profiles = profiles.map(item => item.id === profile.id ? profile : item);
    }
    return Response.json({ ok: true, data: { profiles, defaultProfileId: useLocalAgentStore.getState().defaultProfileId } });
  }
  if (url.pathname.endsWith('/commands')) {
    const command = JSON.parse(String(init?.body));
    if (command.type === 'session.subagent-settings.set') {
      subagentDefaults = command.settings;
      currentProjection = { ...currentProjection, subagentSettings: command.settings };
    } else if (command.type === 'session.model-settings.set') currentProjection = { ...currentProjection, modelSettings: command.settings };
    else throw new Error(`Unexpected fixture command: ${command.type}`);
    currentProjection = { ...currentProjection, revision: currentProjection.revision + 1 };
    return Response.json({ ok: true, data: reply(command.commandId) });
  }
  if (url.pathname === '/api/user-settings') {
    if (init?.method === 'PATCH') {
      const { patches } = JSON.parse(String(init.body));
      subagentDefaults = { ...subagentDefaults, ...Object.fromEntries(Object.entries(patches)
        .map(([key, value]) => [key.slice('agent.subagents.'.length), value])) };
      const settings = { ...useSettingsStore.getState().effectiveSettings, ...patches };
      return Response.json({ ok: true, data: { settings, changedKeys: Object.keys(patches), activation: 'nextRun' } });
    }
    const settings = { ...useSettingsStore.getState().effectiveSettings, ...Object.fromEntries(Object.entries(subagentDefaults)
      .map(([key, value]) => [`agent.subagents.${key}`, value])) };
    return Response.json({ ok: true, data: { settings, runtimeSettings: settings, overriddenKeys: [], storePath: 'fixture' } });
  }
  if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: currentProjection });
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};
useLocalAgentStore.setState({ profiles, defaultProfileId: 'profile:a', selectedProfileId: 'profile:a', reasoningEffortOverride: 'high',
  connections: [{ id: 'connection:preview', name: '预览模型' }] as never });

function Preview() {
  const projection = useLocalAgentStore(state => state.projection);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('隔离预览 · 无关区域留白');
  const [streaming, setStreaming] = useState(false);
  const [showChanges, setShowChanges] = useState(true);
  const [oldStack, setOldStack] = useState(false);
  const [previewWidth, setPreviewWidth] = useState('680px');
  const viewport = useConversationViewport({ sessionId, loading: false, projection,
    presentationLayoutKey: String(Boolean(projection?.pendingPlan)), assistantDraftLayoutKey: text, timelineExtentKey: text });
  const composer = useAgentComposer('zh-CN', viewport.setLatestFollowMode);
  useEffect(() => {
    useLocalAgentStore.setState({
      respondPlan: async response => {
        useLocalAgentStore.setState({ submitting: true });
        await new Promise(resolve => setTimeout(resolve, 900));
        currentProjection = { ...currentProjection, revision: currentProjection.revision + 1, pendingPlan: null };
        useLocalAgentStore.setState({ projection: currentProjection, submitting: false });
        setText(response.kind === 'confirm' ? '计划已确认，正在执行。' : '计划已取消。');
        setStreaming(response.kind === 'confirm');
        return reply(`command:preview:plan:${currentProjection.revision}`);
      },
      sendMessage: async text => {
        const state = useLocalAgentStore.getState();
        if (state.draftSubagentSettings) subagentDefaults = state.draftSubagentSettings;
        currentProjection = { ...emptyProjection(), modelSettings: {
          profileId: state.selectedProfileId!, reasoningEffortOverride: state.reasoningEffortOverride,
        } };
        useLocalAgentStore.setState({ sessionId, projection: currentProjection, defaultProfileId: state.selectedProfileId, draftSubagentSettings: null });
        setText(`已接收：${text}`);
        setNotice(`已使用 ${state.profiles.find(item => item.id === state.selectedProfileId)?.name}；可新建对话检查继承`);
        return reply('command:preview:message');
      },
    });
  }, []);
  useEffect(() => {
    if (!streaming) return;
    let count = 0;
    const timer = window.setInterval(() => {
      count++;
      setText(current => `${current}\n执行进度 ${count}：正在检查本次修改。`);
      if (count === 12) setStreaming(false);
    }, 550);
    return () => window.clearInterval(timer);
  }, [streaming]);
  const showPlan = () => {
    setStreaming(false);
    currentProjection = { ...emptyProjection(), pendingPlan: { planId: 'plan:preview', revision: 1,
      title: '确认后继续执行前端检查', steps: [], mutationManifest: [] } } as unknown as SessionProjection;
    useLocalAgentStore.setState({ sessionId, projection: currentProjection });
    setText('可先向上翻阅，再确认计划；确认后仍可向上滚动。');
  };
  return <>
    <style>{`*{box-sizing:border-box}html,body,#root{height:100%;margin:0;font-family:var(--ac-font-ui);color:var(--ac-foreground);background:var(--ac-surface)}#root{display:grid;grid-template-rows:auto minmax(0,1fr)}.review-toolbar{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid var(--ac-border);font-size:13px;flex-wrap:wrap}.review-toolbar button{font:inherit;padding:6px 10px}.review-status{margin-left:auto}.review-shell{display:grid;grid-template-columns:minmax(12px,1fr) minmax(0,var(--preview-width)) minmax(12px,1fr);min-height:0}.review-main{grid-column:2;grid-template-rows:40px minmax(0,1fr) auto}.review-main--old .local-agent__composer{z-index:auto}.review-blank{height:120px;margin:20px 0;background:var(--ac-surface);border-bottom:1px solid var(--ac-border)}.review-output{white-space:pre-wrap;line-height:1.9;padding:16px 0;min-height:90px}.review-main .local-agent__body{scrollbar-width:auto}`}</style>
    <nav className="review-toolbar" aria-label="预览操作">
      <button onClick={showPlan}>显示待确认计划</button>
      <button onClick={() => viewport.scrollToAnchor('blank:3')}>查看历史</button>
      <button onClick={() => setText(current => `${current}\n${'新增执行消息。\n'.repeat(8)}`)}>追加执行消息</button>
      <button onClick={() => { setStreaming(false); useLocalAgentStore.getState().startNewSession(); setText(''); setNotice('新对话：已继承最近使用模型及保存的档位'); }}>新建对话</button>
      <label><input type="checkbox" checked={showChanges} onChange={event => setShowChanges(event.target.checked)} />预览修改：2 文件 / +88 行</label>
      <label><input type="checkbox" checked={oldStack} onChange={event => setOldStack(event.target.checked)} />对照旧层级</label>
      <label>预览宽度<select aria-label="预览宽度" value={previewWidth} onChange={event => setPreviewWidth(event.target.value)}><option value="900px">900px</option><option value="680px">680px</option><option value="520px">520px</option></select></label>
      <output className="review-status">{viewport.followingLatest ? '跟随最新' : '阅读历史'} · {notice}</output>
    </nav>
    <div className="review-shell" style={{ '--preview-width': previewWidth } as React.CSSProperties}><main className={`local-agent review-main${oldStack ? ' review-main--old' : ''}`} data-following={viewport.followingLatest}>
      <header aria-hidden="true" />
      <div className="local-agent__viewport">
        <div ref={viewport.bodyRef} className="local-agent__body" aria-label="对话内容" {...viewport.bodyHandlers}>
          <div ref={viewport.transcriptRef} className="local-agent__transcript">
            {Array.from({ length: 9 }, (_, index) => <div className="review-blank" key={index} data-conversation-anchor={`blank:${index}`} aria-hidden="true" />)}
            <section className="review-output" data-conversation-anchor="latest" aria-label="最新执行消息">{text}</section>
            <div ref={viewport.messageEndRef} />
          </div>
        </div>
        {viewport.showJumpToLatest && <button className="local-agent__jump-latest" aria-label="前往最新消息" onClick={viewport.scrollToLatest}>↓</button>}
      </div>
      <ConversationComposer composer={composer} language="zh-CN" uiActionError={null} onDismissUiActionError={() => {}} onEditBrowserReview={() => {}}
        changeBar={showChanges && <ConversationSessionScope.Provider value={sessionId}><FileChanges activities={changeActivities} compact /></ConversationSessionScope.Provider>} />
    </main></div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
