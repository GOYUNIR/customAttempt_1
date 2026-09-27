/**
 * PLATFORM TERMS AND PRIVACY — FIRST DRAFT, PENDING LEGAL REVIEW (2026-09-27).
 *
 * Written from the real architecture, not boilerplate: direct charges on the
 * merchant's own Stripe account (lib/tenant-checkout.ts), plan billing on the
 * platform account (lib/plan-billing.ts), the processors actually used
 * (Stripe, Supabase, Cloudflare, Resend). Anything not built is not claimed.
 * The domain and inbox come from configuration, never from this file.
 * Every change here should be re-reviewed; bump LEGAL_DRAFT.reviewed.
 */

export const LEGAL_DRAFT = {
  reviewed: '2026-09-27',
  status: 'First draft. Pending legal review; not yet reviewed by a lawyer.',
};

export type LegalSection = { h: string; p: string[] };

export function platformTerms(site: string, inbox: string): LegalSection[] {
  const contact = inbox ? 'email ' + inbox : 'contact us through ' + site;
  return [
    { h: 'Who these terms are for', p: [
      `These terms cover merchants who run a store on ${site} (the "platform"), and the people they invite to help run it. Shoppers buying from a store deal with that store; the store's own terms and policies apply to their purchase.`,
    ] },
    { h: 'Your store, your sales', p: [
      'Each store takes payments through its own Stripe account, connected to the platform with Stripe Connect. Payments are created directly on the merchant\'s Stripe account: the merchant is the seller and the merchant of record for every sale, and the money goes to the merchant\'s Stripe balance, not through ours.',
      'The merchant is responsible for what it sells, its prices, taxes on its sales, shipping, customer service, refunds, returns and disputes. Refunds and disputes are handled in the merchant\'s Stripe account; Stripe\'s own fees, including dispute fees, are charged by Stripe to that account.',
      'Selling through the platform also means accepting Stripe\'s Connected Account Agreement. Goods and businesses Stripe does not allow cannot be sold here.',
    ] },
    { h: 'Plans and fees', p: [
      'Current plans and fees are on the pricing page, and that page is part of these terms. On the Free plan the platform takes a fee from each sale, collected by Stripe as an application fee at the moment of the sale. On a paid plan the store pays a monthly subscription instead.',
      'Paid plans are billed monthly in advance by card through Stripe, with no free trial. You can cancel at any time from your dashboard; the plan stays on until the end of the period already paid, then the store moves to Free. If a renewal payment fails, the paid plan stays on for 7 days while you update your card; after that the store is billed as Free until payment succeeds. Fees already paid are not refunded for part of a month, except where the law requires it.',
      'We may change plans or fees. We will tell store owners by email at least 30 days before a change takes effect for their store.',
    ] },
    { h: 'Accounts and access', p: [
      'Store owners can invite staff. Everyone signs in with their own email and password plus a one-time code sent by email. Keep your sign-in private; you are responsible for what happens under your store\'s accounts.',
      'Our support staff can act inside a store only when assigned to it. Every action they take is recorded under their own name in the store\'s audit log.',
    ] },
    { h: 'Your content and data', p: [
      'You own your store\'s content (products, images, text) and your store\'s data. You give us permission to host, display and process it only to run your store and the platform.',
      'You can ask for a full export of your store\'s data at any time and we will provide it; a self-serve export is not yet available in the dashboard.',
      'For your shoppers\' personal data, you decide what is collected and why; we process it on your behalf to run your store. Our Privacy Policy explains what we collect.',
    ] },
    { h: 'Acceptable use', p: [
      'Do not use the platform to break the law, sell prohibited goods, mislead shoppers, send spam, attack the service or other stores, or try to reach another store\'s data. We may suspend a store that does, and will tell the owner why unless the law or safety prevents it.',
    ] },
    { h: 'Availability and changes', p: [
      'We work to keep the platform available and your data safe, but we do not promise it will be uninterrupted or error-free. Features described as "coming" are not yet available and are not part of what you are paying for.',
    ] },
    { h: 'Ending', p: [
      'You can stop using the platform at any time: cancel any paid plan, then ask us to close the store. We can end these terms with 30 days\' notice, or at once for a serious breach. Either way, you can ask for your data export before the store is closed.',
    ] },
    { h: 'Liability', p: [
      'To the extent the law allows, the platform is provided "as is", and our total liability to a merchant for any claim is limited to the fees that merchant paid us in the 12 months before the claim. We are not liable for lost profits or indirect losses. Nothing in these terms limits liability that cannot be limited by law.',
    ] },
    { h: 'Contact', p: [
      `Questions about these terms: ${contact}. The governing law and the place for resolving disputes will be set out here after legal review.`,
    ] },
  ];
}

