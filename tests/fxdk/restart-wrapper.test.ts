/**
 * Unit coverage for the FXServer restart-loop wrapper.
 *
 * Pure/deterministic — writes a temp .bat and asserts the loop contract. The
 * BEHAVIOURAL guarantee (survive a real txAdmin full-restart, Stop tears down
 * the tree) needs a live FXServer + txAdmin and is covered by the manual
 * live-verify issue, NOT here.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  WRAPPER_BAT_NAME,
  wrapperSpawnArgs,
  writeRestartWrapper,
} from "../../src/main/fxdk/restart-wrapper";

const dir = mkdtempSync(join(tmpdir(), "myrp-wrapper-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeRestartWrapper", () => {
  const exe = "C:\\FXServer\\server\\FXServer.exe";
  const args = ["+set", "citizen_dir", "C:\\FXServer\\server\\citizen", "+exec", "server.cfg"];

  it("writes the wrapper at the well-known name in the data dir", async () => {
    const batPath = await writeRestartWrapper(dir, exe, args);
    expect(batPath).toBe(join(dir, WRAPPER_BAT_NAME));
  });

  it("emits a restart loop that re-execs the exe", async () => {
    const batPath = await writeRestartWrapper(dir, exe, args);
    const body = readFileSync(batPath, "utf-8");
    // The loop is the whole point: :loop … goto loop.
    expect(body).toContain(":loop");
    expect(body).toContain("goto loop");
    // The exe is quoted (paths can contain spaces) and present once in the loop.
    expect(body).toContain(`"${exe}"`);
    // All FXServer args are forwarded.
    expect(body).toContain("+set");
    expect(body).toContain("citizen_dir");
    expect(body).toContain("+exec");
    expect(body).toContain("server.cfg");
    // cwd is pinned so FXServer's resources/ resolution matches direct-spawn.
    expect(body).toContain(`cd /d "${dir}"`);
  });

  it("quotes args containing spaces", async () => {
    const spacedCfg = "my server.cfg";
    const batPath = await writeRestartWrapper(dir, exe, ["+exec", spacedCfg]);
    const body = readFileSync(batPath, "utf-8");
    expect(body).toContain(`"${spacedCfg}"`);
  });
});

describe("wrapperSpawnArgs", () => {
  it("launches the batch through a cmd shell with /c", () => {
    const { command, args } = wrapperSpawnArgs("C:\\srv\\loop.bat");
    expect(command.toLowerCase()).toContain("cmd");
    expect(args).toContain("/c");
    expect(args).toContain("C:\\srv\\loop.bat");
  });
});
