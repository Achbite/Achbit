// Isolated viewport display check: real Composer, Markdown buffer and viewport owner.
// Decisions update only this fixture; no daemon or Provider is contacted.
// Passing this partial UI check does not constitute system acceptance.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, type ActivityProjection, type CommandReply } from '@achbit/protocol';
import { ConversationComposer } from '../../src/components/local-agent/ConversationComposer';
import { BufferedMarkdown } from '../../src/components/local-agent/BufferedMarkdown';
import { useAgentComposer } from '../../src/components/local-agent/useAgentComposer';
import { useConversationViewport } from '../../src/components/local-agent/useConversationViewport';
import { ProviderHostedDraftGroup, ToolActivityGroup } from '../../src/components/local-agent/ToolActivityDetails';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();
const longShell: ActivityProjection = {
  activityId: 'shell:scroll-fixture', kind: 'tool', status: 'completed', label: '长命令输出滚动检查', runId: 'run:preview', sequence: 1,
  tool: { operation: 'bash', resources: [], shell: {
    command: 'for i in $(seq 1 120); do echo "output $i"; done', cwd: '.', executionScope: 'workspace', terminal: false,
    result: { exitCode: 0, success: true, capturedBytes: 12000, environment: { shell: '/bin/bash', interactive: false, executionScope: 'workspace', terminal: false, pathSource: 'inherited', writeScope: 'workspace', homeWritable: false, networkAccess: false }, durationMs: 1200, timedOut: false, truncated: false,
      stdout: Array.from({ length: 120 }, (_, index) => `输出行 ${index + 1}：保留内层滚动，到边界后继续滚动对话。`).join('\n'), stderr: '' },
  } },
};
const initialSessionId = 'session:viewport-preview';
const plan = { planId: 'plan:preview', revision: 1, title: '恢复容器引擎并运行编译与测试', steps: [], mutationManifest: [] };
const question = { interactionId: 'question:preview', runId: 'run:preview', status: 'pending', kind: 'question', prompt: '本次测试采用哪种配置？', allowFreeform: true,
  options: [{ id: 'debug', label: '调试配置', description: '' }, { id: 'release', label: '发布配置', description: '' }] };
const approval = { approvalId: 'approval:preview', preview: { summary: '执行编译与测试命令', effects: ['external'], logicalTargets: ['host:container'] } };
useLocalAgentStore.setState({ sessionId: initialSessionId, loading: false, catalogBusy: false, submitting: false,
  profiles: [{ id: 'profile:preview', name: 'DeepSeek Flash', enabled: true, thinking: 'auto' }] as never, selectedProfileId: 'profile:preview',
  projection: { sessionId: initialSessionId, revision: 0, contextCompositions: [], queuedInputs: [], plans: [] } as never,
});

