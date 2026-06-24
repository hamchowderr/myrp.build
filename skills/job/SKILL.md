---
name: job
description: "ox_core job resource recipe — model jobs as ox_core groups (group + grade), duty/clock-in via ox_target, lib.addCommand job actions, grade-gated access, salary timers with the group account, job tools/uniforms via ox_inventory. Use when generating a job resource for an ox_core server."
---

# Job Resource Patterns

You are generating a **job** resource for an ox_core server. In the Overextended ecosystem there is no separate "jobs" system — **a job is an ox_core group**. A player who works for the police "job" is simply a member of the `police` group at some grade. This recipe shows how to model jobs on top of ox_core groups, gate access by grade, run a salary loop, and hand out job tools — all server-authoritative.

For the underlying framework primitives (player object, callbacks, notifications) see the `fw-ox-core` skill. For database see `db-oxmysql`. For NUI menus see `nui-patterns`. For validation rules see `security`.

## Overview

ox_core models a job as a **group** row in the `ox_groups` table with:

- `name` — internal id, e.g. `police` (use this in all server code)
- `label` — display name, e.g. `Los Santos Police Department`
- `grades` — an **ordered array of grade labels**; grade index is 1-based. Grade `1` is the lowest rank, higher numbers are higher rank. Grade `0` means "not in the group".
- `type` — optional. Groups that share a `type` are **mutually exclusive** — a player can only hold one group of a given type at a time. Set `type = 'job'` on every job group so a player cannot be police AND mechanic simultaneously.
- `hasAccount` — set `true` to give the group a shared bank account (used here for the payroll source).

Groups are normally seeded once via `Ox.CreateGroup(...)` or inserted into `ox_groups` directly. Your resource then reads/sets a player's grade with `player.getGroup` / `player.setGroup` and gates everything on the server.

**Key distinction from a gang:** a job and a gang are the _same_ ox_core group primitive. The only difference is intent and convention — jobs typically set `type = 'job'` (one job at a time), are assigned by admins via `/setgroup`, and pay a salary; gangs (see the `gang` skill) set `type = 'gang'`, are self-managed by members, and hold a treasury. Mechanically the API is identical.

## Core Patterns

### Defining the job group (one-time seed)

Seed groups once on resource start. `Ox.CreateGroup` is idempotent-safe only if you guard it — it throws if the group already exists, so check `Ox.GetGroup` first. `grades` is ordered low → high.

```lua
-- server/main.lua
local JOB = 'police'

CreateThread(function()
    if Ox.GetGroup(JOB) then return end -- already seeded

    Ox.CreateGroup({
        name = JOB,
        label = 'Los Santos Police Department',
        type = 'job',          -- mutually exclusive with other type='job' groups
        hasAccount = true,      -- creates a shared group bank account for payroll
        grades = {
            { label = 'Cadet' },          -- grade 1
            { label = 'Officer' },        -- grade 2
            { label = 'Sergeant' },       -- grade 3
            { label = 'Chief', accountRole = 'manager' }, -- grade 4
        },
    })
end)
```

`Ox.GetGroup(name)` returns the `OxGroup` table (`{ name, label, grades, type, hasAccount, principal, ... }`) read from GlobalState, or `nil` if it does not exist.

### Reading and setting a player's job server-side (authoritative)

Never trust the client for the player's job or grade. Always resolve it on the server from the player object.

```lua
-- server/main.lua
local JOB = 'police'

-- Read: returns the player's grade in the group (number), or nil if not a member.
local function getJobGrade(source)
    local player = Ox.GetPlayer(source)
    if not player then return nil end
    return player.getGroup(JOB) -- e.g. 2, or nil
end

-- Set: setGroup(groupName, grade). grade 0 removes them from the job.
-- Returns true on success. Persists to the database automatically.
local function setJob(source, grade)
    local player = Ox.GetPlayer(source)
    if not player then return false end
    return player.setGroup(JOB, grade)
end
```

`player.getGroup` is overloaded:

```lua
player.getGroup('police')               -- number grade, or nil
-- Pass an array to find the first matching group of several:
local name, grade = player.getGroup({ 'police', 'ambulance' }) -- 'police', 2
-- Pass { group = minGrade } to require a minimum grade:
local name, grade = player.getGroup({ police = 2 })            -- only matches grade >= 2
-- By type (returns the single job they hold):
local name, grade = player.getGroupByType('job')
```

### Grade-gated server actions

Gate every privileged action on the server by re-reading the player's grade. Define grade constants so intent is clear.

