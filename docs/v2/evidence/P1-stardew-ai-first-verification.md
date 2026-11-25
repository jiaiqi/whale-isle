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
