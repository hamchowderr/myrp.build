---
name: ox-fuel
description: "ox_fuel fuel system — vehicle fuel is read/written through the `fuel` statebag (or GetVehicleFuelLevel native), refueling happens at gas-pump props or with a WEAPON_PETROLCAN jerry can, and payment uses the ox_inventory 'money' item by default. No GetFuel/SetFuel exports exist. Use when generating refueling, fuel-HUD, gas-station, jerry-can, or any resource that reads or modifies vehicle fuel."
---

# ox_fuel

`ox_fuel` is a standalone fuel system for use with `ox_inventory` (an alternative
to LegacyFuel). It tracks each vehicle's fuel as a **statebag** and drains it
while driving via the game's native fuel consumption (`SetFuelConsumptionState`
/ `SetFuelConsumptionRateMultiplier`). It does **not** expose `GetFuel`/`SetFuel`
exports — read and write fuel the way the README documents.

## Reading & setting fuel — there are NO get/set exports

```lua
-- Read (any script, client or server) — the statebag holds the authoritative value
local fuelLevel = Entity(vehicle).state.fuel          -- 0–100, may be nil before first set
-- Client-only native fallback:
local fuelLevel = GetVehicleFuelLevel(vehicle)        -- 0x5F739BB8

-- Set (statebag is what ox_fuel persists/syncs)
Entity(vehicle).state.fuel = fuelAmount               -- clamp yourself to 0–100
```

The statebag key is **`fuel`**. ox_fuel sets it with `state:set('fuel', amount, replicate)`
and mirrors it onto the entity with `SetVehicleFuelLevel`. When you change fuel,
prefer writing the statebag so the value survives and replicates; on the client
you may also call `SetVehicleFuelLevel(vehicle, amount)` to update it instantly.
Use `DoesVehicleUseFuel(vehicle)` to skip vehicles with no tank.

## Config (`config.lua`)

`config.lua` returns a table (loaded via `require 'config'`). Key fields, verbatim
from the installed v1.5.4:

- `showBlips` — `0` hide / `1` nearest only / `2` all gas-station blips.
- `refillValue` — fuel % added per tick (default `0.50`).
- `refillTick` — tick interval in ms (default `250`).
- `priceTick` — money charged per tick when fueling at a pump (default `5`).
- `durabilityTick` — petrol-can durability/ammo consumed per tick (default `1.3`).
- `globalFuelConsumptionRate` — multiplier passed to `SET_FUEL_CONSUMPTION_RATE_MULTIPLIER` (default `10.0`).
- `petrolCan = { enabled, duration, price, refillPrice }` — jerry can buy/refill prices and progress duration.
- `ox_target` — `true` to use ox_target zones on pumps instead of the `/startfueling` keybind.
- `pumpModels` — list of gas-pump prop hashes used for blips, ox_target, and proximity.

## ox_inventory integration

- **Payment:** the default payment method removes the `money` item via
  `exports.ox_inventory:RemoveItem(playerId, 'money', price)` (server) and the
  default money check reads `exports.ox_inventory:GetItemCount('money')` (client).
- **Jerry can:** the item is `WEAPON_PETROLCAN` (a weapon item in ox_inventory).
  Its `metadata.durability` / `metadata.ammo` represent remaining fuel; ox_fuel
  reads it with `GetCurrentWeapon` and writes it back with `SetMetadata`.

### Overriding payment (e.g. charge a bank account instead of cash)

```lua
-- SERVER: replace the cash deduction with custom logic; return true on success
exports.ox_fuel:setPaymentMethod(function(playerId, amount)
    -- deduct from a bank account, society, etc. and return true if paid
    return chargeBank(playerId, amount)
end)

-- CLIENT: replace the "how much money does the player have?" check
exports.ox_fuel:setMoneyCheck(function()
    return getBankBalance()   -- number ox_fuel compares against priceTick / can prices
end)
```

## Canonical pattern — read fuel for a HUD

```lua
-- client: keep a HUD value in sync with the ox_fuel statebag
CreateThread(function()
    while true do
        local veh = cache.vehicle
        if veh then
            local pct = Entity(veh).state.fuel or GetVehicleFuelLevel(veh)
            SendNUIMessage({ action = 'fuel', value = pct })
        end
        Wait(1000)
    end
end)
```

## fxmanifest dependencies

ox_fuel itself declares:

```lua
dependencies { 'ox_lib', 'ox_inventory' }
ox_libs { 'math', 'locale' }
```

A resource that only **reads** vehicle fuel (statebag/native) needs no dependency
on ox_fuel. If you call `setPaymentMethod` / `setMoneyCheck`, add `'ox_fuel'` to
your `dependencies`. Touching cash or the petrol can means depending on
`'ox_inventory'`; notifications/progress use `'ox_lib'`.

## Rules

- Read/write fuel through the **`fuel` statebag** — there are no `GetFuel`/`SetFuel`
  exports, so never invent them.
- Fuel is **server-replicated** via the statebag; the owning client drains it while
  driving. Don't store fuel in your own table or DB column — the statebag is the source.
- Refueling and payment are handled by ox_fuel's own pump/jerry-can flow. Only add
  custom logic via `setPaymentMethod`/`setMoneyCheck`, not by re-implementing fueling.
- Cash is the ox_inventory `money` item; the jerry can is the `WEAPON_PETROLCAN` item.
