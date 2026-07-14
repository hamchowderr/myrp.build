// create-portal → Stripe billing portal session for a WORKSPACE (replaces
// convex/stripe.ts createPortalSession). Finds OR creates the workspace's Stripe
// customer (so comped/owner accounts that never checked out can still open the
// portal — tc6) and returns the portal URL. Secrets: STRIPE_SECRET_KEY, STRIPE_RETURN_URL.
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
const RETURN_URL = requireEnv("STRIPE_RETURN_URL");

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
    // verify_jwt=false → verify the Supabase token here, then authorize the workspace.
    let userId: string;
    try {
      userId = (await validateSupabaseJWT(bearerToken(req))).sub;
    } catch (err) {
      return json({ error: `auth failed: ${(err as Error).message}` }, 401);
    }
    const { workspace_id: requested, email } = await req.json();
    const { data: planRows } = await supabase.rpc("get_user_workspace_plan", {
      p_user_id: userId,
      p_workspace_id: requested ?? null,
    });
    const workspace_id = (planRows as Array<{ workspace_id: string }>)?.[0]?.workspace_id;
    if (!workspace_id) return json({ error: "user not provisioned" }, 403);

    // Owner-only: billing is managed solely by the workspace owner. The user always
    // owns their personal workspace; team developers cannot open a team's portal.
    const { data: member } = await supabase
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (member?.role !== "owner") {
      return json({ error: "only the workspace owner can manage billing" }, 403);
    }

    // Get a VALID Stripe customer, self-healing a stale/deleted reference.
    // Covers comped/owner accounts (mint on demand so the
    // 'Manage' button never 404s, tc6) AND the test->live / account-switch case
    // where the stored id no longer exists in the active account.
    const customerId = await getOrCreateCustomer(stripe, supabase, workspace_id, email);

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: RETURN_URL,
    });
    return json({ url: session.url });
  } catch (err) {
    console.error("[create-portal] error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
