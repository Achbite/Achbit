import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderReportedFailure } from '../dist/local-agent/loopFailure.js';
import { withProviderAttempts } from '../dist/local-agent/providerAttempts.js';

for (const purpose of ['agent', 'contextCompaction', 'approvalReview']) {
  test(`cancellation while registering ${purpose} never starts a Provider stream`, async () => {
    const controller = new AbortController();
    const events = [];
    let sends = 0;
    const request = { requestId: 'request:cancel-admission', sessionId: 'session:cancel-admission',
      runId: 'run:cancel-admission', purpose };
    const deps = {
      nextId: () => 'attempt:cancel-admission',
      updateAssistantDraft() {},
      async commit(event) {
        events.push(event);
        if (event.payload.phase === 'started') controller.abort('user_cancelled');
      },
    };
    await assert.rejects(withProviderAttempts(request, deps, controller.signal, async () => {
      sends++;
      controller.signal.throwIfAborted();
    }), error => error === 'user_cancelled');
    assert.equal(sends, 0, 'cancellation admitted before dispatch must not call the Provider');
    assert.deepEqual(events.map(event => event.payload.phase), ['started', 'failed']);
    assert.equal(events[1].payload.error.code, 'provider_cancelled');
    assert.equal(events[1].payload.error.diagnostics.retryable, false);
  });
}

test('cancelling after repeated network failures interrupts the capped wait without another send', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), events = [];
  let sends = 0;
  const failure = new ProviderReportedFailure('provider_transport_failed', 'Connection reset.', {
    source: 'providerTransport', phase: 'send', category: 'network', retryable: true, causes: [],
  });
  const pending = withProviderAttempts({ requestId: 'request:long-retry', sessionId: 'session:long-retry',
    runId: 'run:long-retry', purpose: 'agent' }, {
    nextId: () => `attempt:${sends + 1}`, updateAssistantDraft() {}, async commit(event) { events.push(event); },
  }, controller.signal, async () => { sends++; throw failure; });
  const cancelled = assert.rejects(pending, error => error === 'user_cancelled');
  for (let attempt = 1; attempt <= 7; attempt++) {
    for (let n = 0; n < 100 && !(events.at(-1)?.payload.phase === 'retryWaiting' && events.at(-1).payload.attempt === attempt); n++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(events.at(-1).payload.phase, 'retryWaiting');
    assert.equal(events.at(-1).payload.attempt, attempt);
    if (attempt < 7) t.mock.timers.tick(60_000);
  }
  controller.abort('user_cancelled');
  await cancelled;
  t.mock.timers.tick(600_000);
  assert.equal(sends, 7);
});

test('a persistence failure after Provider completion never resends the completed request', async () => {
  const controller = new AbortController(), events = [];
  let sends = 0;
  const failure = new ProviderReportedFailure('provider_transport_failed', 'Journal connection reset.', {
    source: 'providerTransport', phase: 'send', category: 'network', retryable: true, causes: [],
  });
  await assert.rejects(withProviderAttempts({ requestId: 'request:completed', sessionId: 'session:completed',
    runId: 'run:completed', purpose: 'agent' }, {
    nextId: () => 'attempt:completed', updateAssistantDraft() {}, async commit(event) {
      events.push(event);
      if (event.payload.phase === 'completed') throw failure;
    },
  }, controller.signal, async (_request, completed) => { sends++; completed(); return 'Done'; }), /Journal connection reset/);
  assert.equal(sends, 1);
  assert.equal(events.some(event => event.payload.phase === 'retryWaiting'), false);
});
