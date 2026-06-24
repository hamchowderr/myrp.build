---
name: ox-target
description: "ox_target third-eye targeting — add interaction options to models, entities, players, vehicles, peds, objects, and world zones (box/sphere/poly) via client exports. Covers the full add*/remove* API, the option object (name, label, icon, distance, canInteract, onSelect, event/serverEvent, groups, items, bones), and zone shapes. Use when generating any resource where the player looks at/aims at something to interact (open a shop, talk to a ped, search a vehicle, use a prop)."
---

# ox_target

`ox_target` is a **standalone** third-eye targeting resource. Its only dependency
is `ox_lib` (no framework, no database). The player holds the target key (default
`LMENU` / Left-Alt), an eye appears, and looking at a registered model/entity/zone
shows clickable interaction options.

**All ox_target functions are CLIENT exports** — register them client-side (e.g.
inside a client script, often gated behind a check). The work an option performs
can still be server-side via `serverEvent`.

## The option object

Every `add*` method takes one option table **or an array of option tables**. Fields
(all verified against source — only `name` truncation differs, everything below is real):

| Field | Type | Purpose |
| --- | --- | --- |
| `label` | string | **Required.** Text shown in the eye menu. |
| `name` | string | Unique id for the option (lets you `remove*` it and dedupes). |
| `icon` | string | Font Awesome class, e.g. `'fa-solid fa-door-open'`. |
| `distance` | number | Max interact distance in metres (default `7`). |
| `canInteract` | function | `(entity, distance, coords, name, bone)` → return truthy to show. Run every frame; keep it cheap. |
| `onSelect` | function | `(data)` callback fired on click (see response below). |
| `event` | string | Client event to `TriggerEvent` instead of onSelect. |
| `serverEvent` | string | Server event to `TriggerServerEvent` (entity is sent as a netId). |
| `command` | string | Console command to `ExecuteCommand`. |
| `export` | string | `exports[resource][export]` to call (use with `resource`). |
| `groups` | string \| string[] \| table | Restrict to framework job/gang/group(s). `{ police = 2 }` requires grade ≥ 2. |
| `items` | string \| string[] | Require the player to have these items (framework-dependent). |
| `anyItem` | boolean | With multiple `items`, show if the player has **any** (default: needs all). |
| `bones` | string \| string[] | Only show when aiming at the named entity bone(s). |
| `offset` / `absoluteOffset` / `offsetSize` | vector3 / boolean / number | Restrict the option to a model-space offset point. |
| `openMenu` | string | Open a nested sub-menu (`'home'` returns to root). |
| `menuName` | string | Which menu this option belongs to (for nesting). |

Provide ONE of `onSelect` / `event` / `serverEvent` / `command` / `export` per option.

### onSelect / event response data

The handler receives a cloned option table plus runtime fields:
`entity` (the entity hit; a **netId** for `serverEvent`, otherwise local handle),
`coords` (vector3 hit point), `distance` (number), `zone` (zone id if a zone was hit),
plus `name` and any custom keys you put on the option. The `icon`, `groups`, `items`,
`canInteract`, `onSelect`, `event`, `serverEvent`, `command`, `export` keys are stripped
from the response.

## Adding to models, entities, players, peds, vehicles, objects

```lua
-- Models: by hash or name (joaat'd internally), single or array
exports.ox_target:addModel(`prop_atm_01`, options)
exports.ox_target:addModel({ `prop_atm_01`, `prop_atm_02` }, options)

-- A specific networked entity (by network id)
exports.ox_target:addEntity(netId, options)
-- A specific local/non-networked entity (by local handle)
exports.ox_target:addLocalEntity(spawnedPedHandle, options)

-- GLOBAL targets — apply to EVERY entity of that class:
exports.ox_target:addGlobalPed(options)      -- any ped (not players)
exports.ox_target:addGlobalPlayer(options)   -- any player ped
exports.ox_target:addGlobalVehicle(options)  -- any vehicle
exports.ox_target:addGlobalObject(options)   -- any object/prop
exports.ox_target:addGlobalOption(options)   -- shows on EVERYTHING (use sparingly)
```

