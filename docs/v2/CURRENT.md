# CURRENT — V2 跨会话唯一交接检查点

> 任何新 AI 会话接手前只看本文件与 [ROADMAP.md](./ROADMAP.md)，严禁依赖对话历史猜测进度。每次完成或阻塞工单时必须同步更新。

## 1. 当前进度锚点

- **当前分支**：`feat/whale-isle-v2`（P0 & P1 全部核心工单、以及 **P2 全部 8 个工单 `V2-P2-01`..`V2-P2-08`** 均已交付验证闭环，即将进入 P3）
- **上一已完成/交接工单**：`V2-P2-08` — **真实星露谷人机联机协作（`CoopRuntime` v1）**（状态：`IMPLEMENTED_UNVERIFIED`）
- **当前唯一激活 `NEXT` 工单**：**`V2-P3-01` — 统一表演系统（Sing Engine SVS/SVC + 舞蹈 + 歌词时钟 + 2D/3D StageRuntime）**
- **同步 UI/设计基准约束（`ADR-003`）**：[design/tidepaper/](../../design/tidepaper/) 为 V2 首选 UI/UX 参考基线（`SPEC.md` + 25 页原型），Obsidian Tide / Tide Deep / Obsidian v4 保留为可选主题；渐进落地时须保留现有 React/IPC 真实绑定与诚实阶段标注。

## 2. 本次 `V2-P2-08` 实际交付与验证证据

- **契约先行** [packages/shared-protocol/src/coop.ts](../../packages/shared-protocol/src/coop.ts) & [index.ts](../../packages/shared-protocol/src/index.ts)：新增房间/成员、独立控制租约、任务板、资源防误卖预留、Mod 兼容预检与断线恢复快照契约。
- **`CoopRuntimeV1` 与兼容检查器** [packages/game-bridge-mcp/src/coop-runtime.ts](../../packages/game-bridge-mcp/src/coop-runtime.ts)：实现成员独立 `GameCharacterControlLease` 与 `TeamBlackboard` 联动、原子资源锁任务启动/交接/`UNCERTAIN` 阻断回执、`sell_forbidden`/`keep` 禁售门禁、`evaluateCoopModsCompatibility` 与心跳超时/宽限重连/超时释放锁防死锁状态机。
- **宿主接线**：[v2-kernel-host.ts](../../apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](../../apps/desktop-host/src/preload/index.ts)、[bridge.ts](../../apps/desktop-host/src/renderer/director/bridge.ts) 接入 8 路 `v2:coop-*` IPC（含 `@workbench/stardew-mods` 本机实盘扫盘）与 P0 急停联动。
- **真实验证**：`coop-runtime.spec.ts` **5/5 PASS**（100% Stmts/Funcs/Lines, 90% Branch）、`desktop-host build` exit 0、`pnpm verify:gate` **7/7 PASS**、Electron 45 E2E Part 1 **3/3 PASS** + Part 2 `ui.e2e` **8/8 PASS**，详见证据 [P2-coop-runtime-v1-verification.md](./evidence/P2-coop-runtime-v1-verification.md)。
- **为什么不是 `DONE`**：尚未启动双端真实《星露谷》+ SMAPI 客户端进行真机联机游玩验收。

## 3. 下一步行动（Next Agent 从这里接手）

1. 检查并认领 **`V2-P3-01`（统一表演系统：Sing Engine SVS/SVC + 舞蹈 + 歌词时钟 + 2D/3D StageRuntime）**：先查阅 `packages/voice-runtime/src/`、`packages/pet-renderer/src/`、`services/audio-ai-worker/` 与 `docs/v2/blueprint/05-角色人格声音与表演系统.md` / `09-直播舞台音乐与互动.md`、`REQUIREMENTS.md` (`REQ-VOX-02` / `REQ-PERF-01` / `REQ-EMB-02`)，按原子工单（≤ 8 业务源码文件）交付可测闭环。
2. 保持全部 gate（`pnpm verify:gate` 7/7 + Electron 45 E2E 顺序全绿）与诚实验收口径。
