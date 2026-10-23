import type { ArtifactProjection, DeliverableProjection, NewSessionEvent, SessionEvent } from '@achbit/protocol';
import type { ArtifactPresentationInput } from './sessionControls.js';
import { SessionControlError } from './sessionControls.js';

type PresentationState = {
  sessionId: string;
  artifacts: Record<string, ArtifactProjection>;
  deliverables: Record<string, DeliverableProjection>;
};

function resourceIdentity(artifact: ArtifactProjection): string {
  return artifact.resourceKey ?? (artifact.workspaceId && artifact.logicalPath
    ? JSON.stringify([artifact.workspaceId, artifact.logicalPath]) : artifact.uri ?? artifact.artifactId);
}

export function presentArtifacts(state: PresentationState, runId: string, callId: string,
  providerCallId: string, requested: readonly ArtifactPresentationInput[], nextId: (kind: string) => string): NewSessionEvent {
  const identities = new Set<string>();
  const items = requested.map(item => {
    const artifact = state.artifacts[item.artifactId];
    if (!artifact) throw new SessionControlError('artifact_not_found', `Unknown archived resource: ${item.artifactId}`);
    const key = resourceIdentity(artifact);
    if (identities.has(key)) throw new SessionControlError('artifact_presentation_duplicate', 'Present one version of each resource per call.');
    identities.add(key);
    const existing = Object.values(state.deliverables).find(delivery => resourceIdentity(delivery) === key);
    if (item.deliveryId && existing?.deliveryId !== item.deliveryId) {
      throw new SessionControlError('artifact_delivery_identity_mismatch', 'deliveryId must identify an existing delivery of this resource.');
    }
    return { artifactId: item.artifactId, label: item.label, deliveryId: existing?.deliveryId ?? nextId('delivery') };
  });
  return { type: 'artifacts.presented', sessionId: state.sessionId, runId, callId, payload: { providerCallId, items } };
}

export function advanceDeliverables(state: PresentationState, event: Extract<SessionEvent, { type: 'artifacts.presented' }>): Record<string, DeliverableProjection> {
  const next = { ...state.deliverables };
  for (const item of event.payload.items) {
    const artifact = state.artifacts[item.artifactId];
    if (!artifact || !item.label.trim() || !item.deliveryId.trim()) throw new Error('artifact_presentation_invalid');
    const previous = next[item.deliveryId];
    const key = resourceIdentity(artifact);
    if (Object.values(next).some(value => resourceIdentity(value) === key && value.deliveryId !== item.deliveryId)
      || previous && resourceIdentity(previous) !== key) throw new Error('artifact_delivery_identity_mismatch');
    next[item.deliveryId] = { ...artifact, label: item.label, deliveryId: item.deliveryId,
      presentationRunId: event.runId, presentedAt: previous?.presentedAt ?? event.occurredAt,
      updatedAt: artifact.modifiedAt ?? artifact.createdAt, sequence: event.sequence };
  }
  return next;
}

export function compareDeliverables(left: DeliverableProjection, right: DeliverableProjection): number {
  const timestamp = (value: string): number => /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return timestamp(right.updatedAt) - timestamp(left.updatedAt) || right.sequence - left.sequence;
}
