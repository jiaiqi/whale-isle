-- DST 状态导出（M7 / T-M7-D3）：产出与 shared-protocol DstStateSnapshotSchema 同形的 Lua 表。
-- 原创实现；机制参考 fruitstarzero/Don-t-Starve-Together-AI-Companion (MIT) 的服务器侧权威快照。
-- 只读 vanilla 组件，不做任意 Lua 执行；所有越界数值在服务端收敛为契约允许的取值范围。
local StateExport = {}

local receiptProvider = nil
local controlProvider = nil

function StateExport.SetReceiptProvider(fn)
    receiptProvider = fn
end

function StateExport.SetControlProvider(fn)
    controlProvider = fn
end

local function clamp(value, lo, hi)
    if value < lo then return lo end
    if value > hi then return hi end
    return value
end

local function bar(component)
    if component == nil then
        return { current = 0, max = 1 }
    end
    local current = tonumber(component.current) or 0
    local max = tonumber(component.max) or 1
    if max <= 0 then max = 1 end
    return { current = clamp(current, 0, max), max = max }
end

local function displayName(ent)
    if ent.components ~= nil and ent.components.named ~= nil and ent.components.named.name ~= nil then
        return tostring(ent.components.named.name)
    end
    return ent.prefab or ""
end

local function isResource(ent)
    local c = ent.components
    if c == nil then return false end
    return c.pickable ~= nil or c.workable ~= nil or c.harvestable ~= nil or c.crop ~= nil
end

local function isHostile(ent, inst)
    local combat = ent.components ~= nil and ent.components.combat or nil
    if combat == nil or inst == nil then return false end
    local ok, result = pcall(function()
        return combat:CanTarget(inst)
    end)
    return ok and result == true
end

local function directionText(dx, dz)
    if math.abs(dx) >= math.abs(dz) then
        return dx >= 0 and "东" or "西"
    end
    return dz >= 0 and "南" or "北"
end

