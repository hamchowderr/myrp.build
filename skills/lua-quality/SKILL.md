---
name: lua-quality
description: "Lua coding standards and best practices for FiveM — based on effective-fivem-lua. Covers functions, events, tables, variables, conditionals, natives, error handling, naming conventions. Use when writing ANY Lua code for FiveM resources."
---

# Lua Quality Standards for FiveM

These rules apply to ALL Lua code written for FiveM. Violating them produces code that compiles but causes lag, exploits, or crashes in production.

## Functions

### Single Responsibility

Each function does one thing. If you find yourself naming a function with "and" in it, split it.

> NOTE: `setMoney`/`getMoney`/`addMoney`/`removeMoney` in the snippets below are
> ILLUSTRATIVE placeholders for "some operation" — they are **not** real ox_core
> methods. Real money lives in the ACCOUNTS system (`GetCharacterAccount` +
> `CallAccount`); see the `fw-ox-core` skill. These examples only teach Lua structure.

```lua
-- WRONG
local function getPlayerAndUpdateMoney(source, amount)
  local player = getPlayer(source)
  player.setMoney(amount)
  return player
end

-- CORRECT
local function getPlayer(source)
  return exports.ox_core:GetPlayer(source)
end

local function updateMoney(player, amount)
  player.setMoney(amount)
end
```

### Parameter Count — 3 Maximum

If a function needs more than 3 parameters, use a table.

```lua
-- WRONG
local function createVehicle(model, x, y, z, heading, color1, color2, plate)
  -- too many params
end

-- CORRECT
local function createVehicle(opts)
  -- opts.model, opts.coords, opts.heading, opts.colors, opts.plate
end
```

### Guard Clauses for Early Returns

Check preconditions first, return early. Avoid deep nesting.

```lua
-- WRONG
local function processReward(source, amount)
  local player = getPlayer(source)
  if player then
    if amount > 0 then
      if player.getMoney() + amount <= MAX_MONEY then
        player.addMoney(amount)
      end
    end
  end
end

-- CORRECT
local function processReward(source, amount)
  local player = getPlayer(source)
  if not player then return end
  if amount <= 0 then return end
  if player.getMoney() + amount > MAX_MONEY then return end
  player.addMoney(amount)
end
```

### Naming Conventions

- **camelCase** for local functions: `getPlayer`, `dropItem`, `calculateDistance`
- **PascalCase** for global functions: `GetPlayer`, `DropItem`
- **Leading verb** in names: `getPlayer`, `setJob`, `checkPermission`, `validateInput`
- Prefix booleans with `is`/`has`/`can`/`should`: `isAdmin`, `hasPermission`, `canCarry`
- Avoid boolean parameters in API/exported functions — use string enums or option tables

### Avoid Boolean Parameters

```lua
-- WRONG — what does true mean here?
transferItem(source, target, 'bread', 5, true)

-- CORRECT — intent is clear
transferItem(source, target, 'bread', 5, { removeOnTransfer = true })
```

### Lua Language Server Annotations on Exports

Add type annotations to exported functions so other resources get autocomplete.

```lua
---@param source number Player server ID
---@param itemName string Name of the item
---@param count? number Amount to add (default 1)
---@return boolean success Whether the item was added
local function addItem(source, itemName, count)
  count = count or 1
  -- ...
end
exports('addItem', addItem)
```

### Keep Returned Values Small

Return only what the caller needs. Prefer accessor exports over table dumps.

```lua
-- WRONG — exposes entire player object, memory waste
exports('getPlayer', function(source)
  return Players[source] -- massive table
end)

-- CORRECT — return specific data
exports('getPlayerJob', function(source)
  local player = Players[source]
  if not player then return nil end
  return player.job
end)
```

### Localize Callback Functions

Define callback functions before passing them — do not define inline in hot paths.

```lua
-- WRONG in hot paths
someLib.onEvent(function(data)
  -- creates a new closure every call
end)

-- CORRECT
local function onEventHandler(data)
  -- defined once, reused
end
someLib.onEvent(onEventHandler)
```

## Events

### Naming Convention

```
{resourceName}:{client/server}:{eventName}
```

Past tense for events that report something happened. Present tense for commands.

```lua
-- Event names (past tense — something happened)
TriggerEvent('banking:server:accountCreated', accountId)
TriggerClientEvent('banking:client:balanceUpdated', source, newBalance)

-- Command-style (present tense — requesting an action)
TriggerServerEvent('banking:server:createAccount', accountType)
```

### Return Data via Callbacks

Do not return data directly from events — use callbacks or server-side exports.

```lua
-- WRONG — events do not return values
AddEventHandler('getPlayerData', function()
  return playerData -- this goes nowhere
end)

-- CORRECT — use a callback event
RegisterNetEvent('myresource:server:requestData', function()
  local source = source
  local data = getPlayerData(source)
  TriggerClientEvent('myresource:client:receiveData', source, data)
end)
```

