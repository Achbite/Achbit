import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { requestReader } from './readerState';
import { useEffect, useRef, useState } from 'react';
import type { ActivityProjection } from '@deepcode/protocol';
import { useConversationHost, useConversationTheme } from './ConversationHost';
import { loadCodeLanguage } from './codeLanguage';
import { useConversationSessionId } from './ConversationSessionScope';
import { useConversationRowState } from './ConversationVirtualRow';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { isBinaryFileChange } from '../../services/localAgentApi';

import { changedFiles, readRoundChange, readChangeStatistics, type FileChangeStatistics, type ChangeCounts, type ChangedFile } from './fileChangeSummary';
export { roundChangeActivities } from './fileChangeSummary';

export function FileChanges({ activities, compact = false }: { activities: ActivityProjection[]; compact?: boolean }) {
  const language = useUiLanguage();
  const { readChange } = useConversationHost();
  const sessionId = useConversationSessionId();
  const [expanded, setExpanded] = useConversationRowState('file-changes:expanded', !compact);
  const [showAll, setShowAll] = useConversationRowState('file-changes:show-all', false);
  const previousView = useRef({ sessionId, compact });
  useEffect(() => {
    if (previousView.current.sessionId !== sessionId) setShowAll(false);
    if (previousView.current.compact !== compact) setExpanded(!compact);
    previousView.current = { sessionId, compact };
  }, [sessionId, compact, setShowAll, setExpanded]);
  const all = changedFiles(activities);
  const signature = JSON.stringify(all.map((file) => [file.key, file.changes.map((entry) => [entry.recordId, entry.index])]));
  const [statistics, setStatistics] = useState<{ signature: string; files: Map<string, FileChangeStatistics>; errors: Map<string, string> }>({ signature: '', files: new Map(), errors: new Map() });
  useEffect(() => {
    if (!sessionId || !all.length) return;
    const controller = new AbortController();
    const files = new Map<string, FileChangeStatistics>();
    const errors = new Map<string, string>();
    setStatistics({ signature, files, errors });
    void (async () => {
      for (const file of all) {
        try {
          files.set(file.key, await readChangeStatistics(readChange, sessionId, file, controller.signal));
        } catch (error) {
          if (controller.signal.aborted) return;
          errors.set(file.path, error instanceof Error ? error.message : String(error));
        }
        if (controller.signal.aborted) return;
        setStatistics({ signature, files: new Map(files), errors: new Map(errors) });
      }
    })();
    return () => controller.abort();
  }, [sessionId, signature, readChange]);
  const counts = statistics.signature === signature ? statistics.files : new Map<string, FileChangeStatistics>();
  const binaryCount = [...counts.values()].filter((value) => value.kind === 'binary').length;
  const total = counts.size === all.length && counts.size > binaryCount ? [...counts.values()].reduce((total, value) => value.kind === 'text' ? ({ added: total.added + value.counts.added, removed: total.removed + value.counts.removed }) : total, { added: 0, removed: 0 }) : null;
  if (!all.length || !sessionId) return null;
  const entries = (compact || showAll ? all : all.slice(0, 3)).map((file) => {
    const statistic = counts.get(file.key);
    return <div className="conversation-change-row" key={file.key}>
      <button type="button" className="conversation-change-file" title={file.path} onClick={() => requestReader(sessionId, { kind: 'diff', file })}>
        <span>{file.path}</span>{statistic?.kind === 'text' ? <DiffCounts counts={statistic.counts} /> : <small>{statistic?.kind === 'binary' ? t(language, 'changes.binaryPrefix') : ''}{file.changes.length > 1 ? t(language, 'changes.count', { count: file.changes.length }) : ({ create: t(language, 'changes.create'), modify: t(language, 'changes.modify'), delete: t(language, 'changes.delete') }[file.changes[0]!.change.kind])}</small>}
      </button>
    </div>;
  });
  return <section className={`conversation-changes${compact ? ' conversation-changes--compact' : ''}${expanded ? ' is-expanded' : ''}`}>
    <button type="button" className="conversation-changes-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <DeepCodeShellIcon name="compose" /><span><strong>{t(language, 'changes.files', { count: all.length })}</strong>{!compact && <small>{t(language, 'changes.round')}</small>}</span>
      {total && <DiffCounts counts={total} />}
      {binaryCount > 0 && <small className="conversation-change-binary-count">{t(language, 'changes.binaryCount', { count: binaryCount })}</small>}
      <DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
    </button>
    {(compact || expanded) && <div className="conversation-change-list">{entries}
      {!compact && all.length > 3 && <button className="conversation-change-more" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}><span>{showAll ? t(language, 'changes.collapse') : t(language, 'changes.more', { count: all.length - 3 })}</span><DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" /></button>}
      {statistics.signature === signature && statistics.errors.size > 0 && <details className="conversation-change-error"><summary>{t(language, 'changes.unavailable', { count: statistics.errors.size })}</summary>{[...statistics.errors].map(([path, message]) => <p key={path}><strong>{path}</strong><br />{message}</p>)}</details>}
    </div>}
  </section>;
}

export function FileChangePreview({ sessionId, file }: { sessionId: string; file: ChangedFile }) {
  const language = useUiLanguage();
  const { readChange } = useConversationHost();
  const theme = useConversationTheme();
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('changes.loading');
  const [error, setError] = useState('');
  const [binary, setBinary] = useState(false);
  const before = file.changes[0]!.change.before;
  const after = file.changes.at(-1)!.change.after;
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setStatus('changes.loading'); setError(''); setBinary(false);
    void Promise.all([readRoundChange(readChange, sessionId, file, controller.signal), import('./codeDiffView')])
      .then(async ([change, { createCodeDiffView }]) => {
        const language = await loadCodeLanguage('', change.path);
        if (controller.signal.aborted || !container.current) return;
        const view = createCodeDiffView(container.current, change.before ?? '', change.after ?? '', language, theme === 'vs-dark');
        dispose = () => view.destroy();
        setStatus('');
      }).catch((error: unknown) => { if (!controller.signal.aborted) {
        if (isBinaryFileChange(error)) { setBinary(true); setStatus('changes.binary'); }
        else { setError(String(error)); setStatus('changes.failed'); }
      } });
    return () => { controller.abort(); dispose?.(); };
  }, [readChange, sessionId, file, theme]);
  return <section aria-label={t(language, 'changes.diffTitle', { path: file.path })} className="reader-diff">
      {status && <small role="status">{t(language, status)}</small>}
      {error && <p role="alert">{error}</p>}
      {binary && <div className="conversation-diff-binary">{t(language, 'changes.binaryDescription')}<small>{before.exists ? t(language, 'changes.beforeSize', { size: before.sizeBytes ?? t(language, 'changes.unknown') }) : t(language, 'changes.beforeAbsent')} · {after.exists ? t(language, 'changes.afterSize', { size: after.sizeBytes ?? t(language, 'changes.unknown') }) : t(language, 'changes.afterAbsent')}</small></div>}
      <div ref={container} className="conversation-diff-editor" />
    </section>;
}

function DiffCounts({ counts }: { counts: ChangeCounts }) {
  const language = useUiLanguage();
  return <span className="conversation-diff-counts" aria-label={t(language, 'changes.lineCounts', { added: counts.added, removed: counts.removed })}><span className="is-added">+{counts.added}</span><span className="is-removed">-{counts.removed}</span></span>;
}
