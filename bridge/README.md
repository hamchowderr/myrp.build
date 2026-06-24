# myrp-build-bridge

Companion resource for [myRP.build](https://github.com/hamchowderr/myrp.build). Provides server-side commands for automated resource deployment and management.

## Installation

1. Copy the `bridge` folder to your server's `resources/[local]/myrp-build-bridge/`
2. Add `ensure myrp-build-bridge` to your `server.cfg`
3. (Optional) Set a security token: `set myrpbuild_token "your-secret-token"` in server.cfg

## Commands (RCON only)

All commands are restricted to console/RCON — players cannot use them.

| Command                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `studio:deploy <name>`    | Refresh + ensure a resource (one-step deploy)  |
| `studio:info <name>`      | Get resource info as JSON                      |
| `studio:resources`        | List all resources with states                 |
| `studio:health`           | Bridge health check (version, players, uptime) |
| `studio:checkdeps <name>` | Check if all dependencies are loaded           |

## Security

- All commands require `source == 0` (console/RCON only)
- Optional token authentication via `myrpbuild_token` convar
- No player-facing functionality

---

_Part of myRP.build_
