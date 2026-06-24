---
name: vehicle-spawner
description: "Vehicle spawner resource for ox_overextended — ox_target/ox_lib command trigger, ox_lib context menu, ox_core money + permissions, native spawn with one-vehicle-per-player cleanup. Use when generating a vehicle-spawner resource."
---

# Vehicle-Spawner Resource Patterns

You are generating a vehicle-spawner resource for an ox_overextended server. The player opens a menu (via ox_target zone or an ox_lib command), picks a vehicle from a list, the server authorizes (permission and/or payment), and the vehicle spawns with the player warped into the driver seat. Each player is limited to one spawned vehicle, cleaned up on respawn.

## Overview

A vehicle spawner is a menu-driven spawn service:

- Open via an `ox_target` zone at a garage/dealership, or an `lib.addCommand` (e.g. `/spawncar`).
- Present spawnable vehicles in an `lib.registerContext` / `lib.showContext` menu.
- The server checks **permission** (ACE / ox_core group) and/or **payment** before authorizing a spawn.
- Spawn the chosen model and **warp the ped into the driver seat**.
- Enforce **one spawned vehicle per player** — delete the previous one first.
- Optional: gate spawning behind an `ox_inventory` key item.

Two spawn strategies:

1. **Temporary spawn (default)** — a throwaway car for testing/joyriding. Spawn the native vehicle client-side after server authorization. Not persisted, not garaged.
2. **Owned/persistent spawn** — use `Ox.CreateVehicle({ model = ... }, coords, heading)` server-side so ox_core tracks it in the DB (garage-style). Only do this if the user asks for owned vehicles.

This recipe defaults to the temporary spawn; the owned variant is noted at the end.

## Core Patterns

### Config (shared)

```lua
-- config.lua  (shared_script)
Config = {
    -- price is server-authoritative; listed here only so the menu can show it
    vehicles = {
        { model = 'adder',   label = 'Truffade Adder',  price = 5000 },
        { model = 'sultan',  label = 'Karin Sultan',    price = 800  },
        { model = 'police',  label = 'Police Cruiser',  price = 0, group = 'police' },
    },
    spawnPoint = vec4(-787.7, -2024.4, 9.1, 137.0), -- x,y,z,heading
    useKeyItem = false,        -- require an ox_inventory 'vehicle_voucher' item
}
```

### Open via ox_target zone OR ox_lib command (client)

Pick one trigger. A garage zone:

```lua
-- client.lua
exports.ox_target:addSphereZone({
    coords = vec3(Config.spawnPoint.x, Config.spawnPoint.y, Config.spawnPoint.z),
    radius = 2.5,
    options = {
        {
            name = 'vehicle_spawner:open',
            icon = 'fa-solid fa-car',
            label = 'Vehicle Spawner',
            onSelect = function() OpenSpawnMenu() end,
        },
    },
})
```

Or a command (both can coexist):

```lua
-- client.lua
lib.addCommand('spawncar', {
    help = 'Open the vehicle spawner',
}, function()
    OpenSpawnMenu()
end)
```

### ox_lib context menu (client)

Build the menu from config. The option `onSelect` **only requests a spawn** — it never decides permission or charges money; that is the server's job.

```lua
-- client.lua
function OpenSpawnMenu()
    local options = {}

    for i = 1, #Config.vehicles do
        local v = Config.vehicles[i]
        options[#options + 1] = {
            title = v.label,
            description = v.price > 0 and ('$%d'):format(v.price) or 'Free',
            icon = 'car',
            onSelect = function()
                RequestSpawn(v.model)
            end,
        }
    end

    lib.registerContext({
        id = 'vehicle_spawner_menu',
        title = 'Vehicle Spawner',
        options = options,
    })

    lib.showContext('vehicle_spawner_menu')
end
```

`lib.registerContext` takes a table with `id`, `title`, and `options` (array of `{ title, description?, icon?, onSelect? }`). `lib.showContext(id)` opens it.

### Authorize + spawn (client side of the flow)

The client asks the server to authorize. The server returns whether the spawn is allowed (after permission + payment). If allowed, the client streams the model and spawns it.

