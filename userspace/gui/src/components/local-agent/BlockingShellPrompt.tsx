import { useId, useLayoutEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { Button, IconButton, PanelHeader, UiIcon } from '../../ui-components';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import type { BlockingShell } from './shellProgress';
import { ShellLiveOutput, useShellStop } from './ShellCommandProgress';
import './shellProgress.css';

/** A wait may target several jobs. Keep navigation mounted and key the output/actions to the exact execution. */
export function BlockingShellPrompt({ sessionId, shells, language }: { sessionId: string; shells: readonly BlockingShell[]; language: UiLanguage }) {
  const [selectedJob, select] = useState<string>();
  const index = Math.max(0, shells.findIndex(a => a.tool.process.jobId === selectedJob));
  const activity = shells[index];
  const root = useRef<HTMLElement>(null);
  const identity = useUiOwner('composer.shell-wait', undefined, { sessionId, runId: activity?.runId, callId: activity?.callId, jobId: activity?.tool.process.jobId });
  useLayoutEffect(() => {
    const node = root.current;
    return () => {
      // Don't steal focus on completion, Session switches, or while the user is reading history.
      if (!node?.contains(document.activeElement)) return;
      const input = node.closest('.local-agent__composer-content')?.querySelector<HTMLTextAreaElement>('textarea');
      queueMicrotask(() => { if (input?.isConnected && document.activeElement === document.body) input.focus({ preventScroll: true }); });
    };
  }, []);
  if (!activity) return null;
  const target = { sessionId, runId: activity.runId, callId: activity.callId, jobId: activity.tool.process.jobId };
  return <section ref={root} {...identity.part('root')} className="local-agent__interaction-panel local-agent__shell-wait" aria-label={t(language, 'agent.tool.shell.awaitingResult')}>
    <PanelHeader className="local-agent__interaction-panel-heading"><span className="local-agent__interaction-caption">
      <span className="local-agent__run-spinner" aria-hidden="true"/><strong role="status">{t(language, 'agent.tool.shell.awaitingResult')}</strong>
    </span>{shells.length > 1 ? <div className="local-agent__interaction-navigation" role="group" aria-label={t(language, 'agent.tool.shell.managed')}>
      <IconButton {...identity.action('previous', 'click')} icon="chevronLeft" size="compact" aria-label={t(language, 'agent.tool.shell.previous')} disabled={!index}
        onClick={() => select(shells[index - 1]!.tool.process.jobId)} />
      <span>{index + 1}/{shells.length}</span>
      <IconButton {...identity.action('next', 'click')} icon="chevronRight" size="compact" aria-label={t(language, 'agent.tool.shell.next')} disabled={index + 1 === shells.length}
        onClick={() => select(shells[index + 1]!.tool.process.jobId)} />
    </div> : <small>{t(language, 'agent.tool.shell.managed')}</small>}</PanelHeader>
    <ShellWaitBody key={JSON.stringify(target)} sessionId={sessionId} activity={activity} language={language} identity={identity} />
  </section>;
}

function ShellWaitBody({ activity, sessionId, language, identity }: {
  activity: BlockingShell; sessionId: string; language: UiLanguage; identity: ReturnType<typeof useUiOwner>;
}) {
  const [open, setOpen] = useState(false);
  const outputId = useId();
  const { process } = activity.tool;
  const { stopping, stop, error } = useShellStop(sessionId, activity);
  return <>
    <code className="local-agent__shell-wait-command" title={process.command}>{process.command}</code>
    <div className="local-agent__shell-wait-actions">
      <Button {...identity.action('toggle-output', 'click')} size="compact" variant="secondary" aria-expanded={open} aria-controls={outputId} onClick={() => setOpen(!open)}>
        <UiIcon name="terminal" size={14}/>{t(language, open ? 'agent.tool.shell.hideOutput' : 'agent.tool.shell.showOutput')}</Button>
      <Button {...identity.action('stop', 'click')} size="compact" variant="danger" disabled={stopping} onClick={() => void stop()}>
        <UiIcon name={stopping ? 'spinner' : 'stop'} size={14}/>{t(language, stopping ? 'agent.tool.shell.stopping' : 'agent.tool.shell.stop')}</Button>
    </div>
    {error && <small role="alert" className="local-agent__tool-error">{error}</small>}
    <div id={outputId} hidden={!open} className="local-agent__shell-wait-output">{open && <>
      <dl className="local-agent__shell-wait-meta">
        <dt>{t(language, 'agent.tool.shell.command')}</dt><dd><code>{process.command}</code></dd>
        <dt>{t(language, 'agent.tool.shell.job')}</dt><dd><code>{process.jobId}</code></dd>
      </dl><ShellLiveOutput output={activity.liveOutput ?? process.output} language={language}/>
    </>}</div>
  </>;
}
