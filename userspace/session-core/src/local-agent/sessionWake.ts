import type { JsonObject, SessionEvent } from '@deepcode/protocol';

/** Stored with the accepted control result, never sent to the model. */
export interface ControlWait {
  afterSequence: number;
  deadline?: number;
}

export type WaitingControl = Extract<SessionEvent, { type: 'session.control.completed' | 'agent.control.completed' }>;

export function controlWait(result: JsonObject): ControlWait | undefined {
  if (result.wait === undefined) return undefined;
  const value = result.wait as JsonObject;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'afterSequence' && key !== 'deadline')
    || !Number.isSafeInteger(value.afterSequence) || Number(value.afterSequence) < 0
    || value.deadline !== undefined && (!Number.isSafeInteger(value.deadline) || Number(value.deadline) < 0)) {
    throw new Error('control_wait_invalid');
  }
  return { afterSequence: value.afterSequence as number,
    ...(value.deadline === undefined ? {} : { deadline: value.deadline as number }) };
}

/** A later request consumes the wait; reload resumes only an unconsumed control. */
export function pendingControlWait(events: readonly SessionEvent[], runId: string): WaitingControl | undefined {
  let pending: WaitingControl | undefined;
  for (const event of events) {
    if (!('runId' in event) || event.runId !== runId) continue;
    if ((event.type === 'session.control.completed' || event.type === 'agent.control.completed') && controlWait(event.payload.result)) {
      pending = event;
    } else if (event.type === 'context.composed' && event.payload.purpose === 'agent'
      && pending && (event.payload.modelView?.throughSequence ?? event.sequence) >= pending.sequence
      || event.type === 'run.finishing' || event.type === 'run.settled') pending = undefined;
  }
  return pending;
}

/** Derived from the existing journal; timer handles never own business state. */
export function pendingWakeups(events: readonly SessionEvent[], runId: string): Map<string, Extract<SessionEvent, { type: 'wake.scheduled' }>> {
  const pending = new Map<string, Extract<SessionEvent, { type: 'wake.scheduled' }>>();
  for (const event of events) {
    if (!('runId' in event) || event.runId !== runId) continue;
    if (event.type === 'wake.scheduled') pending.set(event.payload.scheduleId, event);
    if (event.type === 'wake.triggered' || event.type === 'wake.cancelled') pending.delete(event.payload.scheduleId);
    if (event.type === 'run.finishing' || event.type === 'run.settled') pending.clear();
  }
  return pending;
}

export function inputAfter(events: readonly SessionEvent[], runId: string, sequence: number): boolean {
  return events.some(event => event.sequence > sequence && 'runId' in event && event.runId === runId
    && (event.type === 'agent.message.received' || event.type === 'agent.task.completed'
      || event.type === 'wake.triggered' || event.type === 'input.queued'));
}