```lua
-- client.lua
local spawnedVehicle = nil

function RequestSpawn(model)
    -- Server validates the model, permission, and payment, then says yes/no.
    local allowed = lib.callback.await('vehicle_spawner:authorize', false, model)
    if not allowed then
        lib.notify({ type = 'error', description = 'Not authorized to spawn that vehicle.' })
        return
    end

    -- Clean up the player's previous spawn first (one-per-player rule).
    if spawnedVehicle and DoesEntityExist(spawnedVehicle) then
        DeleteVehicle(spawnedVehicle)
    end
    spawnedVehicle = nil

    local hash = lib.requestModel(model, 10000) -- ox_lib: loads + yields, validates the model
    if not hash then
        lib.notify({ type = 'error', description = 'Invalid vehicle model.' })
        return
    end

    local p = Config.spawnPoint
    local veh = CreateVehicle(hash, p.x, p.y, p.z, p.w, true, false)
    SetModelAsNoLongerNeeded(hash)

    -- Warp the player into the driver seat (-1 = driver).
    SetPedIntoVehicle(cache.ped, veh, -1)
    SetVehicleNumberPlateText(veh, 'SPAWN')

    spawnedVehicle = veh
    lib.notify({ type = 'success', description = 'Vehicle spawned.' })
end

-- enforce one-per-player across respawns / resource restart
AddEventHandler('onResourceStop', function(resource)
    if resource == GetCurrentResourceName() and spawnedVehicle and DoesEntityExist(spawnedVehicle) then
        DeleteVehicle(spawnedVehicle)
    end
end)
```

`lib.requestModel(model)` validates the model (errors on an invalid hash) and yields until loaded — use it instead of a manual `RequestModel`/`while not HasModelLoaded` loop. `SetPedIntoVehicle(ped, veh, -1)` warps into the driver seat.

### Permission + payment check (server)

The server is the only place that decides whether a spawn is allowed. It validates the requested model against the config (so the client cannot spawn an arbitrary model), checks the ACE/group permission if the vehicle requires one, and charges via the ox_core account.

```lua
-- server.lua
local Ox = require '@ox_core.lib.init'

-- index config by model for O(1) server-side lookup + validation
local byModel = {}
for i = 1, #Config.vehicles do byModel[Config.vehicles[i].model] = Config.vehicles[i] end

lib.callback.register('vehicle_spawner:authorize', function(source, model)
    -- source is the implicit runtime id; validate the client-sent model
    if type(model) ~= 'string' then return false end

    local entry = byModel[model]
    if not entry then return false end           -- not a spawnable model — reject

    local player = Ox.GetPlayer(source)
    if not player then return false end

    -- Group/permission gate (e.g. police vehicles)
    if entry.group then
        local group = player.getGroup(entry.group)  -- returns grade/nil
        if not group then return false end
    end

    -- Optional key item gate via ox_inventory
    if Config.useKeyItem then
        local count = exports.ox_inventory:GetItemCount(source, 'vehicle_voucher')
        if not count or count < 1 then return false end
    end

    -- Payment (server owns the price)
    if entry.price and entry.price > 0 then
        local account = player.getAccount()
        if not account or account.balance < entry.price then return false end

        local ok = account.removeBalance({ amount = entry.price, message = 'Vehicle spawn' })
        if not ok then return false end
    end

    return true
end)
```

`player.getGroup(name)` returns the player's grade in that group (or nil). `player.getAccount()` + `account.removeBalance({ amount })` is the ox_core money pattern — ox_core has no `removeMoney` helper; money lives in accounts and `removeBalance` uses a safe non-overdraw guard by default.

### Optional: ox_inventory key item

If `Config.useKeyItem`, check the item server-side with `exports.ox_inventory:GetItemCount(source, name)` (shown above). To consume it on spawn, remove after a successful authorize:

```lua
exports.ox_inventory:RemoveItem(source, 'vehicle_voucher', 1)
```

The item must be registered in ox_inventory's `data/items.lua` on the server. See the `fw-ox-core` skill for inventory export signatures.

## Security

Spawning is a privileged, abusable action (vehicle spam, free supercars, restricted vehicles), so authority lives on the server per the `security` skill:

