import { test } from "@playwright/test";

// The packaged-exe prod-flow E2E suite is being rebuilt against the current
// Supabase Discord auth flow. Until it lands, this tier has no active specs —
// the standard quality gate (`npm run typecheck && npm run check && npm test`)
// does not include E2E. See CONTRIBUTING.md and the open issues.
test.skip("prod-flow E2E suite — rebuilding against Supabase auth", () => {});
