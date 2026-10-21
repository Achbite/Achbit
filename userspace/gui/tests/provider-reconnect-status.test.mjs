import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('reconnect status spans retry wait and reconnect send, and clears when content resumes or run settles', async t => {
  const { providerRetryAttempt, ProviderRetryStatus } = await loadGuiModule(t, '/src/components/local-agent/RunFailureDetails.tsx');
  const error = { code: 'provider_transport_failed', message: 'connect timeout' };
  const fact = { providerRequestId: 'request:1', providerAttemptId: 'attempt:1', purpose: 'agent', attempt: 1, phase: 'retryWaiting', error };
  const projection = { run: { status: 'running' }, providerAttempts: [fact] };
  assert.equal(providerRetryAttempt(projection), 2);
  assert.match(renderToStaticMarkup(ProviderRetryStatus({ projection, language: 'zh-CN' })), /正在重新连接 2\/5/);
  assert.deepEqual(projection.providerAttempts[0].error, error, 'presentation never removes original diagnostics');
  projection.providerAttempts.push({ ...fact, providerAttemptId: 'attempt:2', attempt: 2, phase: 'started', error: undefined });
  assert.equal(providerRetryAttempt(projection, { phase: 'waitingResponse' }), 2);
  assert.match(renderToStaticMarkup(ProviderRetryStatus({ projection, language: 'en-US' })), /Reconnecting 2\/5/);
  for (const phase of ['reasoning', 'awaitingOutput', 'generatingOutput']) assert.equal(providerRetryAttempt(projection, { phase }), null);
  projection.providerAttempts.at(-1).phase = 'completed';
  assert.equal(providerRetryAttempt(projection), null);
  projection.providerAttempts.at(-1).phase = 'retryWaiting';
  for (const status of ['failed', 'completed', 'cancelled', 'waiting', 'finishing']) {
    projection.run.status = status;
    assert.equal(providerRetryAttempt(projection), null);
  }
  projection.run.status = 'running';
  projection.providerAttempts = [{ ...fact, phase: 'started' }];
  assert.equal(providerRetryAttempt(projection), null, 'first send is not a reconnection');
});
