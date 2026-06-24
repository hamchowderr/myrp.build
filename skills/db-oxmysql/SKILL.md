---
name: db-oxmysql
description: "oxmysql query patterns and syntax — the modern MySQL/MariaDB driver for FiveM. Use when generating resources that need database access on servers running oxmysql."
---

# oxmysql — Modern MySQL/MariaDB Driver for FiveM

oxmysql is the modern, actively maintained MySQL/MariaDB driver for FiveM. It is the database driver for the **ox_overextended** stack (ox_core, ox_inventory, ox_banking). It provides both synchronous (.await) and asynchronous (callback) query APIs.

## ox_core schema — the ONLY schema this product uses

> **This is an ox_overextended-ONLY product. The database is ox_core's.**
> The generic table names in the syntax examples further down (`players`, `items`, …) illustrate API
> *shape* only. For real queries, use ox_core's actual schema:
>
> - **Characters** — `characters(charId, stateId, userId, firstName, lastName, …)`. The player key is
>   the integer **`charId`** — never a license string or any other string id.
> - **Money / bank** — ox_core ACCOUNTS, table **`accounts(id, label, owner, group, balance, isDefault, type)`**:
>   - `owner` = the character's **`charId`** for personal accounts (NULL for group/society accounts)
>   - `balance` = the bank balance — **there is NO `bank` column**
>   - `isDefault` = 1 for the character's default personal account
>   - Raw read: `MySQL.scalar.await('SELECT balance FROM accounts WHERE owner = ? AND isDefault = 1', { charId })`
>   - **PREFER the exports API** — `exports.ox_core:GetPlayer(src):getAccount('bank').balance` — over raw SQL (see the `ox-banking` / `fw-ox-core` skills).
>
> ### FORBIDDEN — never generate these (they are not ox_core's schema)
> - `SELECT bank FROM accounts WHERE identifier = …` — WRONG: ox_core's `accounts` has no `bank` or `identifier` column.
> - A `users` table, an `identifier`/string-key column, `accounts.bank`, or `money`/`black_money` JSON columns.
> - A `players` table or `players.money` — ox_core stores characters in `characters` and money in `accounts`.
> - Never emit a stub like `-- adjust the query to match your actual schema` — the schema IS ox_core's `accounts` above.

## fxmanifest.lua Setup

```lua
server_scripts {
  '@oxmysql/lib/MySQL.lua',  -- MUST be listed before your own server scripts
  'server/*.lua'
}

dependencies {
  'oxmysql'
}
```

## Query API — Synchronous (.await) Variants (Preferred)

The `.await` variants block the current coroutine (not the entire server thread) until the query completes. These are the preferred style for clean, readable control flow.

```lua
-- Fetch all matching rows (returns table of rows)
local rows = MySQL.query.await('SELECT * FROM characters WHERE userId = ?', { userId })

-- Fetch exactly one row (returns single row table or nil)
local char = MySQL.single.await('SELECT * FROM characters WHERE charId = ? LIMIT 1', { charId })

-- Fetch a single scalar value (returns the value directly) — ox_core bank balance
local balance = MySQL.scalar.await('SELECT balance FROM accounts WHERE owner = ? AND isDefault = 1', { charId })

-- Insert a row (returns the auto-increment insertId)
local id = MySQL.insert.await('INSERT INTO items (name, count) VALUES (?, ?)', { name, count })

-- Update/delete rows (returns number of affected rows)
local affected = MySQL.update.await('UPDATE accounts SET balance = ? WHERE owner = ? AND isDefault = 1', { balance, charId })

-- Prepared statement (returns rows, cached query plan for repeated use)
local rows = MySQL.prepare.await('SELECT * FROM characters WHERE charId = ?', { charId })
```

## Query API — Asynchronous (Callback) Variants

Use callbacks when you do not need to wait for the result inline.

```lua
MySQL.query('SELECT * FROM characters WHERE userId = ?', { userId }, function(result)
  -- result is a table of rows
end)

MySQL.single('SELECT * FROM characters WHERE charId = ?', { charId }, function(row)
  -- row is a single table or nil
end)

MySQL.scalar('SELECT balance FROM accounts WHERE owner = ? AND isDefault = 1', { charId }, function(value)
  -- value is the scalar result
end)

MySQL.insert('INSERT INTO items (name, count) VALUES (?, ?)', { name, count }, function(insertId)
  -- insertId is the auto-increment ID
end)

MySQL.update('UPDATE accounts SET balance = ? WHERE owner = ? AND isDefault = 1', { balance, charId }, function(affectedRows)
  -- affectedRows is the number of changed rows
end)
```

