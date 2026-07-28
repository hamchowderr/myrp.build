// observability-proxy — the thin PROD telemetry hop.
//
// Flow: the desktop client's MastraPlatformExporter (prod build) batches spans and
// POSTs them here with the user's Supabase session token as the bearer. We verify
// that token and reverse-proxy the batch to Mastra Platform with OUR platform token,
// which is never shipped to the client. Same shape as `inference-proxy` does for the
// gateway key — the client only ever holds its own JWT.
//
// Why a proxy at all: MastraPlatformExporter authenticates with a single
// `Authorization: Bearer` header and takes no custom-header option, so the token it
// sends is the only credential in play. Pointing it straight at Mastra would mean
// shipping the platform token inside the app, which the no-shipped-creds rule
// forbids. Pointing it here costs one hop and keeps the token server-side.
//
// The exporter's `tracesEndpoint` accepts a full publish URL and derives the other
// signals by swapping the suffix, so the client is configured with
// `<this function>/spans/publish` and we receive all five signal paths below.
//
// Secrets (supabase secrets set ...): MASTRA_PLATFORM_ACCESS_TOKEN.
//   Optional: MASTRA_PLATFORM_PROJECT_ID, MASTRA_PLATFORM_URL.
// Auto-injected by the edge runtime: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Requires verify_jwt = false (config.toml): we verify in-function so we can return
// a clean JSON error and so a rejected token never counts against the user's run.
import "@supabase/functions-js/edge-runtime.d.ts";
import { bearerToken, validateSupabaseJWT } from "../_shared/supabase-auth.ts";

const PLATFORM_URL = Deno.env.get("MASTRA_PLATFORM_URL") ?? "https://observability.mastra.ai";
const PLATFORM_TOKEN = Deno.env.get("MASTRA_PLATFORM_ACCESS_TOKEN") ?? "";
const PROJECT_ID = Deno.env.get("MASTRA_PLATFORM_PROJECT_ID") ?? "";

/** The signals Mastra publishes. Anything else is rejected rather than forwarded. */
const SIGNALS = new Set(["spans", "logs", "metrics", "scores", "feedback"]);

/**
 * Hard cap on a forwarded batch. The exporter batches on its own, so a legitimate
 * body is far under this; the cap exists because this endpoint is reachable by any
 * signed-in user and telemetry spend is ours, not theirs.
 */
const MAX_BODY_BYTES = 1_000_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/**
 * Map our public subpath to Mastra's publish path.
 * `/…/observability-proxy/spans/publish` -> `/ai/spans/publish`, or
 * `/projects/<id>/ai/spans/publish` when a project is configured.
 */
function upstreamPath(pathname: string): string | undefined {
  const m = pathname.match(/\/([a-z]+)\/publish\/?$/);
  const signal = m?.[1];
  if (!signal || !SIGNALS.has(signal)) return undefined;
  return PROJECT_ID ? `/projects/${PROJECT_ID}/ai/${signal}/publish` : `/ai/${signal}/publish`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Not configured — tell the client plainly rather than failing opaquely. Tracing
  // must never look "broken" in a way that implies the generation itself failed.
  if (!PLATFORM_TOKEN) return json({ error: "observability not configured" }, 501);

  const target = upstreamPath(new URL(req.url).pathname);
  if (!target) return json({ error: "unknown signal" }, 404);

  // The caller must be a real signed-in user. We never trust the body's identity.
  try {
    await validateSupabaseJWT(bearerToken(req));
  } catch {
    return json({ error: "unauthorized" }, 401);
  }

  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);

  try {
    const upstream = await fetch(`${PLATFORM_URL}${target}`, {
      method: "POST",
      headers: {
        // OUR token — swapped in here, never present in the client.
        Authorization: `Bearer ${PLATFORM_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    });
    // Pass the status through so the exporter's retry/backoff behaves normally, but
    // never echo the upstream body — it is not the client's, and an auth error from
    // Mastra must not leak anything about our account.
    return upstream.ok
      ? json({ ok: true }, 200)
      : json({ error: "upstream rejected", status: upstream.status }, upstream.status);
  } catch {
    return json({ error: "upstream unreachable" }, 502);
  }
});
