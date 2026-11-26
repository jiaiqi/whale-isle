# CURRENT — V2 跨会话唯一交接检查点

> 任何新 AI 会话接手前只看本文件与 [ROADMAP.md](./ROADMAP.md)，严禁依赖对话历史猜测进度。每次完成或阻塞工单时必须同步更新。

## 1. 当前进度锚点

- **当前分支**：`feat/whale-isle-v2`（已发布并推送至 `origin/feat/whale-isle-v2`；已完成 P0 & P1、P2 全部 8 单、`V2-P3-01`、`ADR-003` Tidepaper 主视觉升级、`V2-P3-02`、**`V2-P3-03`**，并已合入 `feat/stardew-launcher`（`V2-P3-06` 一键启动器）与 `feat/tidepaper-v3.1`（Tidepaper v3.1 外壳 + 空状态插画））
- **上一已完成/交接工单**：`V2-P3-03` — **受控 Browser Use 与 Computer Use（Per-Character Profile 隔离 + `ComputerUseLease` 单主控互斥）**（状态：`IMPLEMENTED_UNVERIFIED`）
- **当前唯一激活工单**：无（`V2-P3-04` Digital Life L1 已以 `IMPLEMENTED_UNVERIFIED` 封口，A–F 六子单全绿，证据 [P3-04-social-life-verification.md](./evidence/P3-04-social-life-verification.md)；下一候选 `V2-P3-05` 多被动桌宠同屏，或先清真机验收积压）
- **同步 UI/设计基准约束（`ADR-003`）**：已上线 `design/tidepaper/` 默认主题令牌（`tidepaper` + 晨雾/夜潮 + 5 强调色），并在顶栏提供 `obsidian-tide` / `tide-deep` 实时切换及 `V2-P2`/`V2-P3-01`/`V2-P3-02`/`V2-P3-03` 实盘面板（[P3-tidepaper-ui-verification.md](./evidence/P3-tidepaper-ui-verification.md)）。
- **输入抢占口径（`ADR-004`）**：`ComputerUseLease` 只管 OS 合成输入/前台桌面控制；用户物理输入撤销它。`GameCharacterControlLease` 不受普通键鼠影响，只认 F7/UI 开关/P0 急停（T-M6-73）。P0 急停同时撤销两者。
- **本地客户端常驻约定**：用户要求每次完成任务后保持本地桌面端运行（`pnpm --filter @workbench/desktop-host start`）以便随时测试；推进新工单重新构建后务必保持客户端处于运行状态。

## 2. 本次 `V2-P3-03` 实际交付与验证证据

