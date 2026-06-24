---
name: server-practices
description: "FiveM server administration best practices — server.cfg optimization, resource load order, performance monitoring (resmon), txAdmin, cache management, player limits, convar settings. Use when advising on server setup or generating server configuration."
---

# FiveM Server Best Practices

Comprehensive guide to running a stable, performant FiveM server. These practices are learned from production servers running 64-200+ player slots.

## server.cfg — the complete picture

A real ox server.cfg, top to bottom — the FULL structure: base FiveM resources,
the ox stack in the correct order, and the required convars (not just the ox
lines). Grounded in our live server.cfg + `docs/ox-server-setup.md`.

```cfg
# --- Identity (shown in the server browser) ---
sv_hostname "My Server"
sets sv_projectName "My Server"
sets sv_projectDesc "Description shown in the server browser"
sets tags "roleplay, ox"
sets locale "en-US"

# --- Game build (GTA Online DLC level) ---
# Tracks the latest GTA Online DLC; the number changes with each DLC drop, so do
# NOT treat any value as permanently "latest" — check the current FXServer
# artifact (runtime.fivem.net/artifacts) + the DLC list. The NEWEST as of 2026-06 is
# 3570 (mp2025_01, Money Fronts), still flagged beta; 3258 (mp2024_01) is a widely-used
# STABLE build. Use the latest stable, bump as new DLC stabilizes, and never treat a
# hardcoded number as permanently "the latest".
sv_enforceGameBuild 3258

# --- Network ---
sv_maxclients 48
endpoint_add_tcp "0.0.0.0:30120"
endpoint_add_udp "0.0.0.0:30120"
set resources_useSystemChat true

# --- Secrets — keep OUT of version control ---
# Externalize sv_licenseKey, steam_webApiKey, rcon_password and
# mysql_connection_string into a gitignored file, then exec it:
exec myrp-secrets.cfg

# --- ox required settings ---
# OneSync is MANDATORY — ox_lib/ox_core refuse to start without it. Under txAdmin,
# set OneSync on the txAdmin settings page instead of here (txAdmin's cfg validator
# rejects onesync in server.cfg).
set onesync on
setr ox:locale "en"
setr inventory:target true            # ox_inventory uses ox_target for world interaction
setr sv_stateBagStrictMode true       # ox_lib recommended — reject client statebag tampering

# --- Security ---
sv_scriptHookAllowed false            # block trainers/menus
set sv_enableNetworkedPhoneExplosions false
sv_filterRequestControl 2             # block entity-control griefing (raise toward 4 if needed)
# For a port-forwarded test/public server also consider:
#   sv_endpointPrivacy true   sv_requestParanoia 1

# --- Base / system resources (FiveM defaults — must load FIRST) ---
ensure mapmanager
ensure chat
ensure spawnmanager
ensure sessionmanager
ensure basic-gamemode
ensure hardcap
# (Commonly added too: pma-voice for proximity voice, a loading screen, and an
#  appearance resource such as illenium-appearance.)

# --- ox core stack — ORDER MATTERS: database -> lib -> core ---
ensure oxmysql
ensure ox_lib
ensure ox_core

# --- ox suite (after the core; this order satisfies every dependency) ---
ensure ox_target        # deps: ox_lib
ensure ox_inventory     # deps: oxmysql, ox_lib, onesync
ensure ox_banking       # deps: ox_core, ox_lib, oxmysql, ox_inventory
ensure ox_commands      # deps: ox_lib
ensure ox_doorlock      # deps: oxmysql, ox_lib   (import sql/ox_doorlock.sql once)
ensure ox_fuel          # deps: ox_lib, ox_inventory

# --- Admin permissions ---
add_ace group.admin command allow
add_ace group.admin command.quit deny
add_principal identifier.fivem:XXXXXXXX group.admin

# --- Your generated / custom resources (after the ox resources they depend on) ---
ensure hud-core
ensure bank-balance
ensure admin-spawn-vehicle
# ...
```

> Keep `server.cfg` comments free of semicolons — FiveM splits a line on `;`
> before honoring the `#`, then runs the remainder as commands.

### Hard requirements (from ox_core's fxmanifest)

