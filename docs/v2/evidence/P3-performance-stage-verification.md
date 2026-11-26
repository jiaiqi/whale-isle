# P3-01 实测证据 — 统一表演系统（`V2-P3-01`：`SingEngine` SVS/SVC + 歌词时钟 + 舞蹈 + 2D/Live2D/VRM `StageRuntime`）

> **关联需求**：`REQ-VOX-02`（说话 / SVS / SVC 分离与曲库版权门禁）、`REQ-PERF-01`（统一 `PerformanceDirector` 与自然沉默权）、`REQ-EMB-02`（2D / Live2D / VRM 3D / OBS 舞台同一 `characterId` 无缝切换）。  
> **诚实结论口径**：**`IMPLEMENTED_UNVERIFIED`** —— 共享契约、`SingEngine`（SVS/SVC 与 `preview_guide_tone`）、`evaluateSongRights`、`LyricsClockSync`、`PerformanceDirector`、多后端 `StageRuntime`、宿主 8 路 V2 IPC、完整门禁（7/7）及 Electron 45 全量 E2E 已实测通过；**2026-11-26 真机补验已额外完成**歌词时钟偏差程序度量、舞台画布 CDP 采集、跨后端状态保留实测，并部署 `services/sing-worker` 把 `SingEngine` 的 `workerEndpoint` 真正接上后端做真实探测（详见第 3 节）；因本机**未部署真实神经 SVS/SVC 推理后端**、**无合法 `.moc3` / `.vrm` 资产**（桌宠窗实为 WebM 视频渲染，非画布），按宪章仍标记 `IMPLEMENTED_UNVERIFIED`。

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

## 3. 真机补验（2026-11-26，`[REAL-DEVICE]`）——能自动的都已自动做完

> 本节只记录**真机/真实后端**实测。凡属仿真或契约模拟的证据一律留在第 2 节，不混写。
> 诚实结论：**P3-01 仍为 `IMPLEMENTED_UNVERIFIED`**，原因见第 4 节（缺 SVS/SVC 后端与 Live2D/VRM 合法资产）。

### 3.1 歌词时钟偏差程序度量 `[REAL-DEVICE]`

度量脚本 `tools/scripts/measure-lyrics-clock-drift.mts`（新增，随本工单入库），用真实墙钟 `process.hrtime.bigint` 以 25ms 采样驱动 `LyricsClockSync`，记录每行**实际高亮时刻**与**声明 startMs** 的偏差：

| 指标 | 实测值 |
| --- | --- |
| 行数 / 被测行 | 4 / 4 |
| max 偏差 | **25 ms** |
| mean 偏差 | 17 ms |
| P95 偏差 | 25 ms |
| 容差 | 60 ms |
| 判定 | **pass = true** |
| `afplay` 进程启动延迟 | 2.02 ms |

逐行明细：第 0 行声明 0ms / 实测 0ms（偏差 0），第 1 行声明 2200ms / 实测 2225ms（偏差 25），第 2 行声明 6000ms / 实测 6013ms（偏差 13），第 3 行声明 9800ms / 实测 9805ms（偏差 5）。

**诚实口径（脚本 `honestNote` 原文）**：本度量检验的是 `LyricsClockSync` 在真实墙钟驱动下的切换精度（时钟自身是否引入漂移）；`desktop-host` 当前由手动 IPC tick 喂 `positionMs`，**尚未把 `positionMs` 绑定到真实音频播放位置**，该绑定属后续工单，故本报告**不等于**「歌词已绑定真实音频时钟」。

### 3.2 舞台画布 CDP 采集 `[REAL-DEVICE]`

Playwright over CDP 连接真实 Electron（`127.0.0.1:9333`），枚举 `pet-stage` 窗口内全部媒体元素并实测渲染循环帧率：

| 采集项 | 实测结果 |
| --- | --- |
| `<canvas>` 数量 | **0** |
| `<video>` 数量 | 1 —— `待机呼吸.webm`（`blue-whale-maid` 资产包），`paused=false`、`readyState=4`、640×360 |
| Live2D 运行时存在 | **false**（无 `Live2DCubismCore`，无 `[data-live2d-runtime]`） |
| VRM 运行时存在 | **false**（无 `[data-vrm-runtime]`，`window.THREE` 未定义） |
| rAF 帧率 | **60.4 FPS**（121 帧 / 2002ms） |
| 帧间隔 | median 16.7ms / P95 18.3ms / max 18.6ms |
| 掉帧（>50ms） | **0** |

