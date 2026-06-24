-- myRP.build Bridge -- Server Component
-- Provides auto-refresh, resource management, and server status for myRP.build

local BRIDGE_VERSION = '1.0.0'
local TOKEN = GetConvar('myrpbuild_token', '')

-- --- Utility ---------------------------------------------------------------

--- Validate the bridge token (if configured)
local function isAuthorized(token)
    if TOKEN == '' then return true end  -- No token = open access (dev mode)
    return token == TOKEN
end

--- Get resource state info
local function getResourceInfo(name)
    local state = GetResourceState(name)
    return {
        name = name,
        state = state,  -- 'started', 'stopped', 'missing', 'uninitialized', etc.
        path = GetResourcePath(name) or '',
        metadata = {
            description = GetResourceMetadata(name, 'description', 0) or '',
            version = GetResourceMetadata(name, 'version', 0) or '',
            author = GetResourceMetadata(name, 'author', 0) or '',
        }
    }
end

--- Get all resources and their states
local function getAllResources()
    local resources = {}
    local count = GetNumResources()
    for i = 0, count - 1 do
        local name = GetResourceByFindIndex(i)
        if name then
            resources[#resources + 1] = {
                name = name,
                state = GetResourceState(name)
            }
        end
    end
    return resources
end

-- --- Commands (accessible via RCON from myRP.build) ----------------------

--- Studio: Refresh and ensure a resource in one command
RegisterCommand('studio:deploy', function(source, args, rawCommand)
    if source ~= 0 then return end  -- Console/RCON only

    local resourceName = args[1]
    if not resourceName then
        print('[myRP.build] Usage: studio:deploy <resource-name>')
        return
    end

    -- Refresh to pick up new/changed files
    ExecuteCommand('refresh')

    -- Small delay to let refresh complete
    Citizen.Wait(500)

    -- Ensure the resource (start if stopped, restart if running)
    ExecuteCommand('ensure ' .. resourceName)

    -- Wait and check status
    Citizen.Wait(1000)

    local state = GetResourceState(resourceName)
    if state == 'started' then
        print('[myRP.build] Resource "' .. resourceName .. '" deployed successfully')
    else
        print('[myRP.build] Resource "' .. resourceName .. '" failed to start (state: ' .. state .. ')')
    end
end, true)  -- restricted = true (admin/console only)

--- Studio: Get resource info as JSON (for RCON parsing)
RegisterCommand('studio:info', function(source, args, rawCommand)
    if source ~= 0 then return end  -- Console/RCON only

    local resourceName = args[1]
    if not resourceName then
        print('[myRP.build] Usage: studio:info <resource-name>')
        return
    end

    local info = getResourceInfo(resourceName)
    print('[myRP.build] ' .. json.encode(info))
end, true)

--- Studio: List all resources with states
RegisterCommand('studio:resources', function(source, args, rawCommand)
    if source ~= 0 then return end  -- Console/RCON only

    local resources = getAllResources()
    local started, stopped, other = 0, 0, 0

    for _, res in ipairs(resources) do
        if res.state == 'started' then started = started + 1
        elseif res.state == 'stopped' then stopped = stopped + 1
        else other = other + 1 end
    end

    print(('[myRP.build] Resources: %d started, %d stopped, %d other (total: %d)'):format(
        started, stopped, other, #resources
    ))
end, true)

--- Studio: Health check
RegisterCommand('studio:health', function(source, args, rawCommand)
    if source ~= 0 then return end  -- Console/RCON only

    local playerCount = #GetPlayers()
    local resourceCount = GetNumResources()

    print(('[myRP.build] Bridge v%s | Players: %d | Resources: %d | Uptime: %ds'):format(
        BRIDGE_VERSION,
        playerCount,
        resourceCount,
        math.floor(GetGameTimer() / 1000)
    ))
end, true)

--- Studio: Check dependencies for a resource
RegisterCommand('studio:checkdeps', function(source, args, rawCommand)
    if source ~= 0 then return end  -- Console/RCON only

    local resourceName = args[1]
    if not resourceName then
        print('[myRP.build] Usage: studio:checkdeps <resource-name>')
        return
    end

    local numDeps = GetNumResourceMetadata(resourceName, 'dependency') or 0
    local missing = {}
    local found = {}

    for i = 0, numDeps - 1 do
        local dep = GetResourceMetadata(resourceName, 'dependency', i)
        if dep then
            local depState = GetResourceState(dep)
            if depState == 'started' then
                found[#found + 1] = dep
            else
                missing[#missing + 1] = dep .. ' (' .. depState .. ')'
            end
        end
    end

    if #missing > 0 then
        print('[myRP.build] Missing dependencies for "' .. resourceName .. '": ' .. table.concat(missing, ', '))
    else
        print('[myRP.build] All dependencies satisfied for "' .. resourceName .. '"')
    end
end, true)

-- --- Startup ---------------------------------------------------------------

Citizen.CreateThread(function()
    Citizen.Wait(0)
    print(('[myRP.build] Bridge v%s loaded -- %d resources tracked'):format(
        BRIDGE_VERSION,
        GetNumResources()
    ))
end)
