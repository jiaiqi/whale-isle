# P3-01 实测证据 — 统一表演系统（`V2-P3-01`：`SingEngine` SVS/SVC + 歌词时钟 + 舞蹈 + 2D/Live2D/VRM `StageRuntime`）

> **关联需求**：`REQ-VOX-02`（说话 / SVS / SVC 分离与曲库版权门禁）、`REQ-PERF-01`（统一 `PerformanceDirector` 与自然沉默权）、`REQ-EMB-02`（2D / Live2D / VRM 3D / OBS 舞台同一 `characterId` 无缝切换）。  
> **诚实结论口径**：**`IMPLEMENTED_UNVERIFIED`** —— 共享契约、`SingEngine`（SVS/SVC 与 `preview_guide_tone`）、`evaluateSongRights`、`LyricsClockSync`、`PerformanceDirector`、多后端 `StageRuntime`、宿主 8 路 V2 IPC、完整门禁（7/7）及 Electron 45 全量 E2E 已实测通过；因本机未部署真实神经 SVS/SVC 推理 Worker、未接入真实外部 `.moc3` Cubism 运行时与 WebGL VRM 画布实机目视听感，按宪章标记 `IMPLEMENTED_UNVERIFIED`。

---

## 1. 本次修改清单（业务源码恰好 8 个，符合 ≤ 8 铁律）

| 文件 | 职责与交付 |
| --- | --- |
| [packages/shared-protocol/src/voice.ts](../../../packages/shared-protocol/src/voice.ts) | 新增 `PerformanceChannel`、`SongRights` / `SongRightsCheck`、`SingMode` / `SingBackendMode` / `SingRequest` / `SingRenderResult`、`BilingualLyricLine` / `LyricsClockFrame` / `DanceRoutine`、`SpeechPerformancePlan` / `SilenceDecision` / `PerformanceSnapshot`、`StageBackendKind` / `StageCharacterBinding` / `StageRuntimeSnapshot` 契约 |
| [packages/voice-runtime/src/performance.ts](../../../packages/voice-runtime/src/performance.ts) | 实现 `evaluateSongRights`、`parseBilingualLrc`、`LyricsClockSync`、`buildGuideToneWav`、`SingEngine`（严格区分 SVS/SVC 与普通 TTS）与 6 层仲裁 + 自然沉默权 `PerformanceDirector` |
| [packages/voice-runtime/src/index.ts](../../../packages/voice-runtime/src/index.ts) | 导出统一表演模块 |
| [packages/pet-renderer/src/stage-runtime.ts](../../../packages/pet-renderer/src/stage-runtime.ts) | 实现 `visemeToVrmBlendShapes` / `visemeToLive2dParams` / `expressionToVrmBlendShapes` / `expressionToDesktopAction`、`Desktop2dStageAdapter` / `Live2dStageAdapter` / `Vrm3dStageAdapter` 与无缝切维 `StageRuntime` |
| [packages/pet-renderer/src/index.ts](../../../packages/pet-renderer/src/index.ts) | 导出 `StageRuntime` 与适配器 |
| [apps/desktop-host/src/main/v2-kernel-host.ts](../../../apps/desktop-host/src/main/v2-kernel-host.ts) | 挂载 `v2:perf-*`（6 路）与 `v2:stage-*`（2 路）IPC，并联动 `v2:emergency-halt` / `v2:resume` / `stop()` |
| [apps/desktop-host/src/preload/index.ts](../../../apps/desktop-host/src/preload/index.ts) | 暴露 8 路 `v2Perf*` / `v2Stage*` Preload 桥接方法 |
| [apps/desktop-host/src/renderer/director/bridge.ts](../../../apps/desktop-host/src/renderer/director/bridge.ts) | 同步渲染层 `DirectorBridge` 强类型接口 |

测试与文档文件：`packages/voice-runtime/src/performance.spec.ts`、`packages/pet-renderer/src/stage-runtime.spec.ts`、`apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`。

---

## 2. 实测命令与结果（均于 2026-11-26 现场执行）

### 2.1 类型检查、专项单测覆盖率与宿主构建 (`[SIMULATION]`)
- `pnpm typecheck`：退出码 `0`
- `pnpm exec vitest run packages/voice-runtime/src/performance.spec.ts packages/pet-renderer/src/stage-runtime.spec.ts --coverage.include='packages/voice-runtime/src/performance.ts' --coverage.include='packages/pet-renderer/src/stage-runtime.ts'`：
  - `packages/pet-renderer/src/stage-runtime.spec.ts`：**2/2 PASS**（`stage-runtime.ts`：**100% Stmts / 94.69% Branch / 100% Funcs / 100% Lines**）
  - `packages/voice-runtime/src/performance.spec.ts`：**4/4 PASS**（`performance.ts`：**99.09% Stmts / 89.07% Branch / 100% Funcs / 100% Lines**；合并 **90.88% Branch ≥ 90%**）
- `pnpm --filter @workbench/desktop-host build`：退出码 `0`

### 2.2 Electron 45 全量 E2E 验证 (`[E2E-HOST]`)
- Part 1：`PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts apps/desktop-host/e2e/v2-obsidian-ui.e2e.spec.ts` → **3/3 PASS**
  - `v2-kernel.e2e.spec.ts` 实测 `v2PerfSnapshot()`、`dev_only_non_commercial` 在 `livestream_public` 被 `evaluateSongRights` 阻断、`quietCompanionMode` 沉默策略与 `P0_INTERRUPT` 例外、`original_owned` 唱跳 + 双语歌词 `v2PerfTick(2500)`、同一 `char_xiaojing` 跨 `desktop-2d → live2d → vrm-3d` 无缝保留歌词切换，以及 `v2EmergencyHalt()` 停演清轨。
- Part 2：`PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/ui.e2e.spec.ts` → **8/8 PASS**

### 2.3 四道确定性门禁 (`pnpm verify:gate`)
- 最终一轮全绿：**7 过 / 0 跳过 / 0 待接线**：
  - Gate 1 类型与边界 (`tsc -b` + `dependency-cruiser`) & Python (`ruff` + `mypy --strict`) PASS
  - Gate 2 许可证与密钥扫描（`284` 个源文件，`0` 处违规）、依赖安全扫描（`0 high / 0 critical`）、DST Lua 语法（5 文件）PASS
  - Gate 3 全仓单测（全局分支覆盖率 ≥ 90%）+ `pytest` + 卡死剧本 `S01–S07` PASS
  - Gate 4 回环契约 E2E PASS

---

## 3. 尚未完成的真机实测缺口（`IMPLEMENTED_UNVERIFIED` 原因）

1. **真实神经 SVS / SVC 音频推理与人工听感验收 `[REAL-DEVICE]`**：本机未运行独立的 SVS/SVC 神经推理服务，当前实测覆写了在线 Worker HTTP 契约模拟与确定性 `preview_guide_tone` 导唱波形合成（`realNeuralInferenceVerified: false`）。
2. **真机图形画布渲染验收 `[REAL-DEVICE]`**：Live2D（外部合法 `.moc3` + Cubism Web SDK）与 WebGL VRM 3D 实际桌面可见画布帧率与视觉观感（`realDeviceRenderVerified: false`）待安装真实 3D/Live2D 资产后人工目视验收。
