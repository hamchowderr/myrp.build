/**
 * The prices shown in Settings must match what Stripe actually charges.
 *
 * They drifted once: this list read $15/$25/$60 while the live Stripe prices were
 * $29/$79/$199, so clicking "$15/mo" opened a checkout for $29. Found by the owner
 * on the first real checkout attempt (2026-07-31).
 *
 * A unit test cannot reach Stripe, so this PINS the strings instead: any change
 * has to be deliberate and shows up in review next to the Stripe price IDs. The
 * durable fix is to read prices from Stripe at runtime so the app can never quote
 * a number it is not about to charge — tracked separately.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(__dirname, "../../src/renderer/src/screens/settings/SubscriptionSection.tsx"),
  "utf-8",
);

/** Live Stripe prices, verified 2026-07-31 against STRIPE_<TIER>_PRICE_ID. */
const EXPECTED = [
  { tier: "starter", price: "$29/mo", gens: "100 generations" },
  { tier: "pro", price: "$79/mo", gens: "500 generations" },
  { tier: "studio", price: "$199/mo", gens: "2,500 generations" },
];

describe("subscription tier display", () => {
  for (const { tier, price, gens } of EXPECTED) {
    it(`${tier} shows ${price} and ${gens}`, () => {
      const row = SRC.split("\n").find((l) => l.includes(`tier: "${tier}"`));
      expect(row, `no row for tier "${tier}"`).toBeTruthy();
      expect(row).toContain(price);
      expect(row).toContain(gens);
    });
  }

  it("shows no stale price from the old tier set", () => {
    // The exact numbers that were live in the UI while Stripe charged more.
    for (const stale of ["$15/mo", "$25/mo", "$60/mo"]) {
      const inTierRow = SRC.split("\n")
        .filter((l) => l.includes("tier:"))
        .some((l) => l.includes(stale));
      expect(inTierRow, `stale price ${stale} is being displayed`).toBe(false);
    }
  });

  it("generation counts match plan_limit() in the database", () => {
    // supabase/migrations/20260712000004_functions_core.sql — starter 100,
    // pro 500, studio 2500. A mismatch here overstates what the user is buying.
    const limits = readFileSync(
      join(__dirname, "../../supabase/migrations/20260712000004_functions_core.sql"),
      "utf-8",
    );
    expect(limits).toMatch(/when 'starter' then 100/);
    expect(limits).toMatch(/when 'pro'\s+then 500/);
    expect(limits).toMatch(/when 'studio'\s+then 2500/);
  });
});
