---
name: business
description: "Player-owned business resource recipe for ox_overextended — oxmysql ownership + ledger tables, ox_core player/group for owners and employees, an ox_target zone at the storefront, an ox_lib management menu (deposit/withdraw/stock/hire), and an ox_inventory business stash. Use when generating an ownable shop/company/business resource with money and staff."
---

# Business Resource Patterns

A "business" is a player-ownable company with a bank balance (ledger), a roster of employees and co-owners, a physical management point in the world, and a shared stash for stock. This recipe is the most economy-sensitive of the ox recipes, so the guiding rule is absolute: **every money movement and every ownership/permission check happens server-side, validated against the database.** The client only renders menus and sends intent.

## Overview

Six ox primitives compose the recipe:

1. **oxmysql ownership + ledger** — two custom tables, `businesses` (who owns what, balance) and `business_accounts` (an append-only ledger of every transaction). The balance lives on `businesses` for fast reads; the ledger is the audit trail. All mutations go through `MySQL.transaction.await` so balance and ledger never drift.
2. **ox_core player** — `Ox.GetPlayer(source)` gives the acting player's `charId`, used to resolve ownership and employment.
3. **ox_core group** — each business maps to an ox_core group (e.g. `bean_machine`). Employees and co-owners are members at different grades; `player.getGroup(name)` returns their grade, which drives permissions (cashier vs. manager vs. owner).
4. **ox_target zone** — a box/sphere zone at the storefront opens the management menu.
5. **ox_lib menu** — `lib.registerContext` / `lib.showContext` builds the deposit / withdraw / stock / hire menu; `lib.inputDialog` collects amounts and target ids.
6. **ox_inventory stash** — a group-gated `RegisterStash` holds business stock (see the `drug-stash` skill for the full stash pattern — the mechanism is identical).

Server-authoritative flow: the client opens the menu and sends an intent (e.g. "withdraw 500") through `lib.callback`. The server re-derives the player's permission from their ox_core group, validates the amount, runs a DB transaction, and returns the new balance. The client never sends the balance or the price.

Use lore-friendly business names (the `lore` skill): "Bean Machine" (coffee), "Burger Shot", "Up-n-Atom", "Ammu-Nation".

## Core Patterns

### Schema — businesses + ledger (oxmysql)

Two tables. `businesses` is the source of truth for ownership and current balance; `business_accounts` is the immutable ledger. Always `IF NOT EXISTS`, always InnoDB/utf8mb4 (see `db-mariadb`).

