-- DST 高层动作层（M7 / T-M7-D3）：把 sidecar 计划翻译成 vanilla API 调用并产出四态回执。
-- 原创实现；机制参考 fruitstarzero/Don-t-Starve-Together-AI-Companion (MIT)
--   与 Im-Chuyu/Journey-Together（无 LICENSE，只参考"38 动作全部走原版权限校验"的思想）。
-- 红线：不做任意 Lua 执行器；不加载/执行计划里的字符串；单飞互斥；超时≠失败；人类接管立即中止。
local Actions = {}

local takeover = false
local inFlight = nil
local lastReceipt = nil
local seenActions = {}
local seenCount = 0
local DEFAULT_TIMEOUT_MS = 30 * 1000

local function nowMs()
    return (os.time() or 0) * 1000
end

--- 产出回执（不含 snapshot；sidecar 用最近一次 tick 快照填充后过 DstActionReceiptSchema）。
local function emitReceipt(inst, actionId, tool, status, reason, startedAt)
    local receipt = {
        actionId = actionId,
        tool = tool,
        gameId = "dst",
        status = status,
        reason = reason,
        startedAt = startedAt or nowMs(),
        completedAt = nowMs(),
    }
    lastReceipt = receipt
    return receipt
end

function Actions.ConsumeReceipt()
    local receipt = lastReceipt
    lastReceipt = nil
    return receipt
end

function Actions.SetTakeover(active)
    takeover = active == true
    if takeover and inFlight ~= nil then
        local active = inFlight
        inFlight = nil
        if active.watcher ~= nil then active.watcher:Cancel() end
        if active.inst ~= nil and active.inst.components ~= nil then
            if active.inst.components.locomotor ~= nil then
                active.inst.components.locomotor:StopMove()
            end
            if active.inst.components.combat ~= nil then
                active.inst.components.combat:SetTarget(nil)
            end
            active.inst.bufferedaction = nil
        end
        emitReceipt(active.inst, active.actionId, active.tool, "ABORTED_BY_HUMAN_TAKEOVER",
            "CONSOLE_TAKEOVER_DETECTED", active.startedAt)
    end
end

function Actions.IsTakeover()
    return takeover
end

function Actions.GetAuthority()
    return {
        authority = takeover and "HUMAN_TAKEOVER_ACTIVE" or "AI_AUTOPILOT",
        isPlayerMovingPhysically = takeover,
    }
end

local function findTarget(inst, args)
    if args.prefab == nil and args.target == nil then return nil end
    local x, _, z = inst.Transform:GetWorldPosition()
    local found = TheSim ~= nil and TheSim.FindEntities ~= nil and TheSim:FindEntities(x, 0, z, 18) or {}
    local wanted = args.prefab or args.target
    local best, bestDistance = nil, math.huge
    local maxDistance = tonumber(args.maxDistance) or 12
    for _, ent in pairs(found) do
        if ent ~= inst and ent:IsValid() and ent.prefab ~= nil then
            local match = ent.prefab == wanted or ent:HasTag(wanted)
            if match then
                local ex, _, ez = ent.Transform:GetWorldPosition()
                local dx, dz = ex - x, ez - z
                local distance = math.sqrt(dx * dx + dz * dz)
                if distance <= maxDistance and distance < bestDistance then
                    best, bestDistance = ent, distance
                end
            end
        end
    end
    return best
end

local function findResource(inst, args)
    local x, _, z = inst.Transform:GetWorldPosition()
    local found = TheSim ~= nil and TheSim.FindEntities ~= nil and TheSim:FindEntities(x, 0, z, 14) or {}
    local best, bestDistance = nil, math.huge
    local maxDistance = tonumber(args.maxDistance) or 10
    for _, ent in pairs(found) do
        if ent ~= inst and ent:IsValid() and ent.components ~= nil then
            local c = ent.components
            local usable = c.pickable ~= nil or c.harvestable ~= nil or c.workable ~= nil or c.crop ~= nil
            local prefabOk = args.item == nil or ent.prefab == args.item
            if usable and prefabOk then
                local ex, _, ez = ent.Transform:GetWorldPosition()
                local dx, dz = ex - x, ez - z
                local distance = math.sqrt(dx * dx + dz * dz)
                if distance <= maxDistance and distance < bestDistance then
                    best, bestDistance = ent, distance
                end
            end
        end
    end
    return best
