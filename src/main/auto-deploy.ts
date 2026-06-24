/**
 * Auto-deploy via RCON: refresh server resource list, then ensure the new resource.
 */

import dgram from "node:dgram";
import http from "node:http";
import log from "electron-log/main";
import { getActiveServer } from "../renderer/src/lib/server-registry";
import { resolveServerRconPassword } from "./context";
import { fxdkSession, readSettings, sendStreamMessage, state } from "./shared-state";

/** OOB packet prefix: four 0xFF bytes mark a connectionless (out-of-band) message. */
const OOB_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const RCON_TIMEOUT_MS = 5000;

/**
 * Send an RCON command to FXServer over its UDP out-of-band protocol.
 *
 * FiveM has NO HTTP /rcon endpoint — RCON is the Quake-style connectionless UDP
 * packet on the game port: `0xFFFFFFFF` + `rcon <password> <command>`. The reply
 * comes back out-of-band too, prefixed with `0xFFFFFFFF` then `print`. (The prior
 * HTTP POST /rcon implementation 404'd against a stock server — see bug 11j.)
 *
 * Resolves `ok: true` with the server's text `output` once a reply arrives, or
 * `ok: false` with an error (incl. timeout — note RCON gives no reply for a bad
 * password, so a timeout can also mean auth failure).
 */
export function sendRconCommand(
  port: number,
  password: string,
  command: string,
): Promise<{ ok: boolean; error?: string; output?: string }> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let settled = false;
    const finish = (result: { ok: boolean; error?: string; output?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish({ ok: false, error: "timeout (no reply — server offline or bad rcon password)" }),
      RCON_TIMEOUT_MS,
    );

    sock.on("message", (msg) => {
      // Strip the OOB prefix (0xFF*4) and the leading "print" tag from the reply.
      const text = msg
        .subarray(OOB_PREFIX.length)
        .toString("utf8")
        .replace(/^print\s?/, "")
        .trim();
      finish({ ok: true, output: text });
    });
    sock.on("error", (err) => finish({ ok: false, error: err.message }));

    const packet = Buffer.concat([OOB_PREFIX, Buffer.from(`rcon ${password} ${command}`, "utf8")]);
    sock.send(packet, port, "localhost", (err) => {
      if (err) finish({ ok: false, error: err.message });
    });
  });
}

export async function autoDeploy(resourceName: string): Promise<void> {
  const server = getActiveServer(await readSettings());
  if (!server) return;

  const port = server.serverPort ?? 30120;

  // Resolve RCON password: registry override, else server.cfg + the files it
  // exec's (the password usually lives in a gitignored secrets cfg — 92fh).
  const password = await resolveServerRconPassword(server, state.cachedContext?.serverCfgPath);

  if (!password) {
    log.info("[rcon] No RCON password found — skipping auto-deploy");
    return;
  }

  // Check server is reachable before sending commands
  const ping = await new Promise<boolean>((resolve) => {
    const req = http.get(`http://localhost:${port}/info.json`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });

  if (!ping) {
    log.info("[rcon] Server offline — skipping auto-deploy");
    return;
  }

  sendStreamMessage({ type: "status", text: "Deploying to server…" });
  fxdkSession.emitSystem(`[myRP.build] Deploying: ${resourceName}`);

  const refresh = await sendRconCommand(port, password, "refresh");
  if (!refresh.ok) {
    log.warn("[rcon] refresh failed:", refresh.error);
  }

  // Small delay so server processes the refresh before ensure
  await new Promise((r) => setTimeout(r, 500));

  const ensure = await sendRconCommand(port, password, `ensure ${resourceName}`);
  if (ensure.ok) {
    log.info(`[rcon] ensure ${resourceName} — deployed`);
    sendStreamMessage({ type: "status", text: `✓ ${resourceName} deployed` });
  } else {
    log.warn("[rcon] ensure failed:", ensure.error);
  }
}