--- 构造完整快照。inst 为受控玩家实体（服务端）。
function StateExport.Build(inst)
    local x, y, z = 0, 0, 0
    if inst.Transform ~= nil then
        x, y, z = inst.Transform:GetWorldPosition()
    end

    local world = (TheWorld ~= nil and TheWorld.state ~= nil) and TheWorld.state or {}
    local phase = world.phase or "day"
    if phase ~= "day" and phase ~= "dusk" and phase ~= "night" then phase = "day" end
    local season = world.season or "autumn"
    if season ~= "spring" and season ~= "summer" and season ~= "autumn" and season ~= "winter" then
        season = "autumn"
    end
    local phaseProgress = tonumber(world.time)
    if phaseProgress == nil then
        phaseProgress = (phase == "day" and 0.25) or (phase == "dusk" and 0.6) or 0.85
    end
    phaseProgress = clamp(phaseProgress, 0, 1)

    -- 背包：vanilla itemslots 是稀疏数组，按固定槽位扫描；equipslots 按槽名遍历。
    local inventory = {}
    if inst.components ~= nil and inst.components.inventory ~= nil then
        local inv = inst.components.inventory
        local byName = {}
        for slot = 1, 16 do
            local item = inv.itemslots ~= nil and inv.itemslots[slot] or nil
            if item ~= nil and item.prefab ~= nil then
                local count = (item.components ~= nil and item.components.stackable ~= nil)
                    and item.components.stackable.stacksize or 1
                byName[item.prefab] = (byName[item.prefab] or 0) + count
            end
        end
        if inv.equipslots ~= nil then
            for _, item in pairs(inv.equipslots) do
                if item ~= nil and item.prefab ~= nil then
                    byName[item.prefab] = (byName[item.prefab] or 0) + 1
                end
            end
        end
        for name, count in pairs(byName) do
            local equipped = inv.equipslots ~= nil and inv.equipslots[name] ~= nil
            table.insert(inventory, { itemName = name, count = count, equipped = equipped == true })
        end
    end
    table.sort(inventory, function(a, b) return a.itemName < b.itemName end)

    -- 附近实体：TheSim:FindEntities（vanilla），按距离截断，避免快照膨胀。
    local nearby = {}
    local campfires = {}
    local threats = {}
    local threatCount = {}
    if TheSim ~= nil and TheSim.FindEntities ~= nil then
        local found = TheSim:FindEntities(x, y, z, 16)
        for _, ent in pairs(found) do
            if ent ~= inst and ent:IsValid() and ent.prefab ~= nil then
                local ex, _, ez = 0, 0, 0
                if ent.Transform ~= nil then ex, _, ez = ent.Transform:GetWorldPosition() end
                local dx, dz = ex - x, ez - z
                local distance = math.sqrt(dx * dx + dz * dz)
                if distance <= 16 then
                    local prefab = ent.prefab
                    if #nearby < 40 then
                        table.insert(nearby, {
                            prefab = prefab,
                            displayName = displayName(ent),
                            position = { x = math.floor(ex * 100) / 100, z = math.floor(ez * 100) / 100 },
                            distance = math.floor(distance * 100) / 100,
                            isHostile = isHostile(ent, inst),
                            isResource = isResource(ent),
                        })
                    end

                    local fuel = ent.components ~= nil and ent.components.fuel or nil
                    if ent:HasTag("campfire") and fuel ~= nil then
                        local maxfuel = tonumber(fuel.maxfuel) or 1
                        if maxfuel <= 0 then maxfuel = 1 end
                        table.insert(campfires, {
                            position = { x = math.floor(ex * 100) / 100, z = math.floor(ez * 100) / 100 },
                            fuelPercent = clamp((tonumber(fuel.currentfuel) or 0) / maxfuel, 0, 1),
                        })
                    end

                    local kind = nil
                    if ent:HasTag("hound") then kind = "hound"
                    elseif ent:HasTag("spider") then kind = "spider"
                    elseif prefab == "moose" or prefab == "bearger" or prefab == "dragonfly" then kind = "boss" end
                    if kind ~= nil and distance <= 14 then
                        threatCount[kind] = (threatCount[kind] or 0) + 1
                        if threatCount[kind] == 1 then
                            table.insert(threats, {
                                kind = kind,
                                count = 1,
                                directionText = directionText(dx, dz),
                            })
                        else
                            for _, t in pairs(threats) do
                                if t.kind == kind then t.count = threatCount[kind] end
                            end
                        end
                    end
                end
            end
        end
    end

    local authority = "AI_AUTOPILOT"
    local playerMoving = false
    if controlProvider ~= nil then
        local ok, result = pcall(controlProvider)
        if ok and type(result) == "table" then
            authority = result.authority or authority
            playerMoving = result.isPlayerMovingPhysically == true
        end
    end

    local snapshot = {
        schemaVersion = 1,
        capturedAt = (os.time() or 0) * 1000,
        clock = {
            cycle = math.max(0, math.floor(tonumber(world.cycles) or 0)),
            phase = phase,
            phaseProgress = phaseProgress,
            season = season,
            isRaining = world.israining == true or world.precipitation == "rain",
        },
        player = {
            character = inst.prefab or "wilson",
            health = bar(inst.components ~= nil and inst.components.health or nil),
            hunger = bar(inst.components ~= nil and inst.components.hunger or nil),
            sanity = bar(inst.components ~= nil and inst.components.sanity or nil),
            temperature = tonumber(inst.components ~= nil and inst.components.temperature ~= nil
                and inst.components.temperature.current or 18) or 18,
            moisture = clamp(tonumber(inst.components ~= nil and inst.components.moisture ~= nil
                and inst.components.moisture.moisture or 0) or 0, 0, 100),
            position = { x = math.floor(x * 100) / 100, z = math.floor(z * 100) / 100 },
            inventory = inventory,
        },
        nearby = { entities = nearby, campfires = campfires },
        threats = threats,
        control = {
            authority = authority,
            isPlayerMovingPhysically = playerMoving,
        },
    }

    -- 附带字段（不在 shared-protocol 契约内）：sidecar 先剥离再做 DstStateSnapshotSchema.parse。
    if receiptProvider ~= nil then
        local ok, receipt = pcall(receiptProvider)
        if ok and type(receipt) == "table" then snapshot.lastReceipt = receipt end
    end
    return snapshot
end

return StateExport
