---
name: ox-doorlock
description: "ox_doorlock door management — doors are created in-game via the /doorlock command and persisted to the ox_doorlock SQL table; code interacts via setState/getDoor exports and the stateChanged event, with access gated by characters, groups+grade, items, passcode, or ACE. Use when generating resources that lock/unlock doors, gate areas by job/gang/item, or react to door state changes."
---

# ox_doorlock

`ox_doorlock` manages locking/unlocking of map doors. Doors are normally created
and configured **in-game** through the `/doorlock` command + a targeting resource
(LALT) — NOT in code. Each door is persisted as a row in the `ox_doorlock` table.
Your code interacts with existing doors via exports/events; it does not draw the
door-creation UI itself.

Do NOT invent your own locked-door system or store door state yourself — register
the door once via the command, then drive it through ox_doorlock's API.

## Persistence — the `ox_doorlock` table (oxmysql)

ox_doorlock creates and owns this table; it runs the schema on start.

```sql
CREATE TABLE IF NOT EXISTS `ox_doorlock` (
    `id`   int(11) unsigned NOT NULL AUTO_INCREMENT,
    `name` varchar(50) NOT NULL,
    `data` longtext NOT NULL,   -- JSON blob of door settings
    PRIMARY KEY (`id`)
);
```

`id` is the door identifier you pass to exports. `name` is the human label.
`data` is a JSON-encoded settings blob (coords, model, state, characters,
groups, items, passcode, autolock, etc.). Do NOT write to this table directly —
let the `/doorlock` command and `editDoor` export mutate it so the in-memory
state and connected clients stay in sync.

## Exports

### Client
```lua
exports.ox_doorlock:useClosestDoor()   -- toggle the closest door (server still authorizes)
exports.ox_doorlock:getClosestDoor()   -- returns the closest door's data (lockpicking is handled inside useClosestDoor)
```

### Server
```lua
local door = exports.ox_doorlock:getDoor(1)                       -- by numeric id
local door = exports.ox_doorlock:getDoorFromName('mrpd lockers')  -- by name
local all  = exports.ox_doorlock:getAllDoors()                    -- array of doors

exports.ox_doorlock:setDoorState(id, state)   -- state 0 = unlocked, 1 = locked
exports.ox_doorlock:editDoor(id, data)        -- patch fields on an existing door + persist
```

A door returned by `getDoor` exposes:
`id, name, state, coords, characters, groups, items, maxDistance`
(`state`: 0 unlocked / 1 locked).

## Setting door state

Two equivalent server-side ways to lock/unlock — the event and the export both
route through the same authorization + sync logic:

```lua
TriggerEvent('ox_doorlock:setState', doorId, 1)        -- lock
exports.ox_doorlock:setDoorState(doorId, 0)            -- unlock
```

When called from a net event with a real `source`, the server runs
`isAuthorised` against that player. Called from a script with no `source`
(plain server context), the change is applied unconditionally — so a server
script can force any door open/closed.

## Reacting to door changes

```lua
-- Server: fires whenever a door's lock state changes
AddEventHandler('ox_doorlock:stateChanged', function(source, doorId, locked, usedItem)
    -- source: player who triggered it (nil for autolock/script)
    -- locked: boolean (true = now locked)
    -- usedItem: item name if access was granted via an item, else nil/false
end)
```

There is also `ox_doorlock:loaded` (fired once all doors are loaded from the DB).

## Access gating

A player is authorized to use a door if ANY of these pass (checked server-side
in `isAuthorised`):

- **ACE override** — `Config.PlayerAceAuthorised = true` plus the player having
  `command.doorlock`, OR an ace named `doorlock.<door name>`:
  ```cfg
  add_ace group.police "doorlock.mrpd locker rooms" allow
  add_principal identifier.fivem:123456 group.police
  ```
- **Characters** — `door.characters` is an array of ox_core character ids
  (`player.charId`, the integer charId — never a license or string id). Match grants access.
- **Groups + grade** — `door.groups` is a `table<groupName, minGrade>` map, e.g.
  `{ police = 0, ambulance = 2 }`. Grade `0` allows the whole group; a number is
  the minimum grade. Checked via the framework's group lookup.
- **Items** — `door.items` is a list of items (ox_inventory). Holding any one
  authorizes; an item flagged `remove = true` is consumed on use. Set
  per-item `metadata` to match `slot.metadata.type`.
- **Passcode** — `door.passcode`; the player is prompted for input and must match.

`Config.LockpickItems` (default `{ 'lockpick' }`) governs lockpicking when a door
has `lockpick` enabled; `Config.LockDifficulty` sets the skillcheck.

## Canonical pattern — job-gated door reacting to state

```lua
-- Door 'mrpd lockers' already created in-game via /doorlock, with group police grade 0.

-- Server: force-unlock the door during an alarm, regardless of player gating
RegisterNetEvent('myresource:alarm', function()
    local door = exports.ox_doorlock:getDoorFromName('mrpd lockers')
    if door then
        exports.ox_doorlock:setDoorState(door.id, 0)  -- unlock for everyone
    end
end)

-- Server: audit who opens it, and consume a special item if used
AddEventHandler('ox_doorlock:stateChanged', function(source, doorId, locked, usedItem)
    if source and not locked then
        print(('player %s opened door %s'):format(source, doorId))
    end
end)
```

## Rules / cautions

- **Server-authoritative.** Never let the client decide whether a door opens.
  Client exports (`useClosestDoor`/`pickClosestDoor`) only *request* a change;
  the server's `isAuthorised` is the gate. Don't replicate door state in NUI or
  trust client-sent "I unlocked it" events.
- Don't INSERT/UPDATE the `ox_doorlock` table directly — use the `/doorlock`
  command or `editDoor`, which keeps in-memory doors and all clients synced.
- Door ids/names come from the existing DB rows; generated code should look doors
  up with `getDoorFromName` rather than hardcoding numeric ids it can't know.
- fxmanifest dependencies:
  ```lua
  dependencies {
      'oxmysql',
      'ox_lib',
  }
  ```
  (ox_doorlock itself requires these; resources calling its exports should declare
  `'ox_doorlock'` as a dependency. `ox_target` is optional, used for lockpicking.)
```