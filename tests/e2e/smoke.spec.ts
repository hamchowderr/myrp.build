import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Prod-flow smoke for the packaged Electron app (rewritten off Clerk).
 *
 * Launches the real `dist/win-unpacked/myRP.build.exe` (prod build → `__DEV_BYPASS__`
 * is false, so App.tsx loads AuthApp, not the dev-bypass AppContent) and asserts it
 * cold-starts cleanly into the native **Supabase Discord** auth gate. A fresh exe has
 * no persisted session, so AuthGate (AuthApp.tsx) renders <CustomAuth/> — which we can
 * verify without any network call or completing the external OAuth (the Discord consent
 * screen is interactive + external and isn't automatable here).
 *
 * This is the migration guard: the gate must be Supabase Discord OAuth, NOT Clerk, and
 * NOT the dev-bypass chat surface. Build the binary first: `npm run build:unpack:nosign`.
 */
const EXE = join(process.cwd(), "dist", "win-unpacked", "myRP.build.exe");
const NO_BUILD = `packaged exe not found at ${EXE} — run \`npm run build:unpack:nosign\` first`;

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.skip(!existsSync(EXE), NO_BUILD);
  app = await electron.launch({ executablePath: EXE });
  page = await app.firstWindow();
  // Cold-started packaged Electron can take several seconds to paint the renderer.
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
});

test("boots into the Supabase Discord sign-in gate (prod path, no black screen)", async () => {
  // Renderer actually painted — the asar/CSP/file:// regressions this suite guards
  // against surface as a blank body (see electron-builder.yml fuse notes).
  await expect(page.locator("body")).not.toBeEmpty();

  // The native Supabase Discord OAuth entry point (CustomAuth.tsx).
  const discord = page.getByRole("button", { name: /continue with discord/i });
  await expect(discord).toBeVisible({ timeout: 30_000 });
  await expect(discord).toBeEnabled();

  // Brand + trust copy specific to the sign-in gate — confirms we're on CustomAuth.
  await expect(page.getByText("Sign in to start building")).toBeVisible();
  await expect(page.getByText("AI RESOURCE FORGE")).toBeVisible();
  await expect(page.getByText(/only use Discord to know it's you/i)).toBeVisible();
});

test("does not fall back to Clerk or the dev-bypass surface", async () => {
  // Migration regression guard (Clerk removed): no Clerk chrome anywhere.
  await expect(page.getByText(/clerk/i)).toHaveCount(0);

  // Prod path, not dev-bypass: the owner AppContent chat composer must be absent
  // (dev-bypass would skip auth and render "Describe the resource to generate…").
  await expect(page.getByPlaceholder(/describe the resource/i)).toHaveCount(0);
});
