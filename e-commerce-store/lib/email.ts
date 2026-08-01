import { Resend } from 'resend';

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

// IMPORTANT: 'onboarding@resend.dev' is Resend's shared SANDBOX sender —
// it only reliably delivers to your own verified test address, and
// replies to it go nowhere useful (it's not a real mailbox you own).
// Verify your own domain in the Resend dashboard, then set RESEND_FROM
// to something like "GOYUNIR <hello@yourdomain.com>" in your env vars.
const from = () => process.env.RESEND_FROM || 'GOYUNIR <onboarding@resend.dev>';
const replyTo = () => process.env.RESEND_REPLY_TO || process.env.RESEND_FROM || undefined;

export async function sendWinnerEmail(opts: { to: string; product: string; size: string; amountLabel?: string }) {
  const resend = getResend();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY missing — skip winner email');
    return { ok: false, skipped: true };
  }
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `You're in — ${opts.product} (${opts.size})`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:22px;font-weight:600;margin:0 0 12px">Allocation confirmed</h1>
          <p style="margin:0 0 12px">Your card was charged for <strong>${opts.product}</strong> · ${opts.size}${opts.amountLabel ? ` (${opts.amountLabel})` : ''}.</p>
          <p style="margin:0 0 12px">We'll ship to the address on your entry. Tracking follows when the label is created.</p>
          <p style="color:#666;font-size:13px;margin:0">Questions: reply to this email or use Manage My Entry on the site.</p>
        </div>
      `,
    });
    if (error) { console.error('[email] winner error', error); return { ok: false, error }; }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] winner failed', err);
    return { ok: false, error: err };
  }
}

export async function sendEntryRecoveryEmail(opts: { to: string; product: string; size: string; siteUrl: string; kind: 'early' | 'pre_draw' }) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  const subject = opts.kind === 'pre_draw' ? `${opts.product} — finish your entry before the draw` : `${opts.product} — finish securing your entry`;
  const body = opts.kind === 'pre_draw'
    ? `The draw for <strong>${opts.product}</strong> (${opts.size}) is coming up. You started an entry but didn't finish card setup.`
    : `You started an entry for <strong>${opts.product}</strong> (${opts.size}) but didn't finish securing it.`;
  try {
    const { data, error } = await resend.emails.send({
      from: from(), to: opts.to, replyTo: replyTo(), subject,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">One step left</h1>
          <p style="margin:0 0 12px">${body}</p>
          <p style="margin:0 0 16px">Card is saved only — charged only if selected. One entry per email.</p>
          <p style="margin:0 0 20px">
            <a href="${opts.siteUrl}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:999px;font-size:13px;font-weight:600">Continue on site</a>
          </p>
          <p style="color:#999;font-size:12px;margin:0">If you already finished, ignore this. We send at most a couple of reminders.</p>
        </div>
      `,
    });
    if (error) { console.error('[email] recovery error', error); return { ok: false, error }; }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] recovery failed', err);
    return { ok: false, error: err };
  }
}

// Sent automatically after a promo-linked winner is charged. This does NOT
// move any money — it's an invoice notification so you (or the promoter)
// know a payout is owed. Actual payment still happens outside Stripe
// (Venmo, PayPal, bank transfer) unless you build Stripe Connect payouts.
export async function sendPromoterPayoutEmail(opts: {
  to: string;
  promoterName: string;
  code: string;
  orderAmountLabel: string;
  payoutAmountLabel: string;
  payoutPercent: number;
  product: string;
  size: string;
}) {
  const resend = getResend();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY missing — skip promoter payout email');
    return { ok: false, skipped: true };
  }
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `${opts.code} — a sale just came through (${opts.payoutAmountLabel} owed)`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR — PROMO PAYOUT</p>
          <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">Hi ${opts.promoterName},</h1>
          <p style="margin:0 0 12px">Your code <strong>${opts.code}</strong> was used on an order that just cleared: <strong>${opts.product}</strong> (${opts.size}), order total <strong>${opts.orderAmountLabel}</strong>.</p>
          <p style="margin:0 0 12px">Your payout for this order (${opts.payoutPercent}%): <strong>${opts.payoutAmountLabel}</strong>.</p>
          <p style="color:#666;font-size:13px;margin:0">This is a notification, not an automatic transfer — we'll settle up separately. Reply here with any questions.</p>
        </div>
      `,
    });
    if (error) { console.error('[email] promoter payout error', error); return { ok: false, error }; }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] promoter payout failed', err);
    return { ok: false, error: err };
  }
}