- **Validate the model server-side against the config.** Never spawn whatever string the client sends — index the config by model and reject unknown models. This stops a client from spawning banned or non-existent models.
- **Permission and payment are server-decided.** The menu `onSelect` only requests; `lib.callback.register('vehicle_spawner:authorize', ...)` runs server-side with the implicit `source` and is the single source of truth.
- **Price comes from the server config**, never from the callback args.
- **Rate-limit spawns** so a player cannot spam-spawn (DoS / entity flood). Use the cooldown pattern from the `security` skill:

```lua
local cooldown = {}
-- inside the authorize callback, before charging:
local now = GetGameTimer()
if cooldown[source] and now - cooldown[source] < 5000 then return false end
cooldown[source] = now
```

- **Clean up per-player state** (`cooldown`) in `playerDropped`.
- For owned/persistent vehicles, prefer server-side `Ox.CreateVehicle` so ox_core controls the entity rather than trusting a client-created one.

Cross-reference the `security` skill for full source validation, input validation, and cleanup requirements.

## Common Mistakes

- **Spawning an unvalidated model.** Passing the raw client model to `CreateVehicle`/`Ox.CreateVehicle` lets clients spawn anything. Always look the model up in the server config first.
- **Charging or permission-checking on the client.** The menu, price display, and group check shown to the client are cosmetic. The server must re-check everything in `authorize`.
- **Skipping `lib.requestModel`.** Calling `CreateVehicle` before the model streams in spawns nothing. `lib.requestModel` yields until loaded and validates the hash — use it.
- **No one-per-player cleanup.** Without deleting the previous `spawnedVehicle`, players flood the server with abandoned cars. Track the handle and `DeleteVehicle` before each new spawn and on `onResourceStop`.
- **Reaching for a spawn/money helper that does not exist.** There is no engine-level `SpawnVehicle` shortcut or `removeMoney` on the player. Use the native `CreateVehicle` (temporary) or `Ox.CreateVehicle` (owned), and resolve `player.getAccount()` then `account.removeBalance` for money.
- **Forgetting the seat index.** `SetPedIntoVehicle(ped, veh, -1)` — `-1` is the driver seat; positive indexes are passengers.
- **Treating `lib.callback.await` as fire-and-forget.** It returns the server's authorization boolean; gate the actual spawn on it.

## Owned/persistent variant (server-side spawn)

If the user wants vehicles tracked in the DB (garage-style), spawn server-side instead of client-side:

```lua
-- server.lua, inside or after authorize
local p = Config.spawnPoint
local vehicle = Ox.CreateVehicle({ model = model }, vec3(p.x, p.y, p.z), p.w)
-- vehicle.entity / vehicle.netId can then be handed back to the client to warp in
```

`Ox.CreateVehicle(data, coords, heading)` accepts a model string or `{ model = ... }` and returns an `OxVehicle` instance persisted by ox_core. Use this only for owned vehicles; for throwaway spawns the native client path above is lighter.

## Dependencies

| Resource     | Why                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| ox_lib       | `lib.registerContext`/`showContext`, `lib.addCommand`, `lib.callback`, `lib.requestModel`, `lib.notify`, `cache`                       |
| ox_core      | Player object, group/permission (`player.getGroup`), money (`player.getAccount`, `account.removeBalance`), optional `Ox.CreateVehicle` |
| ox_target    | Only if opening the menu from a garage zone (`addSphereZone`)                                                                          |
| ox_inventory | Only if gating spawning behind a key item (`GetItemCount`, `RemoveItem`)                                                               |

`fxmanifest.lua` essentials:

```lua
fx_version 'cerulean'
game 'gta5'

shared_scripts {
    '@ox_lib/init.lua',
    'config.lua',
}

client_scripts { 'client.lua' }
server_scripts { 'server.lua' }

dependencies {
    'ox_lib',
    'ox_core',
    'ox_target',  -- omit if command-only
}
```

Load order: `ox_lib` before `ox_core`. Add `@ox_lib/init.lua` to `shared_scripts` for the global `lib.*` and `cache`, and `require '@ox_core.lib.init'` in `server.lua` for the `Ox` global.
