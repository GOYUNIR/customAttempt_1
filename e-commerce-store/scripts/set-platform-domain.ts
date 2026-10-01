/**
 * SET THE PLATFORM DOMAIN — the config half of the move (DOMAIN-MIGRATION.md).
 *
 *   npx tsx scripts/set-platform-domain.ts <new-root> [--name "<Platform name>"] [--dry]
 *
 * Rewrites wrangler.jsonc so everything domain-shaped follows ONE value:
 *   routes                         adds <new>/* and *.<new>/*, KEEPS the old ones
 *                                  (old addresses 301 to the new; the old apex
 *                                  becomes GOYUNIR's own store domain)
 *   PLATFORM_ROOT_DOMAIN           <new>
 *   PLATFORM_OLD_ROOT_DOMAINS      the old root (added to any already there)
 *   TURNSTILE_EXPECTED_HOSTNAMES   <new>
 *   SUPPORT_EMAIL                  support@<new>
 *   EMAIL_SINK_DOMAINS             proof.<new>
 *   PLATFORM_STOREFRONT_HOST       goyunir.<new>  (until GOYUNIR's own domain is primary)
 *   PLATFORM_NAME                  with --name
 * Unchanged on purpose: MEDIA_S3_PUBLIC_BASE_URL (media.<old> stays up for
 * good; stored photos are domain-free keys), STOREFRONT_LEGACY_HOSTS (labels,
 * relative to the root). The sender (RESEND_FROM secret) moves separately,
 * only after the new domain is verified for sending (runbook step).
 * Prints the diff; --dry writes nothing. Deploy = commit + push.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const NEW = String(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--name') || '').toLowerCase();
const nameIdx = args.indexOf('--name');
const NAME = nameIdx >= 0 ? String(args[nameIdx + 1] || '').trim() : '';
const DRY = args.includes('--dry');
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(NEW)) { console.error('usage: set-platform-domain.ts <new-root> [--name "<Platform name>"] [--dry]'); process.exit(2); }

const file = join(process.cwd(), 'wrangler.jsonc');
let src = readFileSync(file, 'utf8');
const before = src;
const get = (k: string) => (new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"').exec(src) || [])[1];
const OLD = get('PLATFORM_ROOT_DOMAIN') || '';
if (OLD === NEW) { console.error('The platform domain is already ' + NEW + '.'); process.exit(2); }
const setVar = (k: string, v: string) => {
  if (get(k) !== undefined) src = src.replace(new RegExp('("' + k + '"\\s*:\\s*")[^"]*(")'), '$1' + v + '$2');
  else src = src.replace(/("PLATFORM_ROOT_DOMAIN"\s*:\s*"[^"]*",?)/, '$1\n    "' + k + '": "' + v + '",');
};

// Routes: add the new zone's two patterns after the old ones.
if (!src.includes('"pattern": "' + NEW + '/*"')) {
  src = src.replace(/(\{\s*"pattern":\s*"\*\.[^"]+\/\*",\s*"zone_name":\s*"[^"]+"\s*\})/,
    '$1,\n    { "pattern": "' + NEW + '/*", "zone_name": "' + NEW + '" },\n    { "pattern": "*.' + NEW + '/*", "zone_name": "' + NEW + '" }');
}
const olds = new Set(String(get('PLATFORM_OLD_ROOT_DOMAINS') || '').split(',').map((s) => s.trim()).filter(Boolean));
if (OLD) olds.add(OLD);
olds.delete(NEW);
setVar('PLATFORM_ROOT_DOMAIN', NEW);
setVar('PLATFORM_OLD_ROOT_DOMAINS', [...olds].join(','));
setVar('TURNSTILE_EXPECTED_HOSTNAMES', NEW);
setVar('SUPPORT_EMAIL', 'support@' + NEW);
setVar('EMAIL_SINK_DOMAINS', 'proof.' + NEW);
setVar('PLATFORM_STOREFRONT_HOST', 'goyunir.' + NEW);
if (NAME) setVar('PLATFORM_NAME', NAME.replace(/"/g, ''));

const a = before.split('\n'), b = src.split('\n');
console.log('wrangler.jsonc: ' + OLD + ' -> ' + NEW + (DRY ? ' (dry run, nothing written)' : ''));
for (const line of b) if (!a.includes(line)) console.log('  + ' + line.trim());
for (const line of a) if (!b.includes(line)) console.log('  - ' + line.trim());
if (!DRY) writeFileSync(file, src);
console.log('\nNext: commit and push (deploys), then run\n  npx tsx scripts/verify-domain-migration.ts ' + NEW + ' --old ' + OLD + ' --goyunir-domain ' + OLD);
