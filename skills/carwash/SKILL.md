---
name: carwash
description: "Vehicle carwash resource for ox_overextended — ox_target sphere zones, ox_lib progressBar, ox_core account money, vehicle wash natives. Use when generating a carwash resource."
---

# Carwash Resource Patterns

You are generating a carwash resource for an ox_overextended server. The player drives into a wash bay, interacts via ox_target, pays a fee (validated server-side), watches a blocking ox_lib progress bar, and the vehicle's dirt level is cleaned via natives.

## Overview

A carwash is a location-based service resource:

- One or more wash bays defined as `ox_target` sphere zones at fixed coords.
- The player must be **in a vehicle** to use the bay.
- A fixed price is charged from the player's ox_core money account — looked up and deducted **server-side only**.
- An ox_lib `progressBar` (blocking) gives feedback during the wash; the wash itself is just `SetVehicleDirtLevel(veh, 0.0)` plus `WashDecalsFromVehicle`.
- Optional: an oxmysql table for per-bay config (price, label) instead of a hardcoded Lua `Config`.

Use this recipe when the user asks for a carwash, vehicle wash, or "clean my car" service. Do NOT build it as an inventory item unless asked — the default is a location interaction.

## Core Patterns

### Config (shared)

Keep prices and bay coords in a shared config so client and server agree on locations, but the **price the server charges must come from the server's own copy** — never from the client payload.

```lua
-- config.lua  (shared_script)
Config = {
    price = 150,          -- cost per wash; server is authoritative
    duration = 8000,      -- progress bar ms
    bays = {
        vec3(26.4, -1391.5, 29.3),
        vec3(-74.9, 6420.6, 31.5),
    },
}
```

### ox_target sphere zones (client)

Register a sphere zone at each bay. The `onSelect`/option `canInteract` only fires the wash flow — it never touches money. Gate the option so it only shows when the player is driving.

```lua
-- client.lua
for i = 1, #Config.bays do
    exports.ox_target:addSphereZone({
        coords = Config.bays[i],
        radius = 4.0,
        debug = false,
        options = {
            {
                name = ('carwash:bay_%d'):format(i),
                icon = 'fa-solid fa-soap',
                label = ('Wash Vehicle ($%d)'):format(Config.price),
                -- only offer the option when the player is the driver of a vehicle
                canInteract = function()
                    local veh = cache.vehicle -- ox_lib cache; nil when on foot
                    return veh ~= nil and GetPedInVehicleSeat(veh, -1) == cache.ped
                end,
                onSelect = function()
                    StartWash()
                end,
            },
        },
    })
end
```

`exports.ox_target:addSphereZone` returns the zone id; keep the ids if you need to `exports.ox_target:removeZone(id)` on resource stop.

### ox_lib progressBar + wash natives (client)

`lib.progressBar` is **blocking** — it yields the current thread and returns `true` if it finished or `false` if cancelled/interrupted. Disable movement during the wash and run a cleaning animation via the built-in `anim` field (it plays and stops the dict for you).

```lua
-- client.lua
function StartWash()
    local veh = cache.vehicle
    if not veh then return end

    -- Ask the SERVER to charge + authorize. Client never decides if it can afford it.
    local authorized = lib.callback.await('carwash:requestWash', false)
    if not authorized then
        lib.notify({ type = 'error', description = 'You cannot afford the carwash.' })
        return
    end

    local done = lib.progressBar({
        label = 'Washing vehicle...',
        duration = Config.duration,
        canCancel = true,
        disable = { move = true, car = true, combat = true },
        anim = { dict = 'mini@repair', clip = 'fixing_a_player' },
    })

    if not done then
        -- player cancelled — tell the server so it can refund (server owns the refund logic)
        TriggerServerEvent('carwash:washCancelled')
        return
    end

    -- Apply the visual clean. These are FiveM natives, not ox.
    SetVehicleDirtLevel(veh, 0.0)
    WashDecalsFromVehicle(veh, 1.0)
    lib.notify({ type = 'success', description = 'Vehicle cleaned.' })
end
```

`SetVehicleDirtLevel(vehicle, 0.0)` resets accumulated dirt; `WashDecalsFromVehicle(vehicle, 1.0)` removes mud/decal overlays. Both are client natives — the client owns its own vehicle entity, so this is safe to run client-side.

### ox_core money (server)

ox_core has **no `getMoney`/`removeMoney` helpers**. Money lives in **accounts**. Get the player, get their character account, read `account.balance`, and call `account.removeBalance({ amount })`. `removeBalance` uses a safe SQL guard (`balance - amount >= 0`) unless you pass `overdraw = true`, so it will not push a player negative.

```lua
-- server.lua
-- requires '@ox_core.lib.init' so the Ox global + account wrapper are available
local Ox = require '@ox_core.lib.init'

lib.callback.register('carwash:requestWash', function(source)
    -- source is the implicit, runtime-set player id — never trust a client-sent id
    local player = Ox.GetPlayer(source)
    if not player then return false end

    local account = player.getAccount()  -- the character's default money account
    if not account then return false end

    -- Server owns the price. Never read price from the client.
    local price = Config.price

    if account.balance < price then
        return false
    end

    local ok = account.removeBalance({ amount = price, message = 'Carwash' })
    if not ok then return false end

    -- remember that this player has an active, paid wash (for refund-on-cancel)
    ActiveWash[source] = price
    return true
end)
```

