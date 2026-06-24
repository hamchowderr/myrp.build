---
name: gang
description: "ox_core gang resource recipe — model gangs as ox_core groups (Ox.GetGroup, member ranks/grades, add/remove member), turf via ox_target/zones gated by group, ox_lib context menu for gang management (promote/kick/stash), oxmysql treasury and territory, and a group-gated ox_inventory stash. Use when generating a gang resource for an ox_core server."
---

# Gang Resource Patterns

You are generating a **gang** resource for an ox_core server. As with jobs, the Overextended ecosystem has **no separate "gang" system — a gang is an ox_core group**. Membership in the `ballas` group at some grade IS gang membership at that rank. This recipe shows how to model self-managed gangs on top of groups: member ranks, promote/kick from an in-game menu, a group-gated stash, turf zones, and a treasury.

For framework primitives see `fw-ox-core`. For database see `db-oxmysql`. For NUI menus see `nui-patterns`. For validation see `security`.

## Overview

A gang is a row in ox_core's `ox_groups` table, identical in shape to a job (see the `job` skill):

- `name` — internal id, e.g. `ballas`
- `label` — display name, e.g. `Ballas`
- `grades` — ordered array of rank labels; **1-based** (grade `1` = lowest, `0` = not a member)
- `type` — set `type = 'gang'` so a player can only belong to one gang at a time (and so gang groups don't collide with `type = 'job'` groups)
- `hasAccount` — set `true` to give the gang a shared treasury account

**Gang-as-group vs job-as-group:** the underlying ox_core primitive is the _same_ — both are groups with grades. The differences are conventional:

| Aspect       | Job (`type='job'`)             | Gang (`type='gang'`)                      |
| :----------- | :----------------------------- | :---------------------------------------- |
| Who assigns  | Admins via `/setgroup`         | Members self-manage (boss promotes/kicks) |
| Top grade    | Chief/boss is staff-appointed  | Highest grade is the gang leader          |
| Money        | Salary paid to on-duty members | Shared treasury members deposit into      |
| Mutual excl. | One job at a time              | One gang at a time                        |

Mechanically you use the same exports: `Ox.GetGroup`, `player.getGroup`, `player.setGroup`. The gang flavor is mostly the management UX (context menu) and turf, not new APIs.

## Core Patterns

### Defining the gang group (one-time seed)

```lua
-- server/main.lua
local GANG = 'ballas'

CreateThread(function()
    if Ox.GetGroup(GANG) then return end -- Ox.CreateGroup throws if it exists

    Ox.CreateGroup({
        name = GANG,
        label = 'Ballas',
        type = 'gang',         -- one gang per player; distinct from type='job'
        hasAccount = true,      -- shared treasury account
        grades = {
            { label = 'Recruit' },  -- grade 1
            { label = 'Soldier' },  -- grade 2
            { label = 'Lieutenant', accountRole = 'contributor' }, -- grade 3
            { label = 'Boss', accountRole = 'manager' },           -- grade 4
        },
    })
end)
```

`Ox.GetGroup(GANG)` returns the `OxGroup` table (`{ name, label, grades, type, hasAccount, principal, ... }`) or `nil`. `grades` is an array of labels indexed 1..n.

### Reading membership, ranks, and adding/removing members

All authoritative — performed on the server against the player object.

```lua
-- server/main.lua
local GANG = 'ballas'
local RANK = { RECRUIT = 1, SOLDIER = 2, LIEUTENANT = 3, BOSS = 4 }

-- Current grade in the gang, or nil if not a member.
local function getRank(source)
    local player = Ox.GetPlayer(source)
    return player and player.getGroup(GANG) or nil
end

-- Add or promote a member: setGroup(name, grade). grade 0 removes them.
local function setRank(source, grade)
    local player = Ox.GetPlayer(source)
    if not player then return false end
    return player.setGroup(GANG, grade) -- persists to DB
end

-- Kick a member entirely.
local function kickMember(source)
    return setRank(source, 0)
end
```

`player.getGroup` overloads (useful for "is this player in MY gang?"):

```lua
player.getGroup('ballas')              -- number grade or nil
player.getGroup({ ballas = 2 })        -- matches only if grade >= 2
local name, grade = player.getGroupByType('gang') -- the one gang they hold
```

### Gang management context menu (ox_lib)

Members open a management menu. Build the menu with `lib.registerContext` + `lib.showContext` (client), but every action triggers a **server** event that re-validates rank. Never let the menu's mere existence authorize a kick/promote.

```lua
-- client/main.lua
RegisterNetEvent('gang:openManageMenu', function(members)
    -- `members` is server-supplied: { { source=, name=, rank=, rankLabel= }, ... }
    local options = {}
    for _, m in ipairs(members) do
        options[#options + 1] = {
            title = ('%s [%s]'):format(m.name, m.rankLabel),
            description = 'Manage this member',
            onSelect = function()
                lib.registerContext({
                    id = 'gang_member_' .. m.source,
                    title = m.name,
                    menu = 'gang_manage',
                    options = {
                        { title = 'Promote', onSelect = function() TriggerServerEvent('gang:promote', m.source) end },
                        { title = 'Demote',  onSelect = function() TriggerServerEvent('gang:demote', m.source) end },
                        { title = 'Kick',    onSelect = function() TriggerServerEvent('gang:kick', m.source) end },
                    },
                })
                lib.showContext('gang_member_' .. m.source)
            end,
        }
    end

    lib.registerContext({ id = 'gang_manage', title = 'Gang Management', options = options })
    lib.showContext('gang_manage')
end)
```

```lua
-- server/main.lua
-- Only a boss (top grade) may manage. Re-check on every action.
local function isBoss(source) return getRank(source) == RANK.BOSS end

RegisterNetEvent('gang:requestManageMenu', function()
    local src = source
    if not isBoss(src) then return end -- gate the menu open itself

    -- Build the live member list server-side.
    local members = {}
    for _, ply in pairs(Ox.GetPlayers({ groups = GANG })) do
        members[#members + 1] = {
            source = ply.source,
            name = ply.get('name') or ('Player ' .. ply.source),
            rank = ply.getGroup(GANG),
        }
    end
    TriggerClientEvent('gang:openManageMenu', src, members)
end)

RegisterNetEvent('gang:promote', function(targetSrc)
    local src = source
    if not isBoss(src) then return end
    if type(targetSrc) ~= 'number' then return end

    local current = getRank(targetSrc)
    if not current or current >= RANK.BOSS then return end -- target must be a lower-ranked member
    setRank(targetSrc, current + 1)
end)

RegisterNetEvent('gang:kick', function(targetSrc)
    local src = source
    if not isBoss(src) then return end
    if type(targetSrc) ~= 'number' then return end
    if getRank(targetSrc) == nil or targetSrc == src then return end -- can't kick non-members or self
    kickMember(targetSrc)
end)
```

`Ox.GetPlayers({ groups = GANG })` returns only players in that group — use it to enumerate members rather than scanning every player.

### Group-gated gang stash (ox_inventory)

Register a stash whose access is restricted to gang members via the `groups` filter. The signature is `RegisterStash(name, label, slots, maxWeight, owner, groups, coords)` where `groups` is a `{ ['groupName'] = minGrade }` table.

```lua
-- server/main.lua
CreateThread(function()
    exports.ox_inventory:RegisterStash(
        'gang_ballas_stash',   -- unique name
        'Ballas Stash',        -- label
        50,                     -- slots
        100000,                 -- max weight (grams)
        false,                  -- owner: false/nil = shared among all who can access
        { [GANG] = RANK.SOLDIER } -- only grade >= 2 (Soldier) may open
    )
end)
```

```lua
-- client/main.lua — open it from a target point inside the hideout
exports.ox_target:addSphereZone({
    coords = vec3(126.5, -1296.0, 29.2),
    radius = 1.0,
    groups = { [GANG] = 2 }, -- cosmetic gate; server stash 'groups' is authoritative
    options = {
        {
            name = 'gang_stash',
            icon = 'fa-solid fa-box',
            label = 'Open Gang Stash',
            onSelect = function()
                exports.ox_inventory:openInventory('stash', 'gang_ballas_stash')
            end,
        },
    },
})
```

ox_inventory enforces the stash `groups` filter server-side, so even if a non-member triggers `openInventory`, the open is rejected. The target `groups` option just hides the prompt.

### Turf / territory via group-gated zones

Turf is a zone whose interactions are gated by gang membership. Use `ox_target` `groups`, or a `lib.zones` poly for "are you standing in your turf?" logic. Combine with oxmysql to persist which gang owns which territory.

```lua
-- client/main.lua — claimable turf point
exports.ox_target:addBoxZone({
    coords = vec3(100.0, -1940.0, 21.0),
    size = vec3(4, 4, 3),
    rotation = 0,
    groups = { [GANG] = 1 }, -- any member can attempt to claim
    options = {
        {
            name = 'claim_turf',
            label = 'Claim Turf',
            icon = 'fa-solid fa-flag',
            onSelect = function() TriggerServerEvent('gang:claimTurf', 'grove_st') end,
        },
    },
})
```

```lua
-- server/main.lua
RegisterNetEvent('gang:claimTurf', function(turfId)
    local src = source
    if not getRank(src) then return end       -- must be a member
    if type(turfId) ~= 'string' then return end

    MySQL.update.await(
        'UPDATE gang_turf SET owner = ?, claimed_at = NOW() WHERE turf_id = ?',
        { GANG, turfId }
    )
    lib.notify(src, { title = 'Turf', description = 'Territory claimed for the Ballas.', type = 'success' })
end)
```

### Gang treasury (oxmysql or group account)

Prefer the ox_core **group account** for the treasury — every `hasAccount = true` group has one, accessed via `Ox.GetGroupAccount(name)`. Deposits/withdrawals take an options table.

```lua
-- server/main.lua
RegisterNetEvent('gang:deposit', function(amount)
    local src = source
    if not getRank(src) then return end
    if type(amount) ~= 'number' or amount <= 0 or amount ~= math.floor(amount) then return end

    local player = Ox.GetPlayer(src)
    local pAccount = player and player.getAccount()
    local treasury = Ox.GetGroupAccount(GANG)
    if not pAccount or not treasury then return end

    -- Move money from the player's account into the gang treasury.
    if pAccount.removeBalance({ amount = amount, message = 'Gang deposit' }) then
        treasury.addBalance({ amount = amount, message = ('Deposit by %s'):format(src) })
        lib.notify(src, { title = 'Treasury', description = ('Deposited $%d'):format(amount), type = 'success' })
    end
end)
```

Only ranks with an `accountRole` of `contributor`/`manager`/`owner` (set in the grade definition) can move treasury funds via ox_core's account permission system — design your grades accordingly. If you do not use a group account, keep a `gang_treasury` table in oxmysql and mutate it inside a `MySQL.transaction.await` (see `db-oxmysql`).

## Minimal Complete Example

```lua
-- server/main.lua
local GANG = 'ballas'
local RANK = { RECRUIT = 1, SOLDIER = 2, LIEUTENANT = 3, BOSS = 4 }

local function getRank(src)
    local p = Ox.GetPlayer(src); return p and p.getGroup(GANG) or nil
end
local function isBoss(src) return getRank(src) == RANK.BOSS end

CreateThread(function()
    if not Ox.GetGroup(GANG) then
        Ox.CreateGroup({
            name = GANG, label = 'Ballas', type = 'gang', hasAccount = true,
            grades = { { label = 'Recruit' }, { label = 'Soldier' },
                       { label = 'Lieutenant', accountRole = 'contributor' },
                       { label = 'Boss', accountRole = 'manager' } },
        })
    end
    exports.ox_inventory:RegisterStash('gang_ballas_stash', 'Ballas Stash', 50, 100000, false, { [GANG] = RANK.SOLDIER })
end)

lib.addCommand('gang', { help = 'Open gang management', restricted = 'group.ballas:4' }, function(source)
    TriggerEvent('gang:requestManageMenu', source) -- re-validates inside
end)

RegisterNetEvent('gang:kick', function(targetSrc)
    local src = source
    if not isBoss(src) or type(targetSrc) ~= 'number' or targetSrc == src then return end
    if getRank(targetSrc) == nil then return end
    Ox.GetPlayer(targetSrc).setGroup(GANG, 0)
end)
```

```lua
-- client/main.lua
RegisterCommand('gangmenu', function() TriggerServerEvent('gang:requestManageMenu') end)

RegisterNetEvent('gang:openManageMenu', function(members)
    local options = {}
    for _, m in ipairs(members) do
        options[#options + 1] = {
            title = m.name,
            onSelect = function() TriggerServerEvent('gang:kick', m.source) end,
        }
    end
    lib.registerContext({ id = 'gang_manage', title = 'Gang Management', options = options })
    lib.showContext('gang_manage')
end)
```

## Security

- **Membership and rank are server truth.** Always resolve `player.getGroup(GANG)` server-side. Never accept a rank or "is member" flag from the client.
- **Re-check on every management action.** A boss kicking/promoting must be re-verified in the `gang:kick`/`gang:promote` handler — the context menu existing on the client proves nothing.
- **Stash `groups` is authoritative; target `groups` is cosmetic.** ox_inventory enforces the stash group filter on open; the ox_target `groups` field only hides the prompt. Always set the stash filter.
- **Validate the target.** Confirm `type(targetSrc) == 'number'`, that the target is actually a member (`getRank ~= nil`), is lower-ranked, and is not the actor themselves.
- **Treasury moves go through account permissions.** Give move rights only to senior grades via `accountRole`; validate deposit amounts (positive integer) server-side.
- **Rate-limit** turf claims and treasury actions with a cooldown table cleaned up in `playerDropped`.
- All `security` skill rules (source validation, input validation, no exposed config) apply.

## Common Mistakes

- **Looking for a gang API.** There isn't one — gangs are ox_core groups. Use `Ox.GetGroup`, `player.getGroup`, `player.setGroup`. Identical to the `job` recipe's primitive.
- **Confusing gang and job mechanics.** They share the group primitive; the difference is `type` and intent. Don't try to import a "gang" library — set `type = 'gang'` and build the UX.
- **1-based grade confusion.** Grade `1` is the lowest rank; grade `0` removes membership. The boss is the highest index in `grades`, not grade `0`.
- **Omitting the stash `groups` filter.** Without it, anyone who reaches `openInventory` can loot the stash. The filter is `{ ['ballas'] = minGrade }`.
- **Positional account args.** Use `treasury.addBalance({ amount = n, message = '...' })`, never `addBalance(n)`.
- **Trusting the management menu.** Re-validate `isBoss(source)` inside every server handler, not just before opening the menu.
- **Calling `Ox.CreateGroup` without a guard.** It throws if the gang already exists; check `Ox.GetGroup` first.
- **Expecting a `player.gang` field.** There is no built-in gang field on the player — gangs ARE ox_core groups. Use `Ox.GetGroup`, `player.getGroup`, `player.setGroup` with `type = 'gang'`. ox_overextended only.

## Dependencies

| Resource       | Required | Purpose                                                           |
| :------------- | :------- | :---------------------------------------------------------------- |
| `ox_lib`       | Always   | `lib.registerContext`/`lib.showContext`, `lib.addCommand`, notify |
| `ox_core`      | Always   | Groups-as-gangs, member ranks, treasury account (`Ox.*` API)      |
| `oxmysql`      | Always   | Turf/territory persistence; treasury if not using a group account |
| `ox_target`    | If used  | Group-gated turf zones, stash interaction points                  |
| `ox_inventory` | If used  | Group-gated gang stash via `RegisterStash` `groups` filter        |

Declare in `fxmanifest.lua` (load `@ox_lib/init` so `lib` is global; `ox_lib` must start before `ox_core` in `server.cfg`):

```lua
shared_scripts { '@ox_lib/init.lua' }
server_scripts { '@oxmysql/lib/MySQL.lua', 'server/*.lua' }
client_scripts { 'client/*.lua' }

dependencies {
    'ox_lib',
    'ox_core',
    'oxmysql',
}
```
