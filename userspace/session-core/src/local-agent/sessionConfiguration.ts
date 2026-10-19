import type { AgentConfiguration, AgentContributionSelection, JsonObject } from '@deepcode/protocol';
import { SESSION_CONTROL_ARTIFACT_PRESENT, SESSION_CONTROL_SESSION, SESSION_CONTROL_TODO_UPDATE } from '@deepcode/protocol';
import type { SessionCapabilities } from './plugins.js';
import { createSessionCapabilities } from './sessionCapabilities.js';
import { buildAgentProviderRequest } from './contextComposer.js';
import { DEFAULT_AGENT_CONFIGURATION } from './agentConfiguration.js';

type Kind = keyof AgentConfiguration;
export interface SessionContribution<K extends Kind = Kind> {
  kind: K;
  id: string;
  description: string;
  parametersSchema: JsonObject;
  /** Structural choices available without full model/context configuration. */
  basicParameters?: readonly string[];
  validate(parameters: JsonObject): void;
  create(parameters: JsonObject): { implementation: SessionCapabilities[K]; dispose?(): Promise<void> };
}

const OPTIONAL_CONTROLS = [SESSION_CONTROL_TODO_UPDATE, SESSION_CONTROL_SESSION, SESSION_CONTROL_ARTIFACT_PRESENT];
/** Host-installed contributions, with one catalog for admission, discovery and restoration. */
export class SessionConfigurationRegistry {
  readonly #entries = new Map<string, SessionContribution>();

  constructor(contributions: readonly SessionContribution[] = builtinSessionContributions()) {
    for (const contribution of contributions) {
      const key = `${contribution.kind}:${contribution.id}`;
      if (this.#entries.has(key)) throw new Error('session_contribution_duplicate');
      this.#entries.set(key, contribution);
    }
  }

  describe(fullConfiguration: boolean): JsonObject {
    return Object.fromEntries((['context', 'compaction', 'controls'] as const).filter(kind => fullConfiguration || kind !== 'context')
      .map(kind => [kind, [...this.#entries.values()].filter(item => item.kind === kind).map(item => ({
        id: item.id, description: item.description,
        parametersSchema: fullConfiguration ? item.parametersSchema : {
          type: 'object', additionalProperties: false,
          properties: Object.fromEntries(Object.entries(item.parametersSchema.properties as JsonObject ?? {})
            .filter(([key]) => item.basicParameters?.includes(key))),
        },
      }))]));
  }

  resolve(base: AgentConfiguration = DEFAULT_AGENT_CONFIGURATION,
    overrides: Partial<AgentConfiguration> = {}, fullConfiguration = false): AgentConfiguration {
    const result = structuredClone(base);
    for (const kind of ['context', 'compaction', 'controls'] as const) {
      const override = overrides[kind];
      if (override) {
        const definition = this.definition(kind, override);
        if (!fullConfiguration && (kind === 'context'
          || Object.keys(override.parameters ?? {}).some(key => !definition.basicParameters?.includes(key)))) {
          throw new Error('agent_full_configuration_required');
        }
        result[kind] = override.id === result[kind].id
          ? { id: override.id, parameters: { ...result[kind].parameters, ...structuredClone(override.parameters) } }
          : structuredClone(override);
      }
      this.definition(kind, result[kind]).validate(result[kind].parameters ?? {});
    }
    return result;
  }

  async create(configuration: AgentConfiguration): Promise<SessionCapabilities> {
    const acquired: Array<{ dispose?(): Promise<void> }> = [];
    const dispose = async () => {
      const outcomes = await Promise.allSettled(acquired.map(item => item.dispose?.()));
      const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'session_contributions_dispose_failed');
    };
    const build = <K extends Kind>(kind: K): SessionCapabilities[K] => {
      const selection = configuration[kind];
      const definition = this.definition(kind, selection);
      definition.validate(selection.parameters ?? {});
      const installed = definition.create(selection.parameters ?? {});
      acquired.push(installed);
      return installed.implementation as SessionCapabilities[K];
    };
    try {
      const controls = build('controls');
      const context = build('context');
      const compaction = build('compaction');
      return { controls, compaction: { ...compaction,
          prepare: (input, signal) => compaction.prepare({ ...input, optionalControlTools: controls.optionalTools }, signal) },
        context: { ...context, prepare: (input, signal) => context.prepare({ ...input, optionalControlTools: controls.optionalTools }, signal) }, dispose };
    } catch (error) {
      try { await dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'session_contributions_initialization_failed'); }
      throw error;
    }
  }

  private definition(kind: Kind, selection: AgentContributionSelection): SessionContribution {
    const entry = this.#entries.get(`${kind}:${selection.id}`);
    if (!entry) throw new Error(`agent_contribution_unavailable:${kind}:${selection.id}`);
    return entry;
  }
}