`player.getAccount()` returns the character's account instance (a wrapper over `Ox.GetCharacterAccount(charId)`). `account.balance` is the cached balance field; `account.removeBalance{ amount = n }` / `account.addBalance{ amount = n }` mutate it through the DB. Both accept a `message` for the transaction log.

### Refund on cancel (server)

Because the client could cancel the progress bar after paying, the server tracks the paid amount and refunds it. The client cannot refund itself.

```lua
-- server.lua
ActiveWash = {}

RegisterNetEvent('carwash:washCancelled', function()
    local source = source
    local price = ActiveWash[source]
    if not price then return end          -- nothing pending, ignore
    ActiveWash[source] = nil

    local player = Ox.GetPlayer(source)
    local account = player and player.getAccount()
    if account then
        account.addBalance({ amount = price, message = 'Carwash refund' })
    end
end)

AddEventHandler('playerDropped', function()
    ActiveWash[source] = nil
end)
```

### Optional: oxmysql bay config

If the user wants editable bays, store them in a table instead of `Config.bays`. Always create with `IF NOT EXISTS` and read with `.await`.

```sql
CREATE TABLE IF NOT EXISTS carwash_bays (
    id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
    label   VARCHAR(64) NOT NULL,
    x       FLOAT NOT NULL,
    y       FLOAT NOT NULL,
    z       FLOAT NOT NULL,
    price   INT UNSIGNED NOT NULL DEFAULT 150,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

```lua
-- server.lua — load bays at startup, hand coords (not prices) to clients
local bays = MySQL.query.await('SELECT id, label, x, y, z, price FROM carwash_bays')
-- send only display data (coords + label) to clients; keep prices server-side
```

See the `db-oxmysql` skill for full query patterns.

## Security

Money is the only thing worth exploiting in a carwash, so the rule from the `security` skill applies directly: **the server, not the client, decides the price and whether the player can pay.**

- The wash is gated behind `lib.callback.register('carwash:requestWash', ...)` which runs server-side and uses the implicit `source`.
- The price comes from `Config.price` / the DB on the server — never from a callback argument.
- `account.removeBalance` uses the safe (non-overdraw) path, so a race cannot drive a player negative.
- Refunds are server-authoritative and keyed to a server-tracked `ActiveWash[source]`, so a client cannot trigger a refund it never paid for.
- Add a cooldown so a player cannot spam wash requests (see the `security` skill rate-limiting pattern):

```lua
local cooldown = {}
lib.callback.register('carwash:requestWash', function(source)
    local now = GetGameTimer()
    if cooldown[source] and now - cooldown[source] < 5000 then return false end
    cooldown[source] = now
    -- ... rest of charge logic
end)
```

Cross-reference the `security` skill for source validation, input validation, and `playerDropped` cleanup of all per-player tables (`ActiveWash`, `cooldown`).

## Common Mistakes

- **Charging on the client.** Never deduct money client-side or send the price from the client. The client only requests; the server charges. An exploiter who controls the client controls any client-side number.
- **Inventing a money shortcut.** ox_core has no `getMoney()`/`removeMoney()` helper on the player. Use `player.getAccount()` to resolve the account, then `account.removeBalance` to charge.
- **Forgetting the driver check.** Washing while a passenger, or with no vehicle, makes `cache.vehicle` nil and the natives no-op or error. Gate the ox_target option with `canInteract` and re-check `cache.vehicle` before applying natives.
- **Washing a vehicle you do not own.** `SetVehicleDirtLevel` only reliably affects entities the client has authority over. Apply it to `cache.vehicle` (the player's own car), not arbitrary network entities.
- **Treating progressBar as non-blocking.** `lib.progressBar` yields and returns a boolean. Do not wrap it in `CreateThread` and assume it ran — check its return value before applying the wash and before considering the payment final.
- **No refund path.** If you charge before the progress bar and the player cancels, you must refund server-side, or players lose money on every interrupted wash.
- **Hardcoding `mysql-async`.** This server runs oxmysql. Use `MySQL.query.await` / `MySQL.insert.await`, never `MySQL.Async.fetchAll`.

## Dependencies

| Resource  | Why                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------- |
| ox_lib    | `lib.progressBar`, `lib.callback`, `lib.notify`, `cache`, animation helpers                       |
| ox_core   | Player object + money via accounts (`Ox.GetPlayer`, `player.getAccount`, `account.removeBalance`) |
| ox_target | Sphere zones at each wash bay (`addSphereZone`)                                                   |
| oxmysql   | Only if storing bay config in the DB                                                              |

`fxmanifest.lua` essentials:

```lua
fx_version 'cerulean'
game 'gta5'

shared_scripts {
    '@ox_lib/init.lua',
    'config.lua',
}

client_scripts { 'client.lua' }
server_scripts {
    '@oxmysql/lib/MySQL.lua',  -- only if using the DB; list before your own scripts
    'server.lua',
}

dependencies {
    'ox_lib',
    'ox_core',
    'ox_target',
}
```

Load order: `ox_lib` must start before `ox_core`. Add `@ox_lib/init.lua` to `shared_scripts` so `lib.*` and `cache` are global, and `require '@ox_core.lib.init'` in `server.lua` for the `Ox` global.
