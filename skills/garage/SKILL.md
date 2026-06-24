---
name: garage
description: "Vehicle garage resource for ox_overextended — ox_core Vehicle/Player API, oxmysql vehicles table, ox_lib context menu, ox_target/marker spawn points. Use when generating a garage resource."
---

# Garage Resource Patterns

You are generating a garage resource for an ox_overextended server. A garage lets a player store and retrieve vehicles they own: walk to a garage point, open a menu listing owned vehicles, spawn the selected one, and store the current one back to disk.

## Overview

A garage has four moving parts:

1. **Garage points** — physical interaction spots in the world (ox_target zone or `lib.zones` marker).
2. **Ownership lookup** — server queries the `vehicles` table for rows owned by the active character (`charId`).
3. **Retrieve (spawn)** — server spawns a stored vehicle via `exports.ox_core:SpawnVehicle(id, coords, heading)`, which restores its saved properties and clears the `stored` flag.
4. **Store (despawn)** — server marks a vehicle `stored` (e.g. `'garageName'`) and despawns the entity via the vehicle instance's `setStored` method.

Everything authoritative runs **server-side**. The client only opens menus, picks a spot, and asks the server to act — it never decides ownership or writes the database.

> ox_core does NOT use a custom `owned_vehicles` table. It ships a `vehicles` table keyed by `charId`. Use ox_core's Vehicle API (`CreateVehicle`/`SpawnVehicle`/`CallVehicle`) instead of writing raw spawn SQL — ox_core owns vehicle persistence.

## The ox_core `vehicles` table

This table is created by ox_core's `install.sql`. You query it, but let ox_core write the heavy columns (`data`, `trunk`, `glovebox`).

```sql
-- Created by ox_core — do NOT recreate. Shown for reference only.
CREATE TABLE IF NOT EXISTS `vehicles` (
  `id`       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plate`    CHAR(8)      NOT NULL DEFAULT '',
  `vin`      CHAR(17)     NOT NULL,
  `owner`    INT UNSIGNED NULL DEFAULT NULL,  -- characters.charId
  `group`    VARCHAR(20)  NULL DEFAULT NULL,  -- group-owned vehicles
  `model`    VARCHAR(20)  NOT NULL,
  `class`    TINYINT UNSIGNED NULL DEFAULT NULL,
  `data`     JSON         NOT NULL,           -- ox_core-managed vehicle properties
  `trunk`    JSON         NULL DEFAULT NULL,
  `glovebox` JSON         NULL DEFAULT NULL,
  `stored`   VARCHAR(50)  NULL DEFAULT NULL,  -- NULL = spawned/out; string = garage name or 'impound'
  PRIMARY KEY (`id`),
  UNIQUE KEY `plate` (`plate`),
  UNIQUE KEY `vin` (`vin`),
  KEY `vehicles_owner_key` (`owner`)
);
```

Key facts:

- **`owner`** is the integer `charId` of the owning character — NOT a license or steam id string.
- **`stored`** is the source of truth for "is this vehicle in a garage?". `NULL` means the vehicle is out in the world. A non-null string (the garage name, or `'impound'`) means it is parked.
- **`plate`** is the unique display plate; **`vin`** is the immutable internal id.

## Core Patterns

### Garage points (ox_target — preferred)

Register a sphere zone at each garage. The `onSelect` callback fires when the player interacts.

```lua
-- client/main.lua
for index, garage in ipairs(Config.Garages) do
    exports.ox_target:addSphereZone({
        coords = garage.coords,
        radius = 2.0,
        debug = false,
        options = {
            {
                name = ('garage_open_%d'):format(index),
                icon = 'fas fa-warehouse',
                label = ('Open %s'):format(garage.label),
                distance = 2.0,
                onSelect = function()
                    OpenGarageMenu(index)
                end,
            },
        },
    })
end
```

### Garage points (lib.zones marker — alternative)

If you do not want ox_target as a dependency, use `lib.zones.sphere` with text UI + a keybind.

```lua
-- client/main.lua
for index, garage in ipairs(Config.Garages) do
    lib.zones.sphere({
        coords = garage.coords,
        radius = 2.0,
        debug = false,
        onEnter = function()
            lib.showTextUI(('[E] Open %s'):format(garage.label))
        end,
        onExit = function()
            lib.hideTextUI()
        end,
        inside = function()
            if IsControlJustReleased(0, 38) then -- E
                OpenGarageMenu(index)
            end
        end,
    })
