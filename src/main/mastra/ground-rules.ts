/**
 * The myRP.build ox_overextended ground rules — the ONE source of truth for the
 * product's absolute code invariants.
 *
 * Both the SUPERVISOR (prompt.ts, which enforces them across the team) and the
 * writer/checker SPECIALISTS (sub-agents.ts — lua/nui write code, validator +
 * security-auditor check it) import this. Before this existed the rules lived
 * only in the supervisor prompt, so a specialist writing the actual Lua didn't
 * know them and could e.g. gate a command with an ACE + tell the user to edit
 * server.cfg (myrp-build bug). Phrased imperatively so it reads correctly in
 * either context.
 */
export const GROUND_RULES = `- ox_overextended ONLY. Never generate code for any other FiveM framework — INCLUDING another framework's DATABASE SCHEMA. Use oxmysql (never another DB driver). ox_core money is the \`accounts\` table (owner=charId, balance) — never a \`bank\` column, a string \`identifier\` key, a \`users\`/\`players\` table, or \`players.money\`. Never leave a "-- adjust to your schema" stub — load the db-oxmysql/ox-banking skills for the real ox schema before any money/DB query.
- fx_version 'cerulean' always — never __resource.lua, never older versions.
- SERVER-AUTHORITATIVE for ALL state, never client-trusted: money, items, vehicle/entity status, player stats, and DB writes are decided and validated on the SERVER. The client only REQUESTS (event/callback) and DISPLAYS. A client that can change state is an exploit.
- Every event that receives client data MUST validate source. Prefer ox_lib server callbacks (lib.callback.register returns a value — never take a cb parameter).
- Never deprecated natives: PlayerPedId() not GetPlayerPed(-1).
- USE ox AT THE CALL SITE, not just in the manifest. Declaring the ox_lib dependency is NOT the same as using ox — a resource that depends on ox_lib and then calls vanilla FiveM APIs is a bug, not a compromise. Notifications are lib.notify (client) / TriggerClientEvent with lib.notify (server->client), NEVER chat:addMessage, NEVER native NotifyAboveMap/SetNotificationTextEntry. Input is lib.inputDialog, menus are lib.registerContext/lib.showContext, progress is lib.progressBar, callbacks are lib.callback, key binds are lib.addKeybind. If a task names an ox API, use that exact API.
- LUA SYNTAX ONLY — never JavaScript-isms (each is a luacheck E011 that stops the resource loading): NO backtick/template-literal strings (use string.format('msg %s', x) or '..'); NO ternary cond ? a : b (use cond and a or b); NO optional chaining ?.; NO {key: value} object literals (Lua tables use {key = value}); NO [] array literals ({} is used for arrays too); pair every if/elseif with then and every block with a matching end.
- EVERY resource MUST include an fxmanifest.lua — no exceptions (minimal, server-only, config-only, export-bridge included). Without it the resource does not load.
- fxmanifest.lua must declare every file used (client_scripts, server_scripts, files, ui_page) and ALWAYS include the ox_lib dependency — dependency 'ox_lib' (or dependencies { 'ox_lib', 'oxmysql' } when the DB is used).
- Resource names: lowercase, hyphens only, no spaces, no special characters.
- FILE PATHS: every file you write goes under \`[local]/<resource>/...\` — e.g. \`[local]/carwash/server/main.lua\`, \`[local]/carwash/fxmanifest.lua\`. The workspace root is the server's \`resources/\` directory, NOT \`[local]\`, so a path missing the \`[local]/\` prefix silently writes a resource beside the managed folder where it is never found, validated, or deployed. Never write directly at the workspace root. Read paths may point anywhere (scouting \`[ox]/\` and other resources is fine) — this rule is about WRITES.
- All comments in English.
- LORE-FRIENDLY WORLD: every in-world name — businesses/brands, vehicle makes, streets/locations, currency — MUST fit GTA V's satirical universe (Burger Shot not Burger King, Übermacht not BMW, Legion Square not "downtown", "$" only), NEVER a real-world brand (breaks immersion + is an IP risk). Load the lore skill for canonical parody names.
- NEVER instruct the user to edit server.cfg or add server config, and NEVER gate anything behind ACE permissions. No "add this to your server.cfg", no add_ace / add_principal / setr lines, no \`restricted =\` ACE gates, no manual ensure instructions. The app writes resources and loads them automatically. For permission/admin gating, use ox_core groups IN CODE (player.hasGroup / ox_lib group checks) — data-driven, no server.cfg.`;
