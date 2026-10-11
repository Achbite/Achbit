// Real transcript/composer components; isolated facts and command capture, no Provider or user session.
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, type CommandReply, type InteractionProjection, type SessionProjection } from '@deepcode/protocol';
import { emptySessionState, projectSession } from '../../../session-core/src/local-agent/reducer';
import { ConversationTranscript } from '../../src/components/local-agent/ConversationTranscript';
import { ConversationComposer } from '../../src/components/local-agent/ConversationComposer';
import { useAgentComposer } from '../../src/components/local-agent/useAgentComposer';
import { useConversationViewport } from '../../src/components/local-agent/useConversationViewport';
import { projectionItems } from '../../src/components/local-agent/conversationItems';
import { usePresentedCommittedContent } from '../../src/presentation/PresentationRuntime';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/deepcode-gui/styles/deepcodeDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();
const previewParams = new URLSearchParams(location.search);
document.documentElement.dataset.theme = previewParams.get('theme') === 'dark' ? 'dark' : 'light';
const initialMode = previewParams.get('mode')?.startsWith('question') ? previewParams.get('mode')! : 'message';
const navigationCheck = previewParams.get('navigation') === 'true';
const sessionId = 'session:message-preview';
const base = projectSession(emptySessionState(sessionId));
const messages = [
  { role: 'user', content: '分析一下当前的项目环境\n第二行保留换行与文字选择。' },
  { role: 'assistant', runId: 'run:first', providerRequestId: 'provider:first', content: '已完成环境分析。\n\n- 工作区包含 C++ 源文件。\n- 容器内运行构建和测试。' },
  { role: 'user', content: '跑测一下编译和 test' },
  { role: 'assistant', runId: 'run:second', providerRequestId: 'provider:second', content: '编译与测试已全部跑通。\n\n**工作区变更**\n\n保留用户原有的文件修改。' },
].map((message, i) => ({ ...message, messageId: `message:${i}`, sequence: i + 1, createdAt: '2026-09-16T08:35:00Z',
  filesystemReferences: i === 0 ? [{ referenceId: 'reference:notes', workspaceId: 'workspace:preview', logicalPath: 'notes.txt',
    displayName: 'notes.txt', kind: 'file', mediaType: 'text/plain', byteLength: 120 }] : [], pluginSelections: [], feedback: null })) as SessionProjection['messages'];
if (navigationCheck) {
  messages[1]!.content = Array.from({ length: 12 }, (_, index) => `历史说明 ${index + 1}：保留多轮消息，检查到底部时最新标题无需顶到阅读线。`).join('\n\n');
  messages[3]!.content = '这是最新一轮的短回答。';
}
const initial: SessionProjection = { ...base, revision: 4, messages, timeline: messages.map((message) => ({
  kind: 'message', timelineId: `timeline:${message.messageId}`, messageId: message.messageId, sequence: message.sequence,
  ...(message.role === 'assistant' ? { streamId: `stream:${message.messageId}`, runId: message.runId } : {}),
})) };
const approval = { approvalId: 'approval:preview', callId: 'call:preview', runId: 'run:second', sequence: 5, createdAt: '2026-09-16T08:35:00Z', preview: { summary: '执行 bash：make test', effects: ['external'], logicalTargets: ['host:container'],
  authorizationScope: 'runHostShell', authorizationContext: { workspaceRoot: '/project/example' } } };