### Secure Exports with GetInvokingResource

```lua
exports('addItem', function(source, item, count)
  local invoker = GetInvokingResource()
  if not invoker then return false end
  -- log which resource called this
  print(('[%s] addItem called by %s'):format(GetCurrentResourceName(), invoker))
  -- proceed
end)
```

## Tables

### Implied Array Indices

```lua
-- CORRECT
local fruits = {'apple', 'banana', 'cherry'}

-- WRONG — unnecessary explicit indices
local fruits = {[1] = 'apple', [2] = 'banana', [3] = 'cherry'}
```

### Append with # Operator

```lua
-- CORRECT
myTable[#myTable + 1] = value

-- WRONG — table.insert is slower
table.insert(myTable, value)
```

### Dot Notation for String Keys

```lua
-- CORRECT
local name = player.name
player.job = 'police'

-- WRONG — bracket notation for known string keys
local name = player['name']
player['job'] = 'police'
```

Bracket notation is only for dynamic keys: `player[keyVariable]`

### Numeric For When Order Matters

```lua
-- When order matters, use numeric for
for i = 1, #items do
  processItem(items[i])
end

-- When order does not matter, pairs is fine
for k, v in pairs(config) do
  applyConfig(k, v)
end
```

### Length Operator

```lua
-- CORRECT
local count = #myTable

-- WRONG — deprecated
local count = table.getn(myTable)
```

## Variables

### Naming

- `ALL_CAPS` for constants: `MAX_HEALTH`, `COOLDOWN_MS`, `DEFAULT_JOB`
- `camelCase` for locals: `playerData`, `vehicleList`, `isActive`
- `PascalCase` for globals: `PlayerCache`, `VehicleRegistry`

### Enums Over Booleans

```lua
-- WRONG — what does true/false mean?
local isVIP = true
if isVIP then ... end

-- CORRECT — string constants are self-documenting
local MEMBERSHIP = {
  FREE = 'free',
  VIP = 'vip',
  PREMIUM = 'premium'
}

local membership = MEMBERSHIP.VIP
if membership == MEMBERSHIP.VIP then ... end
```

### Default Values with `or`

```lua
local name = input or 'Unknown'
local count = amount or 1
local config = opts or {}
```

## Conditionals

### No Redundant Boolean Returns

```lua
-- WRONG
local function isAdmin(source)
  if hasPermission(source, 'admin') then
    return true
  else
    return false
  end
end

-- CORRECT
local function isAdmin(source)
  return hasPermission(source, 'admin')
end
```

### Positive Logic Preferred

```lua
-- WRONG — double negative
if not isNotReady then ... end

-- CORRECT
if isReady then ... end
```

### Ternary Pattern

```lua
local label = isVIP and 'VIP Member' or 'Regular'
local speed = inVehicle and 100 or 50
```

**Caveat:** This fails if the "true" value is `false` or `nil`. In those cases, use if/else.

## Natives — FiveM Specific

### NO Citizen. Prefix

The community standard is to use the bare function names. The `Citizen.` prefix is legacy.

```lua
-- CORRECT — community standard
CreateThread(function()
  while true do
    Wait(500)
    checkNearbyPlayers()
  end
end)

-- WRONG — legacy prefix
Citizen.CreateThread(function()
  while true do
    Citizen.Wait(500)
    checkNearbyPlayers()
  end
end)
```

All instances:

- `CreateThread()` NOT `Citizen.CreateThread()`
- `Wait()` NOT `Citizen.Wait()`
- `Await()` NOT `Citizen.Await()`

### Backtick Hashes

Use backtick syntax for hash keys — it is resolved at compile time, not runtime.

```lua
-- CORRECT — compile-time hash
local weaponHash = `weapon_pistol`
local modelHash = `adder`

-- WRONG — runtime hash lookup
local weaponHash = GetHashKey('weapon_pistol')
local modelHash = GetHashKey('adder')
```

### Vector Distance

Use the vector math operator — it is a native operation, faster than the deprecated function.

```lua
-- CORRECT — vector subtraction + length
local distance = #(vec1 - vec2)

-- WRONG — deprecated function, slower
local distance = GetDistanceBetweenCoords(vec1.x, vec1.y, vec1.z, vec2.x, vec2.y, vec2.z, true)
```

### Player Ped

```lua
-- CORRECT
local ped = PlayerPedId()

-- WRONG — deprecated
local ped = GetPlayerPed(-1)
```

### Client Natives

