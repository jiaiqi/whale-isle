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
5. ~~`positionMs` ↔ 真实播放头仍未闭环~~ → 已于 2026-11-26 以独立原子工单闭合（见第 7 节）；真机「边唱边对歌词」仍需真实歌声后端。
6. ~~中控台尚无点歌 UI 面板~~ → 已于 2026-11-26 以独立原子工单接入（见第 6 节）。

---

## 6. 中控台最小点歌面板（2026-11-26，`[E2E-HOST]`）

### 6.1 改动范围（3 个业务源码文件 + 1 个 E2E + CI 列表）

| 文件 | 改动 |
| --- | --- |
| `apps/desktop-host/src/renderer/director/song-console-panel.tsx`（新建） | 能力状态 / 提交 / 取消 / 管线状态 / 真实播放回执五块，全部走 `window.directorBridge.v2Song*` 真实 IPC |
| `apps/desktop-host/src/renderer/director/shell/sidebar.tsx` | `Tab` 增 `song`，导航「生活」组增「点歌台」（`Music4`） |
| `apps/desktop-host/src/renderer/director/App.tsx` | 渲染分支接入面板；`isTabEnabled` 把 `song` 与 `coop`/`life` 一样列为常驻页（老用户本地已存的插件集合里没有 `song`，按集合过滤会让新页凭空消失） |
| `apps/desktop-host/e2e/song-console.e2e.spec.ts`（新建） | 真实 Electron 渲染下的三条诚实断言 |
| `.github/workflows/ci.yml` | macOS E2E 列表增该 spec |

### 6.2 面板做的事与不做的事

- **做**：展示宿主 `v2:song-capabilities` 的四个原子能力真实 `ready/detail/hint`；提交一次点歌（曲目/伴奏/歌词三档许可 + 声线授权来源 + RVC 模型/索引路径）；对当前 `requestId` 发 `v2:song-cancel`；轮询 `v2:song-snapshot`（仅在 `preparing/streaming/completing` 时 1s 一次，终态即停）并渲染管线阶段、缓存键、缓存命中、切片进度、缺口明细、首切片/成品路径与播放回执流水。
- **不做**：不伪造任何"已唱"状态；没有真实首切片就只显示空态文案；提交前若既未勾选声线授权也未填授权来源，直接在前端拦下并提示（宿主门禁同样会拒，前端只是提前说清楚）。

### 6.3 真实渲染验证（`[E2E-HOST]`）

`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/song-console.e2e.spec.ts` —— **1/1 PASS（1.58s）**，环境变量 `WHALE_AUDIO_WORKER=http://127.0.0.1:9` 保证「后端不可达」确定性：

| 断言 | 实测 |
| --- | --- |
| 能力状态 | 卡片出现 `missing`，文案含 `audio-ai-worker`，**不出现「全部就绪」** |
| 未勾选声线授权 → 提交 | 管线 `state=rejected`，拒绝原因含「角色声音模型未经授权，禁止歌声合成或音色转换」 |
| 勾选授权后 → 提交 | 管线 `state=unavailable`，含「缺失能力」逐项缺口，**不出现 `completed`** |
| 播放回执区 | 空态文案「还没有真实播放回执（首切片就绪并播放后才会写入）」 |
| 宿主快照 | `v2SongSnapshot().status.state === 'unavailable'`，与 UI 一致 |
| 渲染进程报错 | `pageErrors` 为空 |

门禁：`pnpm verify:gate` **7 过 / 0 跳过 / 0 待接线**。

### 6.4 仍未验证

1. **真唱**：本机无 Demucs/RVC 后端与授权声线权重，面板只验证了「缺能力如实报缺」。
2. **真实播放头**：`positionMs` 仍未被绑定到真实音频播放位置（`afplay` 不回报进度），面板只能显示播放回执的开始/结束与时长；该缺口单独立工单（Swift 播放器回报真实播放头）。

---

## 7. 真实音频播放头接线（2026-11-26）

### 7.1 为什么不是 afplay

`afplay` 只回报进程退出码，拿不到播放位置；此前宿主用 `Date.now() - startedAt` 当 `playedMs`，歌词/口型只能靠墙钟推算。本节把 `positionMs` 接到**真实播放位置**。

### 7.2 改动（8 个业务源码文件，达单工单上限）

