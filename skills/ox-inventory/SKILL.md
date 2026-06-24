---
name: ox-inventory
description: "ox_inventory slot-based inventory patterns — server-authoritative item Add/Remove/Get/CanCarry/Search, custom items in data/items.lua, stashes, shops, metadata/durability, and hooks. Use when generating any resource that gives/takes/checks items, money (the 'money' item), defines custom items, or creates stashes/shops."
---

# ox_inventory

Slot-based inventory with per-slot metadata. **Every item operation must run on the
server** — the client can request, but only the server decides what enters or leaves
an inventory. Cash is just the `money` item; "dirty" cash is `black_money`.

`inv` (first arg of most server exports) is an inventory identifier: a player
`source` (number), a stash/drop name (string), or a network id for vehicle/owned
inventories. For player operations, pass the player's `source`.

## Core server exports (signatures verified in source)

```lua
-- Add: returns success(boolean), response(slot data table | error string)
local ok, resp = exports.ox_inventory:AddItem(inv, item, count, metadata, slot)
--   item=name|table, count=number, metadata?=table, slot?=number
--   failure strings: 'invalid_item','invalid_inventory','inventory_full'

-- Remove: returns success(boolean), error?(string)
local ok = exports.ox_inventory:RemoveItem(inv, item, count, metadata, slot, ignoreTotal, strict)
--   strict defaults true; failure: 'not_enough_items'

-- Capacity check BEFORE adding (weight + slot space): returns boolean|nil
local can = exports.ox_inventory:CanCarryItem(inv, item, count, metadata)

-- Count of an item the player holds: returns number (0 if none)
local n = exports.ox_inventory:GetItemCount(inv, itemName, metadata, strict)

-- Item record + count: returns a clone with .count, or count number if returnsCount
local data = exports.ox_inventory:GetItem(inv, item, metadata, returnsCount)

-- Search across an inventory:
--   search='slots' -> array of matching slot tables; search='count' -> number
local result = exports.ox_inventory:Search(inv, search, items, metadata)
--   items = string | string[]

-- Slot inspection / mutation
local slot = exports.ox_inventory:GetSlot(inv, slotId)
exports.ox_inventory:SetMetadata(inv, slotId, metadata)        -- replaces slot metadata
exports.ox_inventory:SetDurability(inv, slotId, durability)    -- 0-100

-- All items in an inventory (for owned/stash inventories): array of slots
local items = exports.ox_inventory:GetInventoryItems(inv, owner)
```

Argument order matters: `count` is positional and comes before `metadata`. Do not pass
metadata where count belongs.

## Money / cash

```lua
local cash = exports.ox_inventory:GetItemCount(source, 'money')
exports.ox_inventory:RemoveItem(source, 'money', 100)   -- charge
exports.ox_inventory:AddItem(source, 'money', 100)      -- pay
```

## Custom items — `data/items.lua`

Add a keyed entry. Shape (all verified against shipped items):

```lua
['lockpick'] = {
    label = 'Lockpick',           -- display name (required)
    weight = 110,                 -- grams
    stack = true,                 -- false = each goes in its own slot (default true)
    close = true,                 -- close inventory UI on use (default true)
    consume = 1,                  -- how many used per use; 0 = not consumed; <1 = durability %
    degrade = 60,                 -- minutes until item decays (sets metadata.durability)
    client = {                    -- client-side use behaviour
        usetime = 2500,
        anim = { dict = 'mp_player_intdrink', clip = 'loop_bottle' },
        prop = { model = `prop_ld_can_01`, pos = vec3(0,0,0), rot = vec3(0,0,0) },
        status = { hunger = 200000 },   -- ox status increments (food/drink)
        disable = { move = true, car = true, combat = true },
        notification = 'You used a lockpick',
        export = 'myresource.lockpick',  -- client fn called on use
    },
    server = {
        export = 'myresource.lockpick',  -- server fn called on use
    },
    buttons = {                   -- extra context-menu actions
        { label = 'Inspect', action = function(slot) print(slot) end },
    },
}
```

Notes verified in source: if you set `consume` to nil/omit it but provide
`client.status`/`usetime`/`export` or `server.export`, ox forces `consume = 1`.
After adding items, the SQL `ox_inventory` table reseeds automatically — no manual SQL.

### Usable item handler (the `export` fields)

The export named in `server.export`/`client.export` is invoked when the player uses
the item. Register it as a normal resource export; ox calls it with an event arg:

