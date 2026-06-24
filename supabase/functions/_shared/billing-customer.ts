// Shared "get a valid Stripe customer for a workspace" helper, with self-healing
// for stale/deleted customer references (fivem-studio-cxd).
//
// billing_customers may hold a gateway_customer_id that no longer exists in the
// ACTIVE Stripe account — e.g. after a test->live cutover or an account switch
// (the id was minted under a different account), or if the customer was deleted
// in the dashboard. Using it blindly makes Stripe return "No such customer"
// (resource_missing) and create-portal / create-checkout 500. So: look up the
// stored id, verify it still resolves, and if it's missing/deleted, mint a fresh
// customer and persist it via the same RPC.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type Stripe from "npm:stripe@17.7.0";
import type { Database } from "../../../src/types/database.ts";

export async function getOrCreateCustomer(
  stripe: Stripe,
  supabase: SupabaseClient<Database>,
  workspace_id: string,
  email?: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from("billing_customers")
    .select("gateway_customer_id")
    .eq("workspace_id", workspace_id)
    .maybeSingle();

  const storedId = existing?.gateway_customer_id as string | undefined;
  if (storedId) {
    try {
      const c = await stripe.customers.retrieve(storedId);
      // A deleted customer resolves with { deleted: true } (no throw) — treat as
      // invalid and re-mint. A valid customer is good to use as-is.
      if (!(c as { deleted?: boolean }).deleted) return storedId;
    } catch (err) {
      // Only self-heal on resource_missing ("No such customer"). Rethrow other
      // errors (auth, rate limit) so real failures aren't masked.
      if ((err as { code?: string }).code !== "resource_missing") throw err;
    }
  }

  // Mint a fresh customer in the active account and persist it (replaces any
  // stale row via the upsert in ensure_billing_customer).
  const customer = await stripe.customers.create({ email, metadata: { workspace_id } });
  const { error } = await supabase.rpc("ensure_billing_customer", {
    p_workspace_id: workspace_id,
    p_customer_id: customer.id,
    p_email: email ?? null,
  });
  if (error) throw error;
  return customer.id;
}
