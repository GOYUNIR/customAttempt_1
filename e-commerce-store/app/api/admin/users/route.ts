import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY} from '@/lib/server-config';
import { adminAuthorized, isStepUpVerified, resolveAdminActor, actorHasFullAdminAccess } from '@/lib/admin-verify';
import { randomBytes, scryptSync } from 'crypto';
import { appendAudit } from '@/app/api/admin/audit/route';

export const dynamic = 'force-dynamic';

/**
 * Store-account roles. NOTE: this is a DIFFERENT, older vocabulary than
 * `lib/rbac.ts`'s `PORTAL_ROLES` (super_admin/sales/owner/staff/customer) —
 * that module models the forward-looking multi-tenant Supabase `users` table
 * (not yet wired to this route). This hash's `role` field only ever meant
 * "can this signed-in customer session also read the full store config"
 * (see app/api/store/config/route.ts's `sessionUser.role === 'admin'`
 * check) — sanitizeRole() would silently reject 'admin' and break that
 * feature, so validate against the vocabulary this route actually uses.
 */
const STORE_USER_ROLES = new Set(['customer', 'admin']);
function sanitizeStoreUserRole(value: unknown): 'customer' | 'admin' | null {
  const v = String(value || '').trim().toLowerCase();
  return STORE_USER_ROLES.has(v) ? (v as 'customer' | 'admin') : null;
}

type StoreUser = {
  id: string;
  email: string;
  password: string;
  role: string;
  rewards: number;
  createdAt: string;
  updatedAt?: string;
};

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

async function loadUsers(redis: any): Promise<Record<string, StoreUser>> {
  const raw = await redis.hgetall(USERS_KEY);
  if (!raw) return {};
  const out: Record<string, StoreUser> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = safeParseRedisItem<StoreUser>(value);
    if (parsed) out[key] = parsed;
  }
  return out;
}

function serializeUser(user: StoreUser) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    rewards: user.rewards || 0,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const password = String(url.searchParams.get('password') || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ users: [] });

    const users = Object.values(await loadUsers(redis))
      .sort((a, b) => String(a.email).localeCompare(String(b.email)))
      .map(serializeUser);

    return NextResponse.json({ users });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, users: [] }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }
    // RBAC: customer-account management (creating logins, granting the
    // config-reading 'admin' role, deleting accounts) is a full-admin
    // action — a Staff Impersonation session never reaches it.
    const actor = await resolveAdminActor(request);
    if (!actorHasFullAdminAccess(actor)) {
      return NextResponse.json({ error: 'Not permitted for an impersonation session.' }, { status: 403 });
    }

    const action = String(body?.action || 'create');
    const users = await loadUsers(redis);

    if (action === 'delete') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing user ID' }, { status: 400 });
      await redis.hdel(USERS_KEY, id);
      try {
        await appendAudit(redis, { action: 'USER_DELETED', detail: `User ${id}`, actor: 'admin' });
      } catch {}
      return NextResponse.json({ success: true });
    }

    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 });

    const rewards = Math.max(0, Number(body?.rewards ?? 0) || 0);
    // Never trust a free-text role string from the client verbatim.
    const role = body?.role === undefined ? 'customer' : sanitizeStoreUserRole(body?.role);
    if (role === null) {
      return NextResponse.json({ error: 'Invalid role.' }, { status: 400 });
    }

    // Step-up re-auth for privilege escalation: 'admin' role grants the
    // signed-in customer session read access to the full store config (see
    // app/api/store/config/route.ts). Only require it when the change
    // actually GRANTS the role (new account as admin, or an existing
    // non-admin promoted) — never for saves that leave it unchanged, so
    // routine edits to an already-admin account stay one step.
    if (role === 'admin') {
      const existingForRole = action === 'update' ? users[String(body?.id || '')] : null;
      const isEscalation = action === 'create' || existingForRole?.role !== 'admin';
      if (isEscalation) {
        const fresh = await isStepUpVerified(redis, request, password);
        if (!fresh) {
          return NextResponse.json(
            { error: 'Re-enter your password to confirm this change.', code: 'STEP_UP_REQUIRED' },
            { status: 401 },
          );
        }
      }
    }

    if (action === 'create') {
      const alreadyExists = Object.values(users).some((user) => user.email === email);
      if (alreadyExists) return NextResponse.json({ error: 'A user with this email already exists.' }, { status: 400 });

      const rawPassword = String(body?.userPassword || '').trim();
      if (!rawPassword) return NextResponse.json({ error: 'Password is required for new users.' }, { status: 400 });

      const salt = randomBytes(16).toString('hex');
      const hashed = hashPassword(rawPassword, salt);
      const user: StoreUser = {
        id: `usr_${Date.now().toString(36)}`,
        email,
        password: `${salt}:${hashed}`,
        role,
        rewards,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await redis.hset(USERS_KEY, { [user.id]: JSON.stringify(user) });
      try {
        await appendAudit(redis, { action: 'USER_CREATED', detail: email, actor: 'admin', email });
      } catch {}
      return NextResponse.json({ success: true, user: serializeUser(user) });
    }

    if (action === 'update') {
      const id = String(body?.id || '');
      if (!id) return NextResponse.json({ error: 'Missing user ID' }, { status: 400 });
      const existing = users[id];
      if (!existing) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

      const emailTaken = Object.values(users).some((user) => user.id !== id && user.email === email);
      if (emailTaken) return NextResponse.json({ error: 'Another user already has this email.' }, { status: 400 });

      let nextPassword = existing.password;
      const rawPassword = String(body?.userPassword || '').trim();
      if (rawPassword) {
        const salt = randomBytes(16).toString('hex');
        nextPassword = `${salt}:${hashPassword(rawPassword, salt)}`;
      }

      const updated: StoreUser = {
        ...existing,
        email,
        role,
        rewards,
        password: nextPassword,
        updatedAt: new Date().toISOString(),
      };
      await redis.hset(USERS_KEY, { [updated.id]: JSON.stringify(updated) });
      try {
        await appendAudit(redis, { action: 'USER_UPDATED', detail: email, actor: 'admin', email });
      } catch {}
      return NextResponse.json({ success: true, user: serializeUser(updated) });
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}