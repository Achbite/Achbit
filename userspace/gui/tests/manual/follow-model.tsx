// Isolated review fixture: real store, composer and viewport; only transport is simulated.
// Unrelated UI is deliberately blank. No daemon, Provider or user settings are accessed.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, SESSION_PROJECTION_VERSION, type ActivityProjection, type AgentSettings, type CommandReply, type LlmProviderProfile, type SessionProjection } from '@achbit/protocol';
import { ConversationComposer } from '../../src/components/local-agent/ConversationComposer';
import { ConversationSessionScope } from '../../src/components/local-agent/ConversationSessionScope';
import { FileChanges } from '../../src/components/local-agent/FileChanges';
import { UnappliedInputs } from '../../src/components/local-agent/UnappliedInputs';
import { RunFailureDetails, StoppedRunStatus } from '../../src/components/local-agent/RunFailureDetails';
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
import '../../src/components/local-agent/documentPreview.css';
import '../../src/ui-components/controls.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();
const sessionId = 'session:follow-model-preview';
const fixtureImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
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
    return Response.json({ ok: true, data: { settings, runtimeSettings: settings, storePath: 'fixture' } });
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
  const [readerExpanded, setReaderExpanded] = useState(false);
  const [geometry, setGeometry] = useState('尚未检查几何');
  const originalInput = React.useRef<HTMLTextAreaElement | null>(null);
  const viewport = useConversationViewport({ sessionId, loading: false, projection,
    presentationLayoutKey: String(Boolean(projection?.pendingPlan)), assistantDraftLayoutKey: text, timelineExtentKey: text });
  const composer = useAgentComposer('zh-CN', viewport.setLatestFollowMode);
  useEffect(() => { originalInput.current ??= composer.textareaRef.current; });
  const inspectGeometry = async () => {
    const input = composer.textareaRef.current;
    input?.focus({ preventScroll: true });
    const surface = input?.closest<HTMLElement>('.local-agent__composer');
    await Promise.allSettled(surface?.getAnimations({ subtree: true }).map(animation => animation.finished) ?? []);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const visible = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      const rect = node?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? rect : null;
    };
    const intersect = (a: DOMRect | null, b: DOMRect | null) => Boolean(a && b
      && Math.min(a.right, b.right) > Math.max(a.left, b.left) + .5
      && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + .5);
    const disclosure = visible('.local-agent__composer-disclosure');
    const changes = visible('.conversation-change-dock .conversation-changes-heading');
    const attachments = visible('.local-agent__draft-attachments');
    const textarea = visible('.local-agent__composer > textarea');
    const footer = visible('.local-agent__composer-footer');
    const model = visible('.achbit-session-model__selector');
    const primary = visible('.local-agent__composer-primary-actions');
    const surfaceRect = surface?.getBoundingClientRect();
    const transformedTop = surfaceRect ? surfaceRect.top - 1 + new DOMMatrix(getComputedStyle(surface!, '::before').transform).f : Infinity;
    const checks = {
      disclosureAndChangesSeparate: !intersect(disclosure, changes),
      accessoriesAboveFocusedSurface: [disclosure, changes].every(rect => !rect || rect.bottom <= transformedTop + .5),
      attachmentsAndInputSeparate: !intersect(attachments, textarea),
      inputAndFooterSeparate: !intersect(textarea, footer),
      modelAndPrimarySeparate: !intersect(model, primary),
      originalInputRetained: input === originalInput.current,
      composerInsidePanel: Boolean(surfaceRect && surfaceRect.left >= 0 && surfaceRect.right <= innerWidth + .5),
    };
    setGeometry(JSON.stringify({ passed: Object.values(checks).every(Boolean), width: previewWidth,
      readerExpanded, attachmentCount: composer.pastedTexts.length + composer.pastedImages.length + composer.pendingFilesystemPaths.length,
      checks, gap: changes ? Math.round((transformedTop - changes.bottom) * 10) / 10 : null }, null, 2));
  };
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
    currentProjection = { ...emptyProjection(), queuedInputs: currentProjection.queuedInputs, pendingPlan: { planId: 'plan:preview', revision: 1,
      title: '确认后继续执行前端检查', steps: [], mutationManifest: [] } } as unknown as SessionProjection;
    useLocalAgentStore.setState({ sessionId, projection: currentProjection });
    setText('可先向上翻阅，再确认计划；确认后仍可向上滚动。');
  };
  return <>
    <style>{`*{box-sizing:border-box}html,body,#root{height:100%;margin:0;font-family:var(--ac-font-ui);color:var(--ac-foreground);background:var(--ac-surface)}#root{display:grid;grid-template-rows:auto minmax(0,1fr)}.review-toolbar{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid var(--ac-border);font-size:13px;flex-wrap:wrap}.review-toolbar button{font:inherit;padding:6px 10px}.review-status{margin-left:auto}.review-shell{display:grid;grid-template-columns:minmax(12px,1fr) minmax(0,var(--preview-width)) minmax(12px,1fr);min-height:0}.review-main{grid-column:2;grid-template-rows:40px minmax(0,1fr) auto}.review-main--old .local-agent__composer{z-index:auto}.review-blank{height:120px;margin:20px 0;background:var(--ac-surface);border-bottom:1px solid var(--ac-border)}.review-output{white-space:pre-wrap;line-height:1.9;padding:16px 0;min-height:90px}.review-main .local-agent__body{scrollbar-width:auto}`}</style>
    <nav className="review-toolbar" aria-label="预览操作">
      <button onClick={showPlan}>显示待确认计划</button>
      {(['failed', 'cancelled', 'indeterminate'] as const).map(status => <button key={status} onClick={() => {
        currentProjection = { ...emptyProjection(), run: { runId: 'run:recovery', status, profileId: 'profile:a', workspaceBindings: [] },
          terminalError: status === 'failed' ? { code: 'provider_failed', message: 'Original upstream connection failure' } : null,
          queuedInputs: [{ commandId: 'command:recovery', messageId: 'message:recovery', runId: 'run:recovery', status: 'notApplied', sequence: 2,
            createdAt: '2026-11-07T00:00:00Z', text: '恢复这条完整消息', pluginSelections: [],
            filesystemReferences: [{ referenceId: 'reference:recovery', workspaceId: 'workspace:archive', logicalPath: 'notes.md', displayName: 'notes.md', kind: 'file', mediaType: 'text/markdown', byteLength: 20 }] }] };
        useLocalAgentStore.setState({ sessionId, projection: currentProjection });
        viewport.scrollToLatest();
      }}>{status === 'failed' ? '消息恢复场景' : status === 'cancelled' ? '停止场景' : '结果待确认场景'}</button>)}
      <button onClick={() => viewport.scrollToAnchor('blank:3')}>查看历史</button>
      <button onClick={() => setText(current => `${current}\n${'新增执行消息。\n'.repeat(8)}`)}>追加执行消息</button>
      <button onClick={() => { setStreaming(false); useLocalAgentStore.getState().startNewSession(); setText(''); setNotice('新对话：已继承最近使用模型及保存的档位'); }}>新建对话</button>
      <label><input type="checkbox" checked={showChanges} onChange={event => setShowChanges(event.target.checked)} />预览修改：2 文件 / +88 行</label>
      <label><input type="checkbox" checked={oldStack} onChange={event => setOldStack(event.target.checked)} />对照旧层级</label>
      <label>预览宽度<select aria-label="预览宽度" value={previewWidth} onChange={event => setPreviewWidth(event.target.value)}><option value="900px">900px</option><option value="680px">680px</option><option value="520px">520px</option><option value="360px">360px</option><option value="260px">260px</option></select></label>
      <label><input aria-label="展开 Reader" type="checkbox" checked={readerExpanded} onChange={event => setReaderExpanded(event.target.checked)} />展开 Reader</label>
      <button onClick={() => composer.setPendingFilesystemPaths([{ path: '/fixture/很长的附件名称用于检查窄面板.md', kind: 'file' }])}>添加文件附件</button>
      <button onClick={() => composer.setPastedTexts([{ inputId: 'paste:overlap', text: '附件正文\n'.repeat(50), expanded: true }])}>添加展开文本</button>
      <button onClick={() => composer.setPastedImages([{ inputId: 'image:overlap', name: '截图.png', mediaType: 'image/png',
        byteLength: atob(fixtureImage).length, dataUrl: `data:image/png;base64,${fixtureImage}` }])}>添加图片</button>
      <button onClick={() => { composer.setPastedTexts([]); composer.setPastedImages([]); composer.setPendingFilesystemPaths([]); }}>清空附件</button>
      <button onClick={() => void inspectGeometry()}>聚焦并检查几何</button>
      <button onClick={() => {
        currentProjection = { ...currentProjection, contextUsage: { providerRequestId: 'request:geometry', providerRuntimeRef: 'provider:fixture',
          runId: 'run:preview', sequence: 1, updatedAt: '2026-11-06T00:00:00Z', inputTokens: 1200, outputTokens: 100, contextWindowTokens: 128000 } };
        useLocalAgentStore.setState({ sessionId, projection: currentProjection });
      }}>显示上下文用量</button>
      <details><summary>几何记录</summary><pre aria-label="几何检查结果" style={{ maxHeight: 170, overflow: 'auto', fontSize: 11 }}>{geometry}</pre></details>
      <output className="review-status">{viewport.followingLatest ? '跟随最新' : '阅读历史'} · {notice}</output>
    </nav>
    <div className="review-shell" style={{ '--preview-width': previewWidth } as React.CSSProperties}><main className={`local-agent review-main${oldStack ? ' review-main--old' : ''}${readerExpanded ? ' local-agent--expanded' : ''}`} data-following={viewport.followingLatest}>
      <header aria-hidden="true" />
      <div className="local-agent__viewport">
        <div ref={viewport.bodyRef} className="local-agent__body" aria-label="对话内容" {...viewport.bodyHandlers}>
          <div ref={viewport.transcriptRef} className="local-agent__transcript">
            {Array.from({ length: 9 }, (_, index) => <div className="review-blank" key={index} data-conversation-anchor={`blank:${index}`} aria-hidden="true" />)}
            <section className="review-output" data-conversation-anchor="latest" aria-label="最新执行消息">{text}</section>
            {projection && <RunFailureDetails projection={projection} language="zh-CN" onError={value => setNotice(value ?? '')} />}
            {projection && <StoppedRunStatus projection={projection} language="zh-CN" onError={value => setNotice(value ?? '')} />}
            {projection && <UnappliedInputs key={projection.sessionId} sessionId={projection.sessionId} inputs={projection.queuedInputs} language="zh-CN"
              copiedId={null} onCopy={() => {}} onOpenReference={() => {}} recovery={composer.unappliedRecovery} />}
            <div ref={viewport.messageEndRef} />
          </div>
        </div>
        {viewport.showJumpToLatest && <button className="local-agent__jump-latest" aria-label="前往最新消息" onClick={viewport.scrollToLatest}>↓</button>}
      </div>
      {readerExpanded && <aside className="local-agent__reader" style={{ padding: 20, color: 'var(--ac-muted)' }}>Reader 内容区域 · 保留原网格分区</aside>}
      <ConversationComposer composer={composer} readerExpanded={readerExpanded} language="zh-CN" uiActionError={null} onDismissUiActionError={() => {}} onEditBrowserReview={() => {}}
        changeBar={showChanges && <ConversationSessionScope.Provider value={sessionId}><FileChanges activities={changeActivities} compact /></ConversationSessionScope.Provider>} />
    </main></div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
