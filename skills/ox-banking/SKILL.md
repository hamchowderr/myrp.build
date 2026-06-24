---
name: ox-banking
description: "ox_banking + ox_core account patterns — money is the ox_core ACCOUNT system, not player metadata. Bank/ATM UI via ox_banking, balance operations via ox_core accounts. Use when generating banking, ATM, salary, society/job funds, or any money-handling resource."
---

# ox_banking & ox_core Accounts

`ox_banking` is the **UI layer** (bank + ATM menus). The actual money model lives
in **ox_core's account system** — the `accounts`, `accounts_access`,
`accounts_transactions`, `accounts_invoices` tables. Do NOT invent a `money`
column or store balances in player metadata; use accounts.

The `accounts` columns are: **`id, label, owner, group, balance, isDefault, type`**.
`owner` = the character's **`charId`** (personal accounts); `group` = group name
(society/job accounts); **`balance`** = the money; `isDefault` = 1 for the default
personal account. **PREFER the exports API** to read/modify a balance —
`exports.ox_core:GetPlayer(src):getAccount('bank').balance`. Only fall back to raw
SQL as `SELECT balance FROM accounts WHERE owner = ? AND isDefault = 1`.

> **NEVER** write the form "SELECT bank FROM accounts WHERE identifier = …"
> — ox_core's `accounts` has no `bank` column and no `identifier` column; that schema is wrong.
> Likewise never use a `players.money` column or a string player key.

## ox_banking — opening the UI (client)

```lua
exports.ox_banking:openBank()  -- full bank menu
exports.ox_banking:openAtm({ entity = atmEntity })  -- ATM menu (atmEntity = the ATM object handle)
```

These are CLIENT exports. Trigger them client-side (e.g. from an ox_target
interaction on a bank ped or ATM prop). ox_banking renders the menu and performs
its transactions through ox_core accounts internally — for standard banking you
often only need `openBank`/`openAtm`. Write custom server logic only for
non-standard flows (salaries, fines, society payouts).

## ox_core accounts — the money API (server)

Every character has a default personal account; groups (jobs/gangs) can have a
society account. Fetch an account, then operate on it.

```lua
-- Get accounts (server)
local account  = exports.ox_core:GetCharacterAccount(charId)   -- player's default account
local society  = exports.ox_core:GetGroupAccount('police')     -- group/society account
local newId    = exports.ox_core:CreateAccount(ownerCharId, 'Savings')
```

Account objects live inside ox_core, so call their methods across the resource
boundary with `CallAccount(accountId, method, args)`:

```lua
-- Add / remove / transfer (all SERVER-side, all amounts validated by ox_core)
exports.ox_core:CallAccount(accountId, 'addBalance',    { amount = 500,  message = 'Paycheck' })
exports.ox_core:CallAccount(accountId, 'removeBalance', { amount = 200,  message = 'Fine', overdraw = false })
exports.ox_core:CallAccount(accountId, 'transferBalance', {
    toId = targetAccountId, amount = 1000, message = 'Transfer', note = 'rent', actorId = charId,
})
-- Physical cash <-> account (moves the ox_inventory 'money' item):
exports.ox_core:CallAccount(accountId, 'depositMoney',  playerId, 300)
exports.ox_core:CallAccount(accountId, 'withdrawMoney', playerId, 300)
```

Method shapes (from ox_core): `addBalance({ amount, message })`,
`removeBalance({ amount, overdraw?, message })`,
`transferBalance({ toId, amount, overdraw?, message, note?, actorId? })`,
`depositMoney(playerId, amount, message?, note?)`,
`withdrawMoney(playerId, amount, message?, note?)`.

`removeBalance` returns a failure result when funds are insufficient (unless
`overdraw = true`) — always check the result before granting whatever the money
was paying for.

## Cash vs bank

- **Bank balance** = an ox_core account (above).
- **Cash** = the `money` item in **ox_inventory**:
  `exports.ox_inventory:GetItemCount(source, 'money')`,
  `AddItem(source, 'money', n)`, `RemoveItem(source, 'money', n)`.
- `depositMoney`/`withdrawMoney` move between the two.

## Canonical pattern — custom ATM action

```lua
-- client: open the stock ATM on a prop via ox_target
exports.ox_target:addModel({ `prop_atm_01`, `prop_atm_02`, `prop_atm_03` }, {
    { name = 'use_atm', icon = 'fa-solid fa-money-bill', label = 'Use ATM',
      onSelect = function(data) exports.ox_banking:openAtm({ entity = data.entity }) end },
})

-- server: a CUSTOM action (e.g. pay a bill) — validate everything server-side
lib.callback.register('myatm:payBill', function(source, amount)
    local player  = exports.ox_core:GetPlayer(source)
    if not player then return false end
    local account = exports.ox_core:GetCharacterAccount(player.charId)
    local ok = exports.ox_core:CallAccount(account.id, 'removeBalance', { amount = amount, message = 'Bill' })
    return ok and ok.success ~= false
end)
```

## Rules

- Money operations are **server-authoritative** — never let the client decide a
  balance change. The client opens the UI / requests an action; the server reads
  the account and applies the change.
- Prefer the stock `openBank`/`openAtm` UI; only add server callbacks for logic
  ox_banking doesn't already cover.
- fxmanifest: `dependencies { 'ox_lib', 'ox_core', 'oxmysql' }` (add `ox_banking`
  if you call its exports, `ox_inventory` if you touch cash).
```