| 文件 | 作用 |
| --- | --- |
| `tools/native/macos-audio-helper.swift`（新建） | `AVAudioPlayer` 播放器：`probe` 报可解码时长，`play` 每 100ms 输出 `{"type":"position","positionMs":N,"wallMs":N}`，结束/停止/失败分别输出 `ended`/`stopped`/`error`；SIGTERM 走 `DispatchSource` 转标志位，能停止并回报停止位置 |
| `apps/desktop-host/src/main/native-audio-player.ts`（新建） | 编译缓存（源码 SHA-256 版本化）+ spawn 参数数组 + 逐行 JSON 解析；`playedMs` 取真实播放头最远位置；未收到 `ended` 的 0 退出码**不算成功** |
| `apps/desktop-host/src/main/native-audio-player.spec.ts`（新建） | 9 例：位置回报/停止/报错/异常退出/并发拒绝/非法行忽略/spawn 失败/编译缓存与失败 |
| `apps/desktop-host/src/main/v2-kernel-host.ts` | 启动时装配原生播放器；`songPlayback.playFile` 优先原生播放器（带 `durationMs`），不可用时回退 `afplay`；播放头回调驱动 `PerformanceDirector.tickClock()` + 舞台口型/歌词；新增 `v2:song-playback-head` |
| `apps/desktop-host/src/preload/index.ts` / `renderer/director/bridge.ts` | 暴露 `v2SongPlaybackHead()` 与类型 |
| `apps/desktop-host/src/renderer/director/song-console-panel.tsx` | 面板显示「播放头 m:ss.d」，并区分「真实播放头就绪/在播」与「afplay 回退：无位置回报」；在播时 250ms 轮询 |
| `apps/desktop-host/e2e/song-console.e2e.spec.ts` | 断言面板出现播放头区块，且 darwin 上 `realPlayhead=true`、未播放时 `active=false` |

### 7.3 实测证据

1. **helper 本体（本机 `[REAL-DEVICE]` 级本地执行）**：`swiftc -O` 编译 2000ms 440Hz WAV，`probe` 返回 `{"durationMs":2000}`；`play --duration-ms 1200` 连续输出位置 `0→79→180→…→1289`（wallMs 与 positionMs 基本同步），`SIGTERM` 后输出 `{"type":"stopped","positionMs":583}`。
2. **TS 客户端（真实子进程）**：`createNativeAudioPlayer` 走完整编译缓存（`compileMs: 645`）后播放同一 WAV（`--duration-ms 800`），回调 10 次位置，结果 `{"ok":true,"playedMs":884,"realPlayhead":true}` —— `playedMs` 来自真实播放头而非墙钟。
3. **单测**：`native-audio-player.spec.ts` **9/9 PASS**。
4. **Electron 真实渲染**：`song-console.e2e.spec.ts` **1/1 PASS（2.51s）**，`v2SongPlaybackHead()` 返回 `realPlayhead=true`、`active=false`，面板文案落在「真实播放头就绪 · 待播放」。
5. **门禁**：`pnpm verify:gate` **7 过 / 0 跳过 / 0 待接线**。

### 7.4 仍未验证（不得当成已闭环）

1. **真实歌声下的音画同步**：无 Demucs/RVC 后端与授权声线权重，`playFile` 的真实分支仍未被真实歌声触发；「边唱边对歌词」需要后端到位后再验。
2. **长音频（≥25s）位置精度与漂移**：只用 2s 正弦波验证；长曲需真实产物。
3. **afplay 回退路径**：本机 `swiftc` 可用，回退分支只有单测覆盖，未在真机触发。
4. **首次启动编译开销**：源码哈希未命中时同步编译约 0.6–1s（本机实测 645ms），打包态找不到源码会直接回退 afplay（如实标 `realPlayhead=false`）。

---

## 8. 验收口径：许可红线（任何后续验收不得弱化）

> 本节由 `V2-P3-07A` 契约落地时补入（2026-11-27），原因：点歌台一旦跑通，容易被误读成「开源 = 可商用」。

- **RVC 代码 MIT ≠ 权重可商用**：官方底模（`lj1995/VoiceConversionWebUI`）带「仅供研究使用」条款，RMVPE 上游无 LICENSE。
- **DiffSinger 官方 OpenCpop 检查点未声明权重许可**，数据集 CC BY-NC-ND 4.0，OpenVPI 声码器权重 CC BY-NC-SA 4.0。
- 因此：**商用必须自训底模/声库（并换 FCPE/CREPE）**；随包参考音频只标 `DEV_ONLY_NON_COMMERCIAL`，`builtin_reference` 声源在公开直播/商用分发渠道一律 blocker。
- 商用渠道还要求声音授权含 `commercial_livestream`、权重许可为 `commercial_ok`；儿童声线无监护人授权一律 blocker。
- 代码位置：`packages/voice-runtime/src/singing-profile.ts` 的 `resolveSingingReadiness()`；契约：`packages/shared-protocol/src/singing.ts`。
- 逐文件结论见 [O5-svs-svc-weight-license-per-file.md](./O5-svs-svc-weight-license-per-file.md)，选型定稿见 [V2-P3-07-svc-svs-selection.md](./V2-P3-07-svc-svs-selection.md)。

**验收时的判定顺序**（不得跳步）：

1. 先看 `readiness.blockers` 是否为空（空才可唱）；
2. 再看 `commercialReady`（false 就只能桌面私用，不得开播）；
3. 最后才看听感与音画同步——前两步没过，听感没有意义。
