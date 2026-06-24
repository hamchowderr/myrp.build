---
name: fw-ox-core
description: "ox_core framework patterns — player objects, commands, money, callbacks, inventory, notifications, targeting. Use when generating resources for an ox_core FiveM server."
---

# ox_core Framework Patterns

You are generating code for an ox_core server. This is the modern Overextended framework ecosystem.

## API Patterns

### Player Object

- For METHOD calls, resolve via the ox_core lib wrapper so methods are callable:
  `local Ox = require '@ox_core.lib.init'` then `local player = Ox.GetPlayer(source)`.
- `player` exposes self-bound methods called with a DOT, not a colon:
  `player.set(key, value)`, `player.get(key)`, `player.setGroup(name, grade)`,
  `player.getGroup(name)`, `player.charId`. (A colon `player:set(...)` injects an
  extra `self` and corrupts the first argument.)
- The bare bridge export `exports.ox_core:GetPlayer(source)` is fine for reading
  public fields (`player.charId`) or via `exports.ox_core:CallPlayer(source, 'method', ...)`,
  but its returned object's methods are NOT directly callable — use `Ox.GetPlayer` for those.

### Commands

```lua
lib.addCommand('commandname', function(source, args, raw)
    -- command logic
end)
```

### Money & Accounts

Money is the ox_core **account system** (the `accounts*` tables), NOT a player
field or metadata. Each character has a default account; groups can have a
society account. Operate on balances server-side:

```lua
local account = exports.ox_core:GetCharacterAccount(charId)      -- personal
local society = exports.ox_core:GetGroupAccount('police')        -- job/gang funds
exports.ox_core:CallAccount(account.accountId, 'addBalance',    { amount = 100, message = 'Pay' })
exports.ox_core:CallAccount(account.accountId, 'removeBalance', { amount = 50,  message = 'Fee' })
```

Cash is the `money` item in ox_inventory. For bank/ATM UI and the full balance
API, load the **ox-banking** skill.

### Player data

- `player.setGroup(name, grade)`, `player.set(key, value)`, `player.get(key)` for
  group membership and metadata (NOT money).

### Database (oxmysql)

```lua
MySQL.query.await('SELECT * FROM table WHERE id = ?', { id })
MySQL.insert.await('INSERT INTO table (col) VALUES (?)', { value })
MySQL.update.await('UPDATE table SET col = ? WHERE id = ?', { value, id })
```

Always use `.await` variants for synchronous-style code in ox_core resources.

### Inventory (ox_inventory)

```lua
exports.ox_inventory:GetItem(source, itemName, metadata, count)
exports.ox_inventory:AddItem(source, itemName, count, metadata)
exports.ox_inventory:RemoveItem(source, itemName, count, metadata)
exports.ox_inventory:CanCarryItem(source, itemName, count)
```

### Notifications (ox_lib)

```lua
-- Server-side: there is NO server lib.notify — trigger the client net event:
TriggerClientEvent('ox_lib:notify', source, { title = '...', description = '...', type = 'info' })

-- Client-side: call lib.notify directly with a SINGLE table (no source arg):
lib.notify({ title = '...', description = '...', type = 'info' })
```

Types: `'info'`, `'success'`, `'warning'`, `'error'`

### UI Elements (ox_lib)

- `lib.inputDialog` -- multi-field input forms
- `lib.alertDialog` -- confirmation dialogs
- `lib.progressBar` -- progress bar with animation
- `lib.progressCircle` -- circular progress indicator

### Targeting (ox_target)

```lua
exports.ox_target:addModel(model, options)
exports.ox_target:addSphereZone(coords, options)
exports.ox_target:addLocalEntity(entity, options)
```

### Callbacks (ox_lib)

```lua
-- Server: register a callback (client requests trigger this)
lib.callback.register('name', function(source, ...)
    return result
end)

-- Client -> server (most common): the 2nd positional arg is `delay` (false = none)
local result = lib.callback.await('name', false, ...)
lib.callback('name', false, function(result) end, ...)

-- Server -> client: the 2nd positional arg is the target playerId
local result = lib.callback.await('name', playerId, ...)
```

## Dependencies

ox_core resources expect these to be running on the server:

| Resource       | Required | Purpose                            |
| :------------- | :------- | :--------------------------------- |
| `ox_lib`       | Always   | Utilities, UI, callbacks, commands |
| `ox_core`      | Always   | Core framework                     |
| `oxmysql`      | Always   | Database driver                    |
| `ox_inventory` | If used  | Inventory system                   |
| `ox_target`    | If used  | Targeting/interaction system       |

Always declare these in `fxmanifest.lua`:

```lua
dependencies {
    'ox_lib',
    'ox_core',
    'oxmysql',
}
```

## Common Gotchas

- **Load order matters:** `ox_lib` must be started before `ox_core` in `server.cfg`. If ox_lib is not loaded first, ox_core will fail to initialize.
- **ox_lib must be required:** Add `@ox_lib/init` to your `shared_scripts` in fxmanifest.lua so lib functions are available globally.
- **Await variants:** Always use `.await` for database calls. The non-await variants use callbacks and are easy to misuse.
- **Money lives in ACCOUNTS, not metadata:** ox_core has no `getMoney()`/`addMoney()` helpers. **BANK** money is the ox_core ACCOUNTS system — table `accounts` (`owner` = charId, `balance`) — accessed via the standalone export `exports.ox_core:GetCharacterAccount(charId)` (returns the default personal account; `.balance` for the value), then `exports.ox_core:CallAccount(account.accountId, 'addBalance'/'removeBalance', { amount = n, message = '...' })`. There is **no** `player:getAccount()` method and **no** account named `'bank'`. **CASH** is the `money` item in ox_inventory. Money is NEVER stored in player metadata, and there is NO `accounts.bank`/`identifier` schema. (Load the `ox-banking` + `db-oxmysql` skills for the real schema.)
- **Exports, not events:** ox_core uses exports for all API calls. Do not use TriggerEvent/TriggerServerEvent for framework calls.
