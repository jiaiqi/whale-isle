# 点歌台宿主接线与真实 IPC 验证证据（`V2-P3-01` 点歌台 · 生产调用路径）

> 日期：2026-11-26 ｜ 分支：`feat/whale-isle-v2` ｜ 状态影响：`V2-P3-01` 仍为 `IMPLEMENTED_UNVERIFIED`
> **诚实结论**：本单把点歌台从「内核 + Python 原子能力」接成**真实可调用路径**（`v2:song-*` IPC → `SongConsole` → audio-ai-worker HTTP → SQLite `song_cache_index` → 首切片播放挂载），并用 **真实 Electron IPC** 验证了门禁拒绝、黑名单、后端缺失逐项 `unavailable`、取消与退出清理、失败不落缓存。
> **未验证**：本机**没有 Demucs / RVC / 声线权重 / 授权曲库**，因此「Demucs 真的分离了」「RVC 真的转换了」「首切片真的响过」**一律未实测**，不得据本文件宣称已真机唱过。

---

## 0. 开工前决策声明（AGENTS.md §2.1）

- **采用什么**：复用项目既有机制拼装——`@workbench/local-store` 的 `song_cache_index`（不新建缓存表）、`SongConsole` 编排内核（不改状态机语义）、hooks 级 `verify:gate`；宿主新增 `song-console-host.ts` 承担「HTTP 客户端 + SQLite 适配 + 播放挂载 + 回执」，`v2-kernel-host.ts` 只做装配与 IPC。
- **不采用什么**：不引入新的任务队列/消息总线（后台补齐仍在 `SongConsole.completeInBackground` 内）；不用 `pkill -f afplay` 全局杀进程（会误杀其他音频应用），改为持有子进程句柄按 `SIGTERM` 定向停止；不在缺后端时返回占位音频或静音文件。
- **验证路径与回退**：单测（宿主 + 内核）+ 真实 Electron IPC E2E（worker 指向关闭端口，确定性「缺后端」）+ `pnpm verify:gate` 7 道。失败回退：若 IPC 装配引发宿主回归，可只回退 `v2-kernel-host.ts` 的四路 `v2:song-*` 注册与 `song-console-host.ts` 装配，内核与契约保持兼容（新增字段全部有默认值）。

---

## 1. 本次修改清单

业务源码（8 个，符合 ≤8 铁律）：

1. `packages/shared-protocol/src/song-console.ts` —— `characterId` 收敛为安全文件名段 `^[a-zA-Z0-9_-]+$`（防路径穿越）；新增 `SongSeparate*/SongRenderSliceRequest/SongAudioResult/SongConcatRequest/SongCapabilitiesResult` 跨语言请求回执契约。
2. `packages/shared-protocol/src/registry.ts` —— 上述 9 个契约登记进 `CONTRACT_SCHEMAS`，生成 JSON Schema 与 Pydantic。
3. `packages/voice-runtime/src/song-console.ts` —— `renderSlice` 端口扩展为携带声线模型与全部调参；新增 `sliceParams()` 把同一组输入**既算进缓存键、又原样送推理端**。
4. `apps/desktop-host/src/main/song-console-host.ts`（新建）—— HTTP 客户端（响应走 Zod 校验）、SQLite 缓存适配、黑名单路径解析 `resolveSongBlacklistPath()`、播放挂载与回执流水、`shutdown()`。
5. `apps/desktop-host/src/main/v2-kernel-host.ts` —— 装配 `songConsoleHost`，注册 `v2:song-capabilities|request|snapshot|cancel|shutdown`；播放改为持有 `afplay` 子进程句柄；开唱前 `voice.stopAll()` 做单端互斥；`kernel.stop()` 调用 `songConsoleHost.shutdown('kernel_stop')`。
6. `apps/desktop-host/src/preload/index.ts` —— 暴露 5 路 `v2Song*`。
7. `apps/desktop-host/src/renderer/director/bridge.ts` —— `DirectorBridge` 类型 + `SongPlaybackReceiptView`。
8. `services/audio-ai-worker/song_pipeline.py` —— 请求模型改为消费生成的 Pydantic 契约；请求内 `rvcModelPath/rvcIndexPath` 真正生效（缺文件即 501，不退回别的模型冒充）；线性增益 → ffmpeg dB（`20*log10`，0 按 -60dB）。

测试与资源：`song-console-host.spec.ts`（15 例）、内核 `song-console.spec.ts`（26 例）、`v2-kernel.e2e.spec.ts`（新增真实 IPC 断言）、`test_song_pipeline.py`（9 例）、`assets/song-blacklist.json`。

---

## 2. 已接通的生产入口（真实调用路径）

| 入口 | 通道 | 落点 |
| --- | --- | --- |
| `v2SongCapabilities()` | `v2:song-capabilities` | `GET /api/song/capabilities` → 逐项 `ready/detail/hint` |
| `v2SongRequest(input)` | `v2:song-request` | `SongConsole.request()`：门禁 → 黑名单 → 缓存 → `POST /api/song/separate` → `render-slice` → `concat` |
| `v2SongSnapshot()` | `v2:song-snapshot` | 最近状态 + `lastPlayback` + `playbackReceipts` |
| `v2SongCancel(id)` | `v2:song-cancel` | `SongConsole.cancel()`：置 `cancelled`、停播、后台不再落缓存 |
| `v2SongShutdown(reason)` | `v2:song-shutdown` | `songConsoleHost.shutdown()`：停播 + 取消进行中请求 |

