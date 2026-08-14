/**
 * Legal & policy content for the /terms, /privacy and /shipping pages.
 *
 * Everything here is editable from /admin → Settings → Legal & Policies and
 * persisted under store:config.legal. Nothing about the brand, company name,
 * support address or policy wording is hardcoded in the pages themselves.
 *
 * Content format (a tiny safe markup so buyers can write clean policies without
 * code):
 *   - Lines starting with `## ` become section headings.
 *   - Lines starting with `- ` become bullet points.
 *   - Blank lines separate paragraphs.
 *   - Anything else becomes a paragraph.
 *   - `# ` at the very start overrides the page title.
 */

export type LegalPageKey = 'terms' | 'privacy' | 'shipping';

export type StoreLegalConfig = {
  /** Company/legal entity name used in policy boilerplate. */
  companyName?: string;
  /** Public support email shown on policy pages. */
  supportEmail?: string;
  /** Multi-line Terms of Service content (see format above). */
  terms?: string;
  /** Multi-line Privacy Policy content (see format above). */
  privacy?: string;
  /** Multi-line Shipping & Sales Policy content (see format above). */
  shipping?: string;
};

export const DEFAULT_LEGAL: Required<StoreLegalConfig> = {
  // Neutral white-label defaults. Template buyers set their real company name
  // and support inbox in /admin → Settings → Legal & Policies (or env vars
  // SUPPORT_EMAIL / REPLY_TO_EMAIL). Nothing here is a brand.
  companyName: 'Your Brand',
  supportEmail: 'support@example.com',
  terms: `## 1. Allocation system
{companyName} operates limited product allocations. Entry does not guarantee receipt of product. Selection is at our discretion under published draw rules. One entry per email per product allocation unless we state otherwise.

## 2. Payment
By completing entry you authorize {companyName} (via Stripe) to save your payment method. You are charged only if selected for that allocation. Failed charges may result in forfeiture of that selection.

## 3. Eligibility
You must be able to form a binding contract in your jurisdiction and provide accurate shipping information. We may refuse or cancel entries that appear fraudulent or abusive.

## 4. All sales final
Allocated products are final sale. No returns, refunds, or exchanges, except where required by law.

## 5. Communications & consent
By creating an account you agree to the Terms of Service and Privacy Policy. We may email you about entry status, allocation results, shipping, and other operational notices — these transactional messages are required to run the service.

Marketing messages (drop announcements, release previews, and reward updates) are only sent if you opted in during signup or later through your account settings. You can unsubscribe at any time using the unsubscribe link in any marketing email, or by contacting support.

## 6. Limitation of liability
To the fullest extent permitted by law, {companyName} is not liable for indirect or consequential damages arising from use of the site or allocation process. Total liability for any claim is limited to the amount you paid for the specific allocation at issue.

## 7. Contact
Support: use the address listed on the storefront or Manage My Entry.`,
  privacy: `## What we collect
Email, shipping address, and payment details processed by Stripe. Device/session identifiers for fraud reduction and basic analytics. Entry and draw logs stored in our database (e.g. Redis).

## How we use it
To run allocations, charge selected entrants, ship orders, prevent abuse, send transactional email, and improve the service.

## Sharing
Stripe (payments), email delivery provider (e.g. Resend), hosting (e.g. Vercel), and shipping partners as needed to fulfill. We do not sell personal information.

## Retention
Entry and order records are kept as long as needed for operations, legal, and accounting purposes.

## Your choices
Manage My Entry allows address/payment updates where available. Contact support to request access or deletion where applicable law requires.`,
  shipping: `## Shipping
If you are selected and charged, we ship to the address on your entry. You are responsible for providing a deliverable address. Risk of loss passes on delivery to the carrier where permitted by law.

## Timing
Dispatch timing depends on allocation and fulfillment queues. Tracking is provided when the label is created.

## All sales final
Fragrance and allocated products are final sale. No returns, refunds, or exchanges once charged, except where required by law. Do not open sealed product if local law requires an unopened return exception — contact support before opening.

## Failed delivery
Refused packages or incorrect addresses may not be re-shipped free of charge.`,
};

/** Parse a legal-content block into renderable nodes. `{companyName}` and
 * `{supportEmail}` tokens are substituted from the config. */
export type LegalBlock = { kind: 'heading' | 'paragraph' | 'bullet'; text: string };

export function parseLegalContent(raw: string | undefined, vars: { companyName: string; supportEmail: string }): LegalBlock[] {
  const text = String(raw || '');
  if (!text.trim()) return [{ kind: 'paragraph', text: 'This policy has not been configured yet.' }];
  const out: LegalBlock[] = [];
  const applyVars = (value: string) =>
    value
      .replace(/\{companyName\}/g, vars.companyName || 'our store')
      .replace(/\{supportEmail\}/g, vars.supportEmail || 'support');
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      // Blank line separates paragraphs. If we already pushed a paragraph, add
      // a gap marker so the renderer can insert spacing.
      continue;
    }
    if (line.startsWith('## ')) {
      out.push({ kind: 'heading', text: applyVars(line.slice(3).trim()) });
    } else if (line.startsWith('- ')) {
      out.push({ kind: 'bullet', text: applyVars(line.slice(2).trim()) });
    } else {
      out.push({ kind: 'paragraph', text: applyVars(line) });
    }
  }
  return out;
}
