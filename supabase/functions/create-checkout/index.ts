// create-checkout → Stripe Checkout session for a WORKSPACE (replaces
// convex/stripe.ts createCheckoutSession). Finds/creates the workspace's Stripe
// customer, records it via ensure_billing_customer, returns the checkout URL.
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRO_PRICE_ID, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";
import type { Database } from "../../../src/types/database.ts";
import { getOrCreateCustomer } from "../_shared/billing-customer.ts";
import { requireEnv } from "../_shared/env.ts";
import { bearerToken, validateSupabaseJWT } from "../_shared/supabase-auth.ts";

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-02-24.acacia",
});
const supabase = createClient<Database>(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
);
const SUCCESS_URL = requireEnv("STRIPE_SUCCESS_URL");
const CANCEL_URL = requireEnv("STRIPE_CANCEL_URL");

// tier -> price id. Pro is required; Starter/Studio optional. The caller sends a
// tier name (never a raw price id), so only configured tiers can be purchased.
const TIER_PRICE: Record<string, string | undefined> = {
  starter: Deno.env.get("STRIPE_STARTER_PRICE_ID"),
  pro: requireEnv("STRIPE_PRO_PRICE_ID"),
  studio: Deno.env.get("STRIPE_STUDIO_PRICE_ID"),
};
const priceForTier = (tier?: string): string => {
  const t = tier ?? "pro";
  const price = TIER_PRICE[t];
  if (!price) throw new Error(`unknown or unconfigured tier: ${t}`);
  return price;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // verify_jwt=false → verify the Supabase token here, then authorize the
    // workspace via the RPC (returns the caller's authorized workspace; ignores a
    // spoofed id).
    let userId: string;
    try {
      userId = (await validateSupabaseJWT(bearerToken(req))).sub;
    } catch (err) {
      return json({ error: `auth failed: ${(err as Error).message}` }, 401);
    }
    const { workspace_id: requested, email, tier } = await req.json();
    let priceId: string;
    try {
      priceId = priceForTier(tier);
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
    const { data: planRows } = await supabase.rpc("get_user_workspace_plan", {
      p_user_id: userId,
      p_workspace_id: requested ?? null,
    });
    const workspace_id = (planRows as Array<{ workspace_id: string }>)?.[0]?.workspace_id;
    if (!workspace_id) return json({ error: "user not provisioned" }, 403);

    // Owner-only: billing is managed solely by the workspace owner. The user always
    // owns their personal workspace; team developers cannot start a team's checkout.
    const { data: member } = await supabase
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (member?.role !== "owner") {
      return json({ error: "only the workspace owner can manage billing" }, 403);
    }

    // Self-healing valid customer — same as create-portal.
    const customerId = await getOrCreateCustomer(stripe, supabase, workspace_id, email);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { workspace_id },
    });
    return json({ url: session.url });
  } catch (err) {
    console.error("[create-checkout] error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
