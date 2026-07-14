/**
 * Dev-only local Supabase sign-in.
 *
 * In dev-bypass there is no user JWT, so chat memory used to fall back to a raw
 * PostgresStore — which conflicted with the unified local Supabase's cloud
 * schema. Instead, sign the seeded dev user (supabase/seed.sql) into LOCAL
 * Supabase with the anon client and hand the access token to the SAME
 * SupabaseMemoryStorage adapter prod uses. Net: dev memory goes through the
 * unified adapter/tables/RPCs, exactly like prod.
 *
 * HARD-GATED to `__DEV_BYPASS__` (DCE'd out of packaged builds) — never ships.
 * The credential is a throwaway against 127.0.0.1; the real secret (a DB
 * connection string) is never involved. See the v1f9 plan.
 */
import { createClient } from "@supabase/supabase-js";
import log from "../log";
import { getSupabaseAnonKey, getSupabaseUrl } from "./supabase-client";

const DEV_EMAIL = "dev@myrp.build";
const DEV_PASSWORD = process.env.DEV_SUPABASE_PASSWORD ?? "devpassword";

/** Cached session so we don't sign in on every turn. */
let cached: { token: string; expiresAtMs: number } | null = null;

/**
 * Sign in (anon client) the seeded local dev user and return a still-valid
 * access token, or undefined if dev-bypass is off / local Supabase isn't
 * reachable (callers then degrade to single-turn, never crashing generation).
 */
export async function getDevAccessToken(): Promise<string | undefined> {
  if (!__DEV_BYPASS__) return undefined;

  // Reuse the cached token until it's within 60s of expiry, then re-sign-in
  // (persistSession:false → no refresh token to manage; jwt_expiry is ~3600s).
  if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;

  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) return undefined;

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
  });
  if (error || !data.session) {
    log.warn("[dev-auth] local dev sign-in failed (run `supabase db reset`?):", error?.message);
    cached = null;
    return undefined;
  }
  const session = data.session;
  cached = {
    token: session.access_token,
    expiresAtMs: (session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
  };
  return cached.token;
}