end

local function findEdible(inst)
    local inv = inst.components ~= nil and inst.components.inventory or nil
    if inv == nil then return nil end
    return inv:FindItem(function(item)
        return item.components ~= nil and item.components.edible ~= nil
    end)
end

local function findFuelItem(inst)
    local inv = inst.components ~= nil and inst.components.inventory or nil
    if inv == nil then return nil end
    return inv:FindItem(function(item)
        return item.components ~= nil and item.components.fuel ~= nil
    end)
end

local function findCampfire(inst)
    local x, _, z = inst.Transform:GetWorldPosition()
    local found = TheSim ~= nil and TheSim.FindEntities ~= nil and TheSim:FindEntities(x, 0, z, 12) or {}
    local best, bestDistance = nil, math.huge
    for _, ent in pairs(found) do
        if ent:IsValid() and ent:HasTag("campfire") and ent.components ~= nil and ent.components.fuel ~= nil then
            local ex, _, ez = ent.Transform:GetWorldPosition()
            local dx, dz = ex - x, ez - z
            local distance = math.sqrt(dx * dx + dz * dz)
            if distance < bestDistance then best, bestDistance = ent, distance end
        end
    end
    return best
end

local function pushVanilla(inst, bufferedAction)
    if inst.components ~= nil and inst.components.locomotor ~= nil then
        inst.components.locomotor:PushAction(bufferedAction, true)
    elseif inst.PushBufferedAction ~= nil then
        inst:PushBufferedAction(bufferedAction)
    else
        return false
    end
    return true
end

--- 异步动作完成检测：vanilla BufferedAction 执行期间 inst.bufferedaction 非空；
--- 清零后回 COMPLETED；超过 30s 回 UNCERTAIN（超时≠失败，绝不自动重发）。
local function watchCompletion(inst, actionId, tool, startedAt, target)
    local elapsed = 0
    local watcher
    watcher = inst:DoPeriodicTask(0.25, function()
        elapsed = elapsed + 0.25
        local stillBusy = inst.bufferedaction ~= nil
        if not stillBusy and elapsed < 0.5 then stillBusy = true end -- 给 PushAction 一个 tick 的宽限期
        if elapsed >= DEFAULT_TIMEOUT_MS / 1000 then
            if watcher ~= nil then watcher:Cancel() end
            inFlight = nil
            emitReceipt(inst, actionId, tool, "UNCERTAIN", "ACTION_TIMEOUT_UNCERTAIN", startedAt)
        elseif not stillBusy then
            if watcher ~= nil then watcher:Cancel() end
            inFlight = nil
            if tool == "attack" and inst.components ~= nil and inst.components.combat ~= nil then
                inst.components.combat:SetTarget(nil)
            end
            emitReceipt(inst, actionId, tool, "COMPLETED", nil, startedAt)
        end
    end)
    return watcher
end

local function beginAsync(inst, actionId, tool, startedAt, target)
    inFlight = { inst = inst, actionId = actionId, tool = tool, startedAt = startedAt, watcher = nil }
    inFlight.watcher = watchCompletion(inst, actionId, tool, startedAt, target)
end

