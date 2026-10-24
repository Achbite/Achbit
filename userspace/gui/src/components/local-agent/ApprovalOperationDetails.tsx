import type { EffectPreview } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';

export function ApprovalOperationDetails({ preview, language }: { preview: EffectPreview; language: UiLanguage }) {
  const operation = preview.operation;
  const workspace = operation?.workspaceRoot ?? preview.authorizationContext?.workspaceRoot;
  if (!operation && !preview.fileAccess && !preview.effects.length && !preview.logicalTargets.length) return null;
  return <details className="local-agent__decision-scope">
    <summary>{t(language, 'agent.approval.operation')}</summary>
    <dl>
      {operation && <><dt>{t(language, 'agent.tool.detail.operation')}</dt><dd><code>{operation.toolName}</code></dd></>}
      {typeof workspace === 'string' && <><dt>{t(language, 'agent.tool.shell.cwd')}</dt><dd><code>{workspace}</code></dd></>}
      {operation?.executionScope && <><dt>{t(language, 'agent.approval.executionScope')}</dt><dd><code>{operation.executionScope}</code></dd></>}
      {operation && <><dt>{t(language, 'agent.approval.arguments')}</dt><dd><pre><code>{JSON.stringify(operation.arguments, null, 2)}</code></pre></dd></>}
      {(['read', 'write'] as const).map(access => (preview.fileAccess?.[access].length ?? 0) > 0 && <div key={access}>
        <dt>{t(language, `agent.permission.file.${access}`)}</dt>
        <dd>{preview.fileAccess![access].map(path => <code key={path} title={path}>{path}</code>)}</dd>
      </div>)}
      {preview.effects.length > 0 && <div><dt>{t(language, 'agent.approval.effects')}</dt><dd>{preview.effects.map(effect => <code key={effect}>{effect}</code>)}</dd></div>}
      {preview.logicalTargets.length > 0 && <div><dt>{t(language, 'agent.approval.targets')}</dt><dd>{preview.logicalTargets.map(target => <code key={target}>{target}</code>)}</dd></div>}
    </dl>
  </details>;
}
