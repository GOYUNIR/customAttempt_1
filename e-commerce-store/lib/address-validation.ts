/**
 * Shared shipping-address validation used by both the React storefront
 * (client components) and the address/checkout APIs (server routes).
 *
 * The storefront is a DROP-ALLOCATION / RAFFLE storefront: the shipping
 * address is the address the physical product gets shipped to, so a partial
 * or garbage address is not a UX nit — it is a failed fulfilment. This module
 * therefore requires a COMPLETE address:
 *
 *   123 Main Street, Los Angeles, CA 90210, United States
 *   10 Downing Street, London, SW1A 2AA, United Kingdom
 *   Bahnhofstrasse 10, Zurich, 8001, Switzerland
 *
 * i.e. a street number + street name, a city, a state/region, a ZIP/postal
 * code and a country. Mapbox Address Autofill (lib/mapbox-autofill.ts) is the
 * fast path — its `composeFullAddress` always produces a fully-qualified
 * address — but these structural checks are the real gate, so a customer can
 * never save (or pay for) something like "123 realstreet".
 *
 * The parser is deliberately conservative about *what it accepts* and
 * opinionated about US addresses (state + 5-digit ZIP required), while still
 * accepting common international formats (UK/CA postal codes, 4-6 digit
 * postal codes, country names). Anything it can't confidently classify is
 * rejected with a clear "enter your full address" message.
 */

export interface ParsedShippingAddress {
  street: string;
  city: string;
  state: string;
  postal: string;
  country: string;
  countryCode?: string;
}

export type AddressValidationFailure =
  | 'missing_country'
  | 'missing_postal'
  | 'missing_street'
  | 'missing_state'
  | 'missing_city'
  | 'incomplete';

export type AddressParseResult =
  | { ok: true; parsed: ParsedShippingAddress }
  | { ok: false; reason: AddressValidationFailure };

/** US state abbreviations. */
const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'AS', 'GU', 'MP', 'PR', 'VI',
]);

/** Full US state names (for typed addresses that spell the state out). */
const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
  'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
  'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia',
  'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia',
];


/**
 * Countries the parser recognises. `re` must be word-boundary-safe so it can
 * never match inside a larger word (e.g. "US" must not match "MUSEUM", "CA"
 * must not match "California"). Name-first matching keeps ISO codes from being
 * ambiguous; the compact codes are only accepted as standalone words.
 */