--- 执行单步计划；返回回执表（或 nil = 被去重/无 inst）。
function Actions.ExecuteOne(inst, step)
    if inst == nil or type(step) ~= "table" or step.actionId == nil then return nil end
    local actionId = tostring(step.actionId)
    local tool = tostring(step.tool or "")
    local args = type(step.args) == "table" and step.args or {}
    local startedAt = nowMs()

    -- 去重：同一 actionId 只执行一次（fruitstarzero 机制思想，原创实现）
    if seenActions[actionId] then
        return emitReceipt(inst, actionId, tool, "COMPLETED", "DUPLICATE_ACTION_SKIPPED", startedAt)
    end
    seenActions[actionId] = true
    seenCount = seenCount + 1
    if seenCount > 256 then seenActions, seenCount = {}, 0 end

    -- 人类接管：后续动作一律拒绝执行，避免"接管后 AI 还在动"
    if takeover then
        return emitReceipt(inst, actionId, tool, "ABORTED_BY_HUMAN_TAKEOVER", "CONSOLE_TAKEOVER_ACTIVE", startedAt)
    end
    -- 单飞互斥：在飞动作未结算前拒绝新动作
    if inFlight ~= nil then
        return emitReceipt(inst, actionId, tool, "FAILED", "ACTION_IN_FLIGHT", startedAt)
    end

    local x, _, z = inst.Transform:GetWorldPosition()
    if args.x ~= nil and args.z ~= nil then
        x, z = tonumber(args.x) or x, tonumber(args.z) or z
    end
    local point = Vector3(x, 0, z)

    if tool == "move_to" or tool == "goto" or tool == "follow" then
        local action = BufferedAction(inst, nil, ACTIONS.WALKTO, nil, point)
        if pushVanilla(inst, action) then
            beginAsync(inst, actionId, tool, startedAt, nil)
        else
            emitReceipt(inst, actionId, tool, "FAILED", "LOCOMOTOR_UNAVAILABLE", startedAt)
        end

    elseif tool == "gather" or tool == "pickup" or tool == "harvest" then
        local target = findResource(inst, args) or findTarget(inst, args)
        if target == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_TARGET_FOUND", startedAt)
        else
            local actionName = (target.components ~= nil and target.components.pickable ~= nil) and "PICK" or "PICKUP"
            local action = BufferedAction(inst, target, ACTIONS[actionName])
            if action ~= nil and pushVanilla(inst, action) then
                beginAsync(inst, actionId, tool, startedAt, target)
            else
                emitReceipt(inst, actionId, tool, "FAILED", "ACTION_UNAVAILABLE", startedAt)
            end
        end

    elseif tool == "work" or tool == "chop" or tool == "mine" then
        local target = findTarget(inst, args) or findResource(inst, args)
        local workable = target ~= nil and target.components ~= nil and target.components.workable or nil
        local workAction = workable ~= nil and workable.action or nil
        if type(workAction) == "string" then workAction = ACTIONS[workAction] end
        if workAction == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_WORKABLE_TARGET", startedAt)
        else
            local action = BufferedAction(inst, target, workAction)
            if pushVanilla(inst, action) then
                beginAsync(inst, actionId, tool, startedAt, target)
            else
                emitReceipt(inst, actionId, tool, "FAILED", "ACTION_UNAVAILABLE", startedAt)
            end
        end

    elseif tool == "attack" or tool == "fight" then
        local target = findTarget(inst, args)
        if target == nil or inst.components == nil or inst.components.combat == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_ATTACK_TARGET", startedAt)
        else
            inst.components.combat:SetTarget(target)
            local action = BufferedAction(inst, target, ACTIONS.ATTACK)
            if pushVanilla(inst, action) then
                beginAsync(inst, actionId, tool, startedAt, target)
            else
                inst.components.combat:SetTarget(nil)
                emitReceipt(inst, actionId, tool, "FAILED", "ACTION_UNAVAILABLE", startedAt)
            end
        end

    elseif tool == "eat" or tool == "heal" then
        local item = findEdible(inst)
        if item == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_EDIBLE_ITEM", startedAt)
        elseif inst.components ~= nil and inst.components.eater ~= nil and inst.components.eater.Eat ~= nil then
            local ok = inst.components.eater:Eat(item)
            emitReceipt(inst, actionId, tool, ok and "COMPLETED" or "UNCERTAIN",
                ok and "ATE" or "EATER_REJECTED", startedAt)
        else
            local action = BufferedAction(inst, item, ACTIONS.EAT)
            if pushVanilla(inst, action) then
                beginAsync(inst, actionId, tool, startedAt, item)
            else
                emitReceipt(inst, actionId, tool, "FAILED", "ACTION_UNAVAILABLE", startedAt)
            end
        end

    elseif tool == "craft" or tool == "place_campfire" then
        local recipeName = tool == "place_campfire" and "campfire" or tostring(args.recipe or "")
        local recipe = AllRecipes ~= nil and AllRecipes[recipeName] or nil
        if recipe == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "UNKNOWN_RECIPE", startedAt)
        else
            local ok = true
            if MakeRecipeAtPoint ~= nil then
                ok = MakeRecipeAtPoint(recipe, point, 0, inst) ~= false
            end
            emitReceipt(inst, actionId, tool, ok and "COMPLETED" or "UNCERTAIN",
                ok and "RECIPE_QUEUED" or "RECIPE_REJECTED", startedAt)
        end

    elseif tool == "cook" then
        local fire = findCampfire(inst)
        local cookAction = ACTIONS.COOK or ACTIONS.USEITEM
        if fire == nil or fire.components.stewer == nil or cookAction == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_COOKER", startedAt)
        else
            local action = BufferedAction(inst, fire, cookAction)
            if pushVanilla(inst, action) then
                beginAsync(inst, actionId, tool, startedAt, fire)
            else
                emitReceipt(inst, actionId, tool, "FAILED", "ACTION_UNAVAILABLE", startedAt)
            end
        end

    elseif tool == "add_fuel" or tool == "refuel" then
        local fire = findCampfire(inst)
        local fuelItem = findFuelItem(inst)
        if fire == nil or fire.components.fuel == nil or fuelItem == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_FIRE_OR_FUEL", startedAt)
        else
            local fuelValue = (fuelItem.components.fuel ~= nil and tonumber(fuelItem.components.fuel.fuelvalue)) or 30
            fire.components.fuel:AddFuel(fuelValue)
            inst.components.inventory:RemoveItem(fuelItem, true)
            emitReceipt(inst, actionId, tool, "COMPLETED", "FIRE_REFUELED", startedAt)
        end

    elseif tool == "equip" or tool == "unequip" then
        local inv = inst.components ~= nil and inst.components.inventory or nil
        local item = findTarget(inst, args) or (inv ~= nil and inv:FindItem(function(i)
            return args.item == nil or i.prefab == args.item
        end) or nil)
        if inv == nil or item == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_EQUIP_ITEM", startedAt)
        else
            inv:Equip(item)
            emitReceipt(inst, actionId, tool, "COMPLETED", "EQUIPPED", startedAt)
        end

    elseif tool == "sleep" or tool == "rest" then
        local bed = findTarget(inst, args)
        if bed == nil or ACTIONS.SLEEPIN == nil then
            emitReceipt(inst, actionId, tool, "FAILED", "NO_BED", startedAt)
        else
            local action = BufferedAction(inst, bed, ACTIONS.SLEEPIN)
            if pushVanilla(inst, action) then
                beginAsync(inst, actionId, tool, startedAt, bed)
            else
                emitReceipt(inst, actionId, tool, "FAILED", "ACTION_UNAVAILABLE", startedAt)
            end
        end

    elseif tool == "cancel_action" or tool == "stop" then
        if inFlight ~= nil then
            if inFlight.watcher ~= nil then inFlight.watcher:Cancel() end
            emitReceipt(inst, inFlight.actionId, inFlight.tool, "ABORTED_BY_HUMAN_TAKEOVER",
                "CANCEL_REQUESTED", inFlight.startedAt)
            inFlight = nil
        end
        inst.bufferedaction = nil
        if inst.components ~= nil and inst.components.locomotor ~= nil then
            inst.components.locomotor:StopMove()
        end
        if inst.components ~= nil and inst.components.combat ~= nil then
            inst.components.combat:SetTarget(nil)
        end
        emitReceipt(inst, actionId, tool, "COMPLETED", "CANCELLED", startedAt)

    else
        emitReceipt(inst, actionId, tool, "FAILED", "UNKNOWN_TOOL", startedAt)
    end
    return lastReceipt
end

--- 执行一份计划（最多 8 步）；plan 形如 { planId, expiresAt, actions = {{actionId,tool,args}} }。
function Actions.Execute(inst, plan)
    if type(plan) ~= "table" or type(plan.actions) ~= "table" then return 0 end
    local executed = 0
    for _, step in pairs(plan.actions) do
        if executed >= 8 then break end
        if Actions.ExecuteOne(inst, step) ~= nil then executed = executed + 1 end
    end
    return executed
end

return Actions