function Preview() {
  const projection = useLocalAgentStore((state) => state.projection);
  const sessionId = projection!.sessionId;
  const [scrollPosition, setScrollPosition] = useState('外层 0 · 输出 0');
  const [mode, setMode] = useState('message');
  const [text, setText] = useState('正在核对当前工作区，准备执行后续检查。');
  const [completed, setCompleted] = useState(false);
  const [displayed, setDisplayed] = useState(false);
  const [historyCount, setHistoryCount] = useState(12);
  const [compact, setCompact] = useState(false);
  const viewport = useConversationViewport({ sessionId, loading: false, projection,
    presentationLayoutKey: mode, assistantDraftLayoutKey: String(text.length), timelineExtentKey: '' });
  const composer = useAgentComposer('zh-CN', viewport.setLatestFollowMode);
  const setDecision = (next: string) => {
    setMode(next);
    useLocalAgentStore.setState({ projection: { ...useLocalAgentStore.getState().projection,
      pendingApproval: next === 'approval' ? approval : null,
      pendingPlan: next === 'plan' ? plan : null,
      pendingInteraction: next === 'interaction' ? question : null,
      interactions: next === 'interaction' ? [question] : [],
      run: next === 'interaction' ? { runId: 'run:preview', status: 'waiting', waitingReason: 'userInput' } : null,
    } as never });
  };
  useEffect(() => {
    const finish = (value: string): CommandReply => {
      setDecision('message'); setCompleted(false); setDisplayed(false);
      setText((current) => `${current}\n\n${value}。继续执行后续检查。`);
      const projection = useLocalAgentStore.getState().projection!;
      const revision = projection.revision + 1;
      useLocalAgentStore.setState({ projection: { ...projection, revision } });
      return { schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted', commandId: `command:viewport:${revision}`, sessionId, revision };
    };
    useLocalAgentStore.setState({ respondApproval: async (decision) => finish(`权限已${decision === 'allow' ? '允许' : '拒绝'}`),
      respondPlan: async () => finish('计划已确认'), respondInteraction: async () => finish('问题已回答'),
      sendMessage: async () => finish('新输入已接收') });
  }, []);
  const append = (final: boolean) => {
    setDisplayed(false); setCompleted(final);
    setText((current) => `${current}\n\n${Array.from({ length: final ? 18 : 4 }, (_, index) =>
      `${final ? '最终结果' : '执行进度'} ${index + 1}：确认卡切换与正文增长使用同一个视口；主动查看历史时保留阅读位置。`).join('\n\n')}`);
  };
  return <>
    <style>{`*{box-sizing:border-box}html,body,#root{height:100%;margin:0;font-family:var(--ac-font-ui);color:var(--ac-foreground);background:var(--ac-surface)}#root{display:grid;grid-template-rows:auto minmax(0,1fr)}.fixture-toolbar{display:flex;flex-wrap:wrap;gap:12px;padding:12px 24px;font-size:14px}.fixture-toolbar button,.fixture-toolbar select{font:inherit}.fixture-main{width:min(100%,960px);margin:auto}.fixture-main .local-agent__header{height:40px}.fixture-main{grid-template-rows:40px minmax(0,1fr) auto}.fixture-history{padding:16px 0}.fixture-history p{line-height:1.8}.fixture-geometry{margin-left:auto}.fixture-main .local-agent__body{scrollbar-width:auto}.fixture-main .local-agent__body::-webkit-scrollbar{display:block;width:10px}`}</style>
    <nav className="fixture-toolbar"><select aria-label="检查模式" value={mode} onChange={(event) => setDecision(event.target.value)}>
      <option value="message">普通输入</option><option value="approval">权限确认</option><option value="plan">Plan 确认</option><option value="interaction">方案选择</option>
    </select><button onClick={() => append(false)}>追加正文</button><button onClick={() => append(true)}>完成输出</button>
      <button onClick={() => { setHistoryCount(0); setText('正在检索相关消息。'); viewport.scrollToLatest(); }}>短对话</button>
      <button onClick={() => { setHistoryCount(0); setText('正文已收起。'); }}>收起正文</button>
      <button onClick={() => setCompact(value => !value)}>{compact ? '恢复视口' : '缩小视口'}</button>
      <button onClick={() => useLocalAgentStore.setState({ projection: { ...projection,
        sessionId: sessionId === initialSessionId ? 'session:viewport-other' : initialSessionId } as never })}>切换会话</button>
      <select aria-label="配色模式" defaultValue="light" onChange={(event) => { document.documentElement.dataset.theme = event.target.value; }}><option value="light">浅色</option><option value="dark">深色</option></select>
      <output className="fixture-geometry">{scrollPosition} · {viewport.followingLatest ? '跟随最新' : '阅读历史'} · {displayed ? '正文显示完成' : '等待正文显示完成'}</output>
    </nav>
    <main className="local-agent fixture-main" data-following={viewport.followingLatest} data-session={sessionId} style={{ height: compact ? 360 : '100%' }}>
      <header className="local-agent__header"><strong>分析一下当前的项目环境</strong><span>{completed ? '已完成' : '运行中'}</span></header>
      <div className="local-agent__viewport">
        <div ref={viewport.bodyRef} className="local-agent__body" aria-label="对话内容" {...viewport.bodyHandlers} onScrollCapture={() => {
            const body = viewport.bodyRef.current;
            const detail = body?.querySelector('.local-agent__tool-entry-details');
            setScrollPosition(`外层 ${Math.round(body?.scrollTop ?? 0)} · 输出 ${Math.round(detail?.scrollTop ?? 0)}/${Math.round((detail?.scrollHeight ?? 0) - (detail?.clientHeight ?? 0))}`);
          }}>
          <div ref={viewport.transcriptRef} className="local-agent__transcript">
            {Array.from({ length: historyCount }, (_, index) => <section key={index} className="fixture-history" data-conversation-anchor={`history:${index}`}>
              <strong>历史消息 {index + 1}</strong><p>读取项目配置并核对执行环境。这里保留历史正文，用于检查输出时的位置保持和向上翻阅。</p>
            </section>)}
            <section data-conversation-anchor="tools"><ProviderHostedDraftGroup blocks={[{ kind: 'providerHosted', providerCallId: 'search:preview', outputIndex: 0,
              providerToolType: 'web_search', status: 'completed', action: { queries: ['LLM news'] } } as never]}
              language="zh-CN" onExpand={() => viewport.setLatestFollowMode(false)} /></section>
            <section data-conversation-anchor="shell-fixture">
              <p>展开长命令输出，将鼠标放在输出中：先滚内部，触顶/触底后继续滚动外层。向上离开底部后点击“追加正文”，阅读位置应保留。</p>
              <ToolActivityGroup activities={[longShell]} language="zh-CN"
                onExpand={viewport.anchorDisclosure} onOpenWorkspaceResource={() => {}} />
            </section>
            <section data-conversation-anchor="latest"><BufferedMarkdown text={text} streaming={!completed} streamIdentity="stream:fixture" onDisplayed={() => setDisplayed(true)} /></section>
            <div ref={viewport.messageEndRef} />
          </div>
        </div>
        {viewport.showJumpToLatest && <button className="local-agent__jump-latest" aria-label="前往最新消息" onClick={viewport.scrollToLatest}>↓</button>}
      </div>
      <ConversationComposer composer={composer} language="zh-CN" uiActionError={null}
        onDismissUiActionError={() => {}} onEditBrowserReview={() => setText('已选择浏览器批注。')} />
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
