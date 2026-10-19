import { readSessionEvents } from '../local-agent/conversationRead.js';
import { recoverSession, projectSession } from '../local-agent/reducer.js';
import { startSessionServiceBridge, reportBridgeFailure } from '../sessionServiceBridge.js';
import { DebugObservations } from './observations.js';

void startSessionServiceBridge(send => {
  const observations = new DebugObservations(send);
  return {
    observation: observations,
    operations: ['debug.subscribe', 'debug.unsubscribe', 'debug.observationStatus', 'debug.metrics', 'debug.resultRead'],
    async dispatch(service, operation, data, journal) {
      const required = (key: string) => { const value = data[key]; if (typeof value !== 'string' || !value) throw new Error(`debug_field_invalid:${key}`); return value; };
      switch (operation) {
        case 'debug.subscribe': {
          const sessionId = required('sessionId');
          // Install the subscription before loading the Actor; recovery can produce facts.
          const result = observations.subscribe({ subscriptionId: required('subscriptionId'), sessionId,
            ...(typeof data.runId === 'string' ? { runId: data.runId } : {}),
            ...(typeof data.inputBudgetTokens === 'number' ? { inputBudgetTokens: data.inputBudgetTokens } : {}) });
          try {
            const snapshot = await service.snapshot(sessionId);
            const seen = new Set<string>();
            const seed = async (current: typeof snapshot): Promise<void> => {
              if (seen.has(current.sessionId)) return;
              seen.add(current.sessionId);
              observations.seedTasks(current);
              for (const task of current.agentTasks ?? []) if (task.status === 'running' && task.childRunId) await seed(await service.snapshot(task.agentSessionId));
            };
            await seed(snapshot);
            return { ...result, snapshot };
          }
          catch (error) { observations.failed(sessionId, error); throw error; }
        }
        case 'debug.unsubscribe': return observations.close(required('subscriptionId'));
        case 'debug.observationStatus': return observations.status(required('subscriptionId'));
        case 'debug.resultRead': {
          const sessionId = required('sessionId');
          const sequence = data.eventSequence;
          if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('debug_event_sequence_invalid');
          for await (const event of journal.read(sessionId, sequence - 1)) {
            if (event.sequence !== sequence) break;
            return { source: 'sessionJournal', sessionId, eventSequence: sequence, event };
          }
          throw new Error('debug_event_not_found');
        }
        case 'debug.metrics': {
          const sessionId = required('sessionId');
          const state = recoverSession(sessionId, await readSessionEvents(journal, sessionId));
          const projection = projectSession(state);
          const includingChildren = await service.snapshot(sessionId);
          const runId = typeof data.runId === 'string' ? data.runId : undefined;
          return { sessionId: projection.sessionId, revision: projection.revision,
            runTimings: projection.runTimings?.filter(value => !runId || value.runId === runId) ?? [],
            providerAttempts: Object.values(state.providerAttempts).filter(value => !runId || value.runId === runId),
            tokenUsageHistory: projection.tokenUsageHistory.filter(value => !runId || value.runId === runId),
            scope: 'session', tokenSource: 'providerReportedSessionProjection',
            ownTokenUsage: projection.tokenUsage, includingChildrenTokenUsage: includingChildren.totalTokenUsage,
            aggregateScope: 'wholeSession', physicalAttemptUsage: { source: 'kernelProviderUsage', queryKind: 'provider', coverage: 'separateQuery' }, externalControllerUsage: { coverage: 'unknown', reason: 'notExposed' } };
        }
        default: throw new Error('debug_operation_invalid');
      }
    },
    dispose: () => observations.dispose(),
  };
}).catch(reportBridgeFailure);