export function builtinSessionContributions(): SessionContribution[] {
  return [
    { kind: 'context', id: 'journal', description: 'The Session journal and its stable recorded model views.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: {
        maxTokens: { type: 'integer', minimum: 1, description: 'Optional context budget including output reserve; capped by the selected model window. Omit to inherit.' },
      } },
      validate(parameters) {
        if (Object.keys(parameters).some(key => key !== 'maxTokens') || parameters.maxTokens !== undefined
          && (!Number.isSafeInteger(parameters.maxTokens) || Number(parameters.maxTokens) <= 0)) throw new Error('agent_context_parameters_invalid');
      },
      create: parameters => ({ implementation: { prepare: buildAgentProviderRequest,
        windowTokens: runtime => Math.min(runtime.provider.contextWindowTokens, Number(parameters.maxTokens ?? runtime.provider.contextWindowTokens)),
      } }) },
    { kind: 'compaction', id: 'summary', description: 'Summarize at the context budget; optional automatic management at task boundaries.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: {
        pressureRatio: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Fraction of the context budget for capacity-pressure compaction. Default 1.' },
        enabled: { type: 'boolean', description: 'Automatic task-boundary compaction. Omit to inherit.' },
        thresholdTokens: { type: 'integer', minimum: 1, description: 'Automatic compaction soft threshold in tokens, including cached input. Omit to inherit.' },
      } },
      validate(parameters) {
        if (Object.keys(parameters).some(key => !['pressureRatio', 'enabled', 'thresholdTokens'].includes(key))
          || parameters.enabled !== undefined && typeof parameters.enabled !== 'boolean'
          || parameters.thresholdTokens !== undefined && (!Number.isSafeInteger(parameters.thresholdTokens) || Number(parameters.thresholdTokens) <= 0)
          || parameters.pressureRatio !== undefined
          && (typeof parameters.pressureRatio !== 'number' || !Number.isFinite(parameters.pressureRatio)
            || parameters.pressureRatio <= 0 || parameters.pressureRatio > 1)) throw new Error('agent_compaction_parameters_invalid');
      },
      create(parameters) {
        const compaction = createSessionCapabilities().compaction;
        return { implementation: { ...compaction,
          settings: runtime => ({ enabled: parameters.enabled as boolean ?? runtime.contextManagement.enabled,
            thresholdTokens: parameters.thresholdTokens as number ?? runtime.contextManagement.thresholdTokens }),
          pressureCutoff: (snapshot, runId, receipt, runtime, budget = runtime.provider.contextWindowTokens) => compaction.pressureCutoff(snapshot, runId, receipt,
            runtime, Math.floor(budget * Number(parameters.pressureRatio ?? 1))),
        } };
      } },
    { kind: 'controls', id: 'standard', description: 'Use the shared Loop controls; optional progress, waiting and delivery tools can be selected.',
      basicParameters: ['optionalTools'], parametersSchema: { type: 'object', additionalProperties: false, properties: {
        optionalTools: { type: 'array', uniqueItems: true, items: { enum: OPTIONAL_CONTROLS },
          description: 'Omit for all optional tools; an empty list disables them. Plan and user decisions retain their existing contract.' },
      } },
      validate(parameters) {
        if (Object.keys(parameters).some(key => key !== 'optionalTools') || parameters.optionalTools !== undefined
          && (!Array.isArray(parameters.optionalTools) || new Set(parameters.optionalTools).size !== parameters.optionalTools.length
            || parameters.optionalTools.some(tool => !OPTIONAL_CONTROLS.includes(tool as typeof OPTIONAL_CONTROLS[number])))) {
          throw new Error('agent_controls_parameters_invalid');
        }
      },
      create(parameters) {
        const optionalTools = [...(parameters.optionalTools as string[] ?? OPTIONAL_CONTROLS)];
        const controls = createSessionCapabilities().controls;
        return { implementation: { ...controls, optionalTools,
          decode(callId, name, input) {
            if (OPTIONAL_CONTROLS.includes(name as typeof OPTIONAL_CONTROLS[number]) && !optionalTools.includes(name)) {
              throw new Error('session_control_unavailable');
            }
            return controls.decode(callId, name, input);
          },
        } };
      } },
  ];
}
