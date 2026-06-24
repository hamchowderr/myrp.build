import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAndInitWorkspace } from "../../src/main/mastra/workspace";

// odm: when hybrid search is enabled but the RAG DB is unreachable, the workspace
// must degrade to BM25-only instead of throwing (which would break generation).
describe("createAndInitWorkspace hybrid fallback (odm)", () => {
  let root: string;
  const saved = {
    db: process.env.RAG_DATABASE_URL,
    key: process.env.OPENAI_API_KEY,
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fivem-fallback-"));
    const local = join(root, "[local]", "hello");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
    // Hybrid engages only when BOTH are set — point the DB at a closed port.
    process.env.RAG_DATABASE_URL = "postgres://u:p@127.0.0.1:1/nope";
    process.env.OPENAI_API_KEY = "sk-dummy-not-used-before-connect-fails";
  });

  afterEach(() => {
    process.env.RAG_DATABASE_URL = saved.db;
    process.env.OPENAI_API_KEY = saved.key;
    rmSync(root, { recursive: true, force: true });
  });

  it("degrades to BM25 when hybrid init fails, instead of throwing", async () => {
    // hybrid:true + unreachable DB — must NOT reject; returns a usable workspace.
    const ws = await createAndInitWorkspace(root, {
      hybrid: true,
      indexPaths: [join(root, "[local]")],
    });
    try {
      expect(ws).toBeTruthy();
      // The workspace is functional: BM25 search over the indexed [local] tree works.
      const res = await ws.search("fxmanifest");
      expect(Array.isArray(res)).toBe(true);
    } finally {
      await ws.destroy().catch(() => {});
    }
  });
});
