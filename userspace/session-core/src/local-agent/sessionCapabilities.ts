import { buildAgentProviderRequest } from './contextComposer.js';
import { estimateContextInput, prepareContextCompaction, pressureCompactionCutoff } from './compaction.js';
import { presentArtifacts } from './deliverables.js';
import { publishPlan } from './planStage.js';
import { decodeSessionControlCall } from './sessionControls.js';
import { todoUpdateFact } from './todoState.js';
import type { SessionCapabilities } from './plugins.js';

export function createSessionCapabilities(): SessionCapabilities {
  return {
    context: { prepare: buildAgentProviderRequest },
    compaction: {
      prepare: prepareContextCompaction,
      pressureCutoff: pressureCompactionCutoff,
      estimateInput: estimateContextInput,
    },
    controls: {
      decode: decodeSessionControlCall,
      publishPlan,
      presentArtifacts,
      updateTodo: todoUpdateFact,
    },
    async dispose() {},
  };
}

export interface SessionCapabilityLease {
  readonly implementation: SessionCapabilities;
  release(): Promise<void>;
}

interface InstalledCapabilities {
  implementation: SessionCapabilities;
  references: number;
  retired: boolean;
  disposal?: Promise<void>;
}

/** Process-local implementation ownership; this is neither execution state nor journal state. */
export class SessionCapabilityManager {
  readonly #installed = new Set<InstalledCapabilities>();
  #current: InstalledCapabilities;
  #disposed = false;

  constructor(implementation: SessionCapabilities = createSessionCapabilities()) {
    this.#current = { implementation, references: 0, retired: false };
    this.#installed.add(this.#current);
  }

  acquire(): SessionCapabilityLease {
    if (this.#disposed) throw new Error('session_capabilities_disposed');
    const installed = this.#current;
    installed.references += 1;
    let released: Promise<void> | undefined;
    return {
      implementation: installed.implementation,
      release: () => released ??= (async () => {
        installed.references -= 1;
        await this.releaseRetired(installed);
      })(),
    };
  }

  /** The caller initializes the replacement before transferring ownership here. */
  async replace(implementation: SessionCapabilities): Promise<void> {
    if (this.#disposed) throw new Error('session_capabilities_disposed');
    if ([...this.#installed].some(item => item.implementation === implementation)) {
      throw new Error('session_capabilities_already_installed');
    }
    const previous = this.#current;
    this.#current = { implementation, references: 0, retired: false };
    this.#installed.add(this.#current);
    previous.retired = true;
    await this.releaseRetired(previous);
  }

  /** The Actor stops its loop before disposal, so no request may still hold a lease. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const results = await Promise.allSettled([...this.#installed].map(async installed => {
      installed.retired = true;
      if (installed.references !== 0) throw new Error('session_capabilities_in_use');
      await this.releaseRetired(installed);
    }));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'session_capabilities_dispose_failed');
  }

  private async releaseRetired(installed: InstalledCapabilities): Promise<void> {
    if (!installed.retired || installed.references !== 0) return;
    installed.disposal ??= Promise.resolve().then(() => installed.implementation.dispose());
    await installed.disposal;
    this.#installed.delete(installed);
  }
}
