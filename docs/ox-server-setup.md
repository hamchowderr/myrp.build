# ox_core server setup (MariaDB) — official requirements

Authoritative setup notes for standing up an **ox_overextended** FiveM server,
sourced from the official CommunityOx/Overextended docs and the ox_core recipe.
Captured 2026-05-26 for myRP.build.

## Sources

- ox_core recipe `server.cfg` (canonical ensure order + convars):
  https://github.com/overextended/ox_core_recipe/blob/main/server.cfg
- oxmysql docs (connection string): https://coxdocs.dev/oxmysql
- ox docs site: https://overextended.dev (formerly coxdocs.dev)
- ox_core repo: https://github.com/overextended/ox_core

## Hard requirements (from ox_core fxmanifest, v1.5.14)

```lua
dependencies {
  '/server:12913',   -- minimum FXServer artifact build
  '/onesync',        -- OneSync MUST be enabled
}
node_version '22'    -- bundled in recent FXServer artifacts
```

- **FXServer artifact ≥ build 12913.** (Our local server reports `v1.0.0.25770` — well past it.)
- **OneSync must be ON** — `set onesync on` in `server.cfg`. ox_core will not start without it.
- **Node 22** — present in recent artifacts; no action needed on current builds.

## Database

- ox_core uses the **`mariadb` npm driver directly** (`server/db/pool.ts`) and
  oxmysql for everything else. **MariaDB is required** (not MySQL-only, not Dolt —
  see dolthub/dolt#11098, fixed in Dolt v2.0.8).
- Import `ox_core/sql/install.sql` once. It `CREATE DATABASE`s and `USE`s a schema
  named **`overextended`** by default (the txAdmin recipe substitutes `{{dbName}}`).
- At runtime ox_core also auto-creates two aux tables (`user_tokens`,
  `banned_users`) via `server/db/schema.ts`.

### Local dev database (Docker)

```bash
docker run -d --name fivem-mariadb -p 3306:3306 \
  -e MARIADB_ROOT_PASSWORD=myrpbuild_dev \
  -e MARIADB_DATABASE=fivem -e MARIADB_USER=fivem -e MARIADB_PASSWORD=myrpbuild_dev \
  -v fivem-mariadb-data:/var/lib/mysql mariadb:11.4
# ox_core's install.sql creates its own `overextended` schema; import as root:
#   Get-Content ox_core/sql/install.sql -Raw | docker exec -i fivem-mariadb mariadb -uroot -pmyrpbuild_dev
#   GRANT ALL ON overextended.* TO 'fivem'@'%'; FLUSH PRIVILEGES;
```

## Connection string (oxmysql + ox_core both read this)

```cfg
set mysql_connection_string "mysql://USER:PASS@HOST:3306/DB?charset=utf8mb4"
```

- Recommended URI form (2025). Avoid reserved chars in the password
  (`; , / ? : @ & = + $ #`) or switch to the `server=;database=;userid=;password=` form.
- Load oxmysql **near the top** of resources; if you stream many assets, load
  those first so the DB connection doesn't time out.

## server.cfg — required additions (in order)

```cfg
set onesync on
set mysql_connection_string "mysql://fivem:myrpbuild_dev@localhost:3306/overextended?charset=utf8mb4"
setr ox:locale "en"

ensure oxmysql
ensure ox_lib
ensure ox_core
```

`sv_enforceGameBuild 3258` is already required/standard and present in our cfg.

## ox suite (added 2026-05-26)

The Overextended ox suite on top of the core. Verified-loading versions + deps:

| Resource | Ver | Depends on | SQL |
|---|---|---|---|
| ox_target | 1.18.1 | ox_lib | none |
| ox_inventory | 2.47.8 | oxmysql, ox_lib, onesync | none (uses ox_core's `character_inventory`/`ox_inventory` tables) |
| ox_banking | 1.0.6 | ox_core, ox_lib, oxmysql, **ox_inventory** | none (uses ox_core `accounts*`) |
| ox_commands | main | ox_lib | none |
| ox_doorlock | 1.22.1 | oxmysql, ox_lib | **`sql/ox_doorlock.sql`** (schema; `default.sql`/`community_mrpd.sql` are optional sample doors) |
| ox_fuel | 1.5.4 | ox_lib, **ox_inventory** | none |

Add after the core block (recipe order satisfies all deps), plus the convar:

```cfg
setr inventory:target true

ensure ox_target
ensure ox_inventory
ensure ox_banking
ensure ox_commands
ensure ox_doorlock
ensure ox_fuel
```

Import once: `ox_doorlock/sql/ox_doorlock.sql` into the `overextended` db.
ox_inventory/ox_banking reuse ox_core's schema — no extra import. `ox_commands`
has no release; use the `main` branch archive. All six verified `Started
resource …` clean on the live server with MariaDB.

## Full overextended recipe ensure order (for reference)

The complete RP base (beyond the lean ox_lib/oxmysql/ox_core core) loads in this
order per the recipe:

```
ensure chat
ensure sessionmanager
start pe-basicloading
start bob74_ipl
start pma-voice
start oxmysql
start ox_lib
start ox_core
start ox_target
start illenium-appearance
start ox_inventory
start ox_banking
start ox_commands
start ox_doorlock
start ox_fuel
start npwd
```

Extra convar seen in the recipe: `setr inventory:target true`.

## Resource placement

Release builds (with compiled `dist/` + `web/build`) of ox_lib, oxmysql, ox_core
go in `resources/[ox]/`. Use the **release zips**, not raw source clones —
ox_lib/ox_core ship built artifacts only in releases (a raw clone is missing
`ox_lib/web/build`).
