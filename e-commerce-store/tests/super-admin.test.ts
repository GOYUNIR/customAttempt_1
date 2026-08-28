/**
 * Super-admin sign-in unit tests (node --test).
 *
 * `verifySuperAdminSignIn` talks to Supabase over fetch, so these tests mock
 * `globalThis.fetch` to assert the request shape (password grant → profile
 * flag check) without any network I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifySuperAdminSignIn, verifySuperAdminCredentials } from '../services/config/supabase-client.ts';

/** Replace globalThis.fetch with a canned handler; returns a restore fn. */
function installFetchMock(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => Promise.resolve(handler(String(input)))) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function withSupabaseEnv(fn: () => Promise<void>) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  return async () => {
    try {
      await fn();
    } finally {
      if (url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = url;
      if (anon === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = anon;
    }
  };
}

test(
  'verifySuperAdminSignIn: returns the account when credentials + super-admin flag are valid',
  withSupabaseEnv(async () => {
    const restore = installFetchMock((url) => {
      if (url.includes('/auth/v1/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok', user: { id: 'user-1', email: 'admin@x.co' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify([{ is_super_admin: true }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    try {
      assert.deepEqual(await verifySuperAdminSignIn('admin@x.co', 'pw'), {
        id: 'user-1',
        email: 'admin@x.co',
      });
    } finally {
      restore();
    }
  }),
);

test(
  'verifySuperAdminSignIn: rejects a user who is NOT a super-admin',
  withSupabaseEnv(async () => {
    const restore = installFetchMock((url) => {
      if (url.includes('/auth/v1/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok', user: { id: 'user-1', email: 'admin@x.co' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify([{ is_super_admin: false }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    try {
      assert.equal(await verifySuperAdminSignIn('admin@x.co', 'pw'), null);
    } finally {
      restore();
    }
  }),
);

test(
  'verifySuperAdminCredentials: returns the user id + access token from the password grant',
  withSupabaseEnv(async () => {
    const restore = installFetchMock(() =>
      new Response(
        JSON.stringify({ access_token: 'tok', user: { id: 'user-1', email: 'admin@x.co' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    try {
      assert.deepEqual(await verifySuperAdminCredentials('admin@x.co', 'pw'), {
        id: 'user-1',
        email: 'admin@x.co',
        accessToken: 'tok',
        isSuperAdmin: false,
      });
    } finally {
      restore();
    }
  }),
);

test(
  'verifySuperAdminSignIn: falls back to GoTrue metadata when the profiles table read fails (schema not applied)',
  withSupabaseEnv(async () => {
    const restore = installFetchMock((url) => {
      if (url.includes('/auth/v1/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'tok',
            user: {
              id: 'user-1',
              email: 'admin@x.co',
              user_metadata: { is_super_admin: true, role: 'super_admin' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/profiles')) {
        // A fresh project with no schema → PostgREST returns a 404/PGRST error.
        return new Response('{"message":"Could not find the table"}', { status: 404 });
      }
      return new Response('{}', { status: 404 });
    });
    try {
      assert.deepEqual(await verifySuperAdminSignIn('admin@x.co', 'pw'), {
        id: 'user-1',
        email: 'admin@x.co',
      });
    } finally {
      restore();
    }
  }),
);

test(
  'verifySuperAdminSignIn: returns null when Supabase is not configured',
  async () => {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    try {
      assert.equal(await verifySuperAdminSignIn('admin@x.co', 'pw'), null);
    } finally {
      if (url !== undefined) process.env.SUPABASE_URL = url;
      if (anon !== undefined) process.env.SUPABASE_ANON_KEY = anon;
    }
  },
);