**口径校正（2026-11-26）**：表中 `60.4 FPS` 是 `requestAnimationFrame` 回调频率，**不是视频实际解码帧率**，也不代表观感流畅度；本项只证明渲染循环在跑、无长任务卡顿（掉帧 0），视频真实帧率未测。

**结论**：桌宠窗当前是 **VP9-Alpha `.webm` 双 `<video>` 渲染**（与宪章 §1.1 一致），**不是** canvas / WebGL 画布，因此「Live2D / VRM 画布帧率与目视观感」这一项在当前资产状态下**无法在真机上成立**——不是没测，是被测对象不存在。StageRuntime 的 `desktop-2d / live2d / vrm-3d / obs-stage` 四个后端**切换 API 全部 `ok=true`**、`realDeviceRenderVerified` 恒为 `false`（如实标记，不冒充已目视验收）。

### 3.3 跨后端状态保留 `[REAL-DEVICE]`

走中控台真实试演链路（`v2PerfSingStart` → `v2PerfTick(2500)` → `v2StageSwitchBackend`），在唱歌进行中依次切换 4 个后端：

| 后端 | ok | characterId | 歌词行 | 口型 | 表情 | 舞蹈动作 |
| --- | --- | --- | --- | --- | --- | --- |
| 切换前（基准） | — | char_xiaojing | index 1「小鲸为你点亮海图的星光」 | `round` / 0.3233 | `singing` | `dance_spin` |
| `live2d` | true | char_xiaojing | index 1（不变） | `round` / 0.3233 | `singing` | `dance_spin` |
| `vrm-3d` | true | char_xiaojing | index 1（不变） | `round` / 0.3233 | `singing` | `dance_spin` |
| `obs-stage` | true | char_xiaojing | index 1（不变） | `round` / 0.3233 | `singing` | `dance_spin` |
| `desktop-2d` | true | char_xiaojing | index 1（不变） | `round` / 0.3233 | `singing` | `dance_spin` |

**口径校正（2026-11-26）**：`retained = true` 只证明 **`StageRuntime` 的状态机与绑定数据**在四后端之间切换不丢（角色/歌词/口型/表情/舞蹈 cue 均在），**不证明** Live2D / VRM 真的把画面渲染出来了——本机无 `.moc3` / `.vrm` 资产，四后端的渲染结果均为 `realDeviceRenderVerified = false`。这条是「状态保留已验、实际渲染未验」。

`retained = true`。`PerformanceDirector` 快照同步显示 `mode = singing_and_dancing`、`positionMs = 2500`、`activeDanceCue = c2`、活跃图层含 `vocal_lipsync: sing:*` 与 `performance_choreo: dance:*`。

### 3.4 `sing-worker` 真实后端探测接线 `[REAL-DEVICE]`

**本次新增** `services/sing-worker/`（FastAPI，端口 18880），作为 Electron 与真实歌声后端之间的适配层，并新增 `SingEngine` 的 `workerEndpoint` 接线（原实现**根本没传** `workerEndpoint`，`probeBackends` 必然返回 svs/svc 双 unavailable，探测是假的）。

三层链路真实跑通：`Electron → sing-worker(18880) → GPT-SoVITS(9880)`。

真实探测输出（`GET http://127.0.0.1:18880/sing/health`）：

```json
{
  "svs": false,
  "svc": false,
  "backends": [
    { "name": "svs", "kind": "singing_voice_synthesis", "ready": false, "detail": "未配置 svs 后端（WHALE_SING_SVS_ENDPOINT 为空）" },
    { "name": "svc", "kind": "singing_voice_conversion", "ready": false, "detail": "未配置 svc 后端（WHALE_SING_SVC_ENDPOINT 为空）" }
  ],
  "ttsClone": { "name": "tts", "kind": "text_to_speech", "ready": true, "detail": "tts 后端在线（http://127.0.0.1:9880/docs）（普通 TTS，不得当作 SVS/SVC 使用）" }
}
```

Electron 侧真实消费（`v2PerfSnapshot().singBackends`，真机读取，非 mock）：

```json
[
  { "mode": "svs", "backend": "unavailable", "available": false, "endpoint": "http://127.0.0.1:18880",
    "detail": "Worker 在线但 SVS 能力未就绪：未配置 svs 后端（WHALE_SING_SVS_ENDPOINT 为空）（Worker 另报普通 TTS 可用，但普通 TTS 不得当作 SVS/SVC 使用）" },
  { "mode": "svc", "backend": "unavailable", "available": false, "endpoint": "http://127.0.0.1:18880",
    "detail": "Worker 在线但 SVC 能力未就绪：未配置 svc 后端（WHALE_SING_SVC_ENDPOINT 为空）（Worker 另报普通 TTS 可用，但普通 TTS 不得当作 SVS/SVC 使用）" }
]
```

