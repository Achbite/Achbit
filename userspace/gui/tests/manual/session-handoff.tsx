// Real workbench and store, deterministic read-only transport; no Host, model or user history.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { emptySessionState, projectSession } from '../../../session-core/src/local-agent/reducer';
import type { SessionProjection } from '@achbit/protocol';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import useAppStatusStore from '../../src/state/appStatusStore';
import { UiPluginsProvider } from '../../src/ui-plugins/UiPlugins';
import { ConversationDisplayProvider } from '../../src/components/local-agent/ConversationDisplayProvider';
import AchbitWorkbenchLayout from '../../src/achbit-gui/layout/AchbitWorkbenchLayout';
import { installPaletteDefaults } from '../../src/theme/palette';
import { Button } from '../../src/ui-components';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/achbit-gui/achbitGui.css';

const sessions = ['A','B'].map(name => ({ id: `session:${name}`, title: `会话 ${name}`, createdAt: '2026-01-01', updatedAt: '2026-01-01', workspaceBindings: [] }));
const views = new Map(sessions.map(s => {
  const view = projectSession(emptySessionState(s.id));
  for (let i = 1; i <= 36; i++) {
    const reply = i % 2 === 0, round = Math.ceil(i / 2), id = `${s.id}:${i}`;
    const message: SessionProjection['messages'][number] = { messageId: id, sequence: i, createdAt: s.createdAt,
      runId: `${s.id}:run:${round}`, filesystemReferences: [], pluginSelections: [], feedback: null,
      ...(reply ? { role: 'assistant', providerRequestId: `${s.id}:request:${round}` } : { role: 'user' }),
      content: reply ? `**${s.title} · 第 ${round} 个回答**\n\n这是已经保存的正文。` : `${s.title} · 问题 ${round}` };
    view.messages.push(message); view.timeline.push({ kind: 'message', timelineId: `row:${id}`, messageId: id, sequence: i,
      ...(reply ? { streamId: `stream:${id}` } : {}) });
  }
  view.revision = view.messages.length; return [s.id, view] as const;
}));
const counts = { A: 0, B: 0, statuses: 0, pages: 0 };
const changed = () => window.dispatchEvent(new Event('handoff-fixture-read'));
let release!: () => void;
const hold = new Promise<void>(resolve => { release = resolve; });
const statuses = [...views.values()].map(view => ({ sessionId: view.sessionId, revision: view.revision, run: null }));
const ok = (data: unknown) => Response.json({ ok: true, data });
window.fetch = async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  if (path.endsWith('/conversation/events')) return new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
    init?.signal?.addEventListener('abort', () => c.close(), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  if (path.endsWith('/statuses')) { counts.statuses++; changed(); return ok(statuses); }
  const view = views.get(decodeURIComponent(path.split('/').at(-2) ?? ''));
  if (view && path.endsWith('/projection')) {
    const name = view.sessionId === sessions[0]!.id ? 'A' : 'B'; counts[name]++; changed();
    if (name === 'A') await hold;
    return ok(view);
  }
  if (view && path.endsWith('/read') && JSON.parse(String(init?.body)).view === 'messages') {
    counts.pages++; changed(); return ok({ sessionId: view.sessionId, revision: view.revision, view: 'messages', nextBefore: null,
      items: view.messages.slice(-4).map(m => ({ type: 'message.committed', messageId: m.messageId, role: m.role, content: m.content, truncated: false })) });
  }
  throw new Error(`No fixture route: ${path}`);
};
useLocalAgentStore.setState({ catalogStatus: 'ready', catalog: { projects: [], sessions }, runtimeReady: true });
useAppStatusStore.getState().setApiStatus('connected'); installPaletteDefaults();
function Fixture() {
  const [released, setReleased] = useState(false), [, update] = useState(0);
  React.useEffect(() => { const redraw = () => update(n => n + 1); window.addEventListener('handoff-fixture-read', redraw);
    return () => window.removeEventListener('handoff-fixture-read', redraw); }, []);
  return <><style>{`html,body,#root{height:100%;margin:0}#root{display:grid;grid-template-rows:auto minmax(0,1fr)}#fixture{padding:4px 12px;background:var(--ac-surface-raised);font:var(--ac-font-caption) var(--ac-font-ui)}`}</style>
    <div id="fixture"><Button id="release" size="compact" disabled={released} onClick={() => { release(); setReleased(true); }}>放行 A 的完整读取</Button>{' '}
      <output>完整读取 A={counts.A} B={counts.B}；消息页={counts.pages}；状态表={counts.statuses}</output></div>
    <UiPluginsProvider><ConversationDisplayProvider><AchbitWorkbenchLayout apiStatus="checking" /></ConversationDisplayProvider></UiPluginsProvider></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
