---
name: hud-design
description: "HUD design standards for FiveM — health, armor, hunger, thirst, stamina bars positioned above the GTA V minimap. Use when generating a HUD resource specifically."
---

# HUD Design Standards

A HUD is a passive, always-visible NUI overlay. It NEVER calls `SetNuiFocus`. It covers vital player stats that the game doesn't natively display well.

## Required Stats

Unless the user explicitly asks for fewer, every HUD includes:

| Stat    | Color         | Source (Client)                                            | Range  |
| :------ | :------------ | :--------------------------------------------------------- | :----- |
| Health  | Red           | `GetEntityHealth(ped)` — maps 100-200 to 0-100%            | 0-100% |
| Armor   | Blue          | `GetPedArmour(ped)` — 0-100                                | 0-100  |
| Hunger  | Orange/Yellow | Framework player data (`player.hunger`, `metadata.hunger`) | 0-100  |
| Thirst  | Cyan/Teal     | Framework player data (`player.thirst`, `metadata.thirst`) | 0-100  |
| Stamina | Green         | `GetPlayerSprintStaminaRemaining(PlayerId())` (returns USED, invert) | 0-100  |
| Stress  | Purple        | Framework player data (optional, if available)             | 0-100  |

## Visual Design Requirements

### Position and Layout

- **Position:** bottom-left, above the GTA V minimap (`bottom: ~178px`, `left: ~15px`)
- **Width:** 200-220px (matches minimap width)
- Each stat on its own row with icon, bar, and numeric value

### Styling

- **Background:** dark, semi-transparent with blur (`rgba(0,0,0,0.55-0.65)`, `backdrop-filter: blur(4-6px)`)
- **Border:** subtle (`1px solid rgba(255,255,255,0.06)`), rounded corners (4-6px)
- **Bars:** thin (6-8px height), rounded, with gradient fills and smooth CSS transitions
- **Icons:** colored indicator dots (8-10px circles with matching glow/box-shadow) OR small SVG icons
- **Labels:** small numeric values (10-12px, `font-variant-numeric: tabular-nums`, `text-shadow` for readability)
- **Transitions:** CSS transitions on bar widths (`0.3-0.5s ease`) for smooth updates

### Health Bar Color-Coding

- **Normal (> 50%):** green or standard red
- **Warning (25-50%):** orange
- **Critical (< 25%):** bright red, optionally pulsing

### Critical CSS Rule

```css
body {
  pointer-events: none; /* HUD must NEVER block game input */
  background: transparent;
  overflow: hidden;
  margin: 0;
  padding: 0;
}
```

## Client Script Pattern

```lua
local function getPlayerStats()
  local ped = PlayerPedId()
  local health = GetEntityHealth(ped)
  local maxHealth = GetEntityMaxHealth(ped)

  -- Map health from 100-200 range to 0-100%
  local healthPct = math.floor(((health - 100) / (maxHealth - 100)) * 100)
  if healthPct < 0 then healthPct = 0 end
  if healthPct > 100 then healthPct = 100 end

  local armor = GetPedArmour(ped)
  -- GetPlayerSprintStaminaRemaining returns stamina USED (0 = full, 100 = empty); invert it
  local stamina = math.floor(100 - GetPlayerSprintStaminaRemaining(PlayerId()))

  -- Framework-specific: get hunger/thirst/stress
  -- ox_core example:
  -- local player = exports.ox_core:GetPlayer()
  -- local hunger = player and player.get('hunger') or 100
  -- local thirst = player and player.get('thirst') or 100

  return {
    health = healthPct,
    armor = armor,
    stamina = stamina,
    hunger = hunger or 100,
    thirst = thirst or 100,
    stress = stress or 0
  }
end

-- Polling thread: 200-500ms interval
Citizen.CreateThread(function()
  -- Wait for player to be fully loaded before showing HUD
  while not hasPlayerLoaded do
    Citizen.Wait(500)
  end

  SendNUIMessage({ action = 'show' })

  while true do
    Citizen.Wait(300) -- 300ms polling interval
    local stats = getPlayerStats()
    SendNUIMessage({
      action = 'update',
      health = stats.health,
      armor = stats.armor,
      stamina = stats.stamina,
      hunger = stats.hunger,
      thirst = stats.thirst,
      stress = stats.stress
    })
  end
end)

-- Hide HUD on death
AddEventHandler('baseevents:onPlayerDied', function()
  SendNUIMessage({ action = 'hide' })
end)

-- Show HUD on respawn — 'playerSpawned' is fired by spawnmanager (NOT namespaced, NOT baseevents)
AddEventHandler('playerSpawned', function()
  SendNUIMessage({ action = 'show' })
end)
```

