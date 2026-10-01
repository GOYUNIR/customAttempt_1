/**
 * CUSTOM DOMAIN RULES (STORE-ADDRESSES.md §B). Pure, so they are tested
 * directly: which hostnames a store may connect, the two DNS records it must
 * add, and the plan cap.
 */

export type HostnameCheck =
  | { ok: true; hostname: string }
  | { ok: false; hostname: string; reason: string; suggestion?: string };

/** "HTTPS://Shop.Example.com:443/path" → "shop.example.com". */
export function normalizeHostname(raw: string): string {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  h = h.replace(/:\d+$/, '').replace(/\.+$/, '');
  return h;
}

/**
 * platformRoots: the platform's own domains (the root and any old roots).
 * Neither they nor anything under them may be connected: those are ours.
 */
export function checkHostname(raw: string, ctx: { platformRoots: string[] }): HostnameCheck {
  const hostname = normalizeHostname(raw);
  if (!hostname) return { ok: false, hostname, reason: 'Enter your domain, like www.yourstore.com.' };
  if (hostname.length > 253) return { ok: false, hostname, reason: 'That domain is too long.' };
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) {
    return { ok: false, hostname, reason: 'That is not a valid domain name.' };
  }
  if (labels.every((l) => /^\d+$/.test(l))) return { ok: false, hostname, reason: 'Use a domain name, not an IP address.' };
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, hostname, reason: 'That is not a valid domain name.' };
  for (const root of ctx.platformRoots.map((r) => normalizeHostname(r)).filter(Boolean)) {
    if (hostname === root || hostname.endsWith('.' + root)) return { ok: false, hostname, reason: 'That address belongs to the platform. Use a domain you own.' };
  }
  if (labels.length === 2) {
    return { ok: false, hostname, reason: 'Connect www.' + hostname + ' (then forward ' + hostname + ' to it at your domain provider).', suggestion: 'www.' + hostname };
  }
  return { ok: true, hostname };
}

/** The ownership record a store must publish (its own token per claim). */
export function ownershipRecordName(hostname: string): string {
  return '_store-verify.' + hostname;
}

/** null = unlimited (plan data, 00040). */
export function domainCapAllows(limit: number | null | undefined, used: number): boolean {
  return limit === null || limit === undefined ? true : used < limit;
}