## Parameter Binding

oxmysql supports two parameter binding styles:

### Positional Parameters (? placeholders) — Preferred

Parameters are passed as an indexed table. Values are substituted in order.

```lua
MySQL.query.await('SELECT * FROM vehicles WHERE owner = ? AND garage = ?', { charId, garageName })
```

### Named Parameters (@param placeholders)

Parameters are passed as a keyed table with `@` prefixed keys.

```lua
MySQL.query.await('SELECT * FROM vehicles WHERE owner = @owner AND garage = @garage', {
  ['@owner'] = charId,
  ['@garage'] = garageName
})
```

Positional `?` with indexed tables is the oxmysql convention. Use named parameters only when query readability benefits from it (many parameters, repeated values).

## Transactions

Wrap multiple queries in a transaction for atomicity. If any query fails, all changes are rolled back.

```lua
local success = MySQL.transaction.await({
  {
    query = 'UPDATE accounts SET balance = balance - ? WHERE owner = ? AND isDefault = 1',
    values = { amount, senderCharId }
  },
  {
    query = 'UPDATE accounts SET balance = balance + ? WHERE owner = ? AND isDefault = 1',
    values = { amount, receiverCharId }
  },
  {
    query = 'INSERT INTO transaction_log (sender, receiver, amount) VALUES (?, ?, ?)',
    values = { senderCharId, receiverCharId, amount }
  }
})

if not success then
  print('[resource] Transaction failed — rolled back')
end
```

## Common Mistakes

### Mixing mysql-async syntax with oxmysql

```lua
-- WRONG: mysql-async API does not exist in oxmysql
MySQL.Async.fetchAll('SELECT ...', { ['@id'] = id }, function(result) end)
MySQL.Sync.fetchScalar('SELECT ...', { ['@id'] = id })

-- CORRECT: oxmysql API
MySQL.query.await('SELECT ...', { id })
MySQL.scalar.await('SELECT ...', { id })
```

### String concatenation instead of parameterized queries

```lua
-- WRONG: SQL injection vulnerability
MySQL.query.await('SELECT * FROM characters WHERE firstName = "' .. playerName .. '"')

-- CORRECT: parameterized
MySQL.query.await('SELECT * FROM characters WHERE firstName = ?', { playerName })
```

### Forgetting .await on synchronous calls

```lua
-- WRONG: returns a promise-like object, not the result
local rows = MySQL.query('SELECT * FROM characters')
print(rows[1].firstName) -- ERROR: rows is not a table of results

-- CORRECT: use .await for synchronous result
local rows = MySQL.query.await('SELECT * FROM characters')
print(rows[1].firstName) -- works
```

### Using MySQL.query when MySQL.single or MySQL.scalar is appropriate

```lua
-- WRONG: fetches all rows when you only need one
local rows = MySQL.query.await('SELECT * FROM characters WHERE charId = ?', { charId })
local char = rows[1]

-- CORRECT: use MySQL.single for single-row lookups
local char = MySQL.single.await('SELECT * FROM characters WHERE charId = ?', { charId })
```

## Rules

- Always use parameterized queries — NEVER concatenate user input into SQL strings
- Prefer `.await` variants for cleaner control flow
- Use `MySQL.single.await` when expecting exactly one row
- Use `MySQL.scalar.await` when expecting a single value
- Use `MySQL.transaction.await` for multi-query atomicity
- Table creation: always use `IF NOT EXISTS`
- oxmysql handles connection pooling internally — do not manage connections manually
- **ox_core schema ONLY**: the player key is the integer `charId` (never a string id); bank money is `accounts.balance` keyed by `owner = charId` (there is NO `accounts.bank` column). Prefer the ox_core/ox-banking exports over raw `accounts` SQL.
- NEVER generate a non-ox schema (`accounts.bank`, an `identifier`/string-key column, a `users` or `players` table, `players.money`), and never leave a "-- adjust to your schema" stub.
