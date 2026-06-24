---
name: security
description: "FiveM resource security — source validation, rate limiting, server-side economy, ACE permissions, anti-exploit patterns. Use when generating resources that handle player data, money, items, or network events."
---

# FiveM Resource Security

Every resource that handles player data, economy, items, or network events must follow these security patterns. FiveM resources are a common target for exploits because client-side code runs on untrusted machines.

## Core Principle

**NEVER trust the client.** Any data sent from a client can be fabricated. All authoritative logic (money, items, permissions, state changes) must run server-side with validation.

## Source Validation

Every server-side event handler MUST validate the `source` parameter:

```lua
-- CORRECT: use the implicit source variable
RegisterNetEvent('myresource:transferMoney', function(targetId, amount)
  local source = source  -- capture the implicit source (set by FiveM runtime)

  -- Validate source is a real connected player
  if not source or source <= 0 then return end
  if not GetPlayerName(source) then return end

  -- Now safe to proceed
end)

-- WRONG: trusting a source value sent by the client
RegisterNetEvent('myresource:giveMoney', function(playerSource, amount)
  -- playerSource is CLIENT-SUPPLIED — an exploiter can send any player ID
  -- NEVER use client-sent source values for authoritative operations
end)
```

**Rules:**

- ALWAYS use the implicit `source` variable in event handlers — it is set by the FiveM runtime and cannot be spoofed
- NEVER trust a source/player ID that was sent as an event argument
- Check `GetPlayerName(source)` to verify the source is a connected player
- Check `source ~= 0` to reject console invocations when appropriate

## Input Validation

Validate ALL client-supplied arguments before processing:

```lua
RegisterNetEvent('myresource:transferMoney', function(targetId, amount)
  local source = source

  -- Type checking
  if type(amount) ~= 'number' then return end
  if type(targetId) ~= 'number' then return end

  -- Range checking
  if amount <= 0 or amount > 100000 then return end
  if targetId <= 0 then return end

  -- Integer check (prevent float exploits)
  if amount ~= math.floor(amount) then return end

  -- Existence check
  if not GetPlayerName(targetId) then return end

  -- Now safe to proceed with validated data
end)
```

**Validate:**

- **Type** — `type(value) == 'number'` / `'string'` / `'table'`
- **Range** — minimum and maximum bounds for numbers
- **Integer** — `value == math.floor(value)` when decimals shouldn't be allowed
- **Length** — `#str <= maxLength` for strings to prevent memory abuse
- **Existence** — verify referenced players/entities actually exist
- **Format** — pattern match strings when expecting specific formats

## Rate Limiting

Every network event that triggers expensive work needs a cooldown:

```lua
local cooldowns = {}
local COOLDOWN = 3000 -- milliseconds

RegisterNetEvent('myresource:expensiveAction', function(data)
  local source = source
  local now = GetGameTimer()

  -- Check cooldown
  if cooldowns[source] and (now - cooldowns[source]) < COOLDOWN then
    return -- silently reject, don't tell client why
  end
  cooldowns[source] = now

  -- Proceed with the expensive work
end)

-- ALWAYS clean up per-player state on disconnect
AddEventHandler('playerDropped', function()
  local source = source
  cooldowns[source] = nil
end)
```

**Rules:**

- Every event that does database writes, item transfers, or economy operations needs a cooldown
- Clean up per-player state (cooldowns, caches, temp data) in `playerDropped`
- Don't tell the client WHY they were rate-limited — just silently return
- Use `GetGameTimer()` for millisecond-precision cooldowns
- Typical cooldowns: 1-3 seconds for actions, 5-10 seconds for economy operations

## Server-Side Economy

**NEVER trust the client for money, items, or economy state:**

