import { Resend } from 'resend';

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

const from = () => process.env.RESEND_FROM || 'GOYUNIR <onboarding@resend.dev>';
const replyTo = () => 'goyunir.support@gmail.com';

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
    typeof opts.listPrice === 'number' &&
    opts.listPrice > 0;

  const displayPrice = opts.listPrice && opts.listPrice > 0 ? opts.listPrice : 0;
  const discountedPrice = hasDiscount && displayPrice > 0 
    ? Math.max(1, Math.round(displayPrice * (1 - (opts.discountPercent || 0) / 100)))
    : displayPrice;

  const priceHtml = displayPrice > 0 ? `
    <div style="background: #f5f5f5; padding: 12px 16px; border-radius: 8px; margin: 12px 0;">
      ${hasDiscount ? `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: #666; text-decoration: line-through;">$${displayPrice.toFixed(2)}</span>
          <span style="color: #10b981; font-weight: 700; font-size: 18px;">$${discountedPrice.toFixed(2)}</span>
          <span style="background: #10b981; color: #fff; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;">${opts.discountPercent}% OFF</span>
        </div>
        <div style="font-size: 11px; color: #666; margin-top: 4px;">Promo code: <strong>${opts.promoCode}</strong> applied</div>
      ` : `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: #666;">Price if selected:</span>
          <span style="color: #111; font-weight: 700; font-size: 18px;">$${displayPrice.toFixed(2)}</span>
        </div>
      `}
      <div style="font-size: 11px; color: #888; margin-top: 4px;">Charged only if selected in the draw</div>
    </div>
  ` : '';

  const priceLine = hasDiscount
    ? `<p style="margin:0 0 12px">Promo <strong>${opts.promoCode}</strong> · ${opts.discountPercent}% off if selected (list $${displayPrice.toFixed(2)} → $${discountedPrice.toFixed(2)}). Charged only if selected.</p>`
    : opts.promoCode
      ? `<p style="margin:0 0 12px">Promo <strong>${opts.promoCode}</strong> is on your entry. Charged only if selected.</p>`
      : displayPrice > 0
        ? `<p style="margin:0 0 12px">Your card is saved and charged <strong>$${displayPrice.toFixed(2)} only if selected</strong> in the draw.</p>`
        : `<p style="margin:0 0 12px">Your card is saved and charged <strong>only if selected</strong> in the draw.</p>`;

  const addressLine = opts.address
    ? `<p style="margin:0 0 12px;color:#444;font-size:13px">📦 Ship to: ${opts.address}</p>`
    : '';

  const manage =
    opts.siteUrl
      ? `<p style="margin:16px 0 0"><a href="${opts.siteUrl.replace(/\/$/, '')}/account" style="color:#10b981;font-weight:600;font-size:13px;text-decoration:none;">Manage My Entry →</a></p>`
      : '';

  // Generate a unique order reference
  const orderRef = `GOY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `✅ You're entered — ${opts.product} (${opts.size})`,
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <div style="text-align:center;margin-bottom:24px;">
            <div style="letter-spacing:4px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:600;">GOYUNIR</div>
            <div style="width:60px;height:3px;background:linear-gradient(90deg,#a855f7,#3b82f6);margin:8px auto 0;border-radius:4px;"></div>
          </div>
          
          <h1 style="font-size:26px;font-weight:700;margin:0 0 8px;color:#111;">🎉 You're entered!</h1>
          <p style="color:#6b7280;font-size:14px;margin:0 0 4px;">Reference: <span style="font-family:monospace;color:#111;font-weight:600;">${orderRef}</span></p>
          
          <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:16px 0;">
            <p style="margin:0;font-size:16px;font-weight:600;">${opts.product} <span style="font-weight:400;color:#6b7280;">· ${opts.size}</span></p>
          </div>
          
          ${priceHtml || priceLine}
          ${addressLine}
          
          <div style="background:#ecfdf5;border-left:4px solid #10b981;padding:12px 16px;border-radius:4px;margin:16px 0;">
            <p style="margin:0;font-size:13px;color:#065f46;">💡 Your card is saved but <strong>won't be charged</strong> unless you're selected in the allocation draw.</p>
          </div>
          
          <p style="margin:16px 0 8px;font-size:14px;color:#374151;">After the draw, check this inbox — if you're selected, you'll receive a confirmation and shipping details.</p>
          
          <div style="border-top:1px solid #e5e7eb;margin:20px 0 16px;padding-top:16px;">
            <p style="margin:0;font-size:13px;color:#6b7280;">📧 Questions? Reply to this email or contact <a href="mailto:goyunir.support@gmail.com" style="color:#3b82f6;text-decoration:none;">goyunir.support@gmail.com</a></p>
            ${manage}
          </div>
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
  promoCode?: string;
}) {
  const resend = getResend();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY missing — skip winner email');
    return { ok: false, skipped: true };
  }
  
  const orderRef = `GOY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `🎉 Selected — ${opts.product} (${opts.size})`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:22px;font-weight:600;margin:0 0 12px">🎉 You've been selected!</h1>
          <p style="margin:0 0 12px">Your card was charged for <strong>${opts.product}</strong> · ${opts.size}${opts.amountLabel ? ` (${opts.amountLabel})` : ''}.</p>
          <p style="margin:0 0 12px;color:#666;font-size:12px">Order Reference: ${orderRef}</p>
          ${opts.promoCode ? `<p style="margin:0 0 12px;color:#666;font-size:13px">Promo <strong>${opts.promoCode}</strong> applied.</p>` : ''}
          <p style="margin:0 0 12px">We'll ship to the address on your entry. Tracking follows when the label is created.</p>
          <p style="color:#666;font-size:13px;margin:0">Questions? Reply to this email or contact <a href="mailto:goyunir.support@gmail.com" style="color:#111">goyunir.support@gmail.com</a></p>
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
      ? `⏰ ${opts.product} — finish your entry before the draw`
      : `⏳ ${opts.product} — finish securing your entry`;
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
          <p style="color:#999;font-size:12px;margin:8px 0 0">Questions? <a href="mailto:goyunir.support@gmail.com" style="color:#111">goyunir.support@gmail.com</a></p>
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
  const orderRef = `GOY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `💰 Affiliate credit — ${opts.code}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">Promo credited</h1>
          <p style="margin:0 0 12px">Code <strong>${opts.code}</strong> produced a paid allocation for ${opts.product}.</p>
          <p style="margin:0 0 12px;color:#666;font-size:12px">Order Ref: ${orderRef}</p>
          <p style="margin:0 0 12px">Order ~$${(opts.amountCents / 100).toFixed(2)} · estimated credit $${(opts.payoutCents / 100).toFixed(2)}.</p>
          <p style="color:#666;font-size:13px;margin:0">Payouts are settled offline. Customer email is not shared beyond attribution.</p>
          <p style="color:#666;font-size:12px;margin:8px 0 0">Questions? <a href="mailto:goyunir.support@gmail.com" style="color:#111">goyunir.support@gmail.com</a></p>
        </div>
      `,
    });
    if (error) return { ok: false, error };
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** Sent when a customer updates their shipping address or payment method
 * from /account, or when an admin updates an order from /admin. */