```lua
-- server/main.lua
local JOB = 'police'
local GRADE = { CADET = 1, OFFICER = 2, SERGEANT = 3, CHIEF = 4 }

local function hasMinGrade(source, minGrade)
    local player = Ox.GetPlayer(source)
    if not player then return false end
    local grade = player.getGroup(JOB)
    return grade ~= nil and grade >= minGrade
end

RegisterNetEvent('job:police:cuffSuspect', function(targetNetId)
    local src = source
    -- Authoritative grade check — client cannot bypass this.
    if not hasMinGrade(src, GRADE.OFFICER) then return end
    if type(targetNetId) ~= 'number' then return end
    -- ... perform action ...
end)
```

### Duty / clock-in via an ox_target zone

Clock-in toggles an "on duty" state. The target option itself is gated by `groups` so only members see it, but you **still re-check on the server** when the duty event fires.

```lua
-- client/main.lua
local DUTY_POINT = vec3(441.0, -981.0, 30.69) -- Mission Row PD

CreateThread(function()
    exports.ox_target:addSphereZone({
        coords = DUTY_POINT,
        radius = 1.2,
        debug = false,
        -- ox_target natively hides this option from non-members.
        -- groups = { ['police'] = minGrade }
        groups = { ['police'] = 1 },
        options = {
            {
                name = 'police_duty',
                icon = 'fa-solid fa-user-clock',
                label = 'Toggle Duty',
                onSelect = function()
                    TriggerServerEvent('job:police:toggleDuty')
                end,
            },
        },
    })
end)
```

```lua
-- server/main.lua
local onDuty = {} -- [source] = true

RegisterNetEvent('job:police:toggleDuty', function()
    local src = source
    -- Re-verify membership server-side; the client target gate is cosmetic.
    if not getJobGrade(src) then return end

    onDuty[src] = not onDuty[src]
    lib.notify(src, {
        title = 'Duty',
        description = onDuty[src] and 'You are now on duty.' or 'You are now off duty.',
        type = onDuty[src] and 'success' or 'inform',
    })
end)

AddEventHandler('playerDropped', function()
    onDuty[source] = nil -- always clean up per-player state
end)
```

### Job action commands via lib.addCommand

`lib.addCommand` runs server-side. The `restricted` field accepts an ACE principal — ox_core grants every group member the principal `group.<name>` and each grade the principal `group.<name>:<grade>`. Use `restricted = 'group.police'` to allow any member, or `'group.police:3'` to require grade ≥ 3.

```lua
-- server/main.lua
lib.addCommand('cuff', {
    help = 'Cuff the nearest suspect',
    restricted = 'group.police', -- any police member; ACE-checked automatically
    params = {
        { name = 'target', type = 'playerId', help = 'Target player id' },
    },
}, function(source, args)
    -- args.target is already validated as an online player id by ox_lib.
    -- Defense-in-depth: still confirm grade if the action needs a minimum rank.
    if not hasMinGrade(source, GRADE.OFFICER) then return end
    -- ... cuff logic ...
end)

lib.addCommand('hire', {
    help = 'Hire a player into the police force',
    restricted = 'group.police:3', -- sergeant and above only
    params = {
        { name = 'target', type = 'playerId' },
        { name = 'grade', type = 'number', optional = true },
    },
}, function(source, args)
    local grade = args.grade or 1
    if grade < 1 or grade > 4 then return end
    setJob(args.target, grade)
    lib.notify(args.target, { title = 'Hired', description = 'Welcome to the LSPD.', type = 'success' })
end)
```

`type` values for params: `'number'`, `'string'`, `'playerId'`, `'longString'`.

### Salary on a timer (group account → player)

Pay on-duty members on an interval. ox_core groups with `hasAccount = true` own a shared **group account**; pull the account with `Ox.GetGroupAccount(name)` and move money with the account's `removeBalance` / a player payout. Account mutation methods take an **options table**, not positional args.

```lua
-- server/main.lua
local JOB = 'police'
local PAY_INTERVAL = 10 * 60 * 1000 -- 10 minutes
local SALARY = { [1] = 200, [2] = 350, [3] = 500, [4] = 800 } -- by grade

CreateThread(function()
    while true do
        Wait(PAY_INTERVAL)

        local account = Ox.GetGroupAccount(JOB) -- shared LSPD account
        if account then
            for src in pairs(onDuty) do
                local player = Ox.GetPlayer(src)
                local grade = player and player.getGroup(JOB)
                local amount = grade and SALARY[grade]

                if amount then
                    -- Withdraw payroll from the group account (overdraw guarded).
                    local ok = account.removeBalance({ amount = amount, message = 'Payroll' })
                    if ok then
                        -- Credit the player's personal account.
                        local pAccount = player.getAccount()
                        if pAccount then
                            pAccount.addBalance({ amount = amount, message = 'Salary' })
                            lib.notify(src, { title = 'Paycheck', description = ('$%d deposited'):format(amount), type = 'success' })
                        end
                    end
                end
            end
        end
    end
end)
```

