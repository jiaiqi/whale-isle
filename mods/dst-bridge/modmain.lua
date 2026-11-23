-- Workbench DST Bridge 主入口（M7 / T-M7-D3）：服务器侧权威，all-clients 加载但仅主机/专用服执行。
-- 原创实现；机制参考 fruitstarzero/Don-t-Starve-Together-AI-Companion（MIT，仅思想未复制源码）。
-- 官方通道约束：Klei 651414 收紧沙盒；653007 放开 localhost QueryServer + unsafedata/*.json 写。
local Ipc = modrequire("scripts/bridge/ipc")

-- 客户端/监听端只加载资源，不运行桥接逻辑（side effects 只在 mastersim 发生）。
if TheWorld == nil or not TheWorld.ismastersim then return end

local endpoint = GetModConfigData("bridge_endpoint") or "http://127.0.0.1:18100"
local token = GetModConfigData("pair_token") or ""
local tickInterval = tonumber(GetModConfigData("tick_interval")) or 2
local aiUserid = GetModConfigData("ai_player_userid") or ""
local aiUserids = {}
for id in string.gmatch(aiUserid, "[^,%s]+") do
    aiUserids[id] = true
end
if tickInterval < 1 then tickInterval = 2 end

Ipc.Init({ endpoint = endpoint, token = token })

local claimed = false

AddPlayerPostInit(function(inst)
    if inst == nil or not inst:HasTag("player") then return end
    -- 多玩家服可配置逗号分隔的多个受控 UserID；留空时只接管第一个上线的玩家（专用服典型形态）。
    if aiUserid ~= "" then
        if inst.userid == nil or aiUserids[inst.userid] ~= true then return end
    else
        if claimed then return end
        claimed = true
    end

    if inst._wb_bridge_task ~= nil then return end

    local task = inst:DoPeriodicTask(tickInterval, function()
        if not inst:IsValid() then return end
        if inst.components ~= nil and inst.components.health ~= nil and inst.components.health:IsDead() then
            return -- 死亡期间不做动作（回执铁律：不能以台词替代真实状态）
        end
        Ipc.Tick(inst, inst.userid or "default")
    end)
    inst._wb_bridge_task = task
    inst:ListenForEvent("onremove", function()
        if task ~= nil then task:Cancel() end
        inst._wb_bridge_task = nil
    end)

    print("[wb-dst-bridge] 已接管玩家", inst.userid or "(unknown)", "周期", tickInterval, "s")
end)

-- 可选 RPC：管理端可即时切换"人类接管"；主用通道仍是 sidecar 写 control 哨兵文件。
-- 仅接受管理员或显式配置的受控用户，防止普通玩家通过 RPC 操纵 AI。
AddModRPCHandler("wb_dst_bridge", "takeover", function(player, active)
    if player == nil then return end
    local allowed = false
    local ok, isAdmin = pcall(function()
        return TheNet ~= nil and TheNet.IsAdmin ~= nil and TheNet:IsAdmin(player.userid) == true
    end)
    allowed = ok and isAdmin == true
    if not allowed and aiUserid ~= "" then allowed = player.userid == aiUserid end
    if allowed then
        Ipc.SetTakeover(active == true)
        print("[wb-dst-bridge] RPC 接管", tostring(active))
    end
end)
