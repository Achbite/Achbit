import type { AgentContributionSelection, JsonObject } from '@deepcode/protocol';
import { decodeAgentContribution } from '@deepcode/protocol';
import { runAgentLoop } from './loop.js';

/** A trusted driver uses the same Actor commit, cancellation and Kernel ports. */
export interface AgentLoopDriver {
  run: typeof runAgentLoop;
  dispose?(): Promise<void>;
}

export interface AgentLoopContribution {
  id: string;
  description: string;
  parametersSchema: JsonObject;
  validate(parameters: JsonObject): void;
  create(parameters: JsonObject): AgentLoopDriver;
}

/** Models select installed code by identity; recipes never load executable code. */
export class AgentLoopRegistry {
  readonly #entries = new Map<string, AgentLoopContribution>();

  constructor(contributions: readonly AgentLoopContribution[] = builtinAgentLoops()) {
    for (const contribution of contributions) {
      decodeAgentContribution({ id: contribution.id });
      if (this.#entries.has(contribution.id)) throw new Error('agent_loop_duplicate');
      this.#entries.set(contribution.id, contribution);
    }
  }

  describe(): JsonObject[] {
    return [...this.#entries.values()].map(({ id, description, parametersSchema }) =>
      ({ id, description, parametersSchema: structuredClone(parametersSchema) }));
  }

  validate(selection: AgentContributionSelection = { id: 'standard' }): AgentContributionSelection {
    const value = decodeAgentContribution(selection);
    const definition = this.#entries.get(value.id);
    if (!definition) throw new Error(`agent_loop_unavailable:${value.id}`);
    definition.validate(value.parameters ?? {});
    return value;
  }

  create(selection: AgentContributionSelection): AgentLoopDriver {
    const value = this.validate(selection);
    return this.#entries.get(value.id)!.create(value.parameters ?? {});
  }
}

export function builtinAgentLoops(): AgentLoopContribution[] {
  return [{ id: 'standard', description: 'Provider/tool loop with durable events, waiting, cancellation and recovery.',
    parametersSchema: { type: 'object', additionalProperties: false, properties: {} },
    validate(parameters) { if (Object.keys(parameters).length) throw new Error('agent_loop_parameters_invalid'); },
    create: () => ({ run: runAgentLoop }) }];
}