Use `canInteract` to scope a global target instead of registering it per-entity.

## Adding world zones (no entity required)

```lua
-- Box: coords + size (vector3) + optional rotation (heading degrees)
local id = exports.ox_target:addBoxZone({
    coords = vec3(442.5, -1017.7, 28.9),
    size = vec3(3, 3, 3),
    rotation = 45,
    debug = false,        -- draw the zone outline while developing
    drawSprite = true,    -- show the eye sprite at the zone centre
    options = options,
})

-- Sphere: coords + radius
exports.ox_target:addSphereZone({
    coords = vec3(440.5, -1015.7, 28.9),
    radius = 3,
    debug = false,
    options = options,
})

-- Poly: an array of vec3 points + thickness (vertical height)
exports.ox_target:addPolyZone({
    points = { vec3(0,0,0), vec3(0,5,0), vec3(5,5,0), vec3(5,0,0) },
    thickness = 4,
    debug = false,
    options = options,
})
```

All three return a numeric **zone id**. They also accept an optional `name` field
so the zone can be referenced/removed by name.

## Removing targets

```lua
exports.ox_target:removeZone(id)            -- by numeric id or by zone name
exports.ox_target:zoneExists(id)            -- boolean

exports.ox_target:removeModel(`prop_atm_01`, 'name')   -- name(s) optional; omit to remove all
exports.ox_target:removeEntity(netId, 'name')
exports.ox_target:removeLocalEntity(handle, 'name')

exports.ox_target:removeGlobalPed('name')
exports.ox_target:removeGlobalPlayer('name')
exports.ox_target:removeGlobalVehicle('name')
exports.ox_target:removeGlobalObject('name')
exports.ox_target:removeGlobalOption('name')
```

The second arg is the option `name` (string or array). Targets registered by a
resource are **auto-cleaned when that resource stops** — manual removal is only
needed for entities you despawn or options you toggle at runtime.

`exports.ox_target:disableTargeting(true)` temporarily disables the eye;
`exports.ox_target:isActive()` reports whether the eye is currently open.

## Canonical example

```lua
-- client: interact with ATM props; gated by a held item, opens a server flow
exports.ox_target:addModel({ `prop_atm_01`, `prop_atm_02`, `prop_atm_03` }, {
    {
        name = 'myatm:use',
        label = 'Use ATM',
        icon = 'fa-solid fa-money-bill',
        distance = 1.5,
        items = 'bank_card',
        canInteract = function(entity, distance, coords, name, bone)
            return not IsPedInAnyVehicle(cache.ped, false)
        end,
        onSelect = function(data)
            -- data.entity / data.coords / data.distance available here
            TriggerServerEvent('myatm:open')
        end,
    },
})

-- a ped-shop option restricted to the police job, grade 1+
exports.ox_target:addGlobalPed({
    {
        name = 'police:cuff',
        label = 'Cuff',
        icon = 'fa-solid fa-handcuffs',
        groups = { police = 1 },
        onSelect = function(data)
            TriggerServerEvent('police:cuff', NetworkGetNetworkIdFromEntity(data.entity))
        end,
    },
})
```

## Rules

- ox_target is standalone — fxmanifest needs only `dependency 'ox_lib'` (plus
  `ox_target` if you call its exports). Do NOT pull in a framework just for targeting.
- `addModel`/`addEntity`/zones are CLIENT-side; do real work server-side via
  `serverEvent` (entity arrives as a netId) — never trust the client for money/items.
- Always set a unique `name` so options can be removed/replaced and don't duplicate
  on resource restart.
- Use `groups`/`items`/`canInteract` to scope visibility rather than registering and
  tearing down options manually.
- Keep `canInteract` cheap — it runs every frame while the eye is open.
- `addGlobalOption` shows on every target in the world; prefer the class-specific
  global adders (`addGlobalPed`, etc.) or model/entity targets.
