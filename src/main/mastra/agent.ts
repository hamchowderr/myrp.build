/**
 * myRP.build supervisor agent (APP).
 *
 * The agent's CORE config — model resolution, system prompt + ox RAG,
 * TokenLimiter, memory, maxSteps, sub-agents — lives in the Electron-free
 * `agent-config.ts` (buildFiveMAgentConfig), which Mastra Studio ALSO consumes
 * so the two can never drift. This file adds the one thing Studio can't have:
 * the native, Electron/FFI-bound tools (deploy / server-lifecycle / validator /
 * install / import-schema / smoke-test), assembled here and injected in-app only.
 *
 * The agent derives its filesystem / sandbox / search / skill tools
 * AUTOMATICALLY from the assigned Workspace — there is no manual tool list to
 * maintain or to blow the input-token budget.
 */

import { Agent } from "@mastra/core/agent";
import type { AnyWorkspace } from "@mastra/core/workspace";
import { buildFiveMAgentConfig, type FiveMAgentOptions } from "./agent-config";
import { createDeployTool } from "./tools/deploy";
import { createImportSchemaTool } from "./tools/import-schema";
import { createInstallTool } from "./tools/install";
import { createServerLifecycleTools } from "./tools/server-lifecycle";
import { createSmokeTestTool } from "./tools/smoke-test";
import { createValidatorTool } from "./tools/validator";

// Re-export the shared core types so existing importers (chat.ts, harness.ts)
// keep resolving them off `./agent` unchanged.
export type { FiveMAgentOptions, ProxyConfig } from "./agent-config";

/**
 * Build the myRP.build supervisor agent bound to `workspace`.
 *
 * Pass the Workspace from `createFiveMWorkspace(resourcesRoot)`. Call
 * `await workspace.init()` before streaming so the filesystem, sandbox, and
 * search index are ready. Optionally inject ox RAG context via `opts.ragContext`.
 */
export function createFiveMAgent(workspace: AnyWorkspace, opts: FiveMAgentOptions = {}): Agent {
  return new Agent({
    // Shared, Electron-free core — the SAME config Studio builds.
    ...buildFiveMAgentConfig(workspace, opts),
    // Native/Electron-bound tools — APP ONLY (Studio can't run these, so it
    // omits them). Kept here, out of the shared core, so the core stays bundleable.
    ...(() => {
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool factories — Mastra validates shapes at runtime.
      const tools: Record<string, any> = {};
      if (opts.resourcesRoot) tools.validate_resource = createValidatorTool(opts.resourcesRoot);
      if (opts.deployConfig) {
        tools.deploy_resource = createDeployTool(opts.deployConfig);
        // Non-gated runtime self-verify: the agent ensures the resource
        // and scans the console for async load errors, then fixes + re-tests.
        tools.smoke_test_resource = createSmokeTestTool(opts.deployConfig);
      }
      if (opts.serverConfig) Object.assign(tools, createServerLifecycleTools(opts.serverConfig));
      if (opts.installConfig) tools.install_resource = createInstallTool(opts.installConfig);
      if (opts.importSchemaConfig)
        tools.import_schema = createImportSchemaTool(opts.importSchemaConfig);
      return Object.keys(tools).length > 0 ? { tools } : {};
    })(),
  });
}