```lua
-- GetEntityCoords returns vec3 — use .x / .y / .z
local coords = GetEntityCoords(ped)
print(coords.x, coords.y, coords.z)

-- Send entity references to server via network ID
local netId = NetworkGetNetworkIdFromEntity(entity)
TriggerServerEvent('myresource:server:processEntity', netId)

-- Model loading pattern
local hash = `prop_bench_01a`
RequestModel(hash)
while not HasModelLoaded(hash) do Wait(100) end
-- use model
SetModelAsNoLongerNeeded(hash)
```

### Server Natives

```lua
-- Use source from the event handler — NEVER trust client-sent source
RegisterNetEvent('myresource:server:doThing', function(data)
  local source = source -- implicit from the event
  local ped = GetPlayerPed(source)

  -- Always check entity exists
  if not DoesEntityExist(ped) then return end

  -- Get identifiers
  local identifiers = GetPlayerIdentifiers(source)
  for _, id in ipairs(identifiers) do
    if string.find(id, 'steam:') then
      -- found steam identifier
    end
  end
end)
```

## Error Handling

### assert() for Impossible States

Use `assert` when something should never happen — configuration errors, missing required fields, impossible logic states.

```lua
local config = json.decode(LoadResourceFile(GetCurrentResourceName(), 'config.json'))
assert(config, 'Failed to load config.json — file missing or invalid JSON')
assert(config.spawnPoint, 'config.json missing required field: spawnPoint')
```

### Errors-as-Values for Expected Failures

When a function can fail for legitimate reasons, return `nil` plus an error — do not throw.

```lua
local function withdrawMoney(source, amount)
  local player = getPlayer(source)
  if not player then
    return nil, { code = 'PLAYER_NOT_FOUND', message = 'Player not loaded' }
  end

  local balance = player.getMoney()
  if balance < amount then
    return nil, { code = 'INSUFFICIENT_FUNDS', message = 'Not enough money' }
  end

  player.removeMoney(amount)
  return amount
end

-- Caller
local withdrawn, err = withdrawMoney(source, 500)
if not withdrawn then
  print(('[banking] Withdrawal failed: %s'):format(err.message))
  return
end
```

### pcall for External Calls

Wrap calls to other resources that may throw.

```lua
local ok, player = pcall(function()
  return exports.ox_core:GetPlayer(source)
end)
if not ok or not player then
  print(('[resource-name] ERROR: could not get player for source %s'):format(tostring(source)))
  return
end
```

### Pre-Condition Checks

Validate all client-supplied arguments before trusting them.

```lua
RegisterNetEvent('resource:transferMoney', function(targetSrc, amount)
  local source = source
  if type(amount) ~= 'number' or amount <= 0 or amount > 100000 then return end
  if type(targetSrc) ~= 'number' or targetSrc <= 0 then return end
  -- proceed with validated data
end)
```

### Fail Loudly for Unexpected State

Do not silently return on impossible conditions — log and fail so the bug is visible.

```lua
local function getVehicle(plate)
  local vehicle = VehicleRegistry[plate]
  if not vehicle then
    -- This should never happen if the code is correct
    error(('[vehicles] BUG: getVehicle called with unregistered plate: %s'):format(plate))
  end
  return vehicle
end
```

### Logging vs Throwing — Use Judgment

- **Recoverable failures** (player not found, item not in inventory): log a warning, return nil/false
- **Unrecoverable/impossible states** (missing config, broken invariant): `error()` or `assert()`
- **External call failures** (export threw, native returned unexpected value): `pcall` + log

## Performance

### Cache Globals as Locals at File Scope

Table lookups cost time in loops. Cache at the top of the file.

```lua
local pairs = pairs
local ipairs = ipairs
local tonumber = tonumber
local math_floor = math.floor
local string_format = string.format
```

### Cache Export References in Hot Paths

```lua
local oxInventory = exports.ox_inventory

-- Then use:
local items = oxInventory:GetInventory(source)
```

### String Building with table.concat

```lua
-- CORRECT — O(n) string building
local parts = {}
for i, item in ipairs(items) do
  parts[i] = item.label
end
local display = table.concat(parts, ', ')

-- WRONG — O(n^2) string concatenation in loop
local display = ''
for _, item in ipairs(items) do
  display = display .. item.label .. ', '
end
```

### Nil-Check Player Objects

```lua
local function getPlayer(source)
  local player = exports.ox_core:GetPlayer(source)
  if not player then return nil end
  return player
end
```

### Thread Wait Intervals

```lua
-- Logic checks: minimum 100ms
CreateThread(function()
  while true do
    Wait(100)
    if someCondition then doThing() end
  end
end)

-- Polling (proximity, zone checks): 500ms+
CreateThread(function()
  while true do
    Wait(500)
    checkNearbyPlayers()
  end
end)

-- Dynamic wait — tight when active, relaxed when idle
CreateThread(function()
  while true do
    local inZone = IsPlayerInZone()
    Wait(inZone and 100 or 2000)
    if inZone then handleZoneLogic() end
  end
end)

-- One-shot async setup
CreateThread(function()
  Wait(0)
  doOneTimeSetup()
end)

-- Wait(0) ONLY for render/drawing loops that must run every frame
CreateThread(function()
  while true do
    Wait(0)
    DrawMarker(1, coords.x, coords.y, coords.z, ...)
  end
end)
```

