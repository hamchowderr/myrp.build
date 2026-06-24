/**
 * Server lifecycle tools (fivem-studio-w2s) — let the agent START / STOP /
 * RESTART the local FXServer and report STATUS.
 *
 * This intentionally walks back principle #1 of the 2026-05-23 Agent Server
 * Interaction Contract ("the agent never starts or stops the server"). Decided
 * with the owner on 2026-05-26: the agent SHOULD manage server lifecycle so we
 * can test where the agent is reliable vs. where a human must step in. The only
 * genuine human-only gates left are the Cfx.re-credentialed steps (account,
 * license key, txAdmin master OAuth) — not start/stop, which are mechanical.
 *
 * Safety model (unchanged from deploy_resource, 445.2):
 *   - start/stop/restart are SENSITIVE OPS → `requireApproval: true`. The chat.ts
 *     pump pauses for approve/decline before the process is touched.
 *   - server_status is read-only → no approval (just pings /info.json + checks
 *     the session/process state).
 *
 * Backend: drives the same FxDkSession path as the user-facing buttons via the
 * shared server-control module — RCON/txAdmin/Docker adapters can replace the
 * body later without changing the tool contract.
 *
 * Process boundary: the Mastra agent runs in the MAIN process, so these call
 * server-control + electron-log directly (same as deploy.ts → sendRconCommand).
 */
import http from "node:http";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { checkFxServerProcess, startFxServer, stopFxServer } from "../../server-control";
import log from "../log";

export interface ServerLifecycleConfig {
  /** FiveM server port (server.cfg endpoint) — used by server_status's ping. */
  port: number;
}

/** Is the server answering on /info.json? (No RCON password needed.) */
function pingServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
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
}

const lifecycleOutput = z.object({
  ok: z.boolean(),
  message: z.string(),
});

/**
 * Build the server lifecycle tools bound to the server's port. start/stop/restart
 * are approval-gated; server_status is read-only. Returns a tools map ready to
 * spread into the agent's `tools`.
 */
export function createServerLifecycleTools(cfg: ServerLifecycleConfig) {
  const start_server = createTool({
    id: "start_server",
    description:
      "Start the local FXServer so the user can test resources in-game. Spawns FXServer.exe from the configured server path (killing any orphaned instance first). Use when the server is offline and the user wants to test. Requires user approval before running.",
    inputSchema: z.object({}),
    outputSchema: lifecycleOutput,
    requireApproval: true,
    execute: async () => {
      if (await pingServer(cfg.port)) {
        return { ok: true, message: "The FXServer is already running." };
      }
      const res = await startFxServer();
      log.info(`[server-lifecycle] start_server -> ${res.ok ? "ok" : res.error}`);
      return res.ok
        ? {
            ok: true,
            message:
              "FXServer is starting. Watch the server console for the boot sequence and any resource load errors.",
          }
        : { ok: false, message: `Could not start the server: ${res.error ?? "unknown error"}` };
    },
  });

  const stop_server = createTool({
    id: "stop_server",
    description:
      "Stop the local FXServer. Gracefully stops the managed session, falling back to terminating an externally-launched FXServer.exe. Requires user approval before running.",
    inputSchema: z.object({}),
    outputSchema: lifecycleOutput,
    requireApproval: true,
    execute: async () => {
      const res = await stopFxServer();
      log.info(`[server-lifecycle] stop_server -> ${res.ok ? "ok" : res.error}`);
      return res.ok
        ? { ok: true, message: "FXServer stopped." }
        : { ok: false, message: `Could not stop the server: ${res.error ?? "unknown error"}` };
    },
  });

  const restart_server = createTool({
    id: "restart_server",
    description:
      "Restart the WHOLE local FXServer (stop, then start). Use sparingly — for reloading a single resource after a build, prefer deploy_resource instead. Requires user approval before running.",
    inputSchema: z.object({}),
    outputSchema: lifecycleOutput,
    requireApproval: true,
    execute: async () => {
      const stopped = await stopFxServer();
      // A "not running" stop is fine for a restart — we just start fresh.
      if (!stopped.ok && stopped.error !== "No FXServer process found.") {
        return { ok: false, message: `Restart aborted — stop failed: ${stopped.error}` };
      }
      // Give the OS a moment to release the port/handles before respawning.
      await new Promise((r) => setTimeout(r, 1000));
      const started = await startFxServer();
      log.info(`[server-lifecycle] restart_server -> ${started.ok ? "ok" : started.error}`);
      return started.ok
        ? {
            ok: true,
            message: "FXServer restarted. Watch the server console for the boot sequence.",
          }
        : {
            ok: false,
            message: `Could not restart the server: ${started.error ?? "unknown error"}`,
          };
    },
  });

  const server_status = createTool({
    id: "server_status",
    description:
      "Check whether the local FXServer is running and reachable. Read-only — does not require approval. Returns process state and whether it answers on its info endpoint.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      online: z.boolean(),
      processRunning: z.boolean(),
      message: z.string(),
    }),
    execute: async () => {
      const [online, proc] = await Promise.all([pingServer(cfg.port), checkFxServerProcess()]);
      const message = online
        ? "FXServer is online and answering on its info endpoint."
        : proc.running
          ? "FXServer.exe is running but not yet answering — it may still be booting."
          : "FXServer is offline.";
      return { online, processRunning: proc.running, message };
    },
  });

  return { start_server, stop_server, restart_server, server_status };
}