- **FXServer artifact build ≥ 12913** and **Node 22** (present in recent artifacts).
- **OneSync ON** — ox_core will not start otherwise.
- **MariaDB** (not MySQL-only, not Dolt) — ox_core uses the `mariadb` npm driver
  directly. Import `ox_core/sql/install.sql` once (it creates the `overextended` schema).
- Use the **release zips** of ox_lib / ox_core / oxmysql (they ship built `dist/` +
  `web/build`), not raw source clones.

See `docs/ox-server-setup.md` for the full requirements, exact ox-suite versions,
and the SQL imports.

### Load order rules

1. **Base FiveM resources first** — `mapmanager`, `chat`, `spawnmanager`,
   `sessionmanager`, `hardcap` (what every server needs before gameplay).
2. **Database driver next** — `oxmysql` must run before anything that queries the DB.
3. **`ox_lib` before `ox_core`** — ox_core fails to initialize if ox_lib isn't up;
   ox_lib provides the `lib.*` globals nearly every resource uses.
4. **ox suite after the core** — `ox_target`, then `ox_inventory`, then the
   resources that depend on them (`ox_banking`, `ox_fuel`).
5. **Custom resources after their ox dependencies** — so the exports they call exist.
6. **Game build matches your content** — a higher `sv_enforceGameBuild` unlocks
   newer DLC vehicles/weapons; keep it current and verify your resources support it.

## Performance Monitoring

### resmon — The Built-In Resource Monitor

```
# Enable in console or server.cfg
resmon 1

# Open in-game with F8 console:
resmon
```

**What to watch:**

| Metric              | Healthy | Warning | Critical |
| :------------------ | :------ | :------ | :------- |
| Server frame time   | < 8ms   | 8-16ms  | > 16ms   |
| Per-resource CPU    | < 0.5ms | 0.5-2ms | > 2ms    |
| Per-resource memory | < 5MB   | 5-20MB  | > 20MB   |

### Common Performance Killers

1. **`Wait(0)` in non-render loops** — 60+ executions/second per thread. Use `Wait(500)` or higher.
2. **Unindexed SQL queries** — `WHERE` on non-indexed columns under load. Always index lookup columns.
3. **Entity enumeration every frame** — `GetGamePool('CPed')` is expensive. Cache results, poll at intervals.
4. **Excessive network events** — each event is a network packet. Batch data when possible.
5. **Memory leaks in per-player state** — forgetting to clean up on `playerDropped`.
6. **Large file reads on startup** — reading huge config files synchronously blocks the resource thread.

### Profiler

```
# Start profiler (captures 5 seconds)
profiler record 5000

# View results in browser
profiler view
```

## OneSync

OneSync is required for modern FiveM servers. It handles entity synchronization across all players.

```cfg
set onesync on
```

### OneSync Best Practices

- **Entity limits**: OneSync supports ~8192 entities server-wide. Monitor with `sv_entityLockdown`
- **Scope awareness**: Entities outside a player's scope are not synced to them — design around this
- **Statebags**: Use statebags for entity data that needs to sync across clients
- **Routing buckets**: Use `SetPlayerRoutingBucket` to isolate players (interiors, instances)

```lua
-- Routing buckets for instanced content
SetPlayerRoutingBucket(source, bucketId)
SetEntityRoutingBucket(entity, bucketId)

-- Statebags for synced entity data
Entity(entity).state.isLocked = true
-- Client reads:
local locked = Entity(vehicle).state.isLocked
```

## txAdmin

txAdmin is the standard server management panel for FiveM.

### Key Features to Configure

- **Scheduled restarts**: Set up automatic restarts every 6-8 hours to prevent memory leaks
- **Player banning**: Use txAdmin's ban system, not custom ban resources (it's more reliable)
- **Resource monitoring**: txAdmin monitors resource crashes and can auto-restart them
- **Backups**: Configure automatic server data backups before each restart
- **Whitelist**: Use txAdmin whitelist for closed-community servers

### Restart Schedule

```cfg
# In txAdmin settings or via scheduled tasks:
# Restart at 4 AM, 12 PM, 8 PM (every 8 hours)
# Announce 15 minutes before, then 5 minutes, then 1 minute
```

## Cache Management

### Server-Side Caching Patterns

