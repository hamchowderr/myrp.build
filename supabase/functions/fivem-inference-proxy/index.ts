// fivem-inference-proxy — the thin PROD inference hop (fivem-studio-jqa / ok7).
//
// Flow: desktop client (Mastra, prod build) sends an Anthropic Messages API
// request here with the user's Supabase session token as the key. We forward to the
// Vercel AI Gateway's Anthropic Messages endpoint (/v1/messages), which passes
// cache_control through to Anthropic — so prompt caching is preserved.
//   1. Verify the user's Supabase access token (auth.getUser via service role).
//   2. Check the user's workspace plan + monthly usage (Supabase RPC, service role).
//   3. If allowed, reverse-proxy the request to the Vercel AI Gateway with OUR
//      gateway key (never shipped to the client), streaming the response back.
//   4. Increment usage for the workspace.
//
// The gateway gives multi-provider routing + spend metering + fallbacks; this
// function only adds auth + per-user quota. Dev/owner builds bypass all of this
// (fivem-studio-lwt) and call Anthropic directly.
//
// Secrets (supabase secrets set ...): AI_GATEWAY_API_KEY.
// Auto-injected by the edge runtime: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Requires verify_jwt = false (config.toml) — the token arrives via x-api-key
// (which the platform gate doesn't inspect), so we verify it in-function.
import "@supabase/functions-js/edge-runtime.d.ts";
import { requireEnv } from "../_shared/env.ts";
import { validateSupabaseJWT } from "../_shared/supabase-auth.ts";

// Unified Vercel AI Gateway endpoint (AI SDK `createGateway` provider posts here).
// Multi-provider: the gateway routes by the body's `provider/model` id and preserves
// each provider's caching (Anthropic cache_control forwarded; OpenAI auto). Optional
// override via env.
const GATEWAY_URL =
  Deno.env.get("AI_GATEWAY_URL") ?? "https://ai-gateway.vercel.sh/v3/ai/language-model";
// Embedding endpoint (semantic recall). The AI SDK gateway provider posts
// embeddings to `${baseURL}/embedding-model` and chat to `${baseURL}/language-model`,
// so the client points at this function's base and we route by the request path.
const EMBED_URL =
  Deno.env.get("AI_GATEWAY_EMBED_URL") ?? "https://ai-gateway.vercel.sh/v3/ai/embedding-model";
// Accept either name: the hosted secret may be set as AI_GATEWAY_API_KEY or, to
// match the Infisical convention, VERCEL_GATEWAY_KEY (the client uses the same
// fallback). Reconciles the gateway key-name mismatch (fivem-studio-irx gap #1).
const GATEWAY_KEY = Deno.env.get("AI_GATEWAY_API_KEY") ?? Deno.env.get("VERCEL_GATEWAY_KEY") ?? "";
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-api-key, apikey, x-myrp-memory-op",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Supabase JWT verification lives in ../_shared/supabase-auth.ts.

// --- Supabase quota RPCs (service role), ported from worker/src/supabase.ts ---
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface WorkspacePlan {
  workspace_id: string;
  plan: "free" | "starter" | "pro" | "studio";
  usage_count: number;
  usage_limit: number;
  can_generate: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!GATEWAY_KEY) {
    return json(
      { error: "gateway key not configured (set AI_GATEWAY_API_KEY or VERCEL_GATEWAY_KEY)" },
      500,
    );
  }

  // 1. Auth — the AI SDK Anthropic provider sends the Supabase access token as
  // x-api-key; also accept Authorization: Bearer as a fallback.
  const auth = req.headers.get("authorization") ?? "";
  const token = req.headers.get("x-api-key") ?? (auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!token) return json({ error: "missing api key (x-api-key / bearer token)" }, 401);
  let userId: string;
  try {
    userId = (await validateSupabaseJWT(token)).sub;
  } catch (err) {
    return json({ error: `auth failed: ${(err as Error).message}` }, 401);
  }

  // Classify: embeddings (semantic recall) hit /embedding-model; the OM observer
  // marks its language-model calls with x-myrp-memory-op. Both are FREE internal
  // memory infra — authenticated, but never quota-gated or metered (z8j8.5).
  const isEmbedding = new URL(req.url).pathname.endsWith("/embedding-model");
  const isMemoryOp = isEmbedding || req.headers.get("x-myrp-memory-op") === "1";

  // 2. Quota — resolve the user's workspace plan + usage (gate skipped for memory ops).
  let workspaceId: string;
  try {
    const rows = await rpc<WorkspacePlan[]>("get_user_workspace_plan", { p_user_id: userId });
    const info = rows?.[0];
    if (!info) return json({ error: "user not found — sign in to FiveM Studio first" }, 403);
    if (!isMemoryOp && !info.can_generate) {
      return json(
        {
          error: `Usage limit reached (${info.usage_count}/${info.usage_limit}). ${
            info.plan === "free" ? "Upgrade to Pro for more generations." : "Usage resets monthly."
          }`,
        },
        429,
      );
    }
    workspaceId = info.workspace_id;
  } catch (err) {
    return json({ error: `quota check failed: ${(err as Error).message}` }, 500);
  }

  // 3. Reverse-proxy to the gateway with OUR key, streaming the response back.
  // Forward the client's headers so the AI SDK gateway-provider protocol headers
  // (ai-gateway-*, ai-language-model-*) survive; only SWAP the caller's Supabase
  // token for our gateway key and drop the Supabase-specific auth headers.
  const body = await req.text();
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${GATEWAY_KEY}`);
  headers.delete("x-api-key");
  headers.delete("apikey");
  headers.delete("x-myrp-memory-op");
  headers.delete("host");
  headers.delete("content-length");
  const upstream = await fetch(isEmbedding ? EMBED_URL : GATEWAY_URL, {
    method: "POST",
    headers,
    body,
  });

  // 4. Count one generation for MAIN generations only — memory ops are free infra.
  if (upstream.ok && !isMemoryOp) {
    rpc("increment_usage", { p_workspace_id: workspaceId }).catch((e) =>
      console.error("[inference-proxy] increment_usage failed:", e),
    );
  }

  // Stream straight through (SSE for stream:true, JSON otherwise).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS,
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
});
