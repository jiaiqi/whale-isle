# V2-P1-06 星露谷 AI-First 自主游玩与控制权执行闭环验证报告

- **工单**：`V2-P1-06`
- **结论口径**：`IMPLEMENTED_UNVERIFIED`（核心代码、13 项控制语义、Blueprint 17 §12 12 项仿真验收场景、`verify:gate` 7/7 与全部 4 个 Electron 45 E2E 套件实测通过；因本机无真实《星露谷物语》+ SMAPI 客户端，仍待 `[REAL-DEVICE]` 游戏内真机联调、物理 `F7` 接管与连续浸泡验收）
- **验证日期**：`2026-11-26`

## 一、AI-First 纠偏与控制权闭环实现摘要

1. **三方控制权租约与 13 项控制指令**：新增 [control-lease.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/game-bridge-mcp/src/control-lease.ts)（`GameCharacterControlLease`、`PausedBrainPlanner`、`parseControlCommand`），统一管理 `ai | human | paused | halted` 四态租约与 TTL 过期检查，覆盖 `Stop` / `Pause AI` / `Resume AI` / `Take Over` / `Release Control` / `Follow Me` / `Stay Here` / `Do This` / `Go Fish` / `Go Mine` / `Cancel Task` / `What Are You Doing?` / `Show Plan` 全部 13 项控制语义。
2. **清除默认静默规则代驾（ADR-002 D-103）**：更新 [brain-switch.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/game-bridge-mcp/src/brain-switch.ts)、[llm-planner.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/game-bridge-mcp/src/llm-planner.ts) 与 [autodrive-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/autodrive-host.ts)。缺 Key、解析连续失败或 LLM 不可用时默认进入 `'paused'` 安全停机并交由 `PausedBrainPlanner` 返回安全等待且提示主人，不再静默退回 `RulePlanner`；`allowRuleStandin` 仅保留作显式 opt-in 测试/手动模式。
3. **在飞取消、世代隔离与宿主紧急急停联动**：更新 [autodrive.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/game-bridge-mcp/src/autodrive.ts)、[v2-kernel-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/v2-kernel-host.ts) 与 [signature-widgets.tsx](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx)，补齐 `generation`/`sessionId` 过期指令拒绝（`submitScopedDirective`）、动作前置控制租约门禁、`emergencyStop` 与 V2 内核急停回调联动及 HUD `'paused'`（AI 安全暂停）/ `'rule'`（手动规则模式）状态投影。
4. **仿真剧本与浸泡夹具校准**：更新 [stuck-scenario.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/tools/mock-harness/src/stuck-scenario.ts)、`S02` / `S06` 回归剧本及 [cli.spec.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/tools/soak-real/src/cli.spec.ts)（修复 `chatReplies[step++]` 越界夹紧导致第 17 日误消费复盘 JSON 触发停机的假负载问题）。

## 二、实测命令与结果

| 检查项 | 证据等级 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| 宿主编译与前端资源构建 | `[E2E-HOST]` | `pnpm --filter @workbench/desktop-host build` | exit 0（`main / preload / pet-stage / director` 全通过，CSS 41ms） |
| 仓库全量自动化门禁 | `[SIMULATION]` + 静态门禁 | `pnpm verify:gate` | **7/7 PASS**（TS `strict` + `dependency-cruiser` + Python `ruff/mypy --strict` + 270 源文件零违规 + 0 高危/严重漏洞 + 5 Lua `luac -p` + 全量 Vitest/Pytest 分支覆盖率 ≥90% 含 `S01–S07` 与 `ai-first-v2.spec.ts` + Gate 4 回环 0.4s） |
| 浸泡会话夹具单测 | `[SIMULATION]` | `pnpm exec vitest run --coverage.enabled=false tools/soak-real/src/cli.spec.ts` | **33/33 PASS**（2.42s） |
| 透明窗 / V2 内核 / Obsidian UI E2E | `[E2E-HOST]` | `pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts apps/desktop-host/e2e/v2-obsidian-ui.e2e.spec.ts` | **3/3 PASS**（7.07s） |
| 中控台全链路 UI E2E | `[E2E-HOST]` | `pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/ui.e2e.spec.ts` | **8/8 PASS**（12.53s） |
| 真实《星露谷》+ SMAPI 客户端联调 | `[REAL-DEVICE]` | 待真机环境人工开游联调 | **UNVERIFIED**（本环境无星露谷客户端进程与 SMAPI 运行时；游戏内实按 `F7` 接管与真机连续浸泡待补） |

## 三、2026-11-26 真机补充（`[REAL-DEVICE]`，经中控台 IPC/CDP 驱动，非物理 F7）

> 环境：macOS 27.2 / Apple Silicon；Stardew Valley 1.6.15 + SMAPI 4.5.2 + BlindWhaleFarmer 1.1.27（已含 `playerInControl` 远程设置）+ WhaleIsleAvatar 0.3.0-dev.1。
> 驱动方式：`electron --remote-debugging-port=9333` 启动 `apps/desktop-host/dist/main/index.js`，CDP `Runtime.evaluate` 调用 `window.directorBridge.*`——与中控台按钮走同一条 preload/IPC 通道，因此可作执行层证据，但不等于「人手动点击 UI」。

| 检查项 | 实测结果 |
| --- | --- |
| 中控台启动器拉起真实游戏 | `stardewLaunch({strategy:'smapi'})` → `launching`（pid 71062）→ **`ready` 13.98s**，`saveLoadRequested=true`，`attempts=6`，`message="BWF MCP 已就绪：get_state 正常应答"`；安装探测四项全 `true` |
| 自主驾驶启动 | `autodriveStart('stardew')` → `{ok:true}`，`autodriveStatus().running=true`，事件流出现 `state` |
| 主人接管（游戏侧同步） | `autodriveSetHumanControl(true)` → `humanControl=true`，`gameSync={applied:true, reachable:true, supported:true, playerInControl:true}` —— 证明装好的 BWF 确实接受 `playerInControl` 远程设置 |
| 交还摘要 | `autodriveSetHumanControl(false)` → 摘要 **「主人接管了 6 秒：游戏状态没有可见变化。」**（无变化时如实说无变化），`gameSync.playerInControl=false`，事件流出现 `human-control active=true/false` 两条 |
| P0 急停执行层 | `v2EmergencyHalt('CDP 真机验收：P0 急停')` → `halted=true`、`controlMode=manual_takeover`、**`autodriveStatus().running=false`**（真的停了，不只是改 UI） |
| 急停恢复 | `v2Resume('autonomous')` → `halted=false`、`controlMode=autonomous` |

**仍未验证（保持 `IMPLEMENTED_UNVERIFIED`）**：

- 物理按 `F7` 触发的接管，以及中控台 / 托盘 / 桌宠右键三处开关的状态同步（需人在游戏内实按）。
- 13 项控制语义逐项手动点按（本次只覆盖启动、接管、交还、急停、恢复 5 条）。
- 连续 1 个游戏日 0 卡死的浸泡观察与 `soak-real` 长跑。
- 交还摘要在「接管期间确有变化」时的文案质量（本次接管 6 秒无动作）。
