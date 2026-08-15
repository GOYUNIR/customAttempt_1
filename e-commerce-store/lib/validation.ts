export interface EntryFormState {
  email: string;
  shippingAddress: string;
  quantity: number;
}

export function sanitizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function sanitizeAddress(value: string): string {
  return value.trim();
}

export function normalizeEntryForm(input: Partial<EntryFormState>): EntryFormState {
  return {
    email: sanitizeEmail(input.email ?? ''),
    shippingAddress: sanitizeAddress(input.shippingAddress ?? ''),
    quantity: Math.max(1, Math.min(5, Number.parseInt(String(input.quantity ?? 1), 10) || 1)),
  };
}

export function isValidEmail(value: string): boolean {
  const v = String(value ?? '').trim();
  if (!v || v.length > 254) return false;
  if (/[<>()\[\]\\,;:\s]/.test(v)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Enforce sane password bounds (min matches the signup form's 6-char rule). */
export function isValidPassword(password: unknown): boolean {
  const value = String(password ?? '');
  return value.length >= 6 && value.length <= 128;
}

/** Cap free-text metadata so oversized values can never bloat Redis keys,
 *  Stripe metadata (500-char limit) or email templates. */
export function clampLength(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** Mask an email for logs: `a***@example.com` — never the full address. */
export function maskEmail(email: unknown): string {
  const value = String(email ?? '').trim().toLowerCase();
  if (!value || !value.includes('@')) return '***';
  const [local, domain] = value.split('@');
  if (!local) return `***@${domain}`;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

/** Redact card-ish numbers (16-digit PANs / last4 runs) from a log line. */
export function redactCardNumbers(value: unknown): string {
  const text = String(value ?? '');
  return text
    .replace(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, '**** **** **** ****')
    .replace(/\b\d{4}\b(?=\s|$)/g, '****');
}
