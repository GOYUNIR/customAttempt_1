/**
 * Resolve the RBAC actor for a Server Component. `resolveAdminActor()`
 * (`lib/admin-verify.ts`) takes a `Request` — the shape every API route
 * already has — but a Server Component only has `next/headers`'s
 * `headers()`. This bridges the two: `headers()` already carries the
 * `Cookie`/`Authorization` headers `resolveAdminActor` reads, so wrapping
 * them in a throwaway `Request` (never actually sent anywhere) lets a page
 * reuse the exact same session-resolution logic every API route uses,
 * instead of a second, divergent implementation.
 */

import { headers } from 'next/headers';
import { resolveAdminActor } from '@/lib/admin-verify';
import type { AdminActor } from '@/lib/admin-actor';

export async function resolveAdminActorForPage(): Promise<AdminActor | null> {
  const headersList = await headers();
  const request = new Request('http://internal.local/', { headers: headersList });
  return resolveAdminActor(request);
}
