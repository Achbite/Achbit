import UiIcon from '../../icons/registry';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import React, { useEffect, useState } from 'react';
import { useConversationHost } from './ConversationHost';
import type { JsonObject } from '@achbit/protocol';
import { useConversationRowState } from './ConversationVirtualRow';

export function ReasoningDetails({ sessionId, requestId, live = false, summary }: { sessionId: string; requestId: string; live?: boolean; summary?: React.ReactNode }) {
  const language = useUiLanguage();
  const { readConversation } = useConversationHost();
  const [open, setOpen] = useConversationRowState(`reasoning:${requestId}:open`, false);
  const [page, setPage] = useConversationRowState<JsonObject | null>(`reasoning:${requestId}:page`, null);
  const [offset, setOffset] = useConversationRowState(`reasoning:${requestId}:offset`, 0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await readConversation(sessionId, { view: 'reasoning', providerRequestId: requestId, offset }, controller.signal);
        if (!controller.signal.aborted) { setPage(result.items[0] ?? null); setError(''); }
      } catch (error) { if (!controller.signal.aborted) setError(String(error)); }
      if (live && !controller.signal.aborted) timer = setTimeout(() => void load(), 1000);
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [readConversation, sessionId, requestId, live, open, offset]);
  return <details className="conversation-reasoning" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{summary ?? t(language, live ? 'agent.reasoning.running' : 'agent.reasoning.view')}<UiIcon name="chevronDown" size={14} className="conversation-disclosure-chevron" /></summary>
    {open && <div className="conversation-reasoning-body" tabIndex={0}>{error ? <p role="alert">{error}</p> : !page ? <span>{t(language, 'agent.reasoning.loading')}</span> : <>
      {Array.isArray(page.parts) && page.parts.map((part, index) => part && typeof part === 'object' && !Array.isArray(part)
        ? <section key={index}><small>{t(language, part.kind === 'summary' ? 'agent.reasoning.summary' : 'agent.reasoning.text')}</small><pre>{String(part.content)}</pre></section> : null)}
      {Array.isArray(page.parts) && !page.parts.length && <span>{t(language, 'agent.reasoning.empty')}</span>}
      {page.truncated === true && <small>{t(language, live ? 'agent.reasoning.recent' : 'agent.reasoning.truncated')}</small>}
      {!live && offset > 0 && <button type="button" onClick={() => setOffset(0)}>{t(language, 'agent.reasoning.start')}</button>}
      {!live && typeof page.nextOffset === 'number' && <button type="button" onClick={() => setOffset(Number(page.nextOffset))}>{t(language, 'agent.reasoning.next')}</button>}
    </>}</div>}
  </details>;
}

export function ReasoningHistory({ sessionId, runId }: { sessionId: string; runId: string }) {
  const language = useUiLanguage();
  const { readConversation } = useConversationHost();
  const [items, setItems] = useState<JsonObject[]>([]);
  const [before, setBefore] = useState<number | undefined>();
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void readConversation(sessionId, { view: 'reasoning', limit: 50, ...(before ? { before } : {}) }, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setItems(result.items); setNext(result.nextBefore); setError(''); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [readConversation, sessionId, runId, before]);
  return <>{error && <p role="alert">{error}</p>}{items.filter((item) => item.runId === runId
    && Array.isArray(item.kinds) && item.kinds.length).map((item) => <ReasoningDetails key={String(item.providerRequestId)} sessionId={sessionId} requestId={String(item.providerRequestId)} />)}
    {next !== null && <button type="button" onClick={() => setBefore(next)}>{t(language, 'agent.reasoning.earlier')}</button>}</>;
}
