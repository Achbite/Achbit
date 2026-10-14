// Isolated visual fixture. Uses production composer state and components, with no backend calls.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { COMMAND_REPLY_VERSION, type CommandReply } from '@deepcode/protocol';
import { ConversationComposer } from '../../src/components/local-agent/ConversationComposer';
import { useAgentComposer } from '../../src/components/local-agent/useAgentComposer';
import { useLocalAgentStore } from '../../src/state/localAgentStore';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/deepcode-gui/styles/deepcodeDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/shared/focus.css';

installPaletteDefaults();
const plan = { planId: 'plan:preview', revision: 1, title: '内置浏览器交互渲染测试页', steps: [], mutationManifest: [] };
const question = { interactionId: 'question:preview', prompt: '测试页使用哪种布局？\n\n' + Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 项：检查长问题独立滚动，保留按钮选项和文字反馈区域。`).join('\n\n'), allowFreeform: true, options: [
  { id: 'compact', label: '紧凑布局', description: '按钮、开关和输入放在同一区域' },
  { id: 'grouped', label: '分组布局', description: '按交互类型分区排列' },
] };
const review = { approvalId: 'approval:review', preview: { summary: 'docker ps --format json', approvalReviewer: 'agent', effects: ['shell'], logicalTargets: ['host'], fileAccess: { read: ['/Applications/DeepCode.app'], write: [] }, operation: { toolName: 'bash', workspaceRoot: '/workspace', executionScope: 'host', arguments: { command: 'docker ps --format json' } } } };
const approval = { approvalId: 'approval:preview', preview: { summary: '点击测试页中的“点我 +1”按钮', effects: ['external'], logicalTargets: ['browser:preview-1'], authorizationScope: 'sessionBrowser' } };
useLocalAgentStore.setState({ sessionId: 'session:composer-preview', loading: false, catalogBusy: false, submitting: false,
  profiles: [{ id: 'profile:preview', name: 'DeepSeek Flash', enabled: true, thinking: 'auto' }] as never, selectedProfileId: 'profile:preview',
  projection: { sessionId: 'session:composer-preview', revision: 0, contextCompositions: [], queuedInputs: [], plans: [], pendingApproval: approval } as never,
});

function Preview() {
  const [mode, setMode] = useState('approval');
  const [result, setResult] = useState('');
  const initialized = useRef(false);
  const setDecision = (next: string) => {
    setMode(next); setResult('');
    useLocalAgentStore.setState({ projection: { ...useLocalAgentStore.getState().projection,
      run: next === 'review' ? { runId: 'run:preview', status: 'running' } : null,
      pendingApproval: next === 'review' ? review : next === 'approval' ? approval : null,
      pendingPlan: next === 'plan' ? plan : null,
      pendingInteraction: next === 'interaction' ? question : null,
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
    const finish = (value: string) => { setDecision('message'); setResult(value); return accepted(); };
    useLocalAgentStore.setState({
      setPermissions: async () => { useLocalAgentStore.setState({ projection: { ...useLocalAgentStore.getState().projection, run: null, pendingApproval: { ...review, preview: { ...review.preview, approvalReviewer: 'user' } } } as never }); return accepted(); },
      respondApproval: async (decision) => finish(`权限：${decision}`),
      respondPlan: async (response) => finish(`Plan：${JSON.stringify(response)}`),
      respondInteraction: async (text) => finish(`方案：${text}`),
      sendMessage: async (text) => finish(`消息：${text}`),
    });
  }
  const composer = useAgentComposer('zh-CN', () => {});
  return <>
    <style>{`*{box-sizing:border-box}html,body,#root{margin:0;min-height:100%;font-family:var(--dc-font-ui);color:var(--dc-foreground);background:var(--dc-surface)}.fixture-toolbar{display:flex;gap:14px;align-items:center;padding:24px;max-width:920px;margin:auto;font-size:14px}.fixture-toolbar select{font:inherit}.fixture-main{height:540px;max-width:960px;margin:0 auto;display:flex;flex-direction:column;justify-content:flex-end;overflow:visible}.fixture-context{flex:1;padding:40px 44px;color:var(--dc-muted);font-size:14px}.fixture-context strong{display:block;color:var(--dc-foreground);font-size:18px;margin-bottom:18px}.fixture-result{max-width:800px;margin:24px auto;font-size:14px}.local-agent__composer-shell{width:100%}`}</style>
    <nav className="fixture-toolbar"><span>输入区检查</span><select aria-label="检查模式" value={mode} onChange={(e) => setDecision(e.target.value)}>
      <option value="message">普通输入</option><option value="approval">权限确认</option><option value="review">自动审核</option><option value="plan">Plan 确认</option><option value="interaction">方案选择</option>
    </select><select aria-label="配色模式" defaultValue="light" onChange={(e) => { document.documentElement.dataset.theme = e.target.value; }}><option value="light">浅色</option><option value="dark">深色</option></select></nav>
    <main className="local-agent fixture-main"><div className="fixture-context"><strong>内置浏览器交互渲染测试</strong>创建页面并核对按钮、开关和文本输入。</div>
      <ConversationComposer language="zh-CN" composer={composer} uiActionError={null}
        onDismissUiActionError={() => {}} onEditBrowserReview={review => setResult(`浏览器批注：${JSON.stringify(review)}`)} />
    </main><p className="fixture-result" role="status">{result}</p>
  </>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