## NUI Script Pattern

```javascript
// Start hidden
const container = document.getElementById("hud-container");
container.classList.add("hidden");

window.addEventListener("message", (event) => {
  const data = event.data;

  switch (data.action) {
    case "show":
      container.classList.remove("hidden");
      break;

    case "hide":
      container.classList.add("hidden");
      break;

    case "update":
      // Update bar widths
      document.getElementById("health-bar").style.width = data.health + "%";
      document.getElementById("armor-bar").style.width = data.armor + "%";
      document.getElementById("stamina-bar").style.width = data.stamina + "%";
      document.getElementById("hunger-bar").style.width = data.hunger + "%";
      document.getElementById("thirst-bar").style.width = data.thirst + "%";

      // Update numeric labels
      document.getElementById("health-val").textContent = data.health;
      document.getElementById("armor-val").textContent = data.armor;
      document.getElementById("stamina-val").textContent = data.stamina;
      document.getElementById("hunger-val").textContent = data.hunger;
      document.getElementById("thirst-val").textContent = data.thirst;

      // Color-code health bar by percentage
      const healthBar = document.getElementById("health-bar");
      if (data.health > 50) {
        healthBar.style.background = "linear-gradient(90deg, #e74c3c, #ff6b6b)";
      } else if (data.health > 25) {
        healthBar.style.background = "linear-gradient(90deg, #e67e22, #f39c12)";
      } else {
        healthBar.style.background = "linear-gradient(90deg, #c0392b, #e74c3c)";
      }

      // Optional stress bar
      if (data.stress !== undefined) {
        document.getElementById("stress-bar").style.width = data.stress + "%";
        document.getElementById("stress-val").textContent = data.stress;
      }
      break;
  }
});
```

## CSS Structure

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: transparent;
  pointer-events: none;
  overflow: hidden;
  width: 100vw;
  height: 100vh;
}

.hidden {
  display: none !important;
}

#hud-container {
  position: fixed;
  bottom: 178px;
  left: 15px;
  width: 210px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(5px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 5px;
  padding: 8px 10px;
  font-family: "Segoe UI", sans-serif;
  color: white;
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.stat-row:last-child {
  margin-bottom: 0;
}

.stat-icon {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stat-icon.health {
  background: #e74c3c;
  box-shadow: 0 0 4px #e74c3c;
}
.stat-icon.armor {
  background: #3498db;
  box-shadow: 0 0 4px #3498db;
}
.stat-icon.hunger {
  background: #f39c12;
  box-shadow: 0 0 4px #f39c12;
}
.stat-icon.thirst {
  background: #1abc9c;
  box-shadow: 0 0 4px #1abc9c;
}
.stat-icon.stamina {
  background: #2ecc71;
  box-shadow: 0 0 4px #2ecc71;
}
.stat-icon.stress {
  background: #9b59b6;
  box-shadow: 0 0 4px #9b59b6;
}

.stat-bar-bg {
  flex: 1;
  height: 7px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  overflow: hidden;
}

.stat-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
  width: 100%;
}

.stat-bar.health {
  background: linear-gradient(90deg, #e74c3c, #ff6b6b);
}
.stat-bar.armor {
  background: linear-gradient(90deg, #2980b9, #3498db);
}
.stat-bar.hunger {
  background: linear-gradient(90deg, #e67e22, #f39c12);
}
.stat-bar.thirst {
  background: linear-gradient(90deg, #16a085, #1abc9c);
}
.stat-bar.stamina {
  background: linear-gradient(90deg, #27ae60, #2ecc71);
}
.stat-bar.stress {
  background: linear-gradient(90deg, #8e44ad, #9b59b6);
}

.stat-val {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  min-width: 24px;
  text-align: right;
}
```

## fxmanifest.lua for HUD

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'myRP.build'
description 'Custom HUD'
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

Note: HUDs typically do NOT need server scripts, ox_lib, or oxmysql unless they read framework player data server-side and push it to the client via events.

## Common Mistakes

- **Calling `SetNuiFocus` in a HUD** — HUDs are passive, never capture input
- **Missing `pointer-events: none` on body** — HUD blocks mouse clicks on the game
- **Polling too fast (`Wait(0)`)** — destroys resmon performance; 200-500ms is sufficient
- **Not hiding on death** — HUD shows stats for a dead player
- **Hardcoded health range** — health is 100-200 natively, NOT 0-100; must map it
- **Missing `backdrop-filter` prefix** — some CEF versions need `-webkit-backdrop-filter`
- **Wrong position** — must sit above the minimap, not overlap it

## Reference

- https://docs.fivem.net/docs/game-references/hud-components/
