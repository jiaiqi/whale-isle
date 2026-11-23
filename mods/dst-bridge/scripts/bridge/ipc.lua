-- DST ↔ sidecar IPC（M7 / T-M7-D3）：官方通道 + 能力探测 + 文件降级。
-- 依据：Klei 2025-01 Game Update 651414 收紧沙盒；2025-02 653007 重新放开
--   · TheSim:QueryServer 允许 localhost / 127.0.0.1
--   · io.open 允许写 unsafedata/*.json（.json 在扩展名白名单）
--   · 专用服 -allow_ioopenwrite_sandbox_escape
-- 只押上述官方通道；任何公网 URL / loadstring / 任意命令执行均被拒绝。
-- 主通道：每 tick POST {token, snapshot} 到 sidecar /v1/tick，响应即计划（fruitstarzero MIT 机制思想）。
-- 降级通道：写 unsafedata/dst_bridge_snapshot.json，轮询 unsafedata/dst_bridge_plan.json。
local Ipc = {}

local StateExport = modrequire("scripts/bridge/state_export")
local Actions = modrequire("scripts/bridge/actions")

local SNAPSHOT_FILE = "unsafedata/dst_bridge_snapshot.json"
local PLAN_FILE = "unsafedata/dst_bridge_plan.json"
local CONTROL_FILE = "unsafedata/dst_bridge_control.json"
local MAX_FAILURES_BEFORE_FALLBACK = 3

local endpoint = "http://127.0.0.1:18100"
local token = ""
local mode = "none" -- "http" | "file" | "none"
local tickBusy = {}
local failures = 0
local lastPlanId = nil

local function nowMs()
    return (os.time() or 0) * 1000
end

local function log(...)
    print("[wb-dst-bridge]", ...)
end

local function safeDecode(text)
    if type(text) ~= "string" or text == "" then return nil end
    local ok, data = pcall(json.decode, text)
    if ok and type(data) == "table" then return data end
    return nil
end

local function safeWrite(path, text)
    local ok, file = pcall(io.open, path, "w")
    if not ok or file == nil then return false end
    local written, err = file:write(text)
    file:close()
    return written ~= nil and err == nil
end

local function safeRead(path)
    local ok, file = pcall(io.open, path, "r")
    if not ok or file == nil then return nil end
    local content = file:read("*a")
    file:close()
    return content
end

local function isLocalEndpoint(url)
    if type(url) ~= "string" then return false end
    return url:match("^http://127%.0%.0%.1:%d+") ~= nil
        or url:match("^http://localhost:%d+") ~= nil
end

local function applyPlan(inst, plan)
    if type(plan) ~= "table" then return false end
    if plan.token ~= nil and plan.token ~= token then
        log("计划 token 不匹配，丢弃")
        return false
    end
    if type(plan.expiresAt) == "number" and plan.expiresAt > 0 and plan.expiresAt < nowMs() then
        log("计划已过期，丢弃")
        return false
    end
    if plan.planId ~= nil and plan.planId == lastPlanId then
        return false -- 去重：同一计划不重复执行
    end
    lastPlanId = plan.planId
    local count = Actions.Execute(inst, plan)
    if count > 0 then log("执行计划", tostring(plan.planId), count, "步") end
    return true
end

local function onFailure(reason)
    failures = failures + 1
    log("IPC 失败（" .. tostring(reason) .. "）连续次数=" .. tostring(failures))
    if failures >= MAX_FAILURES_BEFORE_FALLBACK and mode == "http" then
        mode = "file"
        failures = 0
        log("主通道不可达 → 降级 unsafedata/*.json 文件轮询")
    end
end

local function onSuccess()
    failures = 0
end

local function readControl()
    local data = safeDecode(safeRead(CONTROL_FILE))
    if data == nil or type(data.takeover) ~= "boolean" then return end
    if data.takeover ~= Actions.IsTakeover() then
        log("控制台接管切换 →", tostring(data.takeover))
        Actions.SetTakeover(data.takeover)
    end
end

local function fileTick(inst, snapshot)
    if not safeWrite(SNAPSHOT_FILE, json.encode(snapshot)) then
        onFailure("SNAPSHOT_WRITE_DENIED")
        return
    end
    local plan = safeDecode(safeRead(PLAN_FILE))
    if plan ~= nil then
        pcall(os.remove, PLAN_FILE)
        if applyPlan(inst, plan) then onSuccess() else onFailure("PLAN_REJECTED") end
    else
        onSuccess() -- 文件通道本身可用，只是暂无计划
    end
end

--- 初始化：能力探测在 mod 加载时完成，运行期只消费探测结果（运行时安全锁）。
function Ipc.Init(options)
    options = options or {}
    endpoint = options.endpoint or endpoint
    token = options.token or ""
    StateExport.SetControlProvider(function() return Actions.GetAuthority() end)
    StateExport.SetReceiptProvider(function() return Actions.ConsumeReceipt() end)

    if token == "" then
        mode = "none"
        log("pair_token 未配置：mod 自主待机（只采集状态，不下发动作）")
        return
    end
    if not isLocalEndpoint(endpoint) then
        mode = "file"
        log("端点非 localhost/127.0.0.1（653007 限制）→ 直接走文件通道")
        return
    end
    if TheSim ~= nil and TheSim.QueryServer ~= nil then
        mode = "http"
        log("主通道就绪：" .. endpoint .. "/v1/tick")
        return
    end
    if safeWrite(SNAPSHOT_FILE, "{}") then
        mode = "file"
        pcall(os.remove, SNAPSHOT_FILE)
        log("QueryServer 不可用 → 文件通道（unsafedata/*.json）")
    else
        mode = "none"
        log("QueryServer 与 unsafedata 写均不可用 → mod 自主待机")
    end
end

function Ipc.GetMode()
    return mode
end

function Ipc.SetTakeover(active)
    Actions.SetTakeover(active)
end

--- 一个上报周期：读控制台接管哨兵 → 导出快照 → 按能力发送并应用计划。
function Ipc.Tick(inst, agentId)
    agentId = agentId or "default"
    if tickBusy[agentId] or mode == "none" then return end
    tickBusy[agentId] = true
    readControl()
    local ok, snapshot = pcall(StateExport.Build, inst)
    if not ok or type(snapshot) ~= "table" then
        tickBusy[agentId] = nil
        onFailure("SNAPSHOT_BUILD_FAILED")
        return
    end

    if mode == "file" then
        local okTick, err = pcall(fileTick, inst, snapshot)
        tickBusy[agentId] = nil
        if not okTick then onFailure("FILE_TICK_ERROR: " .. tostring(err)) end
        return
    end

    -- agentId 让同一 sidecar / 专用服能区分多个逻辑玩家；单玩家时向后兼容 default。
    local body = json.encode({ token = token, agentId = agentId, snapshot = snapshot })
    local okQuery, err = pcall(TheSim.QueryServer, TheSim, endpoint .. "/v1/tick", function(result, isok)
        tickBusy[agentId] = nil
        if not isok or type(result) ~= "string" then
            onFailure("QUERYSERVER_ERROR")
            return
        end
        local plan = safeDecode(result)
        if plan == nil then
            onFailure("PLAN_DECODE_FAILED")
            return
        end
        if applyPlan(inst, plan) then onSuccess() else onFailure("PLAN_REJECTED") end
    end, "POST", body)
    if not okQuery then
        tickBusy[agentId] = nil
        onFailure("QUERYSERVER_EXCEPTION: " .. tostring(err))
    end
end

return Ipc
