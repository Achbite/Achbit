import type { ContextCompositionReceipt, RunRuntimeSnapshot, SessionEvent } from '@achbit/protocol';
import type { SessionState } from './reducer.js';

function contextShapeUnits(
  partitions: readonly { requestShapeUnits: number }[],
): number {
  return partitions.reduce((total, partition) => total + partition.requestShapeUnits, 0);
}

/** Admission estimate only: never report this as Provider token usage. */
export function estimateContextInput(
  snapshot: { events: readonly SessionEvent[]; state: SessionState },
  receipt: ContextCompositionReceipt, runtime: RunRuntimeSnapshot,
): number {
  const units = contextShapeUnits(receipt.partitions);
  const usage = snapshot.state.contextUsage;
  const prior = usage && snapshot.state.contextCompositions.find((item) => item.providerRequestId === usage.providerRequestId);
  const checkpointAfterUsage = usage && snapshot.events.some((event) => event.type === 'context.compacted' && event.sequence > usage.sequence);
  const previousProvider = usage && snapshot.state.runRuntimeSnapshots[usage.runId]?.provider;
  // A runtime ref identifies one execution, not a model's input accounting.
  // Cross-run calibration needs the matching frozen measurement and a stable
  // resolved-model key; profile IDs alone can outlive model/endpoint edits.
  const compatibleProvider = usage && (usage.providerRuntimeRef === runtime.provider.providerRuntimeRef
    || previousProvider?.providerRuntimeRef === usage.providerRuntimeRef
      && runtime.provider.inputTokenCalibrationKey !== undefined
      && previousProvider.inputTokenCalibrationKey === runtime.provider.inputTokenCalibrationKey);
  if (usage && prior && !checkpointAfterUsage && compatibleProvider
    && usage.contextWindowTokens === runtime.provider.contextWindowTokens) {
    const priorUnits = contextShapeUnits(prior.partitions);
    if (priorUnits > 0) return Math.ceil(usage.inputTokens * units / priorUnits);
  }
  // No prior usage exists for a first request or after a checkpoint. Bound the
  // request shape, including schemas, instead of treating unavailable usage as zero.
  return Math.ceil(units / 3);
}
