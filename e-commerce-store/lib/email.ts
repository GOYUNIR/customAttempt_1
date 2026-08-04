import { Resend } from 'resend';

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

const from = () => process.env.RESEND_FROM || 'GOYUNIR <onboarding@resend.dev>';
const replyTo = () => process.env.RESEND_REPLY_TO || process.env.RESEND_FROM || undefined;

/** One confirmation when raffle entry is secured (card saved, not charged yet). */
export async function sendEntryConfirmedEmail(opts: {
  to: string;
  product: string;
  size: string;
  address?: string;
  promoCode?: string;
  discountPercent?: number;
  listPrice?: number;
  siteUrl?: string;
}) {
  const resend = getResend();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY missing — skip entry email');
    return { ok: false, skipped: true };
  }

  const hasDiscount =
    opts.promoCode &&
    typeof opts.discountPercent === 'number' &&
    opts.discountPercent > 0 &&
    typeof opts.listPrice === 'number';

  const priceLine = hasDiscount
    ? `<p style="margin:0 0 12px">Promo <strong>${opts.promoCode}</strong> · ${opts.discountPercent}% off if selected (list $${opts.listPrice}). Charged only if selected.</p>`
    : opts.promoCode
      ? `<p style="margin:0 0 12px">Promo <strong>${opts.promoCode}</strong> is on your entry. Charged only if selected.</p>`
      : `<p style="margin:0 0 12px">Your card is saved and charged <strong>only if selected</strong> in the draw.</p>`;

  const addressLine = opts.address
    ? `<p style="margin:0 0 12px;color:#444;font-size:13px">Ship to: ${opts.address}</p>`
    : '';

  const manage =
    opts.siteUrl
      ? `<p style="margin:16px 0 0"><a href="${opts.siteUrl.replace(/\/$/, '')}/account" style="color:#111;font-size:13px">Manage My Entry</a></p>`
      : '';

  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `You're entered — ${opts.product} (${opts.size})`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:22px;font-weight:600;margin:0 0 12px">You're entered</h1>
          <p style="margin:0 0 12px">You're in the allocation for <strong>${opts.product}</strong> · ${opts.size}.</p>
          ${priceLine}
          ${addressLine}
          <p style="margin:0 0 12px">After the draw, check this inbox if selected. Results are final once processing completes.</p>
          <p style="color:#666;font-size:13px;margin:0">One entry per email for this scent. Questions? Reply to this email.</p>
          ${manage}
        </div>
      `,
    });
    if (error) {
      console.error('[email] entry confirm error', error);
      return { ok: false, error };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] entry confirm failed', err);
    return { ok: false, error: err };
  }
}

export async function sendWinnerEmail(opts: {
  to: string;
  product: string;
  size: string;
  amountLabel?: string;
}) {
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
      subject: `Selected — ${opts.product} (${opts.size})`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:22px;font-weight:600;margin:0 0 12px">You've been selected</h1>
          <p style="margin:0 0 12px">Your card was charged for <strong>${opts.product}</strong> · ${opts.size}${opts.amountLabel ? ` (${opts.amountLabel})` : ''}.</p>
          <p style="margin:0 0 12px">We'll ship to the address on your entry. Tracking follows when the label is created.</p>
          <p style="color:#666;font-size:13px;margin:0">Questions: reply to this email or use Manage My Entry on the site.</p>
        </div>
      `,
    });
    if (error) {
      console.error('[email] winner error', error);
      return { ok: false, error };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] winner failed', err);
    return { ok: false, error: err };
  }
}

export async function sendEntryRecoveryEmail(opts: {
  to: string;
  product: string;
  size: string;
  siteUrl: string;
  kind: 'early' | 'pre_draw';
}) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  const subject =
    opts.kind === 'pre_draw'
      ? `${opts.product} — finish your entry before the draw`
      : `${opts.product} — finish securing your entry`;
  const body =
    opts.kind === 'pre_draw'
      ? `The draw for <strong>${opts.product}</strong> (${opts.size}) is coming up. You started an entry but didn't finish card setup.`
      : `You started an entry for <strong>${opts.product}</strong> (${opts.size}) but didn't finish securing it.`;
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject,
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
    if (error) {
      console.error('[email] recovery error', error);
      return { ok: false, error };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] recovery failed', err);
    return { ok: false, error: err };
  }
}

/** Optional: notify promoter when their code produces a charged win */
export async function sendPromoterInvoiceEmail(opts: {
  to: string;
  code: string;
  customerEmail: string;
  product: string;
  amountCents: number;
  payoutCents: number;
}) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `Affiliate credit — ${opts.code}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">Promo credited</h1>
          <p style="margin:0 0 12px">Code <strong>${opts.code}</strong> produced a paid allocation for ${opts.product}.</p>
          <p style="margin:0 0 12px">Order ~$${(opts.amountCents / 100).toFixed(2)} · estimated credit $${(opts.payoutCents / 100).toFixed(2)}.</p>
          <p style="color:#666;font-size:13px;margin:0">Payouts are settled offline. Customer email is not shared beyond attribution.</p>
        </div>
      `,
    });
    if (error) return { ok: false, error };
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: err };
  }
}


/** Alias used by trigger-drop */
export async function sendPromoterPayoutEmail(opts: {
  to: string;
  code?: string;
  promoterName?: string;
  customerEmail?: string;
  product: string;
  size?: string;
  amountCents?: number;
  payoutCents?: number;
  revenue?: number;
  orderAmountLabel?: string;
  payoutAmountLabel?: string;
  payoutPercent?: number;
}) {
  let amountCents = opts.amountCents || 0;
  let payoutCents = opts.payoutCents || 0;
  if (!amountCents && opts.orderAmountLabel) {
    const n = Number(String(opts.orderAmountLabel).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n)) amountCents = Math.round(n * 100);
  }
  if (!payoutCents && opts.payoutAmountLabel) {
    const n = Number(String(opts.payoutAmountLabel).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n)) payoutCents = Math.round(n * 100);
  }
  return sendPromoterInvoiceEmail({
    to: opts.to,
    code: opts.code || 'PROMO',
    customerEmail: opts.customerEmail || '',
    product: opts.size ? `${opts.product} (${opts.size})` : opts.product,
    amountCents,
    payoutCents,
  });
}
