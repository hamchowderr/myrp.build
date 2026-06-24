/**
 * install_resource tool (fivem-studio install capability) — lets the agent
 * INSTALL a missing ox-ecosystem dependency: download its release zip, extract
 * into resources/[ox]/, and ensure it on the running server.
 *
 * Pairs with deploy_resource's loadError (445.2 / 9hr): when a build fails with
 * "could not find dependency X", the agent can install X and redeploy instead of
 * just removing the dependency.
 *
 * Safety / scope:
 *   - APPROVAL-GATED (requireApproval: true) — installing downloads + runs files
 *     on the server, so it always pauses for approve/decline (the chat.ts pump).
 *   - CURATED ALLOWLIST only — the official Overextended / CommunityOx release
 *     zips. No arbitrary URLs (no supply-chain surface).
 *   - Idempotent — skips if the resource folder already exists.
 *
 * Windows-only extraction via PowerShell .NET ZipFile (the app is Windows-only;
 * Expand-Archive mis-parses the literal "[ox]" path as a wildcard, so we use
 * ZipFile.ExtractToDirectory which takes literal paths).
 *
 * NOTE: this installs resource FILES only. Resources that need their own SQL
 * schema (ox_core, ox_doorlock) still require their install.sql imported — the
 * tool says so in its result.
 */
import { access } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sendRconCommand } from "../../auto-deploy";
import { downloadAndExtractOx, NEEDS_SQL } from "../../ox-releases";

export interface InstallToolConfig {
  /** The server's resources/ directory (where [ox]/ lives). */
  resourcesRoot: string;
  /** Server port + rcon password — to ensure the resource live after install. */
  port: number;
  rconPassword: string;
}

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

export function createInstallTool(cfg: InstallToolConfig) {
  return createTool({
    id: "install_resource",
    description:
      "Install a missing ox-ecosystem dependency onto the server: downloads its official release, extracts it into resources/[ox]/, and ensures it. Use when a build needs an ox resource that isn't installed (e.g. deploy_resource reported 'could not find dependency ox_target'). Only the curated ox resources are allowed. Requires user approval. Installs files only — ox_core/ox_doorlock also need their install.sql imported (the result will say so).",
    inputSchema: z.object({
      resource: z
        .enum([
          "ox_lib",
          "oxmysql",
          "ox_core",
          "ox_inventory",
          "ox_target",
          "ox_doorlock",
          "ox_fuel",
          "ox_banking",
        ])
        .describe("The ox resource to install."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      installed: z.boolean(),
      message: z.string(),
    }),
    requireApproval: true,
    execute: async (input) => {
      const { resource } = input;
      const oxDir = join(cfg.resourcesRoot, "[ox]");
      const target = join(oxDir, resource);

      // Idempotent — already present?
      try {
        await access(target);
        return { ok: true, installed: true, message: `${resource} is already installed.` };
      } catch {
        // not installed — proceed
      }

      try {
        await downloadAndExtractOx(resource, oxDir);
      } catch (err) {
        return {
          ok: false,
          installed: false,
          message: `Failed to install ${resource}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Make it live if the server is up and rcon is configured.
      let ensured = "";
      if (cfg.rconPassword && (await pingServer(cfg.port))) {
        await sendRconCommand(cfg.port, cfg.rconPassword, "refresh");
        const res = await sendRconCommand(cfg.port, cfg.rconPassword, `ensure ${resource}`);
        ensured = res.ok ? " and ensured on the server" : "";
      }

      const sqlNote = NEEDS_SQL.has(resource)
        ? ` NOTE: ${resource} needs its sql/install.sql imported into the database before it works.`
        : "";
      return {
        ok: true,
        installed: true,
        message: `Installed ${resource} into resources/[ox]${ensured}.${sqlNote}`,
      };
    },
  });
}