export async function sendAccountUpdateEmail(opts: {
  to: string;
  product: string;
  size?: string;
  changeType: 'address' | 'payment' | 'cancelled' | 'shipping';
  newAddress?: string;
}) {
  const resend = getResend();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY missing — skip account update email');
    return { ok: false, skipped: true };
  }
  const heading =
    opts.changeType === 'address'
      ? 'Shipping address updated'
      : opts.changeType === 'payment'
        ? 'Payment method updated'
        : opts.changeType === 'shipping'
          ? 'Shipping status updated'
          : 'Entry cancelled';
  const body =
    opts.changeType === 'address'
      ? `Your shipping address for <strong>${opts.product}</strong>${opts.size ? ` (${opts.size})` : ''} was changed to:</p><p style="margin:0 0 12px;color:#444;font-size:13px">${opts.newAddress || ''}`
      : opts.changeType === 'payment'
        ? `Your payment method on file for <strong>${opts.product}</strong>${opts.size ? ` (${opts.size})` : ''} was updated.`
        : opts.changeType === 'shipping'
          ? `Your order for <strong>${opts.product}</strong>${opts.size ? ` (${opts.size})` : ''} has been updated: ${opts.newAddress || ''}`
          : `Your entry for <strong>${opts.product}</strong>${opts.size ? ` (${opts.size})` : ''} was cancelled.`;
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `📦 ${heading} — ${opts.product}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">${heading}</h1>
          <p style="margin:0 0 12px">${body}</p>
          <p style="color:#666;font-size:13px;margin:0">Didn't make this change? Reply to this email or contact <a href="mailto:goyunir.support@gmail.com" style="color:#111">goyunir.support@gmail.com</a> right away.</p>
        </div>
      `,
    });
    if (error) {
      console.error('[email] account update error', error);
      return { ok: false, error };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] account update failed', err);
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