- **契约先行** [packages/shared-protocol/src/browser-computer.ts](../../packages/shared-protocol/src/browser-computer.ts) & [index.ts](../../packages/shared-protocol/src/index.ts)：新增账号/Profile、`ComputerUseLease`、浏览器任务/runner report/人机交接、P5 一次性 token、OS 输入执行器与用户输入监控状态、`BrowserComputerSnapshot` 契约（Zod 4 默认值使用 `.prefault({})`）。
- **核心安全与运行时** [automation-security.ts](../../packages/runtime-core/src/automation-security.ts)、[browser-runner.ts](../../packages/runtime-core/src/browser-runner.ts)、[human-input-monitor.ts](../../packages/runtime-core/src/human-input-monitor.ts)、[input-executor.ts](../../packages/runtime-core/src/input-executor.ts)：`AccountVault` 掩码/轮换/级联删除与元数据落盘、Per-Character Browser Profile 路径越界拒绝、`ComputerUseLeaseManager` 设备级单主控 + TTL/心跳 + 人工抢占自动恢复 + 急停、`DeterministicBrowserRunner` 确定性动作与逐步 guard、CAPTCHA `awaiting_human`、页面注入只记录不提权、`powerMonitor` idle 轮询与合成事件排除、feature flag 默认关闭的 OS 输入执行器骨架（真实注入 `PENDING`）。
- **宿主与 UI 接线**：[v2-kernel-host.ts](../../apps/desktop-host/src/main/v2-kernel-host.ts)、[electron-browser-engine.ts](../../apps/desktop-host/src/main/electron-browser-engine.ts)、[preload/index.ts](../../apps/desktop-host/src/preload/index.ts)、[bridge.ts](../../apps/desktop-host/src/renderer/director/bridge.ts)、[signature-widgets.tsx](../../apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx)、[App.tsx](../../apps/desktop-host/src/renderer/director/App.tsx) 与 [life-console-view.tsx](../../apps/desktop-host/src/renderer/director/views/life-console-view.tsx)：注册 `v2:auto-*` IPC、Electron 隐藏窗口确定性引擎、HUD 游戏/桌面双租约胶囊、生命总览 P3-03 操作面板。
- **强制回归**：[input-preemption-scope.spec.ts](../../apps/desktop-host/src/main/input-preemption-scope.spec.ts)：星露谷 AI 自主模式下注入用户输入，游戏租约保持 `owner='ai'`，`ComputerUseLease` 被撤销；合成事件不误伤；P0 急停双撤销。
- **真实验证**：P3-03 专项单测 **22/22 PASS**、runtime-core 包级 **90.16% 分支**（Statements 97.37% / Functions 100% / Lines 99.02%）、`desktop-host build` exit 0、`pnpm verify:gate` **7/7 PASS**、Electron 45 E2E Part 1 **3/3 PASS** + Part 2 `ui.e2e` **9/9 PASS**，详见证据 [P3-browser-computer-use-verification.md](./evidence/P3-browser-computer-use-verification.md)。
- **为什么不是 `DONE`**：真实 CGEvent/SendInput 注入未接线（3c feature flag 默认关闭，仅 dry-run）、macOS TCC 打包态授权与真实社交站点风控/验证码样式待 `[REAL-DEVICE]`。

## 3. 下一步行动（Next Agent 从这里接手）

1. **先清真机验收积压，再开新工单**：`V2-P1-06` / `V2-P2-01` / `V2-P2-06` 三单只需要星露谷 + SMAPI（本机已具备），按 [REAL-DEVICE-CHECKLIST.md](./evidence/REAL-DEVICE-CHECKLIST.md) 第一批执行，通过后把对应工单从 `IMPLEMENTED_UNVERIFIED` 改为 `DONE` 并补 `[REAL-DEVICE]` 段落。
2. 认领 **`V2-P3-04`（Digital Life L1：自主浏览、多模态内容理解、兴趣形成与日常调度）**：查阅 `docs/v2/blueprint/08-Digital-Life社交浏览与记忆.md`、[REQUIREMENTS.md](./REQUIREMENTS.md)（`REQ-SOC-01`）、[ADR-004](./adr/ADR-004-input-preemption-scope.md)，复用本工单的 `BrowserRuntime` / `AccountVault` / `BrowserProfileMgr` / 确定性 runner 与 `awaiting_human` 交接，禁止接入任何打码/验证码绕过服务，网页内容一律按数据处理。
3. 每次完成任务后同步提交、推送分支，并确认本地桌面端处于运行状态。

## 4. 2026-11-26 合流记录（两条支线已回流主线）

- **`feat/stardew-launcher` → V2**（合并提交 `19f2258`）：`V2-P3-06` 一键启动器 + `game-health` 「标题画面误判 online」真实缺陷修复；真机证据 [P3-stardew-launcher-verification.md](./evidence/P3-stardew-launcher-verification.md)。
- **`feat/tidepaper-v3.1` → V2**（合并提交 `0878d91`）：Tidepaper v3.1 外壳、三层租约 HUD 与急停横幅、中控台 IA 重组；补完空状态插画接入（对话 / 游戏回执 / 未开播 / 记忆无命中 / 急停）与 `buildComputerLeaseView()` 五态映射。
- 合并后 `pnpm verify:gate` **7/7 PASS**，`ui.e2e` **9/9**、`v2-obsidian-ui.e2e` **1/1** PASS。
- 合并期间发现的环境坑：`-launch` worktree 残留的 Electron 占着 `e2e-profile` 的 LevelDB 锁，会让 `ui.e2e` 的服务商页用例超时假失败；跑 E2E 前先 `pgrep -f e2e-profile` 清理。