**Thread rules:**

- `Wait(0)` is ONLY acceptable inside render/drawing loops
- Any logic check: minimum `Wait(100)`
- Most loops: `Wait(500)` to `Wait(2000)`
- Dynamic wait is the gold standard — tight when active, relaxed when idle

## Rate Limiting

Every network event that triggers expensive work needs a cooldown.

```lua
local cooldowns = {}
local COOLDOWN = 3000 -- milliseconds

RegisterNetEvent('resource:expensiveAction', function(data)
  local source = source
  local now = GetGameTimer()
  if cooldowns[source] and (now - cooldowns[source]) < COOLDOWN then return end
  cooldowns[source] = now
  -- do the expensive work
end)

-- Always clean up per-player state on disconnect
AddEventHandler('playerDropped', function()
  local source = source
  cooldowns[source] = nil
end)
```

For sensitive actions (economy, item transfers): add server-side validation beyond just cooldown. Verify the player actually has the required items/money BEFORE deducting.

## fxmanifest.lua Template

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveM Studio'
description 'Resource description'
version '1.0.0'

shared_scripts {
  '@ox_lib/init.lua',
  'shared/*.lua'
}

server_scripts {
  '@oxmysql/lib/MySQL.lua',
  'server/*.lua'
}

client_scripts {
  'client/*.lua'
}

-- NUI only:
files { 'html/index.html', 'html/style.css', 'html/app.js' }
ui_page 'html/index.html'

dependencies {
  'ox_lib',
  'oxmysql'
}
```

Rules:

- `lua54 'yes'` is ALWAYS included — enables Lua 5.4 features, required for ox_lib 3.x
- `game 'gta5'` is ALWAYS included
- Declare EVERY script file — missing declarations = silent load failure
- List `ox_lib`/`oxmysql` BEFORE your own scripts so globals are available
- Only list dependencies you actually use — extra deps cause startup warnings

## NUI (HTML/CSS/JS Interfaces)

```lua
-- Opening NUI — ALWAYS set focus
RegisterNetEvent('myresource:openMenu', function()
  SetNuiFocus(true, true)
  SendNUIMessage({ action = 'open', data = myData })
end)

-- Closing NUI — ALWAYS release focus
RegisterNuiCallback('closeMenu', function(_, cb)
  SetNuiFocus(false, false)
  cb('ok', {})
end)
```

- Always call `SetNuiFocus(true, true)` when opening
- Always call `SetNuiFocus(false, false)` on close
- Always send `cb('ok', {})` in NUI callbacks to resolve the JS promise
- Never use `window.invokeNative` — always `fetch()` for NUI callbacks
- Never leave `SetNuiFocus(true, true)` without a close path — it traps the mouse
- HUD resources: body must have `pointer-events: none`, NEVER call `SetNuiFocus`

## HUD Design Standards

A HUD is a passive, always-visible NUI overlay. It NEVER calls SetNuiFocus.

Required stats (unless the user explicitly asks for fewer):

- Health (red) — `GetEntityHealth(ped)`, maps 100-200 to 0-100%
- Armor (blue) — `GetPedArmour(ped)`, 0-100
- Hunger (orange/yellow) — from framework player data
- Thirst (cyan/teal) — from framework player data
- Stamina (green) — `GetPlayerStamina(PlayerId())`, 0-100

Visual design:

- Position: bottom-left, above the GTA V minimap (bottom ~178px, left ~15px)
- Width: ~200-220px (matches minimap width)
- Background: dark, semi-transparent with blur
- Bars: thin (6-8px), rounded, gradient fills, smooth CSS transitions
- body must have `pointer-events: none`

Client pattern:

- One `CreateThread` polling at 200-500ms
- Read health/armor/stamina from natives, hunger/thirst from framework metadata
- Single `SendNUIMessage({ action = 'update', ... })` per tick
- `{ action = 'show' }` on player load, `{ action = 'hide' }` on death

## Commands

```lua
-- With ox_lib (preferred when available)
lib.addCommand('admintp', {
  help = 'Teleport to a player',
  params = { { name = 'id', type = 'playerId', help = 'Player ID' } },
  restricted = 'group.admin'
}, function(source, args, raw)
  -- args.id is validated
end)

-- Without ox_lib
RegisterCommand('mycommand', function(source, args, rawCommand)
  if source == 0 then return end -- reject console
  -- manually validate args
end, false)
```

- Never skip `source == 0` check on server-side commands
- Never trust args without validation