If a job has no group account, source salary from oxmysql instead — store a city treasury row and decrement it in a `MySQL.transaction.await` alongside the deposit (see `db-oxmysql`).

### Job tools / uniform via ox_inventory

Hand out job items on clock-in and reclaim them on clock-off. Always check carry capacity server-side first.

```lua
-- server/main.lua
local JOB_ITEMS = { 'police_badge', 'handcuffs', 'radio' }

local function giveJobKit(src)
    for _, item in ipairs(JOB_ITEMS) do
        if exports.ox_inventory:CanCarryItem(src, item, 1) then
            exports.ox_inventory:AddItem(src, item, 1)
        end
    end
end

local function takeJobKit(src)
    for _, item in ipairs(JOB_ITEMS) do
        local has = exports.ox_inventory:GetItem(src, item, nil, true) -- returns count
        if has and has > 0 then
            exports.ox_inventory:RemoveItem(src, item, has)
        end
    end
end
```

For a uniform, gate a clothing change behind the same grade check, or register a grade-gated wardrobe stash via `RegisterStash` with a `groups` filter (see the `gang` skill's stash pattern — identical mechanism).

## Security

Jobs are an authority and economy system, so the `security` skill rules apply in full. Specifically:

- **Server is the source of truth for job and grade.** Resolve `player.getGroup(JOB)` on the server for every privileged action. Never accept a job/grade sent in an event payload.
- **`groups` on ox_target options is cosmetic.** It hides the option from non-members on their own client, but a crafted client can still fire the underlying event. Re-check membership/grade in the server handler.
- **Validate command params** even though `lib.addCommand` does basic coercion — clamp grade ranges, confirm targets exist (`type(target) == 'number'`).
- **Salary must read grade live** at payout time, not from a cached value the client could influence.
- **Rate-limit** clock-in/out and any action event with a cooldown table; clean it up in `playerDropped`.
- **ACE restriction** via `restricted = 'group.police:3'` is enforced by ox_lib before your handler runs — prefer it for admin/management commands.

## Common Mistakes

- **Treating jobs as a separate system.** There is no `setJob`/`getJob` export in ox_core. Use `player.setGroup` / `player.getGroup`. A job IS a group.
- **Off-by-one on grades.** Grades are **1-based**; grade `0` means "no job". The first entry in your `grades` array is grade `1`, not `0`.
- **Forgetting `type = 'job'`.** Without a shared `type`, a player can hold multiple jobs at once. Set the same `type` on every job group to make them mutually exclusive.
- **Calling `Ox.CreateGroup` unconditionally.** It throws if the group already exists. Guard with `if Ox.GetGroup(name) then return end`.
- **Passing positional args to account methods.** `account.addBalance(amount)` is wrong — it takes an options table: `account.addBalance({ amount = amount, message = '...' })`.
- **Trusting the client's duty state.** Keep the on-duty set server-side; never let the client assert it is on duty to unlock pay or actions.
- **Expecting a `player.job` field.** There is no built-in job field on the player — a job IS an ox_core group. Read it with `player.getGroup` and set it with `player.setGroup`, using a shared `type = 'job'`. ox_overextended only.

## Dependencies

| Resource       | Required | Purpose                                                             |
| :------------- | :------- | :------------------------------------------------------------------ |
| `ox_lib`       | Always   | `lib.addCommand`, `lib.notify`, callbacks, classes                  |
| `ox_core`      | Always   | Groups-as-jobs, player object, group accounts (`Ox.*` API)          |
| `oxmysql`      | Always   | Persistence (treasury rows, payroll ledger) when not using accounts |
| `ox_target`    | If used  | Duty/clock-in zones, grade-gated interaction points                 |
| `ox_inventory` | If used  | Job tools, uniforms, grade-gated stashes                            |

Declare in `fxmanifest.lua` (load `@ox_lib/init` so `lib` is global, and ensure `ox_lib` starts before `ox_core` in `server.cfg`):

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