```sql
CREATE TABLE IF NOT EXISTS `businesses` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(64) NOT NULL,          -- display name, e.g. 'Bean Machine'
  `group_name` VARCHAR(32) NOT NULL,          -- ox_core group, e.g. 'bean_machine'
  `owner_cid`  INT UNSIGNED NOT NULL,         -- ox_core charId of the owner
  `balance`    BIGINT NOT NULL DEFAULT 0,     -- cents to avoid float drift
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_group_name` (`group_name`),
  KEY `idx_owner_cid` (`owner_cid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `business_accounts` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `business_id` INT UNSIGNED NOT NULL,
  `actor_cid`   INT UNSIGNED NULL,            -- who performed it (nullable for system entries)
  `type`        ENUM('deposit','withdraw','sale','payroll','adjustment') NOT NULL,
  `amount`      BIGINT NOT NULL,              -- signed cents (+credit / -debit)
  `balance_after` BIGINT NOT NULL,            -- snapshot for audit
  `note`        VARCHAR(128) NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_business_id` (`business_id`),
  CONSTRAINT `fk_ledger_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Store money as integer **cents** (`BIGINT`), never `FLOAT`/`DECIMAL` in hot paths — this eliminates rounding exploits and float drift. Convert to dollars only for display.

### Resolving ownership and permission (server)

Permission is derived from the ox_core group grade, then cross-checked against the DB for ownership-only actions. Never trust a role the client claims.

```lua
-- server/business.lua
local GRADE = { EMPLOYEE = 1, MANAGER = 2, OWNER = 3 }

local function getBusinessByGroup(groupName)
    return MySQL.single.await('SELECT * FROM businesses WHERE group_name = ?', { groupName })
end

-- Returns the acting player's grade in the business group, or nil.
local function getActorGrade(source, groupName)
    local player = Ox.GetPlayer(source)
    if not player then return nil end
    return player.getGroup(groupName) -- number grade or nil (verified ox_core API)
end

local function canManageMoney(grade)
    return grade and grade >= GRADE.MANAGER
end

local function isOwner(source, business)
    local player = Ox.GetPlayer(source)
    if not player then return false end
    return player.charId == business.owner_cid
end
```

### Money movement — atomic transaction (server)

Deposit and withdraw both mutate `businesses.balance` and append to `business_accounts` in a single `MySQL.transaction.await`, so they are atomic. For a deposit, the player's personal money is taken via ox_inventory (money item) or ox_core account first; for a withdraw, it is given back. The server validates the amount and the balance — the client supplies only the requested amount.

```lua
local MAX_TXN = 10000000 -- $100,000 cap per action (in cents), tune to taste

lib.callback.register('business:withdraw', function(source, groupName, dollars)
    -- Input validation (see security skill)
    if type(dollars) ~= 'number' then return false end
    local cents = math.floor(dollars * 100)
    if cents <= 0 or cents > MAX_TXN then return false end

    local business = getBusinessByGroup(groupName)
    if not business then return false end

    -- Permission: managers+ may withdraw
    local grade = getActorGrade(source, groupName)
    if not canManageMoney(grade) then return false end

    -- Server checks funds, NEVER the client
    if business.balance < cents then
        lib.notify(source, { type = 'error', description = 'Insufficient business funds.' })
        return false
    end

    local player = Ox.GetPlayer(source)
    if not player then return false end

    local newBalance = business.balance - cents
    local ok = MySQL.transaction.await({
        {
            query = 'UPDATE businesses SET balance = balance - ? WHERE id = ? AND balance >= ?',
            values = { cents, business.id, cents }, -- balance >= ? guards against a race
        },
        {
            query = [[INSERT INTO business_accounts
                        (business_id, actor_cid, type, amount, balance_after, note)
                      VALUES (?, ?, 'withdraw', ?, ?, ?)]],
            values = { business.id, player.charId, -cents, newBalance, 'manual withdraw' },
        },
    })

    if not ok then return false end

    -- Hand the cash to the player AFTER the ledger commits.
    exports.ox_inventory:AddItem(source, 'money', cents // 100)
    lib.notify(source, { type = 'success', description = ('Withdrew $%s'):format(cents // 100) })
    return newBalance
end)
```

Deposit is the mirror image — verify and remove the player's money _first_, then credit the business in the same transaction:

```lua
lib.callback.register('business:deposit', function(source, groupName, dollars)
    if type(dollars) ~= 'number' then return false end
    local cents = math.floor(dollars * 100)
    if cents <= 0 or cents > MAX_TXN then return false end

    local business = getBusinessByGroup(groupName)
    if not business then return false end

    local grade = getActorGrade(source, groupName)
    if not grade or grade < GRADE.EMPLOYEE then return false end

    -- Verify the player HAS the money before crediting the business.
    local whole = cents // 100
    local held = exports.ox_inventory:GetItemCount(source, 'money')
    if not held or held < whole then
        lib.notify(source, { type = 'error', description = 'You do not have that much cash.' })
        return false
    end

    if not exports.ox_inventory:RemoveItem(source, 'money', whole) then return false end

    local player = Ox.GetPlayer(source)
    local newBalance = business.balance + cents
    local ok = MySQL.transaction.await({
        {
            query = 'UPDATE businesses SET balance = balance + ? WHERE id = ?',
            values = { cents, business.id },
        },
        {
            query = [[INSERT INTO business_accounts
                        (business_id, actor_cid, type, amount, balance_after, note)
                      VALUES (?, ?, 'deposit', ?, ?, ?)]],
            values = { business.id, player and player.charId, cents, newBalance, 'manual deposit' },
        },
    })

    if not ok then
        -- Refund on failure so cash is never destroyed.
        exports.ox_inventory:AddItem(source, 'money', whole)
        return false
    end

    return newBalance
end)
```

The `balance >= ?` clause on the withdraw UPDATE is a guard against two managers withdrawing simultaneously; if the row no longer satisfies it the UPDATE affects 0 rows and the transaction can be treated as failed.

### Hiring — group membership via ox_core (server)

"Hiring" is just assigning the target player's ox_core group + grade. Only owners/managers may hire, and you cannot hire above your own grade.

```lua
lib.callback.register('business:hire', function(source, groupName, targetId, grade)
    if type(targetId) ~= 'number' or type(grade) ~= 'number' then return false end
    if grade < GRADE.EMPLOYEE or grade > GRADE.MANAGER then return false end

    local actorGrade = getActorGrade(source, groupName)
    if not actorGrade or actorGrade <= grade then return false end -- can't hire >= own grade

    local target = Ox.GetPlayer(targetId)
    if not target then return false end

    target.setGroup(groupName, grade) -- verified ox_core player method
    lib.notify(source, { type = 'success', description = 'Employee hired.' })
    lib.notify(targetId, { type = 'inform', description = 'You were hired.' })
    return true
end)
```

To fire, call `target.setGroup(groupName, 0)` — grade 0 removes the group.

### Stock — business stash (ox_inventory)

Stock is an ox_inventory stash gated by the business group. Register it on resource start exactly as in the `drug-stash` recipe:

```lua
-- server: one stash per business, group-gated
exports.ox_inventory:RegisterStash(
    'business:' .. business.group_name, -- unique id
    business.name .. ' Stock',
    50,                                  -- slots
    200000,                              -- maxWeight (grams)
    false,                               -- shared among the group
    { [business.group_name] = GRADE.EMPLOYEE }, -- employees+ can access
    vec3(box.x, box.y, box.z)            -- proximity check
)
```

Opening it from the menu is a client call: `exports.ox_inventory:openInventory('stash', 'business:' .. groupName)`. ox_inventory owns all stock persistence — do not track stock in your own tables.

### Management menu (ox_lib) + target zone (client)

The storefront target opens an `lib.registerContext` menu. Amounts are collected with `lib.inputDialog`; the actual work is a `lib.callback.await` to the server.

```lua
-- client/business.lua
local GROUP = 'bean_machine'

local function promptAmount(title)
    local input = lib.inputDialog(title, {
        { type = 'number', label = 'Amount ($)', required = true, min = 1 },
    })
    return input and input[1]
end

local function openManageMenu()
    lib.registerContext({
        id = 'business_manage',
        title = 'Bean Machine — Management',
        options = {
            {
                title = 'Deposit Cash',
                icon = 'fa-solid fa-arrow-down',
                onSelect = function()
                    local amt = promptAmount('Deposit')
                    if amt then
                        local newBalance = lib.callback.await('business:deposit', false, GROUP, amt)
                        if newBalance then
                            lib.notify({ type = 'success', description = ('New balance: $%s'):format(newBalance // 100) })
                        end
                    end
                end,
            },
            {
                title = 'Withdraw Cash',
                icon = 'fa-solid fa-arrow-up',
                onSelect = function()
                    local amt = promptAmount('Withdraw')
                    if amt then lib.callback.await('business:withdraw', false, GROUP, amt) end
                end,
            },
            {
                title = 'Open Stock',
                icon = 'fa-solid fa-boxes-stacked',
                onSelect = function()
                    exports.ox_inventory:openInventory('stash', 'business:' .. GROUP)
                end,
            },
            {
                title = 'Hire Employee',
                icon = 'fa-solid fa-user-plus',
                onSelect = function()
                    local input = lib.inputDialog('Hire', {
                        { type = 'number', label = 'Target player id', required = true },
                        { type = 'number', label = 'Grade (1 employee, 2 manager)', required = true, min = 1, max = 2 },
                    })
                    if input then lib.callback.await('business:hire', false, GROUP, input[1], input[2]) end
                end,
            },
        },
    })
    lib.showContext('business_manage')
end

CreateThread(function()
    exports.ox_target:addBoxZone({
        coords = vec3(-630.5, 233.5, 81.9),
        size = vec3(1.5, 1.5, 2.0),
        rotation = 0.0,
        debug = false,
        options = {
            {
                name = 'manage_bean_machine',
                icon = 'fa-solid fa-cash-register',
                label = 'Manage Business',
                groups = { [GROUP] = 1 }, -- employees+ see it (UX; server re-checks)
                onSelect = openManageMenu,
            },
        },
    })
end)
```

## Security

Businesses touch money, so the `security` skill rules are mandatory, not optional:

- **Server looks up everything.** Balance, prices, the player's grade, and ownership are all re-derived server-side from the DB and ox_core. The client sends only the requested amount and the action — never the balance, price, or its own role.
- **Atomic transactions.** Balance and ledger always change together inside `MySQL.transaction.await`. On any failure, refund cash you removed so currency is never created or destroyed.
- **Guard against races** with `WHERE balance >= ?` on withdrawals; a row that no longer satisfies it updates 0 rows.
- **Permission derived from group grade**, then cross-checked against `businesses.owner_cid` for owner-only actions (selling the business, deleting it). The ox_target `groups` option is UX only — re-check in every callback.
- **Validate inputs**: `type(amount) == 'number'`, positive, integer cents, capped by `MAX_TXN`. Reject `targetId` that isn't a connected player.
- **Rate-limit** deposit/withdraw/hire callbacks per the `security` cooldown pattern and clean up per-player state in `playerDropped`.
- **Money as integer cents** everywhere; float money is an exploit vector.
- **Ownership checks on hire**: an actor cannot hire at or above their own grade, preventing privilege escalation.

## Common Mistakes

- **Trusting the client for balance or price.** The client sends "withdraw 500"; it must never send "balance is 999999". Always read the balance from `businesses` server-side.
- **Float money.** Storing balance as `FLOAT`/`DECIMAL` and doing arithmetic in dollars leads to rounding drift and exploits. Use `BIGINT` cents.
- **Non-atomic money + ledger.** Updating `businesses.balance` and inserting the ledger row in two separate queries; a crash between them corrupts the audit trail. Use one `MySQL.transaction.await`.
- **Giving cash before the ledger commits.** Always commit the DB transaction first, then `AddItem` the cash. On deposit, remove cash first and refund if the transaction fails.
- **Tracking stock in your own tables.** Business stock is an ox_inventory stash — let ox_inventory persist it. Your tables are for ownership and the money ledger only.
- **Deriving permission from the client.** The menu hides options by grade for UX, but the server must re-check `player.getGroup(groupName)` in every callback.
- **Using events instead of callbacks for money.** Fire-and-forget `TriggerServerEvent` gives the client no authoritative result and is easy to spam. Use `lib.callback` so the server validates and returns the new balance.
- **Forgetting the `UNIQUE` on `group_name`.** Two business rows mapping to one ox_core group breaks permission resolution.

## Minimal Complete Example

A single ownable business ("Bean Machine") with deposit, withdraw, stock, and hire.

### fxmanifest.lua

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveM Studio'
description 'Player-owned business — ledger, employees, stock'
version '1.0.0'

shared_scripts {
    '@ox_lib/init.lua',
}

server_scripts {
    '@oxmysql/lib/MySQL.lua',
    'server/main.lua',
}

client_scripts {
    'client/main.lua',
}

dependencies {
    'ox_lib',
    'ox_core',
    'oxmysql',
    'ox_inventory',
    'ox_target',
}
```

### server/main.lua

```lua
local GRADE = { EMPLOYEE = 1, MANAGER = 2, OWNER = 3 }
local MAX_TXN = 10000000

local function getBusinessByGroup(groupName)
    return MySQL.single.await('SELECT * FROM businesses WHERE group_name = ?', { groupName })
end

local function getActorGrade(source, groupName)
    local player = Ox.GetPlayer(source)
    return player and player.getGroup(groupName)
end

AddEventHandler('onResourceStart', function(resource)
    if resource ~= GetCurrentResourceName() then return end

    MySQL.query.await([[CREATE TABLE IF NOT EXISTS `businesses` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `name` VARCHAR(64) NOT NULL,
        `group_name` VARCHAR(32) NOT NULL,
        `owner_cid` INT UNSIGNED NOT NULL,
        `balance` BIGINT NOT NULL DEFAULT 0,
        `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (`id`), UNIQUE KEY `uq_group_name` (`group_name`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])

    MySQL.query.await([[CREATE TABLE IF NOT EXISTS `business_accounts` (
        `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        `business_id` INT UNSIGNED NOT NULL,
        `actor_cid` INT UNSIGNED NULL,
        `type` ENUM('deposit','withdraw','sale','payroll','adjustment') NOT NULL,
        `amount` BIGINT NOT NULL,
        `balance_after` BIGINT NOT NULL,
        `note` VARCHAR(128) NULL,
        `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (`id`), KEY `idx_business_id` (`business_id`),
        CONSTRAINT `fk_ledger_business` FOREIGN KEY (`business_id`)
            REFERENCES `businesses`(`id`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])

    -- Register the stock stash for each business.
    local businesses = MySQL.query.await('SELECT * FROM businesses') or {}
    for i = 1, #businesses do
        local b = businesses[i]
        exports.ox_inventory:RegisterStash(
            'business:' .. b.group_name, b.name .. ' Stock',
            50, 200000, false, { [b.group_name] = GRADE.EMPLOYEE }
        )
    end
end)

lib.callback.register('business:deposit', function(source, groupName, dollars)
    if type(dollars) ~= 'number' then return false end
    local cents = math.floor(dollars * 100)
    if cents <= 0 or cents > MAX_TXN then return false end

    local business = getBusinessByGroup(groupName)
    if not business then return false end

    local grade = getActorGrade(source, groupName)
    if not grade or grade < GRADE.EMPLOYEE then return false end

    local whole = cents // 100
    local held = exports.ox_inventory:GetItemCount(source, 'money')
    if not held or held < whole then return false end
    if not exports.ox_inventory:RemoveItem(source, 'money', whole) then return false end

    local player = Ox.GetPlayer(source)
    local newBalance = business.balance + cents
    local ok = MySQL.transaction.await({
        { query = 'UPDATE businesses SET balance = balance + ? WHERE id = ?',
          values = { cents, business.id } },
        { query = [[INSERT INTO business_accounts
                      (business_id, actor_cid, type, amount, balance_after, note)
                    VALUES (?, ?, 'deposit', ?, ?, 'menu deposit')]],
          values = { business.id, player and player.charId, cents, newBalance } },
    })
    if not ok then
        exports.ox_inventory:AddItem(source, 'money', whole)
        return false
    end
    return newBalance
end)

lib.callback.register('business:withdraw', function(source, groupName, dollars)
    if type(dollars) ~= 'number' then return false end
    local cents = math.floor(dollars * 100)
    if cents <= 0 or cents > MAX_TXN then return false end

    local business = getBusinessByGroup(groupName)
    if not business then return false end

    local grade = getActorGrade(source, groupName)
    if not grade or grade < GRADE.MANAGER then return false end
    if business.balance < cents then return false end

    local player = Ox.GetPlayer(source)
    local newBalance = business.balance - cents
    local ok = MySQL.transaction.await({
        { query = 'UPDATE businesses SET balance = balance - ? WHERE id = ? AND balance >= ?',
          values = { cents, business.id, cents } },
        { query = [[INSERT INTO business_accounts
                      (business_id, actor_cid, type, amount, balance_after, note)
                    VALUES (?, ?, 'withdraw', ?, ?, 'menu withdraw')]],
          values = { business.id, player and player.charId, -cents, newBalance } },
    })
    if not ok then return false end
    exports.ox_inventory:AddItem(source, 'money', cents // 100)
    return newBalance
end)

lib.callback.register('business:hire', function(source, groupName, targetId, grade)
    if type(targetId) ~= 'number' or type(grade) ~= 'number' then return false end
    if grade < GRADE.EMPLOYEE or grade > GRADE.MANAGER then return false end

    local actorGrade = getActorGrade(source, groupName)
    if not actorGrade or actorGrade <= grade then return false end

    local target = Ox.GetPlayer(targetId)
    if not target then return false end
    target.setGroup(groupName, grade)
    return true
end)
```

### client/main.lua

```lua
local GROUP = 'bean_machine'

local function promptAmount(title)
    local input = lib.inputDialog(title, {
        { type = 'number', label = 'Amount ($)', required = true, min = 1 },
    })
    return input and input[1]
end

local function openManageMenu()
    lib.registerContext({
        id = 'business_manage',
        title = 'Bean Machine — Management',
        options = {
            {
                title = 'Deposit Cash',
                icon = 'fa-solid fa-arrow-down',
                onSelect = function()
                    local amt = promptAmount('Deposit')
                    if amt then
                        local bal = lib.callback.await('business:deposit', false, GROUP, amt)
                        if bal then lib.notify({ type = 'success', description = ('Balance: $%s'):format(bal // 100) }) end
                    end
                end,
            },
            {
                title = 'Withdraw Cash',
                icon = 'fa-solid fa-arrow-up',
                onSelect = function()
                    local amt = promptAmount('Withdraw')
                    if amt then
                        local bal = lib.callback.await('business:withdraw', false, GROUP, amt)
                        if bal then lib.notify({ type = 'success', description = ('Balance: $%s'):format(bal // 100) })
                        else lib.notify({ type = 'error', description = 'Withdrawal failed.' }) end
                    end
                end,
            },
            {
                title = 'Open Stock',
                icon = 'fa-solid fa-boxes-stacked',
                onSelect = function()
                    exports.ox_inventory:openInventory('stash', 'business:' .. GROUP)
                end,
            },
            {
                title = 'Hire Employee',
                icon = 'fa-solid fa-user-plus',
                onSelect = function()
                    local input = lib.inputDialog('Hire', {
                        { type = 'number', label = 'Target player id', required = true },
                        { type = 'number', label = 'Grade (1 employee, 2 manager)', required = true, min = 1, max = 2 },
                    })
                    if input then lib.callback.await('business:hire', false, GROUP, input[1], input[2]) end
                end,
            },
        },
    })
    lib.showContext('business_manage')
end

CreateThread(function()
    exports.ox_target:addBoxZone({
        coords = vec3(-630.5, 233.5, 81.9),
        size = vec3(1.5, 1.5, 2.0),
        rotation = 0.0,
        debug = false,
        options = {
            {
                name = 'manage_bean_machine',
                icon = 'fa-solid fa-cash-register',
                label = 'Manage Business',
                groups = { [GROUP] = 1 },
                onSelect = openManageMenu,
            },
        },
    })
end)
```

This gives an ownable business with an auditable ledger, group-based staff, a physical management point, and ox_inventory-backed stock — all money and permission decisions made server-side.

## Dependencies

| Resource       | Required | Purpose                                                                                                  |
| :------------- | :------- | :------------------------------------------------------------------------------------------------------- |
| `ox_lib`       | Always   | `lib.registerContext` / `lib.showContext` menu, `lib.inputDialog`, `lib.callback`, `lib.notify`          |
| `ox_core`      | Always   | Player object (`Ox.GetPlayer`, `charId`), group membership for owners/employees (`getGroup`, `setGroup`) |
| `oxmysql`      | Always   | `businesses` + `business_accounts` tables, atomic balance/ledger transactions                            |
| `ox_inventory` | Always   | Business stock stash (`RegisterStash`/`openInventory`), money item add/remove                            |
| `ox_target`    | Always   | Management zone at the storefront                                                                        |

Cross-references: see `fw-ox-core` for the player/group API, `db-oxmysql` for transaction/query patterns, `db-mariadb` for schema/InnoDB conventions, `drug-stash` for the full ox_inventory stash pattern reused here, `security` for the server-authoritative economy rules, and `lore` for lore-friendly business names.
