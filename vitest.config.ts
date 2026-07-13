import { defineConfig } from "vitest/config";

/**
 * Vitest config for the Mastra migration test tier.
 *
 * Node environment — these tests exercise main-process modules (workspace,
 * agent) directly, not the renderer. AIMock provides the deterministic LLM
 * backend (no real Anthropic calls); see tests/setup/aimock.ts.
 *
 * `forks` pool: tests mutate process.env (ANTHROPIC_BASE_URL) and touch the
 * filesystem/sandbox, so isolated child processes are safer than worker threads.
 */
export default defineConfig({
  // `__DEV_BYPASS__` is a build-time literal injected by electron.vite.config.ts's
  // `define` for the shipped app; under Vitest there is no Vite define pass, so we
  // supply it here. `true` represents the dev/owner environment, which is the only
  // context where the dev-only hybrid pgvector path (workspace.ts) is even eligible
  // — letting the hybrid-fallback test (odm) exercise the real connect-probe logic.
  define: {
    __DEV_BYPASS__: "true",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
