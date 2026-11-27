import type { SessionProjection } from '@achbit/protocol';
import type { ConversationHost } from '../../src/components/local-agent/ConversationHost';

/** The screenshot's 3+50 case, fed through the normal workbench, change statistics and Reader. */
export function changeOverlaySession(base: SessionProjection, host: ConversationHost): SessionProjection {
  const runId = 'run:overlay', recordId = 'record:overlay-files';
  const names = ['dto.rs', 'lifecycle.rs', 'local_agent_store.rs', ...Array.from({ length: 50 }, (_, i) => `file-${i + 4}.ts`)];
  const fileChanges = names.map(name => ({ workspaceId: 'fixture', path: `src/${name}`, kind: 'modify' as const, before: { exists: true }, after: { exists: true } }));
  const originalRead = host.readChange;
  host.readChange = (session, record, i, signal) => record === recordId && session === base.sessionId && fileChanges[i]
    ? Promise.resolve({ workspaceId: 'fixture', path: fileChanges[i].path, before: `before ${names[i]}\n`, after: `after ${names[i]}\n` })
    : originalRead(session, record, i, signal);
  const common = { createdAt: '2026-11-26T02:57:00Z', filesystemReferences: [], pluginSelections: [], feedback: null };
  const messages: SessionProjection['messages'] = [
    { ...common, sequence: 1, messageId: 'overlay:question', role: 'user', content: '请检查本轮文件修改。' },
    { ...common, sequence: 3, messageId: 'overlay:answer', role: 'assistant', runId, providerRequestId: 'provider:overlay',
      content: Array.from({ length: 32 }, (_, i) => `检查记录 ${i + 1}：保留当前阅读位置，文件变更明细可以单独查看。`).join('\n\n') },
  ];
  return { ...base, revision: 3, run: { runId, profileId: 'profile:preview', status: 'running', workspaceBindings: [] },
    messages, activities: [{ kind: 'tool', activityId: 'activity:overlay', sequence: 2, runId, status: 'completed', label: 'fs.edit', tool: { operation: 'fs.edit', resources: [], recordId, fileChanges } }],
    fileChangeRounds: [{ runId, recordIds: [recordId] }],
    timeline: [{ kind: 'message', timelineId: 'timeline:1', messageId: 'overlay:question', sequence: 1 },
      { kind: 'toolGroup', timelineId: 'timeline:2', activityIds: ['activity:overlay'], sequence: 2 },
      { kind: 'message', timelineId: 'timeline:3', messageId: 'overlay:answer', streamId: 'stream:overlay', sequence: 3 }],
    contextUsage: { runId, providerRequestId: 'provider:overlay', providerRuntimeRef: 'fixture', sequence: 3, updatedAt: common.createdAt, inputTokens: 3500, outputTokens: 100, contextWindowTokens: 10000 },
  };
}
