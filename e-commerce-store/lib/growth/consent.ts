/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPLIANCE GATE — may we send this, to this person, right now?
 *
 * Every Growth module send passes through `canSend`. It is a gate, not a
 * helper: a module that cannot demonstrate consent for a contact must not send,
 * and that is enforced in one place rather than remembered in each handler.
 *
 * TRANSACTIONAL vs MARKETING is the distinction that does the work, and it is
 * not cosmetic:
 *
 *   TRANSACTIONAL  concerns something the person already did — an order they
 *                  placed, a draw they entered, a payment that failed. Under
 *                  CAN-SPAM this is not a commercial message, and gating it
 *                  behind a marketing opt-in would WITHHOLD a notice the
 *                  customer needs. A declined-payment notice is the clearest
 *                  case: refusing to send it because they never ticked a
 *                  marketing box serves nobody.
 *   MARKETING      is anything else, and requires an explicit opt-in plus
 *                  quiet hours and a frequency cap.
 *
 * `customers.email_opt_in` is the record (migration 00022), where NULL means
 * "never asked" and is deliberately distinguishable from false. NULL does NOT
 * pass a marketing check — an unanswered question is not a yes.
 *
 * WHAT IS DELIBERATELY NOT HERE, and needs counsel before any SMS ships: TCPA
 * carries statutory damages of roughly $500-$1,500 PER MESSAGE, and the
 * written-consent standard for marketing SMS is stricter than anything below.
 * No SMS channel is enabled (lib/growth/registry.ts refuses it), and the
 * consent shape for it should be reviewed by a lawyer before it stores a row,
 * not after.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { getDb } from '@/lib/db/client';
import { eq, gte } from '@/lib/db/query';
import { readProfile } from '@/lib/customer-profile';
import type { ConsentChannel, GrowthModule } from '@/lib/growth/registry';
import { isWithinQuietHours } from '@/lib/growth/quiet-hours';

export type SendDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'no_consent' | 'quiet_hours' | 'frequency_cap' | 'daily_cap' | 'no_contact' | 'error';
      detail: string;
      /** When the send could be retried, for reasons that are about timing. */
      retryAfter?: string;
    };

/**
 * Consent given by joining a list, rather than by ticking the box on an account.
 *
 * SOME AUDIENCES ARE NOT CUSTOMERS. Someone who submits "tell me when this is
 * back" from a product page has consented explicitly and in writing — they just
 * have no `customers` row, because they have never bought anything. Reading
 * only `customers.email_opt_in` refuses those people, which is not a stricter
 * privacy posture: it is looking in the wrong drawer and calling the silence a
 * no. Back-in-stock could not reach a single one of its own subscribers until
 * this existed.
 *
 * It is EVIDENCE, not an assertion. The caller hands over the stored row's own
 * status and timestamp and the gate judges them; a handler cannot simply claim
 * the person opted in. See `validListConsent`.
 */
export type ListConsent = {
  /** The table the consent is recorded in, e.g. 'alert_subscribers'. */
  source: string;
  status: 'active' | 'unsubscribed';
  /** When the person joined. An undatable consent is not a consent. */
  recordedAt: string;
};

export type SendContext = {
  tenantId: string;
  module: GrowthModule;
  email: string;
  /** IANA zone for quiet hours. Falls back to the store's own when unknown. */
  timezone?: string | null;
  now?: Date;
  /** Consent held somewhere other than the customer record. See ListConsent. */
  listConsent?: ListConsent | null;
};

/** Whether a list record is real consent, or just a row somebody passed in. */
function validListConsent(consent: ListConsent | null | undefined): boolean {
  if (!consent || consent.status !== 'active') return false;
  if (!String(consent.source || '').trim()) return false;
  return Number.isFinite(Date.parse(String(consent.recordedAt || '')));
}

const isMarketing = (channels: ConsentChannel[]): boolean =>
  channels.includes('email_marketing') || channels.includes('sms_marketing');

/**
 * The single gate. Returns a reason on refusal so the caller can log something
 * actionable rather than "send skipped".
 *
 * Fails CLOSED on an error. Everywhere else in this codebase an outage degrades
 * toward doing the work anyway; here it must not. Sending without being able to
 * confirm consent is the failure that carries statutory damages, and "the
 * consent lookup was down" is not a defence.
 */
