---
name: drug-stash
description: "Drug stash resource recipe for ox_overextended — a shared, access-controlled ox_inventory stash opened via ox_target, gated by ox_core job/gang group, with ox_lib notifications. Use when generating a stash/storage/drop resource where players deposit and retrieve items from a persistent shared location."
---

# Drug Stash Resource Patterns

A "drug stash" is a fixed-location, access-controlled container that a gang or crew uses to deposit and retrieve contraband. The whole point of building it on ox_inventory is that **ox_inventory owns item storage and persistence** — you register the stash once, restrict who can open it, and let ox_inventory handle slots, weight, item metadata, and database persistence. Do NOT hand-roll item storage with your own SQL tables; that is the single most common mistake in this recipe.

## Overview

The recipe wires four ox primitives together:

1. **ox_inventory stash** — `exports.ox_inventory:RegisterStash(...)` registers a named, persistent container with slot/weight limits and group-based access control. ox_inventory persists its contents to the `ox_inventory` database table automatically.
2. **ox_target zone** — a sphere or box zone at the stash coordinates. When the player targets it and selects "Access Stash", the client opens the stash.
3. **ox_core group gating** — access is restricted to a job/gang group (e.g. `ballas`). The `groups` argument on `RegisterStash` is enforced server-side by ox_inventory itself; ox_core defines the group and grades.
4. **ox_lib notify** — feedback when the player is not allowed, or for flavor ("You stash the product").

The data flow is server-authoritative by construction: the client only _requests_ to open a stash by name. ox_inventory's server validates the requesting player's groups against the stash's `groups` table before returning any contents. Item moves into and out of the stash are validated entirely inside ox_inventory's server. Your resource never touches item counts.

Naming should be lore-friendly (GTA V satire) — gang names like `ballas`, `vagos`, `families`, stash labels like "Forum Drive Lockup" or "Grove Street Stash". See the `lore` skill for canonical parodies.

## Core Patterns

### Registering the stash (server)

