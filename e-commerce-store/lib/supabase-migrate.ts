/**
 * SUPABASE SCHEMA AUTO-APPLY — lets the Setup Wizard build the database for the
 * operator instead of asking them to paste SQL by hand.
 *
 * Supabase's PostgREST endpoint can only CRUD tables/functions — it cannot run
 * DDL. Arbitrary SQL (our idempotent migrations) is executed through the
 * Supabase **Management API** (`api.supabase.com`), which needs a one-time
 * personal access token (`SUPABASE_ACCESS_TOKEN`, starts with `sbp_`). When that
 * token is present the wizard applies all four migrations in order, edge-safe
 * (plain `fetch`, no Node builtins), and the store "sets itself up".
 *
 * When the token is absent the wizard falls back to the concise manual plan
 * (see lib/setup-schema-guide.ts) and tells the operator the one thing to add.
 */

import {
  MIGRATION_00001,
  MIGRATION_00002,
  MIGRATION_00003,
  MIGRATION_00004,
} from '@/lib/setup-schema-guide';
import { readSupabaseEnv } from '@/services/config/supabase-client';

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: '00001_init.sql', sql: MIGRATION_00001 },
  { name: '00002_setup_operational.sql', sql: MIGRATION_00002 },
  { name: '00003_tenant_routing.sql', sql: MIGRATION_00003 },
  { name: '00004_ai_secondary.sql', sql: MIGRATION_00004 },
];

/** Read + trim the Supabase Management-API access token (never logged). */
function readSupabaseAccessToken(): string {
  return String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
}

/** True when a token is present but clearly not a Supabase personal access
 *  token (they start with `sbp_`). Lets us give a friendlier error instead of
 *  a raw Management-API 401. */
export function isMalformedSupabaseAccessToken(): boolean {
  const token = readSupabaseAccessToken();
  if (!token) return false;
  return !token.startsWith('sbp_') || token.length < 12;
}

export function supabaseAutoMigrateAvailable(): boolean {
  const token = readSupabaseAccessToken();
  const { url } = readSupabaseEnv();
  return Boolean(token && url && projectRefFromUrl(url));
}

function projectRefFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export type AutoMigrateResult = {
  applied: boolean;
  ran: string[];
  error?: string;
};

/** Apply all four migrations in order via the Supabase Management API. */
export async function autoApplySchema(): Promise<AutoMigrateResult> {
  const token = readSupabaseAccessToken();
  const { url } = readSupabaseEnv();
  const ref = url ? projectRefFromUrl(url) : null;

  if (!token || !ref) {
    return {
      applied: false,
      ran: [],
      error:
        'Set SUPABASE_ACCESS_TOKEN (Supabase → Account → Access Tokens) so the wizard can build the schema for you, or run `supabase db push`.',
    };
  }

  if (isMalformedSupabaseAccessToken()) {
    return {
      applied: false,
      ran: [],
      error:
        'SUPABASE_ACCESS_TOKEN does not look like a Supabase personal access token (it must start with `sbp_`). Create a NEW token at https://supabase.com/dashboard/account/tokens and paste the full value.',
    };
  }

  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: migration.sql }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
          return {
            applied: false,
            ran,
            error:
              `${migration.name} failed: the SUPABASE_ACCESS_TOKEN was rejected (HTTP ${res.status}). It is likely a legacy or expired token. Delete it and create a NEW personal access token at https://supabase.com/dashboard/account/tokens (tokens start with \`sbp_\`), set it as SUPABASE_ACCESS_TOKEN, then retry.`,
          };
        }
        return {
          applied: false,
          ran,
          error: `${migration.name} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
        };
      }
      ran.push(migration.name);
    } catch (err) {
      return {
        applied: false,
        ran,
        error: `${migration.name} failed: ${String((err as Error)?.message || err)}`,
      };
    }
  }

  return { applied: true, ran };
}