export function platformPrivacy(site: string, inbox: string): LegalSection[] {
  const contact = inbox ? 'email ' + inbox : 'contact us through ' + site;
  return [
    { h: 'Who this covers', p: [
      `This policy covers the operator of ${site} and people who use it: merchants and their staff, visitors to this site, and shoppers at stores on the platform.`,
      'For shoppers, the store you buy from decides what it collects and why, and it is responsible for that data; we process it on the store\'s behalf. Contact the store first about your data; we will help it answer.',
    ] },
    { h: 'What we collect', p: [
      'Merchants and staff: name, email address, sign-in details (passwords are stored hashed by our authentication provider), the one-time sign-in codes we email, the store\'s settings and content, the store\'s Stripe account identifier, and a record of actions taken in the store (the audit log).',
      'Shoppers: email address, shipping address, what was ordered and paid, and entries into raffles or waitlists. Card details are entered on Stripe\'s pages and handled by Stripe; they never reach our servers. For raffles, Stripe saves the payment method so a winner can be charged after the draw.',
      'Everyone: IP address and basic device and session details, used for security, sign-in sessions and limiting abuse (for example too many attempts from one connection).',
    ] },
    { h: 'Why we use it', p: [
      'To run stores and the platform: taking orders, running raffles and waitlists, sending order and sign-in emails, billing plans, preventing fraud and abuse, keeping an audit trail, and supporting merchants. Our legal bases are performing our contract with merchants, the store\'s contract with its shoppers, and our legitimate interest in keeping the service secure.',
      'We do not sell personal information, and we do not use shoppers\' data for our own advertising.',
    ] },
    { h: 'Who processes it for us', p: [
      'Stripe (payments and plan billing), Supabase (database and sign-in), Cloudflare (hosting, storage of images and session data, and email forwarding), and Resend (sending email). This site also loads fonts from Google Fonts, which sees your IP address when the page loads. Each processes data only to provide its service. Some are in the United States.',
    ] },
    { h: 'Cookies', p: [
      'The platform sets only the cookies needed to keep you signed in and secure. A store may add its own analytics or marketing tools; its own policy covers those.',
    ] },
    { h: 'How long we keep it', p: [
      'Merchant and store data is kept while the store is active. Orders are kept as long as the store needs them for its records and as the law requires. Audit logs are kept to protect the store and the platform. When a store is closed, we delete or anonymise its data within a reasonable time, except what we must keep by law.',
    ] },
    { h: 'Your rights', p: [
      `Depending on where you live (for example under the GDPR in Europe or the CCPA in California), you can ask to see, correct, export or delete your personal data, or object to how it is used. To do so, ${contact}. We will answer within the time the law sets. You can also complain to your local data protection authority.`,
    ] },
    { h: 'Security', p: [
      'Each store\'s data is kept separate from every other store\'s. Staff sign in with a password plus an emailed code, support access is limited and logged, and card data stays with Stripe. No system is perfectly secure; if a breach affects your data we will tell you as the law requires.',
    ] },
    { h: 'Changes', p: [
      'We will update this policy as the platform changes and show the date of the latest version at the top.',
    ] },
  ];
}
