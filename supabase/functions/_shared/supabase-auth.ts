// Shared Supabase JWT verification for Edge Functions that run with
// verify_jwt=false (fivem-studio-gvh — native Supabase Auth replaced Clerk).
//
// We verify the user's access token with a service-role client: auth.getUser(jwt)
// validates the token's signature + expiry against the project's keys and returns
// the user. The returned `sub` is the NATIVE Supabase user id (uuid) — the same
// value as auth.uid() — which the workspace RPCs now key on (p_user_id uuid).
//
// In-function verification (not the platform verify_jwt) is used for consistency:
// the inference proxy receives the token via the `x-api-key` header (the AI SDK
// Anthropic provider puts it there), which the platform gate doesn't inspect.
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../../../src/types/database.ts";
import { requireEnv } from "./env.ts";

const admin = createClient<Database>(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);

/** Verify a Supabase access token and return its claims (throws on failure). */
export async function validateSupabaseJWT(token: string): Promise<{ sub: string; email?: string }> {
  if (!token) throw new Error("missing token");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error(error?.message ?? "invalid token");
  return { sub: data.user.id, email: data.user.email ?? undefined };
}

/** Read the bearer token from the Authorization header (the Supabase access token). */
export function bearerToken(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}
