---
name: npc-pack
description: "Static NPC ped pack for ox_overextended — RequestModel/CreatePed spawning, ox_target entity targeting or ox_lib proximity, ox_lib context/dialogue menus, ox_core metadata or oxmysql persistence, ped cleanup on stop. Use when generating an npc-pack resource."
---

# NPC Pack Resource Patterns

You are generating an NPC pack for an ox_overextended server. An NPC pack spawns a configured set of static, non-combatant peds in the world that players can interact with (talk, open a menu, trigger an action) and that are cleaned up cleanly when the resource stops.

## Overview

An NPC pack has four moving parts:

1. **Config table** — a reusable list of NPCs: model, coords, heading, animation/scenario, and what interacting does.
2. **Spawning** — load each model with `lib.requestModel`, `CreatePed`, then freeze it, make it invincible, block events, and disable collision damage so it behaves like a static prop.
3. **Interaction** — ox_target entity targeting (preferred) OR `lib.zones` proximity, opening an ox_lib context menu / dialogue on interact.
4. **Cleanup** — every spawned ped handle is tracked and deleted in `onResourceStop`, so reloading the resource never leaves orphan peds behind.

Interaction _effects_ that touch player state, economy, or persistence run **server-side**. The client only spawns visuals and opens menus.

## Core Patterns

### Config table (reusable NPC definitions)

```lua
-- config.lua (shared_script)
Config = {}

Config.NPCs = {
    {
        model = 's_m_m_gardener_01',
        coords = vec3(-269.4, -955.3, 31.2),
        heading = 208.0,
        scenario = 'WORLD_HUMAN_CLIPBOARD',   -- ambient anim; nil for idle
        target = {
            icon = 'fas fa-comment',
            label = 'Talk to the Clerk',
            distance = 2.0,
        },
        interaction = 'clerk_dialogue',         -- key the handler switches on
    },
    {
        model = 'a_m_y_business_01',
        coords = vec3(-1037.5, -2738.0, 20.2),
        heading = 330.0,
        scenario = nil,
        target = { icon = 'fas fa-briefcase', label = 'Speak to Agent', distance = 2.0 },
        interaction = 'agent_menu',
    },
}
```

### Spawning peds (client)

Load the model with `lib.requestModel` (yields until loaded, validates the model), create the ped, then lock it down. Track every handle so cleanup can delete it.

```lua
-- client/main.lua
local spawnedPeds = {}

local function spawnNpc(npc, index)
    local model = lib.requestModel(npc.model, 10000)
    if not model then return end

    local ped = CreatePed(0, model, npc.coords.x, npc.coords.y, npc.coords.z - 1.0, npc.heading, false, true)

    -- Make it a static, non-combatant prop-like ped
    SetEntityInvincible(ped, true)
    FreezeEntityPosition(ped, true)
    SetBlockingOfNonTemporaryEvents(ped, true)   -- ignore gunfire/panic
    SetPedCanRagdoll(ped, false)
    SetEntityCanBeDamaged(ped, false)
    SetPedDiesWhenInjured(ped, false)
    SetPedCanBeTargetted(ped, false)             -- not a combat target

    if npc.scenario then
        TaskStartScenarioInPlace(ped, npc.scenario, 0, true)
    end

    SetModelAsNoLongerNeeded(model)              -- release the model once the ped exists
    spawnedPeds[index] = ped
    return ped
end
```

> **Coords:** subtract `1.0` from `z` when spawning at ground coords sampled in-game (player coords are at the head/torso, ped origin is at the feet), or use `GetGroundZFor_3dCoord`. Keep `isNetwork = false` so each client owns its own local copy — static decorative NPCs do not need to be networked.

### Interaction — ox_target entity targeting (preferred)

Add a per-entity target option with `exports.ox_target:addLocalEntity`. The `onSelect` runs when the player aims at the ped and selects the option.

```lua
-- client/main.lua
local function addNpcTarget(ped, npc)
    exports.ox_target:addLocalEntity(ped, {
        {
            name = ('npc_%s'):format(npc.interaction),
            icon = npc.target.icon,
            label = npc.target.label,
            distance = npc.target.distance or 2.0,
            onSelect = function()
                onInteract(npc)
            end,
        },
    })
end
```