export async function canSend(ctx: SendContext): Promise<SendDecision> {
  const email = String(ctx.email || '').trim().toLowerCase();
  if (!email) {
    return { allowed: false, reason: 'no_contact', detail: 'No email address.' };
  }

  const marketing = isMarketing(ctx.module.requires.consent);
  const now = ctx.now || new Date();

  try {
    // ── 1. consent ────────────────────────────────────────────────────────
    if (marketing) {
      const profile = await readProfile(ctx.tenantId, email);

      // A DECLINE OUTRANKS EVERYTHING. Someone who has unticked the box on
      // their account has said no, and a mailing-list row signed up before that
      // must not resurrect them. Checked first, deliberately: the ordering is
      // the whole safety property.
      if (profile?.emailOptIn === false) {
        return {
          allowed: false,
          reason: 'no_consent',
          detail: 'Marketing consent for ' + email + ' is declined on their customer record.',
        };
      }

      // NULL is "never asked". An unanswered question is not a yes — but a list
      // they explicitly joined is one, even without a customer record.
      const optedIn = profile?.emailOptIn === true;
      const onList = validListConsent(ctx.listConsent);
      if (!optedIn && !onList) {
        return {
          allowed: false,
          reason: 'no_consent',
          detail: profile
            ? 'Marketing consent for ' + email + ' was NEVER ASKED, and they are on no relevant list.'
            : 'No customer record and no list membership, so no marketing consent can be demonstrated for ' + email + '.',
        };
      }
    }

    // ── 2. quiet hours (marketing only) ───────────────────────────────────
    if (ctx.module.compliance.quietHours) {
      const quiet = isWithinQuietHours(now, ctx.timezone || null);
      if (quiet.quiet) {
        return {
          allowed: false,
          reason: 'quiet_hours',
          detail: 'Local time is ' + quiet.localHour + ':00 in ' + quiet.zone + ' — inside quiet hours.',
          retryAfter: quiet.nextAllowedIso ?? undefined,
        };
      }
    }

    // ── 3. frequency cap, per contact, rolling 7 days ─────────────────────
    const capWindowStart = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const recent = (await getDb().select<{ id: string }>('usage_events', {
      where: {
        tenant_id: eq(ctx.tenantId),
        module_id: eq(ctx.module.id),
        reference: eq('contact:' + email),
        occurred_at: gte(capWindowStart),
      },
      select: ['id'],
      limit: 100,
    })) as Array<{ id: string }>;

    if (recent.length >= ctx.module.compliance.frequencyCap) {
      return {
        allowed: false,
        reason: 'frequency_cap',
        detail:
          email + ' has had ' + recent.length + ' ' + ctx.module.id +
          ' messages in the last 7 days (cap ' + ctx.module.compliance.frequencyCap + ').',
      };
    }

    return { allowed: true };
  } catch (err) {
    // Fails closed. See the function doc.
    return {
      allowed: false,
      reason: 'error',
      detail:
        'Consent could not be confirmed for ' + email + ', so nothing was sent: ' +
        ((err as Error)?.message || String(err)),
    };
  }
}

/**
 * Whether this tenant has room under the module's daily cap.
 *
 * Separate from `canSend` because it is about US, not the recipient — it is the
 * budget valve, checked once per batch rather than once per contact.
 */
export async function withinDailyCap(
  tenantId: string,
  module: GrowthModule,
  override?: number | null,
): Promise<{ within: boolean; usedToday: number; cap: number }> {
  const cap = Math.max(0, Math.floor(Number(override ?? module.caps.perTenantPerDay)));
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  try {
    const rows = (await getDb().select<{ quantity: number | string }>('usage_events', {
      where: {
        tenant_id: eq(tenantId),
        module_id: eq(module.id),
        occurred_at: gte(dayStart.toISOString()),
      },
      select: ['quantity'],
      limit: 5000,
    })) as Array<{ quantity: number | string }>;
    const usedToday = rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    return { within: usedToday < cap, usedToday, cap };
  } catch (err) {
    console.error('[growth-consent] daily cap check failed', (err as Error)?.message || err);
    // Fails closed here too: an uncheckable cap is not an absent one.
    return { within: false, usedToday: -1, cap };
  }
}