const question: InteractionProjection = { interactionId: 'question:preview', callId: 'call:question-preview',
  runId: 'run:first', sequence: 5, createdAt: '2026-10-11T02:00:00Z', status: 'pending', mode: 'continue', kind: 'question',
  prompt: '“左上角的电脑控制图标”具体指哪个位置？这会决定它属于现有窗口内的显示插件，还是需要一个不抢焦点的原生桌面浮层。\n\n我会继续核查与位置无关的接口、插件更新和调用边界。',
  options: [
    { id: 'desktop', label: '系统桌面左上角', description: '切换到其他应用后仍可见，点击展开电脑控制预览。' },
    { id: 'window', label: 'DeepCode 窗口左上角', description: '放在应用标题栏或导航区域内，作为预览与状态入口。' },
  ], allowFreeform: previewParams.get('freeform') !== 'false',
};
const questionProjection = (long: boolean): SessionProjection => ({ ...initial, revision: 5,
  messages: initial.messages.slice(0, 2),
  interactions: [{ ...question, prompt: long ? `${question.prompt}\n\n${'长问题检查：保留原文、换行与完整的可操作区域，不应出现横向溢出。'.repeat(8)}` : question.prompt }],
  activities: [{ activityId: question.interactionId, kind: 'interaction', status: 'waiting', label: question.prompt,
    runId: question.runId, callId: question.callId, sequence: question.sequence }],
  timeline: [...initial.timeline.slice(0, 2), { kind: 'toolGroup', timelineId: 'timeline:question', sequence: 5, activityIds: [question.interactionId] }],
});
useLocalAgentStore.setState({ sessionId, projection: initialMode.startsWith('question') ? questionProjection(initialMode === 'question-long') : initial, loading: false, submitting: false, catalogBusy: false,
  profiles: [{ id: 'profile:preview', name: 'DeepSeek Flash', enabled: true }] as never, selectedProfileId: 'profile:preview' });

