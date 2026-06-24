// Stripe webhook → Supabase (replaces convex/http.ts). Verifies the signature and
// upserts the workspace's subscription via the update_subscription RPC (service
// role bypasses RLS). Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (set via
// `supabase secrets set`); SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected.
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";
import type { Database } from "../../../src/types/database.ts";
import { requireEnv } from "../_shared/env.ts";

const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
  apiVersion: "2025-02-24.acacia",
});
const supabase = createClient<Database>(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
);
const webhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");

// Map a Stripe price id -> plan name. Unknown/absent price on an active sub falls
// back to 'pro' (they paid for something). Starter/Studio are optional so the loop
// still works if only Pro is configured.
const PRICE_TO_PLAN = new Map<string, string>(
  [
    [Deno.env.get("STRIPE_STARTER_PRICE_ID"), "starter"],
    [Deno.env.get("STRIPE_PRO_PRICE_ID"), "pro"],
    [Deno.env.get("STRIPE_STUDIO_PRICE_ID"), "studio"],
  ].filter((e): e is [string, string] => Boolean(e[0])),
);
const planForPrice = (priceId?: string) => (priceId && PRICE_TO_PLAN.get(priceId)) || "pro";

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing stripe-signature", { status: 400 });

  let event: Stripe.Event;
  try {
    // constructEventAsync: Deno uses async (WebCrypto) signature verification.
    event = await stripe.webhooks.constructEventAsync(await req.text(), sig, webhookSecret);
  } catch (err) {
    return new Response(`invalid signature: ${(err as Error).message}`, {
      status: 400,
    });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const item = sub.items.data[0];
        const toIso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
        // current_period_* live on the Subscription in the 2025-02-24.acacia API
        // shape (stripe@17.7.0), not on the SubscriptionItem (fivem-studio-6az).
        const { error } = await supabase.rpc("update_subscription", {
          p_customer_id: customerId,
          p_subscription_id: sub.id,
          p_status: sub.status,
          p_plan: planForPrice(item?.price?.id),
          p_period_start: toIso(sub.current_period_start),
          p_period_end: toIso(sub.current_period_end),
          p_cancel_at_period_end: sub.cancel_at_period_end,
        });
        if (error) throw error;
        break;
      }
      default:
        break; // ignore other events
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    return new Response("webhook handler error", { status: 500 });
  }
});