```lua
-- CORRECT: server validates and processes everything
RegisterNetEvent('myresource:buyItem', function(itemName, quantity)
  local source = source

  -- Validate inputs
  if type(itemName) ~= 'string' or type(quantity) ~= 'number' then return end
  if quantity <= 0 or quantity > 100 then return end
  if quantity ~= math.floor(quantity) then return end

  -- Server looks up the price (NEVER accept price from client)
  local itemConfig = Config.Items[itemName]
  if not itemConfig then return end
  local totalCost = itemConfig.price * quantity

  -- Server checks if player can afford it
  local player = exports.ox_core:GetPlayer(source)
  if not player then return end

  -- Money lives in the ox_core ACCOUNTS system, never in player metadata.
  local account = exports.ox_core:GetCharacterAccount(player.charId)
  if not account or account.balance < totalCost then
    -- Notify insufficient funds
    return
  end

  -- Server checks if player can carry the items
  if not exports.ox_inventory:CanCarryItem(source, itemName, quantity) then
    return
  end

  -- Server performs the transaction (removeBalance guards against overdraw)
  exports.ox_core:CallAccount(account.accountId, 'removeBalance', { amount = totalCost, message = 'Purchase' })
  exports.ox_inventory:AddItem(source, itemName, quantity)
end)

-- WRONG: client sends the price
RegisterNetEvent('myresource:buyItem', function(itemName, quantity, price)
  -- price is CLIENT-SUPPLIED — exploiter sends price = 0
end)
```

**Rules:**

- Server looks up prices, not the client
- Verify the player HAS the money/items BEFORE deducting
- Check inventory capacity before adding items
- Perform deductions and additions as close together as possible (pseudo-atomic)
- Log economy transactions for audit trails

## ACE Permissions

Use ACE (Access Control Entry) for admin/restricted commands:

```lua
-- Using ox_lib (preferred)
lib.addCommand('admintp', {
  help = 'Teleport to a player',
  params = {
    { name = 'id', type = 'playerId', help = 'Target player ID' }
  },
  restricted = 'group.admin'  -- Only players with group.admin ACE
}, function(source, args, raw)
  -- args.id is already validated as a valid player ID
  local targetPed = GetPlayerPed(args.id)
  if not targetPed or not DoesEntityExist(targetPed) then return end
  -- teleport logic
end)

-- Using RegisterCommand (when ox_lib unavailable)
RegisterCommand('admintp', function(source, args, rawCommand)
  if source == 0 then return end  -- reject console

  -- Manual ACE check
  if not IsPlayerAceAllowed(source, 'myresource.admin') then
    -- silently reject or notify
    return
  end

  -- validate args manually
  local targetId = tonumber(args[1])
  if not targetId or not GetPlayerName(targetId) then return end
  -- teleport logic
end, false)  -- false = command is available to all, ACE checked in handler
```

**ACE patterns:**

- `IsPlayerAceAllowed(source, 'permission.name')` — check if a player has a specific permission
- `restricted = 'group.admin'` in ox_lib commands — automatic ACE restriction
- Always check `source ~= 0` to handle console invocations
- Define granular permissions (`myresource.use`, `myresource.admin`, `myresource.manage`) not just admin/not-admin

## Error Handling with pcall

Wrap external calls that may fail:

```lua
-- pcall for any call that could throw (exports, framework functions)
local ok, player = pcall(function()
  return exports.ox_core:GetPlayer(source)
end)

if not ok or not player then
  print('[myresource] ERROR: could not get player for source ' .. tostring(source))
  return
end

-- Safe to use player now
```

**When to pcall:**

- Any `exports.*` call (the target resource might not be running)
- Framework player object access (player might have disconnected mid-operation)
- Database calls that might fail
- Any external API that could throw

## Export Security

Validate callers when exposing exports:

```lua
-- Check which resource is calling your export
exports('getPlayerData', function(source)
  local invoker = GetInvokingResource()

  -- Optional: restrict to specific resources
  local allowed = { ['ox_core'] = true, ['ox_inventory'] = true }
  if invoker and not allowed[invoker] then
    print('[myresource] Unauthorized export call from: ' .. tostring(invoker))
    return nil
  end

  -- Validate source
  if not source or source <= 0 then return nil end

  return getPlayerData(source)
end)
```