```lua
-- Cache expensive lookups from YOUR resource's own table (keyed by ox_core charId)
local dataCache = {}

local function getData(charId)
  if dataCache[charId] then
    return dataCache[charId]
  end

  local data = MySQL.single.await('SELECT * FROM my_resource_data WHERE charId = ?', { charId })
  dataCache[charId] = data
  return data
end

-- Invalidate on change
local function updateData(charId, key, value)
  MySQL.update.await('UPDATE my_resource_data SET ?? = ? WHERE charId = ?', { key, value, charId })
  if dataCache[charId] then
    dataCache[charId][key] = value
  end
end

-- ALWAYS clean up
AddEventHandler('playerDropped', function()
  playerCache[source] = nil
end)
```

### Client-Side Asset Caching

```lua
-- Always release models and assets after use
local function spawnProp(model, coords)
  local hash = type(model) == 'string' and `model` or model
  RequestModel(hash)

  local timeout = 0
  while not HasModelLoaded(hash) do
    Wait(100)
    timeout = timeout + 100
    if timeout > 5000 then
      print('[WARN] Model load timeout: ' .. model)
      return nil
    end
  end

  local obj = CreateObject(hash, coords.x, coords.y, coords.z, true, false, false)
  SetModelAsNoLongerNeeded(hash) -- ALWAYS release after creation
  return obj
end
```

## Convar Best Practices

```cfg
# Network performance
set sv_maxPacketSize 4096
set net_statsFile "netstats.log"

# Security
sv_scriptHookAllowed 0           # Block ScriptHook (cheat tool)
sv_enableNetworkedPhoneExplosions 0  # Block phone explosion exploit

# Voice (if using pma-voice or mumble-voip)
setr voice_useNativeAudio false
setr voice_useSendingRangeOnly true

# Disable problematic features
set sv_enableNetworkedSounds 1
set sv_filterRequestControl 4      # Strict entity request control
```

## Database Optimization

### Connection Pool Sizing

```cfg
# oxmysql connection pool (in server.cfg or oxmysql config)
# Rule of thumb: 2 connections per 32 players, minimum 5
set mysql_connection_string "mysql://user:pass@localhost/db?charset=utf8mb4&connectionLimit=10"
```

### Slow Query Prevention

- Index every column used in `WHERE`, `JOIN`, or `ORDER BY`
- Keep transactions short — don't hold them across `Wait()` calls
- Use `.await` queries consistently (they auto-release connections)
- Avoid `SELECT *` — request only needed columns
- Run schema migrations during maintenance windows, not resource starts

## Player Slot Optimization

| Player Count | Recommended Specs  | Key Settings                            |
| :----------- | :----------------- | :-------------------------------------- |
| 32           | 2 cores, 4GB RAM   | Default OneSync                         |
| 64           | 4 cores, 8GB RAM   | OneSync, optimized resources            |
| 128          | 6 cores, 16GB RAM  | OneSync, entity limits, routing buckets |
| 200+         | 8+ cores, 32GB RAM | OneSync Infinity, aggressive culling    |

### Scaling Tips

- **Reduce entity spawn distances** — fewer synced entities = less bandwidth
- **Use routing buckets for interiors** — players in separate buckets don't sync entities
- **Optimize NUI resources** — each NUI is a Chromium instance consuming RAM
- **Batch database writes** — don't save every keystroke; save on intervals or events
- **Profile first, optimize second** — use `resmon` and `profiler` to find actual bottlenecks

## Server Crash Prevention

1. **Never `error()` in a thread** — it kills the entire resource. Use pcall or return early.
2. **Catch export failures** — if a dependency isn't started, exports throw. Use pcall.
3. **Set timeouts on loops** — infinite loops without `Wait()` freeze the server thread.
4. **Monitor memory** — Lua resources that leak memory will eventually crash the server.
5. **Handle edge cases** — player disconnects mid-transaction, entity deleted mid-operation, etc.

```lua
-- Safe export call pattern
local function safeExport(resource, export, ...)
  local ok, result = pcall(function(...)
    return exports[resource][export](exports[resource], ...)
  end, ...)

  if not ok then
    print(('[WARN] Export %s:%s failed: %s'):format(resource, export, tostring(result)))
    return nil
  end

  return result
end
```

## Reference

- https://docs.fivem.net/docs/server-manual/server-commands/
- https://docs.fivem.net/docs/server-manual/setting-up-a-server/
- https://docs.fivem.net/docs/scripting-reference/convars/
