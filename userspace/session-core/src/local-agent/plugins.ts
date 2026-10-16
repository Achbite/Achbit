import type {
  ContextCompositionPartitionKind,
  KernelPort,
  ModelMessage,
  ProviderPort,
  RunPreparationPort,
} from '@deepcode/protocol';
import type { buildAgentProviderRequest } from './contextComposer.js';
import type { estimateContextInput, prepareContextCompaction, pressureCompactionCutoff } from './compaction.js';
import type { decodeSessionControlCall } from './sessionControls.js';
import type { publishPlan } from './planStage.js';
import type { presentArtifacts } from './deliverables.js';
import type { todoUpdateFact } from './todoState.js';
import type { AgentLoopDriver } from './loopRegistry.js';

export interface ContextMessageContribution {
  contributionId: string;
  contributionKind: Exclude<ContextCompositionPartitionKind, 'filesystemReferences' | 'tools'>;
  label: string;
  message: ModelMessage;
  sourceSequence?: number;
}

/** Implementations are selected together for one logical request, including retries. */
export interface SessionCapabilities {
  readonly context: {
    readonly prepare: (
      input: Parameters<typeof buildAgentProviderRequest>[0], signal: AbortSignal,
    ) => ReturnType<typeof buildAgentProviderRequest>;
  };
  readonly compaction: {
    readonly prepare: (
      input: Parameters<typeof prepareContextCompaction>[0], signal: AbortSignal,
    ) => ReturnType<typeof prepareContextCompaction> | Promise<ReturnType<typeof prepareContextCompaction>>;
    readonly pressureCutoff: typeof pressureCompactionCutoff;
    readonly estimateInput: typeof estimateContextInput;
  };
  readonly controls: {
    readonly optionalTools?: readonly string[];
    readonly decode: typeof decodeSessionControlCall;
    readonly publishPlan: typeof publishPlan;
    readonly presentArtifacts: typeof presentArtifacts;
    readonly updateTodo: typeof todoUpdateFact;
  };
  dispose(): Promise<void>;
}

/** Trusted ports assembled by the Host; extension activation remains in Kernel. */
export interface AgentComposition {
  provider: ProviderPort;
  kernel: KernelPort;
  runPreparation: RunPreparationPort;
  /** Actor owns this implementation; replacement is a trusted Session operator action. */
  capabilities?: SessionCapabilities;
  /** Actor owns this driver and disposes it after all active execution stops. */
  runner?: AgentLoopDriver;
  dispose(): Promise<void>;
}