中控台 UI 标签同步显示 `SVS: unavailable` / `SVC: unavailable`。

**关键设计决定（诚实红线）**：本机已装并在跑的 **GPT-SoVITS 是 TTS / 音色克隆，不是歌声合成（SVS）**。把它接到 svs/svc 端点上就是「用 TTS 冒充唱歌」，违反 `SingEngine` 的设计意图与宪章 §2.2「真实执行回执铁律」。因此：

- `sing-worker` **只**转发到显式配置的 `WHALE_SING_SVS_ENDPOINT` / `WHALE_SING_SVC_ENDPOINT`，**不会**把普通 TTS 顶上去；
- 普通 TTS 单独作为 `ttsClone` 能力位如实上报，且 `detail` 里强制带上「普通 TTS 不得当作 SVS/SVC 使用」的显式警告；
- 后端缺失 → HTTP 501 + 具体原因，**不返回任何伪造音频**；
- `neuralVerified` **只在真实后端真的返回了音频时**才置 `true`；Electron 侧 `SingRenderResult.realNeuralInferenceVerified` 严格取后端回执，缺失或 `false` 一律不置真。

配套单测：`packages/voice-runtime/src/performance.spec.ts` **5/5 PASS**（新增「Worker 能力明细回传」与「`neuralVerified=true` 时才置真」两例），`services/sing-worker/test_sing_worker.py` **4/4 PASS**（无后端时 health 双 false 且 `ttsClone.detail` 含禁用告警；`/sing/svs` 与 `/sing/svc` 无后端返回 501 且**不含** `audioBase64`；`/health` 与唱歌能力解耦）。

### 3.5 GPT-SoVITS 真实推理实测（**TTS，不是唱歌**）`[REAL-DEVICE]`

直连 `http://127.0.0.1:9880/tts`（权重 `gsv-v2final-pretrained`，参考音频 `packages/pet-renderer/assets/voice-refs/genki_ref.wav`）：

| 项 | 实测值 |
| --- | --- |
| HTTP | 200（`content-type: audio/wav`） |
| 推理耗时 | **1.01 s** |
| 音频 | 单声道 / 32000 Hz / 82560 帧 / **2580 ms** |
| 产物 | `/tmp/p3-01-gpt-sovits-out.wav`（本地证据，不入库） |

**这条只证明「真实神经 TTS 推理在本机跑得通」**，与 SVS/SVC 无关，故 `SingEngine` 仍判定 `backendMode = preview_guide_tone`、`realNeuralInferenceVerified = false`（真机 `v2PerfSingStart` 实测输出）。

---

## 4. 尚未完成的真机实测缺口（`IMPLEMENTED_UNVERIFIED` 原因，需 owner 提供前置）

1. **真实神经 SVS / SVC 音频推理与人工听感验收 `[REAL-DEVICE]`**：本机**没有**歌声合成（SVS）与音色转换（SVC）后端。`sing-worker` 已就位且会如实回报 unavailable，但真实演唱仍无法产生。**需要 owner 提供**：合法的歌声合成后端（如 DiffSinger / RVC 系服务的可授权部署）与索引文件（`.pth` + `.index`）、以及用于比对的授权曲库。
2. **Live2D / VRM 真机画面与听感验收 `[REAL-DEVICE]`**：当前**没有任何** `.moc3` / `.vrm` 资产（`live2dRuntimePresent=false`、`vrmRuntimePresent=false`），桌宠窗实为 WebM 视频渲染。**需要 owner 提供**：授权的 Cubism `.moc3` + `.model3.json`、`.vrm` 模型与对应 three-vrm 运行时许可；本工单只预留接口，**不得**自行抓取来源不明的模型。
3. **情绪参考音频补齐**：现仅 `genki_ref.wav`（1 组），缺 `tsundere_refuse` / `rage_spray` / `lazy_yawn` / `happy_rice` 共 4 组。
4. **点歌台管线未落地**：Demucs v4 伴奏分离 → 前 25 秒切片 → RVC2 / RMVPE → 流式预缓冲 → 后台补齐拼接 → songs 缓存池，仍在计划中，repo 内无实现。
5. **`positionMs` ↔ 真实音频播放位置绑定**：`LyricsClockSync` 精度已验（第 3.1 节），但宿主仍靠手动 IPC tick 喂时钟，尚未绑定真实音频播放头。

> 上述 1~4 项均为**外部素材 / 后端 / 人工听感**依赖，Agent 无法自行获取或代为听感确认；按调度要求已单列清单报 owner，不阻塞其余工单推进。
