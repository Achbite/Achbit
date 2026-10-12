import { UiRegion } from '../../ui-plugins/UiRegion';
import React, { useEffect, useState } from 'react';
import type { ActivityProjection, AssistantDraftBlockProjection, ProviderHostedActivityProjection, SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { UiPluginSlotView, useDisplayTheme } from '../../ui-plugins/UiPlugins';
import { ApprovalActivity } from './ApprovalActivity';
import { AgentActivity, AgentGroupSummary } from './agentNavigation';
import { FileChanges } from './FileChanges';
import { useConversationRowState } from './ConversationVirtualRow';

function shellWriteScopeLabel(language: UiLanguage, writeScope: string): string {
  const key = `agent.tool.shell.writeScope.${writeScope}`;
  const label = t(language, key);
  return label === key ? writeScope : label;
}

interface ToolActivityGroupProps {
  pendingApproval?: SessionProjection['pendingApproval'];
  reviewingApproval?: boolean;
  activities: ActivityProjection[];
  language: UiLanguage;
  onExpand(): void;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

interface ProviderHostedDraftGroupProps {
  blocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>>;
  language: UiLanguage;
  onExpand(): void;
}

export const ProviderHostedDraftGroup: React.FC<ProviderHostedDraftGroupProps> = ({
  blocks,
  language,
  onExpand,
}) => {
  const [expanded, setExpanded] = useConversationRowState('hosted-group:expanded', false);
  const summary = t(language, 'agent.tool.summary.usedMany', { count: blocks.length });
  return (
    <UiRegion slot="activity.row" data={{ kind: 'providerHosted', blocks, expanded }} actions={{ setExpanded }}><article className={`local-agent__tool-group${expanded ? ' local-agent__tool-group--expanded' : ''}`}>
      <UiRegion slot="activity.summary" data={{ kind: 'providerHosted', blocks, expanded }} actions={{ setExpanded }}><button
        type="button"
        className="local-agent__tool-group-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onExpand();
          setExpanded((current) => !current);
        }}
      >
        <span className="local-agent__tool-group-icon">
          <DeepCodeShellIcon name="search" />
        </span>
        <strong>{summary}</strong>
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button></UiRegion>
      {expanded && (
        <UiRegion slot="activity.detail" data={{ kind: 'providerHosted', blocks, expanded }} actions={{ setExpanded }}><div className="local-agent__tool-group-items">
          {blocks.map((block) => (
            <ProviderHostedEntry
              key={block.providerCallId}
              hosted={block}
              status={block.status}
              language={language}
              onExpand={onExpand}
            />
          ))}
        </div></UiRegion>
      )}
    </article></UiRegion>
  );
};

export const ToolActivityGroup: React.FC<ToolActivityGroupProps> = ({
  activities, pendingApproval, reviewingApproval = false,
  language,
  onExpand,
  onOpenWorkspaceResource,
}) => {
  const [expanded, setExpanded] = useConversationRowState('tool-group:expanded', false);
  return (
    <UiRegion slot="activity.row" data={{ kind: 'activities', activities, expanded }} actions={{ setExpanded }}><article className={`local-agent__tool-group${expanded ? ' local-agent__tool-group--expanded' : ''}`}>
      <div className="local-agent__tool-group-heading"><UiRegion slot="activity.summary" data={{ kind: 'activities', activities, expanded }} actions={{ setExpanded }}><button
        type="button"
        className="local-agent__tool-group-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onExpand();
          setExpanded((current) => !current);
        }}
      >
        <span className="local-agent__tool-group-icon">
          <DeepCodeShellIcon
            name={activities.every((activity) => activity.kind === 'providerHosted')
              ? 'search'
              : 'tool'}
          />
        </span>
        <strong>{toolGroupSummary(activities, language)}</strong>
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button></UiRegion>{!expanded && <AgentGroupSummary activities={activities} language={language} />}</div>
      {expanded && (
        <UiRegion slot="activity.detail" data={{ kind: 'activities', activities, expanded }} actions={{ setExpanded }}><div className="local-agent__tool-group-items">
          {activities.map((activity) => (
            activity.kind === 'approval' ? <ApprovalActivity key={activity.activityId} activity={activity} language={language}
              pending={pendingApproval?.callId === activity.callId} reviewing={reviewingApproval} onExpand={onExpand} />
              : activity.agent ? <AgentActivity key={activity.activityId} activity={activity} language={language} />
              : <ToolActivityEntry
              activity={activity}
              key={activity.activityId}
              language={language}
              onExpand={onExpand}
              onOpenWorkspaceResource={onOpenWorkspaceResource}
            />
          ))}
        </div></UiRegion>
      )}
    </article></UiRegion>
  );
};

