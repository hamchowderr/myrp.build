---
name: fxmanifest
description: "fxmanifest.lua template and rules — resource manifest format, required fields, script declarations, dependency management. Use when creating or modifying a FiveM resource's fxmanifest.lua file."
---

# fxmanifest.lua — Resource Manifest

Every FiveM resource requires a `fxmanifest.lua` at its root. This file declares metadata, scripts, dependencies, and assets.

## Complete Template

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

-- Resource metadata
author 'FiveM Studio'
description 'Resource description here'
version '1.0.0'

-- Shared scripts (loaded on BOTH client and server)
-- ox_lib init MUST come before your own shared scripts
shared_scripts {
  '@ox_lib/init.lua',
  'shared/*.lua'
}

-- Server scripts
-- oxmysql lib MUST come before your own server scripts
server_scripts {
  '@oxmysql/lib/MySQL.lua',
  'server/*.lua'
}

-- Client scripts
client_scripts {
  'client/*.lua'
}

-- NUI files (HTML/CSS/JS assets accessible to the NUI browser)
files {
  'html/index.html',
  'html/style.css',
  'html/app.js'
}

-- NUI entry point
ui_page 'html/index.html'

-- Dependencies (only resources you actually use)
dependencies {
  'ox_lib',
  'ox_core',
  'oxmysql'
}

-- Data files (for item metadata, shared configs, etc.)
data_file 'DLC_ITYP_REQUEST' 'stream/*.ytyp'
```

## Required Fields

These three fields are mandatory in every fxmanifest.lua:

```lua
fx_version 'cerulean'   -- Always 'cerulean' (current manifest version)
game 'gta5'             -- Always 'gta5' for FiveM
lua54 'yes'             -- Always included — enables Lua 5.4, required for ox_lib 3.x
```

Never omit `lua54 'yes'` — it enables Lua 5.4 features (integers, bitwise operators, utf8 library) and is required by ox_lib 3.x and newer libraries.

## Script Declarations

### Ordering Rules

Script load order within each block follows declaration order. External library scripts MUST come before your own:

```lua
-- CORRECT: ox_lib init loaded first, then your shared code
shared_scripts {
  '@ox_lib/init.lua',    -- 1st: makes lib.* globals available
  'shared/config.lua',   -- 2nd: your config (can use lib.*)
  'shared/utils.lua'     -- 3rd: your utilities
}

-- CORRECT: oxmysql loaded first, then your server code
server_scripts {
  '@oxmysql/lib/MySQL.lua',  -- 1st: makes MySQL.* globals available
  'server/main.lua',         -- 2nd: your server code (can use MySQL.*)
  'server/commands.lua'      -- 3rd: additional server scripts
}
```

### Script Types

| Declaration      | Runs on         | Use for                                     |
| :--------------- | :-------------- | :------------------------------------------ |
| `shared_scripts` | Client + Server | Config files, shared utilities, ox_lib init |
| `client_scripts` | Client only     | Game interaction, NUI control, rendering    |
| `server_scripts` | Server only     | Database, economy, authoritative logic      |

### Glob Patterns

```lua
-- Single file
client_scripts { 'client/main.lua' }

-- All .lua files in a directory
client_scripts { 'client/*.lua' }

-- Recursive (all subdirectories)
client_scripts { 'client/**/*.lua' }
```

**Important:** Declare EVERY script file used. Missing declarations cause silent load failures — the script simply never runs, with no error message.

## NUI Declarations

For resources with HTML/CSS/JS interfaces:

```lua
-- List ALL files the NUI browser needs access to
files {
  'html/index.html',
  'html/style.css',
  'html/app.js',
  'html/images/*.png',     -- glob works for files too
  'html/fonts/*.woff2'
}

-- Entry point for the NUI browser
ui_page 'html/index.html'
```

- `files` makes assets available to the NUI CEF browser
- `ui_page` sets which HTML file loads as the NUI page
- Any file not listed in `files` will 404 when the NUI tries to load it
- `ui_page` requires a specific file path, not a glob

## Dependencies

```lua
dependencies {
  'ox_lib',       -- Only if you use lib.* functions
  'ox_core',      -- Only if you use ox_core exports
  'oxmysql',      -- Only if you use MySQL.* functions
  'ox_inventory', -- Only if you use ox_inventory exports
  'ox_target'     -- Only if you use ox_target exports
}
```

**Rules:**

- Only declare dependencies you actually import/use
- Extra dependencies cause startup warnings and slow resource loading
- If a declared dependency isn't running, the resource will fail to start
- The `@resource/file.lua` syntax in script blocks already implies a dependency, but explicit declaration is still recommended

## Data Files

For streaming assets and item metadata:

```lua
-- Streaming assets (map objects, vehicles, etc.)
data_file 'DLC_ITYP_REQUEST' 'stream/*.ytyp'

-- Item metadata for ox_inventory
files {
  'data/items.lua'
}
```

## Resource Metadata

```lua
author 'Your Name'
description 'What this resource does'
version '1.0.0'
```

These are optional but recommended. They appear in the server console on resource start and in management tools.

## Common Patterns

### Minimal resource (no NUI, no database)

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveM Studio'
description 'Simple resource'
version '1.0.0'

shared_scripts {
  '@ox_lib/init.lua'
}

client_scripts {
  'client/*.lua'
}

server_scripts {
  'server/*.lua'
}

dependencies {
  'ox_lib'
}
```

### Full resource (NUI + database + framework)

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveM Studio'
description 'Full-featured resource'
version '1.0.0'

shared_scripts {
  '@ox_lib/init.lua',
  'shared/config.lua'
}

server_scripts {
  '@oxmysql/lib/MySQL.lua',
  'server/*.lua'
}

client_scripts {
  'client/*.lua'
}

files {
  'html/index.html',
  'html/style.css',
  'html/app.js'
}

ui_page 'html/index.html'

dependencies {
  'ox_lib',
  'ox_core',
  'oxmysql',
  'ox_inventory'
}
```

### Client-only resource (HUD, visual effects)

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'FiveM Studio'
description 'Client-only HUD'
version '1.0.0'

client_scripts {
  'client/*.lua'
}

files {
  'html/index.html',
  'html/style.css',
  'html/app.js'
}

ui_page 'html/index.html'
```

## Common Mistakes

- **Missing `lua54 'yes'`** — breaks ox_lib 3.x and loses Lua 5.4 features
- **Wrong script order** — your scripts load before ox_lib/oxmysql, globals are nil
- **Undeclared scripts** — script file exists but isn't in fxmanifest, never executes (silent failure)
- **Undeclared NUI files** — CSS/JS/images 404 in the NUI browser
- **Unnecessary dependencies** — resource fails to start if the dependency isn't running
- **Using `resource_manifest_version`** — obsolete; always use `fx_version 'cerulean'`
- **Missing `game 'gta5'`** — resource won't load

## Reference

- https://docs.fivem.net/docs/scripting-reference/resource-manifest/resource-manifest/