### Interaction — ox_lib proximity (alternative, no ox_target)

If you do not want ox_target, attach a `lib.zones.sphere` at each NPC and use text UI + a keybind.

```lua
-- client/main.lua
local function addNpcZone(ped, npc)
    lib.zones.sphere({
        coords = npc.coords,
        radius = npc.target.distance or 2.0,
        debug = false,
        onEnter = function() lib.showTextUI(('[E] %s'):format(npc.target.label)) end,
        onExit = function() lib.hideTextUI() end,
        inside = function()
            if IsControlJustReleased(0, 38) then -- E
                onInteract(npc)
            end
        end,
    })
end
```

### Dialogue / menu on interact (ox_lib context menu)

`onInteract` routes on `npc.interaction`. Use a context menu for choices, or `lib.alertDialog` for a one-shot dialogue line.

```lua
-- client/main.lua
function onInteract(npc)
    if npc.interaction == 'clerk_dialogue' then
        lib.alertDialog({
            header = 'Clerk',
            content = 'We are closed for the day. Come back tomorrow.',
            centered = true,
        })
    elseif npc.interaction == 'agent_menu' then
        lib.registerContext({
            id = 'npc_agent_menu',
            title = 'Insurance Agent',
            options = {
                {
                    title = 'Ask about a policy',
                    description = 'Hear the pitch',
                    icon = 'file-contract',
                    onSelect = function()
                        lib.notify({ description = 'Premiums start at $500/week.', type = 'inform' })
                    end,
                },
                {
                    title = 'Buy a policy',
                    icon = 'dollar-sign',
                    -- Server validates funds + records state. NEVER do economy client-side.
                    onSelect = function()
                        TriggerServerEvent('npcpack:purchasePolicy')
                    end,
                },
            },
        })
        lib.showContext('npc_agent_menu')
    end
end
```

### Persistent interaction state

For per-character flags ("has this player already met this NPC / bought the policy"), there are two correct options on ox_overextended.

**Option A — ox_core character metadata** (lightweight, lives on the player object):

```lua
-- server/main.lua
local Ox = require '@ox_core.lib.init'

RegisterNetEvent('npcpack:purchasePolicy', function()
    local source = source
    -- Resolve via the Ox lib wrapper so player.get/.set are callable methods.
    -- (The bare exports.ox_core:GetPlayer bridge returns a member WITHOUT those closures.)
    local player = Ox.GetPlayer(source)
    if not player or not player.charId then return end

    -- Read existing metadata flag
    if player.get('hasInsurance') then
        return lib.notify(source, { description = 'You already have a policy.', type = 'error' })
    end

    -- (validate funds / charge here — server-authoritative, see security skill)

    -- Persist the flag on the character (third arg `true` replicates to client state)
    player.set('hasInsurance', true, true)
    lib.notify(source, { description = 'Policy purchased.', type = 'success' })
end)
```

**Option B — oxmysql table** (when you need richer rows, e.g. one row per NPC interaction):

```sql
CREATE TABLE IF NOT EXISTS `npcpack_interactions` (
  `charId`      INT UNSIGNED NOT NULL,        -- characters.charId
  `npc`         VARCHAR(50)  NOT NULL,        -- interaction key
  `count`       INT          NOT NULL DEFAULT 0,
  `lastSeen`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`charId`, `npc`)
);
```

```lua
-- server/main.lua
RegisterNetEvent('npcpack:logInteraction', function(npcKey)
    local source = source
    if type(npcKey) ~= 'string' or #npcKey > 50 then return end

    local player = exports.ox_core:GetPlayer(source)
    if not player or not player.charId then return end

    MySQL.insert.await([[
        INSERT INTO npcpack_interactions (charId, npc, count) VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE count = count + 1
    ]], { player.charId, npcKey })
end)
```

Prefer **Option A** for simple boolean/scalar flags; reach for **Option B** only when you need history or per-NPC rows.

### Cleanup on resource stop (mandatory)

Delete every tracked ped, plus any ox_target/zone handles, when the resource stops. Without this, every `restart` leaves a duplicate ped frozen in the world.