interface ProviderHostedEntryProps {
  hosted: ProviderHostedActivityProjection;
  status: ActivityProjection['status'];
  language: UiLanguage;
  onExpand(): void;
}

const ProviderHostedEntry: React.FC<ProviderHostedEntryProps> = ({ hosted, status, language, onExpand }) => {
  const [expanded, setExpanded] = useConversationRowState(`hosted:${hosted.providerCallId}:expanded`, false);
  const actionType = providerHostedActionType(hosted.action);
  const fieldLabels: Record<string, string> = {
    queries: 'agent.providerHosted.detail.queries',
    query: 'agent.providerHosted.detail.queries',
    url: 'agent.providerHosted.detail.url',
    pattern: 'agent.providerHosted.detail.pattern',
    sources: 'agent.providerHosted.detail.sources',
  };
  return (
    <div className={`local-agent__tool-entry local-agent__tool-entry--${status}`}>
      <button type="button" className="local-agent__tool-entry-heading" aria-expanded={expanded} onClick={() => {
        if (!expanded) onExpand();
        setExpanded((value) => !value);
      }}>
        <span className="local-agent__tool-entry-icon"><DeepCodeShellIcon name="search" /></span>
        <strong>{providerHostedSummary(hosted, status, language)}</strong>
        {status !== 'completed' && <span>{toolActivityStatus(status, language)}</span>}
        <span className="local-agent__tool-entry-chevron" aria-hidden="true"><DeepCodeShellIcon name="chevronRight" /></span>
      </button>
      {expanded && <div className="local-agent__tool-entry-details">
        <dl>
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.status')}</dt>
            <dd>{toolActivityStatus(status, language)}</dd>
          </div>
          {actionType && (
            <div>
              <dt>{t(language, 'agent.providerHosted.detail.action')}</dt>
              <dd><code>{actionType}</code></dd>
            </div>
          )}
          {hosted.action !== undefined && Object.entries(hosted.action).filter(([field]) => field !== 'type').map(([field, value]) => (
            <div key={field}>
              <dt>{fieldLabels[field] ? t(language, fieldLabels[field]) : field}</dt>
              <dd><code>{typeof value === 'string'
                ? value
                : Array.isArray(value) && value.every((item) => typeof item === 'string')
                  ? value.join('\n')
                  : JSON.stringify(value, null, 2)}</code></dd>
            </div>
          ))}
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.providerTool')}</dt>
            <dd><code>{hosted.providerToolType}</code></dd>
          </div>
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.providerCallId')}</dt>
            <dd><code>{hosted.providerCallId}</code></dd>
          </div>
        </dl>
      </div>}
    </div>
  );
};

