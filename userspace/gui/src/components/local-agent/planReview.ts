import { t, type UiLanguage } from '../../i18n';
import type { PlanOperation, PlanProjection } from '@achbit/protocol';

/** A presentation diff only: confirmation still addresses the complete published revision. */
export function planScopeAddition(previous: PlanProjection | undefined, current: PlanProjection): {
  reason: string; operations: PlanOperation[];
} | null {
  if (!previous || previous.planId !== current.planId || previous.runId !== current.runId
    || previous.title !== current.title || current.revision !== previous.revision + 1
    || previous.steps.length !== current.steps.length
    || previous.steps.some((step, index) => {
      const next = current.steps[index]!;
      return step.stepId !== next.stepId || step.title !== next.title || step.details !== next.details
        || JSON.stringify(step.verification ?? []) !== JSON.stringify(next.verification ?? []);
    })) return null;
  const prefix = `${previous.summary}\n\n`;
  if (!current.summary.startsWith(prefix)) return null;
  const reason = current.summary.slice(prefix.length).trim();
  const before = new Set(previous.mutationManifest.map((item) => JSON.stringify(item)));
  const after = new Set(current.mutationManifest.map((item) => JSON.stringify(item)));
  if (!reason || [...before].some((item) => !after.has(item))) return null;
  const operations = current.mutationManifest.filter((item) => !before.has(JSON.stringify(item)));
  return operations.length ? { reason, operations } : null;
}

export function planOperationDetail(operation: PlanOperation, language: UiLanguage = 'zh-CN'): string {
  const chinese = language === 'zh-CN';
  if ('writablePaths' in operation) {
    const paths = operation.writablePaths.map((target) => target.path + (target.kind === 'directory' ? '/' : '')).join(', ');
    return `${t(language, 'agent.tool.shell.command')} · ${t(language, 'agent.tool.shell.writeScope')}: ${paths}${operation.command ? `\n${operation.command}` : ''}${operation.terminal ? ` · ${t(language, 'agent.plan.interactiveTerminal')}` : ''}`;
  }
  const label = operation.operation === 'fs.delete' ? (chinese ? '删除' : 'Delete')
    : operation.operation === 'fs.write' ? (chinese ? '写入' : 'Write')
      : operation.operation === 'document.render' ? (chinese ? '生成文档' : 'Render document') : (chinese ? '编辑' : 'Edit');
  const directory = operation.targetKind === 'directoryTree'
    ? operation.operation === 'fs.delete' ? (chinese ? '（删除目录树）' : ' (delete directory tree)')
      : (chinese ? '（目录内文件，含新建）' : ' (descendant files, including new files)') : '';
  return `${label} · ${operation.target}${directory}`;
}
