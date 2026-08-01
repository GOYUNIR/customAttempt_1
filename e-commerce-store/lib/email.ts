import { Resend } from 'resend';

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

const from = () => process.env.RESEND_FROM || 'GOYUNIR <onboarding@resend.dev>';

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
      subject: `You're in — ${opts.product} (${opts.size})`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
          <p style="letter-spacing:3px;font-size:11px;text-transform:uppercase;color:#666">GOYUNIR</p>
          <h1 style="font-size:22px;font-weight:600">Allocation confirmed</h1>
          <p>Your card was charged for <strong>${opts.product}</strong> · ${opts.size}${opts.amountLabel ? ` (${opts.amountLabel})` : ''}.</p>
          <p>We'll ship to the address on your entry. You'll get tracking when the label is created.</p>
          <p style="color:#666;font-size:13px">Questions: reply to this email or use Manage My Entry on the site.</p>
        </div>
      `,
    });
    if (error) {
      console.error('[email] resend error', error);
      return { ok: false, error };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('[email] send failed', err);
    return { ok: false, error: err };
  }
}