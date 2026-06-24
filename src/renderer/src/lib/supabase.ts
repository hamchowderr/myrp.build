// Renderer Supabase client. Supabase Auth is now the identity provider (native
// Discord OAuth via PKCE), replacing Clerk — clerk-js had no Electron session
// persistence (fivem-studio-gvh). RLS scopes by the native `auth.uid()` carried
// in the Supabase JWT this client manages.
//
// The auth block makes the session durable in Electron: a custom `storage`
// adapter (ipcAuthStorage → main-process safeStorage file) persists the session
// + PKCE code_verifier across reload/refresh/relaunch. detectSessionInUrl is off
// because we exchange the OAuth code ourselves (loopback → exchangeCodeForSession),
// not via a browser URL fragment.
//
// Null when env is unset (e.g. local dev without Supabase) so callers can degrade
// gracefully, mirroring the old null-guard.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database";
import { ipcAuthStorage } from "./auth-storage";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient<Database> | null =
  url && anonKey
    ? createClient<Database>(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          flowType: "pkce",
          storage: ipcAuthStorage,
          storageKey: "myrpbuild-auth",
        },
      })
    : null;

// Dev-only: expose the client so the CDP harness (scratch/cdp-session.mjs) can
// inspect the live session for the Phase 5 persistence checks. Stripped from
// production builds by the `import.meta.env.DEV` guard (no effect when packaged).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __supabase?: SupabaseClient<Database> | null }).__supabase = supabase;
}