const COUNTRIES: Array<{ re: RegExp; code: string; name: string }> = [
  { re: /\bunited\s*states(?:\s*of\s*america)?\b/i, code: 'US', name: 'United States' },
  { re: /\busa\b/i, code: 'US', name: 'United States' },
  { re: /\bu\.?\s?\.?\s?s\.?\s?\.?\s?a?\s?\.?\b/i, code: 'US', name: 'United States' },
  { re: /\bcanada\b/i, code: 'CA', name: 'Canada' },
  { re: /\bunited\s*kingdom\b|\bgreat\s*britain\b|\bengland\b/i, code: 'GB', name: 'United Kingdom' },
  { re: /\buk\b|\bgb\b/i, code: 'GB', name: 'United Kingdom' },
  { re: /\baustralia\b|\baus\b/i, code: 'AU', name: 'Australia' },
  { re: /\bgermany\b|\bdeutschland\b/i, code: 'DE', name: 'Germany' },
  { re: /\bfrance\b/i, code: 'FR', name: 'France' },
  { re: /\bjapan\b/i, code: 'JP', name: 'Japan' },
  { re: /\bchina\b|\bprc\b/i, code: 'CN', name: 'China' },
  { re: /\bitaly\b|\bitalia\b/i, code: 'IT', name: 'Italy' },
  { re: /\bspain\b|\bespaña\b/i, code: 'ES', name: 'Spain' },
  { re: /\bmexico\b/i, code: 'MX', name: 'Mexico' },
  { re: /\bnetherlands\b|\bholland\b/i, code: 'NL', name: 'Netherlands' },
  { re: /\bswitzerland\b|\bschweiz\b/i, code: 'CH', name: 'Switzerland' },
  { re: /\bsweden\b/i, code: 'SE', name: 'Sweden' },
  { re: /\bnorway\b/i, code: 'NO', name: 'Norway' },
  { re: /\bdenmark\b/i, code: 'DK', name: 'Denmark' },
  { re: /\bbelgium\b/i, code: 'BE', name: 'Belgium' },
  { re: /\baustria\b/i, code: 'AT', name: 'Austria' },
  { re: /\bportugal\b/i, code: 'PT', name: 'Portugal' },
  { re: /\bireland\b/i, code: 'IE', name: 'Ireland' },
  { re: /\bnew\s*zealand\b/i, code: 'NZ', name: 'New Zealand' },
  { re: /\bbrazil\b/i, code: 'BR', name: 'Brazil' },
  { re: /\bargentina\b/i, code: 'AR', name: 'Argentina' },
  { re: /\bindia\b/i, code: 'IN', name: 'India' },
  { re: /\bsingapore\b/i, code: 'SG', name: 'Singapore' },
  { re: /\buae\b|\bunited\s*arab\s*emirates\b/i, code: 'AE', name: 'United Arab Emirates' },
  { re: /\bsaudi\s*arabia\b/i, code: 'SA', name: 'Saudi Arabia' },
  { re: /\bsouth\s*korea\b|\bkorea\b/i, code: 'KR', name: 'South Korea' },
  { re: /\bpoland\b|\bpolska\b/i, code: 'PL', name: 'Poland' },
  { re: /\bgreece\b|\bhellas\b/i, code: 'GR', name: 'Greece' },
  { re: /\bthailand\b/i, code: 'TH', name: 'Thailand' },
  { re: /\bturkey\b|\btürkiye\b|\bturkiye\b/i, code: 'TR', name: 'Turkey' },
  { re: /\bindonesia\b/i, code: 'ID', name: 'Indonesia' },
  { re: /\bphilippines\b/i, code: 'PH', name: 'Philippines' },
  { re: /\bmalaysia\b/i, code: 'MY', name: 'Malaysia' },
  { re: /\bhong\s*kong\b/i, code: 'HK', name: 'Hong Kong' },
  { re: /\bsouth\s*africa\b/i, code: 'ZA', name: 'South Africa' },
  { re: /\bisrael\b/i, code: 'IL', name: 'Israel' },
  { re: /\bqatar\b/i, code: 'QA', name: 'Qatar' },
];

const US_ZIP_RE = /\b\d{5}(?:[-\s]?\d{4})?\b/;
const UK_POSTAL_RE = /\b[A-Z]{1,2}\d[A-Z\d]{1,2}\s?\d[A-Z]{2}\b/i;
const CA_POSTAL_RE = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;

/** US 2-letter code that sits immediately before a ZIP (e.g. ", CA 90210,"). */
const US_STATE_BEFORE_ZIP_RE = /\b([A-Z]{2})\b\s*\d{5}/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findCountry(text: string): { re: RegExp; code: string; name: string } | null {
  for (const c of COUNTRIES) {
    if (c.re.test(text)) return c;
  }
  return null;
}

/**
 * Find a postal code. US ZIPs win; otherwise UK/Canadian alphanumeric formats;
 * otherwise a bare 4-6 digit number (common internationally).
 */
function findPostal(text: string, country: { code: string } | null): string | null {
  const zip = text.match(US_ZIP_RE);
  if (zip) return zip[0];

  if (!country || country.code === 'GB') {
    const uk = text.match(UK_POSTAL_RE);
    if (uk) return uk[0].replace(/\s+/g, ' ').trim();
  }
  if (!country || country.code === 'CA') {
    const ca = text.match(CA_POSTAL_RE);
    if (ca) return ca[0].replace(/\s+/g, ' ').trim();
  }

  const digits = text.match(/\b\d{4,6}\b/);
  if (digits) return digits[0];
  return null;
}



