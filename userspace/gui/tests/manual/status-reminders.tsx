// Backend-free interaction check using the real status, sidebar, controls and reminder components.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { QueuedInputProjection } from '@achbit/protocol';
import type { UiLanguage } from '../../src/i18n';
import { Button, UiIcon, UI_ICON_NAMES } from '../../src/ui-components';
import ProviderStageStatus from '../../src/components/local-agent/ProviderStageStatus';
import { SessionRunStatus } from '../../src/components/local-agent/SessionRunStatus';
import { ProviderRetryStatus } from '../../src/components/local-agent/RunFailureDetails';
import { UnappliedInputs } from '../../src/components/local-agent/UnappliedInputs';
import { emptyComposerState } from '../../src/components/local-agent/composerSubmission';
import { restoreUnappliedInputs } from '../../src/components/local-agent/composerRecovery';
import { dismissUnappliedInputs } from '../../src/state/unappliedInputReminders';
import Sidebar from '../../src/achbit-gui/layout/AchbitSidebar';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/theme/builtinFonts.css';
import '../../src/theme/paletteBase.css';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/achbit-gui/achbitGui.css';
import '../../src/achbit-gui/styles/achbitShell.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/local-agent/richContent.css';
installPaletteDefaults();
const sessionA = 'session:status-reminders-a', sessionB = 'session:status-reminders-b';
const makeInput = (id: string): QueuedInputProjection => ({ commandId: id, messageId: `message:${id}`, runId: 'run:ended',
  status: 'notApplied', text: `保留的未处理消息 ${id}\nOriginal unsent text`, filesystemReferences: [], pluginSelections: [],
  sequence: 2, createdAt: '2026-11-15T00:00:00Z' });