end
```

### Listing owned vehicles (ox_lib context menu)

The client asks the server for the player's stored vehicles in this garage, then builds a context menu. The server is the only place ownership is decided.

```lua
-- client/main.lua
function OpenGarageMenu(garageIndex)
    local garage = Config.Garages[garageIndex]
    local vehicles = lib.callback.await('garage:getOwned', false, garageIndex)

    if not vehicles or #vehicles == 0 then
        return lib.notify({ title = garage.label, description = 'You have no vehicles stored here.', type = 'error' })
    end

    local options = {}
    for _, veh in ipairs(vehicles) do
        options[#options + 1] = {
            title = veh.label or veh.model,
            description = ('Plate: %s'):format(veh.plate),
            icon = 'car',
            metadata = { { label = 'Class', value = tostring(veh.class) } },
            onSelect = function()
                TriggerServerEvent('garage:retrieve', garageIndex, veh.id)
            end,
        }
    end

    lib.registerContext({ id = 'garage_menu', title = garage.label, options = options })
    lib.showContext('garage_menu')
end
```

### Ownership query (server, ox_core + oxmysql)

Resolve the active character with `exports.ox_core:GetPlayer(source)`, read its `charId`, then query the `vehicles` table for rows owned by that `charId` and stored in this garage.

```lua
-- server/main.lua
lib.callback.register('garage:getOwned', function(source, garageIndex)
    local garage = Config.Garages[garageIndex]
    if not garage then return {} end

    local player = exports.ox_core:GetPlayer(source)
    if not player or not player.charId then return {} end

    -- stored = garage.name → vehicle is currently parked in THIS garage
    local rows = MySQL.query.await(
        'SELECT id, plate, model, class FROM vehicles WHERE owner = ? AND stored = ?',
        { player.charId, garage.name }
    )

    for _, row in ipairs(rows) do
        row.label = Config.VehicleLabels[row.model] or row.model
    end

    return rows
end)
```

### Retrieving a vehicle (server spawns via ox_core)

Re-verify ownership server-side (never trust the `id` the client sent), confirm the vehicle is actually stored, then let ox_core spawn it. `SpawnVehicle` restores the saved properties and sets `stored = NULL` automatically.

```lua
-- server/main.lua
RegisterNetEvent('garage:retrieve', function(garageIndex, vehicleId)
    local source = source
    if type(garageIndex) ~= 'number' or type(vehicleId) ~= 'number' then return end

    local garage = Config.Garages[garageIndex]
    if not garage then return end

    local player = exports.ox_core:GetPlayer(source)
    if not player or not player.charId then return end

    -- Re-verify ownership AND that it is parked in this garage (server-authoritative)
    local row = MySQL.single.await(
        'SELECT id FROM vehicles WHERE id = ? AND owner = ? AND stored = ?',
        { vehicleId, player.charId, garage.name }
    )
    if not row then
        return lib.notify(source, { description = 'That vehicle is not stored here.', type = 'error' })
    end

    -- ox_core spawns at the configured spawn point, restores properties, clears `stored`
    local vehicle = exports.ox_core:SpawnVehicle(vehicleId, garage.spawn.xyz, garage.spawn.w)
    if not vehicle then
        return lib.notify(source, { description = 'Failed to spawn vehicle.', type = 'error' })
    end

    -- Hand the keys / seat the player (project-specific). Get the network id to seat client-side.
    local netId = NetworkGetNetworkIdFromEntity(vehicle.entity)
    TriggerClientEvent('garage:seatPlayer', source, netId)
end)
```

```lua
-- client/main.lua
RegisterNetEvent('garage:seatPlayer', function(netId)
    local veh = lib.waitFor(function()
        local e = NetworkGetEntityFromNetworkId(netId)
        if e ~= 0 and DoesEntityExist(e) then return e end
    end, 'vehicle did not stream in', 5000)
    if veh then SetPedIntoVehicle(cache.ped, veh, -1) end
end)
```

### Storing the current vehicle (server despawns via ox_core)

When the player parks, find the ox_core vehicle instance from the entity, verify they own it, then call its `setStored` method through `exports.ox_core:CallVehicle`. Passing `despawn = true` deletes the world entity and persists `stored`.

```lua
-- client/main.lua: triggered from the same garage menu / target option
RegisterNetEvent('garage:store', function(garageIndex)
    local veh = cache.vehicle
    if not veh then
        return lib.notify({ description = 'You are not in a vehicle.', type = 'error' })
    end
    TriggerServerEvent('garage:store', garageIndex, NetworkGetNetworkIdFromEntity(veh))
end)
```

```lua
-- server/main.lua
RegisterNetEvent('garage:store', function(garageIndex, netId)
    local source = source
    if type(garageIndex) ~= 'number' or type(netId) ~= 'number' then return end

    local garage = Config.Garages[garageIndex]
    if not garage then return end

    local player = exports.ox_core:GetPlayer(source)
    if not player or not player.charId then return end

    local entity = NetworkGetEntityFromNetworkId(netId)
    if not DoesEntityExist(entity) then return end

    -- Resolve the ox_core vehicle instance from the entity
    local vehicle = exports.ox_core:GetVehicleFromEntity(entity)
    if not vehicle or vehicle.owner ~= player.charId then
        return lib.notify(source, { description = 'You do not own this vehicle.', type = 'error' })
    end

    -- setStored(value, despawn): write `stored` = garage name AND delete the entity.
    -- CallVehicle takes the STRING vin (a numeric id is treated as an entityId and misses).
    exports.ox_core:CallVehicle(vehicle.vin, 'setStored', garage.name, true)
    lib.notify(source, { description = 'Vehicle stored.', type = 'success' })
end)
```

### Config table

```lua
-- config.lua (shared_script)
Config = {}

