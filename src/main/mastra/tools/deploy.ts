/**
 * deploy_resource tool (445.2) — makes a freshly built/edited resource live on the
 * RUNNING FiveM server via RCON `refresh` + `ensure <resource>`.
 *
 * Contract (vault: "FiveM Studio - Agent Server Interaction"):
 *   - NEVER starts/stops the server — that's txAdmin + the user. If the server is
 *     offline, this no-ops and tells the user to start it.
 *   - Scoped to ONE resource; `ensure` loads it (or reloads if running). No
 *     full-server restart, ever.
 *   - APPROVAL-GATED: `requireApproval: true` — server-affecting commands always
 *     pause for approve/decline (the chat.ts pump drives it). Automatic intent
 *     (the agent calls it after every build), approved execution.
 *   - Backend-abstracted today via RCON (sendRconCommand). txAdmin-API / Docker
 *     adapters can replace the body later without changing the tool contract.
 *
 * Resource load output is NOT returned here — it appears in the existing server
 * console stream (FxDkSession stdout → stream:serverConsole) as the server
 * processes the ensure, so the user sees load errors inline.
 */
import http from "node:http";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sendRconCommand } from "../../auto-deploy";
import log from "../log";

export interface DeployToolConfig {
  /** FiveM server port (server.cfg endpoint / RCON HTTP). */
  port: number;
  /** rcon_password from Settings; empty disables deploy (with a clear message). */
  rconPassword: string;
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

/**
 * Build the approval-gated deploy tool bound to the server's RCON config. Pass
 * the port + rcon password resolved from AppSettings at the IPC layer.
 */
export function createDeployTool(cfg: DeployToolConfig) {
  return createTool({
    id: "deploy_resource",
    description:
      "Make a freshly built or edited resource live on the RUNNING FiveM server by running `refresh` then `ensure <resource>` via RCON. Call this after writing a resource so the user can test it immediately. This does NOT restart the whole server (use restart_server for that). If the server is offline it no-ops — offer start_server. Returns the resource's actual LOAD RESULT: if loadSuccess is false, loadError holds the server's error (e.g. a missing dependency or a Lua/manifest error) — when that happens, FIX the resource and call deploy_resource again. Requires user approval before running.",
    inputSchema: z.object({
      resource: z
        .string()
        .describe("The resource folder name under [local]/ to make live, e.g. 'carwash'."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      deployed: z.boolean(),
      /** Did the resource actually START on the server (not just: was the RCON command delivered)? */
      loadSuccess: z.boolean().optional(),
      /** The server's load-failure text when loadSuccess is false — fix the resource and redeploy. */
      loadError: z.string().optional(),
      message: z.string(),
    }),
    // Server-affecting command — always pauses for approve/decline (the contract).
    requireApproval: true,
    execute: async (input) => {
      const { resource } = input;
      if (!cfg.rconPassword) {
        return {
          ok: false,
          deployed: false,
          message:
            "RCON password is not configured in Settings — cannot deploy. Set rcon_password to enable in-app deploys.",
        };
      }
      if (!(await pingServer(cfg.port))) {
        return {
          ok: false,
          deployed: false,
          message: `The FiveM server is offline. Start it (txAdmin) and then deploy ${resource} to test.`,
        };
      }
      // `refresh` so newly-created files are detected, then `ensure` to load it.
      await sendRconCommand(cfg.port, cfg.rconPassword, "refresh");
      const res = await sendRconCommand(cfg.port, cfg.rconPassword, `ensure ${resource}`);
      if (!res.ok) {
        log.warn(`[deploy] ensure ${resource} RCON failed -> ${res.error}`);
        return {
          ok: false,
          deployed: false,
          message: `Couldn't reach the server to deploy ${resource}: ${res.error ?? "unknown RCON error"}`,
        };
      }

      // RCON delivered — inspect the server's ensure reply for the LOAD result.
      // FXServer prints e.g. "Couldn't start resource X", "Could not find dependency …",
      // or "SCRIPT ERROR …" on failure; a clean start produces no error text.
      const output = (res.output ?? "").trim();
      const failed =
        /couldn't start|could not find dependency|script error|failed to (load|start)|error (loading|parsing|while)/i.test(
          output,
        );
      log.info(`[deploy] ensure ${resource} -> ${failed ? "LOAD FAILED" : "started"}`);

      return failed
        ? {
            ok: true,
            deployed: false,
            loadSuccess: false,
            loadError: output,
            message: `${resource} did not start: ${output} — fix the resource and deploy again.`,
          }
        : {
            ok: true,
            deployed: true,
            loadSuccess: true,
            message: output
              ? `${resource} deployed and started. Server: ${output}`
              : `${resource} deployed and started cleanly.`,
          };
    },
  });
}
