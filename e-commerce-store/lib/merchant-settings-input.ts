/**
 * MERCHANT SETTINGS INPUT — what a merchant may change about their store's
 * look and policies (/api/merchant/settings). Pure; every rule tested.
 *
 * Only these keys, all bounded. The store never comes from the input; the
 * route writes them into the SESSION's store's config row and nothing else.
 * Legal text is the merchant's own: an empty policy means "not published",
 * and the storefront says so rather than showing template text under their
 * name (components/LegalPage.tsx).
 */
export type MerchantSettings = {
  brandName: string;
  hero: { eyebrow: string; headline: string; body: string };
  legal: { companyName: string; supportEmail: string; terms: string; privacy: string; shipping: string };
};

const LIMITS = { brandName: 80, eyebrow: 60, headline: 120, body: 300, companyName: 120, policy: 20000 } as const;

export function validateMerchantSettings(raw: any): { ok: true; value: MerchantSettings } | { ok: false; error: string } {
  const s = (v: unknown) => String(v ?? '').replace(/\r\n/g, '\n').trim();
  const brandName = s(raw?.brandName);
  const hero = { eyebrow: s(raw?.hero?.eyebrow), headline: s(raw?.hero?.headline), body: s(raw?.hero?.body) };
  const legal = {
    companyName: s(raw?.legal?.companyName), supportEmail: s(raw?.legal?.supportEmail).toLowerCase(),
    terms: s(raw?.legal?.terms), privacy: s(raw?.legal?.privacy), shipping: s(raw?.legal?.shipping),
  };
  if (brandName.length > LIMITS.brandName) return { ok: false, error: 'The store name is limited to ' + LIMITS.brandName + ' characters.' };
  if (hero.eyebrow.length > LIMITS.eyebrow || hero.headline.length > LIMITS.headline || hero.body.length > LIMITS.body) {
    return { ok: false, error: 'Homepage text is too long (line above ' + LIMITS.eyebrow + ', headline ' + LIMITS.headline + ', text ' + LIMITS.body + ').' };
  }
  if (legal.companyName.length > LIMITS.companyName) return { ok: false, error: 'The business name is limited to ' + LIMITS.companyName + ' characters.' };
  if (legal.supportEmail && !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(legal.supportEmail)) return { ok: false, error: 'The contact email is not valid.' };
  for (const k of ['terms', 'privacy', 'shipping'] as const) {
    if (legal[k].length > LIMITS.policy) return { ok: false, error: 'Each policy is limited to ' + LIMITS.policy + ' characters.' };
  }
  return { ok: true, value: { brandName, hero, legal } };
}
