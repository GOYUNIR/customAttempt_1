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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
