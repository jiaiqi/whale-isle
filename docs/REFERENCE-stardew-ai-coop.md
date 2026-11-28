# REFERENCE — stardew-ai-coop（KotokaYuzu/stardew-ai-coop）复评档案

> 仓库：https://github.com/KotokaYuzu/stardew-ai-coop ｜ 许可证：**MIT**（`reference-clones/stardew-ai-coop/LICENSE` L1–27，`Copyright (c) 2026 KotokaYuzu`；SMAPI LGPL-3.0；`agent/assets/README.md` 立绘仅限本机自用）｜ 主语言：C#（SMAPI `CoopLink` v0.4.14）+ Python 3.13（零三方依赖控制台/大脑）
> 注意：本仓库 `main` 分支源码停留在 `0.4.14 / 协议 v5`，与 README 宣称的 `v0.5.20` 存在版本差（`README.md` L15、`AI必读.md` L9）。
> 分析方式：只读本地克隆 `reference-clones/stardew-ai-coop/` 全仓源码与文档（未执行任何脚本）。分析日期：2026-11-28

---

## 1. 结论摘要

一套面向“**本机双开真人 Host + AI Guest 局域网联机**”的陪伴型系统，虽然在 IPC（文件轮询）、平台兼容性（强依赖 Windows DPAPI + PowerShell）和长距离寻路（仅导 13×13 视野）上存在明显上限，但它在**大小脑异步分层、UI 防点错令牌、AI 防嘴硬谎报、游戏修改房主聊天鉴权与有界记忆** 5 个工程设计上极具启发。

## 2. 采用什么（纯思想借鉴，未复制源码）

- **反幻觉 `MenuToken`（SHA256 UI 状态校验）**（`AgentActions.cs` L95–109）：对当前菜单实例 + 文本计算短哈希，按钮点击必须核对一致，防止界面切换竞态误点。
- **AI 防嘴硬谎报与视觉自检门禁**：
  - `agent_ground_reply` / `AGENT_SYSTEM`（`agent_runtime.py` L22–25, L440）：未在最新状态/回执看到真实成功证据前，禁止自称已拆包/已存档/已送达（已在 Batch 8 `llm-prompt.ts` 吸收为明示红线）。
  - `test_vision`（`controller.py` L879–912）：视觉开关激活前跑“左红右蓝”物理辨色验证，不通过则禁止识图。
- **异步反射 + 可选轻量小脑 JEV**：Python 轮询即刻触发天气/23:00 犯困/单次掉血 ≥25/4 格突现怪物反射，高危瞬间不再干等云端 LLM（`agent_runtime.py` L235–300）。
- **蛇形地块遍历与失败格拉黑**（`skills.py` L74–100, L493–522）：`pos[1] % 2` 交替方向减少折返，同一坐标连续失败 4 次自动拉黑。
- **256KB 有界结构化记忆 + 凭据脱敏**（`memory_store.py` L15–100）：按体积上限与旧时间戳淘汰并正则剔除 `sk-`/`api_key`/`bearer`。
- **`GameEdits` 房主聊天原文锁**（`GameEdits.cs` L101–104）：危险修改（金币/天气/技能/时间）须校验最近聊天日志原文存在匹配指令，防止大模型私自开挂。
- **`KeepItems` 昏倒保护兜底**：允许在测试/陪玩托管档中于 `performPassOut` 后退还昏倒丢失钱物（仅作可选娱乐保护灵感）。

## 3. 不采用什么（为什么）

- **原子文件轮询 IPC**（6 tick 扫命令文件 / 12 tick 重写 `state.json` + `PermissionError` 退避）：延迟高且易遇文件锁竞态，远不如我们的 WS + JSON-RPC 总线与 HTTP MCP。
- **Windows DPAPI (`crypt32.dll`) + PowerShell 脚本**：无法在 macOS 上运行，且 Mixin 六重继承过重。
- **13×13 窄视野 + 原生 `PathFindController`**：无全图规划与矿洞炸石寻路，长程自动化能力明显弱于 BWF A* + 跨图 BFS。

## 4. 复评记录

| 日期 | 结论变化 | 原因 |
| --- | --- | --- |
| 2026-11-28 | 首次建档；确认为 MIT（`CoopLink` 源码滞后至 0.4.14）；沉淀 `MenuToken`、`agent_ground_reply`、蛇形遍历、256KB 脱敏记忆与房主聊天锁机制 | 只读审计本地克隆 `reference-clones/stardew-ai-coop` |
