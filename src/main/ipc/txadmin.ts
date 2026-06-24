/**
 * IPC handlers for txAdmin REST control — server restart button (fivem-studio-zdy)
 * and resource-manager live controls (fivem-studio-myn).
 *
 * Reads connection config (url/username/password) from AppSettings on each call
 * so the latest Settings are always used. The client caches the txAdmin session
 * per base URL, so only the first call per session performs the password login.
 */

import { ipcMain } from "electron";
import { getActiveServer } from "../../renderer/src/lib/server-registry";
import { readSettings } from "../shared-state";
import {
  clearHarvestedSession,
  hasHarvestedSession,
  type TxAdminConfig,
  txAdminCommand,
  txAdminControl,
  txAdminTestConnection,
} from "../txadmin/client";
import { openTxAdminLogin } from "../txadmin/webview-auth";

// 127.0.0.1 (not localhost): on Windows "localhost" resolves to IPv6 ::1, but
// txAdmin binds IPv4 — so the literal IPv4 loopback is the reliable default.
const DEFAULT_TXADMIN_URL = "http://127.0.0.1:40120";

/** Resolve the configured txAdmin base URL from settings (or the default). */
async function loadBaseUrl(): Promise<string> {
  const server = getActiveServer(await readSettings());
  return (server?.txAdminUrl?.trim() || DEFAULT_TXADMIN_URL).replace(/\/+$/, "");
}

/**
 * Build a TxAdminConfig from settings, or an error if not usable. A harvested
 * webview session (zero-password, dt2) is sufficient on its own — only require
 * a username+password when no harvested session exists for this baseUrl.
 */
async function loadConfig(): Promise<TxAdminConfig | { error: string }> {
  const server = getActiveServer(await readSettings());
  if (!server) {
    return { error: "No settings found — configure txAdmin in Settings first." };
  }
  const baseUrl = (server.txAdminUrl?.trim() || DEFAULT_TXADMIN_URL).replace(/\/+$/, "");
  const username = server.txAdminUsername?.trim() ?? "";
  const password = server.txAdminPassword ?? "";
  // A harvested webview session means we never need a stored password.
  if (!hasHarvestedSession(baseUrl) && (!username || !password)) {
    return {
      error:
        "txAdmin is not signed in — use “Sign in to txAdmin” (Cfx.re, no password) or set a username/password in Settings.",
    };
  }
  return { baseUrl, username: username || undefined, password: password || undefined };
}

export function registerTxAdminHandlers(): void {
  // Whole-server control: restart | stop | start
  ipcMain.handle("txadmin:control", async (_e, action: "restart" | "stop" | "start") => {
    const cfg = await loadConfig();
    if ("error" in cfg) return { ok: false, error: cfg.error };
    return txAdminControl(cfg, action);
  });

  // Is txAdmin actually listening at the configured URL? (fivem-studio-92fh) A
  // direct-launched FXServer has no txAdmin, so the txAdmin-only controls (the
  // whole-server Restart) must hide rather than dead-end on ERR_CONNECTION_REFUSED.
  // Any HTTP response — even a redirect/401 — means it's up; only a refused/timed-
  // out connection means it isn't.
  ipcMain.handle("txadmin:isAvailable", async () => {
    const baseUrl = await loadBaseUrl();
    try {
      const res = await fetch(baseUrl, {
        signal: AbortSignal.timeout(1500),
        redirect: "manual",
      });
      return { available: res.status > 0 };
    } catch {
      return { available: false };
    }
  });

  // Per-resource / console command: restart_res | stop_res | start_res | ensure | refresh
  ipcMain.handle("txadmin:command", async (_e, action: string, parameter?: string) => {
    const cfg = await loadConfig();
    if ("error" in cfg) return { ok: false, error: cfg.error };
    return txAdminCommand(cfg, action, parameter ?? "");
  });

  // Validate the configured credentials + connectivity (for the Settings UI).
  ipcMain.handle("txadmin:testConnection", async () => {
    const cfg = await loadConfig();
    if ("error" in cfg) return { ok: false, error: cfg.error };
    return txAdminTestConnection(cfg);
  });

  // Zero-password login (dt2): open the txAdmin web panel in a window, let the
  // user authenticate (Cfx.re SSO), then harvest the session into the client.
  ipcMain.handle("txadmin:webviewLogin", async () => {
    const baseUrl = await loadBaseUrl();
    return openTxAdminLogin(baseUrl);
  });

  // Sign out of the harvested session (drops the cached cookie + csrf).
  ipcMain.handle("txadmin:webviewLogout", async () => {
    clearHarvestedSession(await loadBaseUrl());
    return { ok: true };
  });

  // Is a zero-password (harvested) session currently active for the configured URL?
  ipcMain.handle("txadmin:hasWebviewSession", async () => {
    return { active: hasHarvestedSession(await loadBaseUrl()) };
  });
}
