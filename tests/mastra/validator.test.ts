/**
 * Static validator unit tests (zhk.8). Deterministic — no API/model spend.
 * Builds throwaway resources under a temp resources/[local]/ and asserts the
 * issues the validator reports.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usesBacktickString, validateResource } from "../../src/main/mastra/tools/validator";

let root: string;

function writeResource(name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, "[local]", name, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fivem-validator-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateResource", () => {
  it("passes a correct resource with no errors", async () => {
    writeResource("good", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nshared_scripts { '@ox_lib/init.lua' }\nserver_scripts { 'server/main.lua' }\ndependencies { 'ox_lib' }\n`,
      "server/main.lua": `lib.addCommand('heal', { restricted = 'group.admin' }, function() end)\n`,
    });
    const issues = await validateResource(root, "good");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("flags a file declared in fxmanifest that does not exist", async () => {
    writeResource("missing", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nclient_scripts { 'client.lua' }\n`,
      "client/main.lua": `local ped = PlayerPedId()\n`,
    });
    const issues = await validateResource(root, "missing");
    expect(issues.some((i) => i.severity === "error" && i.message.includes("client.lua"))).toBe(
      true,
    );
  });

  it("flags forbidden patterns and missing fx_version", async () => {
    writeResource("bad", {
      "fxmanifest.lua": `game 'gta5'\nserver_scripts { 'server/main.lua' }\n`,
      "server/main.lua": `local p = GetPlayerPed(-1)\nMySQL.Async.fetchAll('SELECT 1')\n`,
    });
    const issues = await validateResource(root, "bad");
    const errs = issues.filter((i) => i.severity === "error").map((i) => i.message);
    expect(errs.some((m) => m.includes("cerulean"))).toBe(true);
    expect(errs.some((m) => m.includes("PlayerPedId"))).toBe(true);
    expect(errs.some((m) => m.includes("oxmysql"))).toBe(true);
  });

  it("flags a non-ox accounts.bank/identifier schema query (0gdr)", async () => {
    writeResource("esxschema", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { '@oxmysql/lib/MySQL.lua', 'server/main.lua' }\ndependencies { 'ox_lib', 'oxmysql' }\n`,
      "server/main.lua":
        "local bal = MySQL.scalar.await('SELECT `bank` FROM `accounts` WHERE `identifier` = ?', { id })\n",
    });
    const issues = await validateResource(root, "esxschema");
    expect(
      issues.some((i) => i.severity === "error" && /non-ox accounts schema/i.test(i.message)),
    ).toBe(true);
  });

  it("does NOT flag a correct ox_core accounts query (zero false-positive, 0gdr)", async () => {
    writeResource("oxschema", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nshared_scripts { '@ox_lib/init.lua' }\nserver_scripts { '@oxmysql/lib/MySQL.lua', 'server/main.lua' }\ndependencies { 'ox_lib', 'oxmysql' }\n`,
      "server/main.lua":
        "local bal = MySQL.scalar.await('SELECT balance FROM accounts WHERE owner = ? AND isDefault = 1', { charId })\n",
    });
    const issues = await validateResource(root, "oxschema");
    expect(issues.some((i) => /non-ox accounts schema/i.test(i.message))).toBe(false);
  });

  it("errors when fxmanifest is missing", async () => {
    writeResource("nomanifest", { "server/main.lua": "print('x')\n" });
    const issues = await validateResource(root, "nomanifest");
    expect(issues.some((i) => i.severity === "error" && i.message.includes("missing"))).toBe(true);
  });

  it("warns on orphan files not declared in the manifest", async () => {
    writeResource("orphan", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'server/main.lua' }\ndependencies { 'ox_lib' }\n`,
      "server/main.lua": `print('x')\n`,
      "client/extra.lua": `print('orphan')\n`,
    });
    const issues = await validateResource(root, "orphan");
    expect(issues.some((i) => i.severity === "warning" && i.message.includes("extra.lua"))).toBe(
      true,
    );
  });

  it("flags a backtick/template-literal string as an error (2hd)", async () => {
    writeResource("backtick", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nshared_scripts { '@ox_lib/init.lua' }\nclient_scripts { 'client/main.lua' }\n`,
      "client/main.lua": "local name = 'world'\nlocal msg = `Hello world`\nprint(name)\n",
    });
    const issues = await validateResource(root, "backtick");
    expect(issues.some((i) => i.severity === "error" && /backtick|E011/i.test(i.message))).toBe(
      true,
    );
  });

  it("requires the ox_lib dependency even for a config-only resource (2hd)", async () => {
    writeResource("configonly", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nshared_scripts { 'config.lua' }\n`,
      "config.lua": "Config = {}\nConfig.Price = 100\n",
    });
    const issues = await validateResource(root, "configonly");
    expect(issues.some((i) => i.severity === "error" && /ox_lib/.test(i.message))).toBe(true);
  });

  // ---------------------------------------------------------------------
  // ox-correctness (myrp-build-lar). These reproduce the FIRST live generation
  // on the fixed loop: it declared dependencies { 'ox_lib' } and then notified
  // with chat:addMessage, and this validator passed it. GROUND_RULES already
  // forbade both; the gap was enforcement, not guidance.
  // ---------------------------------------------------------------------

  it("flags chat:addMessage instead of ox notifications (lar)", async () => {
    writeResource("vanillanotify", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'server/main.lua' }\ndependencies { 'ox_lib' }\n`,
      "server/main.lua": `RegisterCommand('pingtest', function(source)\n    TriggerClientEvent('chat:addMessage', source, { args = { 'Server', 'pong' } })\nend, false)\n`,
    });
    const issues = await validateResource(root, "vanillanotify");
    const errs = issues.filter((i) => i.severity === "error").map((i) => i.message);
    expect(errs.some((m) => m.includes("chat:addMessage") && m.includes("lib.notify"))).toBe(true);
  });

  it("flags the native notification chain (lar)", async () => {
    writeResource("nativenotify", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nclient_scripts { 'client/main.lua' }\ndependencies { 'ox_lib' }\n`,
      "client/main.lua": `RegisterCommand('x', function()\n    SetNotificationTextEntry('STRING')\n    DrawNotification(false, true)\nend, false)\n`,
    });
    const issues = await validateResource(root, "nativenotify");
    expect(
      issues.some((i) => i.severity === "error" && /SetNotificationTextEntry/.test(i.message)),
    ).toBe(true);
  });

  it("flags a manifest that declares ox_lib while no code calls lib.* (lar)", async () => {
    writeResource("declaredunused", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'server/main.lua' }\ndependencies { 'ox_lib' }\n`,
      // Deliberately free of any OTHER forbidden pattern, so only the
      // declared-but-unused rule can produce this error.
      "server/main.lua": `RegisterCommand('noop', function(source)\n    print('hello')\nend, false)\n`,
    });
    const issues = await validateResource(root, "declaredunused");
    expect(
      issues.some(
        (i) => i.severity === "error" && /never calls lib\.\*|call site/i.test(i.message),
      ),
    ).toBe(true);
  });

  it("does NOT flag the correct ox server notify form (zero false-positive, lar)", async () => {
    // The correct server-side form IS a TriggerClientEvent, so a rule keyed on
    // the trigger rather than the event name would reject correct ox code.
    writeResource("oxnotify", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'server/main.lua' }\ndependencies { 'ox_lib' }\n`,
      "server/main.lua": `lib.addCommand('ping', {}, function(source)\n    TriggerClientEvent('ox_lib:notify', source, { description = 'pong', type = 'success' })\nend)\n`,
    });
    const issues = await validateResource(root, "oxnotify");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("does NOT flag ox_lib:notify used WITHOUT any lib.* call (zero false-positive, lar)", async () => {
    // Caught by a live run: the agent repaired a resource to the non-deprecated
    // server form, which uses the ox_lib NET EVENT and no lib.* at all. That is
    // correct ox usage and needs the ox_lib dependency (ox_lib registers the
    // handler), so the declared-but-unused rule must not fire.
    // Deliberately contains NO `lib.` — the earlier oxnotify fixture used
    // lib.addCommand, so it passed this rule for the wrong reason.
    writeResource("neteventonly", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'server/main.lua' }\ndependencies { 'ox_lib' }\n`,
      "server/main.lua": `RegisterCommand('ping', function(source)\n    TriggerClientEvent('ox_lib:notify', source, { description = 'pong', type = 'success' })\nend, false)\n`,
    });
    const issues = await validateResource(root, "neteventonly");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("does NOT flag a config-only resource that declares ox_lib (zero false-positive, lar)", async () => {
    // Config-only resources are REQUIRED to declare ox_lib and legitimately have
    // no lib.* call — the declared-but-unused rule must not fire on them.
    writeResource("configonlyok", {
      "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\nshared_scripts { '@ox_lib/init.lua', 'config.lua' }\ndependencies { 'ox_lib' }\n`,
      "config.lua": "Config = {}\nConfig.Price = 100\n",
    });
    const issues = await validateResource(root, "configonlyok");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

describe("usesBacktickString", () => {
  it("detects a backtick template literal in expression position", () => {
    expect(usesBacktickString("local s = `hi`")).toBe(true);
    expect(usesBacktickString("print(`a b`)")).toBe(true);
  });
  it("does not flag a backtick inside a normal string (zero false-positive)", () => {
    expect(usesBacktickString('local s = "use `code` here"')).toBe(false);
    expect(usesBacktickString("local s = 'a `b` c'")).toBe(false);
  });
  it("does not flag a backtick inside a comment", () => {
    expect(usesBacktickString("-- use `backticks` in JS, not Lua")).toBe(false);
    expect(usesBacktickString("--[[ `x` ]]\nlocal y = 1")).toBe(false);
  });
  it("does not flag a backtick inside a long string", () => {
    expect(usesBacktickString("local s = [[ a `b` c ]]")).toBe(false);
    expect(usesBacktickString("local s = [==[ `x` ]==]")).toBe(false);
  });
  it("returns false for clean Lua", () => {
    expect(usesBacktickString("local s = ('a ' .. 'b')\nif x then return end")).toBe(false);
  });
});
