# ox_overextended only

myRP.build targets the **ox_overextended** ecosystem exclusively — `ox_core`, `ox_lib`, `ox_inventory`, `ox_target`, `oxmysql`. Confirmed product decision (2026-05-21).

- NEVER generate or reference any other FiveM framework, or a non-oxmysql database driver — oxmysql + ox_core only.
- The agent only loads skills in the `OX_SKILLS` allowlist (`src/main/mastra/workspace.ts`), sourced from the tracked **root `skills/`** dir via `src/main/ipc/chat.ts` → `oxSkillPaths(join(app.getAppPath(), "skills"))`.
- To add a skill: create its folder under root `skills/` (with a `SKILL.md` whose `name:` matches the folder) AND add its name to `OX_SKILLS`.
- `.claude/skills/` is NOT the app's skill source (it's the Claude Code skill convention); the runtime uses root `skills/`.
