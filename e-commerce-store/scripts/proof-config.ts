/**
 * The platform domain the proofs run against: production's
 * PLATFORM_ROOT_DOMAIN from wrangler.jsonc (so set-platform-domain.ts moves
 * them too), or PROOF_ROOT_DOMAIN to point them somewhere else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function wranglerVar(name: string): string {
  try {
    const src = readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return (new RegExp('"' + name + '"\\s*:\\s*"([^"]*)"').exec(src) || [])[1] || '';
  } catch { return ''; }
}

export const ROOT = (process.env.PROOF_ROOT_DOMAIN || wranglerVar('PLATFORM_ROOT_DOMAIN')).trim().toLowerCase();
if (!ROOT) throw new Error('No platform domain: set PLATFORM_ROOT_DOMAIN in wrangler.jsonc or PROOF_ROOT_DOMAIN');
export const SUPPORT_EMAIL = wranglerVar('SUPPORT_EMAIL') || 'support@' + ROOT;
/** A RegExp-safe version of ROOT, for patterns. */
export const ROOT_RE = ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
