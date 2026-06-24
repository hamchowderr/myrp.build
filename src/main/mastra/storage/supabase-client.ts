/**
 * Per-run Supabase client for the cloud Mastra memory adapter (M2.3 —
 * fivem-studio-825).
 *
 * Runs in the Electron MAIN process. NO DB credential ships in the client — the
 * client is built from the baked, publishable anon key + VITE_SUPABASE_URL and
 * the per-run user JWT (the same `payload.accessToken` the inference proxy uses).
 * Reads go through RLS-protected tables (is_workspace_member); writes go through
 * the SECURITY DEFINER RPCs (M2.2). The JWT scopes every request to the
 * authenticated user, so no service-role/DB-password is ever involved.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database";

export type RunSupabaseClient = SupabaseClient<Database>;

/** Resolve the baked Supabase URL (publishable). M3.4 bakes this into main's
 *  `define`; until then it's read from the runtime env. */
export function getSupabaseUrl(): string | undefined {
  return process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
}

/** Resolve the baked anon key (publishable, RLS-protected). */
export function getSupabaseAnonKey(): string | undefined {
  return process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
}

/**
 * Build a Supabase client that authenticates every request as the user behind
 * `jwt`. Returns undefined when the publishable url/anon key aren't available
 * (e.g. dev-bypass / unconfigured) so callers can degrade to no-cloud memory.
 */
export function createRunClient(jwt: string): RunSupabaseClient | undefined {
  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) return undefined;
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
