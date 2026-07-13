/**
 * Auth bootstrap — Discord sign-in loopback + encrypted auth store.
 *
 * Behavior-preserving extraction from src/main/index.ts. Registers the
 * `auth:start-signin` loopback and the `auth:store:*` IPC handlers exactly as
 * before; call registerAuthHandlers() once during app startup.
 *
 * Discord sign-in via system browser + loopback (RFC 8252 native-app pattern),
 * native Supabase Auth + PKCE.
 *
 * An Electron renderer can't host the provider redirect, so OAuth runs entirely
 * in the user's real system browser:
 *
 *   renderer → auth:start-signin → main starts a one-shot 127.0.0.1 loopback
 *   server and RETURNS its redirect URI. The renderer calls
 *   supabase.auth.signInWithOAuth({ provider:'discord', skipBrowserRedirect:true,
 *   redirectTo:<loopback>/cb }) — which also stores the PKCE code_verifier in the
 *   persistent auth store — then opens the returned authorize URL via
 *   shell.openExternal. Discord → the local Supabase /auth/v1/callback → redirect
 *   to the loopback with ?code=… . Main captures the code, forwards it to the
 *   renderer on auth:signin-code, and the renderer finishes via
 *   exchangeCodeForSession(). Loopback (not myrpbuild://) avoids the dev
 *   single-instance problem and works identically in dev + packaged builds.
 *
 * No external hand-off page is needed anymore — native Supabase OAuth completes
 * against the Supabase auth callback directly, so the Cloudflare worker +
 * mint-signin-token edge fn are retired (Phase 6 cleanup).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { app, ipcMain, safeStorage } from "electron";
import log from "electron-log/main";
import { state } from "../shared-state";

const SIGNIN_RETURN_HTML = (ok: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>myRP.build — ${ok ? "Signed in" : "Sign-in error"}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background:#0a0a0b; color:#e7e7ea; }
  .card { width:min(420px,92vw); padding:40px 32px; text-align:center;
    background:#141416; border:1px solid #26262b; border-radius:16px; }
  h1 { font-size:20px; margin:0 0 8px; font-weight:650; }
  p { margin:0; font-size:14px; line-height:1.5; color:#a1a1aa; }
</style></head><body><div class="card">
  <h1>${ok ? "You're signed in 🎉" : "Something went wrong"}</h1>
  <p>${ok ? "Return to myRP.build — you can close this tab." : "Please return to myRP.build and try again. You can close this tab."}</p>
</div></body></html>`;

let signInServer: Server | undefined;
let signInTimer: ReturnType<typeof setTimeout> | undefined;
function stopSignInServer(): void {
  if (signInTimer) {
    clearTimeout(signInTimer);
    signInTimer = undefined;
  }
  if (signInServer) {
    signInServer.close();
    signInServer = undefined;
  }
}

// Persistent, encrypted store backing the renderer's Supabase Auth client.
// The session + PKCE code_verifier are kept in a single JSON
// blob encrypted with Electron safeStorage (OS keychain/DPAPI) under userData, so
// they survive reload, the >60s token refresh, and full app relaunch — the exact
// persistence the prior in-memory auth lacked here. If safeStorage has no backend (rare on Windows,
// our target), we fall back to plaintext + a warning rather than losing auth.
const AUTH_STORE_PATH = (): string => join(app.getPath("userData"), "auth-store.bin");
let authStoreCache: Record<string, string> | null = null;
let warnedNoEncryption = false;

function loadAuthStore(): Record<string, string> {
  if (authStoreCache) return authStoreCache;
  try {
    if (existsSync(AUTH_STORE_PATH())) {
      const raw = readFileSync(AUTH_STORE_PATH());
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString("utf-8");
      authStoreCache = JSON.parse(json) as Record<string, string>;
    } else {
      authStoreCache = {};
    }
  } catch (err) {
    log.error("[auth-store] failed to read; starting empty:", err);
    authStoreCache = {};
  }
  return authStoreCache;
}

function saveAuthStore(store: Record<string, string>): void {
  const json = JSON.stringify(store);
  const encrypt = safeStorage.isEncryptionAvailable();
  if (!encrypt && !warnedNoEncryption) {
    warnedNoEncryption = true;
    log.warn("[auth-store] safeStorage unavailable — persisting auth tokens in PLAINTEXT.");
  }
  const buf = encrypt ? safeStorage.encryptString(json) : Buffer.from(json, "utf-8");
  writeFileSync(AUTH_STORE_PATH(), buf);
}

// Main-process accessors for the SAME encrypted auth-store.bin used by the
// renderer's Supabase session. Lets other main modules persist a secret without
// a second keychain file — e.g. the GitHub backup token,
// which must live in main (git push runs here) and must NEVER touch the database.
export function getStoredSecret(key: string): string | null {
  return loadAuthStore()[key] ?? null;
}
export function setStoredSecret(key: string, value: string): void {
  const store = loadAuthStore();
  store[key] = value;
  saveAuthStore(store);
}
export function removeStoredSecret(key: string): void {
  const store = loadAuthStore();
  delete store[key];
  saveAuthStore(store);
}

/** Register the sign-in loopback + encrypted auth-store IPC handlers. */
export function registerAuthHandlers(): void {
  ipcMain.handle("auth:start-signin", async (): Promise<string> => {
    // Tear down any prior in-flight attempt (re-click, or abandoned tab).
    stopSignInServer();
    return await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
          if (reqUrl.pathname !== "/cb") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found");
            return;
          }
          const code = reqUrl.searchParams.get("code");
          const errParam =
            reqUrl.searchParams.get("error_description") ?? reqUrl.searchParams.get("error");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(SIGNIN_RETURN_HTML(!!code));
          const main = state.mainWindow;
          if (code && main && !main.isDestroyed()) {
            log.info("[signin] loopback captured OAuth code, forwarding to renderer");
            if (main.isMinimized()) main.restore();
            main.focus();
            main.webContents.send("auth:signin-code", code);
          } else {
            log.warn("[signin] loopback hit without a code", errParam ? `(${errParam})` : "");
          }
        } catch (err) {
          log.error("[signin] loopback handler error:", err);
          try {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("error");
          } catch {}
        } finally {
          stopSignInServer();
        }
      });
      server.on("error", (err) => {
        log.error("[signin] loopback server error:", err);
        stopSignInServer();
        reject(err);
      });
      // Ephemeral port on loopback only — the loopback merely RECEIVES the OAuth
      // code; the PKCE exchange happens in the renderer's Supabase client. The
      // `http://127.0.0.1:*` wildcard in supabase/config.toml allows this redirect.
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        signInServer = server;
        // Abandon the attempt if the user never returns (frees the port).
        signInTimer = setTimeout(() => {
          log.warn("[signin] loopback timed out (no callback within 5m)");
          stopSignInServer();
        }, 5 * 60_000);
        const cb = `http://127.0.0.1:${port}/cb`;
        log.info("[signin] loopback ready; awaiting OAuth code at", cb);
        resolve(cb);
      });
    });
  });

  ipcMain.handle(
    "auth:store:get",
    (_e, key: string): string | null => loadAuthStore()[key] ?? null,
  );
  ipcMain.handle("auth:store:set", (_e, key: string, value: string): void => {
    const store = loadAuthStore();
    store[key] = value;
    saveAuthStore(store);
  });
  ipcMain.handle("auth:store:remove", (_e, key: string): void => {
    const store = loadAuthStore();
    delete store[key];
    saveAuthStore(store);
  });
}
