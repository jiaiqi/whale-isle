# CURRENT — V2 跨会话唯一交接检查点

> 任何新 AI 会话接手前只看本文件与 [ROADMAP.md](./ROADMAP.md)，严禁依赖对话历史猜测进度。每次完成或阻塞工单时必须同步更新。

## 1. 当前进度锚点

- **当前分支**：`feat/whale-isle-v2`（已发布并推送至 `origin/feat/whale-isle-v2`；已完成 P0 & P1、P2 全部 8 单、`V2-P3-01`、`ADR-003` Tidepaper 主视觉升级及 **`V2-P3-02`**）
- **上一已完成/交接工单**：`V2-P3-02` — **LifeRuntime 驱动的直播中控与 OBS 舞台**（状态：`IMPLEMENTED_UNVERIFIED`）
- **当前唯一激活 `NEXT` 工单**：**`V2-P3-03` — 受控 Browser Use 与 Computer Use（Per-Character Profile 隔离 + `ComputerUseLease` 单主控互斥）**
- **同步 UI/设计基准约束（`ADR-003`）**：已上线 `design/tidepaper/` 默认主题令牌（`tidepaper` + 晨雾/夜潮 + 5 强调色），并在顶栏提供 `obsidian-tide` / `tide-deep` 实时切换及 `V2-P2`/`V2-P3-01`/`V2-P3-02` 实盘面板（[P3-tidepaper-ui-verification.md](./evidence/P3-tidepaper-ui-verification.md)）。
- **本地客户端常驻约定**：用户要求每次完成任务后保持本地桌面端运行（`pnpm --filter @workbench/desktop-host start`）以便随时测试；推进新工单重新构建后务必保持客户端处于运行状态。

## 2. 本次 `V2-P3-02` 实际交付与验证证据

- **契约先行** [packages/shared-protocol/src/live.ts](../../packages/shared-protocol/src/live.ts) & [index.ts](../../packages/shared-protocol/src/index.ts)：新增平台连接态、曲库排麦队列、礼物/关注合并批次、OBS 舞台载荷与下播摘要契约。
- **核心直播运行时** [packages/live-stream-hub/src/live-runtime.ts](../../packages/live-stream-hub/src/live-runtime.ts)：交付 `checkLivestreamSongRights`（四重版权拦截 `dev_only_non_commercial` / `unlicensed`）、`probeLivePlatformEndpoint`（绝不虚构观众数/在线态，异常降级标 `degraded`）、`LiveRuntimeV2`（弹幕 Guard 去重、礼物合并防爆麦、OBS 舞台同步与急停拦截）。
- **宿主与 UI 接线**：[v2-kernel-host.ts](../../apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](../../apps/desktop-host/src/preload/index.ts)、[bridge.ts](../../apps/desktop-host/src/renderer/director/bridge.ts) 与 [life-console-view.tsx](../../apps/desktop-host/src/renderer/director/views/life-console-view.tsx) 接入 7 路 `v2:live-*` IPC 与直播中控按钮。
- **真实验证**：`live-runtime.spec.ts` **3/3 PASS**（`91.66%` 分支 / `100%` 函数与行）、`desktop-host build` exit 0、`pnpm verify:gate` **7/7 PASS**、Electron 45 E2E Part 1 **3/3 PASS** + Part 2 `ui.e2e` **8/8 PASS**，详见证据 [P3-live-runtime-obs-verification.md](./evidence/P3-live-runtime-obs-verification.md)。
- **为什么不是 `DONE`**：尚未连入真实抖音/B站/YouTube 测试直播间与真实 OBS Studio 客户端进行线上实流测试。

## 3. 下一步行动（Next Agent 从这里接手）

1. 认领 **`V2-P3-03`（受控 Browser Use 与 Computer Use：Per-Character Profile 隔离 + `ComputerUseLease` 单主控互斥）**：查阅 `docs/v2/blueprint/11-浏览器与桌面操控安全.md`、`REQUIREMENTS.md`（`REQ-SEC-02` / `REQ-AUTO-01`），交付 `AccountVault` / `BrowserProfile` 隔离、确定性脚本优先、`ComputerUseLease`（设备级单主控 + 用户键鼠抢占）、验证码/P5 人机交接与门禁验证，按原子工单（≤ 8 业务源码文件）推进。
2. 每次完成任务后同步提交、推送分支，并确认本地桌面端处于运行状态。