interface ToolActivityEntryProps {
  activity: ActivityProjection;
  language: UiLanguage;
  onExpand(): void;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

const ToolActivityEntry: React.FC<ToolActivityEntryProps> = ({
  activity,
  language,
  onExpand,
  onOpenWorkspaceResource,
}) => {
  const [expanded, setExpanded] = useConversationRowState(`tool:${activity.activityId}:expanded`, false);
  const theme = useDisplayTheme();
  const tool = activity.tool;
  const shell = tool?.shell;
  const process = tool?.process;
  const result = shell?.result;
  const output = activity.liveOutput ?? process?.output;
  const resources = tool?.resources.filter((resource) => !(resource.kind === 'workspacePath'
    && tool.fileChanges?.some((change) => change.workspaceId === resource.workspaceId && change.path === resource.logicalPath))) ?? [];
  if (activity.providerHosted) {
    return (
      <ProviderHostedEntry
        hosted={activity.providerHosted}
        status={activity.status}
        language={language}
        onExpand={onExpand}
      />
    );
  }
  return (
    <div className={`local-agent__tool-entry local-agent__tool-entry--${activity.status}`}>
      <UiRegion slot="activity.summary"><button
        type="button"
        className="local-agent__tool-entry-heading"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onExpand();
          setExpanded(!expanded);
        }}
      >
        <span className="local-agent__tool-entry-icon"><DeepCodeShellIcon name={shell ? 'terminal' : isFileMutationOperation(tool?.operation) ? 'compose' : tool?.operation?.startsWith('fs.') ? 'artifact' : 'tool'} /></span>
        <strong>{toolActivitySummary(activity, language)}</strong>
        {activity.status !== 'completed' && (
          <span>{toolActivityStatus(activity.status, language)}</span>
        )}
        {activity.status === 'active' && activity.startedAt && (
          <ToolElapsed startedAt={activity.startedAt} language={language} />
        )}
        <span className="local-agent__tool-entry-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button></UiRegion>
      {expanded && (
        <UiPluginSlotView slot="tool.result" input={{ kind: 'tool.result', activity, toolId: tool?.operation ?? activity.label, locale: language, theme }}>
        <div className="local-agent__tool-entry-details">
          {tool?.error && <p className="local-agent__tool-error" role="status"><code>{tool.error.code}</code>: {tool.error.message}</p>}
          {tool?.projectionError && <p className="local-agent__tool-error" role="status"><code>{tool.projectionError.code}</code>: {tool.projectionError.message}</p>}
          <FileChanges activities={[activity]} compact />
          <dl>
            <div>
              <dt>{t(language, 'agent.tool.detail.operation')}</dt>
              <dd><code>{tool?.operation ?? activity.label}</code></dd>
            </div>
            {process && <div><dt>{t(language, 'agent.tool.shell.command')}</dt><dd><code>{process.command}</code></dd></div>}
            {shell && (
              <>
                <div>
                  <dt>{t(language, 'agent.tool.shell.command')}</dt>
                  <dd><code>{shell.command}</code></dd>
                </div>
                <div>
                  <dt>{t(language, 'agent.tool.shell.cwd')}</dt>
                  <dd><code>{shell.cwd}</code></dd>
                </div>
                {result && (
                  <>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.environment')}</dt>
                      <dd>{t(language, 'agent.tool.shell.environmentValue', {
                        shell: result.environment.shell,
                      })}</dd>
                    </div>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.writeScope')}</dt>
                      <dd>{shellWriteScopeLabel(language, result.environment.writeScope)}</dd>
                    </div>
                  </>
                )}
              </>
            )}
          </dl>
          {activity.interruption && <p role="status">{activity.interruption.message}</p>}
          {activity.inputRejection && (
            <div className="local-agent__input-rejection">
              <p>{activity.inputRejection.message}</p>
              {activity.inputRejection.issues.map((issue, index) => (
                <div key={`${issue.path}:${issue.rule}:${index}`}>
                  <code>{issue.path}</code><span>{issue.message}</span>
                  {issue.expected !== undefined && <code>{JSON.stringify(issue.expected)}</code>}
                </div>
              ))}
            </div>
          )}
          {resources.length > 0 && (
            <div className="local-agent__tool-resources">
              {resources.map((resource, index) => {
                const key = `${resource.kind}:${resource.workspaceId ?? ''}:${resource.logicalPath ?? resource.uri ?? resource.label}:${index}`;
                if (
                  resource.kind === 'workspacePath'
                  && resource.workspaceId
                  && resource.logicalPath
                ) {
                  return (
                    <UiRegion slot="activity.summary"><button
                      type="button"
                      key={key}
                      onClick={() => onOpenWorkspaceResource(
                        resource.workspaceId!, resource.logicalPath!,
                      )}
                    >
                      {resource.label}
                    </button></UiRegion>
                  );
                }
                if (resource.kind === 'url' && resource.uri) {
                  return (
                    <a href={resource.uri} key={key} rel="noreferrer" target="_blank">
                      {resource.label}
                    </a>
                  );
                }
                return <span key={key}>{resource.label}</span>;
              })}
            </div>
          )}
          {result && (
            <div className="local-agent__shell-result">
              <div className="local-agent__shell-result-meta">
                <span>{t(language, 'agent.tool.shell.exit', {
                  code: result.exitCode ?? t(language, 'agent.tool.shell.noExitCode'),
                })}</span>
                <span>{t(language, 'agent.tool.shell.duration', {
                  duration: result.durationMs,
                })}</span>
                {result.timedOut && <span>{t(language, 'agent.tool.shell.timedOut')}</span>}
                {result.truncated && <span>{t(language, 'agent.tool.shell.truncated')}</span>}
              </div>
              {result.stdout && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stdout')}</span>
                  <pre>{result.stdout}</pre>
                </section>
              )}
              {result.stderr && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stderr')}</span>
                  <pre>{result.stderr}</pre>
                </section>
              )}
              {!result.stdout && !result.stderr && (
                <small>{t(language, 'agent.tool.shell.noOutput')}</small>
              )}
            </div>
          )}
          {process?.result && <div className="local-agent__shell-result-meta">
            <span>{t(language, 'agent.tool.shell.exit', {code: process.result.exitCode ?? t(language, 'agent.tool.shell.noExitCode')})}</span>
            <span>{t(language, 'agent.tool.shell.duration', {duration: process.result.durationMs})}</span>
            {process.result.timedOut && <span>{t(language, 'agent.tool.shell.timedOut')}</span>}
          </div>}
          {!result && output && (
            <div className="local-agent__shell-result">
              {output.truncated && <small>{t(language, 'agent.tool.shell.truncated')}</small>}
              {(['stdout', 'stderr'] as const).map((stream) => output[stream] && (
                <section key={stream}>
                  <span>{t(language, `agent.tool.shell.${stream}`)}</span>
                  <pre>{output[stream]}</pre>
                </section>
              ))}
              {!output.stdout && !output.stderr && (
                <small>{language === 'zh-CN' ? '尚无输出' : 'No output yet'}</small>
              )}
            </div>
          )}
        </div>
        </UiPluginSlotView>
      )}
    </div>
  );
};

