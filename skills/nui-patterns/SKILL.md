---
name: nui-patterns
description: "NUI (Native UI) patterns for FiveM — HTML/CSS/JS overlays, SendNUIMessage, RegisterNUICallback, fetch-based communication. Use when generating resources that include HTML/CSS/JS user interfaces."
---

# NUI (Native UI) Patterns

NUI is FiveM's system for rendering HTML/CSS/JS interfaces as in-game overlays. Every NUI resource follows the same lifecycle and communication patterns.

## NUI Lifecycle

The complete flow for any NUI resource:

1. **Declare in fxmanifest.lua** — register HTML files and entry point
2. **Open** — Lua sends `SendNUIMessage({ action = 'open' })` + `SetNuiFocus(true, true)`
3. **Interact** — JS sends data back via `fetch()` to registered NUI callbacks
4. **Close** — JS calls the close callback via `fetch()`, Lua runs `SetNuiFocus(false, false)`

## fxmanifest.lua Declarations

Every NUI resource needs these in its manifest:

```lua
files {
  'html/index.html',
  'html/style.css',
  'html/app.js',
  -- include ALL files the NUI references (images, fonts, etc.)
}

ui_page 'html/index.html'
```

- `files` makes assets available to the NUI browser
- `ui_page` sets the entry point HTML file
- Missing file declarations cause silent 404s in the NUI browser

## Focus Management

```lua
-- Opening: give NUI mouse cursor AND keyboard focus
SetNuiFocus(true, true)

-- Closing: ALWAYS release both
SetNuiFocus(false, false)
```

**Critical rules:**

- ALWAYS call `SetNuiFocus(false, false)` on every close path
- Never leave `SetNuiFocus(true, true)` without a close path — it traps the mouse and keyboard
- First argument = mouse cursor visible, second = keyboard input captured
- For HUDs and passive overlays, NEVER call `SetNuiFocus` — they must not capture input

## Client-Side Lua Patterns

### Opening the NUI

```lua
RegisterNetEvent('myresource:openMenu', function()
  SetNuiFocus(true, true)
  SendNUIMessage({ action = 'open', data = myData })
end)
```

### Registering NUI Callbacks (JS -> Lua)

```lua
-- Called when JS does fetch() to this endpoint
RegisterNuiCallback('closeMenu', function(data, cb)
  SetNuiFocus(false, false)
  cb('ok', {})  -- MUST call cb() to resolve the JS fetch promise
end)

RegisterNuiCallback('submitForm', function(data, cb)
  -- data contains whatever JS sent in the fetch body
  local name = data.name
  local amount = data.amount

  -- Validate inputs
  if type(name) ~= 'string' or type(amount) ~= 'number' then
    cb('error', { message = 'Invalid input' })
    return
  end

  -- Process and respond
  TriggerServerEvent('myresource:processForm', name, amount)
  cb('ok', { success = true })
end)
```

**Always call `cb()` in every callback** — failing to call it leaves the JS `fetch()` promise hanging forever.

### Sending Data to NUI

```lua
-- Send structured messages with an action field for dispatch
SendNUIMessage({
  action = 'updateInventory',
  items = playerItems,
  money = playerMoney
})
```

## JavaScript-Side Patterns

### Receiving Messages from Lua

```javascript
window.addEventListener("message", (event) => {
  const data = event.data;

  switch (data.action) {
    case "open":
      document.getElementById("container").classList.remove("hidden");
      populateData(data.data);
      break;
    case "close":
      document.getElementById("container").classList.add("hidden");
      break;
    case "updateInventory":
      renderItems(data.items);
      break;
  }
});
```

### Sending Data to Lua (fetch pattern)

```javascript
// ALWAYS use fetch() for NUI callbacks — NEVER use window.invokeNative
document.getElementById("close-btn").addEventListener("click", () => {
  fetch(`https://${GetParentResourceName()}/closeMenu`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
});

document.getElementById("submit-btn").addEventListener("click", () => {
  const formData = {
    name: document.getElementById("name-input").value,
    amount: parseInt(document.getElementById("amount-input").value),
  };

  fetch(`https://${GetParentResourceName()}/submitForm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formData),
  });
});
```

**Key rules:**

- `GetParentResourceName()` returns the resource name — use it in ALL fetch URLs
- NEVER hardcode the resource name in fetch URLs
- NEVER use `window.invokeNative()` — it is deprecated and unreliable
- Always use `POST` method with `Content-Type: application/json`
- Always `JSON.stringify()` the body, even if empty (`JSON.stringify({})`)

### Escape Key to Close

```javascript
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    fetch(`https://${GetParentResourceName()}/closeMenu`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }
});
```

## CSS Reset for NUI

Every NUI HTML file needs this base CSS:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: transparent; /* game shows through */
  overflow: hidden; /* no scrollbars */
  font-family: "Segoe UI", sans-serif;
  color: white;
  width: 100vw;
  height: 100vh;
}

/* For interactive NUIs: container captures pointer events */
.container {
  pointer-events: auto;
}

/* Hidden state */
.hidden {
  display: none;
}
```

**Important:**

- `background: transparent` is required so the game renders behind the UI
- For passive overlays (HUDs, notifications), `body` must have `pointer-events: none`
- For interactive menus, the container element should have `pointer-events: auto`
- Start the main container with `class="hidden"` and show it on the `open` action

## Complete Minimal Example

### client/main.lua

```lua
local isOpen = false

RegisterNetEvent('myresource:toggle', function()
  if isOpen then
    SetNuiFocus(false, false)
    SendNUIMessage({ action = 'close' })
  else
    SetNuiFocus(true, true)
    SendNUIMessage({ action = 'open' })
  end
  isOpen = not isOpen
end)

RegisterNuiCallback('close', function(_, cb)
  SetNuiFocus(false, false)
  isOpen = false
  cb('ok', {})
end)

RegisterNuiCallback('doAction', function(data, cb)
  TriggerServerEvent('myresource:action', data.value)
  cb('ok', {})
end)
```

### html/app.js

```javascript
window.addEventListener("message", (event) => {
  const { action } = event.data;
  const container = document.getElementById("app");

  if (action === "open") container.classList.remove("hidden");
  if (action === "close") container.classList.add("hidden");
});

document.getElementById("action-btn").addEventListener("click", () => {
  fetch(`https://${GetParentResourceName()}/doAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "something" }),
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    fetch(`https://${GetParentResourceName()}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }
});
```

## Common Mistakes

- **Forgetting `cb()` in callbacks** — JS fetch hangs, NUI becomes unresponsive
- **Not releasing focus on close** — mouse trapped in NUI, player cannot move
- **Using `window.invokeNative`** — deprecated, use `fetch()` always
- **Hardcoding resource name in fetch URLs** — breaks if resource is renamed
- **Missing `files` declaration in fxmanifest** — NUI loads but assets 404
- **Not handling Escape key** — players expect Escape to close any menu
- **Transparent background missing** — NUI renders with white/black background over the game

## Reference

- https://docs.fivem.net/docs/scripting-reference/nui-development/
