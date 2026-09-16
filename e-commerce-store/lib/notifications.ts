/**
 * NOTIFICATION DELIVERY — the charge path's interface to email.
 *
 * ARCHITECTURE.md SEV-3, reproduced live in the Phase D4.2 dry run: a winner
 * was charged and the email failed with a Resend 422. Nothing recorded it.
 *
 * The precise shape of that bug matters: sendWinnerEmail RETURNS
 * `{ ok: false, error }` rather than throwing, so the call sites' try/catch
 * never fired and the return value was discarded. A silent failure, not even
 * an unhandled one.
 *
 * deliverWinnerEmail is the only thing charge paths should call:
 *   - attempts delivery once, inline, so the happy path stays immediate
 *     (the cron that flushes retries runs DAILY — waiting for it would mean a
 *     winner learns they won up to 24 hours late)
 *   - on failure, enqueues for out-of-band retry
 *   - NEVER throws, so a notification can never affect a charge
 */
import { createRedisClient } from '@/lib/server-config';
import { sendWinnerEmail } from '@/lib/email';
import { NOTIFICATION_QUEUE_KEY, NOTIFICATION_DEAD_LETTER_KEY } from '@/lib/redis-keys';
import {
  buildNotificationJob,
  enqueueNotification,
  flushNotifications,
  parseNotificationJob,
  type FlushResult,
  type NotificationJob,
  type NotificationStorage,
} from '@/lib/notification-queue';

type WinnerEmailOpts = Parameters<typeof sendWinnerEmail>[0];

function storage(): NotificationStorage | null {
  return createRedisClient() as unknown as NotificationStorage | null;
}

/**
 * Deliver a winner email. Attempts once inline; queues for retry on failure.
 * Never throws — callers are in the middle of a charge.
 */
export async function deliverWinnerEmail(opts: WinnerEmailOpts): Promise<void> {
  let failure = '';
  try {
    const result = await sendWinnerEmail(opts);
    if (result?.ok) return;
    failure = typeof result?.error === 'string' ? result.error : JSON.stringify(result?.error ?? 'unknown');
  } catch (err) {
    failure = (err as Error)?.message || String(err);
  }

  const store = storage();
  if (!store) {
    console.error('[notifications] winner email failed AND no storage to queue it', { to: opts.to, failure });
    return;
  }
  const queued = await enqueueNotification(
    store,
    NOTIFICATION_QUEUE_KEY,
    buildNotificationJob('winner_email', opts as unknown as Record<string, unknown>, failure),
  );
  if (!queued) {
    console.error('[notifications] winner email failed AND could not be queued', { to: opts.to, failure });
  }
}

/** Retry queued notifications. Called from the cron routes. */
export async function flushWinnerNotifications(limit = 100): Promise<FlushResult> {
  const store = storage();
  const empty: FlushResult = { examined: 0, delivered: 0, requeued: 0, deadLettered: 0, skippedNotDue: 0, dropped: 0 };
  if (!store) return empty;
  return flushNotifications({
    storage: store,
    queueKey: NOTIFICATION_QUEUE_KEY,
    deadLetterKey: NOTIFICATION_DEAD_LETTER_KEY,
    limit,
    send: async (job: NotificationJob) => {
      const result = await sendWinnerEmail(job.payload as unknown as WinnerEmailOpts);
      return Boolean(result?.ok);
    },
  });
}

/** Dead-lettered notifications — customers charged but never told. */
export async function readDeadLetteredNotifications(limit = 50): Promise<NotificationJob[]> {
  const store = storage();
  if (!store) return [];
  try {
    const raws = (await store.lrange(NOTIFICATION_DEAD_LETTER_KEY, 0, limit - 1)) || [];
    return raws.map(parseNotificationJob).filter((j): j is NotificationJob => j !== null);
  } catch {
    return [];
  }
}
