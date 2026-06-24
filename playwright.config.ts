import { defineConfig } from "@playwright/test";

// Playwright config scoped to the Electron prod-flow harness (tests/e2e/*).
// Vitest still owns tests/unit/, tests/visual/, tests/eval/, tests/fxdk/, etc.
//
// `npm run test:e2e` drives this. It launches `dist/win-unpacked/myRP.build.exe`
// directly (via _electron.launch in the specs) — there is no dev server to start,
// so testDir is just the spec directory and we don't define webServer.
//
// Build the binary first: `npm run build:unpack:nosign`.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // Electron tests bind real Windows resources — serialize
  workers: 1,
  reporter: [["list"]],
  timeout: 90_000, // packaged Electron cold-start + Clerk mount can be ~10s
  use: {
    trace: "on-first-retry",
  },
});
