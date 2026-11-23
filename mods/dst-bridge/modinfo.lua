-- Workbench DST Bridge —— Klei DST 服务器侧 all-clients mod（M7）
-- 原创实现；机制思想参考 fruitstarzero/Don-t-Starve-Together-AI-Companion (MIT)。
-- 来源：https://github.com/fruitstarzero/Don-t-Starve-Together-AI-Companion （仅思想，未复制源码）
-- 仅押 Klei 官方 653007 放开的通道：localhost TheSim:QueryServer + unsafedata/*.json 写。
name = "Workbench DST Bridge (AI Companion)"

version = 1

description = [[
服务器侧权威桥接 mod：每 2 秒向本地 sidecar (127.0.0.1:18100) 上报 DstStateSnapshot，
接收计划后用原版 BufferedAction / locomotor / combat / MakeRecipeAtPoint 执行并回传四态回执。
仅用于本地工作台 AI 共玩；需要人类在 Klei 官方页面配置 cluster_token.txt。
]]

author = "Whale Isle"

api_version = 10

-- 所有客户端都加载本 mod，但只有 TheWorld.ismastersim（专用服/主机）真正运行桥接逻辑。
all_clients = function(player)
    return true
end

configuration_options = {
    {
        name = "bridge_endpoint",
        label = "本地 sidecar 地址（必须是 localhost / 127.0.0.1）",
        options = {
            { description = "http://127.0.0.1:18100", data = "http://127.0.0.1:18100" },
        },
        default = "http://127.0.0.1:18100",
    },
    {
        name = "pair_token",
        label = "与 sidecar 配对的 token（必须非空；留空时 mod 自主待机）",
        options = {
            { description = "请在 sidecar 与 mod 两侧配置同一 token", data = "" },
        },
        default = "",
    },
    {
        name = "tick_interval",
        label = "状态上报间隔（秒）",
        options = {
            { description = "2 秒（推荐，653007 官方通道）", data = 2 },
            { description = "1 秒", data = 1 },
            { description = "5 秒（省资源）", data = 5 },
        },
        default = 2,
    },
    {
        name = "ai_player_userid",
        label = "受控角色 Klei UserID（多玩家服必填；留空=首个上线的玩家）",
        options = {
            { description = "留空", data = "" },
        },
        default = "",
    },
}
