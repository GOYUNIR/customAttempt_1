import { Resend } from 'resend';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

/** Brand name used inside transactional emails. Falls back to the environment
 * (BRAND_NAME / NEXT_PUBLIC_SITE_NAME) and then GOYUNIR so template buyers can
 * rename the brand without touching email markup. */
function emailBrandName(): string {
  return process.env.BRAND_NAME || process.env.NEXT_PUBLIC_SITE_NAME || 'GOYUNIR';
}

const from = () => process.env.RESEND_FROM || `${emailBrandName()} <onboarding@resend.dev>`;
const replyTo = () => process.env.REPLY_TO_EMAIL || process.env.SUPPORT_EMAIL || 'goyunir.support@gmail.com';

/** One confirmation when raffle entry is secured (card saved, not charged yet). */
export async function sendEntryConfirmedEmail(opts: {
  to: string;
  product: string;
  size: string;
  address?: string;
  promoCode?: string;
  discountPercent?: number;
  listPrice?: number;
  orderRef?: string;
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

  const orderRef = formatOrderRef(opts.orderRef || '') || buildOrderRef(opts.to, opts.product, opts.size);

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
          
          <div style="background:#f5f3ff;border:1px solid #ede9fe;border-radius:12px;padding:14px 16px;margin:16px 0;">
            <p style="margin:0 0 6px;font-size:13px;color:#4c1d95;font-weight:600;">🎁 Points &amp; rewards</p>
            <p style="margin:0 0 8px;font-size:13px;color:#6d28d9;">Create a free account to redeem your points and track this entry.</p>
            <a href="${(opts.siteUrl || '').replace(/\/$/, '') || 'https://goyunir.com'}/auth/signup" style="display:inline-block;padding:9px 18px;background:#6d28d9;color:#fff;border-radius:999px;font-weight:600;font-size:13px;text-decoration:none;">Create account to redeem</a>
          </div>
          
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

// ... keep existing imports and helper functions ...

export async function sendWinnerEmail(opts: {
  to: string;
  product: string;
  size: string;
  amountLabel?: string;
  promoCode?: string;
  shippingAddress?: string;
  orderRef?: string;
  siteUrl?: string;
  originalPrice?: string;
  discountPercent?: number;
}) {
  const resend = getResend();
  if (!resend) {
    console.warn('[email] RESEND_API_KEY missing — skip winner email');
    return { ok: false, skipped: true };
  }
  
  const orderRef = formatOrderRef(opts.orderRef || '') || buildOrderRef(opts.to, opts.product, opts.size);
  const hasDiscount = opts.discountPercent && opts.discountPercent > 0 && opts.originalPrice;
  
  const manageLink = opts.siteUrl ? `
    <div style="margin:16px 0;text-align:center;">
      <a href="${opts.siteUrl.replace(/\/$/, '')}/account" style="display:inline-block;padding:12px 28px;background:#10b981;color:#fff;border-radius:999px;font-weight:600;font-size:14px;text-decoration:none;">Manage My Entry →</a>
    </div>
  ` : '';
  
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `🎉 Selected — ${opts.product} (${opts.size})`,
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <div style="text-align:center;margin-bottom:24px;">
            <div style="letter-spacing:4px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:600;">GOYUNIR</div>
            <div style="width:60px;height:3px;background:linear-gradient(90deg,#a855f7,#3b82f6);margin:8px auto 0;border-radius:4px;"></div>
          </div>
          
          <h1 style="font-size:26px;font-weight:700;margin:0 0 8px;color:#111;">🎉 You've been selected!</h1>
          <p style="color:#6b7280;font-size:14px;margin:0 0 4px;">Order Reference: <span style="font-family:monospace;color:#111;font-weight:600;">${orderRef}</span></p>
          
          <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:16px 0;">
            <p style="margin:0;font-size:16px;font-weight:600;">${opts.product} <span style="font-weight:400;color:#6b7280;">· ${opts.size}</span></p>
          </div>
          
          <div style="background:#f0fdf4;border-radius:8px;padding:12px 16px;margin:12px 0;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="color:#666;">Amount Charged:</span>
              ${hasDiscount ? `
                <div style="text-align:right;">
                  <span style="color:#666;text-decoration:line-through;font-size:13px;">$${opts.originalPrice}</span>
                  <span style="color:#10b981;font-weight:700;font-size:20px;margin-left:8px;">${opts.amountLabel}</span>
                  <span style="background:#10b981;color:#fff;padding:2px 10px;border-radius:12px;font-size:10px;font-weight:600;margin-left:8px;">${opts.discountPercent}% OFF</span>
                </div>
              ` : `
                <span style="font-weight:700;font-size:20px;color:#111;">${opts.amountLabel}</span>
              `}
            </div>
            ${opts.promoCode ? `<div style="font-size:12px;color:#10b981;margin-top:4px;">🏷 Promo code: ${opts.promoCode} applied</div>` : ''}
          </div>
          
          ${opts.shippingAddress ? `
            <div style="background:#f9fafb;border-radius:8px;padding:12px 16px;margin:12px 0;">
              <p style="margin:0;font-size:13px;color:#6b7280;">📦 Shipping to:</p>
              <p style="margin:4px 0 0;font-size:14px;font-weight:500;">${opts.shippingAddress}</p>
            </div>
          ` : ''}
          
          <p style="margin:16px 0 8px;font-size:14px;color:#374151;">We'll ship to the address on your entry. Tracking information will follow when the label is created.</p>
          
          ${manageLink}
          
          <div style="border-top:1px solid #e5e7eb;margin:20px 0 16px;padding-top:16px;">
            <p style="margin:0;font-size:13px;color:#6b7280;">📧 Questions? Reply to this email or contact <a href="mailto:goyunir.support@gmail.com" style="color:#3b82f6;text-decoration:none;">goyunir.support@gmail.com</a></p>
          </div>
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

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
}) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: 'Reset your GOYUNIR password',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <p style="letter-spacing:4px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:700;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:24px;font-weight:700;margin:0 0 10px">Reset your password</h1>
          <p style="margin:0 0 14px;color:#4b5563">Use the link below to set a new password for your account.</p>
          <p style="margin:0 0 20px"><a href="${opts.resetUrl}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px">Reset password</a></p>
          <p style="color:#6b7280;font-size:13px;margin:0">If you did not request this, you can ignore this message.</p>
        </div>
      `,
    });
    if (error) return { ok: false, error };
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function sendWaitlistConfirmationEmail(opts: { to: string }) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: 'You are on the GOYUNIR release list',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <p style="letter-spacing:4px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:700;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:24px;font-weight:700;margin:0 0 10px">You’re in.</h1>
          <p style="margin:0 0 12px;color:#4b5563">You will be first to know when the next release opens or a new product goes live.</p>
          <p style="margin:0;color:#6b7280;font-size:13px">This list is managed directly by the brand team from the admin portal.</p>
        </div>
      `,
    });
    if (error) return { ok: false, error };
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function sendReleaseAnnouncementEmail(opts: {
  to: string;
  productName: string;
  slug: string;
  tagline?: string;
}) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://goyunir.com';
  const productUrl = siteUrl ? `${siteUrl.replace(/\/$/, '')}/${opts.slug}` : `/${opts.slug}`;
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `Now live — ${opts.productName}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <p style="letter-spacing:4px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:700;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:24px;font-weight:700;margin:0 0 8px">${opts.productName} is now live.</h1>
          <p style="margin:0 0 14px;color:#4b5563">${opts.tagline || 'Limited release access is now open.'}</p>
          <p style="margin:0 0 20px"><a href="${productUrl}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px">Open release</a></p>
          <p style="margin:0;color:#6b7280;font-size:13px">You are receiving this because you joined the private release list.</p>
        </div>
      `,
    });
    if (error) return { ok: false, error };
    return { ok: true, id: data?.id };
  } catch (err) {
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
  const orderRef = buildOrderRef(opts.customerEmail, opts.product, 'promo');
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

export async function sendDeliveryIncentiveEmail(opts: {
  to: string;
  product: string;
  size?: string;
  code: string;
  creditAmountCents: number;
  minimumOrderSubtotalCents?: number;
  eligibleProductSlugs?: string[];
  eligibleSizes?: string[];
}) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  const eligibleProducts = Array.isArray(opts.eligibleProductSlugs) ? opts.eligibleProductSlugs.join(', ') : '';
  const eligibleSizes = Array.isArray(opts.eligibleSizes) ? opts.eligibleSizes.join(', ') : '';
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `Your GOYUNIR delivery credit is ready`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.55">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666;margin:0 0 16px">GOYUNIR</p>
          <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">Your delivery credit is unlocked.</h1>
          <p style="margin:0 0 12px">Thanks for receiving <strong>${opts.product}</strong>${opts.size ? ` (${opts.size})` : ''}. Your private follow-up credit is now active.</p>
          <div style="margin:0 0 18px;padding:14px 16px;border-radius:18px;background:#111;color:#fff;display:inline-block;font-weight:700;letter-spacing:1px">${opts.code}</div>
          <p style="margin:0 0 8px">Credit: <strong>$${(opts.creditAmountCents / 100).toFixed(2)}</strong></p>
          ${opts.minimumOrderSubtotalCents ? `<p style="margin:0 0 8px">Minimum order: <strong>$${(opts.minimumOrderSubtotalCents / 100).toFixed(2)}</strong></p>` : ''}
          ${eligibleProducts ? `<p style="margin:0 0 8px">Eligible release(s): <strong>${eligibleProducts}</strong></p>` : ''}
          ${eligibleSizes ? `<p style="margin:0 0 14px">Eligible size(s): <strong>${eligibleSizes}</strong></p>` : ''}
          <p style="margin:0 0 14px;color:#4b5563">This code is linked to your email, limited to one use, and cannot be transferred or stacked.</p>
          <p style="margin:0 0 14px;color:#4b5563">Create a free account to redeem this credit and track your orders: <a href="https://goyunir.com/auth/signup" style="color:#111;font-weight:600">Create account</a></p>
          <p style="margin:0;color:#666;font-size:13px">Questions? <a href="mailto:goyunir.support@gmail.com" style="color:#111">goyunir.support@gmail.com</a></p>
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

/** Sent right after account creation — welcome points + one-time 10% code. */
export async function sendWelcomeEmail(opts: {
  to: string;
  points: number;
  promoCode: string;
  discountPercent: number;
  siteUrl?: string;
}) {
  const resend = getResend();
  if (!resend) return { ok: false, skipped: true };
  const brand = emailBrandName();
  const siteUrl = String(opts.siteUrl || process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  try {
    const { data, error } = await resend.emails.send({
      from: from(),
      to: opts.to,
      replyTo: replyTo(),
      subject: `Welcome to ${brand} — your member credit is ready`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <p style="letter-spacing:4px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:700;margin:0 0 16px">${brand}</p>
          <h1 style="font-size:24px;font-weight:700;margin:0 0 10px">Welcome to the club.</h1>
          <p style="margin:0 0 14px;color:#4b5563">Your account is live. Here is what membership unlocked:</p>
          <div style="background:#f9fafb;border-radius:12px;padding:14px 16px;margin:0 0 14px;">
            <p style="margin:0 0 6px;font-size:13px;color:#111;"><strong>⭐ ${opts.points} welcome points</strong> — already added to your account.</p>
            <p style="margin:0;font-size:13px;color:#111;"><strong>🏷 ${opts.discountPercent}% off your first release</strong> — apply the one-time code below at checkout.</p>
          </div>
          <div style="margin:0 0 18px;padding:14px 16px;border-radius:18px;background:#111;color:#fff;display:inline-block;font-weight:700;letter-spacing:1px;font-size:15px;">${opts.promoCode}</div>
          <p style="margin:0 0 12px;color:#4b5563">This code is linked to your email, limited to one use, and applies automatically on your first qualifying release.</p>
          ${siteUrl ? `<p style="margin:0 0 20px"><a href="${siteUrl}/account" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px">Open my account</a></p>` : ''}
          <p style="margin:0;color:#6b7280;font-size:13px">Questions? <a href="mailto:goyunir.support@gmail.com" style="color:#111">goyunir.support@gmail.com</a></p>
        </div>
      `,
    });
    if (error) {
      console.error('[email] welcome error', error);
      return { ok: false, error };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] welcome failed', err);
    return { ok: false, error: err };
  }
}
