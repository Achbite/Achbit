import { LoopFailure } from './loopFailure.js';
import type { AgentLoopDeps } from './loopTypes.js';
import { createSessionCapabilities } from './sessionCapabilities.js';
import type { SessionCapabilityLease } from './sessionCapabilities.js';

export function installedControls<T>(controls: T | undefined): T {
  if (!controls) throw new LoopFailure('session_control_unavailable', 'This session has no control component.');
  return controls;
}

export function acquireCapabilities(deps: AgentLoopDeps): SessionCapabilityLease {
  if (deps.capabilities) return deps.capabilities.acquire();
  // Direct Loop callers own their composition. Actors always provide the manager.
  return {
    implementation: deps.composition.capabilities ?? createSessionCapabilities(),
    async release() {},
  };
}

export async function releaseCapabilities(
  lease: SessionCapabilityLease,
  failure?: { error: unknown },
): Promise<void> {
  try {
    await lease.release();
  } catch (error) {
    throw new CapabilityReleaseFailure(failure?.error === error ? undefined : failure, error);
  }
}

/** Keeps request classification while reporting an additional implementation cleanup failure. */
export class CapabilityReleaseFailure extends AggregateError {
  constructor(readonly requestFailure: { error: unknown } | undefined, releaseError: unknown) {
    super(requestFailure ? [requestFailure.error, releaseError] : [releaseError], 'session_capability_release_failed');
  }
}

/** Resource cleanup failure must remain visible even if cancellation arrives concurrently. */
export class ToolViewRetirementFailure extends AggregateError {
  constructor(error: unknown) {
    super([error], 'tool_view_retire_failed');
  }
}