```lua
-- server.lua of YOUR resource (matches server.export = 'myresource.lockpick')
exports('lockpick', function(event, item, inventory, slot, data)
    if event == 'usingItem' then
        -- return false here to ABORT use (item not consumed)
    elseif event == 'usedItem' then
        -- runs after consume; do the effect
    end
end)
```

## Stashes — `RegisterStash` (server)

Persistent stashes are registered server-side, typically on `onServerResourceStart`.
Verified arg order:

```lua
exports.ox_inventory:RegisterStash(name, label, slots, maxWeight, owner, groups, coords)
--   name    string  unique id (db key)
--   label   string  title shown when open
--   slots   number
--   maxWeight number (grams)
--   owner?  string|true|nil   string = locked to that identifier;
--                             true = per-player unique; nil = shared by all
--   groups? table   e.g. { ['police'] = 0 }  (job grade gate)
--   coords? vector3 (optional, for distance check)
```

Open a stash from the client: `exports.ox_inventory:openInventory('stash', name)`.
For throwaway stashes use `CreateTemporaryStash(properties)` (returns an id) instead.

## Shops — `RegisterShop` (server) or `data/shops.lua`

```lua
exports.ox_inventory:RegisterShop('PoliceArmory', {
    name = 'Police Armory',
    inventory = {
        { name = 'water', price = 10 },
        { name = 'armour', price = 500, grade = 2 },   -- grade = required job grade
    },
    groups = { ['police'] = 0 },     -- restrict who can open
    locations = { vec3(452.6, -980.0, 30.6) },
    blip = { id = 59, colour = 69, scale = 0.8 },
})
```

Static shops can instead live as a keyed entry in `data/shops.lua` (same shape under
a `ShopType` key, with `locations`/`targets`).

## Hooks — `registerHook` (server)

Run validation/side-effects on inventory events. Return `false` from the callback to
**cancel** the action. Verified hook events: `swapItems`, `buyItem`, `craftItem`,
`createItem`, `openShop`.

```lua
local id = exports.ox_inventory:registerHook('swapItems', function(payload)
    -- payload has fromInventory, toInventory, fromSlot, toSlot, etc.
    if payload.fromType == 'player' and payload.toType == 'drop' then
        return false   -- block dropping
    end
end, {
    inventoryFilter = { '^stash:' },   -- only fire for matching inventories
    itemFilter = { ['gold'] = true },  -- only fire for these items
})

exports.ox_inventory:removeHooks(id)   -- cleanup (auto-removed on resource stop)
```

## Metadata & durability

Per-slot metadata is a table (e.g. `{ durability = 80, serial = 'X1' }`). Set it with
`SetMetadata(inv, slotId, metadata)` / read via `GetSlot`. `degrade` on the item def
makes ox auto-decay `metadata.durability` over time; `SetDurability(inv, slotId, n)`
sets it explicitly (0-100, 0 destroys/empties the use).

## Canonical example — custom item + stash drop

```lua
-- data/items.lua
['evidence_bag'] = { label = 'Evidence Bag', weight = 50, stack = true, close = false }

-- server: give the bag if the player can carry it (server-authoritative)
RegisterNetEvent('police:giveEvidenceBag', function()
    local src = source
    if exports.ox_inventory:CanCarryItem(src, 'evidence_bag', 1) then
        exports.ox_inventory:AddItem(src, 'evidence_bag', 1, { case = 'OPEN' })
    end
end)

-- server: register a shared police evidence stash
AddEventHandler('onServerResourceStart', function(res)
    if res ~= GetCurrentResourceName() then return end
    exports.ox_inventory:RegisterStash('police_evidence', 'Evidence Locker', 50, 100000,
        nil, { ['police'] = 0 }, vec3(474.6, -996.0, 30.7))
end)

-- client: open it via ox_target / a command
exports.ox_inventory:openInventory('stash', 'police_evidence')
```

## Rules

- **Server-authoritative:** all `AddItem`/`RemoveItem`/`SetMetadata`/`RegisterStash`
  run on the server. Never trust a client claim about what it holds — re-check with
  `GetItemCount`/`Search` server-side before granting anything.
- Always `CanCarryItem` before `AddItem` for non-money items so you don't silently fail
  on a full inventory; check `RemoveItem`'s success before granting the result.
- `count` is positional before `metadata` — keep the order exact.
- fxmanifest dependencies: `dependencies { 'ox_lib', 'oxmysql', 'ox_inventory' }`
  (and `'/onesync'` / `'/server:6116'` are already required by ox_inventory itself).