```lua
-- client/main.lua
AddEventHandler('onResourceStop', function(resource)
    if resource ~= GetCurrentResourceName() then return end

    for index, ped in pairs(spawnedPeds) do
        if DoesEntityExist(ped) then
            exports.ox_target:removeLocalEntity(ped)  -- if ox_target was used
            DeleteEntity(ped)
        end
        spawnedPeds[index] = nil
    end
end)
```

### Wiring it together (client startup)

```lua
-- client/main.lua
local function init()
    for index, npc in ipairs(Config.NPCs) do
        local ped = spawnNpc(npc, index)
        if ped then
            addNpcTarget(ped, npc)   -- or addNpcZone(ped, npc) for the proximity variant
        end
    end
end

-- Spawn on resource start AND when the player session is ready
AddEventHandler('onResourceStart', function(resource)
    if resource == GetCurrentResourceName() then init() end
end)
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
    '@oxmysql/lib/MySQL.lua',  -- only if using the persistence table
    'server/main.lua',
}

dependencies {
    'ox_lib',
    'ox_core',
    'ox_target',  -- only if using entity targeting (omit for the lib.zones variant)
    'oxmysql',    -- only if using the persistence table
}
```

## Security

NPCs are client visuals, but their _interactions_ often touch player state — apply server-authoritative rules (see the `security` skill):

- **Any effect that grants items, money, or flags runs server-side.** The client may open the menu, but `purchasePolicy`/`logInteraction` validate and persist on the server. Never adjust money or set persistent flags client-side.
- **Validate every argument.** `npcKey` must be type-checked and length-capped; reject unknown keys against `Config.NPCs` so a client cannot log arbitrary strings.
- **Re-derive the character server-side** with `exports.ox_core:GetPlayer(source)` and `player.charId` — never accept a charId from the client.
- **Rate-limit interaction events** with a per-source `GetGameTimer()` cooldown and clear it in `playerDropped`.
- **Distance-check sensitive interactions** server-side (verify the player's ped is near the NPC coords) so a client cannot fire `purchasePolicy` from anywhere on the map.

## Common Mistakes

- **No cleanup handler.** Forgetting `onResourceStop` deletion is the #1 NPC-pack bug — every reload stacks another invincible ped on the old one. Always track handles and `DeleteEntity` on stop.
- **`CreatePed` before the model loads.** Calling `CreatePed` without `lib.requestModel` first spawns an invisible/missing ped. Always load (and validate) the model first, then `SetModelAsNoLongerNeeded` after.
- **Networking decorative peds.** Passing `isNetwork = true` to `CreatePed` makes one client the owner and replicates the ped — on disconnect it can vanish or duplicate. Use `false` for static decorative NPCs so each client owns a local copy.
- **Forgetting `SetBlockingOfNonTemporaryEvents`.** Without it, a "static" ped will flee or react to nearby gunfire and walk away from its post. Combine with `FreezeEntityPosition` + `SetEntityInvincible`.
- **Storing state on the entity / GlobalState.** Per-player progress belongs in ox_core metadata (`player.set`) or the oxmysql table keyed by `charId`, not on the client ped or in a client table that resets on relog.
- **Keying the table on a license/steam string.** ox_core persistence keys on the integer `charId` from `player.charId`; key on `charId`, never a license/steam identifier string.

## Dependencies

| Resource    | Why                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ox_lib`    | `lib.requestModel` (safe model loading), context menus / `lib.alertDialog` (dialogue), notifications, `lib.zones` (proximity variant), callbacks. |
| `ox_core`   | Resolve the character (`GetPlayer` → `charId`) and store per-character interaction flags via metadata (`player.get`/`player.set`).                |
| `ox_target` | Optional — per-entity interaction via `addLocalEntity`. Omit if using the `lib.zones` proximity variant.                                          |
| `oxmysql`   | Optional — persistent interaction history table keyed by `charId`. Omit if metadata flags are sufficient.                                         |

Cross-references: `fw-ox-core` (player object + metadata), `lua-quality` (ped lifecycle, handle tracking), `security` (server-authoritative interaction effects), `nui-patterns` (if a custom NUI dialogue is needed instead of context menus), `lore` (lore-friendly NPC names/dialogue).
