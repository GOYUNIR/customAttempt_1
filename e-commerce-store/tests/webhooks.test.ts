import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backoffDelayMs,
  dispatchWebhookWithRetry,
  parseWebhookJob,
  enqueueWebhook,
  flushWebhookQueue,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_BASE_DELAY_MS,
  type WebhookStorage,
} from '../lib/webhooks.ts';

function fakeFetch(responses: Array<{ status: number; body?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200 };
    return new Response(next.body ?? '{}', { status: next.status });
  }) as typeof fetch;
  return { fn, calls };
}

test('backoffDelayMs grows exponentially: 1s, 2s, 4s (capped)', () => {
  assert.equal(backoffDelayMs(0), WEBHOOK_BASE_DELAY_MS);
  assert.equal(backoffDelayMs(1), WEBHOOK_BASE_DELAY_MS * 2);
  assert.equal(backoffDelayMs(2), WEBHOOK_BASE_DELAY_MS * 4);
  assert.equal(backoffDelayMs(5), WEBHOOK_BASE_DELAY_MS * 4); // capped at last retry slot
});

test('dispatchWebhookWithRetry succeeds on first 2xx', async () => {
  const { fn, calls } = fakeFetch([{ status: 200 }]);
  const result = await dispatchWebhookWithRetry({ url: 'https://x.co/hook', event: 'user.registered', payload: { a: 1 }, fetchImpl: fn });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.event, 'user.registered');
  assert.equal(body.payload.a, 1);
});

test('dispatchWebhookWithRetry retries non-2xx then gives up after max attempts', async () => {
  const { fn, calls } = fakeFetch([{ status: 500 }, { status: 502 }, { status: 500 }]);
  const result = await dispatchWebhookWithRetry({ url: 'https://x.co/hook', event: 'settings.changed', fetchImpl: fn, baseDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, WEBHOOK_MAX_ATTEMPTS);
  assert.equal(calls.length, WEBHOOK_MAX_ATTEMPTS);
});

test('parseWebhookJob rejects malformed lines and unknown events', () => {
  assert.equal(parseWebhookJob('not json'), null);
  assert.equal(parseWebhookJob('{"event":"bogus"}'), null);
  const job = parseWebhookJob('{"id":"a","event":"license.updated","payload":{"k":1},"queuedAt":"2026-01-01"}');
  assert.ok(job);
  assert.equal(job!.event, 'license.updated');
});

test('enqueueWebhook pushes a JSON job and flushWebhookQueue delivers + removes it', async () => {
  const queue: string[] = [];
  const storage: WebhookStorage = {
    rpush: async (_k, ...v) => { queue.push(...v); return queue.length; },
    lrange: async () => [...queue],
    lrem: async (_k, _c, value) => { const i = queue.indexOf(value); if (i >= 0) queue.splice(i, 1); return i >= 0 ? 1 : 0; },
    llen: async () => queue.length,
    get: async () => null,
    set: async () => {},
  };
  await enqueueWebhook(storage, 'q', 'user.registered', { email: 'a@b.co' });
  assert.equal(queue.length, 1);

  const { fn } = fakeFetch([{ status: 200 }]);
  const result = await flushWebhookQueue({
    storage,
    queueKey: 'q',
    subscribers: { 'user.registered': 'https://x.co/hook' },
    fetchImpl: fn,
    baseDelayMs: 1,
  });
  assert.equal(result.processed, 1);
  assert.equal(result.delivered, 1);
  assert.equal(queue.length, 0);
});
