/**
 * NOTIFICATION RETRY QUEUE — durable delivery for transactional email.
 * Pure, zero-import (see tests/notification-queue.test.ts).
 *
 * WHY THIS EXISTS (ARCHITECTURE.md SEV-3, reproduced live in the Phase D4.2
 * dry run): a raffle winner was charged real money and the winner email failed
 * with a Resend 422. The failure was caught, console.error'd, and forgotten.
 * The customer is charged and never told, and nothing anywhere records it.
 *
 * DESIGN: the charge path must never depend on a notification.
 *   - The caller attempts delivery once, inline, so the happy path is
 *     immediate. That attempt can never fail or block the charge.
 *   - On failure the job is enqueued. Retries happen out of band.
 *   - After MAX_ATTEMPTS a job moves to a DEAD-LETTER list, which a health
 *     check surfaces. "Charged but never told" becomes visible instead of
 *     silent — that, not the retrying, is the point.
 *
 * Deliberately NOT a retry loop inside the charge path: retrying there makes
 * the charge slower and can still end in silence.
 *
 * Mirrors lib/webhooks.ts's queue shape (rpush/lrange/lrem over the storage
 * adapter, exponential backoff) rather than inventing a second mechanism.
 */

export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const NOTIFICATION_BASE_DELAY_MS = 60_000;

export type NotificationKind = 'winner_email';

export function isNotificationKind(value: unknown): value is NotificationKind {
  return value === 'winner_email';
}

export interface NotificationJob {
  id: string;
  kind: NotificationKind;
  /** How many delivery attempts have already FAILED. */
  attempts: number;
  queuedAt: string;
  lastError: string;
  /** Opaque to this module — the payload the sender needs. */
  payload: Record<string, unknown>;
}

/** Minimal storage surface, structurally compatible with StorageClient. */
export interface NotificationStorage {
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
}

/** Exponential backoff on a 0-based attempt index: 1m, 2m, 4m, 8m, 16m. */
export function notificationBackoffMs(attempt: number, baseDelayMs = NOTIFICATION_BASE_DELAY_MS): number {
  const n = Math.max(0, Math.min(attempt, NOTIFICATION_MAX_ATTEMPTS - 1));
  return baseDelayMs * 2 ** n;
}

export function buildNotificationJob(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  lastError = '',
  attempts = 1,
): NotificationJob {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    attempts: Math.max(1, Math.floor(attempts) || 1),
    queuedAt: new Date().toISOString(),
    lastError: String(lastError || '').slice(0, 300),
    payload: payload || {},
  };
}

/** Parse a queue line. Returns null on anything malformed — a corrupted line
 *  must never crash a flush, it just gets dropped as undeliverable. */
export function parseNotificationJob(raw: string): NotificationJob | null {
  try {
    const p = JSON.parse(raw) as Partial<NotificationJob>;
    if (!p || !isNotificationKind(p.kind)) return null;
    if (!p.payload || typeof p.payload !== 'object') return null;
    return {
      id: String(p.id || `legacy-${Math.random().toString(36).slice(2, 8)}`),
      kind: p.kind,
      attempts: Math.max(1, Math.floor(Number(p.attempts)) || 1),
      queuedAt: String(p.queuedAt || ''),
      lastError: String(p.lastError || ''),
      payload: p.payload as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/** Has this job exhausted its attempts and belong in the dead-letter list? */
export function isExhausted(job: NotificationJob): boolean {
  return job.attempts >= NOTIFICATION_MAX_ATTEMPTS;
}

/** Is this job due for another attempt yet, given when it was queued? */
export function isDue(job: NotificationJob, nowMs: number): boolean {
  const queued = Date.parse(job.queuedAt);
  if (!Number.isFinite(queued)) return true; // unparseable timestamp: try it
  return nowMs - queued >= notificationBackoffMs(job.attempts - 1);
}

/** Enqueue a failed delivery for out-of-band retry. Never throws: a queue
 *  write failing must not propagate into the charge path that called it. */
export async function enqueueNotification(
  storage: NotificationStorage,
  queueKey: string,
  job: NotificationJob,
): Promise<boolean> {
  try {
    await storage.rpush(queueKey, JSON.stringify(job));
    return true;
  } catch {
    return false;
  }
}

export interface FlushResult {
  examined: number;
  delivered: number;
  requeued: number;
  deadLettered: number;
  skippedNotDue: number;
  dropped: number;
}

/**
 * Attempt delivery of every due job.
 *
 * `send` returns true on success. A throw is treated as a failure, never
 * propagated — one poisonous job must not stop the queue.
 *
 * Each job is removed from the queue BEFORE the attempt, then re-added with an
 * incremented count if it needs another try. Removing after a successful send
 * would leave a duplicate if the process died mid-flush; this way the worst
 * case is a lost retry rather than a repeated email.
 */
export async function flushNotifications(input: {
  storage: NotificationStorage;
  queueKey: string;
  deadLetterKey: string;
  send: (job: NotificationJob) => Promise<boolean>;
  nowMs?: number;
  limit?: number;
}): Promise<FlushResult> {
  const { storage, queueKey, deadLetterKey, send } = input;
  const nowMs = input.nowMs ?? Date.now();
  const limit = input.limit ?? 100;
  const result: FlushResult = { examined: 0, delivered: 0, requeued: 0, deadLettered: 0, skippedNotDue: 0, dropped: 0 };

  let raws: string[] = [];
  try {
    raws = (await storage.lrange(queueKey, 0, limit - 1)) || [];
  } catch {
    return result;
  }

  for (const raw of raws) {
    result.examined++;
    const job = parseNotificationJob(raw);
    if (!job) {
      await storage.lrem(queueKey, 1, raw).catch(() => 0);
      result.dropped++;
      continue;
    }
    if (!isDue(job, nowMs)) {
      result.skippedNotDue++;
      continue;
    }

    await storage.lrem(queueKey, 1, raw).catch(() => 0);

    let ok = false;
    try {
      ok = await send(job);
    } catch {
      ok = false;
    }

    if (ok) {
      result.delivered++;
      continue;
    }

    const next: NotificationJob = { ...job, attempts: job.attempts + 1, queuedAt: new Date(nowMs).toISOString() };
    if (isExhausted(next)) {
      // Dead-letter: a real person was charged and never told. This list is
      // what the health check reads, so the failure is visible rather than
      // living only in a log line nobody reads.
      await storage.rpush(deadLetterKey, JSON.stringify(next)).catch(() => 0);
      result.deadLettered++;
    } else {
      await storage.rpush(queueKey, JSON.stringify(next)).catch(() => 0);
      result.requeued++;
    }
  }

  return result;
}
