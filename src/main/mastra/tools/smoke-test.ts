/**
 * smoke_test_resource tool — the agent's runtime self-verify step.
 *
 * Unlike deploy_resource (approval-gated, inspects only the synchronous RCON
 * reply), this VERIFIES the resource actually loads by scanning the server console
 * for the ASYNC load result (Lua errors, missing deps, parse failures that appear on
 * stdout after `ensure` returns). It is intentionally NOT approval-gated: it's a test
 * on the LOCAL dev server, and the self-verify loop must run unattended (the agent
 * calls it, reads the result, fixes, and re-tests within its own run).
 *
 * Distinct from deploy_resource by intent: deploy_resource = explicit "make it live"
 * (gated); smoke_test_resource = "did what I just wrote load?" (the agent's own QA).
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { deployAndVerifyResource } from "../../smoke-test";
import type { DeployToolConfig } from "./deploy";

export function createSmokeTestTool(cfg: DeployToolConfig) {
  return createTool({
    id: "smoke_test_resource",
    description:
      "VERIFY that a resource you just wrote actually loads on the running FiveM dev server. Runs `ensure <resource>` then SCANS THE SERVER CONSOLE for the asynchronous load result — Lua syntax/runtime errors, missing dependencies, manifest/parse failures — that the deploy reply alone misses. Call this after writing and validating a resource (when a server is running) as your final check. NOT approval-gated — it is a local test, not a production deploy. If loadSuccess is false, loadError + consoleSnippet hold the server's actual error: FIX the resource and call smoke_test_resource again, repeating until it loads clean. If the server is offline it returns a clear message — then skip and tell the user to start the server to verify.",
    inputSchema: z.object({
      resource: z
        .string()
        .describe("The resource folder name under [local]/ to smoke-test, e.g. 'carwash'."),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      deployed: z.boolean(),
      loadSuccess: z.boolean(),
      startedConfirmed: z.boolean(),
      loadError: z.string().optional(),
      matchedPattern: z.string().optional(),
      consoleSnippet: z.array(z.string()).optional(),
      secondsWaited: z.number(),
    }),
    execute: async (input) => deployAndVerifyResource(input.resource, cfg.port, cfg.rconPassword),
  });
}
