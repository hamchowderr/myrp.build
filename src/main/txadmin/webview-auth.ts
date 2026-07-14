/**
 * txAdmin in-app login (zero-password).
 *
 * Opens a real Electron BrowserWindow on a PERSISTENT partition pointed at the
 * txAdmin web panel and lets the user authenticate however they like — in
 * particular via Cfx.re SSO (the "Login with Cfx.re" button), which a headless
 * username/password POST cannot do. Once logged in, we HARVEST the session
 * straight from that Electron session:
 *
 *   - cookies: `session.fromPartition("persist:txadmin").cookies.get({url})`.
 *     Electron returns httpOnly cookies (the koa `sess` + `sess.sig` pair),
 *     which the renderer's document.cookie could not.
 *   - CSRF token: PRIMARY path is to call `GET /auth/self` with the harvested
 *     cookie (verified txAdmin v8.0.1 contract → `{csrfToken}`); this is robust
 *     and version-independent. A best-effort in-page read of
 *     `window.txConsts.preAuth.csrfToken` / `window.txConsts.csrfToken` is kept
 *     only as a defensive fallback and is NOT relied upon.
 *
 * The resulting {cookie, csrfToken} Session is injected into the REST client's
 * cache (setHarvestedSession) so all subsequent control/command writes reuse it
 * with NO stored password. Username/password remains a full fallback.
 *
 * NOTE (honesty): the cookie harvest + `/auth/self` CSRF derivation are the
 * solid, verified parts. The in-page `window.txConsts` fallback shape is
 * txAdmin-version-dependent and is documented as best-effort — see the
 * manual live-verify issue; this has not been exercised against a live txAdmin.
 */

import { BrowserWindow, session as electronSession } from "electron";
import log from "electron-log/main";
import { buildSessionFromCookie, type Session, setHarvestedSession } from "./client";

export const TXADMIN_PARTITION = "persist:txadmin";

export interface WebviewLoginResult {
  ok: boolean;
  /** Identity name from /auth/self on success (for the UI to show). */
  name?: string;
  error?: string;
  /** True if the user closed the window before completing login. */
  cancelled?: boolean;
}

/** Cookie header string for `url` from the txAdmin partition (httpOnly included). */
async function harvestCookieHeader(baseUrl: string): Promise<string | null> {
  const sess = electronSession.fromPartition(TXADMIN_PARTITION);
  const cookies = await sess.cookies.get({ url: baseUrl });
  if (cookies.length === 0) return null;
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Best-effort in-page CSRF read — defensive fallback only. txAdmin exposes the
 * pre-auth token at `window.txConsts.preAuth.csrfToken` (and historically at
 * `window.txConsts.csrfToken`); shape is version-dependent, so failures are
 * swallowed and the caller relies on the /auth/self path instead.
 */
async function readInPageCsrf(win: BrowserWindow): Promise<string | null> {
  try {
    const token = (await win.webContents.executeJavaScript(
      "(window.txConsts && (window.txConsts.preAuth?.csrfToken || window.txConsts.csrfToken)) || null",
      true,
    )) as string | null;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Try to build a harvested Session from the partition's current cookies.
 * Returns null until the user has actually logged in (cookies present AND
 * `/auth/self` reports a non-logout identity with a csrfToken).
 */
async function tryHarvest(
  baseUrl: string,
  win: BrowserWindow,
): Promise<{ session: Session; name?: string } | null> {
  const cookie = await harvestCookieHeader(baseUrl);
  if (!cookie) return null;

  // Primary: derive the CSRF token + identity from /auth/self with the cookie.
  const session = await buildSessionFromCookie(baseUrl, cookie);
  if (session) {
    // Grab the display name too (cheap, same endpoint shape) — non-fatal.
    let name: string | undefined;
    try {
      const res = await fetch(`${baseUrl}/auth/self`, {
        headers: { Cookie: cookie, "Content-Type": "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as { name?: string };
      name = data.name;
    } catch {
      /* name is cosmetic */
    }
    return { session, name };
  }

  // Fallback: cookie exists but /auth/self gave no csrfToken — try the in-page
  // token. Only usable if the cookie still authenticates the eventual writes.
  const inPage = await readInPageCsrf(win);
  if (inPage) return { session: { cookie, csrfToken: inPage } };

  return null;
}

/**
 * Open the txAdmin login window and resolve once a session is harvested (or the
 * user cancels). `baseUrl` must have no trailing slash. On success the session
 * is injected into the REST client cache for the same baseUrl.
 */
export function openTxAdminLogin(baseUrl: string): Promise<WebviewLoginResult> {
  const url = baseUrl.replace(/\/+$/, "");
  return new Promise<WebviewLoginResult>((resolve) => {
    const win = new BrowserWindow({
      width: 1024,
      height: 768,
      title: "Sign in to txAdmin",
      autoHideMenuBar: true,
      webPreferences: {
        partition: TXADMIN_PARTITION,
        // This window loads a remote/local web app — keep it sandboxed and with
        // no Node integration. No preload: we never expose app APIs to txAdmin.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    let settled = false;
    const finish = (result: WebviewLoginResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (result.ok && !win.isDestroyed()) win.close();
      resolve(result);
    };

    // Poll for a harvested session every 1.5s while the window is open.
    const poll = setInterval(() => {
      void (async () => {
        if (settled || win.isDestroyed()) return;
        try {
          const harvested = await tryHarvest(url, win);
          if (harvested) {
            setHarvestedSession(url, harvested.session);
            log.info("[txadmin-webview] Harvested session for", url);
            finish({ ok: true, name: harvested.name });
          }
        } catch (err) {
          log.warn("[txadmin-webview] harvest attempt failed:", err);
        }
      })();
    }, 1500);

    win.on("closed", () => {
      // If the user closed the window before we harvested anything, it's a cancel.
      finish({
        ok: false,
        cancelled: true,
        error: "Login window closed before sign-in completed.",
      });
    });

    win.loadURL(url).catch((err: unknown) => {
      finish({
        ok: false,
        error: `Could not load txAdmin at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      });
      if (!win.isDestroyed()) win.close();
    });
  });
}
