/**
 * DROP-ALERT SUBSCRIBERS (H8) — the release-announcement mailing list.
 *
 * Moved out of the `customer:waitlist` KV hash into
 * `public.alert_subscribers` (migration 00023). It is NOT
 * `public.waitlist_entries`: that table is a per-VARIANT restock queue and
 * requires a `variant_id` this data has never had. See 00023's header.
 *
 * This is a list of email addresses belonging to people who asked to hear
 * about releases. Two consequences run through the code below:
 *
 *   - A subscribe must never LOSE a source or an interest. Someone who signed
 *     up from the footer and later from a product page is one person with two
 *     sources, so both writes union rather than overwrite.
 *   - `notifiedSlugs` is what stops a subscriber being emailed twice about the
 *     same product. Losing it means spamming people who already heard.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

export type AlertSubscriber = {
  id: string;
  email: string;
  status: 'active' | 'unsubscribed';
  sources: string[];
  interests: string[];
  /** product slug -> ISO timestamp of the announcement already sent. */
  notifiedSlugs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type SubscriberRow = {
  id: string;
  email: string;
  status: string | null;
  sources: string[] | null;
  interests: string[] | null;
  notified_slugs: Record<string, string> | null;
  created_at: string;
  updated_at: string;
};

const SELECT = ['id', 'email', 'status', 'sources', 'interests', 'notified_slugs', 'created_at', 'updated_at'];

const normalizeEmail = (email: unknown): string => String(email || '').trim().toLowerCase();

const toArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];

/** Union two lists, preserving first-seen order and dropping blanks. */
const union = (a: unknown, b: unknown): string[] =>
  Array.from(new Set([...toArray(a), ...toArray(b)]));

const toSubscriber = (row: SubscriberRow): AlertSubscriber => ({
  id: row.id,
  email: row.email,
  status: row.status === 'unsubscribed' ? 'unsubscribed' : 'active',
  sources: toArray(row.sources),
  interests: toArray(row.interests),
  notifiedSlugs:
    row.notified_slugs && typeof row.notified_slugs === 'object' ? row.notified_slugs : {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** One subscriber, or null. */
export async function readSubscriber(tenantId: string, email: string): Promise<AlertSubscriber | null> {
  const normalized = normalizeEmail(email);
  if (!tenantId || !normalized) return null;
  try {
    const rows = (await getDb().select<SubscriberRow>('alert_subscribers', {
      where: { tenant_id: eq(tenantId), email: eq(normalized) },
      select: SELECT,
      limit: 1,
    })) as SubscriberRow[];
    return rows?.[0] ? toSubscriber(rows[0]) : null;
  } catch (err) {
    console.error('[alert-subscribers] read failed', normalized, (err as Error)?.message || err);
    return null;
  }
}

/** Everyone on the list, newest activity first (what the admin panel shows). */
export async function listSubscribers(tenantId: string, limit = 1000): Promise<AlertSubscriber[]> {
  if (!tenantId) return [];
  try {
    const rows = (await getDb().select<SubscriberRow>('alert_subscribers', {
      where: { tenant_id: eq(tenantId) },
      select: SELECT,
      order: { column: 'updated_at', ascending: false },
      limit,
    })) as SubscriberRow[];
    return (rows || []).map(toSubscriber);
  } catch (err) {
    console.error('[alert-subscribers] list failed', (err as Error)?.message || err);
    return [];
  }
}

export type SubscribeResult =
  | { ok: true; subscriber: AlertSubscriber; created: boolean }
  | { ok: false; reason: 'invalid' | 'error' };

/**
 * Add an address to the list, or fold a new source/interests into the record
 * that is already there.
 *
 * The unique (tenant_id, email) constraint is what makes a concurrent double
 * submit safe: the loser gets a 23505, re-reads, and merges into the winner's
 * row instead of creating a second subscription. That is the same shape as
 * lib/customers.ts's ensureCustomer, for the same reason.
 *
 * The merge itself is a read-modify-write and is NOT compare-and-swapped. That
 * is a deliberate difference from the loyalty balance: the worst case here is
 * that two simultaneous signups from two different pages record one source
 * instead of two, which costs a tag on a mailing-list row. It is not money, and
 * a CAS retry loop on every newsletter signup would buy nothing.
 */
export async function subscribe(
  tenantId: string,
  email: string,
  input: { source?: string; interests?: string[] } = {},
): Promise<SubscribeResult> {
  const normalized = normalizeEmail(email);
  if (!tenantId || !normalized) return { ok: false, reason: 'invalid' };
  const source = String(input.source || '').trim().toLowerCase();
  const interests = toArray(input.interests).slice(0, 20);

  const db = getDb();
  try {
    const existing = await readSubscriber(tenantId, normalized);
    if (existing) {
      const patch = {
        sources: union(existing.sources, source ? [source] : []),
        interests: union(existing.interests, interests),
        // Re-subscribing reactivates: someone who asks to be on the list again
        // is asking to be on the list.
        status: 'active',
      };
      const updated = (await db.update<SubscriberRow>(
        'alert_subscribers',
        { where: { tenant_id: eq(tenantId), id: eq(existing.id) } },
        patch,
      )) as SubscriberRow[];
      return {
        ok: true,
        created: false,
        subscriber: updated?.[0] ? toSubscriber(updated[0]) : { ...existing, ...patch, status: 'active' },
      };
    }

    const created = (await db.insert<SubscriberRow>('alert_subscribers', {
      tenant_id: tenantId,
      email: normalized,
      status: 'active',
      sources: source ? [source] : [],
      interests,
      notified_slugs: {},
    })) as SubscriberRow[];
    if (created?.[0]) return { ok: true, created: true, subscriber: toSubscriber(created[0]) };
    return { ok: false, reason: 'error' };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (/duplicate key|already exists|23505/i.test(message)) {
      // Lost the race on (tenant_id, email). The other writer's row is the one
      // that exists — merge into it rather than reporting a failure to someone
      // who is, in fact, now subscribed.
      const again = await readSubscriber(tenantId, normalized);
      if (again) {
        return subscribe(tenantId, normalized, input);
      }
    }
    console.error('[alert-subscribers] subscribe failed', normalized, message);
    return { ok: false, reason: 'error' };
  }
}

/** Remove an address entirely (the admin panel's "remove" action). */
export async function removeSubscriber(tenantId: string, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!tenantId || !normalized) return false;
  try {
    await getDb().remove('alert_subscribers', {
      where: { tenant_id: eq(tenantId), email: eq(normalized) },
    });
    return true;
  } catch (err) {
    console.error('[alert-subscribers] remove failed', normalized, (err as Error)?.message || err);
    return false;
  }
}

/**
 * Record that this subscriber has now been told about this product.
 *
 * Written AFTER the send succeeds, never before: the failure that matters is
 * emailing someone twice, and a mark written first would suppress a retry of a
 * send that never happened.
 */
export async function markNotified(
  tenantId: string,
  subscriber: AlertSubscriber,
  slug: string,
): Promise<boolean> {
  const key = String(slug || '').trim();
  if (!tenantId || !subscriber?.id || !key) return false;
  try {
    await getDb().update(
      'alert_subscribers',
      { where: { tenant_id: eq(tenantId), id: eq(subscriber.id) } },
      { notified_slugs: { ...subscriber.notifiedSlugs, [key]: new Date().toISOString() } },
      { returning: 'default' },
    );
    return true;
  } catch (err) {
    console.error('[alert-subscribers] notify mark failed', subscriber.email, (err as Error)?.message || err);
    return false;
  }
}
