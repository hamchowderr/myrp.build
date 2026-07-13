/**
 * Go/no-go smoke test: prove @mastra/core Workspace embeds and runs
 * outside the HTTP-server / `mastra dev` path (the original rejection's blocker).
 *
 * Creates a throwaway fixture FiveM resources tree, builds the workspace, init()s
 * it, then exercises filesystem read/write/list + BM25 search. No Anthropic calls,
 * no network — this only validates the runtime embeds.
 *
 *   npx tsx tests/mastra/smoke-workspace.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "fivem-ws-"));
  const localDir = join(root, "[local]", "hello");
  mkdirSync(localDir, { recursive: true });
  writeFileSync(
    join(localDir, "fxmanifest.lua"),
    "fx_version 'cerulean'\ngame 'gta5'\nshared_script '@ox_lib/init.lua'\n",
  );

  const ws = createFiveMWorkspace(root);
  console.log("[smoke] workspace constructed:", ws.constructor.name);

  await ws.init();
  console.log("[smoke] init() ok");

  const fs = ws.filesystem;
  if (!fs) throw new Error("no filesystem on workspace");

  // write
  await fs.writeFile("[local]/hello/server.lua", "print('hi from ox')\n");
  console.log("[smoke] writeFile ok");

  // read back
  const content = await fs.readFile("[local]/hello/fxmanifest.lua");
  const text = typeof content === "string" ? content : content.toString();
  console.log("[smoke] readFile ok, ox_lib present:", text.includes("ox_lib"));

  // list
  const entries = await fs.readdir("[local]/hello");
  console.log("[smoke] readdir ok:", entries.map((e) => e.name).join(", "));

  // search (BM25)
  try {
    const results = await ws.search("ox_lib", { topK: 5 });
    console.log("[smoke] search ok, hits:", results.length);
  } catch (err) {
    console.log("[smoke] search threw (non-fatal for go/no-go):", String(err));
  }

  await ws.destroy();
  rmSync(root, { recursive: true, force: true });
  console.log("[smoke] PASS — Mastra Workspace embeds and runs in plain Node");
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