/**
 * Break a single-line shipping address into its components. Returns
 * `{ ok: false, reason }` with a specific reason when a required component is
 * missing so callers can show a targeted error message.
 */
export function parseShippingAddress(raw: string): AddressParseResult {
  const v = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!v) return { ok: false, reason: 'incomplete' };

  const country = findCountry(v);
  if (!country) return { ok: false, reason: 'missing_country' };

  const postal = findPostal(v, country);
  if (!postal) return { ok: false, reason: 'missing_postal' };

  // Street is the first comma-separated segment and MUST contain a street
  // number plus letters. Mapbox full addresses always start with the number.
  const firstSegment = v.split(',')[0].trim();
  const hasStreetNumber = /\b\d{1,6}[a-zA-Z]?([.,\s]|$)/.test(firstSegment);
  const hasStreetName = /[A-Za-z]{2,}/.test(firstSegment);
  if (!firstSegment || !hasStreetNumber || !hasStreetName) {
    return { ok: false, reason: 'missing_street' };
  }

  // US addresses require a state (2-letter code before the ZIP, or a state name).
  let state = '';
  if (country.code === 'US') {
    const codeMatch = v.match(US_STATE_BEFORE_ZIP_RE);
    if (codeMatch && US_STATE_CODES.has(codeMatch[1])) {
      state = codeMatch[1];
    } else {
      const nameMatch = v.match(new RegExp(`\\b(${US_STATE_NAMES.join('|')})\\b`, 'i'));
      if (nameMatch) state = nameMatch[1];
    }
    if (!state) return { ok: false, reason: 'missing_state' };
  } else {
    state = '—';
  }

  // City: everything left after removing street segment, postal, state and
  // country. Must still contain at least one alphabetic word.
  let remainder = v;
  remainder = remainder.split(',').slice(1).join(', ').trim();
  remainder = remainder.replace(new RegExp(escapeRegex(postal), 'gi'), ' ');
  if (state !== '—') remainder = remainder.replace(new RegExp(`\\b${escapeRegex(state)}\\b`, 'gi'), ' ');
  remainder = remainder.replace(country.re, ' ');
  remainder = remainder.replace(/[,\s]+/g, ' ').trim();

  if (!/[A-Za-z]{2,}/.test(remainder)) return { ok: false, reason: 'missing_city' };
  const city = remainder.split(/\s+/).slice(0, 4).join(' ');

  return {
    ok: true,
    parsed: {
      street: firstSegment,
      city,
      state,
      postal,
      country: country.name,
      countryCode: country.code,
    },
  };
}

const FULL_ADDRESS_EXAMPLE =
  '"123 Main Street, Los Angeles, CA 90210, United States"';

/**
 * Validate a shipping address string. Returns `null` when the address is a
 * complete, shippable address, otherwise a human-readable reason.
 */
export function validateShippingAddress(address: string): string | null {
  const v = String(address || '').trim();
  if (!v) return 'Enter a shipping address.';

  const result = parseShippingAddress(v);
  if (result.ok) return null;

  switch (result.reason) {
    case 'missing_country':
      return `Add the country to your shipping address (e.g. ${FULL_ADDRESS_EXAMPLE}). A complete address is required so we can ship to you.`;
    case 'missing_postal':
      return `Add the ZIP / postal code to your shipping address (e.g. ${FULL_ADDRESS_EXAMPLE}).`;
    case 'missing_street':
      return `Add the street number and street name (e.g. ${FULL_ADDRESS_EXAMPLE}).`;
    case 'missing_state':
      return `Add the state to your shipping address (e.g. ${FULL_ADDRESS_EXAMPLE}).`;
    case 'missing_city':
      return `Add the city to your shipping address (e.g. ${FULL_ADDRESS_EXAMPLE}).`;
    default:
      return `Enter your full shipping address (street number + street name, city, state, ZIP and country). For example ${FULL_ADDRESS_EXAMPLE}.`;
  }
}