function Preview() {
  const projection = useLocalAgentStore((state) => state.projection)!;
  const [mode, setMode] = useState(initialMode);
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failEdit, setFailEdit] = useState(false);
  const [language, setLanguage] = useState<'zh-CN' | 'en-US'>(previewParams.get('language') === 'en-US' ? 'en-US' : 'zh-CN');
  const presentation = usePresentedCommittedContent(projection, language);
  const viewport = useConversationViewport({ sessionId, loading: false, projection, presentationLayoutKey: presentation.layoutKey,
    assistantDraftLayoutKey: '', timelineExtentKey: String(projection.revision) });
  const composer = useAgentComposer(language, viewport.setLatestFollowMode);
  const items = useMemo(() => projectionItems(projection), [projection]);
  useEffect(() => { useLocalAgentStore.setState({
    editMessage: async (messageId, text, expectedRevision): Promise<CommandReply> => {
      setResult(JSON.stringify({ messageId, text, expectedRevision }));
      if (failEdit) { useLocalAgentStore.setState({ error: 'fixture_edit_failed' }); throw new Error('fixture_edit_failed'); }
      useLocalAgentStore.setState({ error: null });
      return { schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted', commandId: 'command:fixture:edit', sessionId, revision: expectedRevision + 1 };
    },
    respondInteraction: async (response, interactionId): Promise<CommandReply> => {
      setResult(JSON.stringify({ interactionId, response }));
      if (failEdit) throw new Error('fixture_answer_failed');
      const current = useLocalAgentStore.getState().projection!;
      const revision = current.revision + 1;
      useLocalAgentStore.setState({ projection: { ...current, revision,
        interactions: current.interactions.map(value => value.interactionId === interactionId ? { ...value, status: 'answered', response } : value),
      } });
      return { schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted', commandId: 'command:fixture:answer', sessionId, revision };
    },
    respondApproval: async (decision, scope): Promise<CommandReply> => {
      setResult(JSON.stringify({ decision, scope })); setMode('message');
      const revision = projection.revision + 1;
      useLocalAgentStore.setState({ projection: { ...projection, revision, pendingApproval: null,
        activities: projection.activities.map((activity) => activity.kind === 'approval'
          ? { ...activity, status: decision === 'allow' ? 'completed' : 'denied' } : activity) } });
      return { schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted', commandId: 'command:fixture:approval', sessionId, revision };
    },
  }); }, [failEdit, projection]);
  const changeMode = (next: string) => {
    setMode(next); setResult('');
    if (next.startsWith('question')) {
      useLocalAgentStore.setState({ projection: questionProjection(next === 'question-long') });
      return;
    }
    const permission = next === 'approval';
    useLocalAgentStore.setState({ projection: { ...initial, pendingApproval: permission ? approval : null,
      activities: permission ? [{ activityId: 'approval:preview', kind: 'approval', status: 'waiting',
        label: approval.preview.summary, runId: approval.runId, callId: approval.callId, sequence: 5 }] : [],
      timeline: permission ? [...initial.timeline.slice(0, 3), { kind: 'toolGroup', timelineId: 'permission:preview', sequence: 5,
        activityIds: ['approval:preview'] }, initial.timeline[3]!] : initial.timeline,
    } as SessionProjection });
  };
  return <>
    <style>{`*{box-sizing:border-box}html,body,#root{height:100%;margin:0;font-family:var(--dc-font-ui);color:var(--dc-foreground);background:var(--dc-surface)}#root{display:grid;grid-template-rows:auto minmax(0,1fr) auto}.fixture-toolbar{display:flex;gap:12px;flex-wrap:wrap;padding:12px 24px;font-size:14px}.fixture-toolbar select{font:inherit}.fixture-main{width:min(100%,${previewParams.get('width') === 'narrow' ? '420px' : '1000px'});margin:auto;grid-template-rows:minmax(0,1fr) auto}.fixture-main .local-agent__transcript{padding:22px 0}.fixture-result{font-size:12px;margin:0;padding:8px 24px;white-space:pre-wrap}`}</style>
    <nav className="fixture-toolbar"><select aria-label="检查模式" value={mode} onChange={(event) => changeMode(event.target.value)}>
      <option value="message">消息操作</option><option value="approval">宿主权限</option><option value="question">回答卡片</option><option value="question-long">长问题</option></select>
      <button type="button" onClick={() => changeMode('question')}>重置回答卡片</button>
      {navigationCheck && <><button onClick={viewport.scrollToLatest}>滚动到底部</button>
        <button onClick={() => useLocalAgentStore.setState({ projection: { ...projection, revision: projection.revision + 1,
          messages: projection.messages.map((message, index) => index === projection.messages.length - 1
            ? { ...message, content: `${message.content}\n\n追加最新正文，检查布局增长后的高亮。` } : message) } })}>追加最新正文</button>
        <button onClick={() => { if (viewport.bodyRef.current) { viewport.setLatestFollowMode(false); viewport.bodyRef.current.scrollTop = 0; } }}>回看历史</button></>}
      <select aria-label="配色模式" defaultValue={document.documentElement.dataset.theme} onChange={(event) => { document.documentElement.dataset.theme = event.target.value; }}><option value="light">浅色</option><option value="dark">深色</option></select>
      <select aria-label="语言" value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}><option value="zh-CN">中文</option><option value="en-US">English</option></select>
      <label><input type="checkbox" checked={failEdit} onChange={(event) => setFailEdit(event.target.checked)} />模拟提交失败</label>
    </nav>
    <main className="local-agent fixture-main"><div className="local-agent__viewport"><div className="local-agent__body" ref={viewport.bodyRef} {...viewport.bodyHandlers}>
      <ConversationTranscript language={language} loading={false} projection={projection} activeProject={undefined}
        hasConversationContent displaySettledRunIds={new Set(mode.startsWith('question') ? ['run:second'] : ['run:first', 'run:second'])} artifacts={[]} onDisplayed={() => {}}
        conversationItems={items} draftItems={[]} presentation={presentation} viewport={viewport}
        openWorkspaceResource={async () => {}} setUiActionError={setError} canEditMessage={composer.canEditMessage} onEditMessage={composer.beginMessageEdit} />
    </div></div><ConversationComposer language={language} composer={composer} uiActionError={error} /></main>
    <output className="fixture-result" aria-label="命令回执">{result}</output>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