`RegisterStash(name, label, slots, maxWeight, owner, groups, coords)` must run server-side **before any player tries to open it** — register it on `onResourceStart` (and re-register on player load is unnecessary; once registered it stays registered for the resource's lifetime). The `groups` table maps a group name to the **minimum grade** required.

```lua
-- server/main.lua
local STASH_ID = 'ballas_lockup'

local function registerStashes()
    exports.ox_inventory:RegisterStash(
        STASH_ID,            -- name: unique stash identifier (also the DB key)
        'Forum Drive Lockup', -- label: shown in the inventory UI
        50,                  -- slots
        100000,              -- maxWeight (grams)
        false,              -- owner: false/nil = shared stash (everyone in the group shares it)
        { ballas = 0 },      -- groups: requires group 'ballas' at grade >= 0
        nil                  -- coords: optional; lets ox_inventory enforce a distance check
    )
end

AddEventHandler('onResourceStart', function(resource)
    if resource ~= GetCurrentResourceName() then return end
    registerStashes()
end)
```

**Owner semantics (verified against ox_inventory source):**

- `owner = false` or `nil` → a single **shared** stash. Everyone who passes the `groups` check opens the same container. This is what a gang stash wants.
- `owner = <identifier string>` → the stash is tied to that one identifier (a personal stash).
- `owner = true` → each player gets their own unique stash under the same name, but can request other players' stashes by passing an owner — not what you want for a shared crew stash.

**`groups` is the access control.** ox_inventory's server checks the opening player's ox_core groups against this table and refuses to return contents if they don't qualify. You do not need to re-check on the client — but you should still gate the target option for UX (below).

### Opening the stash via ox_target (client)

Add a target zone at the stash location. On select, call the client `openInventory` export with type `'stash'` and the stash id. ox_inventory's client triggers a server callback (`ox_inventory:openInventory`) which performs the authoritative group/distance check.

```lua
-- client/main.lua
local STASH_ID = 'ballas_lockup'
local stashCoords = vec3(96.5, -1940.2, 20.8)

CreateThread(function()
    exports.ox_target:addSphereZone({
        coords = stashCoords,
        radius = 1.2,
        debug = false,
        options = {
            {
                name = 'open_ballas_lockup',
                icon = 'fa-solid fa-box-archive',
                label = 'Access Stash',
                -- ox_target groups option also pre-filters by ox_core group,
                -- so non-members never even see the option:
                groups = { ballas = 0 },
                onSelect = function()
                    -- Opens the stash; ox_inventory re-validates server-side.
                    exports.ox_inventory:openInventory('stash', STASH_ID)
                end,
            },
        },
    })
end)
```

Two layers of access control are intentional here: the `groups` field on the ox_target option hides the prompt from non-members (UX), and the `groups` table on `RegisterStash` is the **authoritative** server-side check (security). Never rely on the target option alone.

### Gating by job/gang with ox_core (server)

ox_core defines groups and grades. ox_inventory reads a player's groups to evaluate stash access, so you just need players to _be in_ the group. To gate access dynamically (e.g. an admin command that grants gang membership), use the player object's `setGroup`:

```lua
-- server: granting/revoking gang membership (verified ox_core player methods)
lib.addCommand('setgang', {
    help = 'Assign a player to a gang',
    params = {
        { name = 'target', type = 'playerId' },
        { name = 'gang',   type = 'string' },
        { name = 'grade',  type = 'number', optional = true },
    },
    restricted = 'group.admin',
}, function(source, args)
    local player = Ox.GetPlayer(args.target)
    if not player then return end
    player.setGroup(args.gang, args.grade or 0)  -- grade 0 removes the group
end)
```

To read a player's group inside your own logic (verified: `getGroup(name)` returns the grade number, or nil):

```lua
local player = Ox.GetPlayer(source)
local grade = player and player.getGroup('ballas')
if not grade then
    return lib.notify(source, { type = 'error', description = 'You are not in this crew.' })
end
```

`Ox.GetPlayer(source)` is the server-side accessor (also available as `exports.ox_core:GetPlayer(source)`).

### Persisting stash metadata with oxmysql (optional)

ox_inventory already persists stash **contents** — do not duplicate that. The only legitimate reason to use oxmysql here is to persist **metadata about the stash itself**: who placed it, when it was last accessed, which crew controls it, or to support player-placed stashes whose coordinates and ownership must survive a restart.

```sql
CREATE TABLE IF NOT EXISTS `crew_stashes` (
  `stash_id`    VARCHAR(64) NOT NULL,
  `label`       VARCHAR(64) NOT NULL,
  `owner_group` VARCHAR(32) NOT NULL,
  `x`           FLOAT NOT NULL,
  `y`           FLOAT NOT NULL,
  `z`           FLOAT NOT NULL,
  `created_by`  INT UNSIGNED NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`stash_id`),
  KEY `idx_owner_group` (`owner_group`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

```lua
-- server: load persisted stashes on start, register each with ox_inventory
local function loadPersistedStashes()
    local rows = MySQL.query.await('SELECT * FROM crew_stashes')
    if not rows then return end

    for i = 1, #rows do
        local s = rows[i]
        exports.ox_inventory:RegisterStash(
            s.stash_id,
            s.label,
            50,
            100000,
            false,
            { [s.owner_group] = 0 },
            vec3(s.x, s.y, s.z)
        )
    end
end
```

The `crew_stashes` table holds _where the stash is and who owns it_ — never item rows. Item rows live in ox_inventory's own table.

### Distance enforcement

When you pass `coords` to `RegisterStash`, ox_inventory rejects open requests from players who are not near those coordinates — a free anti-teleport-loot check. Always pass `coords` for fixed stashes. For mobile/player-carried stashes you'd omit it, but those are out of scope for a fixed drug stash.

## Security

The security posture for a stash resource is almost entirely "let ox_inventory do its job, and don't add insecure shortcuts." Apply the patterns from the `security` skill:

- **Item moves are server-authoritative inside ox_inventory.** Never write a net event like `RegisterNetEvent('stash:deposit', ...)` that adds/removes items based on client input — that recreates the exact exploit ox_inventory's stash system prevents. Open the stash and let the player drag items in the UI.
- **Group check is server-side via `RegisterStash` `groups`.** The ox_target `groups` option is UX only; an exploiter can call `openInventory` directly, and ox_inventory will still reject them because the authoritative check lives in the server callback. Always populate the `groups` table on the stash.
- **Pass `coords`** so ox_inventory enforces proximity and rejects remote-open exploits.
- **Validate `source` and inputs** on any custom command (e.g. an admin "create stash" command): check `type()`, use `lib.addCommand` with `restricted` for ACE-gated admin actions, reject `source == 0` where appropriate.
- **Rate-limit** any custom net event you add (e.g. a "place stash" event) per the `security` skill cooldown pattern, and clean up per-player state in `playerDropped`.
- **Never send the stash group list or other server config to clients.** The client needs only the stash id and coordinates to build the target zone.

## Common Mistakes

- **Hand-rolling item storage.** Creating a `stash_items` table and `AddItem`/`RemoveItem` net events instead of using `RegisterStash`. ox_inventory already persists contents, enforces weight/slots, handles metadata (serials, durability), and validates moves. Re-implementing it is both wasteful and insecure.
- **Registering the stash on the client.** `RegisterStash` is a **server** export. Calling it client-side does nothing useful and the stash will not exist authoritatively.
- **Omitting the `groups` table** and relying only on the ox_target `groups` option. An exploiter calls `openInventory('stash', id)` directly and walks in. The stash's own `groups` is the real gate.
- **Confusing `owner` and `groups`.** `owner` controls _which instance_ of the stash you get (shared vs per-player); `groups` controls _who is allowed in_. A shared crew stash is `owner = false` + `groups = { gang = 0 }`.
- **Forgetting `coords`** on a fixed stash, losing the built-in distance check.
- **Re-registering the stash on every player load.** Register once on resource start (and once per persisted row at load). Re-registering with different args mutates the live stash for everyone.
- **Wrong stash type string.** The client export is `openInventory('stash', stashId)` — the first argument is the literal string `'stash'`, not the label.
- **Listing `ox_inventory` scripts manually.** You only declare it as a dependency; never `@ox_inventory/...` in `server_scripts` for a consumer resource.

## Minimal Complete Example

A shared gang stash at a fixed location, openable only by the `ballas` group.

### fxmanifest.lua

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveM Studio'
description 'Ballas crew stash — shared, group-gated ox_inventory stash'
version '1.0.0'

shared_scripts {
    '@ox_lib/init.lua',
}

server_scripts {
    'server/main.lua',
}

client_scripts {
    'client/main.lua',
}

dependencies {
    'ox_lib',
    'ox_core',
    'ox_inventory',
    'ox_target',
}
```

### server/main.lua

```lua
local STASH_ID = 'ballas_lockup'
local STASH_GROUP = 'ballas'
local STASH_COORDS = vec3(96.5, -1940.2, 20.8)

local function registerStashes()
    exports.ox_inventory:RegisterStash(
        STASH_ID,
        'Forum Drive Lockup',
        50,                       -- slots
        100000,                   -- maxWeight (grams)
        false,                    -- shared stash
        { [STASH_GROUP] = 0 },    -- requires group 'ballas', any grade
        STASH_COORDS              -- proximity enforced server-side
    )
end

AddEventHandler('onResourceStart', function(resource)
    if resource ~= GetCurrentResourceName() then return end
    registerStashes()
end)

-- Admin helper: assign a player to the crew so they can open the stash.
lib.addCommand('setcrew', {
    help = 'Assign a player to the Ballas crew',
    params = {
        { name = 'target', type = 'playerId', help = 'Target player server id' },
        { name = 'grade',  type = 'number',   help = 'Grade (0 removes)', optional = true },
    },
    restricted = 'group.admin',
}, function(source, args)
    local player = Ox.GetPlayer(args.target)
    if not player then return end
    player.setGroup(STASH_GROUP, args.grade or 1)
    lib.notify(source, { type = 'success', description = 'Crew membership updated.' })
end)
```

### client/main.lua

```lua
local STASH_ID = 'ballas_lockup'
local STASH_GROUP = 'ballas'
local STASH_COORDS = vec3(96.5, -1940.2, 20.8)

CreateThread(function()
    exports.ox_target:addSphereZone({
        coords = STASH_COORDS,
        radius = 1.2,
        debug = false,
        options = {
            {
                name = 'open_ballas_lockup',
                icon = 'fa-solid fa-box-archive',
                label = 'Access Stash',
                groups = { [STASH_GROUP] = 0 }, -- hides prompt from non-members (UX)
                onSelect = function()
                    -- Authoritative group + distance check happens in ox_inventory's server.
                    exports.ox_inventory:openInventory('stash', STASH_ID)
                end,
            },
        },
    })
end)
```

That is the entire resource. ox_inventory persists everything dropped into the stash, enforces the group and proximity checks, and survives restarts with no extra code.

## Dependencies

| Resource       | Required | Purpose                                                                                                       |
| :------------- | :------- | :------------------------------------------------------------------------------------------------------------ |
| `ox_lib`       | Always   | `lib.addCommand`, `lib.notify`, shared init (`@ox_lib/init.lua`)                                              |
| `ox_core`      | Always   | Player object (`Ox.GetPlayer`), group/grade membership (`setGroup`)                                           |
| `ox_inventory` | Always   | The stash itself — `RegisterStash` (server), `openInventory` (client). Owns all item storage and persistence. |
| `ox_target`    | Always   | Sphere/box zone at the stash to trigger the open action                                                       |
| `oxmysql`      | If used  | Only to persist _stash metadata_ (location, owner crew) — never items                                         |

Cross-references: see `fw-ox-core` for player/group APIs, `db-oxmysql` for query patterns if you persist metadata, `security` for the server-authoritative and rate-limiting rules, `lore` for lore-friendly gang and location naming, and `fxmanifest` for manifest rules.
