/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CLOUDFLARE CUSTOM-HOSTNAME STATUS MAPPING — pure decision logic.
 *
 * Cloudflare's Custom Hostnames API returns a much larger status vocabulary
 * than the admin domain panel needs to show an operator (see
 * supabase/migrations/00010_custom_domains.sql's `domain_status`/`ssl_status`
 * CHECK constraints for the trimmed-down set this app actually stores).
 * Zero imports (mirrors lib/rbac.ts / lib/b2b/*) so this is directly
 * `node --test`-loadable; lib/cloudflare-saas.ts (the network + Supabase
 * orchestration layer) imports it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type DomainStatus = 'unconfigured' | 'pending' | 'active' | 'error';
export type SslStatus = 'unconfigured' | 'pending_validation' | 'pending_issuance' | 'active' | 'error';

/** Cloudflare's `custom_hostname.status` → this app's `domain_status`. */
export function mapCloudflareDomainStatus(cfStatus: string | null | undefined): DomainStatus {
  const s = String(cfStatus || '').toLowerCase();
  if (!s) return 'unconfigured';
  if (s === 'active' || s === 'active_redeploying' || s === 'test_active' || s === 'test_active_apex') return 'active';
  if (s === 'blocked' || s === 'test_blocked' || s === 'test_failed' || s === 'pending_blocked' || s === 'deleted') return 'error';
  // Every other Cloudflare status (pending, moved, pending_deletion,
  // pending_migration, pending_provisioned, provisioned, test_pending, …)
  // is an in-progress state from the operator's point of view.
  return 'pending';
}

/** Cloudflare's `custom_hostname.ssl.status` → this app's `ssl_status`. */
export function mapCloudflareSslStatus(cfSslStatus: string | null | undefined): SslStatus {
  const s = String(cfSslStatus || '').toLowerCase();
  if (!s) return 'unconfigured';
  if (s === 'active' || s === 'staging_active') return 'active';
  if (s === 'pending_validation' || s === 'initializing') return 'pending_validation';
  if (
    s === 'pending_issuance' ||
    s === 'pending_deployment' ||
    s === 'staging_deployment' ||
    s === 'pending_cleanup'
  ) {
    return 'pending_issuance';
  }
  if (
    s.includes('timed_out') ||
    s === 'expired' ||
    s === 'deleted' ||
    s === 'pending_expiration' ||
    s === 'pending_deletion' ||
    s === 'deactivating' ||
    s === 'inactive'
  ) {
    return 'error';
  }
  return 'pending_validation';
}

/** True when Cloudflare's own SDK/API health check should be considered
 *  "done, don't keep polling" — either fully active or in a terminal error
 *  state. Used to decide whether the admin panel should keep auto-refreshing
 *  a pending domain's status. */
export function isTerminalDomainStatus(status: DomainStatus): boolean {
  return status === 'active' || status === 'error';
}
