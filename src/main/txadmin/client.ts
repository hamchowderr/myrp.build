/**
 * txAdmin REST client (main process).
 *
 * Ported from the verified fivem-agents client
 * (src/mastra/tools/txadmin/{auth,fxserver}.ts), adapted to:
 *   - read credentials from a passed config (AppSettings) instead of env vars,
 *   - run as plain functions (no Mastra createTool wrapper).
 *
 * Drives the SAME txAdmin REST API for both local dev (http://127.0.0.1:40120)
 * and the cloud Docker demos (http://<vps>:4012x) — only the base URL changes.
 * Verified against txAdmin v8.0.1 and the vault map
 * "myRP.build — txAdmin & FXServer Reference".
 *
 * Auth: POST /auth/password {username, password} → session cookie(s) + csrfToken.
 * All writes require `Cookie` + `x-txadmin-csrftoken` headers.
 */

export interface TxAdminConfig {
  /** Base URL with no trailing slash, e.g. "http://127.0.0.1:40120". */
  baseUrl: string;
  /** txAdmin admin username (e.g. "hamchowderr"). Optional with a harvested session. */
  username?: string;
  /**
   * Numeric backup password set during txAdmin registration. Optional: when a
   * webview-harvested session exists for this baseUrl (zero-password login),
   * password login is never attempted. Kept as the fallback.
   */
  password?: string;
}

export interface TxAdminResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface Session {
  cookie: string;
  csrfToken: string;
}

/**
 * Shape of the txAdmin JSON responses we care about. NOTE: txAdmin returns
 * HTTP 200 with `{logout:true}` for an invalid/expired session (it does NOT use
 * 401/403), so callers must inspect `logout`, not just the status code.
 */
interface TxAdminResponse {
  type?: string;
  msg?: string;
  logout?: boolean;
}

/** Per-baseUrl session cache — survives across calls within the main process. */
const sessionCache = new Map<string, Session>();

/**
 * Per-baseUrl harvested-session store. Populated by the
 * webview login flow (src/main/txadmin/webview-auth.ts) after the user logs
 * into txAdmin via Cfx.re SSO. When present and valid it is preferred over a
 * password login, so no backup password need ever be stored. A harvested
 * session is NEVER auto-discarded on expiry of the password fallback; only
 * `clearHarvestedSession` (explicit sign-out) or a failed re-validation drops it.
 */
const harvestedSessions = new Map<string, Session>();

/** Inject a webview-harvested session for a baseUrl (zero-password login). */
export function setHarvestedSession(baseUrl: string, session: Session): void {
  const key = baseUrl.replace(/\/+$/, "");
  harvestedSessions.set(key, session);
  // Prime the active cache so the next call uses it immediately.
  sessionCache.set(key, session);
}

/** Drop any harvested session for a baseUrl (explicit sign-out). */
export function clearHarvestedSession(baseUrl: string): void {
  const key = baseUrl.replace(/\/+$/, "");
  harvestedSessions.delete(key);
  sessionCache.delete(key);
}

/** Does a harvested (passwordless) session exist for this baseUrl? */
export function hasHarvestedSession(baseUrl: string): boolean {
  return harvestedSessions.has(baseUrl.replace(/\/+$/, ""));
}

/**
 * Validate a cookie by fetching `GET /auth/self` and reading back the authoritative
 * `csrfToken` (per the verified txAdmin v8.0.1 contract). This is the ROBUST way
 * to obtain a CSRF token for a harvested cookie — it does not depend on the
 * version-specific in-page `window.txConsts` shape. Returns a Session or null.
 */
export async function buildSessionFromCookie(
  baseUrl: string,
  cookie: string,
): Promise<Session | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/auth/self`, {
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as {
      csrfToken?: string;
      logout?: boolean;
    };
    if (data.logout || !data.csrfToken) return null;
    return { cookie, csrfToken: data.csrfToken };
  } catch {
    return null;
  }
}

function authHeaders(s: Session): Record<string, string> {
  return {
    Cookie: s.cookie,
    "x-txadmin-csrftoken": s.csrfToken,
    "Content-Type": "application/json",
  };
}

/**
 * Capture all Set-Cookie headers (koa session usually sets a sess + sess.sig
 * pair) and reduce each to its `name=value` segment for the Cookie header.
 */
function extractCookie(res: Response): string | null {
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [];
  if (list.length > 0) return list.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : null;
}

async function login(cfg: TxAdminConfig): Promise<Session> {
  if (!cfg.username || !cfg.password) {
    throw new Error(
      "txAdmin is not signed in — log in via the in-app txAdmin window (Cfx.re) or set a backup username/password in Settings.",
    );
  }
  const res = await fetch(`${cfg.baseUrl}/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`txAdmin login failed: ${res.status} ${res.statusText} — ${body}`.trim());
  }
  const data = (await res.json().catch(() => ({}))) as { csrfToken?: string };
  const cookie = extractCookie(res);
  if (!cookie) throw new Error("txAdmin login returned no session cookie");
  if (!data.csrfToken) throw new Error("txAdmin login returned no csrfToken (bad credentials?)");
  return { cookie, csrfToken: data.csrfToken };
}