`GetInvokingResource()` returns the name of the resource that called the export, or `nil` if called internally.

## Anti-Exploit Patterns

### Never expose internal state to clients

```lua
-- WRONG: sending server-side config to client
TriggerClientEvent('myresource:sendConfig', source, {
  prices = Config.Prices,       -- exploiter now knows all prices
  adminList = Config.Admins,    -- exploiter knows who admins are
  secretKey = Config.APIKey     -- catastrophic data leak
})

-- CORRECT: only send what the client needs to display
TriggerClientEvent('myresource:openShop', source, {
  items = getVisibleShopItems(source)  -- filtered, display-only data
})
```

### Validate entity ownership

```lua
RegisterNetEvent('myresource:modifyVehicle', function(netId, modification)
  local source = source
  local entity = NetworkGetEntityFromNetworkId(netId)

  -- Verify entity exists
  if not DoesEntityExist(entity) then return end

  -- Verify the player owns/is near this entity
  local playerPed = GetPlayerPed(source)
  local playerCoords = GetEntityCoords(playerPed)
  local entityCoords = GetEntityCoords(entity)

  if #(playerCoords - entityCoords) > 10.0 then
    -- Player is too far from the entity — likely an exploit
    print('[myresource] Suspicious: player ' .. source .. ' modifying distant entity')
    return
  end
end)
```

### Prevent event spam detection

```lua
local eventCounts = {}
local EVENT_THRESHOLD = 20  -- max events per window
local EVENT_WINDOW = 10000  -- 10 second window

local function checkEventSpam(source)
  local now = GetGameTimer()

  if not eventCounts[source] then
    eventCounts[source] = { count = 1, start = now }
    return false
  end

  local data = eventCounts[source]

  if (now - data.start) > EVENT_WINDOW then
    -- Reset window
    data.count = 1
    data.start = now
    return false
  end

  data.count = data.count + 1

  if data.count > EVENT_THRESHOLD then
    print('[myresource] Event spam detected from source: ' .. source)
    return true  -- is spamming
  end

  return false
end

AddEventHandler('playerDropped', function()
  eventCounts[source] = nil
end)
```

## Common Vulnerabilities in FiveM Resources

| Vulnerability                               | How it's exploited                   | Prevention                                |
| :------------------------------------------ | :----------------------------------- | :---------------------------------------- |
| Client-sent source ID                       | Exploiter sends another player's ID  | Always use implicit `source`              |
| Client-sent prices/amounts                  | Exploiter sends price = 0            | Server looks up all values                |
| Missing rate limiting                       | Exploiter spams events 1000x/sec     | Cooldowns on all events                   |
| Trusting client coordinates                 | Exploiter teleports via events       | Server validates positions                |
| Exposed server config                       | Exploiter reads prices/admin list    | Only send display data to clients         |
| Missing type validation                     | Exploiter sends wrong types to crash | `type()` check all arguments              |
| No pcall on exports                         | Missing resource crashes handler     | Wrap external calls in pcall              |
| RegisterNetEvent without handler validation | Any client can trigger any net event | Validate source + inputs in every handler |

## Security Checklist

Before marking a resource as complete:

- [ ] Every `RegisterNetEvent` handler validates `source` (implicit, not client-sent)
- [ ] Every handler validates argument types and ranges
- [ ] Economy operations are fully server-side (server looks up prices)
- [ ] Rate limiting on all events that do database/economy work
- [ ] `playerDropped` cleans up all per-player state
- [ ] Admin commands use ACE permissions
- [ ] No server config/secrets sent to clients
- [ ] External export calls wrapped in `pcall`
- [ ] Entity operations check `DoesEntityExist` first
- [ ] No `Wait(0)` in server-side loops (DoS vector)

## Reference

- https://docs.fivem.net/docs/scripting-manual/security/
