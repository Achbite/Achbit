// Isolated visual fixture. Uses production composer state and components, with no backend calls.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, type CommandReply, type InteractionProjection, type ModelInteractionRequest } from '@achbit/protocol';
import { ConversationComposer } from '../../src/components/local-agent/ConversationComposer';
import { InteractionCard } from '../../src/components/local-agent/InteractionCard';
import { useAgentComposer } from '../../src/components/local-agent/useAgentComposer';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import { installTextSelectionBoundary } from '../../src/components/shared/textSelection';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/theme/builtinFonts.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();
const plan = { planId: 'plan:preview', revision: 1, title: '内置浏览器交互渲染测试页', steps: [], mutationManifest: [] };
const reviewedPlan = { ...plan, review: { status: 'completed', decision: 'ask',
  reason: '计划需要修改工作区中的文件，但当前用户要求尚未明确允许这些改动。请核对修改范围后决定是否继续。\n审核说明应完整展示，确认、取消和修改意见应继续针对同一份计划。' } };
const workspacePlan = { ...reviewedPlan, workspaceRequests: [{ workspaceId: 'workspace:additional',
  rootPath: '/projects/团队共享工作区/待确认的计划与验收资料/本轮允许访问的目录' }] };
const question = { interactionId: 'question:preview', prompt: '测试页使用哪种布局？\n\n' + Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 项：检查长问题独立滚动，保留按钮选项和文字反馈区域。`).join('\n\n'), allowFreeform: true, options: [
  { id: 'compact', label: '紧凑布局', description: '按钮、开关和输入放在同一区域' },
  { id: 'grouped', label: '分组布局', description: '按交互类型分区排列' },
] };
const review = { approvalId: 'approval:review', preview: { summary: 'docker ps --format json', approvalReviewer: 'agent', effects: ['shell'], logicalTargets: ['host'], fileAccess: { read: ['/Applications/Achbit.app'], write: [] }, operation: { toolName: 'bash', workspaceRoot: '/workspace', executionScope: 'host', arguments: { command: 'docker ps --format json' } } } };
const approval = { approvalId: 'approval:preview', preview: { summary: '点击测试页中的“点我 +1”按钮', effects: ['external'], logicalTargets: ['browser:preview-1'], authorizationScope: 'sessionBrowser' } };
const scopeQuestion = { interactionId: 'question:debug-scope', kind: 'question', prompt: '工具与界面链路可以直接测试；若要覆盖完整的 Session → 模型 → 工具 → 回复链路，需要给独立 Debug 实例配置模型。你希望采用哪种范围？', allowFreeform: true, options: [
  { id: 'full', label: '完整链路，复用当前模型配置', description: '进行一次小型真实请求，核对模型、工具与回复。' },
  { id: 'tools', label: '只测工具与界面链路', description: '不调用模型，测量工具、界面事件与组件耗时。' },
  { id: 'config', label: '使用指定的 Debug 配置', description: '提供独立 Debug 状态目录或模型配置。' },
] };
const buildApproval = { approvalId: 'approval:debug-build', preview: {
  summary: '以宿主用户权限执行 bash：python3 debug-smoke/build_latest.py\n执行已准备的记录脚本，使用目标 worktree 的 bash ./build.sh -debug 构建 Debug 产物。',
  effects: ['shell'], logicalTargets: ['host'], authorizationScope: 'runHostShell',
  authorizationScopes: ['runCommand', 'sessionCommand', 'runHostShell', 'sessionHostShell'],
  authorizationContext: { workspaceId: 'workspace:preview', workspaceRoot: '/workspace' },
  review: { decision: 'ask', reason: '本次实际运行的是工作区中的 Python 脚本。请确认是否允许执行这次操作。' },
  operation: { toolName: 'bash', workspaceRoot: '/workspace', executionScope: 'host', arguments: { command: 'python3 debug-smoke/build_latest.py' } },
} };
function questionFact(request: Omit<ModelInteractionRequest, 'kind'> & { interactionId: string }, sequence: number): InteractionProjection {
  return { kind: 'question', mode: 'continue', ...request, status: 'pending', sequence,
    runId: 'run:preview', callId: `call:${request.interactionId}`, createdAt: '2026-10-18T08:00:00Z' };
}
function numberedQuestion(index: number): InteractionProjection {
  return questionFact({ ...scopeQuestion, interactionId: `question:preview:${index}`,
    prompt: `第 ${index + 1} 个问题：${scopeQuestion.prompt}` }, index);
}
useLocalAgentStore.setState({ sessionId: 'session:composer-preview', loading: false, catalogBusy: false, submitting: false,
  profiles: [{ id: 'profile:preview', name: 'DeepSeek Flash', enabled: true, thinking: 'auto', reasoningEffort: 'medium' }] as never, selectedProfileId: 'profile:preview',
  projection: { sessionId: 'session:composer-preview', revision: 0, contextCompositions: [], queuedInputs: [], plans: [], interactions: [], pendingApproval: approval } as never,
});

function Preview() {
  useEffect(() => installTextSelectionBoundary(document), []);
  const [mode, setMode] = useState('approval');
  const [result, setResult] = useState('');
  const [compact, setCompact] = useState(false);
  const initialized = useRef(false);
  const setDecision = (next: string) => {
    setMode(next); setResult('');
    const interactions = next === 'questions' ? Array.from({ length: 5 }, (_, index) => numberedQuestion(index))
      : next === 'interaction' ? [questionFact(question, 0)] : next === 'concurrent' ? [questionFact(scopeQuestion, 0)] : [];
    const pendingPlan = next === 'plan' ? plan : next === 'plan-reviewed' ? reviewedPlan
      : next === 'plan-workspace' ? workspacePlan
      : next === 'plan-review' ? { ...plan, review: { status: 'reviewing' } } : null;
    useLocalAgentStore.setState({ projection: { ...useLocalAgentStore.getState().projection,
      run: next === 'review' || next === 'questions' || next === 'plan-review' ? { runId: 'run:preview', status: 'running' }
        : pendingPlan ? { runId: 'run:preview', status: 'waiting', waitingReason: 'plan' }
        : next === 'interaction' ? { runId: 'run:preview', status: 'waiting', waitingReason: 'userInput' }
        : next === 'concurrent' ? { runId: 'run:preview', status: 'waiting', waitingReason: 'approval' } : null,
      pendingApproval: next === 'review' ? review : next === 'approval' ? approval : next === 'concurrent' ? buildApproval : null,
      pendingPlan,
      effectivePermissions: { 'agent.permissions.workspaceMutation': next === 'plan-review' || next === 'plan-reviewed' ? 'review' : 'plan' },
      interactions, pendingInteraction: interactions[0] ?? null,
    } as never });
  };
  if (!initialized.current) {
    initialized.current = true;
    const accepted = (): CommandReply => {
      const projection = useLocalAgentStore.getState().projection!;
      const revision = projection.revision + 1;
      useLocalAgentStore.setState({ projection: { ...projection, revision } });
      return { schemaVersion: COMMAND_REPLY_VERSION, status: 'accepted', commandId: `command:preview:${revision}`, sessionId: projection.sessionId, revision };
    };
    const finish = (value: string) => {
      setDecision('message');
      setResult(value); return accepted();
    };
    useLocalAgentStore.setState({
      setPermissions: async patches => {
        const projection = useLocalAgentStore.getState().projection!;
        if (projection.pendingPlan && patches['agent.permissions.workspaceMutation'] === 'plan') {
          useLocalAgentStore.setState({ projection: { ...projection,
            effectivePermissions: { ...projection.effectivePermissions, ...patches },
            run: { ...projection.run, runId: 'run:preview', status: 'waiting', waitingReason: 'plan' },
          } as never });
          setResult('计划审核：改为人工确认');
        } else {
          useLocalAgentStore.setState({ projection: { ...projection, run: null,
            pendingApproval: { ...review, preview: { ...review.preview, approvalReviewer: 'user' } },
          } as never });
        }
        return accepted();
      },
      respondApproval: async (decision) => {
        const projection = useLocalAgentStore.getState().projection!;
        useLocalAgentStore.setState({ projection: { ...projection, pendingApproval: null,
          run: { ...projection.run, runId: 'run:preview', status: 'running', waitingReason: undefined } } as never });
        setResult(`权限：${decision}`); return accepted();
      },
      respondPlan: async (response) => finish(`Plan：${JSON.stringify(response)}`),
      respondInteraction: async (text, interactionId) => {
        const projection = useLocalAgentStore.getState().projection!;
        const interactions = projection.interactions.map(item => item.interactionId === interactionId
          ? { ...item, status: 'answered' as const, response: text } : item);
        useLocalAgentStore.setState({ projection: { ...projection, interactions,
          pendingInteraction: interactions.find(item => item.status === 'pending') ?? null,
          run: projection.run?.waitingReason === 'userInput'
            ? { ...projection.run, status: 'running', waitingReason: undefined } : projection.run,
        } });
        setResult(`问题：${interactionId} → ${text}`); return accepted();
      },
      sendMessage: async (text) => { setResult(`消息：${text}`); return accepted(); },
      cancelRun: async () => {
        const projection = useLocalAgentStore.getState().projection!;
        useLocalAgentStore.setState({ projection: { ...projection, pendingInteraction: null,
          interactions: projection.interactions.map(item => item.status === 'pending' ? { ...item, status: 'closed' } : item),
          run: { ...projection.run, runId: 'run:preview', status: 'cancelled' } } as never });
        return accepted();
      },
    });
  }
  const composer = useAgentComposer('zh-CN', () => {});
  const projection = composer.projection!;
  const advance = (waiting: boolean) => useLocalAgentStore.setState({ projection: { ...projection,
    run: { ...projection.run, runId: 'run:preview', status: waiting ? 'waiting' : 'running', waitingReason: waiting ? 'userInput' : undefined },
  } as never });
  return <>
    <style>{`*{box-sizing:border-box}html,body,#root{margin:0;min-height:100%;font-family:var(--dc-font-ui);color:var(--dc-foreground);background:var(--dc-surface)}.fixture-toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:16px 24px;max-width:920px;margin:auto;font-size:14px}.fixture-toolbar select,.fixture-toolbar button{font:inherit}.fixture-main{height:calc(100dvh - 190px);min-height:380px;width:100%;max-width:960px;margin:0 auto;display:flex;flex-direction:column;overflow:hidden}.fixture-context{flex:1;min-height:0;overflow:auto;padding:24px 44px;color:var(--dc-muted);font-size:14px}.fixture-context strong{display:block;color:var(--dc-foreground);font-size:18px;margin-bottom:18px}.fixture-result{max-width:800px;margin:16px auto;font-size:14px}.local-agent__composer-shell{width:100%;flex-shrink:0}.fixture-context article{margin:20px 0}`}</style>
    <nav className="fixture-toolbar"><span>输入区检查</span><select aria-label="检查模式" value={mode} onChange={(e) => setDecision(e.target.value)}>
      <option value="message">普通输入</option><option value="approval">权限确认</option><option value="review">工具自动审核</option><option value="plan">Plan 确认</option>
      <option value="plan-reviewed">审核后人工确认</option><option value="plan-workspace">工作区授权确认</option><option value="plan-review">计划自动审核</option>
      <option value="interaction">方案选择</option><option value="concurrent">问题与权限并存</option><option value="questions">执行中多个问题</option>
    </select><select aria-label="配色模式" defaultValue="light" onChange={(e) => { document.documentElement.dataset.theme = e.target.value; }}><option value="light">浅色</option><option value="dark">深色</option></select>
      <button onClick={() => setCompact(value => !value)}>{compact ? '恢复宽度' : '窄面板'}</button>
    </nav>
    {projection.interactions.length > 0 && <nav className="fixture-toolbar">
      <button onClick={() => advance(true)}>进入等待回答</button><button onClick={() => advance(false)}>继续非阻塞工作</button>
      <button onClick={() => {
        const interactions = [...projection.interactions, numberedQuestion(projection.interactions.length)];
        useLocalAgentStore.setState({ projection: { ...projection, interactions, pendingInteraction: projection.pendingInteraction ?? interactions.at(-1)! } });
      }}>追加问题</button>
      <span>{projection.run?.status === 'running' ? '运行中' : projection.run?.waitingReason === 'approval' ? '等待授权' : '等待用户回答'}</span>
    </nav>}
    <main className="local-agent fixture-main" style={{ maxWidth: compact ? 420 : 960 }}><div className="fixture-context" role="region" aria-label="对话历史"><strong>内置浏览器交互渲染测试</strong>创建页面并核对按钮、开关和文本输入。
      {projection.interactions.map(item => <InteractionCard key={item.interactionId} interaction={item} language="zh-CN" />)}
      {projection.interactions.length > 0 && <p>已继续完成与这些答案无关的检查。</p>}
    </div>
      <ConversationComposer language="zh-CN" composer={composer} uiActionError={null}
        onDismissUiActionError={() => {}} onEditBrowserReview={review => setResult(`浏览器批注：${JSON.stringify(review)}`)} />
    </main><p className="fixture-result" role="status">{result}</p>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