Config.Garages = {
    {
        name = 'legion_garage',                       -- matches `stored` column value
        label = 'Legion Square Garage',
        coords = vec3(215.8, -810.1, 30.7),           -- interaction point
        spawn = vec4(227.5, -800.2, 30.5, 158.0),     -- where retrieved vehicles appear
    },
    {
        name = 'pillbox_garage',
        label = 'Pillbox Hill Garage',
        coords = vec3(310.5, -772.1, 29.3),
        spawn = vec4(305.0, -780.0, 29.2, 90.0),
    },
}

-- Optional friendly model → display name map for the menu
Config.VehicleLabels = {
    adder = 'Truffade Adder',
    sultanrs = 'Karin Sultan RS',
}
```

### fxmanifest.lua

```lua
fx_version 'cerulean'
game 'gta5'

shared_scripts {
    '@ox_lib/init.lua',
    'config.lua',
}

client_scripts {
    'client/main.lua',
}

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    'server/main.lua',
}

dependencies {
    'ox_lib',
    'ox_core',
    'oxmysql',
    'ox_target',  -- only if using the ox_target spawn points
}
```

## Security

Garages move owned property and economy-relevant assets, so apply the standard server-authoritative rules (see the `security` skill):

- **Ownership is decided server-side, always.** Re-query `owner = player.charId` on every retrieve and store. Never trust a `vehicleId` or `netId` from the client as proof of ownership.
- **Validate `stored` on retrieve.** A vehicle that is already spawned (`stored IS NULL`) must not be spawnable again — that's how exploiters duplicate cars. The `stored = ?` clause in the retrieve query prevents this.
- **Type-check every argument** (`garageIndex`, `vehicleId`, `netId`) before use, and verify the garage index exists in `Config.Garages`.
- **Rate-limit** retrieve/store events with a per-source cooldown (`GetGameTimer()`), and clear it in `playerDropped` — spawning vehicles is expensive.
- **Distance check** the store request: verify the player's ped is near the garage coords server-side before allowing a store, so a player can't park a car from across the map.
- **Use the implicit `source`** in every handler; never accept a player id as an argument.

## Common Mistakes

- **Inventing an `owned_vehicles` table.** ox_core uses `vehicles` keyed by `charId`. Do not write your own ownership schema or raw `INSERT INTO owned_vehicles`. Let ox_core own persistence; you only read for the menu and call `SpawnVehicle`/`setStored`.
- **Spawning with `CreateVehicle` natives directly.** Using the raw `CreateVehicle` GTA native bypasses ox_core, so the vehicle has no `vin`, no saved properties, and won't persist. Use `exports.ox_core:SpawnVehicle(id, ...)`.
- **Forgetting `setStored(..., true)` despawns.** The second arg controls despawn. `setStored('garage', false)` writes the column but leaves the entity in the world (duplication bug). Pass `true` when parking.
- **Comparing `owner` to a license string.** `owner` is the integer `charId` from `player.charId`. Comparing it to `player.stateId` or a license string will always fail.
- **Querying with `stored IS NOT NULL` to mean "owned".** `stored` only reflects garage state. Filter ownership by `owner = ?`, and garage location by `stored = ?`.
- **Skipping `lib.waitFor` when seating the player.** The spawned vehicle entity may not have streamed to the client yet; resolve the entity from the netId with `lib.waitFor` before `SetPedIntoVehicle`.

## Dependencies

| Resource    | Why                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ox_lib`    | Context menu (`lib.registerContext`/`lib.showContext`), callbacks (`lib.callback`), notifications, zones (`lib.zones`), `lib.requestModel`, `lib.waitFor`. |
| `ox_core`   | Vehicle persistence + spawn/store API (`GetPlayer`, `GetVehicleFromEntity`, `SpawnVehicle`, `CallVehicle` → `setStored`) and the `vehicles` table.         |
| `oxmysql`   | Querying the `vehicles` table to list a character's owned/stored vehicles.                                                                                 |
| `ox_target` | Optional — sphere-zone interaction points at each garage. Omit if using `lib.zones` markers + keybind.                                                     |

Cross-references: `fw-ox-core` (player object + Vehicle API), `db-oxmysql` (query syntax), `security` (server-authoritative ownership, rate limiting), `lore` (lore-friendly garage names).
