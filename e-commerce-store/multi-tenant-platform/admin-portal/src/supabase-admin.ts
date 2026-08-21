/**
 * Service-role Supabase client for the Admin Portal. The service role key
 * bypasses RLS — the Admin Portal is the one trusted writer for tenant data.
 * NEVER use this client in the edge Worker or any public route.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../shared/types.ts';

export interface AdminCredentials {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export function createAdminClient(credentials: AdminCredentials): SupabaseClient<Database> {
  return createClient<Database>(credentials.supabaseUrl, credentials.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
