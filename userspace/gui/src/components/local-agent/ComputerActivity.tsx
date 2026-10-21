import type { ActivityProjection, ArtifactProjection, ComputerActivityProjection, JsonObject } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { ArtifactImageLink } from './ArtifactLinks';
import { FileChanges } from './FileChanges';
import { UiPluginSlotView, useDisplayTheme } from '../../ui-plugins/UiPlugins';
import { useConversationRowState } from './ConversationVirtualRow';
import './computerActivity.css';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const short = (value: string): string => value.length > 80 ? `${value.slice(0, 80)}…` : value;

export function computerActivitySummary(computer: ComputerActivityProjection, language: UiLanguage): string {
  const { input, action } = computer;
  const label = t(language, `agent.computer.action.${action}`);
  const verb = label === `agent.computer.action.${action}` ? action : label;
  const element = computer.inputObservation?.element;
  const elementName = text(element?.title) || text(element?.description) || text(element?.text) || text(input.elementId);
  const coordinates = typeof input.x === 'number' && typeof input.y === 'number' ? `(${input.x}, ${input.y})` : '';
  let target = '';
  if (action === 'press') target = elementName;
  else if (action === 'click') target = text(input.selector) || coordinates;
  else if (action === 'type' || action === 'setValue') target = elementName || text(input.selector) || short(text(input.text));
  else if (action === 'key') target = text(input.key);
  else if (action === 'drag') target = `${coordinates} → (${input.toX}, ${input.toY})`;
  else if (action === 'scroll') target = ['deltaX', 'deltaY', 'x', 'y']
    .filter(key => typeof input[key] === 'number').map(key => `${key}: ${input[key]}`).join(', ');
  else if (['observe', 'capture', 'open', 'openSelf', 'navigate', 'reload', 'inspect', 'activate', 'close'].includes(action)) {
    target = text(computer.window?.title) || text(computer.observation?.interface?.title)
      || text(computer.page?.title) || text(computer.page?.url) || text(input.url) || text(input.path)
      || text(input.previewId) || computer.app || '';
  }
  return target ? `${verb} · ${target}` : verb;
}

/** Render only the interface returned by this observation; no current-window reads. */
export function computerInterfaceText(snapshot: JsonObject): string {
  const lines: string[] = [];
  if (typeof snapshot.text === 'string') lines.push(snapshot.text);
  if (Array.isArray(snapshot.elements)) {
    for (const element of snapshot.elements) {
      if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
      const names = [element.title, element.text, element.description, element.value]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      if (element.value !== undefined && (typeof element.value !== 'string' || element.value === '')) {
        names.push(`value=${JSON.stringify(element.value)}`);
      }
      lines.push([element.elementId ?? element.selector, element.role, ...new Set(names)]
        .filter(value => typeof value === 'string' && value).join('  '));
    }
  }
  if (snapshot.accessibility) lines.push(JSON.stringify(snapshot.accessibility, null, 2));
  return lines.join('\n');
}

function ObservationImages({ ids, artifacts, language, before = false }: {
  ids: string[]; artifacts: readonly ArtifactProjection[]; language: UiLanguage; before?: boolean;
}) {
  const label = t(language, before ? 'agent.computer.inputImage' : 'agent.computer.observationImage');
  return <div className="computer-activity__images">{ids.map(id => {
    const artifact = artifacts.find(item => item.artifactId === id);
    return artifact ? <ArtifactImageLink key={id} artifact={artifact} label={label}
      title={label} className="computer-activity__image" />
      : <span key={id} role="status">{t(language, 'agent.computer.imageUnavailable')}</span>;
  })}</div>;
}

export function ComputerActivity({ activity, computer, artifacts, language, statusLabel, onExpand }: {
  activity: ActivityProjection; computer: ComputerActivityProjection; artifacts: readonly ArtifactProjection[];
  language: UiLanguage; statusLabel: string; onExpand(): void;
}) {
  const [expanded, setExpanded] = useConversationRowState(`computer:${activity.activityId}:details`, false);
  const theme = useDisplayTheme();
  const observation = computer.observation;
  const target = text(computer.window?.title) || text(computer.page?.title) || text(computer.page?.url) || computer.app;
  const error = activity.tool?.error ?? activity.tool?.projectionError ?? activity.interruption;
  const summary = computerActivitySummary(computer, language);
  return <div className={`local-agent__tool-entry local-agent__tool-entry--${activity.status} computer-activity`}>
    <button type="button" className="local-agent__tool-entry-heading" aria-expanded={expanded}
      onClick={() => { onExpand(); setExpanded(!expanded); }}>
      <span className="local-agent__tool-entry-icon"><DeepCodeShellIcon name="browser" /></span>
      <strong>{summary}</strong>
      {activity.status !== 'completed' && <span>{statusLabel}</span>}
      <span className="local-agent__tool-entry-chevron" aria-hidden="true"><DeepCodeShellIcon name="chevronRight" /></span>
    </button>
    {expanded && <UiPluginSlotView slot="tool.result" input={{ kind: 'tool.result', activity, toolId: activity.tool?.operation ?? activity.label, locale: language, theme }}>
    <div className="computer-activity__body">
      {target && !summary.endsWith(` · ${target}`) && <span className="computer-activity__target">{target}</span>}
      {computer.dispatched === true && <span className="computer-activity__dispatch">{t(language,
        error?.code === 'computer_observation_failed' ? 'agent.computer.dispatchedObservationFailed' : 'agent.computer.dispatched')}</span>}
      {error && <p className="local-agent__tool-error" role="status">{error.message}</p>}
      {activity.notExecuted && <p role="status">{t(language, `agent.tool.notExecuted.${activity.notExecuted.reason === 'cancelled' ? 'cancelled' : 'dependencyFailed'}`)}</p>}
      {activity.inputRejection && <p className="local-agent__tool-error" role="status">{activity.inputRejection.message}</p>}
      {observation && observation.artifactIds.length > 0 && <ObservationImages ids={observation.artifactIds} artifacts={artifacts} language={language} />}
      {observation?.interface && <div className="computer-activity__interface">
        <span>{t(language, 'agent.computer.interface')}</span>
        <pre>{computerInterfaceText(observation.interface)}</pre>
      </div>}
      {computer.result && <div className="computer-activity__details">
        <span>{t(language, 'agent.computer.result')}</span><pre>{JSON.stringify(computer.result, null, 2)}</pre>
      </div>}
      <FileChanges activities={[activity]} inlineDiff />
      <details className="computer-activity__parameters" onToggle={onExpand}>
        <summary>{t(language, 'agent.computer.parameters')}</summary>
        {computer.inputObservation && computer.inputObservation.artifactIds.length > 0 && <ObservationImages
          ids={computer.inputObservation.artifactIds} artifacts={artifacts} language={language} before />}
        <pre>{JSON.stringify(computer.input, null, 2)}</pre>
      </details>
    </div>
    </UiPluginSlotView>}
  </div>;
}