**首切片是否真的接到播放队列**：是。`handleStatus()` 在 `prebuffer_ready`（真实渲染产物）与 `cache_hit`（真实缓存文件）两个阶段调用 `playback.playFile()`，`playFile` **在 `afplay` 进程 exit 后才 resolve**，并写入 `PLAYING → COMPLETED/FAILED/CANCELLED` 回执；`rejected/unavailable/cancelled` 会停播并把回执标记 `CANCELLED`。**但本机无后端，该分支从未被真实音频触发过**（单测用替身、E2E 断言 `lastPlayback === null`），故只算接线完成，不算播放实测。

---

## 3. 缓存键口径（避免换声线误复用）

`<characterId>_sha256(...)[:16]`，进键成分：

- 源文件**指纹**（`size@mtimeMs`），不只路径——同名换内容不会误命中；
- `characterId` / `voiceProfileId` / `song.songId` / `song.durationMs`；
- `rvcModelPath` / `rvcIndexPath`（换声线必然失效）；
- `pitchShiftSemitones` / `indexRate` / `protectVoiceless` / `vocalGain` / `accompanimentGain`；
- `firstSliceMs` / `sliceMs`（切片策略变化失效）。

单测覆盖 6 类输入各变更一次键必须不同、相同输入键必须稳定、同路径换内容键不同。

---

## 4. 验证结果

### 4.1 确定性单测（`[SIMULATION]`）

| 套件 | 结果 |
| --- | --- |
| `apps/desktop-host/src/main/song-console-host.spec.ts` | **15/15 PASS** |
| `packages/voice-runtime/src/song-console.spec.ts` | **26/26 PASS** |
| `services/audio-ai-worker/test_song_pipeline.py` | **9/9 PASS**（`pnpm py:test` 全量 61 例 PASS） |

宿主单测覆盖：能力部分缺失逐项上报、worker 不可达、声线与调参确实送达推理端、门禁拒绝零音频调用、索引有行但文件不存在 → 重跑、缓存命中不重复分离且触发播放、分离 501 → `unavailable` 不落缓存、首切片渲染失败不播不落缓存、后台取消、`shutdown` 清理、SQLite 适配、黑名单路径解析与损坏兜底。

### 4.2 真实 Electron IPC（`[E2E-HOST]`）

`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts` —— **1/1 PASS，12.15s**（worker 环境变量指向关闭端口 `127.0.0.1:9`，保证「缺后端」确定性）：

| 断言 | 实测 |
| --- | --- |
| `v2SongCapabilities()` | `ok=false`，全部 `ready=false`，`demucs.detail` 含「不可达」 |
| 无声线授权 → 点歌 | `state=rejected`，`rejectionReason` 含「授权门禁」，无 `prebufferPath` |
| 曲名「国歌」→ 点歌 | `state=rejected`，`rejectionReason` 含「违禁曲目黑名单」（证明仓库 `assets/song-blacklist.json` 在开发态被真实加载） |
| 合法但无后端/无源音频 | `state=unavailable`，`missingCapabilities` 含 `demucs`，`unavailableReason` 含「拒绝以占位音频冒充真唱」 |
| `v2SongCancel('不存在')` | `{ ok:false, cancelled:false, reason:'没有正在进行的点歌请求…' }` |
| `v2SongShutdown('e2e')` | `{ cancelledRequestId: null }`（不误伤） |
| `v2SongSnapshot()` | `status.state=unavailable`、`lastPlayback=null`、`playbackReceipts=[]`（**从未播放过就如实为空**） |

### 4.3 质量门禁

`pnpm verify:gate` → **7 过 / 0 跳过 / 0 待接线**（Gate 1 TS+dependency-cruiser、Gate 1 Python ruff+mypy --strict、Gate 2 许可证与密钥、Gate 2 依赖漏洞、Gate 2 DST Lua、Gate 3 单测、Gate 4 回环 E2E）。

---

## 5. 未完成 / 未验证（禁止当成已通过）

1. **Demucs v4 真实分离未实测**：本机 `demucs` 未安装，`separate` 只有 501 路径被真实调用过。
2. **RVC 声线转换未实测**：全盘无 `.pth`，`rvcModelPath/rvcIndexPath` 的真实推理效果无从谈起。
3. **首切片真实播放未实测**：`afplay` 挂载分支未被真实音频触发（E2E 明确断言 `lastPlayback === null`）。
4. **真实音频路径的延迟指标未测**：「缓存命中 <50ms」只有 `cacheLookupMs` 度量字段，无真实曲库样本支撑。
5. **`positionMs` ↔ 真实播放头仍未闭环**：与 P3-01 的歌词时钟缺口同源，属实现缺口而非素材缺口。
6. **中控台尚无点歌 UI 面板**：IPC 与类型已通，界面按后续工单接入（当前只能由 E2E / 脚本调用）。
