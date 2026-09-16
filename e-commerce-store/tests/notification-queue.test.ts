import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTIFICATION_MAX_ATTEMPTS,
  buildNotificationJob,
  enqueueNotification,
  flushNotifications,
  isDue,
  isExhausted,
  notificationBackoffMs,
  parseNotificationJob,
  type NotificationJob,
  type NotificationStorage,
} from '../lib/notification-queue.ts';

/** In-memory storage standing in for the Redis/KV adapter. */
function memStore(seed: Record<string, string[]> = {}) {
  const lists: Record<string, string[]> = { ...seed };
  const store: NotificationStorage & { lists: Record<string, string[]> } = {
    lists,
    async rpush(key, ...values) {
      lists[key] = lists[key] || [];
      lists[key].push(...values);
      return lists[key].length;
    },
    async lrange(key, start, stop) {
      return (lists[key] || []).slice(start, stop + 1);
    },
    async lrem(key, _count, value) {
      const arr = lists[key] || [];
      const i = arr.indexOf(value);
      if (i >= 0) arr.splice(i, 1);
      return i >= 0 ? 1 : 0;
    },
  };
  return store;
}

const QUEUE = 'notify:queue';
const DEAD = 'notify:dead';
const payload = { to: 'winner@example.com', product: 'Item', size: 'M' };

test('backoff grows exponentially and is capped', () => {
  assert.equal(notificationBackoffMs(0, 1000), 1000);
  assert.equal(notificationBackoffMs(1, 1000), 2000);
  assert.equal(notificationBackoffMs(2, 1000), 4000);
  assert.equal(notificationBackoffMs(99, 1000), 1000 * 2 ** (NOTIFICATION_MAX_ATTEMPTS - 1));
});

test('parseNotificationJob rejects malformed lines instead of throwing', () => {
  assert.equal(parseNotificationJob('not json'), null);
  assert.equal(parseNotificationJob('{"kind":"unknown_kind","payload":{}}'), null);
  assert.equal(parseNotificationJob('{"kind":"winner_email"}'), null);
  const ok = parseNotificationJob(JSON.stringify(buildNotificationJob('winner_email', payload)));
  assert.equal(ok?.kind, 'winner_email');
});

test('enqueueNotification never throws, even when storage fails', async () => {
  const broken: NotificationStorage = {
    async rpush() { throw new Error('redis down'); },
    async lrange() { return []; },
    async lrem() { return 0; },
  };
  // The charge already happened. A queue write failing must not propagate.
  assert.equal(await enqueueNotification(broken, QUEUE, buildNotificationJob('winner_email', payload)), false);
});

test('THE BUG: a failed send is retried rather than lost', async () => {
  const store = memStore();
  await enqueueNotification(store, QUEUE, buildNotificationJob('winner_email', payload, 'Resend 422'));
  const r = await flushNotifications({
    storage: store, queueKey: QUEUE, deadLetterKey: DEAD,
    send: async () => false,
    nowMs: Date.now() + 3_600_000,
  });
  assert.equal(r.delivered, 0);
  assert.equal(r.requeued, 1, 'the job must still exist for another attempt');
  assert.equal(store.lists[QUEUE].length, 1);
  assert.equal(parseNotificationJob(store.lists[QUEUE][0])?.attempts, 2);
});

test('a successful retry delivers and leaves the queue empty', async () => {
  const store = memStore();
  await enqueueNotification(store, QUEUE, buildNotificationJob('winner_email', payload));
  const r = await flushNotifications({
    storage: store, queueKey: QUEUE, deadLetterKey: DEAD,
    send: async () => true,
    nowMs: Date.now() + 3_600_000,
  });
  assert.equal(r.delivered, 1);
  assert.equal((store.lists[QUEUE] || []).length, 0);
  assert.equal((store.lists[DEAD] || []).length, 0, 'a delivered job must never be dead-lettered');
});

test('THE POINT: exhausting attempts dead-letters instead of vanishing', async () => {
  const store = memStore();
  await enqueueNotification(store, QUEUE, buildNotificationJob('winner_email', payload, 'Resend 422'));
  let flushes = 0;
  for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS + 2; i++) {
    await flushNotifications({
      storage: store, queueKey: QUEUE, deadLetterKey: DEAD,
      send: async () => false,
      nowMs: Date.now() + 86_400_000 * (i + 1),
    });
    flushes++;
  }
  assert.equal((store.lists[QUEUE] || []).length, 0, 'queue drains');
  assert.equal((store.lists[DEAD] || []).length, 1, 'the charged-but-untold customer is RECORDED');
  const dead = parseNotificationJob(store.lists[DEAD][0]);
  assert.equal(dead?.attempts, NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(dead?.payload.to, 'winner@example.com');
  assert.ok(flushes > 0);
});

test('a job that is not due yet is left alone', async () => {
  const store = memStore();
  await enqueueNotification(store, QUEUE, buildNotificationJob('winner_email', payload));
  const r = await flushNotifications({
    storage: store, queueKey: QUEUE, deadLetterKey: DEAD,
    send: async () => { throw new Error('send must not be called'); },
    nowMs: Date.now(), // immediately — backoff has not elapsed
  });
  assert.equal(r.skippedNotDue, 1);
  assert.equal(r.delivered, 0);
  assert.equal(store.lists[QUEUE].length, 1);
});

test('a throwing sender does not stop the queue or lose the job', async () => {
  const store = memStore();
  await enqueueNotification(store, QUEUE, buildNotificationJob('winner_email', { to: 'a@x.com' }));
  await enqueueNotification(store, QUEUE, buildNotificationJob('winner_email', { to: 'b@x.com' }));
  let calls = 0;
  const r = await flushNotifications({
    storage: store, queueKey: QUEUE, deadLetterKey: DEAD,
    send: async () => { calls++; throw new Error('provider exploded'); },
    nowMs: Date.now() + 3_600_000,
  });
  assert.equal(calls, 2, 'the second job is still attempted after the first throws');
  assert.equal(r.requeued, 2);
});

test('a corrupted queue line is dropped, not left to poison every flush', async () => {
  const store = memStore({ [QUEUE]: ['{{{garbage'] });
  const r = await flushNotifications({
    storage: store, queueKey: QUEUE, deadLetterKey: DEAD,
    send: async () => true,
    nowMs: Date.now(),
  });
  assert.equal(r.dropped, 1);
  assert.equal((store.lists[QUEUE] || []).length, 0);
});

test('isExhausted / isDue boundaries', () => {
  const fresh = buildNotificationJob('winner_email', payload);
  assert.equal(isExhausted(fresh), false);
  assert.equal(isExhausted({ ...fresh, attempts: NOTIFICATION_MAX_ATTEMPTS } as NotificationJob), true);
  assert.equal(isDue({ ...fresh, queuedAt: 'nonsense' } as NotificationJob, Date.now()), true);
});
