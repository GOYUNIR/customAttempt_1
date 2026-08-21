/**
 * OUTBOUND WEBHOOK DISPATCHER — background delivery with exponential backoff.
 *
 * System events (`user.registered`, `license.updated`, `settings.changed`) are
 * queued and delivered to per-event subscriber URLs. Each delivery retries up
 * to `WEBHOOK_MAX_ATTEMPTS` times with exponential backoff (1s → 2s → 4s). The
 * queue is stored through the `StorageClient` abstraction so it works on any
 * backend (Upstash / Supabase / Workers-KV).
 *
 * DESIGN — ZERO-import (no `@/`) so `node --test` loads it directly. Storage +
 * fetch are both injectable; key names are passed in by callers (which resolve
 * them from `lib/redis-keys.ts`) so this module stays provider-agnostic.
 */

export const WEBHOOK_MAX_ATTEMPTS = 3;
export const WEBHOOK_BASE_DELAY_MS = 1_000;

/** The events this platform emits. */
export const WEBHOOK_EVENTS = ['user.registered', 'license.updated', 'settings.changed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Minimal storage surface the dispatcher needs (structurally compatible with
 *  `StorageClient` so any adapter satisfies it). */
export interface WebhookStorage {
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
  llen(key: string): Promise<number>;
  get(key: string): Promise<unknown>;
  set(key: string, value: string | unknown): Promise<unknown>;
}

/** Exponential backoff for a 0-based attempt index: 1s, 2s, 4s (capped at the
 *  last retry slot). */
export function backoffDelayMs(attempt: number, baseDelayMs = WEBHOOK_BASE_DELAY_MS): number {
  const n = Math.max(0, Math.min(attempt, WEBHOOK_MAX_ATTEMPTS - 1));
  return baseDelayMs * 2 ** n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DispatchResult {
  ok: boolean;
  attempts: number;
  status?: number;
}

/** Deliver a single webhook with up to `maxAttempts` retries (exponential
 *  backoff). A 2xx response succeeds; non-2xx and network errors retry. */
export async function dispatchWebhookWithRetry(input: {
  url: string;
  event: WebhookEvent;
  payload?: unknown;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<DispatchResult> {
  const maxAttempts = input.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
  const baseDelayMs = input.baseDelayMs ?? WEBHOOK_BASE_DELAY_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = JSON.stringify({
    event: input.event,
    payload: input.payload ?? {},
    sentAt: new Date().toISOString(),
  });

  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts = attempt + 1;
    try {
      const res = await fetchImpl(input.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'storefront-webhook/1.0' },
        body,
      });
      if (res.ok) return { ok: true, attempts, status: res.status };
      if (attempt < maxAttempts - 1) await sleep(backoffDelayMs(attempt, baseDelayMs));
    } catch {
      if (attempt < maxAttempts - 1) await sleep(backoffDelayMs(attempt, baseDelayMs));
    }
  }
  return { ok: false, attempts };
}

export interface EnqueuedWebhook {
  id: string;
  event: WebhookEvent;
  payload: unknown;
  queuedAt: string;
}

/** Serialize a webhook job onto the queue key (JSON lines via `rpush`). */
export function enqueueWebhook(
  storage: WebhookStorage,
  queueKey: string,
  event: WebhookEvent,
  payload?: unknown,
): Promise<number> {
  const job: EnqueuedWebhook = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    event,
    payload: payload ?? {},
    queuedAt: new Date().toISOString(),
  };
  return storage.rpush(queueKey, JSON.stringify(job));
}

/** Parse a raw queue line (safe — returns null on malformed JSON). */
export function parseWebhookJob(raw: string): EnqueuedWebhook | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EnqueuedWebhook>;
    if (!parsed || !isWebhookEvent(parsed.event)) return null;
    return {
      id: String(parsed.id || `legacy-${Math.random().toString(36).slice(2, 8)}`),
      event: parsed.event,
      payload: parsed.payload ?? {},
      queuedAt: String(parsed.queuedAt || ''),
    };
  } catch {
    return null;
  }
}

/** Flush the queue: read each job, dispatch to the event's subscriber URL with
 *  backoff, and remove it on success (or after exhausting retries — a failed
 *  job is dropped so it can never wedge the queue forever). Returns counts. */
export async function flushWebhookQueue(input: {
  storage: WebhookStorage;
  queueKey: string;
  /** Event → URL map. Events without a URL are dropped silently. */
  subscribers: Record<string, string>;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
}): Promise<{ processed: number; delivered: number; failed: number }> {
  const { storage, queueKey, subscribers, fetchImpl } = input;
  const raw = await storage.lrange(queueKey, 0, -1);
  let delivered = 0;
  let failed = 0;

  for (const rawLine of raw) {
    const job = parseWebhookJob(rawLine);
    // Malformed jobs are dropped so they can never wedge the queue forever.
    if (!job) {
      await storage.lrem(queueKey, 1, rawLine);
      continue;
    }
    const url = subscribers[job.event]?.trim();
    if (!url) {
      await storage.lrem(queueKey, 1, rawLine);
      continue;
    }
    const result = await dispatchWebhookWithRetry({
      url,
      event: job.event,
      payload: job.payload,
      maxAttempts: input.maxAttempts,
      baseDelayMs: input.baseDelayMs,
      fetchImpl,
    });
    await storage.lrem(queueKey, 1, rawLine);
    if (result.ok) delivered += 1;
    else failed += 1;
  }

  return { processed: raw.length, delivered, failed };
}