function ToolElapsed({ startedAt, language }: { startedAt: string; language: UiLanguage }) {
  const elapsed = () => Math.max(0, Math.floor((Date.now() - Number(startedAt)) / 1000));
  const [seconds, setSeconds] = useState(elapsed);
  useEffect(() => {
    setSeconds(elapsed());
    const timer = window.setInterval(() => setSeconds(elapsed()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span>{language === 'zh-CN' ? `${seconds} 秒` : `${seconds}s`}</span>;
}

export function toolGroupSummary(
  activities: ActivityProjection[],
  language: UiLanguage,
): string {
  const status = toolGroupStatus(activities);
  if (!activities.every(activity => activity.status === 'completed')) {
    if (!activities.some(activity => ['requested', 'active', 'waiting'].includes(activity.status))) {
      return t(language, 'agent.tool.summary.count', { count: activities.length });
    }
    const counts = new Map<ActivityProjection['status'], number>();
    for (const activity of activities) counts.set(activity.status, (counts.get(activity.status) ?? 0) + 1);
    if (counts.size === 1 && ['active', 'requested', 'waiting'].includes(status)) {
      return t(language, `agent.tool.summary.${status}Many`, { count: activities.length });
    }
    return [t(language, 'agent.tool.summary.count', { count: activities.length }),
      ...Array.from(counts, ([state, count]) => t(language, 'agent.tool.summary.statusCount', {
        status: ['requested', 'active', 'waiting', 'completed'].includes(state)
          ? toolActivityStatus(state, language) : t(language, 'agent.tool.summary.ended'), count,
      }))].join(' · ');
  }
  const descriptions: string[] = [];
  const operations = activities.map(activity => activity.tool?.operation ?? '');
  if (operations.some(operation => operation === 'plugin.search' || operation === 'plugin.activate')) descriptions.push(t(language, 'agent.tool.summary.loaded'));
  if (operations.some(operation => ['fs.read', 'fs.list', 'fs.search'].includes(operation))) descriptions.push(t(language, 'agent.tool.summary.read'));
  if (operations.some(isFileMutationOperation)) descriptions.push(t(language, 'agent.tool.summary.edited'));
  if (operations.some(operation => ['bash', 'powershell', 'process.start'].includes(operation))) descriptions.push(t(language, 'agent.tool.summary.ran'));
  if (activities.some(activity => activity.kind === 'providerHosted')) descriptions.push(t(language, 'agent.tool.summary.searched'));
  if (activities.some(activity => activity.kind === 'agent')) descriptions.push(t(language, 'agent.tool.summary.agents'));
  if (!descriptions.length && activities.every(activity => activity.kind === 'approval')) descriptions.push(t(language, 'agent.tool.summary.permissions'));
  return descriptions.length ? descriptions.join(language === 'zh-CN' ? '、' : ', ')
    : t(language, 'agent.tool.summary.usedMany', { count: activities.length });
}

export function toolActivitySummary(activity: ActivityProjection, language: UiLanguage): string {
  if (activity.kind === 'providerHosted' && activity.providerHosted) {
    return providerHostedSummary(activity.providerHosted, activity.status, language);
  }
  const operation = activity.tool?.operation ?? activity.label;
  const target = activity.tool?.resources[0]?.label;
  const command = activity.tool?.shell?.command;
  if (activity.status === 'requested' || activity.status === 'waiting') {
    return t(language, `agent.tool.summary.${activity.status}One`, { operation: command ?? operation });
  }
  if (activity.status === 'completed') {
    if ((operation === 'bash' || operation === 'powershell') && command) {
      return t(language, 'agent.tool.activity.ranCommand', { command });
    }
    if (operation === 'fs.delete' && target) {
      return t(language, 'agent.tool.activity.deletedPath', { path: target });
    }
    if (isFileMutationOperation(operation) && target) {
      return t(language, 'agent.tool.activity.editedPath', { path: target });
    }
    if (operation === 'fs.read' && target) {
      return t(language, 'agent.tool.activity.readPath', { path: target });
    }
    return t(language, 'agent.tool.summary.usedOne', { operation });
  }
  if (['failed', 'denied', 'rejected', 'indeterminate', 'cancelled'].includes(activity.status)) {
    if ((operation === 'bash' || operation === 'powershell') && command) {
      return t(language, 'agent.tool.activity.commandDidNotComplete', { command });
    }
    return t(language, 'agent.tool.activity.didNotComplete', {
      operation,
      target: target ? ` · ${target}` : '',
    });
  }
  if ((operation === 'bash' || operation === 'powershell') && command) {
    return t(language, 'agent.tool.activity.runningCommand', { command });
  }
  return t(language, 'agent.tool.activity.runningOperation', {
    operation,
    target: target ? ` · ${target}` : '',
  });
}

function providerHostedSummary(hosted: ProviderHostedActivityProjection, status: ActivityProjection['status'], language: UiLanguage): string {
  const target = providerHostedActionTarget(hosted.action);
  const state = status === 'completed' ? 'completed'
    : ['failed', 'denied', 'indeterminate', 'cancelled'].includes(status) ? 'didNotComplete' : 'active';
  return target ? t(language, `agent.providerHosted.summary.${state}Target`, { target })
    : t(language, `agent.providerHosted.summary.${state}`);
}

function providerHostedActionType(action: Record<string, unknown> | undefined): string {
  return typeof action?.type === 'string' ? action.type : '';
}

function providerHostedActionTarget(action: Record<string, unknown> | undefined): string {
  if (!action) return '';
  if (Array.isArray(action.queries)) {
    const queries = action.queries.filter((query): query is string => (
      typeof query === 'string' && query.length > 0
    ));
    if (queries.length > 0) return queries.join(' · ');
  }
  for (const field of ['query', 'url', 'pattern']) {
    const value = action[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function isFileMutationOperation(operation: string | undefined): boolean {
  return operation !== undefined && [
    'fs.write',
    'fs.edit',
    'fs.delete',
  ].includes(operation);
}

function toolActivityStatus(
  status: ActivityProjection['status'],
  language: UiLanguage,
): string {
  return t(language, `agent.tool.status.${status}`);
}

function toolGroupStatus(
  activities: ActivityProjection[],
): ActivityProjection['status'] {
  const priority: ActivityProjection['status'][] = [
    'active',
    'waiting',
    'requested',
    'failed',
    'denied',
    'rejected',
    'indeterminate',
    'cancelled',
    'completed',
  ];
  return priority.find((status) => activities.some((activity) => activity.status === status))
    ?? 'indeterminate';
}
