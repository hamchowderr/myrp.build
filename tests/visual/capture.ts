/* Attach to the running, signed-in dev app over CDP and capture the live
 * generation stream as a sequence of screenshots.
 *
 * Prereq: dev app running with --remote-debugging-port=9222 (is.dev switch in
 * main/index.ts). Run: npx tsx tests/visual/capture.ts "<prompt>"
 *
 * Docs: playwright chromium.connectOverCDP + electron --remote-debugging-port.
 * NOTE: this triggers a REAL generation (model spend).
 */

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const SHOTS = `${process.cwd()}/tests/visual/shots`;
const PROMPT = process.argv[2] ?? "a simple /heal command resource for ox_core";
const DURATION_MS = 60_000;
const INTERVAL_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, "0");

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const context = browser.contexts()[0];
  // The renderer window is the localhost:5173 page (skip devtools targets).
  const pages = context.pages();
  const page = pages.find((p) => p.url().startsWith("http://localhost")) ?? pages[0];
  console.log("attached to:", page.url());
  await page.bringToFront().catch(() => {});

  // Opt into the AI-Elements chat when AE=1.
  if (process.env.AE === "1") {
    await page.evaluate(() => localStorage.setItem("ae-chat", "1"));
    await page.reload();
    console.log("ae-chat flag set + reloaded");
  }

  let i = 0;
  const shot = async (label: string) => {
    const file = `${SHOTS}/${pad(i++)}_${label}.png`;
    await page.screenshot({ path: file });
    console.log("  📸", file);
  };

  await shot("baseline");

  // Smoke check: just confirm the UI loaded (no model spend).
  if (process.env.NOSEND === "1") {
    console.log("NOSEND — baseline only, no generation");
    await browser.close();
    process.exit(0);
  }

  // Find the prompt textarea by its placeholder and send.
  const ta = page.getByPlaceholder(/Describe the resource to generate/i);
  await ta.waitFor({ timeout: 10_000 });
  await ta.fill(PROMPT);
  await shot("typed");
  // Ctrl+Enter submits (see ChatInput.handleKeyDown).
  await ta.press("Control+Enter");
  console.log(`sent: "${PROMPT}" — capturing every ${INTERVAL_MS}ms`);

  const start = Date.now();
  while (Date.now() - start < DURATION_MS) {
    await sleep(INTERVAL_MS);
    await shot(`t${Math.round((Date.now() - start) / 1000)}s`);
  }

  await shot("final");
  await browser.close(); // detaches CDP; does NOT close the app
  console.log("done — screenshots in", SHOTS);
  process.exit(0);
})();
