// Production workbench and submit path. Only HTTP facts and their delivery order are controlled here.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, DEFAULT_USER_SETTINGS, type ConversationCommand, type SessionProjection } from '@achbit/protocol';
import { projectSession, emptySessionState } from '../../../session-core/src/local-agent/reducer';
import AchbitWorkbenchLayout from '../../src/achbit-gui/layout/AchbitWorkbenchLayout';
import { ConversationDisplayProvider } from '../../src/components/local-agent/ConversationDisplayProvider';
import { UiPluginsProvider } from '../../src/ui-plugins/UiPlugins';
import { useLocalAgentStore as store } from '../../src/state/localAgentStore';
import { useSettingsStore } from '../../src/state/settingsStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import { InteractionPreview } from './InteractionPreview';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/achbit-gui/achbitGui.css';

const scenario = new URLSearchParams(location.search).get('scene');
const id = 'session:echo', other = 'session:other', epoch = '2026-01-01T00:00:00Z';
const profile = { id: 'profile:echo', connectionId: 'connection:fixture', name: 'Fixture', model: 'fixture',
  providerFlavor: 'openai', kind: 'responses', thinking: 'disabled', enabled: true } as const;
const settings = { ...DEFAULT_USER_SETTINGS, 'workbench.language': 'zh-CN' };
useSettingsStore.setState({ effectiveSettings: settings, userSettings: settings, storePath: '/fixture/settings.json' });
const blank = (sessionId: string): SessionProjection => ({ ...projectSession(emptySessionState(sessionId)), revision: 1,
  modelSettings: { profileId: profile.id, reasoningEffortOverride: null } });
let p = blank(id);
const otherView = blank(other);
const run = { runId: 'run:fixture', profileId: profile.id, status: 'running' as const, workspaceBindings: [] };
const summary = (sid: string) => ({ id: sid, title: sid, createdAt: epoch, updatedAt: epoch, workspaceBindings: [], profileId: profile.id });
const catalog = () => ({ projects: [], sessions: [summary(other), ...(created ? [summary(id)] : [])] });
let created = scenario !== 'new', serial = 0;
function message(commandId: string, text: string, messageId = `server:${++serial}`, runId?: string) {
  const sequence = p.revision + 1;
  p = { ...p, revision: sequence, messages: [...p.messages, { commandId, messageId, content: text, role: 'user', sequence,
    createdAt: epoch, filesystemReferences: [], pluginSelections: [], feedback: null, ...(runId ? { runId } : {}) }],
    timeline: [...p.timeline, { kind: 'message', sequence, timelineId: 'row:' + messageId, messageId }] };
}
if (scenario !== 'new') message('command:old', '同一句话');
if (scenario === 'queue') p = { ...p, run };
store.setState({ sessionId: created ? id : null, projection: created ? p : null, profiles: [profile],
  selectedProfileId: profile.id, defaultProfileId: profile.id, runtimeReady: true, profileRead: { phase: 'ready' },
  catalogStatus: 'ready', catalog: catalog(), welcomeIndex: 0 });
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { release, promise }; }
const createGate = gate();
let readGate: ReturnType<typeof gate> | null = null;
let pending: { command: Extract<ConversationCommand, {type: 'message.submit'}>; receipt: ReturnType<typeof gate>; rejected: boolean } | undefined;
const ok = (data: unknown) => Response.json({ ok: true, data });
window.fetch = async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  if (path.endsWith('/sessions') && init?.method === 'POST') { await createGate.promise; created = true; return ok(p); }
  if (path.endsWith('/commands')) {
    const command = JSON.parse(String(init?.body)) as ConversationCommand;
    if (command.type !== 'message.submit' || command.sessionId !== id || pending) throw Error('unexpected fixture command');
    const item = pending = { command, receipt: gate(), rejected: false };
    await item.receipt.promise; pending = undefined;
    return ok({ schemaVersion: COMMAND_REPLY_VERSION, commandId: command.commandId, sessionId: id, revision: p.revision,
      ...(item.rejected ? { status: 'rejected', error: { code: 'input_declined', message: '此消息未送达。' } } : { status: 'accepted' }) });
  }
  if (path.endsWith('/projection')) {
    if (decodeURIComponent(path).includes('/'+other+'/')) return ok(otherView);
    if (readGate) await readGate.promise;
    return ok(p);
  }
  if (path.endsWith('/statuses')) return ok([p, otherView].map(v => ({ sessionId: v.sessionId, revision: v.revision, run: v.run })));
  if (path.endsWith('/catalog')) return ok(catalog());
  if (path.endsWith('/plugins')) return ok({ revision: 'fixture', plugins: [] });
  if (path.endsWith('/llm/profiles')) return ok({ profiles: [profile], connections: [], defaultProfileId: profile.id });
  if (path.endsWith('/llm/usage')) return ok({ query: JSON.parse(String(init?.body)), coverageFrom: 0, currency: 'USD',
    totals: { calls: 0, reportedCalls: 0, pricedCalls: 0, cacheReportedCalls: 0, cacheReportedInputTokens: 0, inputTokens: 0,
      outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 }, buckets: [], connections: [], sessions: [] });
  throw Error('unexpected fixture route: ' + path);
};
Object.assign(window, { echoFixture: {
  create: createGate.release,
  command: () => pending?.command,
  selected: () => store.getState().sessionId,
  openOther: () => store.getState().activateSession(other), // same selection operation used by a desktop completion-open event
  commit() {
    const c = pending!.command;
    if (c.runId) p = { ...p, revision: p.revision + 1, queuedInputs: [...p.queuedInputs, { commandId: c.commandId,
      messageId: `queued:${++serial}`, text: c.text, createdAt: epoch, status: 'queued', sequence: p.revision + 1,
      runId: c.runId, filesystemReferences: [], pluginSelections: [] }] };
    else { message(c.commandId, c.text); p = { ...p, run }; }
  },
  foreign() { message('command:other-window', pending!.command.text); },
  refresh: () => store.getState().refresh(),
  reply(reject = false) { pending!.rejected = reject; pending!.receipt.release(); },
  holdRead() { readGate = gate(); },
  releaseRead() { readGate?.release(); readGate = null; },
  async consume() { const [q, ...rest] = p.queuedInputs; if (!q) throw Error('queue empty'); p = { ...p, queuedInputs: rest };
    message(q.commandId, q.text, q.messageId, q.runId); await store.getState().refresh(); },
} });
installPaletteDefaults();
createRoot(document.querySelector('#root')!).render(<InteractionPreview><UiPluginsProvider><ConversationDisplayProvider>
  <AchbitWorkbenchLayout apiStatus="checking" />
</ConversationDisplayProvider></UiPluginsProvider></InteractionPreview>);