const phases = ['waitingResponse', 'reasoning', 'awaitingOutput', 'generatingOutput', 'tools', 'preparing'] as const;
const states = ['running', 'completed', 'waiting', 'failed', 'cancelled', 'releasing', 'releaseFailed', 'indeterminate'] as const;
const startedAt = new Date().toISOString();
function Preview() {
  const [language, setLanguage] = useState<UiLanguage>('zh-CN');
  const [sessionId, setSessionId] = useState(sessionA);
  const [inputs, setInputs] = useState([makeInput('old')]);
  const [draft, setDraft] = useState(emptyComposerState);
  const [epoch, setEpoch] = useState(0);
  const [activationCount, setActivationCount] = useState(0);
  const [outcome, setOutcome] = useState('');
  const reset = () => {
    for (const id of [sessionA, sessionB]) sessionStorage.removeItem(`achbit:unapplied-dismissed:${id}`);
    setInputs([makeInput('old')]); setDraft(emptyComposerState()); setOutcome(''); setSessionId(sessionA); setEpoch(value => value + 1);
  };
  Object.assign(window, { __statusRecovery: { snapshot: () => ({ sessionId, inputs, draft, outcome, activationCount }) } });
  return <>
    <style>{`#root{overflow:auto;padding:16px;box-sizing:border-box}.fixture-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.fixture-layout{display:grid;grid-template-columns:260px minmax(0,1fr);gap:24px}.fixture-sidebar{height:420px;border:1px solid var(--ac-border);border-radius:12px;overflow:hidden}.fixture-sidebar>.achbit-gui-left-rail{height:100%}.fixture-content.local-agent{display:block;height:auto;overflow:visible;padding:8px}.fixture-content h2{font-size:16px;margin:18px 0 10px}.fixture-content .local-agent__provider-stage{margin-bottom:12px;min-height:26px}.fixture-session-statuses{display:flex;flex-wrap:wrap;gap:16px}.fixture-icons{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}.fixture-icons .ac-button{justify-content:flex-start}.fixture-draft{width:100%;min-height:64px;background:var(--ac-surface-raised);color:var(--ac-foreground);border:1px solid var(--ac-border);border-radius:8px;padding:8px;font:inherit}.fixture-content .local-agent__unapplied-inputs{padding:8px 0}@media(max-width:680px){.fixture-layout{grid-template-columns:minmax(0,1fr)}.fixture-sidebar{height:260px}}`}</style>
    <nav className="fixture-toolbar">
      <Button id="reset" onClick={reset}>重置</Button>
      <select aria-label="语言" value={language} onChange={event => setLanguage(event.target.value as UiLanguage)}><option value="zh-CN">中文</option><option value="en-US">English</option></select>
      <select aria-label="字号" defaultValue="1" onChange={event => document.documentElement.style.setProperty('--ac-ui-font-scale', event.target.value)}><option value="1">100%</option><option value="1.5">150%</option></select>
      <select aria-label="主题" defaultValue="light" onChange={event => { document.documentElement.dataset.theme = event.target.value; }}><option value="light">浅色</option><option value="dark">深色</option></select>
    </nav>
    <div className="fixture-layout"><aside className="fixture-sidebar"><Sidebar language={language} catalogStatus="ready" projects={[]}
      sessions={[{ id: sessionA, projectId: null, title: '会话 A' }, { id: sessionB, projectId: null, title: '会话 B' }] as never}
      sessionStatuses={{}} statusError={null} readRunMarkers={{}} collapsedProjectIds={new Set()} activeSessionId={sessionId} draftProjectId={null}
      busy={false} activationBusy={false} reorderDisabled={false} reorderError={null} onReorder={() => {}} projectCreateMenuOpen={false}
      onCreatePrimarySession={() => {}} onOpenProjectCreateMenu={() => {}} onToggleProject={() => {}} onCreateProjectSession={() => {}}
      onActivateSession={session => { setSessionId(session.id); setActivationCount(value => value + 1); }}
      onOpenProjectContextMenu={() => {}} onOpenSessionContextMenu={() => {}} onOpenSettings={() => {}} /></aside>
      <main className="fixture-content local-agent">
        <section id="reminders"><h2>未处理消息</h2>
          <UnappliedInputs key={`${sessionId}:${epoch}`} sessionId={sessionId} inputs={inputs} language={language} copiedId={null}
            onCopy={() => setOutcome('copied')} onOpenReference={() => {}} recovery={{ restoredIds: draft.restoredInputIds ?? [], inDecision: false, canUndo: false, undo() {},
              restore(items, append) { setDraft(restoreUnappliedInputs(draft, items, append)); } }} />
          <textarea className="fixture-draft" aria-label="恢复草稿" value={draft.draft} onChange={event => setDraft(value => ({ ...value, draft: event.target.value }))} />
          <div className="fixture-toolbar"><Button id="send-success" onClick={() => { dismissUnappliedInputs(sessionId, inputs.filter(item => item.status === 'notApplied').map(item => item.commandId)); setOutcome('accepted'); }}>模拟提交成功</Button>
            <Button id="send-failure" onClick={() => setOutcome('failed')}>模拟提交失败</Button>
            <Button id="new-unapplied" onClick={() => setInputs(value => [...value, makeInput(`new:${value.length}`)])}>新增未处理消息</Button></div>
          <output id="outcome">{outcome}</output>
        </section>
        <section id="provider-statuses"><h2>状态圈／状态点</h2>{phases.map(phase => <ProviderStageStatus key={phase} language={language} toolPending={false}
          run={{ runId: 'run:status', status: 'running' } as never}
          activity={{ phase, purpose: 'agent', startedAt, lastContentAt: startedAt } as never} />)}
          {states.filter(status => status !== 'running').map(status => <ProviderStageStatus key={status} language={language} toolPending={false}
            run={{ runId: 'run:status', status, waitingReason: 'userInput' } as never} />)}
          <ProviderRetryStatus language={language} projection={{ run: { status: 'running' }, providerAttempts: [{ phase: 'retryWaiting', attempt: 1 }] } as never} />
        </section>
        <section><h2>同类状态图标</h2><div className="fixture-session-statuses">{states.map(status => <SessionRunStatus key={status} language={language}
          run={{ runId: 'run:status', status, waitingReason: 'userInput' } as never} />)}</div></section>
        <section><h2>共享图标＋文字控件</h2><div className="fixture-icons">{UI_ICON_NAMES.map(name => <Button key={name} data-fixture-icon={name}><UiIcon name={name} size={16} /><span>{language === 'zh-CN' ? '操作 ' : 'Action '}{name}</span></Button>)}</div></section>
      </main>
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
