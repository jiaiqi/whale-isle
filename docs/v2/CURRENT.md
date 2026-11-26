# CURRENT — V2 跨会话唯一交接检查点

> 任何新 AI 会话接手前只看本文件与 [ROADMAP.md](./ROADMAP.md)，严禁依赖对话历史猜测进度。每次完成或阻塞工单时必须同步更新。

## 1. 当前进度锚点

- **当前分支**：`feat/whale-isle-v2`（P0 & P1 核心、**P2 全部 8 个工单**、以及 P3 首单 **`V2-P3-01`** 已交付验证闭环）
- **上一已完成/交接工单**：`V2-P3-01` — **统一表演系统**（`IMPLEMENTED_UNVERIFIED`）+ **Tidepaper（潮汐纸）主基线 UI/UX 升级与 P2/P3 实盘控制台接线**（`REQ-UI-01 DONE`）
- **当前唯一激活 `NEXT` 工单**：**`V2-P3-02` — LifeRuntime 驱动的直播中控与 OBS 舞台（真实平台流接入 + 曲库版权门禁）**
- **同步 UI/设计基准约束（`ADR-003`）**：已上线 `design/tidepaper/` 默认主题令牌（`tidepaper` + 晨雾/夜潮 + 5 强调色），并在顶栏提供 `obsidian-tide` / `tide-deep` 实时切换及 `V2-P2`/`V2-P3-01` 实盘面板（[P3-tidepaper-ui-verification.md](./evidence/P3-tidepaper-ui-verification.md)）。
- **本地客户端常驻约定**：用户要求每次完成任务后保持本地桌面端运行（`pnpm --filter @workbench/desktop-host start`）以便随时测试；推进新工单导致源码改动并重新构建前，如需重启加载新产物，务必重启保持客户端处于运行状态。

## 2. 本次 `V2-P3-01` 实际交付与验证证据

- **契约先行** [packages/shared-protocol/src/voice.ts](../../packages/shared-protocol/src/voice.ts)：新增歌唱权校验（song/accompaniment/lyrics/voiceModelAuthorized）、SVS/SVC、双语 LRC 时钟、舞蹈编排、语音沉默决策、6 层优先级仲裁与 `StageRuntime` 跨维化身契约。
- **歌唱与表演总控** [packages/voice-runtime/src/performance.ts](../../packages/voice-runtime/src/performance.ts)：交付 `evaluateSongRights`（拦截 `unlicensed`/`dev_only_non_commercial` 入公开直播与商用）、`parseBilingualLrc` / `LyricsClockSync`、`SingEngine`（严格区别 SVS/SVC 与普通 TTS）、`PerformanceDirector`（6 层仲裁 + 自然沉默权 + `AudioMixer` 并发唱伴音效）。
- **跨维度舞台化身** [packages/pet-renderer/src/stage-runtime.ts](../../packages/pet-renderer/src/stage-runtime.ts)：交付 `Desktop2dStageAdapter` / `Live2dStageAdapter` / `Vrm3dStageAdapter` 与 `StageRuntime`，支持同一 `char_xiaojing` 在 `desktop-2d` / `live2d` / `vrm-3d` / `obs-stage` 间切换时保留歌词、表情与口型参数映射。
- **宿主接线**：[v2-kernel-host.ts](../../apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](../../apps/desktop-host/src/preload/index.ts)、[bridge.ts](../../apps/desktop-host/src/renderer/director/bridge.ts) 接入 8 路 `v2:perf-*` / `v2:stage-*` IPC 与急停联动。
- **真实验证**：`performance.spec.ts` + `stage-runtime.spec.ts` **6/6 PASS**（合并分支覆盖 90.88%）、`desktop-host build` exit 0、`pnpm verify:gate` **7/7 PASS**、Electron 45 E2E Part 1 **3/3 PASS** + Part 2 `ui.e2e` **8/8 PASS**，详见证据 [P3-performance-stage-verification.md](./evidence/P3-performance-stage-verification.md)。
- **为什么不是 `DONE`**：尚缺真实神经 SVS/SVC 推理后端听感实测，以及外部 Cubism `.moc3` 与 WebGL VRM 画布实机渲染验证。

## 3. 下一步行动（Next Agent 从这里接手）

1. 检查并认领 **`V2-P3-02`（LifeRuntime 驱动的直播中控与 OBS 舞台：真实平台流接入 + 曲库版权门禁）**：先查阅 `packages/live-stream-hub/src/`、`apps/desktop-host/src/main/{live-host.ts,webui-server.ts}` 与 `docs/v2/blueprint/09-直播舞台音乐与互动.md`、`REQUIREMENTS.md` (`REQ-LIVE-01`)，复用 `PerformanceDirector`、`evaluateSongRights` 与 `StageRuntime`，按原子工单（≤ 8 业务源码文件）交付可测闭环。
2. 保持全部 gate（`pnpm verify:gate` 7/7 + Electron 45 E2E 顺序全绿）与诚实验收口径。
