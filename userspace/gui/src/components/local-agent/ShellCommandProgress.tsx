import { useEffect, useRef, useState } from 'react';
import type { ActivityProjection, ToolOutputProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { isPendingShell } from './shellProgress';

/** The two presentations submit the same single-call decision. Only a terminal fact confirms a stop. */
export function useShellStop(sessionId: string | null, activity: ActivityProjection) {
  const { runId, callId, status } = activity;
  const canStop = Boolean(sessionId && runId && callId && status === 'active' && isPendingShell(activity));
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<symbol | null>(null);
  useEffect(() => {
    setStopping(false); setError(undefined);
    return () => { request.current = null; };
  }, [sessionId, runId, callId, status]);
  const stop = async () => {
    if (!canStop || !sessionId || !callId || request.current) return;
    const token = Symbol(); request.current = token;
    setStopping(true); setError(undefined);
    try { await useLocalAgentStore.getState().cancelTool(sessionId, runId, callId); }
    catch (reason) {
      if (request.current === token) { request.current = null; setError(String(reason)); setStopping(false); }
    }
  };
  return { canStop, stopping, stop, error };
}

export function ShellLiveOutput({ output, language }: { output?: ToolOutputProjection; language: UiLanguage }) {
  return <div className="local-agent__shell-result">
    {output?.truncated && <small>{t(language, 'agent.tool.shell.truncated')}</small>}
    {(['stdout', 'stderr'] as const).map(stream => output?.[stream] && <section key={stream}>
      <span>{t(language, `agent.tool.shell.${stream}`)}</span><pre>{output[stream]}</pre>
    </section>)}
    {!output?.stdout && !output?.stderr && <small>{t(language, 'agent.tool.shell.noOutputYet')}</small>}
  </div>;
}