/**
 * Validate a cached session. NOTE: txAdmin's GET /auth/self returns HTTP 200
 * even when logged out (body `{logout:true}`), so we must inspect the body —
 * not just res.ok.
 */
async function isValid(baseUrl: string, s: Session): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/auth/self`, { headers: authHeaders(s) });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { logout?: boolean };
    return data.logout !== true;
  } catch {
    return false;
  }
}

async function getSession(cfg: TxAdminConfig): Promise<Session> {
  // 1) Active cache (could be a harvested or a password session) — reuse if valid.
  const cached = sessionCache.get(cfg.baseUrl);
  if (cached && (await isValid(cfg.baseUrl, cached))) return cached;
  sessionCache.delete(cfg.baseUrl);

  // 2) Prefer a webview-harvested session (zero-password, dt2). If it still
  //    validates, use it; if it has expired, drop it and fall through to the
  //    password fallback (when credentials are configured).
  const harvested = harvestedSessions.get(cfg.baseUrl);
  if (harvested) {
    if (await isValid(cfg.baseUrl, harvested)) {
      sessionCache.set(cfg.baseUrl, harvested);
      return harvested;
    }
    harvestedSessions.delete(cfg.baseUrl);
  }

  // 3) Password fallback (login() throws a clear error if no credentials).
  const session = await login(cfg);
  sessionCache.set(cfg.baseUrl, session);
  return session;
}

async function postAuthed(cfg: TxAdminConfig, path: string, body: unknown): Promise<TxAdminResult> {
  try {
    const send = async (
      session: Session,
    ): Promise<{ status: number; ok: boolean; data: TxAdminResponse }> => {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method: "POST",
        headers: authHeaders(session),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as TxAdminResponse;
      return { status: res.status, ok: res.ok, data };
    };

    let session = await getSession(cfg);
    let r = await send(session);
    // txAdmin signals an invalid/expired session with HTTP 200 + {logout:true}
    // (not 401/403). Re-login once and retry on that signal as well.
    if (r.status === 401 || r.status === 403 || r.data.logout === true) {
      sessionCache.delete(cfg.baseUrl);
      session = await getSession(cfg);
      r = await send(session);
    }
    if (!r.ok) return { ok: false, error: `${r.status}` };
    if (r.data.logout) {
      return {
        ok: false,
        error:
          "txAdmin rejected the session — check the username/password and that the admin has the control.server permission.",
      };
    }
    return {
      ok: r.data.type !== "error",
      message: r.data.msg,
      error: r.data.type === "error" ? r.data.msg : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whole-server control. POST /fxserver/controls {action}. */
export function txAdminControl(
  cfg: TxAdminConfig,
  action: "restart" | "stop" | "start",
): Promise<TxAdminResult> {
  return postAuthed(cfg, "/fxserver/controls", { action });
}

/**
 * Console / per-resource command. POST /fxserver/commands {action, parameter}.
 * For resources: action = "restart_res" | "stop_res" | "start_res" | "ensure",
 * parameter = resource name. action = "refresh" with empty parameter rescans.
 */
export function txAdminCommand(
  cfg: TxAdminConfig,
  action: string,
  parameter = "",
): Promise<TxAdminResult> {
  return postAuthed(cfg, "/fxserver/commands", { action, parameter });
}

/** Validate credentials + connectivity. Returns the admin identity on success. */
export async function txAdminTestConnection(
  cfg: TxAdminConfig,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const session = await getSession(cfg);
    const res = await fetch(`${cfg.baseUrl}/auth/self`, { headers: authHeaders(session) });
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
    const data = (await res.json().catch(() => ({}))) as { name?: string; logout?: boolean };
    if (data.logout) return { ok: false, error: "authentication failed (no session)" };
    return { ok: true, name: data.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
