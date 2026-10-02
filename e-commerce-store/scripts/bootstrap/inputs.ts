/**
 * BOOTSTRAP INPUTS: everything a fresh install needs to know, and nothing
 * else. The platform's name, domain and operator identity are inputs, never
 * constants; the same code installs "GOYUNIR on goyunir.com" or any other.
 * Secrets are NOT inputs: they come from the environment by name
 * (secrets-manifest.ts) and are never printed.
 *
 * From a JSON file (--config bootstrap.json) and/or flags (flags win):
 *   --name "Platform Name" --domain example.com --worker my-worker
 *   --cloudflare-account <id> --supabase-project <ref> --admin-email a@b.c
 */
import { readFileSync, existsSync } from 'node:fs';

export type BootstrapInputs = {
  /** The platform's public name ("Larkspur Commerce"). */
  name: string;
  /** The platform's root domain; stores live at <slug>.<domain>. */
  domain: string;
  /** The Cloudflare Worker's name. */
  worker: string;
  cloudflareAccountId: string;
  /** Supabase project ref (the subdomain of <ref>.supabase.co). */
  supabaseProject: string;
  /** The first super-admin's sign-in email (the password comes from BOOTSTRAP_ADMIN_PASSWORD). */
  adminEmail: string;
  /** Where customers and merchants write to. Default support@<domain>. */
  supportEmail: string;
  /** Where platform alerts go (signup breaker etc.). Default: supportEmail. */
  alertEmail: string;
  /** Sender for platform mail. Default "<name> <notifications@<domain>>". */
  sendingFrom: string;
  /** Legal entity named in the Terms (empty until legal review). */
  legalEntity: string;
  /** R2 bucket for product photos. Default <worker>-media. */
  mediaBucket: string;
  /** Turnstile site key (public; created by the cloudflare step). */
  turnstileSiteKey: string;
  /** Previous root domains that should 301 here (the old stack's). */
  oldRootDomains: string[];
};

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Fill defaults and validate (pure; tested). Throws a readable error. */
export function resolveInputs(raw: Partial<Omit<BootstrapInputs, 'oldRootDomains'>> & { oldRootDomains?: string[] | string }): BootstrapInputs {
  const domain = String(raw.domain || '').trim().toLowerCase();
  const name = String(raw.name || '').trim();
  const problems: string[] = [];
  if (!name) problems.push('name is required (the platform\'s public name)');
  if (!DOMAIN_RE.test(domain)) problems.push('domain must look like example.com');
  const worker = String(raw.worker || '').trim() || domain.split('.')[0].replace(/[^a-z0-9-]/g, '-') + '-platform';
  const supportEmail = String(raw.supportEmail || '').trim() || (domain ? 'support@' + domain : '');
  const inputs: BootstrapInputs = {
    name,
    domain,
    worker,
    cloudflareAccountId: String(raw.cloudflareAccountId || '').trim(),
    supabaseProject: String(raw.supabaseProject || '').trim(),
    adminEmail: String(raw.adminEmail || '').trim().toLowerCase(),
    supportEmail,
    alertEmail: String(raw.alertEmail || '').trim() || supportEmail,
    sendingFrom: String(raw.sendingFrom || '').trim() || (name && domain ? name + ' <notifications@' + domain + '>' : ''),
    legalEntity: String(raw.legalEntity || '').trim(),
    mediaBucket: String(raw.mediaBucket || '').trim() || worker + '-media',
    turnstileSiteKey: String(raw.turnstileSiteKey || '').trim(),
    oldRootDomains: (Array.isArray(raw.oldRootDomains) ? raw.oldRootDomains : String(raw.oldRootDomains || '').split(','))
      .map((d) => String(d).trim().toLowerCase()).filter((d) => d && d !== domain),
  };
  for (const d of inputs.oldRootDomains) if (!DOMAIN_RE.test(d)) problems.push('old root domain "' + d + '" is not a domain');
  for (const [k, v] of [['supportEmail', inputs.supportEmail], ['alertEmail', inputs.alertEmail], ...(inputs.adminEmail ? [['adminEmail', inputs.adminEmail]] : [])] as const) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) problems.push(k + ' is not an email address');
  }
  if (problems.length) throw new Error('bootstrap inputs: ' + problems.join('; '));
  return inputs;
}

/** Read --config <file> and flags into raw inputs. */
export function readInputs(argv: string[]): Partial<BootstrapInputs> {
  const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  const file = flag('config');
  const fromFile = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const map: Record<string, keyof BootstrapInputs> = {
    name: 'name', domain: 'domain', worker: 'worker', 'cloudflare-account': 'cloudflareAccountId', 'supabase-project': 'supabaseProject',
    'admin-email': 'adminEmail', 'support-email': 'supportEmail', 'alert-email': 'alertEmail', 'sending-from': 'sendingFrom',
    'legal-entity': 'legalEntity', 'media-bucket': 'mediaBucket', 'turnstile-site-key': 'turnstileSiteKey', 'old-root-domains': 'oldRootDomains',
  };
  const out: Record<string, unknown> = { ...fromFile };
  for (const [f, k] of Object.entries(map)) { const v = flag(f); if (v !== undefined) out[k] = v; }
  return out as Partial<BootstrapInputs>;
}
