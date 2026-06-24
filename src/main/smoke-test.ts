/**
 * Deploy & smoke-test (fivem-studio-m7f / epic 5hx).
 *
 * The automated half of "official" in-FiveM testing: deploy a generated resource
 * to the running FXServer via RCON, then scan the server console for the
 * asynchronous load result (Lua errors, missing deps, parse failures) and return
 * a structured pass/fail — NO game client, NO approval gate. Catches the majority
 * of "the agent generated something that won't load" failures.
 *
 * Why separate from the agent's `deploy_resource` tool: that tool is
 * approval-gated and only inspects the SYNCHRONOUS RCON reply. The real load
 * errors (Lua syntax/runtime) appear on the FXServer stdout AFTER `ensure`
 * returns, so we snapshot the console buffer, send `ensure`, then poll the buffer
 * for new lines and scan them (scanConsoleForLoadErrors). In-client gameplay
 * testing (Tier 4) stays manual.
 */
import type { SmokeAllResult, SmokeResourceResult, SmokeResult } from "../renderer/src/lib/types";
import { sendRconCommand } from "./auto-deploy";
import { fxdkSession } from "./shared-state";
import { type ConsoleScanResult, scanConsoleForLoadErrors } from "./smoke-scan";

export { LOAD_ERROR_PATTERNS, scanConsoleForLoadErrors } from "./smoke-scan";
export type { SmokeResult };

/**
 * Deploy `resourceName` to the running FXServer and verify it loads cleanly.
 *
 * refresh → ensure → poll the console buffer for up to `waitMs`, scanning new
 * lines for load errors (resolves early on the first error). Reuses the live
 * FxDkSession console buffer (same one the UI shows).
 */
export async function deployAndVerifyResource(
  resourceName: string,
  port: number,
  rconPassword: string,
  waitMs = 8000,
): Promise<SmokeResult> {
  const fail = (loadError: string, deployed = false): SmokeResult => ({
    ok: false,
    deployed,
    loadSuccess: false,
    startedConfirmed: false,
    loadError,
    secondsWaited: 0,
  });
  if (!rconPassword) return fail("RCON password not configured (Settings → server).");

  const before = fxdkSession.getConsoleBuffer().length;
  // refresh so the server discovers newly written files, then ensure it.
  await sendRconCommand(port, rconPassword, "refresh");
  await new Promise((r) => setTimeout(r, 500));
  const ensure = await sendRconCommand(port, rconPassword, `ensure ${resourceName}`);
  if (!ensure.ok) return fail(ensure.error ?? "ensure failed — is the server running?", false);

  const start = Date.now();
  let scan: ConsoleScanResult = { loadSuccess: true, startedConfirmed: false };
  while (Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 250));
    scan = scanConsoleForLoadErrors(fxdkSession.getConsoleBuffer().slice(before), resourceName);
    if (!scan.loadSuccess) break; // fail fast on first error
  }
  return {
    ok: scan.loadSuccess,
    deployed: true,
    loadSuccess: scan.loadSuccess,
    startedConfirmed: scan.startedConfirmed,
    loadError: scan.loadError,
    matchedPattern: scan.matchedPattern,
    consoleSnippet: scan.snippet,
    secondsWaited: Math.round((Date.now() - start) / 100) / 10,
  };
}

/**
 * Deploy + smoke-test EVERY built resource in one pass (the "full test").
 *
 * One `refresh` so the server picks up all newly written files, then `ensure`
 * each resource (idempotent; already-loaded ones just re-affirm), wait a single
 * window for the asynchronous load output to flush, and scan that one console
 * slice per resource. Far faster than looping deployAndVerifyResource (which
 * refreshes + waits 8s each): ~one refresh + N quick ensures + one scan window.
 */
export async function deployAndVerifyAll(
  resourceNames: string[],
  port: number,
  rconPassword: string,
  scanMs = 5000,
): Promise<SmokeAllResult> {
  const row = (resource: string, loadError: string): SmokeResourceResult => ({
    resource,
    ok: false,
    deployed: false,
    loadSuccess: false,
    startedConfirmed: false,
    loadError,
    secondsWaited: 0,
  });
  if (resourceNames.length === 0) return { ok: true, results: [] };
  if (!rconPassword) {
    return {
      ok: false,
      results: resourceNames.map((r) =>
        row(r, "RCON password not configured (Settings → server)."),
      ),
    };
  }

  await sendRconCommand(port, rconPassword, "refresh");
  await new Promise((r) => setTimeout(r, 600));

  const before = fxdkSession.getConsoleBuffer().length;
  // Fire every `ensure` concurrently — each RCON call can wait up to RCON_TIMEOUT_MS
  // (5s) for a reply, so sequential would be 5s × N in the worst case (e.g. a bad
  // rcon_password makes EVERY call time out). Concurrent bounds the deploy phase to
  // ~one timeout regardless of resource count.
  const ensureErrors = new Map<string, string>();
  await Promise.all(
    resourceNames.map(async (name) => {
      const ensure = await sendRconCommand(port, rconPassword, `ensure ${name}`);
      if (!ensure.ok) {
        ensureErrors.set(name, ensure.error ?? "ensure failed — is the server running?");
      }
    }),
  );

  // Let the async load output flush, then scan the single slice per resource.
  await new Promise((r) => setTimeout(r, scanMs));
  const buf = fxdkSession.getConsoleBuffer().slice(before);
  const seconds = Math.round(scanMs / 100) / 10;

  const results: SmokeResourceResult[] = resourceNames.map((resource) => {
    const ensureErr = ensureErrors.get(resource);
    if (ensureErr) return { ...row(resource, ensureErr), secondsWaited: seconds };
    const scan = scanConsoleForLoadErrors(buf, resource);
    return {
      resource,
      ok: scan.loadSuccess,
      deployed: true,
      loadSuccess: scan.loadSuccess,
      startedConfirmed: scan.startedConfirmed,
      loadError: scan.loadError,
      matchedPattern: scan.matchedPattern,
      consoleSnippet: scan.snippet,
      secondsWaited: seconds,
    };
  });
  return { ok: results.every((r) => r.ok), results };
}
