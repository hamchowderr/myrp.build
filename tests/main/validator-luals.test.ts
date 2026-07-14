import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { luaLsCheckErrors } from "../../src/main/mastra/tools/validator";

// Integration test against the REAL bundled lua-language-server. The binary is
// prefetched at build time / vendored in dev under build/lua-language-server (gitignored),
// so it's absent in CI — skip there rather than fail. Where present, this proves the
// --check gate (a) catches a genuine Lua error and (b) stays silent on clean code that
// uses FiveM globals, i.e. the Error-level calibration excludes undefined-global noise.
const EXE = process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server";
const LUALS = join(process.cwd(), "build", "lua-language-server", "bin", EXE);
const hasBinary = existsSync(LUALS);

describe.skipIf(!hasBinary)("luaLsCheckErrors (real lua-language-server)", () => {
  const prev = process.env.LUALS_PATH;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "luals-it-"));
    process.env.LUALS_PATH = LUALS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.LUALS_PATH;
    else process.env.LUALS_PATH = prev;
  });

  it("reports a real Lua syntax error", async () => {
    writeFileSync(join(dir, "client.lua"), "local x =\n");
    const issues = await luaLsCheckErrors(dir);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toContain("lua-language-server");
    expect(issues[0].file).toBe("client.lua");
  }, 40_000);

  it("stays silent on clean Lua using FiveM globals (undefined-global is warning-level)", async () => {
    writeFileSync(
      join(dir, "ok.lua"),
      "local ped = GetPlayerPed(-1)\nexports.ox_inventory:Search()\nprint(ped)\n",
    );
    expect(await luaLsCheckErrors(dir)).toEqual([]);
  }, 40_000);

  it("no-ops when LUALS_PATH is unset (graceful skip)", async () => {
    delete process.env.LUALS_PATH;
    writeFileSync(join(dir, "bad.lua"), "local y =\n");
    expect(await luaLsCheckErrors(dir)).toEqual([]);
  });
});
