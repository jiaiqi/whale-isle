# Changelog

本项目的所有显著变更将记录在本文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased] — 2026-11-27

### Changed（表现力语音收尾三件：显式离线档开关 / UI 体感代价 / 修 StubLocalBackend 冒名）

- **显式「本地引擎 = 可选离线档」开关**：`planVoiceFallback()` 不再用「本地引擎装没装」隐式决定优先级，改为接收显式 `tier`——`commercial_default`（默认，商业 API 首跳、本地引擎降为 `role:'optional'`）与 `offline_preferred`（本地引擎首跳，随时可切回）。新增 `tierHonored`：所选档位没兑现（例如选了离线档但本地未安装）时置 `false`，UI 必须说出来。档位持久化在 `PetDesktopPrefsSchema.voiceEngineTier`。
- **UI 直接写体感代价**：`OFFLINE_TIER_COST` / `OFFLINE_TIER_COST_TEXT` 提到 `packages/shared-protocol/src/voice.ts`，语音中心面板渲染「一句话等 16–43 秒 / 首包 10–35 秒 / 冷启动首句 30 秒」，并展示本地 Audio Worker 的探针实测档位（占位/降级、真实后端、未启动）与「情绪 TTS：支持/不支持（探针实测）」。文档与界面共用同一份常量。
- **修 `StubLocalBackend` 冒名**：`"local-gpt-sovits"`（一个真实存在的本地 TTS 服务 preset）→ `"stub-sine-placeholder"`；`StubCloudBackend` 的 `"cloud-siliconflow"` 同样冒名真实云端服务 → `"stub-sine-placeholder-cloud"`；`FailingBackend` → `"stub-failing"`。
- **占位标记贯通契约**：`TtsSynthesisResultSchema` 新增 `placeholder` / `placeholderReason`；`VoiceSynthesisOutputSchema` 同步；`/tts/synthesize`、`/tts/emotion`、`/ws/audio` 回执都带标记，调用方再也不会把「正弦波」当成「真实 TTS 人声」。
- **`supportsEmotion` 改探针实测**：`/health` 新增 `tts` 段（`mode`/`engine`/`supportsEmotion`/`detail`），由 `EmotionTtsRouter.probe_emotion_capability()` 真跑——同文本两种情绪各合成一小段再比字节，字节相同即判定后端不区分情绪；占位后端一律 `false`。宿主 `LocalAudioWorkerProvider.probe()` 删掉两处硬编码的 `supportsEmotion: true`，改读 worker 自报，旧版 Worker 未上报时按 `false` 处理。
- **验证**：`pnpm verify:gate` 7/7；新增 11 例 TS 单测（档位分支 / 探针解析 / 占位回执）+ 6 例 Python 单测（冒名回归 / 占位标记 / 探针三种后端）。真机证据（本机真实 uvicorn + 真实 HTTP）：`/health` → `mode=placeholder, supportsEmotion=false`，`/tts/emotion` → `placeholder:true`，宿主探针 → `supportsEmotion:false, degraded:true`。证据 [TTS-local-engine-benchmark-verification.md](./docs/v2/evidence/TTS-local-engine-benchmark-verification.md) §9。


### Added（表现力语音：引擎下载器 + 本地引擎安装状态判定）

- **`tools/scripts/fetch-engine.mjs`**：按清单逐文件下载 + sha256 校验 + 原子安装（全部通过才写 `installed.json` 并 rename），单文件 3 次失败即清空分片目录、绝不留半包；支持 `--check` / `--remove` / `--dry-run`；优先走系统 curl（实测 18.7 MB/s，Node fetch 同链路仅 ~0.2 MB/s），curl 缺失时回退 fetch。
- **`engine-manifests/cosyvoice2-0.5b.json`**：钉死 HF commit `eec1ae6c` 与 14 个文件的字节数 / LFS sha256（最小运行集 4,073,955,371 B）；权重本体不进 git。
- **`packages/voice-runtime/src/local-engine.ts`**：`resolveLocalEngine()` 唯一判据是 `installed.json` 存在且清单文件齐全、字节数正确——`--remove` 之后立刻读成未安装；`planVoiceFallback()` 落方案 §5.5 降级链（本地 → 商业 API → 系统 TTS），每跳标 degraded 并写明原因。13 例单测覆盖 no_marker / corrupt_marker / wrong_engine / file_missing / size_mismatch 与多版本选择。

### Added（自主社交发起策略 `P3-04G`）

- **owner 四条口径落成**：默认关闭；每日 ≤2 次且累计 ≤30 分钟；间隔 90–150 分钟 ±20% 抖动；收官/失败后冷却 ≥60 分钟；本地 00:00–08:00 禁发；连续 2 次失败当日停发。单次预算 20 条 / 10 分钟 / 内容理解 ≤8 次，且当日剩余预算不足时把单次时长钳到剩余。
- **拦截原因逐项可读**：暂停/急停、已有会话、夜间、连续失败、次数用尽、时长用尽、冷却、间隔未到、平台未实测、执行器未接入、模型不可用、用户玩游戏/直播/用电脑——生活页直接显示「被谁拦住」。
- **P0 急停立即 abort 在跑会话**（记 `user_stopped`）；会话跨 00:00 按 `quiet_hours` 收官。
- **桌宠气泡改为只报开始/收官**，移除逐条浏览投影（owner 口径：不逐条刷屏）。
- **L1 浏览执行器骨架并入本单**：候选来源抽象（`SocialBrowseCandidateSource`）、逐条读取（`SocialBrowseItemReader`）、内容理解配额（超限后不再发模型调用）、用户中途打断（`aborted/user_stopped`）四段端口齐全；双门禁——夹具源必须显式放行且产品恒 `allowLocalFixture=false`，真实平台源未实测一律 `PERMISSION_DENIED`。
- **23 + 12 例确定性单测**（可注入时钟与随机序列，不 sleep），`verify:gate` 7/7。证据 [P3-04G-social-autostart-verification.md](./docs/v2/evidence/P3-04G-social-autostart-verification.md)。
- **如实记录未接项**：宿主不注册任何候选来源，执行器 `runnable=false`、`executorReady` 仍为 `false`，开关打开也不会发起——真实平台浏览在 owner 逐项声明并实测能力矩阵之前一律不接。

### Changed（中控台 macOS 自绘窗口顶栏：去掉系统黑条，保留原生红绿灯）

- **问题**：中控台沿用系统原生标题栏，macOS 深色模式下是一条黑条，与 Tidepaper 暖色纸面内容割裂（owner 直接反馈）。
- **macOS**：`createDirectorWindow` 改 `titleBarStyle: 'hiddenInset'` + `trafficLightPosition: { x: 18, y: 14 }`，内容画进标题栏区域，关闭/最小化/缩放三颗灯仍由 AppKit 原生绘制。渲染层新增 40px `.wb-titlebar`：左侧 80px 红绿灯安全区 + 鲸屿品牌（品牌从侧栏移入，避免重复），右侧窗口级标签「桌面中控台」；背景/边框/文字全部走 Tidepaper token，浅色与深色都与内容完全同色。
- **行为**：整条顶栏 `-webkit-app-region: drag`；拖动移动窗口、双击触发 macOS 原生缩放（不是最大化）均由系统处理，无自造 IPC。全屏时系统隐藏红绿灯，顶栏不被遮挡。
- **Windows / Linux**：保留原生边框（Windows `titleBarOverlay` 需按主题双向同步且没有 macOS 双击缩放语义；Linux 各 WM 支持不一），渲染层不渲染该顶栏、侧栏品牌保持原样 —— 不会出现「没有窗口按钮」的窗口。
- **验证**：`pnpm verify:gate` 7/7；`ui.e2e` + `v2-obsidian-ui.e2e` 2 文件 10 用例 PASS；macOS 真机用 CGEvent 复核拖动、双击 zoom/unzoom、全屏。证据 [P3-director-titlebar-verification.md](./docs/v2/evidence/P3-director-titlebar-verification.md)。Windows / Linux 真机未执行。

### Added（单桌宠全链路 E2E：宿主仿真 BWF 端点 + 启动到记忆一条剧本）

- **宿主可在测试态指向仿真 BWF**：`bwf-settings.ts` 新增 `resolveBwfEndpoint()`（注入端点优先、空串回落真实端口）；`index.ts` 仅在 `PET_STAGE_E2E=1` 时读取 `WHALE_E2E_BWF_ENDPOINT`，并在注入时忽略真实端口联动，生产恒为 `undefined`。
- **`single-pet-chain.e2e.spec.ts`**（`[E2E-HOST]`+`[SIMULATION]`）：测试进程起活农场仿真（12 株成熟草莓 + 12 格已开垦）→ 点顶栏「启动」并勾选自动启动 → `running=true` → 仿真收到 `get_state` 与真实动作 → 三态回执 → `v2MemoryQuery` 检索命中该回执 → 停止。本机 1/1、6.22s；已加入 `.github/workflows/ci.yml` 的 macOS E2E 列表。证据 [P3-single-pet-chain-verification.md](./docs/v2/evidence/P3-single-pet-chain-verification.md)。
- **`V2-P4-01` 转 `NEXT`**：owner「先把一个桌宠走通」后成为唯一激活主线；本单为其实现侧首件。
- **调度方案文档**（仅方案，未实现）：`P3-04E-scheduler-autostart-proposal.md` 给出自动发起社交会话的节律、单次预算、急停位置与 owner 可见信息，等 owner 拍四个点。

### Fixed / Changed（单桌宠链路优先：P3-06 缺陷①就绪竞态修复；`V2-P2-09` 按 owner 决策暂缓）

- **P3-06 缺陷①（BWF 就绪竞态）已修**：`AutodriveRunner.start()` 原实现只做一次 `adapter.ping()`，冷启动后立刻点「启动」会误报「BWF MCP 不可达」。现新增 `readyTimeoutMs`（默认 `0` = 保持旧行为）与 `readyPollMs`，窗口内按间隔重探并逐次发 `watchdog/heartbeat` 事件说明「第 N 次重探」；窗口耗尽仍抛 `unreachableMessage` 不装成功；等待期间 `stop()` 安静取消而不误报故障。宿主 `autodrive-host.ts` 注入 90s 窗口 + 2s 间隔。新增单测 3 例（`[SIMULATION]`），真机冷启动等待表现待复验。
- **owner 决策：先不做分屏，先把一个桌宠走通**。`V2-P2-09` 整体与 `V2-P2-09D` 记为 `PENDING` +「owner 暂缓，等单桌宠走通后再启动」，不再挂「等 cabin + 手柄前置」阻塞理由；已交付的 A/B/C/E/F 保留在 `feat/whale-isle-v2` 不回滚，真机项仍 `BLOCKED`。
- **planner 两处实现语义入库留痕**（不改实现，待 owner 定）：`NON_SELLABLE` 排除「箱子」但不排除「木箱」，与 `hasChestItem` 的宝箱识别不对称；`pickTrashableFallback` 是后命中覆盖前命中而非先命中先生效。详见 [P3-planner-semantics-findings.md](./docs/v2/evidence/P3-planner-semantics-findings.md)，现状已由 `planner-utils.spec.ts` 断言锁定。

### Added / Changed（`V2-P3-01` 点歌台：宿主 IPC 接线与真实调用路径 — 状态维持 `IMPLEMENTED_UNVERIFIED`）

- **接通生产调用路径**：`v2-kernel-host.ts` 新增 `v2:song-capabilities|request|snapshot|cancel|shutdown` 五路 IPC，装配 `createSongConsoleHost()`（`SongConsole` 编排内核 + audio-ai-worker `/api/song/*` 真实 HTTP 客户端 + SQLite `song_cache_index` + 首切片播放挂载），preload 与 `DirectorBridge` 同步暴露类型。
- **首切片真的接播放**：`prebuffer_ready` 与 `cache_hit` 才触发 `afplay`，且**在进程 exit 后才 resolve**，写入 `PLAYING → COMPLETED/FAILED/CANCELLED` 回执流水；`rejected/unavailable/cancelled` 会停播并标记 `CANCELLED`。开唱前先 `voice.stopAll()`，避免 TTS 与歌声两端同时出声。
- **停止方式修正**：不再 `pkill -f afplay`（会误杀其它音频应用），改为持有子进程句柄按 `SIGTERM` 定向停止；`kernel.stop()` 调 `songConsoleHost.shutdown('kernel_stop')`。
- **契约先行**：点歌请求/状态/能力与 Python 原子能力请求回执（`SongSeparateRequest/Result`、`SongRenderSliceRequest`、`SongAudioResult`、`SongConcatRequest`、`SongCapabilitiesResult`）登记进 `CONTRACT_SCHEMAS` 并生成 JSON Schema + Pydantic；`characterId` 收敛为 `^[a-zA-Z0-9_-]+$`（当文件名用，防路径穿越）。
- **修掉「换声线只换缓存键」**：`renderSlice` 端口扩展为携带 `rvcModelPath/rvcIndexPath/pitchShiftSemitones/indexRate/protectVoiceless/vocalGain/accompanimentGain`，与缓存键同一组输入，真正送到推理端；Python 侧请求内模型优先且缺文件即 501，线性增益改为 `20*log10` 转 dB。
- **缓存键加固**：源文件 `size@mtimeMs` 指纹参与哈希，同名换内容不误命中。
- **验证**：`song-console-host.spec.ts` 15/15、内核 `song-console.spec.ts` 26/26、Python 61/61、真实 Electron IPC E2E 通过（worker 指向关闭端口，确定性验证门禁拒绝/违禁黑名单/逐项 unavailable/取消/退出清理/失败不落缓存，`lastPlayback` 如实为 `null`）、`pnpm verify:gate` 7/7。
- **仍未实测**：本机无 Demucs / RVC / 声线权重 / 授权曲库，**分离、转换与首片真实播放均未跑过**；中控台点歌 UI 面板待后续工单。

### Added / Changed（`V2-P3-01` 真机补验：歌声引擎真实后端探测 — 状态维持 `IMPLEMENTED_UNVERIFIED`）

- **新增 `services/sing-worker/`**（FastAPI，端口 18880）：歌声后端适配层。只转发到显式配置的 `WHALE_SING_SVS_ENDPOINT` / `WHALE_SING_SVC_ENDPOINT`；普通 TTS 单列 `ttsClone` 能力位如实上报，`detail` 强制带「普通 TTS 不得当作 SVS/SVC 使用」告警；后端缺失返回 501 + 具体原因且**不含** `audioBase64`，`neuralVerified` 仅在真实后端真返回音频时置 `true`。
- **修复探测造假**：`v2-kernel-host.ts` 中 `new SingEngine()` **从未传 `workerEndpoint`**，导致 `probeBackends` 必然返回 svs/svc 双 unavailable、探测形同虚设；现由 `WHALE_SING_WORKER` 显式注入。
- **探测明细回传**：`packages/voice-runtime/src/performance.ts` 的 `probeBackends` 回传后端 `detail`（「Worker 在线但 SVS 能力未就绪：未配置 svs 后端…」），`realNeuralInferenceVerified` 严格取 Worker 回执，缺失或 `false` 一律不置真。
- **新增 `tools/scripts/measure-lyrics-clock-drift.mts`**：真实墙钟 `process.hrtime.bigint` 以 25ms 采样驱动 `LyricsClockSync`，输出每行高亮时刻与声明 `startMs` 的偏差 JSON。
- **真机证据**（`[REAL-DEVICE]`）：三层探测 `Electron → sing-worker(18880) → GPT-SoVITS(9880)` 真实跑通；歌词时钟 max 偏差 25ms / P95 25ms（容差 60ms，4/4 命中）；跨 `live2d/vrm-3d/obs-stage/desktop-2d` 状态 `retained=true`；pet-stage 实为 WebM 双 `<video>` 渲染（0 canvas、60.4 FPS、0 丢帧），无 `.moc3`/`.vrm` 资产故 Live2D/VRM 画布目视无从谈起；GPT-SoVITS 真实推理 HTTP 200 / 1.01s / 32000Hz / 2580ms（**属 TTS 音色克隆，非歌声合成**，故不置 `realNeuralInferenceVerified`）。
- **门禁与测试**：`pnpm verify:gate` 7/7 PASS；`performance.spec.ts` 5/5 PASS（新增明细回传与 `neuralVerified` 门禁两例）；`services/sing-worker/test_sing_worker.py` 4/4 PASS。
- **仍缺前置（已报 owner）**：合法 Cubism `.moc3` + `.vrm` 资产、歌声合成（SVS）与音色转换（SVC）后端权重及索引、4 组缺失情绪参考音频、点歌台管线（Demucs 分离 + 切片 + 预缓冲）。

### Added / Changed（`V2-P3-06` 真机补验：中控台「启动」按钮真实点击 — 转 `DONE`）

- 冷启动路径实测：游戏未运行 → 申请 `ComputerUseLease` → CGEvent 真实点击顶栏「启动」→ 2 秒内 `autodriveStatus().running === true`，按钮标签翻转为「停止星露谷物语自动驾驶」。
- 帧证据归档：`artifacts/acceptance/P3-06-before-click.png` 与 `P3-06-after-click-driving.png`（`screencapture -x -l <windowId>`；`-R` 区域截取会带到合成画面失真）。
- 抓到两个真实缺陷待修：BWF 就绪竞态（启动瞬间 `autodriveStart` 报「MCP 不可达」，需重试）；CGEvent 点击依赖窗口真正处于系统前台（建议改 AXPress）。
- 方法论结论：macOS `screencapture -V -l` 取到的是**陈旧缓冲**（连续 10 帧内容完全一致），改用 0.25s 间隔 `-l` 连拍 60 帧才拿到真实帧差。

### Added（V2-P3-04A：Digital Life L1 契约先行）

- **`shared-protocol/src/social.ts`**：社区数字生活 L1 契约——`BrowseSession`（`interactionMode` 以 `z.literal('readonly')` 契约层钉死 L1 只读边界，目标/条目与时长预算/停止条件必填）、`SocialPlatformCapabilityEntry` 能力矩阵（渠道/授权/风险级别/`lastVerifiedAt=0` 表未实测）、`ContentUnderstanding`（诚实记录执行理解的 modelId）、`InterestSignal`（单次幅度封顶 ±0.5 防剧烈改写偏好）。
- **`shared-protocol/src/model.ts`**：多模态消息契约——`ChatContentPart`（text/image，base64 与 url 双源）、单图 base64 ≤6M 字符、单消息 ≤8 parts，供 P3-04B 网关映射与内容理解管线消费。
- 两域不进 `CONTRACT_SCHEMAS` 跨语言注册（C#/Python 无消费方，沿用 P3-03 browser-computer 先例），`gen:contracts` 零漂移；新增 9 例契约单测。

### Added（V2-P3-04B：模型网关多模态）

- **`model-gateway/gateway.ts`**：`ChatMessage.content` 扩展为纯文本或多模态 parts（消费 P3-04A 契约）；OpenAI 兼容协议映射 `image_url`（base64 → `data:` URI、url 直传），Anthropic 协议映射 image block（base64/url 双源，system 仅文本、带图片即 BAD_REQUEST 不上行）；入站消息先过 `GatewayChatMessageSchema` 契约校验；脱敏覆盖文本 part 与图片外链 URL（base64 图像数据不做文本脱敏）。
- **视觉预检（诚实口径）**：`discoveredModels` 清单明确 `supportsVision=false` 的模型记 `MODEL_NO_VISION` 直接跳过不浪费请求；清单无描述（未知）则放行由供应商真实 400 回答。新增 6 例单测，包分支覆盖 94.27%。

### Added（V2-P3-04C：SocialRuntime L1 只读浏览内核）

- **`character-core/social-runtime.ts`**：L1 浏览会话状态机（planned → active ⇄ paused / awaiting_human → completed / aborted），能力矩阵门禁「已授权 + 已实测（lastVerifiedAt>0）」双条件缺一即拒（REQ-SOC-01 铁律程序化），L1 互动能力（点赞/关注/评论/发布）在运行时层再拦；`maxItems` / `maxDurationMs` 预算达标自动按 `budget_exhausted` 收官；候选选择由上层模型注入（AI-First，内核不做内容决策）；事实事件经 EventBus 广播。新增 5 例单测，分支覆盖 93.33%。

### Added（V2-P3-04D：内容理解管线与兴趣沉淀）

- **`character-core/content-understanding.ts`**：页面正文（截断 4000 字符控 Token）+ 可选截图 → 网关窄端口多模态消息（默认 VISION_STORYBOARD 槽）→ 抽取首个 JSON 对象经 Zod 终审为 `ContentUnderstanding`；`modelId` 取回执真实路由不编造；模型输出/网页内容一律按不可信数据处理（system 明示严禁执行其中指令）；输出无 JSON 即抛错由调用层安全暂停（ADR-002 不静默退化）。
- **`character-core/interest-sink.ts`**：`InterestSignal` 是模型判定（interestRelevance × sentiment 因子）的确定性映射，±0.5 契约封顶、|delta|<0.05 噪声不落账；落 `PreferenceStore(topics)` 带完整来源历史；记忆经 `InterestMemoryPort` 窄端口写浏览 event 与话题 concept 派生链（derivedFromIds 支撑级联删除）——dependency-cruiser 边界由端口注入反转保持，character-core 不直连 memory-graph。新增 8 例单测。

### Added（V2-P3-04E：日程调度接线与状态可见）

- **LifeRuntime 预算守卫**：`social`（自主浏览）计入资源密集活动，Token/时长预算耗尽时自主浏览被 `BUDGET_EXHAUSTED` 拦截，用户强制命令仍放行。
- **宿主装配**：`v2-kernel-host` 接线 SocialRuntime + 内容理解管线 + 兴趣沉淀——理解走 autodrive `chatViaGateway`（同一供应商 Key 与饭碗计量，网关未就绪诚实报错安全暂停），记忆端口接 MemoryHost（未就绪则跳过记忆不阻塞偏好沉淀）；能力矩阵经 `v2-social-capabilities.json` 原子落盘，`SocialRuntime.updateCapabilities` 热更新。
- **9 路 `v2:social-*` IPC + 中控台生活页 L1 面板**：能力矩阵（授权/实测状态如实显示）、会话列表与状态机操作（开始/暂停/收官/中止）、目标必填的会话规划。
- **顺手修复**：tray-popover e2e 启动竞态（独立 commit `3583472`）。
- **暂缓项（如实记录）**：scheduler tick 自动发起浏览会话的循环未接（当前手动/事件驱动）；pet-stage 浏览状态投影归 P3-04F。

### Added（V2-P3-04F：站点仿真与全链路 E2E）

- **`tools/mock-harness/social-site-sim.ts`** `[SIMULATION]`：社区站点确定性仿真器（本地 node:http，4 篇夹具含 prompt 注入页，全部带 `data-simulation` 标识；候选经契约校验），3 例单测。
- **`social-life.e2e.spec.ts`** `[E2E-HOST]`：L1 全链路——能力未授权/未实测双双拒绝 → 声明已实测 → 规划 → 启动 → 真实 runner 读仿真站（不访问公网）→ 达预算自动收官 → 无 Key 理解诚实报错 → pet-stage 思考泡投影（复用 pet:bubble 通道，不新增协议）。
- **pet-stage 投影**：主进程订阅 `social.session.viewed/completed` 内核事件转思考泡（「在读：…」「收官…」）。
- 整单 `V2-P3-04` 以 `IMPLEMENTED_UNVERIFIED` 封口，证据归档 `docs/v2/evidence/P3-04-social-life-verification.md`。

### Fixed（批次 C：UI 诚实性）

- **OBS 页演示数据可见标记** `obs-panel.tsx`：弹幕议会投票卡、RVC 歌词卡、弹幕交互条三处演示数据新增可见「预演」徽章（此前只在代码注释标注，UI 上无法与真实数据区分）；饭碗与双轨气泡用真实数据不标；`ui.e2e` 新增徽章 ≥3 可见的防回归断言。
- **攻略专题死导航** `chat-view.tsx`：上下文卡片「攻略专题」从错误跳转到模型与饭碗页改为游戏共玩页（心得本所在）。

### Fixed（批次 B：审计遗留 4 个低危 bug 清零）

- **Cookie 单向导入不回写** `electron-browser-engine.ts`：dispose 时把 Chromium partition 现状按 origin 分组原子回写 cookies.json（与导入互逆），人工交接登录态跨任务存活；补首批引擎单测 3 例。
- **cancel 误标 INTERRUPTED_BY_P0**（两处实现）：`AudioPlaybackReceipt.status` 契约新增 `CANCELLED`（Zod + JSON Schema + Pydantic 同步生成）；主进程 `GlobalAudioLeaseManager` 与 `voice-runtime AudioMixer` 的 cancel/stopAll 如实标 CANCELLED，P0 抢占语义不变；气泡生命周期 cancelled 同 completed 收泡；`voice-runtime.spec.ts` 固化误标的断言已纠正；补主进程租约管理器首批单测 6 例。
- **租约审计不落盘** `automation-security.ts`：`ComputerUseLeaseManager` 新增 `auditFilePath`，内存环形缓冲外逐条追加 JSONL（装配到 `userData/lease-audit.jsonl`），写失败只告警不炸业务；补单测。
- **级联删除只展开一层** `memory-graph/store.ts`：`hardDelete` 衍生集改 BFS 不动点展开，二级衍生（摘要的摘要）不再漏删成孤儿；补二级衍生断言。
- **附带**：契约生成物积压漂移（windowLayer/bubbleFontScale/facing/moving 等历史 Zod 改动漏跑 gen:contracts）已独立 chore 提交一次性补齐。

### Fixed（弹层 portal 统一收尾 + E2E 环境确定性）

- **剩余 4 处弹层 portal 化**：`providers/dialogs.tsx`（导入外部配置、添加自定义服务商）与 `pet-studio/`（验收台、创作中心）统一 `createPortal` 到 body，摆脱 `.wb-main` 层叠上下文困局；App.tsx 启动弹窗经核实挂载在 `.wb-main` 之外、层叠正常，未动。
- **studio.e2e 断言同步 Tidepaper v3.1 侧栏文案**：「语音中心 → 声音与表演」「OBS 挂件 → 直播与 OBS」；v3.1 合流时漏同步，因该套件不在 CI 运行清单而迟至今日暴露——CI 只跑 9 个 e2e 套件中的 4 个，覆盖盲区已记录待办。
- **stardew-launcher.e2e 环境干扰修复**：新增 `WHALE_E2E_GAME_OFFLINE=1` 开关（仅 TEST_MODE 生效），`game:health` 在该开关下如实返回 offline 不真探测——本机真机星露谷在线时真实探活会让「离线横幅/先启动游戏提示」路径测不到。

### Fixed（气泡 `<think>` 标签清洗双保险 + 联机链路真实漏洞）

- **渲染层防御清洗** `pet-stage/widgets/bubble-text.ts`（新增纯函数）+ `bubbles.ts` 入口接入：thought 轨有 think 块时取标签内内容、dialog 轨剥掉 think 块只留可见文本，未闭合的流式半截块也吃掉，清洗后为空不弹气泡；覆盖 pet:say 直达、问候/彩蛋、E2E 注入等所有绕过主进程清洗的路径。
- **联机链路真实漏洞**：`coop-host.ts` 的 `handleAgentEvent` 此前直接转发 `event.intent`/`event.summary` 发气泡与中控台事件流，未经 `stripThink`——LLM 偶发带出标签时联机桌宠气泡会原样显示；现已与 autodrive-host 同一口径在广播前清洗。
- **验证**：`bubbles.spec.ts` 8/8（含 4 个清洗用例）；`ui.e2e` 气泡测试注入带标签文本，留证截图确认标签符号不显示。

### Fixed（桌宠双轨气泡可读性与遮挡）

- **内心戏云朵泡对比度**：`bubbles.ts` 底色从 `rgba(191,90,242,0.30)` 浅紫加深为 `rgba(96,44,150,0.68)` 深紫渐变、文字提亮为 `#f8f1ff`——浅紫底 + 浅字在浅色桌面上几乎不可读（真机截图确认）。
- **对话泡被角色遮挡**：两个气泡补 `z-index:7`——角色 WebM 双 `<video>` 交叉淡入每次换片重挂载 DOM，无 z-index 的气泡会被新视频压盖住；7 高于角色视频、低于 workCards(z8)/guide(z9)。
- **对话泡位置整体重排**：`bubble-layout.ts` 从「贴右下（bottom:12，与角色身体重叠区）」改为「右上头部侧面固定位 + 朝左尾巴指向角色」，底部居中区域让给饭碗挂件；垂直隔离带从 8px 加宽到 20px，覆盖云朵泡 DOM max-height 的 +16 余量，长文本极端情况下双轨也不重叠。
- **验证**：`bubbles.spec.ts` 4/4、`ui.e2e` 双轨气泡几何断言通过；[E2E-HOST] 截图 `artifacts/pet-stage-bubbles.png` 与真机窗口 CDP 截图双重留证。

### Fixed（中控台弹层层叠：小窗口下被 HUD 盖住点不到）

- **根因**：`.wb-main` 的 `position:relative + z-index:1` 形成层叠上下文，弹层 `z-[150]` 只在其内部生效，对外仍低于 `.wb-hud(z5)`；窗口较矮时 HUD 换行增高盖住弹窗顶部按钮（CI macOS 上 Playwright 报 `wb-hud intercepts pointer events`）。
- **修复**：`coop-panel.tsx`「添加 AI 队友」与 `character-pack-store.tsx`「角色包商店」两个弹层改为 `createPortal` 到 `document.body`；其余同构弹层（providers/dialogs ×2、pet-studio ×2、App.tsx 启动弹窗）列入后续统一处理。
- **测试隔离**：`ui.e2e.spec.ts` 9 处启动统一加 `WHALE_DISABLE_INPUT_MONITOR=1`——真实物理输入检测器会把开发者本机键鼠活动误判为人类接管撤销桌面租约，导致租约断言在本机必现失败（CI 无头环境无此变量）。

### Fixed（安全：供应商凭据通道命名空间击穿 + 账号级联删除空操作）

- **`provider-vault.ts`**：`providers:save-key` / `key-mask` / `discover-models` / `copy-key` / `check-balance` / `test-chat` 全部拒绝 `account:` 前缀（账号保险箱条目），`vault-status` 过滤该前缀不暴露存在性；修复渲染进程可借通用供应商 IPC 把社交凭据写入剪贴板或发往任意 baseUrl 的边界击穿。
- **`provider-vault.ts` / `v2-kernel-host.ts`**：新增 `deleteVaultKey()` 真实删除并落盘；`SecretVaultPort.delete` 不再是 `() => false` 空操作，`AccountVault.revokeAccount` / `deleteCharacter` 的级联吊销真实生效。
- **CI**：`.github/workflows/ci.yml` 触发电门加入 `feat/whale-isle-v2`——此前该分支 44 个提交从未经过 CI，门禁结果全靠本机自证。

### Added / Changed（`V2-P3-06`：星露谷一键启动器与真实就绪探活 — `IMPLEMENTED_UNVERIFIED`）

- **启动器状态机** `apps/desktop-host/src/main/stardew-launcher.ts`：`not_installed → launching → waiting_mcp → ready / timeout / failed`，`ready` 只由 BWF MCP `get_state` 真实应答触发；已在运行（端口可达或 `pgrep StardewModdingAPI`）不重复启动；子进程 `detached + stdio:'ignore' + unref()`，PPID=1 不随宿主退出；主方式直接 spawn `Contents/MacOS/StardewModdingAPI`，回退 `open steam://rungameid/413150`；标题画面自动 `load_save({})`，失败如实提示手动读档；端口一律 `127.0.0.1`（T-M6-74）。
- **修复编造就绪缺陷** `apps/desktop-host/src/main/game-health.ts`：BWF 在标题画面返回 `HTTP 200 + isError:false +「游戏还没有进入存档」`，旧探活判为 `online`；现按正文识别为 `reachable`，并补 `game-health.spec.ts` 锁定真机文案。
- **共玩页入口** `apps/desktop-host/src/renderer/director/{App.tsx,game-panel.tsx,bridge.ts}` 与 `preload/index.ts`、`packages/shared-protocol/src/index.ts`、`packages/stardew-mods/src/paths.ts`：启动入口、启动状态条与「以后自动启动」记忆；安装路径探测复用 `stardew-mods` 纯函数。
- **真机验证**：两种启动方式均实测拉起 SMAPI 4.5.2 并进档（直接 spawn 14.1s / Steam 14.0s），证据 [P3-stardew-launcher-verification.md](./docs/v2/evidence/P3-stardew-launcher-verification.md)；剩余缺口为中控台按钮路径未单独录屏、Windows/Linux 仅纯函数单测。

### Added / Changed（Tidepaper 空状态插画与桌面租约 HUD 映射）

- **空状态插画** `apps/desktop-host/src/renderer/director/shell/empty-illustration.tsx` 与 `design-tokens.css`：明暗两套 WebP 同时渲染、由 `:root.dark` 切换；接入对话空态（`empty-chat`）、游戏回执空态（`game-offline`）、未开播（`live-offline`）、记忆无命中（`empty-memory`）与急停横幅（`halted`）。
- **控制权 HUD 桌面租约** `apps/desktop-host/src/renderer/director/App.tsx`：`computerLease` 改由 `buildComputerLeaseView()` 从 `BrowserComputerSnapshot` 推导人类优先 / 急停 / 抢占 / 权限拒绝 / 空闲五态，不再只传 `active` 布尔。
- **构建** `apps/desktop-host/scripts/build.mjs`：把 `assets/illustrations` 复制到 `dist/renderer/illustrations`。
- **验证**：`tsc -b`、desktop-host build、`ui.e2e` 9/9 与 `v2-obsidian-ui.e2e` 1/1 通过。

### Added / Changed（`V2-P3-03`：受控 Browser Use 与 Computer Use — `IMPLEMENTED_UNVERIFIED`）

- **浏览器/桌面操控契约** `packages/shared-protocol/src/{browser-computer.ts,index.ts}`：定义账号与 Profile、`ComputerUseLease`、浏览器任务与 runner report、人机交接（`awaiting_human`）、P5 一次性确认 token、OS 输入执行器与用户输入监控状态、`BrowserComputerSnapshot` Zod 契约（Zod 4 默认值使用 `.prefault({})`）。
- **租约、账号隔离与确定性浏览器运行时** `packages/runtime-core/src/{automation-security.ts,browser-runner.ts,human-input-monitor.ts,input-executor.ts,index.ts}`：实现 `AccountVault` 掩码/轮换/级联删除、Per-Character Browser Profile 路径越界拒绝、`ComputerUseLeaseManager` 设备级单主控 + TTL/心跳 + 用户物理输入抢占与自动恢复 + P0 双撤销、`DeterministicBrowserRunner`（`BrowserEnginePort`、逐步 guard、CAPTCHA 交接、页面注入只记录不提权）、`HumanInputMonitor`（`powerMonitor` idle + 合成事件排除）与 feature flag 默认关闭的真实 OS 输入执行器骨架（dry-run / `permission_denied` / `not_implemented` 诚实回执）。
- **Electron 隐藏窗口引擎、宿主 IPC 与 HUD** `apps/desktop-host/src/{main/electron-browser-engine.ts,main/v2-kernel-host.ts,preload/index.ts,renderer/director/bridge.ts,renderer/director/v2/signature-widgets.tsx,renderer/director/App.tsx,renderer/director/views/life-console-view.tsx}`：按角色/账号隔离 partition、`v2:auto-*` 浏览器/租约/P5/交接/清理 IPC、游戏租约与桌面租约双胶囊 HUD、生命总览 P3-03 面板；新增 ADR-004 强制回归测试。
- **验证**：P3-03 专项单测 22/22、runtime-core 90.16% 分支、`verify:gate` 7/7、`desktop-host build` 与 Electron 45 E2E 3/3 + `ui.e2e` 9/9 全绿；真实 OS 注入与 TCC 打包态授权待 `[REAL-DEVICE]`。

### Fixed（Tidepaper v3.1 验收修正 — `DONE`）

- **夜潮急停对比度** `apps/desktop-host/src/renderer/director/design-tokens.css`：暗色主题的急停横幅与「急停 F8」按钮由 `--rose` + 白字（实测 2.74:1）改为 `--halt-bg`（`color-mix(in srgb, var(--rose) 68%, #000)`），白字提升至 5.43:1；键帽改为黑 18% 底、白字 7.29:1；急停态「恢复自主」改白底深 rose 字 5.43:1。晨雾保持 5.82:1。
- **急停对比度回归断言** `apps/desktop-host/e2e/ui.e2e.spec.ts`：在既有主题对比度用例内按实际计算色（含半透明叠层合成）校验 `.btn-stop`、`.btn-stop .kbd`、`.wb-halt-copy`、`[data-v2-hud-resume]` ≥4.5:1，晨雾 / 夜潮各一轮。
- **生命中枢列表截断** `apps/desktop-host/src/renderer/director/views/life-console-view.tsx`：活跃目标与主仆约定条目改为标题单行省略 + 右侧状态 chip，列表禁用横向滚动，长标题不再撑破卡片。

### Added / Changed（`REQ-UI-01`：Tidepaper v3.1「潮汐纸 · 精修」中控台外壳 — `DONE`）

- **纸面材质与外壳令牌** `apps/desktop-host/src/renderer/director/{design-tokens.css,styles.css}`：`.card` 改为实底 + 细边 + 极轻阴影，玻璃模糊仅保留给 `obsidian-tide` / `tide-deep`；新增静态海图等高线 `--map-contour` 与 feTurbulence 纸纹 `--paper-noise`，移除 ambient 漂移动画；新增 56px 顶栏、统一页头、`.kbd`、`.seg`、急停按钮、焦点环 `--ring` 与纸面滚动条。
- **信息架构与角色卡** `apps/desktop-host/src/renderer/director/shell/sidebar.tsx`：导航重组为 此刻 / 角色 / 化身 / 生活 / 能力 / 治理（空组自动隐藏）；墨色方块品牌区；底部角色卡播放真实待机 WebM，向上弹出角色菜单并保留 `[data-character-switch]` / `[data-character-option]` / `aria-checked`。
- **顶栏在场胶囊与外观分段容器** `apps/desktop-host/src/renderer/director/shell/topbar.tsx`：新增仅由真实数据驱动的桌面/直播/游戏在场胶囊；皮肤、明暗、跟随系统合入 `.wb-appearance` 分段容器，全部既有 `data-*` 选择器与点击行为保持不变。
- **三层控制权 HUD 与急停横幅** `apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx`：展示 活动 · LifeActivity / 游戏角色 · GameCharacter / 桌面键鼠 · ComputerUse 三层租约；`ComputerUseLease` 未接线时如实标注「未接入 · P3」；急停态改为整条 rose 横幅与白色声呐。
- **PageHead 与四页落地** `apps/desktop-host/src/renderer/director/{shell/page-head.tsx,views/life-console-view.tsx,memory-panel.tsx,plugins-panel.tsx,providers-panel.tsx}`：新增统一页头组件；生命中枢、记忆、插件、模型页切换为眉标 + 衬线标题；记忆图谱 Canvas 颜色改为运行时解析主题 token。
- **`⌘K` 直达小鲸** `apps/desktop-host/src/renderer/director/{shell/command-palette.tsx,App.tsx}`：输入以 `>` 开头时顶部渲染「发给小鲸：…」并回车发送；新增底部快捷键提示条与纸面 Toast。
- **验证**：`pnpm typecheck` 退出码 0、`pnpm verify:gate` 7/7、desktop-host build 成功、Electron 45 E2E 第一组 3/3 与第二组 8/8 通过；浅/深 × Tidepaper / Obsidian / Tide Deep 截图见 `artifacts/tidepaper-v3.1/`；证据文档 `docs/v2/evidence/P3-tidepaper-v3.1-shell-verification.md`。

### Added / Changed（`V2-P3-02`：`LifeRuntime` 驱动的直播中控与 OBS 舞台 — `IMPLEMENTED_UNVERIFIED`）

- **直播中控与 OBS 舞台契约** `packages/shared-protocol/src/{live.ts,index.ts}`：定义 `LivePlatformId`、`LiveConnectionState`、`LivePlatformAdapterStatus`、`LiveSongQueueItem`、`LiveGiftThankBatch`、`LiveObsStagePayload`、`LiveSessionSummary` 与 `LiveRuntimeSnapshot` Zod 契约。
- **`LiveRuntimeV2` 核心运行时与版权门禁** `packages/live-stream-hub/src/{live-runtime.ts,live-runtime.spec.ts,index.ts}`：复用 `LiveEventHub` 护栏/去重/注意力调度，新增 `checkLivestreamSongRights`（四重版权拦截 `dev_only_non_commercial`/`unlicensed`）、`probeLivePlatformEndpoint`（绝不虚构在线状态）、礼物/进场/点赞合并防爆麦、点歌优先级排麦、OBS 舞台同步与场次总结。
- **宿主 7 路 IPC 与 Tidepaper 直播控件** `apps/desktop-host/src/{main/v2-kernel-host.ts,preload/index.ts,renderer/director/bridge.ts,renderer/director/views/life-console-view.tsx}`：挂载 `v2:live-*` 7 路 IPC 联动 `CharacterCore`/`PerformanceDirector`/`StageRuntime` 与 P0 急停，并在 Tidepaper 生命总览接入开播/下播/点歌拦截按钮，通过 `verify:gate` 7/7 与 Electron 45 E2E 4 套件。

### Added / Changed（`ADR-003` / `REQ-UI-01`：Tidepaper 潮汐纸主 UI/UX 升级与 P2/P3 实盘控制台 — `DONE`）

- **Tidepaper 多主题令牌系统** `apps/desktop-host/src/renderer/director/{design-tokens.css,styles.css}`：确立潮汐纸 Tidepaper（晨雾 Mist 暖白纸面 `#F3EFE7` + 墨蓝 `#142036` + 珊瑚落日 `#D14D2C` / 夜潮 `#0D1220`）为默认主界面并满足 WCAG AA ≥4.5:1 对比度，完整保留 Obsidian Tide 与 Tide Deep 可选主题及 5 种强调色（`coral/sea/whale/kelp/plum`）。
- **工作台壳层与 V2 生命中枢升级** `apps/desktop-host/src/renderer/director/{App.tsx,shell/sidebar.tsx,shell/topbar.tsx,v2/signature-widgets.tsx,views/life-console-view.tsx}`：对齐 Tidepaper「此刻 / 角色与化身 / 生活与舞台 / 能力与治理」导航、顶栏视觉主题与强调色选择器（`[data-skin-picker]`）、`Shift+Esc`/`F8` 双急停绑定，以及接入 `V2-P3-01` 表演舞台（2D/Live2D/VRM/OBS 切换、唱跳双语歌词与 NC 版权拦截）和 `V2-P2` 创作工坊/星露谷联机 Mods 实盘预检；通过 `verify:gate` 7/7 与 Electron 45 E2E 全套。

### Added / Changed（`V2-P3-01`：统一表演系统 `SingEngine` / `PerformanceDirector` / `StageRuntime` — `IMPLEMENTED_UNVERIFIED`）

- **歌唱授权、双语歌词时钟、舞蹈与舞台切换契约** `packages/shared-protocol/src/voice.ts`：定义 `PerformanceChannel`、`SongRights` / `SongRightsCheck`、`SingMode` / `SingBackendMode` / `SingRequest` / `SingRenderResult`、`BilingualLyricLine` / `LyricsClockFrame`、`DanceRoutine`、`SpeechPerformancePlan` / `SilenceDecision` / `PerformanceSnapshot` 与 `StageBackendKind` / `StageCharacterBinding` / `StageRuntimeSnapshot` Zod 契约。
- **歌唱引擎、音频时钟歌词同步与 6 层表演仲裁总控** `packages/voice-runtime/src/{performance.ts,performance.spec.ts,index.ts}`：实现 `evaluateSongRights`（四重版权拦截 `dev_only_non_commercial` / `unlicensed` 与无声线授权）、`parseBilingualLrc` / `LyricsClockSync`、`SingEngine`（严格隔离 SVS/SVC 与普通 TTS，诚实探针与导唱 WAV 提取 `preview_guide_tone`）及 `PerformanceDirector`（6 层动作优先级仲裁、`decideSpeechSilence` 自然沉默权、`AudioMixer` 并发唱伴音效与急停清零）。
- **2D / Live2D / VRM 3D / OBS 统一舞台化身调度与宿主 8 路 IPC** `packages/pet-renderer/src/{stage-runtime.ts,stage-runtime.spec.ts,index.ts}` & `apps/desktop-host/src/{main/v2-kernel-host.ts,preload/index.ts,renderer/director/bridge.ts}`：交付 `Desktop2dStageAdapter` / `Live2dStageAdapter` / `Vrm3dStageAdapter`（含 `visemeToVrmBlendShapes` / `visemeToLive2dParams` 映射）与 `StageRuntime` 无缝切维保留歌词/表情/口型状态，挂载 8 路 `v2:perf-*` / `v2:stage-*` IPC，通过 `verify:gate` 7/7 与 Electron 45 E2E 4 套件（真实神经歌声 Worker 与实机 3D/Live2D 画布渲染待后续真机验证）。

### Added / Changed（`V2-P2-08`：真实星露谷人机联机协作 `CoopRuntime` v1 — `IMPLEMENTED_UNVERIFIED`）

- **联机协作房间与控制权契约** `packages/shared-protocol/src/{coop.ts,index.ts}`：定义 `CoopRoomStatus`、`CoopParticipant`、`CoopTaskItem`、`CoopResourceReservation`、`CoopModCompatibilityReport` 与 `CoopRuntimeSnapshot` Zod 契约。
- **`CoopRuntimeV1` 核心运行时与 Mod 兼容性预检** `packages/game-bridge-mcp/src/{coop-runtime.ts,coop-runtime.spec.ts,index.ts}`：交付成员独立 `GameCharacterControlLease`（人机互不抢权 + P0 全局急停隔离）、Task Board（原子锁启动/交接/`UNCERTAIN` 转 `blocked` 真实回执）、`sell_forbidden`/`keep` 防误卖资源门禁、`evaluateCoopModsCompatibility` 与断线宽限保活/超时自动释放锁防死锁恢复。
- **宿主 8 路联机 IPC 与实盘 Mods 扫描** `apps/desktop-host/src/{main/v2-kernel-host.ts,preload/index.ts,renderer/director/bridge.ts}`：挂载 `v2:coop-*` 8 路 IPC（含 `@workbench/stardew-mods` 真实扫描），通过 `verify:gate` 7/7 与 Electron 45 E2E 全套（待双端真实游戏联机游玩验证）。

### Added / Changed（`V2-P2-07`：`AssetRegistry`、舞台/场景/声音资产创作与版本回滚 — `DONE`）

- **统一十态 AssetRegistry 与音画质检契约** `packages/shared-protocol/src/media.ts`：新增 `AssetRegistryCategory`、`StageSceneInspection`、`SoundAssetInspection`、`AssetVersionRecord`、`AssetRegistryEntry`、`AssetIntegrityCheck` 与 `CommercialCleanExportResult`。
- **舞台背景/音效工坊、十态版本回滚与商用清源门禁** `apps/desktop-host/src/main/{asset-registry-v2.ts,asset-registry-v2.spec.ts,v2-kernel-host.ts}` & `apps/desktop-host/src/{preload/index.ts,renderer/director/bridge.ts}`：实现 `createProceduralStageScenePng` / `inspectStageSceneAsset`、`synthesizeSfxWav` / `inspectAudioAsset`（RIFF WAV `fmt`/`data` 解析与削波检测 + OGG/MP3/M4A 嗅探）、`AssetRegistryV2`（不可变快照、`validation_failed`/未审批发布阻断、SHA-256 防篡改、一键回滚与 `exportCleanBundle` 拦截 `CC BY-NC-SA 4.0`），挂载 9 路 `v2:asset-*` / `v2:stage-scene-create` / `v2:sound-sfx-create` IPC 并通过 `verify:gate` 7/7 与 Electron 45 E2E 全套。

### Added / Changed（`V2-P2-06`：游戏像素人物流水线与 Stardew Avatar Mod 导出核验 — `IMPLEMENTED_UNVERIFIED`）

- **11 步像素流水线与 Stardew 导出核验契约** `packages/shared-protocol/src/media.ts`：新增 `PixelPipelineStep`、`PixelSpriteQaReport`、`PixelAvatarJobRequest`、`PixelAvatarJobSnapshot` 与 `StardewAvatarExportVerification` Zod 契约。
- **纯 Node PNG 编解码、11 步流水线与 `WhaleIsleAvatar` 导出一致性校验** `apps/desktop-host/src/main/{pixel-avatar-v2.ts,pixel-avatar-v2.spec.ts,v2-kernel-host.ts}` & `apps/desktop-host/src/{preload/index.ts,renderer/director/bridge.ts}`：实现内置 `node:zlib` 8-bit RGB/RGBA PNG 编解码（支持 Filter 0–4）、`PixelAvatarPipelineV2`（贯通 CharacterBible 锁定、4×6 投影切格、脚底对齐 1×/2×/4× 缩放、白边清理、调色板量化、空帧超限 QA、SHA-256 溯源、审批门禁与单人/联机 profile 原子导出）及 `verifyStardewAvatarExport`，接入 5 路 `v2:pixel-*` IPC；实测 `dotnet build`（0 警告）暂存 `WhaleIsleAvatar.dll`、`verify:gate` 7/7 与 Electron 45 E2E 全绿（星露谷实机画面目视确认待人类补验）。

### Added / Changed（`V2-P2-05`：Character Bible、2D/Live2D 创作与 CrossPet 全量合法导入 — `IMPLEMENTED_UNVERIFIED`）

- **Character Bible / Live2D / 授权拦截 / CrossPet 导入契约** `packages/shared-protocol/src/media.ts`：新增 `CharacterBibleUpsertRequest`、`CharacterBibleAttachRefRequest`、`Live2dLayerRole`、`Live2dAssetInspection`、`AssetDistributionChannel`、`LicenseDistributionCheck`、`Asset2dStudioPackage`、`CrossPetImportRequest`、`CrossPetImportedEntry` 与 `CrossPetImportResult`。
- **Character Bible、2D/Live2D 质检与 CrossPet 全量合法导入** `apps/desktop-host/src/main/{character-studio-v2.ts,character-studio-v2.spec.ts,v2-kernel-host.ts}` & `apps/desktop-host/src/{preload/index.ts,renderer/director/bridge.ts}`：实现 `CharacterBibleStore`（参考图 QA 与候选区审批晋升联动）、`inspectLive2dOrLayered2d`（Cubism `model3.json`/`.moc3`/纹理/口型与 2D 分层完整度质检）、`evaluateAssetDistributionPolicy`（强制阻断 `CC BY-NC-SA 4.0` / `DEV_ONLY` / 未审图进入公开直播或商用分发）与 `CharacterStudioV2.importCrossPetPack`（实测随包 30 个 CrossPet 角色全量合法导入与 Bible 建档），接入 10 路 `v2:bible-*` / `v2:2d-*` / `v2:crosspet-import` IPC，通过 `verify:gate` 7/7 与 Electron 45 E2E 全套。

### Added / Changed（`V2-P2-04`：3D 大模型生成与 Blender 自动化后处理流水线 — `IMPLEMENTED_UNVERIFIED`）

- **3D / VRM 质检契约** `packages/shared-protocol/src/{media.ts,media.spec.ts}`：新增 `Mesh3dProviderProtocol`、`BlenderToolchainStatus`、`VrmInspectionReport`、`Pipeline3dRequest` 与 `Pipeline3dJobSnapshot` Zod 契约。
- **GLB/VRM 二进制质检与无头 Blender 后处理编排** `apps/desktop-host/src/main/{pipeline-3d.ts,pipeline-3d.spec.ts,v2-kernel-host.ts}` & `apps/desktop-host/src/{preload/index.ts,renderer/director/bridge.ts}`：实现 `inspectGlbOrVrm`（真实解析 glTF 2.0 / VRM 0.x / 1.0 二进制块，校验网格/Humanoid 核心骨/BlendShapes/口型 Viseme，裸 GLB 在要求 VRM 时拒绝通过）、`detectBlenderToolchain`、headless Python 后处理脚本生成器与 `Pipeline3dManager`，挂载 `v2:3d-*` 4 路 IPC 并通过 `verify:gate` 7/7 与 Electron 45 E2E（本机缺 Blender 与 Hunyuan3D 服务待真机补验）。

### Added / Changed（`V2-P2-03`：`MediaGenerationGateway` 与图片生成流水线 — `IMPLEMENTED_UNVERIFIED`）

- **媒体生成与十态资产契约** `packages/shared-protocol/src/{media.ts,media.spec.ts,index.ts}`：定义 Blueprint 06 十态管线、`MediaProviderCapability`、`CharacterBible`（含三视图参考图与 `forbiddenChanges`）、`AssetProvenance`、`MediaCandidateItem` 与 `MediaJobSnapshot` Zod 契约。
- **统一生图网关与候选区审查隔离** `apps/desktop-host/src/main/{media-gateway.ts,media-gateway.spec.ts,v2-kernel-host.ts}` & `apps/desktop-host/src/{preload/index.ts,renderer/director/bridge.ts}`：实现 `MediaGenerationGateway`（诚实探测本地 Coding Agent 生图能力与在线付费属性、Character Bible 提示词与已批准参考图过滤、独立候选区 `<userData>/media-candidates/` QA 校验与磁盘恢复、`approved` 门禁禁止跳过审查发布），并挂载 5 路 `v2:media-*` IPC。33 专项单测、`pnpm verify:gate` 7/7 与 4 个 Electron 45 E2E 套件全绿。

### Added / Changed（`V2-P2-02`：开放生态与插件进程隔离 — `REQ-SEC-01 DONE` / `REQ-EXT-01 IMPLEMENTED_UNVERIFIED`）

- **生态与隔离契约** `packages/shared-protocol/src/{ecosystem.ts,ecosystem.spec.ts,index.ts}`：定义 `PluginTrustLevel`、`ToolRiskTier`（`P0_READ`–`P5_FORBIDDEN`）、`PluginSandboxHealth`、`AgentSkillManifest`、双向 MCP 描述/审计及 Harness 集成等级契约。
- **Worker Isolate 插件沙箱、`PolicyBroker` 与 `SkillRegistry`** `packages/plugin-kit/src/{v2-sandbox-skills.ts,v2-sandbox-skills.spec.ts,index.ts}`：实现剥离宿主机敏感 `process.env`、限堆内存、死循环超时 `worker.terminate()` 强杀与跨线程 Broker 的 `IsolatedPluginRunner`；实现 P0–P5 与 `vault://`/`shell://` 硬拒审计 `PolicyBroker`；实现解析 `SKILL.md` 与静态危险脚本扫描拦截的 `SkillRegistry`。
- **宿主退役主进程第三方插件直连装载** `apps/desktop-host/src/main/plugin-host.ts`：全面切换为 `IsolatedPluginRunner` + `PolicyBroker`，通过 Electron 45 E2E 外部插件发现→启用→审批→调用验收。
- **双向 MCP 与多 Harness 扩展** `packages/agent-harness/src/{mcp-bridge.ts,mcp-bridge.spec.ts,providers.ts,index.ts}`：实现 `WhaleMcpClient`（Streamable HTTP + STDIO）、受控鉴权与递归脱敏 `WhaleMcpServer`、执行级隔离器 `executeHarnessTask` 及 Codex/OpenCode/Pi/OpenHands 预设。`pnpm verify:gate`（7/7）与 4 个 Electron 45 E2E 套件全绿。

### Added / Changed（`V2-P2-01`：攻略学习闭环增强 — `IMPLEMENTED_UNVERIFIED`）

- **攻略知识与兼容契约** `packages/shared-protocol/src/{knowledge.ts,knowledge.spec.ts,index.ts}`：定义 `GameKnowledgeItem`、`GuideProvenance`、`GameRuntimeContext` 与 `GuideCompatibilityReport` Zod 契约。
- **版本/Mod 兼容检查与溯源索引** `packages/game-bridge-mcp/src/guide-library.ts`、`tools/guide-forager/src/forage.ts`：`parseGuideProvenance` 解析来源类型/URI/版本/Mod，`detectRuntimeContextFromState` 提取运行期环境，`evaluateGuideCompatibility` 检测跨版本（`outdated`）与缺 Mod（`mod-mismatch`）并降权警告；`renderGuideMarkdown` 输出完整 `gameId / sourceType / gameVersion / modContext` 元数据头。
- **实玩置信度演进、反例积累与复盘闭环** `packages/game-bridge-mcp/src/{strategy-notebook.ts,reflection.ts,llm-prompt.ts,llm-planner.ts,guide-learning-v2.spec.ts}`：`StrategyNotebook` 向后兼容加载 v1 存档并支持 `recordVerificationOutcome`（成败升降置信度与反例积累）、`auditVersionCompatibility` 与 `toGameKnowledgeItem`；`LlmPlanner` 将真实动作回执联动至心得本且维持 ≤500 行预算（493 行）。64 专项单测、`pnpm verify:gate` 7/7 与 4 个 Electron 45 E2E 套件全绿。

### Added / Changed（`V2-P1-06`：星露谷 AI-First 自主游玩与控制权执行闭环 — `IMPLEMENTED_UNVERIFIED`）

- **三方控制权租约与 13 项控制指令** `packages/game-bridge-mcp/src/control-lease.ts`：新增 `GameCharacterControlLease`（`ai | human | paused | halted` 与 TTL 租约）、`PausedBrainPlanner`（AI 安全暂停等待器）及 `parseControlCommand`（覆盖 `Stop / Pause AI / Resume AI / Take Over / Release Control / Follow Me / Stay Here / Do This / Go Fish / Go Mine / Cancel Task / What Are You Doing? / Show Plan` 13 项控制语义）。
- **清除默认静默规则代驾** `packages/game-bridge-mcp/src/{brain-switch.ts,llm-planner.ts}` & `apps/desktop-host/src/main/autodrive-host.ts`：缺 Key 或 LLM 连续异常默认切换 `'paused'` 安全暂停并提示主人，不再静默落入 `RulePlanner`（仅保留 `allowRuleStandin` 显式 opt-in 手动/测试模式）。
- **世代隔离、急停联动与 HUD 状态** `packages/game-bridge-mcp/src/autodrive.ts`、`apps/desktop-host/src/{main/v2-kernel-host.ts,renderer/director/v2/signature-widgets.tsx}`：接入 `submitScopedDirective`（`expectedSessionId` + `expectedGeneration` 过期拒收）、动作前置控制租约门禁、V2 急停触发 `runner.emergencyStop` 与 HUD `'paused'` / `'rule'` 诚实徽章。
- **全量门禁与 E2E 回归**：新增 `ai-first-v2.spec.ts` 覆盖 Blueprint 17 §12 12 项场景，修正 `tools/soak-real/src/cli.spec.ts` `chatReplies` 索引越界夹紧问题；`pnpm verify:gate`（7/7）与 4 个 Electron 45 E2E 套件全绿，待真实《星露谷》+ SMAPI 客户端实机联调与浸泡。

### Added / Changed（`V2-P1-05`：Obsidian Tide 中控台重构与核心工作流界面）

- **Obsidian Tide 四大签名组件与真实阶段标注** `apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx`：实现 `SonarRing`（投射 9 态 CharacterCore 呼吸/游戏/说话/急停态）、`ReceiptChip`（严格 `PENDING | COMPLETED | FAILED | UNCERTAIN` 四态）、`LicenseBadge`（非商用/GPL/商源清晰区分）、`StageBadge`（P2/P3/P4 未接线能力诚实标注）与置顶常驻 `ControlOwnershipHud`（支持 `F8` 急停、`F9` 接管/交还、`F10` 安静睡眠）。
- **`App.tsx` Strangler 模块化拆解** `apps/desktop-host/src/renderer/director/{App.tsx,views/*,shell/*,bridge.ts,styles.css,design-tokens.css}`：将 `App.tsx` 从 1,466 行拆减至 914 行，拆出 `ChatView`/`ChatAside`（`views/chat-view.tsx`）、`GameWorkspaceView`（`views/stardew-view.tsx`）及全新「V2 生命中枢」控制台（`views/life-console-view.tsx`，直连 12 域快照、多轨混音与口型预览、四级诚实额度矩阵、五类记忆与级联真删除）；补齐 `system/dark/light` 三态主题、`F8/F9/F10/⌘K` 全局控制并修复 `.wb-top` 下拉菜单层叠上下文。
- **全量 Electron 45 E2E 回归**：新增 `apps/desktop-host/e2e/v2-obsidian-ui.e2e.spec.ts`，联合 `ui.e2e.spec.ts`（8/8）、`desktop.e2e.spec.ts`、`v2-kernel.e2e.spec.ts` 及 `pnpm verify:gate`（7/7）全部通过。

## [Unreleased] — 2026-11-25

### Added（`V2-P1-04`：类人五类记忆与经验成长）

- **五类记忆与审计契约** `packages/shared-protocol/src/{memory.ts,memory.spec.ts,index.ts}`：定义 `MemoryCategory`（`working | episodic | semantic | relational | self`）、`MemoryRetentionPolicy`、`MemoryUncertaintyLevel`、`MemoryCorrectionEntry`、`FuzzyImpression` 与无明文 `MemoryDeletionAudit`。
- **类人记忆图谱与级联真删除** `packages/memory-graph/src/{store.ts,retrieve.ts,memory-v2.spec.ts}` & `packages/local-store/src/sqlite.ts`：实现情绪半衰期加权与同向召回、模糊印象归纳（`consolidateRelationalImpressions`）、不确定性提示、用户纠正（`correctNode`）、`Self` 保护域与级联真删除（`hardDelete` 清除衍生摘要、原子重写磁盘 JSONL 抹除原文、联动 SQLite `deleteViewerByUid` 并留存无明文审计）。
- **Electron 宿主接线** `apps/desktop-host/src/{main/v2-kernel-host.ts,main/index.ts,preload/index.ts}`：暴露 `v2:memory-*` IPC 通道，同步更新 `CharacterCore.profile.updateMemoryRef`；扩展 `v2-kernel.e2e.spec.ts` Electron 45 E2E 校验。

### Added（`V2-P1-03`：模型供应商与四级诚实额度矩阵 — `IMPLEMENTED_UNVERIFIED`）

- **额度矩阵契约** `packages/shared-protocol/src/{quota.ts,quota.spec.ts,index.ts}`：定义 `ProviderQuotaReport`（`official_api` | `verifiable_third_party` | `cli_status` | `unknown` 四级来源、余额、5h/日/周/月窗口、认证状态、错误详情与脱敏摘要）与 `ProviderQuotaMatrix`。
- **预设扩展与统一探针** `packages/model-gateway/src/{presets.ts,quota-probes.ts,quota-probes.spec.ts,index.ts}`：新增 `kimi-moonshot`（CN/GLOBAL）预设与 `minimax` `CODING_PLAN` 变体；实现 DeepSeek / Kimi / OpenRouter / SiliconFlow / OpenCode Go / MiniMax Coding Plan / Ollama / 本地 CLI 状态探针；不支持查询厂商（OpenAI/Anthropic/MiniMax 按量/火山方舟等）强制返回 `queryable: false, source: 'unknown'`，绝不编造数字。
- **Electron 宿主接线** `apps/desktop-host/src/{main/provider-vault.ts,main/v2-kernel-host.ts,preload/index.ts}`：暴露 `v2:provider-quota` 与 `v2:provider-quota-matrix` IPC（主进程侧解析 Key 并脱敏错误摘要）；扩展 `v2-kernel.e2e.spec.ts` Electron 45 E2E 验证。待补 Kimi 与 MiniMax Coding Plan 真实 Key 实测。

### Added（`V2-P1-02`：真实 `VoiceProvider`、独立 `VoiceIdentity`、口型联动与多轨 `AudioMixer` — `IMPLEMENTED_UNVERIFIED`）

- **语音与混音契约** `packages/shared-protocol/src/{voice.ts,voice.spec.ts,index.ts}`：定义 `VoiceProviderStatus`、`LipSyncFrame`、`VoiceSynthesisRequest` / `Output`、`AudioTrackState`、`SpeechFloorHolder` 与 `AudioMixerSnapshot`。
- **独立语音运行时 `@workbench/voice-runtime`** `packages/voice-runtime/src/`：实现 `CloudOpenAiTtsProvider`、`MiniMaxTtsProvider`、`LocalAudioWorkerProvider` 与诚实降级 `SystemFallbackVoiceProvider`（macOS `say` / Windows 注入安全 PowerShell SAPI）；实现 `VoiceProviderRouter`（`VoiceIdentity` 解耦路由、LRU 缓存、分句预取、降级标明）；实现 RIFF/PCM16 WAV 能量+过零率口型提取与 `LipSyncTimelinePlayer`；拆分 `SpeechFloorArbiter` 与非阻塞多轨 `AudioMixer`（BGM 自动压低/恢复 + 按轨输出设备路由）。
- **Electron 宿主与桌宠口型接线** `apps/desktop-host/src/{main/v2-kernel-host.ts,main/index.ts,preload/index.ts,renderer/pet-stage/main.ts}`：暴露 `v2:voice-*` IPC、接入 `AudioMixer` 鸭降与 `pet:lip-sync` 桌宠 Viseme/幅度联动；扩展 `v2-kernel.e2e.spec.ts` Electron 45 E2E 校验。待补真实云端 Key 联调、人工听感与 Windows SAPI 硬件验收。

### Added（`V2-P1-01`：模块化 12 域 `CharacterCore` 与最小 `LifeRuntime`）

- **12 域共享契约** `packages/shared-protocol/src/{character.ts,character.spec.ts,index.ts}`：定义 `Identity` / `Personality` / `Preferences` / `Emotion` / `Motivation` / `Goals` / `Commitments` / `Relationships` 引用 / `Memory` 引用 / `VoiceIdentity` / `Embodiment` / `ActivityState` 与 `CharacterCoreSnapshotSchema`。
- **独立域核心包 `@workbench/character-core`** `packages/character-core/src/`：拆分为 `PersonaProfileStore`、`PreferenceStore`、`EmbodimentRegistry`、`EmotionStateEngine`、`GoalManager`、`CommitmentLedger`、`LifeRuntime` 与组合根 `CharacterCore`；支持原子落盘（`v2-character-core.json`）与损坏快照隔离恢复；`dependency-cruiser` 新增 `character-core-boundary` 边界规则。
- **Electron 宿主单源接线** `apps/desktop-host/src/{main/v2-kernel-host.ts,main/index.ts,main/character-persona.ts,preload/index.ts}`：`switchDefaultCharacter` 切外观时仅更新 `char_xiaojing` 的 `desktop-2d` Embodiment，保留身份、目标、约定与人格演进；`autodrive` 决策、回执情绪刺激与手动接管同步至 `LifeRuntime` 与 `CharacterCore`；扩展 `v2-kernel.e2e.spec.ts` 真机 Electron 45 E2E 校验。

### Fixed（推理模型 `reasoning_effort` 与输出令牌预算适配）

- **`ModelGateway.chat()` 透传 `reasoning_effort` 与 `cached_tokens`** `packages/model-gateway/src/{gateway.ts,presets.ts}`：OpenAI 兼容请求支持可选 `reasoningEffort`（`'minimal' | 'low' | 'medium' | 'high'`）并兼容读取 `usage.prompt_tokens_details.cached_tokens` 计入 `cachedInputTokens`；`minimax` 预设新增 `MiniMax-M3.1-Flash`（`reasoning: true`）。
- **提高星露谷规划器与夜间复盘 `maxTokens` 上限** `packages/game-bridge-mcp/src/{llm-planner.ts,reflection.ts}`：将晨间计划（350→1600）、每步自主决策（450→1600）、adapter 决策（400→1200）及夜间复盘（400→1600）预算放大，避免强制自适应思考模型在 350–450 令牌内将配额全部耗尽于 `reasoning_content` 导致 `content` 为空而误触发 3 连解析失败代驾；`llm-planner.ts` 保持 489 行（≤500 行）。
- **`soak:real` 支持 `WHALE_SOAK_REASONING_EFFORT`** `tools/soak-real/src/cli.ts`：合法环境变量透传给 `ModelGateway`，未显式指定时对 `minimax` 默认注入 `reasoning_effort: 'low'`（DeepSeek 等普通供应商不注入）。

### Added / Changed（T-M6-72b：`soak:real` 同步 LLM 自主验收口径与 `human` 态防误判）

- **攻略、心得本与 Token 实装进 `tools/soak-real/src/cli.ts`**：新增 `loadGuideFiles()` 自动载入 `guide-forager/*.md` 全部 **12 专题**，为 `LlmPlanner` 传入 `<runDir>/notes/` 持久化心得本并绑定 `onInsight` 写入 `events.jsonl`（同时检查 `notebook.hasReflectedDay` 捕获只更新 `tomorrowHint` 的复盘）；接入 `ModelGateway.onUsage` 真实累加 `input/cachedInput/output/total` Token。
- **`human-control` 介入豁免与精细计时** `stuck-detector.ts` / `day-tracker.ts`：`StuckDetector` 在 `human-control(active=true)` 期间跳过 `clock-stall`、`bwf-self-pause` 与 `repeat-failure`，交还时清除接入期滞留文本并重置时钟基线；`DayTracker` 新增 `DayLlmStats` 追踪每日计划/修订、规则代驾占比、聊天建议采纳、`insight` 次数及跨日/收尾精确累计的临时介入次数与时长。
- **双模式汇报与退出码分流** `report.ts`：`--llm` 按 2026-11-25 自主模式口径（日数、0 卡死、金币上涨、计划/复盘/心得 ≥ 计划日数）判定 `pass` 与退出码，累晕与 2:00 遣返只记不判失败，报告新增 `## LLM 自主指标` 与总览「临时介入」行；`--no-llm` 保持原有 7/7 每日闭环口径不变。

### Added / Changed（T-M6-72：攻略学习、按存档经验心得本与每晚复盘）

- **攻略库切块索引与宿主侧 `read_guide` 伪工具** `packages/game-bridge-mcp/src/guide-library.ts`：按 `##` / `###` 将 Markdown 攻略稳定切为 `{topic, sectionId, title, summary(≤80字), text(≤2000字)}`（过滤 `History` 等样板节），每轮只注入 ≤800 字与当前季节/地点/计划最相关的索引；LLM 通过宿主直读伪工具 `{"tool":"read_guide","args":{"topic","section"}}` 按需读全文（每轮上限 2 节，绝不发往游戏也不占 `ActionLock`）。
- **补采 5 个日常新手与经济专题** `tools/guide-forager/src/forage.ts` + `guide-forager/*.md`：扩充 `TOPIC_PAGES` 至 **12 专题**并从 Stardew Valley Wiki 实抓 `开局前几周`、`四季作物收益`、`社区中心收集包`、`赚钱路线`、`工具升级` 5 篇（保留出处与 CC BY-NC-SA 3.0 声明），`autodrive-host.ts` 解除 4000 字截断全量加载并同步暴露 `stardew-notes/<saveName>.json` 持久化。
- **按存档持久化经验心得本** `packages/game-bridge-mcp/src/strategy-notebook.ts`：Zod 校验 `StrategyInsight`（`id, source, claim, when, verdict(adopt|defer|reject|refuted), why, evidence[], createdDay, updatedDay, hits`）；按游戏存档名持久化至 `stardew-notes/<saveName>.json`；容量上限 200 条按「先淘汰久未引用的 `refuted`，再淘汰 `hits` 最低」回收；每轮检索 Top 5 注入 prompt，引用 `usedInsight` 即刻 `hits+1` 并发射 `insight` 事件供事后追溯。
- **每晚幂等复盘与明日打算闭环** `packages/game-bridge-mcp/src/reflection.ts`：在 LLM 决定 `sleep` 前（或 `≥24:00` 且当日已有回执时）每日幂等触发一次复盘，聚合当日计划、回执与失败签名 Top 3 修订或推翻既有心得、生成 `tomorrowHint` 注入次日晨间计划；复盘异常或乱码静默跳过，绝不阻断睡觉。
- **中控台星露谷页只读展示** `apps/desktop-host/src/renderer/director/App.tsx`：新增「当日计划（只读）」与「心得本（只读）」卡片，并在 `EventCard` 渲染 `plan` / `insight` / `brain` 事件。`llm-planner.ts` 保持 **489 行（≤500 行）**。

### Added / Changed（T-M6-70：LLM 全权决策模式、当日计划、强制命令分流与规则临时代驾）

- **移除规则代决，`llm-planner.ts` 瘦身至 487 行（≤500 行硬门禁）**：删除 `LlmPlanner` 内全部替模型做主的硬编码分支（满包救援阶梯、23:00/低体力/低血量强制改写、`LOW_SPACE_BLOCKED`、冷却硬拦截、节日与砍树攒木确定性状态机）；LLM 在线可用期间 `RulePlanner.decide` 调用 **0 次**。拆出 `day-plan.ts`、`brain-switch.ts`、`llm-prompt.ts` 三个纯模块。
- **每日计划自拟与步中修订** `packages/game-bridge-mcp/src/day-plan.ts`：换日后首次可自由行动时生成今日计划（`{plan:[{goal,why}],mood}`），每轮注入决策上下文；支持任意步通过 `planUpdate` 增删改或标记完成，发射 `AutodriveEvent { type: 'plan', reason: 'morning' | 'update' }` 并在桌宠气泡/聊天流播报。
- **生存只提醒 + 失败记忆提示驱动 + T-M6-73 接管摘要注入** `packages/game-bridge-mcp/src/llm-prompt.ts`：每轮计算距 02:00 强制昏倒剩余分钟（深夜 `01:40` 精确报剩 20 分钟）、体力/生命百分比与背包空位，仅作风险提示不改动作；注入最近失败归一化签名、连败次数与时钟停滞秒数；`AutodriveRunner.setHumanControl(false)` 交还时的状态差异摘要自动注入下一轮 prompt 一次。
- **普通建议 vs `/` 强制命令三类分流** `chat-directive.ts` / `autodrive-host.ts` / `App.tsx`：
  - 普通非 `/` 消息：星露谷自驾 LLM 在线时进入「主人说」上下文，下一轮由模型按人设输出 `stance: accept | modify | decline` + `reply`（2 个游戏小时未表态自动过期），气泡发声并写入 `chat-stance` 事件统计采纳率；
  - 快捷命令（`/goto` `/fish` `/sleep` `/forage` `/state` `/stop`）：直达工具 P0 插队；修复 `App.tsx` 的 `parseDirective` default 分支此前把未知 `/xxx` 误当工具名直发的 bug；
  - `/自然语言` 强制命令：排在当日计划之前，严格校验只接受 `stance: execute` 或带非空 `reason` 的 `infeasible`（输出 `decline`/`modify`/缺表态自动拒收重问，连续 2 次不合规进代驾）；`execute` 持续至 `commandDone: true` + `COMPLETED` 回执（动作失败自动撤回声明继续推进）或 `/cancel`；LLM 离线时回退关键词直译，未命中如实告知「大脑离线，现在只能执行快捷命令」。
- **`BrainSwitch` 临时代驾与中途无缝同步** `brain-switch.ts`：无 Key、单次网关超时或连续 3 次无法解析/越权时切换 `rule-standin`（发射 `brain` 事件，中控台顶栏接管条显示「规则代驾中」），每现实 2 分钟探测恢复（补 Key 即刻恢复）；修复中途切换代驾时 `RulePlanner` 首次 `decide` 误把初始化当跨日清空当日失败记忆的隐患（先锚定 `dayKey` 再重放当日真实回执）。
- **卡死回归剧本升级 `S01–S07`**：按 T-M6-70 新语义更新 `S01`（LLM 自主读满包提醒与失败记忆选 `eat 太阳鱼 force=true`）、`S02`（死硬脚本触发 3 次全局熔断后转代驾推进时钟），新增正例 `S07-llm-failure-memory-forage.json`（海滩无鱼竿失败一次后读失败记忆改选 `forage`）。

### Fixed（T-M6-74：`localhost` 被解析到 IPv6 导致「游戏开着却报 MCP 不可达」）

- **现象**：中控台点「启动自动驾驶」返回 `BWF MCP 不可达（http://localhost:18088/mcp）——确认游戏已启动`，但同一时刻 `curl http://127.0.0.1:18088/settings` 是 200、游戏也确实开着。
- **根因**：macOS 上 `localhost` 优先解析到 IPv6 `::1`，而 BWF 的 HttpListener 只注册了 `http://127.0.0.1:<port>/` 前缀——`::1` 能建立连接但路由一律 404，宿主把 404 当成「连不上」，提示语又引导用户去重开游戏，等于把人带偏。
- **修复**：`StardewAdapter` 构造时用新增的 `normalizeBwfEndpoint()` 把 `//localhost` 换成 `//127.0.0.1`（不可达文案也用规范化后的地址，便于排查）；`bwf-settings` 的 `bwfBaseUrl` / `bwfMcpEndpoint` 默认改用 `127.0.0.1`。
- **验证**：单测 2 例（三种主机名输入、适配器报错文案不含 localhost）；`[REAL-DEVICE]` 修复前同一操作返回「不可达」，修复后返回 `{ok:true}` 并成功驱动游戏（`decision: fish` 进事件流）。

### Added（T-M6-73：BWF `playerInControl` 补丁，接管开关打通到游戏内）

- **补丁** `mods/bwf-patches/2026-11-25-player-in-control-settings.patch`：BWF 上游本来就有 `SetPlayerInControl(bool)`（取消在跑动作 + 停下内置 AI + 解冻时间 + 恢复玩家移动 + HUD 提示），但只有 F7 能触发。补丁把它接进 `/settings` 远程设置——`ApplyRemoteSettings` 收到 `playerInControl` 时切主线程调用（`Game1.player` 必须主线程；未进存档则记日志忽略），`SettingsSnapshot` 上报 `playerInControl` 供宿主回读。
- **宿主侧同步** `apps/desktop-host/src/main/bwf-settings.ts`：新增 `pushBwfPlayerInControl()`，POST 后隔一拍回读快照确认——补丁把设置排到主线程执行，POST 返回的快照还是旧值，不回读就等于假装成功；旧 DLL 快照里没有该字段，如实返回 `supported:false`。`autodrive:set-human-control` 现在同时停宿主 runner 并把开关下发到游戏，按 `reachable/supported/applied` 三态给出「游戏没连上 / 旧 DLL 请按 F7 / 接管未确认」的不同提示。
- **真机验证（`[REAL-DEVICE]`）**：`dotnet build -c Release` 0 警告 → 备份旧 DLL 装机 → 重启 SMAPI → `GET /settings` 出现 `"playerInControl": false` → `load_save 泡泡湾` → `POST true` → 回读 `true` → `get_state` 首行出现 `【玩家接管中】玩家按 F7 接管了游戏，你的游戏动作都会被拒绝` → `POST false` → 回读 `false` → 标记消失。**未验**：游戏内实按 F7（与远程调同一函数）、Electron UI 点击链路、桌宠右键菜单第三处开关。
- **验证**：`bwf-settings.spec.ts` 新增 5 例（新 DLL 命中、主线程竞态回读第二次才生效、旧 DLL 不重试直接报不支持、补丁在但一直没生效、连接拒绝）；`pnpm test` 124 文件 / **1501 用例全绿**、分支 **90.52%**。

### Added（T-M6-73：临时介入开关，宿主侧骨架）

- **runner `human` 态** `packages/game-bridge-mcp/src/autodrive.ts`：`setHumanControl(active, reason)` 进入时清空 pending 指令与卡死/熔断计数、`ActionLock.cancel('human-control')` 中止在飞动作，主循环在 `get_state` 之后短路——只读轮询，不发动作、不发 keepalive、不做卡死恢复；退出时重置 `lastMutationAt` 与哨兵，避免刚松手就补一条无谓 keepalive。新增事件 `{ type: 'human-control', active, reason: 'switch' | 'in-game' | 'resume', summary? }`。
- **与游戏内 F7 双向同步**：`get_state` 文本出现 `【玩家接管中】`（BWF 补丁标记，导出常量 `PLAYER_IN_CONTROL_MARKER`）→ 自动进入 `human` 态并广播 `reason='in-game'`；标记消失 → 自动交还。宿主开关与游戏内操作因此共用同一状态机，不会互相打架。
- **交还差异摘要** `describeHumanSession()`（纯函数）：用接管前与交还时的状态快照给出「主人接管了 X 分钟：金币 640→900（+260），时钟 …，位置 Farm→Town，体力 …」；缺快照时如实说「没有拿到可比对的游戏状态」，不编造变化。
- **IPC 与两处 UI**：主进程 `autodrive:set-human-control`（返回 `humanControl` 与降级提示）、`autodrive:status.humanControl`；中控台星露谷页顶栏新增接管条（「我来操作 / 交还给 AI」+ 状态文案），托盘快捷浮窗自驾页新增同款按钮，两处都由 `human-control` 事件驱动同步。
- **降级如实说明**：本轮没有改 BWF C# `playerInControl`（真机被长时 soak 占用，C# 无法编译验证），因此开关只保证「宿主侧立刻停手」；游戏内彻底松手需按 F7 或更新 BWF 补丁，开关返回里会带上这句提示。
- **验证**：`autodrive.spec.ts` 新增 5 例（接管态 0 决策且只发 `get_state`/`cancel_action`、`【玩家接管中】` 自动进出、交还摘要含金币差值、开关幂等、无快照不编造）；`pnpm test` 124 文件 / **1496 用例全绿**、分支 **90.51%**；`pnpm verify:gate` **7 过 / 0 跳过**。**真机未验**：桌宠右键菜单第三处开关、BWF 补丁、摘要注入 LLM prompt、`soak:real` 识别 `human` 态均留在 `T-M6-73`（状态 `DOING`）。

### Fixed（soak:real 每日闭环口径：区分「没做」与「没事可做」）

- **问题**：`day-tracker` 的每日闭环只认「当天出现对应工具的 COMPLETED 回执」，`N/A` 仅覆盖冬季/季末不买种不播种。真机连续 5 次浸泡都是「闭环 0/1」，但事件流显示读信、收获、买种、播种当天根本没有机会（无未读信、农场概况「可收获 0」、无空耕地、背包无种子），属于把「没事可做」误判成失败。
- **修复**：`StatePatch` 新增 `opportunity` 字段，由 CLI 从真实 `get_state` 解析（`parseFarmSummary` / `parseSeedInventory` / 未读信件数 / `seedShopStatus` 营业时间）后传入；`DayTracker` 全天取并集，只在「拿到过状态且全天从未出现机会」时把 mail/water/harvest/buySeeds/plant 记 N/A。
- **防空绿**：观察者关闭或状态解析失败时 `opportunity` 为 undefined，机会型 N/A 不启用，退化为原严格口径；sleep 与 ship 永远没有 N/A，仍是硬锚点，因此部分日（未跑满）依旧判不完整。
- **报告**：`report.md` 的「每日闭环」表把 mail/water/harvest 三列也接入 N/A 渲染，脚注说明 N/A 的两类来源。
- **验证**：`pnpm test` 124 文件 / **1490 用例全绿**、分支 **90.46%**；新增 8 例（五项全无机会、各自触发、无空地不买不种、17:00 后不买种但可播种、无观测不启用机会型 N/A、出现一次机会即不 N/A、雨天 water 不 N/A）。**真机未复验**：当前浸泡进程加载的是改动前的 `dist`，新口径需要下一轮 `soak:real` 才能出真机证据。

### Added（T-M6-69：规则规划器每日闭环底线）

- **日程状态机** `packages/game-bridge-mcp/src/rule-schedule.ts`（新，零依赖纯决策层）：`survivalDecision`（体力 <8% 原地睡 / <15% 回家 / ≥24:00 强制回家睡 / 生命 <30% 先吃）→ `scheduleDecision`（读信 → 农舍出门看作物 → 雨天跳过的浇水 → 收获 → 出货 → 购种（营业/季末成熟/预算/空地前置检查）→ 播种 → 开垦（体力 >40% 且明确没有空地，默认 ≤15 格）→ 22:00 可配置收工 → 钓鱼/采集填充，两者都被避开则 wait 求助）。日程步骤「决策即记、失败回执撤销」，避免同一状态文本反复动作；收工前任何时刻人在农舍都会补一次「去农场看作物」，保证 T-M6-70 中途接手能续上当天日程。
- **种子表与季末判断** `seed-table.ts`（新）：春防风草 20g/4d、夏辣椒 40g/5d（重复收获）、秋小白菜 50g/4d，冬季不种；季内剩余天数 ≥ 成熟天数才买/种；买种预算同时受「保留 100g」「单次 ≤ 金币 60%」「不超过空地数」约束；数值标注以游戏内商店为准。
- **状态解析补强** `state-hints.ts`：`parseSeedInventory`（背包种子堆，跳过【留着】）、`parseFarmSummary`（真机「农场概况 + 农田」格式，兼容旧措辞；缺字段为 null 不猜 0）、`parseWeekday`（Tue/周二）、`seedShopStatus`（9:00–17:00、周三/节日休息）。
- **RulePlanner 改造** `planner.ts`：拆成「主动商店买种 → 菜单 → 生存护栏 → 满包救援阶梯（行为不变）→ 日程状态机」；跨日（含换季）重置日程与失败记忆；最近一次农场概况缓存供离开农场后的决策使用；商店界面若是自己开的先买种再处理界面。
- **多日活农场仿真** `tools/mock-harness/src/bwf-farm-sim.ts`（新）：日期/时钟/金币/体力/背包/农田/天气随工具调用真实变化，`get_state` 与真机 BWF 1.1.27 同段落同措辞；支持换日结算出货、作物过夜生长、雨天自动浇水、换季枯萎、周三/打烊商店、02:00 遣返与累晕扣钱；复用 `bwf-replay-server.ts` 抽出的 `startBwfHttpServer`（JSON/SSE 双形态），S01–S06 剧本保持全绿。
- **7 日纯规则闭环** `tools/mock-harness/src/rule-7day.spec.ts`（新）：真实 `RulePlanner` 在仿真里从春 16 跑 7 天——每日闭环项完成（当天无机会的项记 N/A）、7 项各至少完成一次、0 累晕、0 次 2:00 遣返、第 7 天金币 5890g > 第 1 天 1370g、`chat()` 0 次；跨季（春 26 → 夏 4）断言春季季末不买种、夏季自动改买辣椒种子。另有 `seed-table.spec.ts`、`rule-schedule.spec.ts`、`bwf-farm-sim.spec.ts` 与 `state-hints.spec.ts` 扩展覆盖每条优先级分支（周三/17:00 后不去商店、雨天不浇水、24:00 强制回家、中途接手）。
- **验证**：`pnpm typecheck` 通过；`pnpm test` 124 文件 / **1481 用例全绿**（含并行工单新增用例；本工单新增 `seed-table`/`rule-schedule`/`bwf-farm-sim`/`rule-7day` 四个 spec 与 `state-hints`/`autodrive` 扩展）、分支 **90.47%**；`pnpm verify:gate` **7 过 / 0 跳过**。真机（本机 SMAPI → BWF `McpPort=18088`，`--no-llm`）4 轮：① `artifacts/soak/20261125-105149`（夏5 09:50 **中途接手**）`take_items 喷壶` → `water_crops` 2 株 → 出货 → 钓鱼，25/25 回执成功，证明「任意时刻接手能续上当天日程」；② `artifacts/soak/20261125-114409`（夏8–夏9，**2/2 游戏日**）**0 卡死 / 0 累晕 / 0 次 2:00 遣返**，49 条回执 0 失败（成功率 100%），金币 35448g → 40202g（+4754g），夏8 浇水+出货+22:00 睡觉、夏9 浇水+出货完成；③ `20261125-121556`（夏9 21:20 接手 → 夏10 06:00）读信 1 封 + 收获 2 株 + 浇水 + 出货全完成，21 分钟后 SMAPI 本体崩溃（`recursive_mutex lock failed`）；④ `20261125-122237`（夏10 06:00）复现完整晨间闭环后玩家按 F7 接管（`human-control active`），按「键鼠接管停手」停止。报告里「闭环完整 0/2」是 `day-tracker` 的 N/A 口径所致（只覆盖冬季/季末买种播种；无未读信、无可收作物记「—」），当天的读写/收获/浇水/出货/睡觉回执均在事件流里，已由并行修复「soak:real 每日闭环口径」补上机会型 N/A。

### Fixed（T-M6-69：真机浸泡发现）

- **BWF 农场内作物段是明细格式**：站在农场时 `get_state` 没有「（农场概况：共 N 株作物…）」总览行，`parseFarmSummary` 整段返回 null，真机上表现为「播种完不浇水」。改为双格式解析（明细「需要浇水 N 株 / 可收获 N 株 / 零散耕地 N 格（其中 M 株作物）」与旧措辞并行，缺字段仍为 null 不猜 0）。
- **中文版浇水工具叫「喷壶」**：`take_items { item: '水壶' }` 被 BWF 判「所有地点的箱子里都没有水壶」，白冷却一天。背包识别用宽松正则（水壶/喷壶/Watering Can），取回用游戏内名字 `WATERING_CAN_ITEM = '喷壶'`，取回后当轮立刻浇水。
- **长动作执行中不抢动作**：`get_state` 顶部「【正在执行】sleep 已经执行 …」期间任何动作都会被拒，规则层连发会把失败刷成 `repeat-failure` 卡死签名（真机夏6 22:40 实测 2 次）。新增 `inProgressGuard()`（RulePlanner 决策第 0 步）：有执行中动作只 `wait` 15s，等它做完再决策。
- **水壶曾被当成可出货物**：`ESSENTIAL_RE` / `NON_SELLABLE_RE` 不含「水壶/喷壶」，测试里往背包加水壶后规划器会 `ship_items 水壶`。两个正则都补上，真机不会再把浇水工具卖掉。

## [Unreleased] — 2026-11-24

### Added（T-M6-68：卡死现场 → 永久回归剧本）

- **BWF 同构 HTTP 回放服务** `tools/mock-harness/src/bwf-replay-server.ts`：按剧本 JSON 应答 `tools/call`（JSON 与 SSE 双形态），维护 `get_state` 状态文本并按时钟锚点 `/时间：第\d+年[春夏秋冬]\d+日 \d{2}:\d{2}/` 推进；支持跨 24:00 换日、跨 28 日换季、跨年；模拟 BWF 选择题闸门（缺 `choice` 显性报错）、`freezeUntilMutation`（120s 自暂停文案 + 冻结时钟，变更动作解冻）、未覆盖工具显性报错。不复用 `stardew-simulator.ts`（WebSocket、工具面不同构）。
- **剧本 schema 与加载器** `stuck-scenario.ts`：Zod 校验 `id/signature/source/initialState/rules/freezeUntilMutation/llmScript/planner/expect`，重复 id、空目录、坏 JSON 全部报错；`planner` 支持 `rule|llm|idle`，`expect` 支持 `maxCycles/maxSameFailure/mustCallOneOf/clockMustAdvance/mustCallWithArgs`。
- **首批 6 个永久回归剧本** `tools/mock-harness/scenarios/stuck/`：S01 满包无箱木材 22、S02 海滩无鱼竿连败、S03 剧情多行选择题、S04 BWF 120s 自暂停冻结、S05 tidy↔store↔donate 无箱循环、S06 LLM 连败后 fallback 不知失败。`stuck-regressions.spec.ts` 每个剧本一条 `it`，驱动**真实** `AutodriveRunner` + 真实 `RulePlanner`/`LlmPlanner`，接入 Gate 3（Gate 输出打印剧本数量）。
- **现场包 → 剧本草稿转换器** `pack-to-scenario.ts`（`pnpm tsx tools/mock-harness/src/pack-to-scenario.ts artifacts/soak/<run>/stuck/<id>`）：复用 `soak-real` 的 `failureSignature()` 与现场包三件（`verdict.json`/`last50.jsonl`/`state.txt`）；`expect` 为占位值必须人工补全，缺 verdict 直接报错、缺 state 用占位说明，绝不编造现场。
- **卡死台账** `docs/STARDEW-STUCK-LEDGER.md`：签名｜首次出现｜频次（累计浸泡）｜剧本｜修复工单｜状态，与 6 个剧本一一对应；记录每个剧本「删一行修复 → 红 → 还原 → 绿」证据。
- **验证**：`pnpm typecheck` 通过；`pnpm test` 119 文件 / **1405 用例全绿**，分支覆盖率 **90.27%**；`pnpm verify:gate` **7 过 / 0 跳过**，Gate 3 输出「卡死回归剧本：6 个」。六条回退实验均确认变红（详见 ROADMAP T-M6-68 决策声明）。**真机现场包 → 转换 → 红 → 修 → 绿链路未执行**：当前无真机现场包（BWF 18080 未监听），VERIFY 登记待真机。

### Added（T-M6-67：`soak:real` 真机浸泡工具）

- **新 workspace 包 `tools/soak-real/`**：`pnpm soak:real -- --days N` 连真实 BWF（`McpPort=18088`）无人值守跑 N 个游戏日；支持 `--no-llm`、`--on-stuck=continue|stop`、`--max-hours`、`--observer-ms`、`--endpoint`、`--out`、`--save-dir`。LLM Key 只从 `WHALE_SOAK_PROVIDER / WHALE_SOAK_API_KEY / WHALE_SOAK_MODEL / WHALE_SOAK_BASE_URL` 读，缺项自动降级并在报告注明；Key 仅内存使用，不落盘不进日志。Ctrl+C 先 `stopAndWait()` 再写报告；退出码 `0` 达标 / `1` 卡死或闭环不达标 / `2` 连接或参数错误。
- **四条卡死判定**（纯状态机，`now` 由调用方注入）：游戏时钟现实 180s 未推进（睡觉决策后 10 分钟、过场/存档文案、02:00–06:00 换日窗口白名单）、同一失败签名最近 30 条回执内 ≥3 次且游戏时间推进 ≤1h、BWF 自暂停文案、runner `watchdog kind=stuck`；同签名 5 分钟冷却去重；失败签名归一化为 `工具｜原因模板｜地点`（抹掉坐标/引号物品/星级/数字/`<think>`）。
- **现场包** `artifacts/soak/<runId>/stuck/<序号>-<kind>/`：`verdict.json / last50.jsonl / state.txt / planner.json / screen.png / save/`（`screencapture -x` 与存档递归拷贝失败只写 `.err`，绝不抛异常）+ 全量 `events.jsonl`、`meta.json`（参数、LLM 模式、git HEAD、BWF `/settings` 快照）、`summary.json`、`report.md`。
- **每日闭环与报告**：跨日切分、雨天自动记浇水、冬季/季末买种播种记 `N/A`、累晕、2:00 遣返、金币曲线；报告含总览、每日闭环表、失败签名 Top10、卡死清单（链接现场目录）、金币表 + 内联 SVG；复用 `metrics.ts` 的 `summarizeAutodriveQuality` 输出成功率/失败率/重复动作/最长同工具/看门狗。
- **planner 只读快照**：`RulePlanner.debugSnapshot()`（阶段/冷却表/`avoidTools`/`rescueTried`）与 `LlmPlanner.debugSnapshot()`（objective/冷却/拒绝集合/fallback），卡死现场包直接落盘。
- **验证**：`pnpm typecheck` 通过；`pnpm test` 119 文件 / **1405 用例全绿**，分支 **90.23%**（同日另一次 90.33%）；`pnpm verify:gate` **7 过 / 0 跳过**（Gates 1–4 全绿，`卡死回归剧本：6 个`）。**真机 3 次**（AI 操作本机：SMAPI 拉起游戏 → BWF `McpPort=18088` → `load_save 泡泡湾`）：① `artifacts/soak/20261125-085545`（夏2，14.2 min，41 完成 / 1 超时，0 卡死）暴露累晕误判（见下方 Fixed）；② 修复后 `artifacts/soak/20261125-091123`（夏3，14.9 min，52 完成 / 2 失败，成功率 96%，**0 卡死 / 累晕 0 / 遣返 0 / 2:00 前睡觉 ✅**，金币 21174→21174，次日到账 24036；闭环 3/7，报告如实判「闭环不完整」、退出码 1）；③ 人造卡死 `artifacts/soak/20261125-092647`（`--on-stuck=stop` + `kill -STOP` 190s 后 `-CONT`）→ 恢复瞬间判 **`clock-stall`（06:40 停 197s）**，现场包 `stuck/01-clock-stall/` **7 件齐全**（verdict / last50（50 行）/ state（5.5KB）/ planner / **screen.png 1.7MB 3840×2160** / save（5 文件）），随即收尾退出 1。**限制**：游戏窗口不在前台时 `screen.png` 抓到整屏桌面（屏幕录制权限已就绪，非 `.err`）；LLM 模式未跑（无 Key，已自动降级并在报告注明）。

### Fixed（T-M6-67：真机浸泡发现「累晕」误判）

- **日记里的「晕倒过一次」被判成当天累晕**：`day-tracker.ts` 原先用 `/累晕|晕倒/` 匹配 `get_state` 原文，BWF 的长期笔记里写着「…晕倒过一次，睡前必须回家！」，导致真机第一次运行（`20261125-085545`，夏2）整天被记为 `passedOut`，报告结论与退出码随之出错。现改为 `PASSED_OUT_TEXT_RE = /累晕了|累晕过去|晕倒了|晕了过去|体力耗尽[^。\n]{0,6}(晕|倒)|passed out/i`（只认真实累晕事件），并补回归用例「日记/建议里的『晕倒过一次』不算当天累晕」；修复后真机 `20261125-091123` 累晕 0 天。

### Fixed（T-A：陪伴主循环·语音终态闭合）

- **节流命中补发语音终态**：`voice-host.speak()` 同文本 8s 节流命中时此前直接返回 `ok:true`，租约从未建立、`pet:speech-result` 永不到来，渲染层气泡停在 `waiting` 挂满 60s TTL（`BUBBLE_TTL_MS`）。现在节流命中按「已交付」补发 `completed` 终态，气泡立即干净收起；确立不变式「凡气泡等待语音收口，必有且仅有一个终态」。
- **空台词/内心戏关闭不发回执（经消费端核实）**：`showBubble(text='')` 本就隐藏（无等待气泡）；生产代码无 `scene:'inner'` 调用方，内心戏云朵泡不走对话泡生命周期。盲发回执反而可能在多宠排队场景污染同 agent 正在等待的另一条气泡（回执仅带 agentId 无 bubbleId），故保持不发并用用例锁定。
- **回归证据**：`voice-host.spec.ts` **8/8**（新增「8s 节流命中补发 completed 终态，气泡不挂 60s TTL」「空台词与内心戏关闭不产生回执」）；全仓 `pnpm test` 109 文件 / **1281 用例全绿**；`pnpm typecheck` 通过。

### Fixed（T-A2：雷区反射气泡在桌宠上从未显示——真机插桩发现）

- **`reflex_<actionState>` 工具名错位**：主进程反射回执 `tool` 为 `reflex_<actionState>`（autodrive-host），而 4 个消费点硬编码字面量 `reflex_spray`（桌宠气泡 pet-stage/main.ts、导演台事件区 App.tsx、桌宠工坊最新发言 pet-stage-panel、shared-protocol `toolLabelZh`）。`PetActionState` 枚举无 `spray` 值 → **所有角色的雷区反射气泡在桌宠上从未显示**（此前单测/E2E 均未覆盖此 DOM 行为）。统一改为 `reflex_` 前缀匹配；`toolLabelZh` 对 `reflex_*` 回退「雷区反射」（spec 新增 2 例）。
- **真机验证（AI 操作本机；宿主无屏幕录制权限，改用 CDP 插桩读渲染层 DOM + `pgrep say/afplay` 进程采样，不改应用行为）**：真实 userData 启动 → 雷区消息 → 气泡 0.3s 内出现 → `say` 2s 合成 + `afplay` 5.5s 播放 → **afplay 退出同一拍气泡收起**（租约回执收泡，非 60s TTL/静音挂字，全程无静音徽标）；冷却过期后第二句雷区再次闭环；`pet:say` 同句两连发第二次无发声（T-A 节流真机生效）。证据：`artifacts/real-device/`（CDP 截图 ×3 + 进程采样日志）。
- **限制如实记录**：终端上下文 safeStorage 解密失败（opencode-go/minimax，Keychain 访问受限）→ LLM `chat_reply` 气泡未能真机复验（与 ROADMAP T-M6-66① 症状一致）；反射冷却遮蔽下的节流场景未直接观测（由单测覆盖）。
- **回归**：`pnpm typecheck` 通过；`pnpm test` 109 文件 / **1283 用例全绿**；license-scanner 0 违规。

### Added（T-M6-63 ~ T-M6-65：桌宠深度体验三阶段）

- **T-M6-63 盘活随包素材与显示层级**：共享契约新增 `PetAvatarClip.facing/moving/category`、`PetDesktopPrefs.windowLayer/bubbleFontScale/patrolEnabled/notebookFontId/randomEggEnabled/peakOutfit*`；`resolvePoseCharacterProfile` 统一 custom-* 与随包 crosspet-* 的 pose-config/首见问候（立绘不计姿态、缺字段不猜）；气泡挂上首软糖体，8 套小本子手写体按家族映射；aboutme 动作保留分类/朝向/位移区间，三餐（06:30–09:30 / 11:30–13:30 / 17:30–20:30）×3、节日/季节 ×5、余额动作移出日常池，6 档余额动画 + 拖拽悬空动作；三档窗口层级（macOS screen-saver / Win11 floating）与气泡字号独立缩放（导演台 + 右键菜单）。
- **T-M6-64 交互升级与工作跟随进化**：`patrol-controller` 自主巡逻（25–45s 低概率 4–8s、moving 帧区间按 speed 位移、workArea 夹紧、≤8px 边缘反转、facing 镜像只作用于精灵）；三段式睡眠过渡（小憩/哈欠 2.5s → sleep_mute；惊醒 2s → idle）；剪影 head/face/body 分区点击；工作态晃动只记仇不中断、结束后按 ≥8/≥5/≥2 触发 redhot/puffed/annoyed，level≥3 两段式哄好 coaxed→forgiven；工作跟随 2 路 busy/3 路 swamped、asking/compact/error、≤4 张悬浮任务卡、Hook 后 5s log-watch 去重、idle-leave/app-exit/always-with-app 三策略、贴边自动探出与 10s 收回、主副角色自动对调防重影；CLI 钩子支持 PreCompact/Notification/PermissionRequest。
- **T-M6-65 小本子/彩蛋/日志/峰谷**：小本子双页（相处记录 + 朋友留言，留言者手写体、便签/贴纸/挚友双人对话卡 + 双头像），8 套纸张主题，`notebookFontId` 持久化；冷启动只读补录 Claude/Codex JSONL（只统计 timestamp/model/tool_use/function_call，marker 幂等、零正文）；`egg-theater` 15 个 egg-* 专属 host/hostSkin 优先、pop→pretend→抓包/溜走五段、并发防重入与退出清理；`cli-log-watcher` 1.5s 增量 (path,inode,offset)、启动 EOF、截断重置、坏行跳过、与 Hook 5s 去重；北京峰谷 00:30–08:30 空闲、仅跨边界换装一次，中控台/托盘 24h 时间条与皮肤选择。
- **回归证据（合并 main 502d907 后）**：全仓 **1278 tests / 分支 90.39%**；`pnpm verify:gate` **7 过 / 0 跳过**；`pnpm --filter @workbench/desktop-host build` 通过；全量 Electron E2E **13/13（6 spec，新增 `pet-evolution.e2e.spec.ts`）**，含 crosspet-claude 真实 pose-config、气泡 `ShangShouGummy`、`windowLayer`/`bubbleFontScale` 持久化与真实窗口置顶、小本子双页/8 手写体注入、彩蛋打开→抓包→收口无僵尸窗。macOS 真机与 Windows 11 验收清单见 `docs/VERIFY.md`。

### Fixed（T-M6-63~65 真机操作首轮）

- **原生右键菜单融合 T-M6-63/65 能力**：主分支已将右键升级为 `pet-context-menu.ts` 原生系统菜单；合并时把「显示层级（始终置顶 / AI 干活时 / 普通层级）」radio 子菜单与「彩蛋小剧场（专属优先）」并入原生菜单，旧 HTML 菜单整体移除，彻底突破 400px 窗口边界。
- **旧 1.3× 缩放不再污染窗口位置**：主分支移除缩放入口后，`PetDesktopPrefs.scale` 仍可能在任意设置变更时把窗口拉回 1.3× 并按旧宽度夹紧（desktop E2E 复现 60px 缝隙）。现在窗口读取时统一归 1.0×，设置回调不再同步旧 scale；缩放后的底边中心锚点也重新夹紧到工作区。
- **真机操作证据（AI 直接操作 macOS）**：真实点击「扫描本机历史记录补录」→ **42 个文件 / 5180 轮**，二次点击「本机已补录过」；小蓝狐（GLM）纸张「湖蓝便签」+ 志莽行书、小芽「星紫横线」+ 站酷快乐体；`s` 键睡眠 `sleeping:true` 闭眼、再按唤醒；桌宠窗口 x 228→283→308 自主巡逻；彩蛋剧场真实打开 egg 窗并在超时后自动关闭（无僵尸窗）；演示会话 8 次工具 → crosspet-claude 窗口戴皇冠 + 双任务卡绿勾；切小蓝狐后峰谷卡片真实出现且开关 toast 生效。指针相关的头/脸/身分区点击、晃动静默记仇/两段哄好、贴边探出与主副对调仍待人工复核（CUA 合成点击会落在真实指针位置，透明桌宠窗无法可靠模拟）。
### Added（T-M6-61 / T-M6-62：本机 Codex CLI 生图 + 星露谷像素角色同步）

- **T-M6-61 免 API Key 生图后端**：新增 `codex-image-backend.ts`，优先探测 `codex-imagegen`（uv 安装，Apache-2.0）、缺失时回退官方 `codex exec`；只检查 `~/.codex/auth.json` 是否存在，绝不读取/回传 token；`execFile` 参数数组、150s 超时（后端上限 180s）、输出脱敏与 PNG/WebP/JPEG 魔数校验；`image-gen-client` 新增 `codex-cli` 协议；创作中心供应商列表自动出现「本机 Codex CLI（免 API Key）」并标注快速/慢速后端。
- **T-M6-62 星露谷外观同步 Mod**：`mods/stardew-avatar-sync`（SMAPI 4.x / Stardew 1.6，C#/Harmony）读取主进程原子写入的 `active-avatar.json`，FileSystemWatcher 200ms 去抖后主线程重载；Harmony 挂 `FarmerRenderer.draw` **12 参主实现**（9 参重载会被 JIT 内联，拦不到），复用原版 position/origin/layerDepth/逐帧偏移，只替换 base 身体帧；`FacingDirection` 0上/1右/2下/3左 映射像素表行，walk/run 用原版动画索引驱动 4 相位步态；工具/鱼竿/手持物/表情仍由原版独立绘制；洗澡/坐下/骑马/木筏/游泳/睡觉/弹弓回落原版，坏图自动回落预设。`stardew-avatar-host` 提供 9 角色预设、一键安装/卸载、开关持久化、联机隔离 profile 写入；贴图按**内容哈希**命名（`stardew-sprite-<hash>.png`）绕开 SMAPI 的 ModContent 贴图缓存，运行中应用新图可真正热切换并清理旧版本。
- **像素表流水线升级 96×128 / 4×6**：行=下/右/上/左，列=待机/左脚在前/右脚在前/过渡/动作/表情；切格改为「行投影定位 4 条角色带 + 逐行列投影聚类 6 个角色」，不再按画布/内容包围盒硬切（修复 AI 出图列距 235px 时第一列被切半只）；整表共用同一缩放系数并脚底对齐（修复逐帧独立缩放导致走路时头忽大忽小/上下跳）；新增轮廓外白晕清理与 median-cut 24 色收敛（保留蓝发/肤色，避免抗锯齿近似色挤占色板）；仍为最近邻采样，输出颜色是输入颜色子集。
- **动作帧空手规则（真机修复）**：AI 会把「鱼竿/法杖」直接画进动作帧，游戏里原版又单独绘制鱼竿/工具，出现两根竿错位、手与竿割裂。提示词改为**所有帧必须空手**（待机/行走/动作/表情都禁止画鱼竿、斧头、法杖、木棍等），动作列只画向前伸出的手臂，工具与手持物统一由游戏引擎绘制；重新出图后真机验证持竿手部与鱼竿贴合。
- **创作中心「星露谷像素表」页签**：6 列提示词（逐列描述步态与动作）、目标角色选择、供应商/模型选择、96×128 单帧与整表 pixelated 预览、一键应用；游戏共玩页新增「同步桌宠形象进游戏」开关与「安装 Mod」。
- **最终 DMG（2026-11-24 21:10）**：重打 `release/鲸屿 Whale Isle-0.2.0-dev.1-arm64.dmg`（**2,374,340,843 B**），包含 T-M6-61/62、复盘优化与并行 `pet-stage` 拖拽修复；挂载校验 `Resources/mods/WhaleIsleAvatar/{manifest.json,WhaleIsleAvatar.dll 23,040B}`、`Resources/hooks/work-follow-hook.mjs`、`Resources/pet-packs/` 1.9G、`app.asar` 内 tray/popover 入口；无 `.temp*.dmg`，随后重启开发版应用。
- **回归证据**：`codex-image-backend` 12、`image-gen-client` 新增 2、`pixel-sprite-pipeline` **13/13**、`stardew-avatar-host` **13/13**、契约 1；`dotnet build` 0 警告；macOS 真机经创作中心真实出图（1536×1024，codex-imagegen），并在星露谷内 computer-use 验证四朝向、向右行走、钓鱼抛竿/鱼线/浮漂与 IPC 应用后的热切换。

### Changed / Fixed（T-M6-61/62 复盘：UI 真实性、安全边界与状态同步）

- **共玩页状态不再过期**：`stardew-avatar:state` 改为读取 Mod 目录 `active-avatar.json` 的真实同步角色，新增 `syncedCharacterId/syncedDisplayName/syncedSpriteReady`；开关/安装/卸载/切角色/应用后主进程广播 `stardew-avatar:changed`，渲染层实时刷新，展示「游戏内：X · 像素表/原版预设」「Mod 已安装/未编译」。
- **补齐缺失操作**：共玩页新增「同步当前」与「卸载 Mod」（带确认）；安装成功提示改为「重启游戏后生效」，不再暗示热加载 DLL。
- **像素表页签真实化**：共享「参考图」按钮不再是摆设——`StardewSpriteGenRequestSchema` 新增 `referenceImagePath`，主进程复核存在性/扩展名/大小后随请求发送（OpenAI edits / Gemini inlineData / codex-imagegen `--image`）；生成后提示「点一键应用生效」，应用后自动重读角色目录刷新预览；目标角色默认优先游戏内已同步角色，并显示「游戏内当前」。
- **超时与文案**：Codex CLI 生图超时 90s→150s（真实出图常见 60–120s，避免误杀），UI 文案同步并显示「约 30–90 秒」。
- **安全边界**：`stardew-avatar:apply-character` 只接受已注册角色且 id 必须匹配 `^[a-z0-9-]+$`，宿主 `spritePathFor` 再做一次路径包含校验（防 `custom-../../` 越界）；旧哈希贴图清理改为逐文件容错（Windows 上被游戏占用的旧图删不掉时不影响新图同步）。
- **联机文案纠偏**：Mod 只替换本端玩家（多开时每个实例各读自己的 active-avatar.json），删除未被消费的 `SendMessage` 广播与 `_peers` 死代码；README/manifest/ROADMAP/VERIFY 不再声称「同局队友各自形象」。
- **后台切角不再偷改游戏外观**：`switchDefaultCharacter` 不再写星露谷外观；只有用户显式动作才同步（共玩页开关/同步当前、创作中心一键应用、工作台或托盘手动切角）。启动恢复、召唤、前台应用、工作跟随等后台路径只换桌面桌宠，不会用过期会话覆盖用户已应用的像素表；真机验证启动后 `active-avatar.json` 保持 aboutme-gemini，而工坊手动切到小鲸/切回小芽会各自写回对应像素表。
- **像素目标默认当前桌宠**：创作中心像素页签每次打开默认选中当前桌宠（而非上一次临时覆盖的角色），显示「游戏内当前」并给出「目标不是当前桌宠」琥珀提示；应用后同步刷新「游戏内当前」与预览，避免状态自相矛盾。
- **E2E 去抖**：三游戏连接引导断言改为轮询等待 `data-game-conn` 从 `unknown` 落到 online/reachable/offline，消除探测未完成就读取导致的偶发失败。
- **E2E 与真实游戏隔离**：`PET_STAGE_E2E=1` 时星露谷外观宿主改用 `e2e-profile/e2e-mods` 空槽位；E2E 里的「同步开关」不再写用户真实 `Mods/WhaleIsleAvatar/active-avatar.json`（复盘时发现 E2E 曾把真实游戏目标改成 crosspet-claude），测试后真实文件保持 aboutme-gemini。


### Added（T-M6-60：macOS + Windows 11 双端托盘常驻与 Magpie 风格快捷浮窗）

- **托盘宿主 `tray-host.ts`**：macOS 18×18 `trayTemplate.png` + 36×36 `@2x`（`setTemplateImage(true)` 自动适配深浅菜单栏）；Windows 11 32×32 `tray-win-dark/light.png`，按 `nativeTheme.shouldUseDarkColors` 选取并监听 `updated` 实时切换。图标由 `scripts/generate-tray-icons.ts` 直接读取 `shared/brand.ts` 的鲸鱼路径生成（4×4 超采样 + 内置 PNG 编码，零外部图像库）；构建随 `assets/brand → dist/renderer/brand` 进入 asar。
- **跨平台智能锚点 `computePopoverBounds`**：托盘可用时按最近显示器边缘判断任务栏方位——macOS 顶部贴下方 6px、Win11 底部贴上方 8px、左右贴内侧；Win11 图标折叠进 `^` 溢出区导致 `tray.getBounds()` 全 0 时，回退光标所在屏 workArea 右下角并留 8px，绝不弹到 `(0,0)`；最终坐标夹紧在 workArea 内，覆盖多屏负坐标与 125%/150%/200% DPI。
- **常驻生命周期**：新增 `isQuitting`；关闭中控台只 `preventDefault + hide`；`window-all-closed` 仅在真正退出时结束进程；`app:quit` 统一置位 → `coopHost.stopAll()` → `tray.destroy()` → `app.quit()`；`ui:open-director` 可从托盘/Dock 复原中控台。点击托盘使用 250ms 失焦防抖（blur 隐藏后同一次点击不重开）；右键原生菜单（打开中控台 / 显示或暂藏全部桌宠 / 退出），Win11 额外双击托盘打开中控台；`PET_STAGE_E2E=1` 跳过真实系统 Tray。
- **Magpie 风格 360×500 快捷浮窗**：独立 `renderer/tray-popover` 入口（无边框/透明/置顶/跳过任务栏，macOS `vibrancy:'popover'`，Windows 透明窗 + CSS 圆角阴影），preload 复用 `directorBridge`。顶栏「鲸鱼 Logo + 鲸屿 + 自驾状态胶囊 + 刷新/中控台/验收台」；三段 Tab：桌宠（当前角色卡 + 9 角色快切 + 6 快捷动作 + 快捷发话 `/chat:say`）、自驾（真实探活/启停/目标条与取消/最近 3 回执/联机队友）、饭碗（SVG 环形余量 + 已用/档位 + 一键加饭 + 跨 AI 工作跟随活跃会话 + 语音开关/音量）；底栏「更新时间 · 复制 WebUI 地址」与「退出」。全部数据走真实 IPC，零 emoji、深浅双主题 CSS 变量。
- **回归证据**：`tray-host.spec.ts` 10/10（双端定位、溢出区回退、负坐标/DPI 夹紧、250ms 防抖、深浅图标、关闭隐藏 vs 退出）；Electron E2E 新增 1/1（三 Tab 真实渲染、9 角色胶囊、6 动作、饭碗余额、360×500 非 0 坐标、隐藏不闪退）；全仓 **1138 tests / 分支 90.3%**；`pnpm verify:gate` **7 过 / 0 跳过**；Electron E2E **12/12（5 spec）**。最终 DMG **2,374,124,696 B**（含 `trayTemplate.png`/`tray-win-light.png` 与 `tray-popover/`，挂载校验通过，无 `.temp*.dmg`）。macOS 真机已通过（2026-11-24），Windows 11 待后续真机。

### Added（T-M6-55 ~ T-M6-59：桌宠全字段运行、AI 直连出图、星露谷大脑进化、CLI 钩子向导、OBS 挂件收口）

- **T-M6-55 自定义角色全字段真运行**：新增 `greeting-schedule.ts`（6 时段 + 8 节日：公历元旦/万圣/圣诞/国庆，农历春节初一到初七/元宵/端午/中秋，内置 2025–2035 农历表零联网），按「角色 id + 日期 + 键」持久化去重；首见优先节日姿态 → 时段姿态 → 缺图回退每日问候。`custom:pose-config` 增发 `idleActions/glyph/apps`；ambient 空闲链按权重混播自定义立绘与内置氛围池；`#glyph-layer` 在 reading/searching 时渲染 3–5 个代码符号飘字（省电自动关闭）。主进程新增 macOS 3s 前台应用只读监听（`frontAppWatcher` + `matchCharacterForApp`，含随包 CrossPet apps），偏好 `followFrontApp` 默认关闭、关闭后严格保持手选角色。小本子/成就优先读自定义 `milestones`（`{h}` 替换当前小时）与 `notebook.notes/sign`。验收台新增 `acceptance:carousel`（主进程 1.5s 节拍）与 `acceptance:guides`，桌宠窗叠加 90% 身高虚线框 + 97% 脚底基线 + 姿态角标，停止/关闭弹窗自动回 idle。
- **T-M6-56 创作中心 AI 直连出图**：新增 `image-gen-client.ts`（OpenAI Images `generations/edits` 兼容 `gpt-image-1`/`dall-e-3` 与中转站，解析 b64_json/临时 url；Gemini Native `generateContent` + `responseModalities:["IMAGE"]` 解析 inlineData；单张 60s 超时、Key 全程脱敏）与 `image-gen-drafts.ts`（草稿目录防穿越、参考图校验 ≤20MB、并发 ≤2、done 文件收集）。`creator-host` 新增 `creator:image-gen-providers / generate-batch / regenerate-one / commit-draft`，实时 `creator:gen-progress` 推 data URL，草稿确认后直接复用 `importImages` 流水线（抠像 → 90% 脚底 → blink 贴回 → avatar/portrait → 热重载）。创作中心 A/B 页签新增供应商/模型选择、参考图、实时网格（queued/generating/done/failed + 重画）与「确认入库并后处理」；无 Key 时如实提示并可一键跳转「模型服务商」。
- **T-M6-57 星露谷大脑进化与联机同步**：`teamContext()` 明确 objectiveDone 完成判据（动作仍要执行，回执成功才算完成）；`LlmPlanner` 记录未确认的完成声明，`AutodriveRunner` 动作成功后广播 `目标已完成：…` 并结束目标，失败则撤回声明继续推进。新增 `state-hints.ts`（无鱼竿/商店 09:00-17:00 打烊/空位 ≤2/list_chests 摘要，≤240 字）注入每轮 user prompt。新增 `objective` 事件作为目标生命周期单点事实源；`autodrive:objective-status / clear-objective` IPC；游戏共玩事件流 4 种徽标（大脑决策/规则兜底/主人插队/目标推进中）、目标条与一键取消；联机 Agent 事件带 agentId 广播，Coop 共享同一 LlmPlanner 生命周期与 3 连败熔断。
- **T-M6-58 8 家 CLI 钩子一键安装**：新增 `work-follow-installer.ts`：Claude Code / Gemini CLI / Cursor 标准 JSON 钩子幂等合并（`.whale-isle.bak` 备份、坏 JSON/未知格式拒绝写入、卸载仅移除鲸屿条目），其余 5 家诚实标注「手动模式」并给可复制命令；钩子脚本同步到 `userData/work-follow/hook.mjs`（打包 `Resources/hooks`），脚本支持 stdin JSON（session_id/tool_name/hook_event_name）。`work-follow:self-test` 写入受控事件并验证轮询消费 ≤1.5s；工坊 Tab 4 新增 8 家状态卡片与安装/卸载/复制/自检。
- **T-M6-59 OBS 挂件收口**：`/obs` 复用中文化工具/状态词表（钓鱼/制作/已完成/失败），支持 `?layout=compact|card&theme=dark|light`，状态卡顶栏显示 `/api/state.characterName` 当前角色；中控台增加布局/主题选择并实时拼接带 token 的源地址。新增 `iteration.e2e.spec.ts` 覆盖创作中心生图入口、验收台参考线/轮播、CLI 探测与自检、OBS 中文化参数与目标条不伪造。重打 `release/鲸屿 Whale Isle-0.2.0-dev.1-arm64.dmg`（2,374,039,164 B），挂载校验 `Resources/hooks/work-follow-hook.mjs` 与 `Resources/pet-packs/`（1.9G）完整、无 `.temp*.dmg` 残留；全仓 1127 tests / 分支 90.27% / Electron E2E 12/12 / `verify:gate` 7 过。

### Fixed（T-M6-54：逐行审计 P0/P1 真实缺陷，2026-11-24）

- **创作中心白底抠像（P0）**：`keyWhiteBackground` 先检测四角透明（已是透明图直接跳过，保留 alpha），再用**从四边出发的连通洪水填充**删除背景，只删与边缘连通的白，绝不全局删白——白色衣服、眼白、白龙等封闭区域完整保留；`creator-host` 抠像后改为 `fromRaw(raw).resize(...)`，去底结果真正进入输出的 90% 脚底对齐 WebP（旧实现直接缩放原图，抠像结果被丢弃）。
- **夜间睡衣工作跟随（P0）**：`onSessionIdle` / `onAgentPose` / `onCrown` 统一走 `matchPetViewForCharacter`，同时匹配 `session.characterId` 与 `nightOutfit(characterId)`（22:00–07:00 只开睡衣变体也能命中）。
- **星露谷多步目标生命周期（P0）**：`resetDailyStateIfNeeded` 跨日清空 `objective`（首次决策初始化不算跨日）；`MAX_OBJECTIVE_ROUNDS=15` 上限；决策 JSON 支持 `objectiveDone:true` 主动完成；`AutodriveRunner.clearObjective()` + `autodrive-host` 在**新单步原子指令**或用户说「算了/取消目标/不用了」时清空旧目标并广播回执，避免旧目标跨日/被替换后继续驱动；删除未使用的 `stuckConsulted/failStreak/avoidTools` 死字段。
- **自定义角色交互（P0/P1）**：`custom:pose-config` 下发 `fx`/`egg`；pet-stage 右键/「戳一下」优先 `pokePose`（pose-skin `playPose`，缺图回退 `rage_spray`），`fx` 经 `normalizePoseEffect`/`mergePoseEffects` 并入 PoseSkinRenderer（新增 bubbles/celebrate/victory/priceDown/priceUp SVG 动效），`egg:true` 的自定义角色被点中同样逃跑；`summonEgg` 把 userData `egg:true` 自定义角色与 CrossPet `egg-*` 合并随机挑选。
- **回归证据**：`pose-effects` 4/4（含别名/脏值/默认映射保留）、`pet-control-host` 6/6（睡衣命中 + 自定义彩蛋）、`custom-character` 7/7（egg 标记）、`image-pipeline` 10/10（透明跳过/封闭白保留/浅色衣服保留）、planner 目标生命周期 4 例、autodrive `clearObjective`、chat-directive 取消语 12 例；全仓 **1021 tests / 分支 90.17%**，`pnpm verify:gate` **7 过 / 0 跳过**，Electron E2E **11/11**。

### Added（全量素材随包 + 桌宠工坊 / 语音中心重构）

- **`assets/pet-packs/` 全量素材直入（T-M6-45）**：新增 `pnpm sync:pet-packs`（GitHub tree 枚举 + 8 并发 + 按字节数断点续传 + 失败重试 + `SYNC-MANIFEST.json`）。实拉 aboutme-pets 2,624 文件 / 1,894 MiB（9 包 · 1,050 精灵图 · 480 条 `.m4a`）、crosspet 946 文件 / 87 MiB（8 基础 + 7 皮肤 + 15 彩蛋 + 8 套手写字体）、上首软糖体.ttf；二次运行 0 下载 / 3,571 跳过。`apps/desktop-host/package.json` 增 `extraResources: assets/pet-packs → Resources/pet-packs`（不进 asar/dist）。
- **`whale-pet://` 只读协议**：主进程 `resolvePetPacksDir()`（打包态 `Resources/pet-packs`、开发态仓库 `assets/pet-packs`）+ `protocol.registerSchemesAsPrivileged`（standard/secure/supportFetchAPI/stream）+ 严格穿越校验（编码 `%2e%2e`/`%2f`、反斜杠、空段、非白名单扩展名 → 403；缺失 → 404；非 GET → 405），音频走 `net.fetch(file://)` 支持 Range。9 包 manifest/角色由 `buildAboutmePackArtifacts()` 统一生成（与 userData 导入共用同一套槽位/音轨规则），注册表合并随包角色（同名 userData 包不再重复）。
- **桌宠工坊（T-M6-46）**：侧栏精简为 4 组（桌宠工坊 / 语音中心 / 游戏共玩 / 联机协作 / OBS 挂件 / Harness / 模型服务商 / 扩展与权限），`pet-stage-panel` 升级为四页签外壳：舞台与互动、动作预览与素材库（640×360 12fps Canvas 逐帧播放器、Space/←→/↑↓、进度条、`.m4a` 随帧 seek、MediaRecorder 导出 WebM、推到桌宠试播、全量动作/11 槽位/CrossPet 皮肤彩蛋实时搜索）、小本子与友谊、跨 AI 跟随与接口；顶部 9 角色 + 皮肤快切条。`pets-panel.tsx` 退役。
- **语音中心（T-M6-46）**：9 角色声线绑定条 + 5×5 试听按所选角色绑定（`voice:character-bind` → `userData/voice-bindings.json`，主进程 `resolveVoiceId` 覆盖优先）；如实展示 mcode/say/未适配后端、动作原声 ducking 开关与 live 抢麦锁状态；高阶情感/RVC 精调随 `characterId` 切换。
- **联机一键启动向导（T-M6-47）**：Terraria 本地服参数数组启动（`-port/-world/-worldname/-noupnp/-autocreate`）+ `terraria-bridge.tmod` 探测 + 每 AI `bridge-port.txt` + 客户端 `-join` 尝试；DST `cluster_token.txt` 0600 落盘（校验 Klei 字符集、不回显/不写日志）、`Master/modoverrides.lua` 写受控 UserID 与同源 pair_token、专用服 + 单 Sidecar :18100（`ELECTRON_RUN_AS_NODE`）；向导三步显示真实落盘/构建状态。
- **9 角色平权收口（T-M6-48 切片）**：未登记角色使用中性人设与中性短评，不再继承小鲸的「大肥鱼」雷区与口吻。

### Added（批次 3-4：CrossPet 社交 / 跨 AI 跟随 / 对外驱动口）

- **CrossPet 姿势渲染（T-M6-48）**：契约新增 `PetRendererType='pose-skin'` 与 `PetCharacter.skins`；`PoseSkinRenderer` 以「姿势图 = 1 帧 clip」接入 `RendererHost`（交叉淡入 + Q 弹），`pose-effects` 提供 6 类 SVG 头顶动效；`pet-packs` 把 30 个 CrossPet 角色目录（8 基础 + 7 换装 + 15 `egg-*` 彩蛋）转成角色与 manifest，`character.json.lines` 原样供气泡使用；夜间 22:00–07:00 自动换睡衣，`egg-*` 被点击即逃跑关窗。
- **多宠社交（T-M6-48）**：`PetWindowManager` 新增 `collisions()`（重叠 >12% 才触发，2 秒去抖）、`assemble()`（底部排排站）、`dismissAll()`；主进程 `pet:summon / assemble / dismiss / egg-summon`；两只桌宠相撞互 Q 弹 + 吐槽。
- **友谊与「我们的小本子」（T-M6-48）**：`FriendshipStore`（Electron/Node 内置 `node:sqlite`）实现 10 颗心 / 1/4 填充 / 每日上限 15 / 4 档关系；摸头/戳/协作/完成共同目标/互聊涨分；留言、互聊记录与一键隐私擦除；`friendship-host` 提供闲时互聊（角色预置模板，经全局语音锁串行播报并写入 memory-graph）、久坐/喝水提醒（60/45 分钟，23:00–07:00 与睡眠免打扰）与每日首次见面问候；桌宠工坊 Tab 3 接入 8 套 CrossPet 手写字体、统计、成就与留言板。
- **跨 AI 工作跟随（T-M6-49）**：`work-follow-host` 只读 source/session/工具名/模型名，支持 single（主宠随活跃 AI 换装）与 multi（每个 AI 各来一只），单会话工具调用 ≥8 自动戴皇冠；ACP Harness 事件直接镜像，本机 CLI 用 `tools/hooks/work-follow-hook.mjs` 追加 `userData/work-follow/events.jsonl`（坏行跳过、按偏移增量）；Tab 4 实时任务卡与事件流。
- **对外本机驱动口（T-M6-49）**：WebUI 新增 `GET /api/pet/:agentId/state`、`POST /say`（睡觉态 409，`wake:true` 叫醒）、`POST /action`（500ms–60s）；入参过 `PetApiSayRequest / PetApiActionRequest` Zod 契约，设备 token 鉴权；`plugin-kit` 的插件上下文在清单声明 `{resource:'pet:control',policy:'allow'}` 时注入 `petApi.state/say/action`。
- **9 角色平权收口**：未登记角色使用中性人设与中性短评，不再继承小鲸的「大肥鱼」雷区与口吻。

### Fixed（2026-11-24 真机：没鱼竿 → fish 无限失败卡死 / 指令只回复不办事）

- **连败退回规则日程不再复读同一动作**：`LlmPlanner` 检测到同一工具连续两次失败时，旧实现直接 `fallback.decide()`，但 `RulePlanner` 不知道失败原因（`observeReceipt` 未转发），按日程在 07:10 继续 `fish` → 事件流无限刷屏、游戏时间冻结（真机截图：`第1年夏2日 07:10 · Beach` 循环数十条「钓鱼赚米！」）。现在：
  - `LlmPlanner.observeReceipt` 把回执转发给规则兜底；
  - `RulePlanner` 记录**所有工具**的失败（环境级失败「没有鱼竿/没有工具/材料不够」一次即避开，普通失败连续两次避开，成功解除），钓鱼阶段绕开 `fish` 转采集，采集/清地也失败则 `wait` 明确求助；
  - 连败触发 `cooledTools` 后**仍由 LLM 决策**：每轮 user prompt 注入「今天已冷却的动作 + 最近失败原因 + 换方案提示（`list_chests`/`take_items`/FishShop 买鱼竿/采集/农活/下矿）」，不再用 `if (repeated) return fallback` 硬切绕过大脑；
  - 所有 `fallback.decide` 出口统一走 `fallbackDecision`：兜底动作若已在冷却中 → 改 `wait` 求助，真实兜底在 intent 标注「规则兜底」，事件流可区分大脑与离线兜底。
- **规则侧鱼竿前置检查**：`hasFishingRod()` 认「鱼竿/钓竿/Rod」；背包段明确没有鱼竿（或 fish 已连败冷却）时，`RulePlanner` 的 fishing 阶段直接转采集，不盲目调用 fish；`observeReceipt` 扩展为**所有非生存类工具**连败 ≥2 当日跳过（`SURVIVAL_TOOLS` 的吃饭/睡觉/赶路/界面仍可重试）。
- **编排器全局防刷屏熔断**：相同 `(tool + FAILED summary)` 连续 ≥3 次且 `gameClock` 未推进 → 发 watchdog 并暂停 30s，任何规划器/兜底都失效时的最后一道网。
- **聊天多步目标落地**：`chat-directive` 解析协议扩展为两种形态——单步原子动作（`tool/args`）与多步目标（`tool:"" + objective + firstTool/firstArgs`），toolDoc 补 `list_chests`；`chat:say` 接到 objective 时注入 ack、自动拉起自驾、`submitObjective` 持续驱动 LlmPlanner，有首步则同时 `submitDirective` 立即执行，并广播 `chat_order` 让中控台可见；`teamContext()` 修复单机 objective 被空黑板短路的问题（「主人当前目标」每轮独立注入）。
- **指令解析失败不再静默**：`chat:say` 的指令解析异常此前被空 `catch` 吞掉，用户只收到回话、游戏里毫无动静。现在记录原因、事件流广播「指令解析失败（未接单）」，并在回话 system 里要求如实说明，不假装接单。
- **下单失败回灌**：主人刚下的单执行失败时，除原回执外补一条 `chat_order FAILED` 事件与气泡语音（「主人，X 没办成……原因」），不再只看到一句「好嘞」。

### Fixed（T-M6-51：批次 1-4 审计缺陷）

- **定向投递参数序**：删除 `PetWindowManager.send(channel, agentId, payload)` 双字符串入口，统一 `sendAgent(agentId, channel, payload)` 与 `broadcast`；修复 bump / summoned / crown / wake / say / preview 全部被写反后静默丢弃的问题。
- **CrossPet 透明穿透**：`<img>`（pose-skin）补齐 alpha 采样（object-fit contain 几何）与缩放同步，皮肤/彩蛋可正常点击、拖拽、摸头、右键与逃跑。
- **单宠换装**：工作跟随不再 `dismissAll(null)` 销毁 default 主窗；改为只关其他 AI 窗并在 default 原地换角色（保留 `/api/pet/default/*` 与自驾目标），含夜间睡衣解析。
- **工作跟随完整性**：ACP `session-started/permission/exit` 共用缓存 sessionId；modelName 优先映射角色；single 模式 tool 命中新角色也换装；multi 60s 闲置先告别再退场。
- **其它**：CrossPet `portrait/avatar/portrait-card` 不进入动作槽；`whale-pet://` 显式 `Content-Type`；右键「叫她出来」二级面板期间保持交互；FrameCanvas 按真实帧尺寸绘制；工作跟随监听器可退订；非星露谷 planner systemPrompt 惰性读取当前角色名；拆分 `pet-control-host` / `coop-launch-host` / `acp-session-cache`。

### Added（T-M6-53：创作中心与姿态验收台）

- **自定义角色深度协议**：`PetCustomCharacter` 契约兼容 CrossPet `character.json`（name/accent/apps/greeting/lines/glyph/idleActions/pokePose/correctedPose/longThink/fx/outfit/aura/host/skin/egg）并扩展 `reactTo`、`milestones`、`notebook`；`userData/pet-characters/<id>/` 目录加载、克隆内置、改名（本机 settings，升级不丢）、零重启热重载（右键「重新载入」/创作中心保存）。
- **reactTo 代演**：命中来源或 modelName 的自定义角色优先代演工作状态、多会话与庆祝；姿态缺失按 compact→writing、asking→listening、其余→idle 回退；correctedPose（出错 3 分钟内再次对话一次性触发）与 longThink（decision 后 N 秒切 deepthink）。
- **创作中心**：三页签（角色/皮肤生图提示词编译器、5 态彩蛋提示词 + 主脑台词生成、拖入建角）；11/5/5/社区梗姿态批次；主进程图像后处理（白底抠像、90% 身高脚底对齐、idle-blink 仅闭眼贴回、avatar 192×192、portrait-card 256×384、WebP 编码）。
- **姿态验收台**：暂停真实事件、12 场景直接驱动真实桌宠窗口、缺失姿态回退检查、1.5s 全姿态轮播 + 90% 参考线、脱敏 Markdown 报告（零对话正文/路径/密钥）、桌宠 Option+右键直达。

### Fixed（T-M6-50：动作库按角色/形象分库，对齐 aboutme-pets 线上实现）

- **动作库不再混包**：逐行分析上游 `preview.json` 播放器后，按「每角色自己的 categories + `idleAnimationId` + `totalActions`」重建 Tab 2：切角色即整套动作库替换、清空搜索、自动播该角色待机动作；默认只显示当前角色（claude 166 / dsh 101 …），「全部 9 包」仍可显式切换。
- **逐动作帧元数据**：`PetStudioAction` 增加 `frameWidth/frameHeight/rows`，`PetStudioPack` 增加 `idleClipId`；播放器与 WebM 导出使用每个动作自己的尺寸与 fps，不再假定全局 640×360。
- **声画同步改为上游同款**：音轨 fetch 成 blob + 隐藏 `<audio>`，**音频作为时钟**（帧号 = `floor(currentTime×fps)`），blob 就绪前冻结动画；暂停/恢复与音频同步，拖动/逐帧会 seek 音频；按 category 折叠分组，搜索只作用于当前角色。

### Changed

- `docs/THIRD_PARTY_NOTICES.md` 登记 `assets/pet-packs/` 三类素材（aboutme-pets MIT、crosspet CC BY-NC-SA 4.0、上首软糖体字体待核实），统一 `DEV_ONLY_NON_COMMERCIAL`；`license-scanner` 跳过 `assets/pet-packs` 二进制树。
- `.gitignore` 忽略 `assets/pet-packs/*` 二进制（保留 README 与 SYNC-MANIFEST）；1.85 GiB 素材只在本机与安装包中存在。

## [Unreleased] — 2026-11-23

### Added

- **联机协作大厅（T-M6-39）**：新增 TeamGoal / TeamAssignment / TeamBlackboardSnapshot / TeamCommsMessage 四契约（`pnpm gen:contracts` 61 契约）；`TeamBlackboard` 提供区域软锁（TTL/续租/过期）、版本化快照与 ≤300 字 Prompt 摘要；`HuddleOrchestrator` 严格 2–3 轮、自动协商 5 分钟冷却、单场 12,000 token 预算，超预算或 LLM 异常降级为本地规则分工；CoopHost 为每个 AI 独立绑定 persona/voice/planner（复用主 Gateway 与饭碗），新增端点可视化增删改、`@单人` P0 定向、`@全队` 重议、求助区域交接与三栏大厅（目标 / 群聊 / 黑板）。验证：TeamBlackboard 7、Huddle 10、CoopHost IPC 5、团队上下文注入 2、Electron UI E2E 7/7；真实双 AI 联机与听感待真机。
- **多桌宠同屏多开 + 全局抢麦（T-M6-38）**：`PetWindowManager` 按 `agentId` 管理透明窗，独立坐标/缩放/锁定持久化到 `pet-window-prefs.json`，新窗 +220px 错位，默认 `default` 保持旧单窗兼容；桌宠 hash URL 携带 agentId/characterId，动作/气泡/状态事件按 agentId 过滤；语音输出租约上提主进程，按角色注册表解析 voiceId，`coop:speaker` 广播 speaking/idle 驱动发言/倾听动作。验证：窗口管理 5、语音串行 5、Electron E2E 多窗开关 7/7。
- **DST 同 sidecar 多 Agent 路由（T-M6-40）**：`agentId` 贯穿通用动作请求、DST `/state`、`/act`、`/cancel`、sidecar 每玩家快照/pending/cancel 槽与 Mod 多受控 UserID tick；单玩家/`default` 向后兼容。验证：dst-adapter 12/12、sidecar 10/10（快照/动作/cancel 隔离）；真实 DST 多玩家待人类。

### Added（协作可用性收口，T-M6-41）

- **DST 逻辑玩家 ID 可视化**：`McpEndpoint.routingId` 贯穿契约/CoopHost/DST adapter；UI 可填 Klei UserID，DST 空值直接拒绝接管，避免同 sidecar 读错角色。
- **自动求助**：真实状态事件补充 health/freeSlots；体力 <15%、生命 <30% 或背包满持续 30 秒自动发 `need_help` 并尝试交接给空闲队友，3 分钟抑制抖动；成员卡新增人工求助按钮。
- **真实目标进度**：`TeamGoalMetric.source` 支持 `team_money` / `shared_wood`；金币来自 Stardew 共享钱包，公共木材用 `list_chests item=木材` 仅统计箱子并排除背包；目标编辑支持金币/木材 target。
- **E2E 兼容修复**：旧 `prefsSet` 位置写入手动同步到 `PetWindowManager` 的 default 窗口偏好，修复重启恢复 E2E；按窗口实际状态比对，不再依赖全局值是否变化。

### Added（T-M6-41 / T-M6-42，2026-11-24）

- **aboutme-pets 九角色包与 SpritesheetRenderer**：新增精灵图契约字段（sprite/meta/audio）、帧裁切与零黑帧切换、动作原声及 `coop:speaker` 下 duck 至 15%；Node 导入器支持 9 包、并发 6、断点跳过、进度事件、11 语义槽位 + ambientPool、角色 persona/专属 voiceId/语速音高；角色包商店接入舞台与协作页，素材只落 userData。许可证台账登记 hunmer/aboutme-pets + lokicorvus/crosspet（CC BY-NC-SA 4.0）。
- **联机一键启动**：新增 `coop-launcher`，星露谷可生成隔离 Mods profile（普通 Mod 符号链接、BWF 独立拷贝、改写 McpPort/ShowHud）并以参数数组启动；协作页新增可折叠三游戏向导和自动端口分配。Terraria/DST 当前只做本机路径探测，不伪造启动成功。
- **角色专属口癖**：`character-persona` 增加按 characterId 的专属雷区响应，小鲸保留原 persona-brain 规则。

### Added（T-M6-44，2026-11-24）

- **九角色功能平权**：`pets:manifest` 读取当前角色真实 manifest；自驾提示/回执短评/声线按角色动态；指令解析角色名动态；10 套完整 `PetPersonaConfig` 全部经 `persona-brain` 加载并具备 P0 `rage_spray`；舞台按 renderer 自动切换 WebM/精灵图；声音工坊按角色保存；Coop 角色优先级去特权。
- **桌面防打扰**：贴边 45% 收起与 10s 回缩/事件探出、Alt 临时 0.35 透明度+穿透、全屏应用自动隐藏、`Control+Alt+P` 暂藏/唤回、闲置 30s 省电。
- **无焦点 Alt 穿透与拖离贴边**：主进程以全局鼠标坐标 + macOS CGEventSource / Windows GetAsyncKeyState 轮询判定悬停 Alt，直接 setOpacity(0.35)/setIgnoreMouseEvents，不依赖窗口焦点；拖离边缘新增 clearDock，只清贴边记忆、不弹回旧位置。
- **按角色恢复音色包**：voice-studio 新增 load-pack，切换角色时加载该角色已保存的五档情感参数与 SVC 参数。
- **副桌宠身份与平滑探出**：pet-stage 使用本窗 agentId 执行 dock/undock；`pet:poke-line(agentId)` 按窗口角色返回专属台词；`undock` 改为 smoothstep 逐帧 setBounds。E2E 覆盖副窗 dock/poke。
- **全屏按屏判定与双击弹弓**：`detectFullscreenForDisplay` 输入桌宠 display bounds + 可见全屏窗口 bounds，多屏只隐藏被覆盖的屏；E2E 复用同一函数。双击改为 drag-throw 阻尼弹簧位移，先弹射再精确回原点，并保留 Q 弹形变。
- **九角色平权与专属戳一戳**：`pets:manifest` 与 `speak` 共用 `selectedCharacterManifest` / `voiceSceneForCharacter` seam，9 个 aboutme 角色逐项断言 manifest、characterId、speakerName、voiceId、语速音高；右键戳触发角色专属吐槽。
- **气泡语音回执状态机**：新增纯 `bubble-lifecycle`（waiting/speaking/muted/hidden）：speaking 中不收起、语音完成即收、失败/超时/中断保留文字并显示静音角标、60s 兜底；`VoiceHost` 通过 `pet:speech-result` 广播 lease 终态，pet-stage 按 agentId 消费。
- **交互与声学手感**：摸头哄好、右键戳、甩晕四级、双击 Q 弹、S/右键安静睡眠；气泡等待 `coop:speaker` 完成回执、60s 兜底与静音角标；精灵音轨 duck 15%。

### Fixed

- **星露谷真机卡死（BWF 120s 自暂停 → 时钟冻结死锁）**：日志实锤 BWF 因「MCP 客户端 120 秒没有动作」暂停游戏；旧 watchdog 在当前无在途动作时 `cancel()` 直接返回、根本没发 `cancel_action`，却每 2 秒重复声称已兜底，形成永不进入 planner 的死循环。修复：无在途也真实发送 cancel；90 秒无变更动作自动发游戏原生 keepalive（星露谷 `wait minutes=1`）阻止自暂停；4 分钟冻结时 cancel + 最小恢复动作，恢复失败才交还 planner，并重置 stale 计时避免刷屏。补 3 项回归测试；`ActionLock.cancel` 仍以「是否有在途动作被取消」为返回值，保持旧语义。**当前运行实例仍是旧主进程，需重启 Electron 后生效。**

## [0.2.0-dev.1] — 2026-11-23

首个可复现开发基线：Electron 45.4.1 + Zod 4.6.7（audit 0 high/0 critical）、契约原生 JSON Schema 生成、三游戏代码闭环（泰拉瑞亚/DST 真机待验收）、OBS `/obs` 只读挂件、自治质量指标、CI + soak + 7 项本地门禁、服务商面板拆分、全项目审计收口（见 ROADMAP T-M6-27~35）。

### Added

- **直播最小链路（T-M6-37，T-M6-31 切片二）**：`live-stream-hub` 接入主进程，弹幕/事件经 Zod 契约 → 防封护栏 → 注意力分档/去重 → 批次，落到 OBS 页实时事件流、插件总线与 P0 语音短评；新增 `live:ingest` / `live:replay` / `live:snapshot` IPC 与确定性样本回放。验证：live-host 4/4、Electron E2E 6/6。**未接线**：真实 dyhub、常客账本落盘、点歌执行链、OBS 图层；回放标为 `[SIMULATION]`，不是真机直播证据。
- **外部插件生产链路（T-M6-36，T-M6-31 切片一）**：`userData/plugins/<id>/{manifest.json,index.mjs}` 发现真实 dsh 插件，清单过 Zod、id 与目录名一致、符号链接越界拦截；`vault://*`（密钥单咽喉）与 `shell://*`（审批 UI 未接线）装载期硬拒；dsh 工具默认 ask 策略，需 `pluginApprove` 会话授权；setup 崩溃回滚、工具异常隔离、禁用注销工具/订阅。中控台插件页显示真实外部插件、工具与错误；新增 `docs/PLUGINS.md` 与可复制示例 `docs/examples/plugins/hello-whale/`。验证：plugin-host 6/6、Electron E2E 5/5（真实动态 import → 启用 → 工具调用）。**注意**：插件在主进程运行，Policy 不是 JS 沙箱，只装载用户本机可信代码。
- **自治质量指标（T-M6-35，审计 Phase 2 切片）**：`packages/game-bridge-mcp/metrics.ts` 从真实事件流派生有效回执率、失败/错误率、重复动作率、动作覆盖面与最长同工具连击；口径明确（TIMEOUT 不计成功也不计失败、`think` 不算动作、编排器汇总回执排除、空集显示「—」不伪造 0%/100%）。星露谷与泰拉瑞亚面板新增「自治质量（本会话）」卡；渲染层通过 `@workbench/game-bridge-mcp/metrics` 子路径导入，避免把适配器副作用打进前端包。验证：metrics 8/8（分支 100%）、Electron UI E2E 4/4。
- **OBS 只读透明挂件 `/obs`（T-M6-34，T-M6-31 首个最小真实链路）**：内嵌 WebUI 新增 `GET /obs`——透明底、`STAGE_PROTOCOL=1`、token 鉴权、`obs-readonly` 声明；页面通过 `/ws` 订阅动作/回执并回放最近 20 条，只读、无任何指令/审批入口。中控台 OBS 页改为「复制 OBS 源地址」（含本机 token，提示勿外传），文案从「18765 接线中」改为真实的 18780 `/obs`。验证：webui-server 23/23、Electron UI E2E 4/4（真实内嵌服务 401/200 与协议标记）。投票/歌词/点歌层仍未接线，OBS 叠加观感待真机。
- **语音后端如实展示（T-M6-33，审计发现）**：新增 `voice:backend` 只读探测与顶栏标识——`mcode` 角色音色链不额外标注，`say` 兜底显示「· say」，非 macOS 显示「· 未适配」，title 展示具体链路说明。此前界面只有「语音开/关」，容易让用户误以为始终在用角色 TTS。验证：探测单测 4/4、Electron UI E2E 断言 `data-voice-backend` 三态；真实听感与 Windows 适配仍待真机。
- **CI 与仿真长时浸泡（T-M6-29 部分）**：新增 `.github/workflows/ci.yml`（ubuntu：typecheck / depcruise / 单测排除 Electron E2E / ruff+mypy+pytest；macOS：完整 `pnpm verify:gate` + Electron `desktop.e2e`/`ui.e2e`，不注入 secrets、不跑真实游戏）；新增 `pnpm soak:autodrive [分钟]`（`tools/scripts/soak-autodrive.mjs`），在本地星露谷仿真器上按 autodrive 节奏长跑，统计 get_state 失败率、异常回执率与 RSS/heap 趋势，12 秒冒烟实测 445 轮 / 1335 事件 / 0 失败 / 0 异常回执。Gate 4 更名为「回环契约 E2E」并在脚本与 VERIFY 顶部写明它是测试内手工组合（假语音适配器 + `:memory:` SQLite），**不是**生产端到端。CI 尚未在远端实际跑过，如实记录。
- **多游戏/多端点事件与指令隔离（T-M6-27，P0 正确性）**：autodrive 事件现在强制携带 `sessionId / gameId / generation`，联机 agent 池事件另带 `agentId + sessionId`；渲染层与桌宠只消费当前会话事件，旧 generation、异 sessionId、异 gameId 与联机端点事件一律丢弃，切换游戏后不再出现「星露谷页显示泰拉瑞亚动作」或旧回执污染语音/记忆。P0 指令新增可选 `expectedSessionId`，主进程拒绝来自已切换会话的迟到指令（不误发到新游戏），省略时保持旧调用兼容。验证：会话过滤纯函数 6 项、双 runner 并发隔离 1 项、runner 会话标识 2 项、Electron E2E 1 项（状态含会话标识 + 过期指令被拒绝），相关包单测 223 项全绿。仍属 `[E2E-HOST]`/`[SIMULATION]`，真实多游戏并发仍待真机。
- **三游戏共玩页统一与连接引导（T-M6-25）**：游戏共玩页三个游戏（星露谷 / 泰拉瑞亚 / 饥荒 DST）共用同一套区块——连接引导条、当前动作、目标链、执行记录与回执、实时指标、快捷插队、默认折叠的高级诊断；主进程新增只读探活（星露谷 18080/mcp `get_state`、泰拉瑞亚 18090/health、DST 18100/health），按 `online / reachable / offline` 三态如实呈现，连不上时给出人类可执行的启动指引（载入存档、装模组、配 `cluster_token`），**不会把未连接粉饰成已连接**；「重新探测」按钮真实往返 IPC。DST 面板补齐状态 IPC 注入（此前恒为「未接线」），技术文案收敛为口语，技术细节与许可证结论收进折叠诊断。验证：探活单测 11/11（fetch 全注入零网络）、Electron UI E2E 1/1、`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线；未连接真实游戏。
- **全局游戏共玩壳层（T-M6-24）**：侧栏将星露谷、泰拉瑞亚、DST 与 Mod 管理归并到「游戏共玩」入口，并迁移旧路由；品牌区与桌宠舞台共享角色选择，顶栏游戏选择与自动驾驶启停共用实际运行状态，主脑显示当前绑定模型短名及缺 Key 回落入口。修正深浅主题语义文字/绿色 token，并加入最低 4.5:1 的对比度断言。验证：desktop-host 构建通过、Electron UI E2E 1/1、`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线；未连接真实游戏。
- **桌宠多显示器安全定位（T-M6-23）**：移植 dsh-pet MIT 多屏矩形区域几何；拖拽/甩抛按屏幕工作区夹紧整窗，记录真实 Electron `displayId`，启动时按该屏恢复，屏幕拔除后回落最近可用屏。新增几何边界单测和 Electron 重启恢复 E2E；未复制素材。验证：几何单测 5/5、desktop-host 构建通过、Electron E2E 1/1、`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线。

### Changed

- **英文产品名统一为 Whale Isle**：README/AGENTS/SPEC/PRODUCT-DESIGN 中的旧代号 `ai-vtuber-workbench` 与「AI VTuber Workbench」统一改为 **Whale Isle**（仓库 slug 为 `whale-isle`）；根包名改为 `whale-isle`，Terraria/DST 模组 author 元数据改为 Whale Isle，设计稿示例路径同步；`User-Agent` 改为 `Whale-Isle/1.0`，`APP_ID` 与 electron-builder appId 对齐为 `com.whaleisle.desktop`。**冻结存储键保留**：IndexedDB `ai-vtuber-director`、`whaleisle-` revision 前缀、`@workbench/*` 包作用域与路径字段不改，避免用户配置/协议身份漂移（已在代码注释说明）。
- **修复干净环境构建（GitHub CI 首跑发现）**：`apps/desktop-host` 的 `tsc -b` 只引用了 4 个包，而渲染层还从 `@workbench/local-store/dexie`、`@workbench/model-gateway/presets`、`@workbench/game-bridge-mcp/metrics` 等 **subpath** 导入；这些包未在项目引用中，干净 checkout（无 dist）时子路径类型不可解析。已补齐 11 个 project references，并为 `agent-harness / game-bridge-mcp / live-stream-hub / local-store / memory-graph / model-gateway / plugin-kit` 打开 `composite`；删除全部 dist + tsbuildinfo 后 `desktop-host build`、`verify:gate` 7 项、Electron E2E 6 项均通过。
- **服务商面板职责拆分（T-M6-26）**：`providers-panel.tsx` 从 **1779 行**降至 **921 行**容器，详情、模型列表、槽位/默认模型、侧栏、自定义+导入弹窗（合并）、公共 UI 拆入 `renderer/director/providers/`（另有 catalog 类型与纯函数模块；合计 8 个业务文件）；全部 state、Dexie 与 bridge 副作用仍由容器持有，40 种 `data-*` 选择器与重构前逐项一致。验证：typecheck、depcruise（379 模块 0 违规）、desktop-host build、Electron UI E2E 4/4。
- **本地门禁补齐依赖漏洞与 DST Lua 校验（T-M6-29 收尾）**：`pnpm verify:gate` 的 Gate 2 新增 `pnpm audit --audit-level high`（离线/超时 SKIP，CI 强制执行）与 `luac -p mods/dst-bridge/**/*.lua`（缺 luac 时 SKIP，CI 安装 lua5.4 强制）；本地门禁现为 **7 项检查**，本机实测 5 个 Lua 文件语法通过、audit 0 high/0 critical。C# 构建仍依赖 tModLoader 程序集，留真机环境执行。
- **依赖安全升级（T-M6-30）**：Electron **38.8.6 → 45.4.1**，清除全部 Electron / extract-zip 高危告警；45 取消 postinstall，改为首次 `require('electron')` 懒下载，Electron E2E 统一加 `--use-mock-keychain`（避免 macOS 新二进制的钥匙串授权框同步阻塞启动，CI 同样适用）。Zod **3.25.76 → 4.6.7** 全仓统一，移除 `zod-to-json-schema`，契约生成器改用原生 `z.toJSONSchema`（保留默认值/required 语义与 `additionalProperties:false`，剥离 `.int()` safe-int 与 `.uuid()` 冗余 pattern，二次生成幂等）。修复 Zod 4 语义差异：`z.record(enum)` → `z.partialRecord`（套餐仍可只绑定部分槽位）、`PauseConfig.default({})` → `.prefault({})`（嵌套默认仍生效）。`pnpm audit --audit-level high` 接入 CI 与新增 `pnpm audit:high`。验证：`pnpm verify:gate` 5 过 / 0 跳过、744 tests、分支 90.12%、py:check 37、Electron E2E 4/4；37 份 schema 语义零丢失，Pydantic 仅 3 处等价类名变化。残留：Electron 45 的 `safeStorage` 同步 API 已弃用（功能正常），待后续迁移 async 版。
- **服务商变体路由修复（T-M6-32，审计发现）**：`resolveEndpoint()` 原只按 Region+Plan 匹配，而 OpenCode Go/Console 的 OpenAI 与 Anthropic 变体共享这两个字段，导致永远命中首个 OpenAI 变体、UI 的「Anthropic」胶囊实际不生效。现按 `provider.protocol` 收窄候选并透传到网关请求 URL/请求头；供应商面板 `toConfig()` 把选中变体协议写入契约字段；App 冷启动同时还原变体 Region/Plan（修复同协议不同胶囊的供应商冷启动退回默认项）。验证：model-gateway 70/70（变体矩阵 + `x-api-key` 断言）、depcruise 0 违规、typecheck 通过。
- **修两游戏适配器在打包产物里被 tree-shaking 掉（M7 遗留，随 T-M6-25 连接引导暴露）**：`packages/game-bridge-mcp/package.json` 标注的 `sideEffects: false` 让 esbuild 把 index.ts 中「靠副作用导入自注册」的泰拉瑞亚 / DST 适配器整包裁掉，真机表现为「未注册的游戏适配器：dst（已注册：stardew）」——两游戏在打包版里既无法驾驶也拿不到状态。已改为 `sideEffects: true` 并在包内写明原因；本仓开发态（未打包、走 dist 直连）不受影响，所以此前一直未暴露。
- **多游戏自驾宿主热切换与打包收口（T-M7-03 补充，2026-11-22）**：每轮聊天读取当前角色提示和游戏名，雷区路径调用 `persona-brain` 反射钩子，`say()` 返回剥离 `<think>` 后的可见文本；各 `GameAdapter` 可提供专属规则规划器/攻略主题，切换时等待旧 runner 与在途动作闭合后重建规划器并更新记忆日键。攻略和 persona fixture 加入安装包；将由 esbuild 打入渲染产物的纯前端依赖移入 `devDependencies`。macOS arm64 DMG 从 303,129,628 bytes 降至 297,394,499 bytes（约 −1.89%）；`pnpm verify:gate` 5 过 / 0 跳过 / 0 待接线，分支覆盖率 90.14%。真实三游戏热切换仍待 `[REAL-DEVICE]` 验收；本机没有 Developer ID，构建跳过代码签名。
- **独立安装包首次落地并真机安装（T-M6-05，2026-11-22 用户指令「把最新安装包打包安装」）**：`apps/desktop-host/package.json` 接入 electron-builder 26.18（macOS dmg arm64 + Win nsis x64 配置、`pnpm package` 脚本、`asar:true`、`npmRebuild:false`）；最新代码（含 M7 两游戏）打出 `release/鲸屿 Whale Isle-0.1.0-arm64.dmg`（289MB），装入 `/Applications/鲸屿 Whale Isle.app`（513MB）并启动成功（进程树 + WebUI 18780 token 401 实证）。本地无 Developer ID 签名，安装后须 `xattr -dr com.apple.quarantine`；体积超出原 <200MB 目标、首启向导未做，如实记录。
- **M7 多游戏扩展合流完成：AI 全自动玩泰拉瑞亚 + 饥荒 DST（2026-11-22）**：
  - **共享地基**：`shared-protocol` 12 域桥接契约（通用请求/受理/四态回执/轮询/探活 + Terraria/DST 快照·回执·配置 + 两个新规划槽）；`game-bridge-mcp` 的 `GameAdapter` seam（星露谷原样包装、双泳道 adapter 自注册）；宿主按 `gameId` 选择 adapter/角色槽位/聊天指令档案/记忆日键；中控台三游戏导航与独立面板。
  - **泰拉瑞亚泳道**：`terraria-simulator`（5 剧本 + 11 it）、`terraria-adapter`（17 it + 零 token 规则兜底）、`mods/terraria-bridge/`（C# tML：HttpListener 18090 / 帧级 SetControls / NavLite 物理预测寻路 / 生存反射 / F8 接管 / 思考冻结）、`terraria-panel.tsx`、`REFERENCE-terrariablind.md`。
  - **饥荒 DST 泳道**：`dst-simulator`（5 剧本 + 9 it）、`dst-adapter`（11 it）、`mods/dst-bridge/`（Lua 服务器侧权威 + Klei 653007 localhost QueryServer tick + unsafedata 降级）、`services/dst-bridge-sidecar/`（双面 HTTP 18100 + 本地专用服 stdin 托管 + token 校验，含 10 it）、`dst-panel.tsx`、`REFERENCE-dst-ai-companion.md`。
  - **门禁与诚实口径**：`pnpm verify:gate` 5 过 / 0 跳过（699 tests，分支 90.13%）；sidecar spec 纳入根 vitest 与 tsc project、补 6 类分支收口测试；修复 4 处既有计时抖动（harness 150ms 握手、autodrive 60ms、E2E 10s 冷启动、仿真器在飞窗口）。**C# 模组已用 GitHub Release tML v2026.09.3.1 程序集编译通过并打包成 .tmod 落入 Mods 目录、Lua 5.5.1 `luac -p` 语法已过、DST 专用服已装 + sidecar 三端点冒烟通过；两游戏仍无真机证据**（tML 加载 / DST cluster_token 配本地服由人类验收，见 VERIFY 右栏）；沙盒证据全部标注 `[SIMULATION]`。许可证：MIT 蓝本仅思想吸收未复制源码，GPL/无许可证项目红线登记见 THIRD_PARTY_NOTICES。
- **T-M7-02 GameAdapter 多游戏 seam（2026-11-22，M7 共享地基）**：`packages/game-bridge-mcp/src/adapter.ts` 新增 `GameAdapter` 接口 + `GameAdapterRegistry`（默认注册星露谷工厂）+ `StardewAdapter`（原样包装 `BwfMcpClient`，真机链路行为零变化）；`AutodriveRunner` 第三参数可注入 adapter，ping / 不可达提示 / get_state 解析 / 卡死时钟 / 长动作超时 / 回执分类全部走钩子（默认仍为星露谷原逻辑，`BWF MCP 不可达（18080）` 文案与 78 工具白名单不动）；`ActionLock` 传输改结构化 `GameBridgeTransport`，超时表与 `cancel_action` 工具名可注入；`mcp-client.ts` 零改动。门禁：星露谷 106 项现有 spec 全量回归通过 + adapter 6 项新测（**假新游戏 adapter 驱动同一 runner** 实证：JSON 状态经 parseState 进入事件流、classifyReceipt 与 ping/不可达提示全部走钩子、JSON 时钟也能刷新卡死哨兵），全量 629 tests、adapter.ts 覆盖率 lines 96.66% / branches 100% / functions 90.9% / statements 100%。
- **M7 多游戏扩展立项：AI 全自动玩泰拉瑞亚 + 饥荒 DST（2026-11-22 用户指令；T-M7-01 契约先行已落地）**：
  - **可行性结论（双网络调研代理，许可证逐仓打开 LICENSE 核实）**：两款均可行且各有 MIT 全链路先例——泰拉瑞亚 = `Reisenbug/TerraBlind`（模组内 HTTP + 动作回执三段式 accepted→status→outcome + 世界事实终止判据 + SurvivalReflex 生存反射 + receding-horizon 物理预测寻路；B 站大师模式 Boss 无伤演示，实现开源）；饥荒 DST = `fruitstarzero/Don-t-Starve-Together-AI-Companion`（服务器侧权威 mod + 本机 Node HTTP 桥 + 2s QueryServer tick 全链路），IPC 只押 Klei 官方 653007 通道（`TheSim:QueryServer` 允许 localhost、`io.open` 允许写 `unsafedata/*.json`、专用服 `-allow_ioopenwrite_sandbox_escape`；2025-01 的 651414 曾收紧沙盒，勿用 io 直写/第三方 URL）。GPL 红线核实：TShock/TSAPI/HEROsMod/TerraNoneBridge/dst-admin-go 一行不进仓；无许可证项目（Journey-Together/Insight(RecEx)/ActionQueue/TCR/DontStarveAI 等）仅参考思想。
  - **T-M7-01 落地**：shared-protocol 新增 12 域——通用 `GameBridgeReceiptStatus/ActionRequest/ActionAccepted/Receipt/ActionStatus/Health`（统一桥接协议：每游戏模组内 HTTP，`GET /state · POST /act · GET /action_status · POST /cancel · GET /health`；星露谷 BWF 18080 原样不动，**18760 中心 WS 网关设计稿正式搁置**）+ `TerrariaStateSnapshot/ActionReceipt/BridgeConfig`（tML 模组 18090）+ `DstStateSnapshot/ActionReceipt/BridgeConfig`（sidecar 18100）+ `WorkbenchRoleSlot` 增 `TERRARIA_GAME_PLANNER`/`DST_GAME_PLANNER`（director 槽位默认表同步补键）；`pnpm gen:contracts` 50 契约 0 冲突、`pnpm py:check` 全绿（ruff / mypy --strict / 37 pytest）、契约单测 27 过（gameId 字面量互斥、非法 season/TIMEOUT 态拒绝、接管语义快照）。M7 双泳道治理（每泳道各一激活工单）已写入 ROADMAP 头部铁律。
- **TypeSafe Jev（jevmodel.org）接入（2026-11-22 用户指令「看下这个网站的 jev 怎么接入」+ 示例 key/请求体）**：
  - **API 实证**（真实 key 全量探针）：`POST https://jevmodel.org/v1/systemone`，认证 `Bearer`；请求 `{state, model, questions: {id: {type: choice|noul|score, instructions, criteria}}}`（criteria 对象=标签→描述、数组=有序刻度）；**响应** `{model: "jev-1.14.0", answers: {id: {choice/noul/score, probabilities, confidence, legend}}, usage: {input_tokens, output_tokens}}`——choice 返回具名答案+全分布、noul 直接给 true 概率、score 给浮点刻度+图例；定价：登录送 10 万输入 token、¥49 起 1500 万永不过期、成功按输入 token 扣费输出免费（重试建议带 Idempotency-Key）。
  - **落地**：新增 `typesafe-jev` 服务商预设（jev-latest/jev-1.14.0/jev-1.13.0，全决策协议 `toolCalling=false`）；**System One 端点注册表化**（jevmodel.org 官方直连 + OpenCode Console 中继双路由），探针请求体升级为 TypeSafe 规范形状（type/instructions/criteria）；**纯决策服务商的「保存并检测」自动改走原生决策探针**（不再误报「没有 chat 模型」）；官方 1024px 标志入库（jevmodel.org favicon 声明位）；获取 Key ↗ 直达 `/zh/dashboard/`（白名单加 jevmodel.org）；模型全标「决策 S1」、不进聊天槽位下拉。
  - **真机验证（用户提供示例 key）**：四题示例一次拿到全部响应形状（choice「技术」confidence 1 + noul 0.96 + score 0.97 带 legend + usage 609/88）；UI 端到端——粘贴 Key →「保存并检测」**已连接（决策探针 jev-latest）· 1357ms**；行测 `jev-latest ✓ 1422ms / jev-1.13.0 ✓ 1530ms / jev-1.14.0 ✗ HTTP 402`（该 key 免费档覆盖 latest 与 1.13，最新版 1.14 需付费，如实显示）。CDP 回归 **31/31**（含 TS-Jev 渲染/无 key 行测如实报错）。
- **默认模型自动挑选 + jev 能力落位 + 查余额（2026-11-22 用户指令三件套）**：
  - **自动挑选**：逐模型测试结果**持久化**（`override.tested`，刷新/换服务商不丢），槽位下拉新增「**自动挑选**」选项 + 默认模型页「**一键智能分配**」；评分=延迟打底 + 推理 +500（主脑/规划器）+ 免费 +300 + **弹幕快反槽 `typesafe/jev-router` +1000**（TypeSafe Jev 决策路由的本职，jev 能力落位）+ 视觉槽硬性 vision + 决策协议（jev-1.13 系）不进聊天槽；批量测试完成/应用挂载时自动重解析；**空池不破坏既有绑定**只提示；auto 标记存独立 Dexie 键（`slotAutoFlags`），主进程与 App 启动路径零改动（永远只见具体绑定）。
  - **查余额（Magpie keybalance 思想）**：`providers:check-balance` 主进程持 Key 请求各厂商**公开余额 API**（真实 key 探明 schema）：OpenRouter `$1.00 剩余 / 上限 $1.00（周限额）`、DeepSeek `CNY 76.62`、OpenCode Go `配额：5h 窗已用 56% · 本周 68% · 本月 34%（带重置时刻）`、SiliconFlow user/info；「查余额」按钮 + 余额胶囊持久化（`override.balance`）；OpenAI/Anthropic/MiniMax/火山方舟无公开余额 API 如实提示。**坑位**：余额响应必须先 `JSON.parse` 完整再截断展示——截断后 parse 会把大响应变 null（OpenRouter /key 实测踩过）。
  - **一致性修复**：`commitProvider` 展开基准改 `overridesRef.current`——逐模型测试 `persistTested` 高频写 overrides，用渲染闭包里的旧态展开会互相冲掉；测试写入不打 `brainApplyConfig`（58 个模型批量也零主进程噪音）。
  - **验收**：CDP **29/29**（测试结果跨刷新持久 ✓、空池自动分配保留默认绑定 ✓、决策 jev-1.13 排除/聊天 jev-router 可选 ✓、假 key 余额查询如实 401 ✓、旧批全保）；**真实 key 正路径全过**——jev-router 行测 5649ms ✓ → 主脑「自动挑选 → jev-router」落地 → DeepSeek ¥76.62 余额胶囊显示；全仓 502/502 + typecheck/depcruise 全绿。jev 原生 System One 决策适配已立项 **T-M6-14**（弹幕快反打分/自驾归因等判断点从 chat 切到原生 choice/noul，设计先行待用户确认判断点清单）。
- **OpenRouter 上架 Jev：`typesafe/jev-router` 入预设（2026-11-22 用户指令「jev 模型用 openrouter 试一下」）**：OpenRouter 目录 476 个模型中 TypeSafe 系仅此一个——Jev Router（跑在 Jev System One 上的路由模型，聊天形态暴露、1M 上下文、动态计费无免费版；原生 jev-latest 未以独立聊天模型上架）。**用户真实 key 实测三连绿**：直接探针 1820ms ✓、「保存并检测」首选 jev-router 通过（1434ms，442 模型拉齐）✓、行内测试点 ✓ 1112ms——**无需等 System One 适配即可把槽位绑到 `openrouter/typesafe/jev-router`**；顺带证实用户 OpenRouter 账户有余额、第一轮报错确系旧代码失效预设 ID 的 404（已修）。预设置顶 + 推理/视觉标记 + spec 同步（23/23）。
- **模型逐个测试 + 一键批量测试（2026-11-22 用户指令，Magpie「Test models」交互）**：模型列表每行新增「测试」按钮与行内状态点（`✓ 延迟ms` / `✗ HTTP 码`，悬浮看错误原文）；头部「测试模型」按钮**4 并发**批量测当前服务商全部**开启**的模型，进度实时显示（`停止 done/total` 再点即停）、>50 个先确认防误点大清单；**决策协议模型（jev 系）自动改走 System One 探针**（`/inference/systemone/v1/systemone` 最小 noul 问题，请求体形状经无 key schema 校验实证）而不是必失败的 /chat/completions；顺手修真 bug：**本地引擎（Ollama 等 loopback）免 Key 测试**——原 vault 对无 key 服务商一律报「尚未保存 API Key」，Ollama 模型测试从未可用，现 loopback 端点跳过凭据要求。真实 key 复验（vault 拷贝隔离实例）：jev-1.13-free 探针 **422 upstream 不可用**（与免费 chat 同被锁第三方客户端）、jev-1.13 **402 可充值解锁**、opencode-go `hy4-flash-free` **1688ms 再次回话成功**（用户唯一免费口子坐实）。CDP 回归 **27/27**（单模型测试→✗HTTP 401 行状态、批量 3/3 状态齐全+按钮恢复、本地免 Key 路径错误为连接层而非 key 层、旧批 23 项全保）+ 全仓 502/502 + depcruise 全绿。**排序补充（同日用户指令「开启的模型放在最前面」）**：模型列表开启项排最前、停用项沉底（组内保持原相对顺序，与侧栏「已关闭」沉降同哲学），CDP 33/33（停用沉底/恢复回前排实证）。
- **供应商页 v5.5：Magpie 交互 + 官方图标 + OpenCode Console/原 Zen（2026-11-22 用户指令）**：
  - **OpenCode Zen 实证落地**（调研发现 **Zen 已更名 OpenCode Console**，旧 `/inference/zen/*` 全 404）：新增 `opencode-zen` 预设（OpenAI `/inference/openai/v1` + Anthropic `/inference/anthropic/v1` 双变体、PAY_AS_YOU_GO）；模型发现走协议无关根 `/inference/v1/models`（105 模型，免费档 12 个含决策模型 **`jev-1.13-free`**/付费 `jev-1.13`）；`provider-vault` 端点分流重构——**会话头只对 Go 路径（`/inference/go`）生效**（原 `isOpenCodeUrl` 会误给 Console 加 `x-opencode-session`）；jev 系标 `toolCalling=false` + 面板「决策 S1」能力位，**不进聊天槽位下拉、无「设为主脑」**（System One 决策协议不吃 /chat/completions，待专用适配工单接弹幕快反决策槽），测试模型自动避开 decision 类；备注如实告知「免费档 chat 官方仅保证 OpenCode 客户端内可用，第三方可能 403（FreeUsageLimitError 原文显示）」。
  - **官方图标**（用户指令：网上搜集、禁止生成/随便用）：9 家 logo 从各家官网 favicon 与 GitHub 官方组织头像收集（`file` 校验真实图像、76KB，`assets/brand/providers/` 随构建拷贝）——OpenRouter/DeepSeek/SiliconFlow/OpenAI/Anthropic/MiniMax/火山方舟/OpenCode/Ollama；OpenAI favicon 的 `prefers-color-scheme` 固定为白底黑标（跟 OS 走会隐身）；GPT-SoVITS 无商标级官方标识，保留 lucide 图标不硬凑；台账登记商标指称性使用。渲染 logo 优先、lucide 兜底、白底小卡深浅主题可读。
  - **Magpie 交互采纳**（调研源码逐行实证）：①「获取 Key ↗」直达各厂商控制台——`providers:open-external` IPC，主进程 https+主机白名单校验后 `shell.openExternal`（防渲染层被攻破后钓鱼）；②智能粘贴——自定义对话框 Base URL 支持粘 `curl`/`export OPENAI_BASE_URL|ANTHROPIC_BASE_URL`/带端点后缀裸 URL 自动填 URL+协议+isFullUrl，Key 输入自动剥 `Bearer ` 前缀；③「已关闭」折叠子区——停用服务商沉底不与启用项混排；④详情副行 `host · N 模型 · 状态`。
  - **顺手修真 bug**：`syncBrain` 失败分支也会异步覆盖「保存并检测」结果条（真机实证：多内置商缺 Key 时红色「主脑回落规则」盖掉检测结果）→ 成功/失败都改 toast；坑位实录：**desktop-host 渲染层解析 `@workbench/model-gateway/presets` 走包的 dist 构建产物**，改 presets 后必须 `pnpm --filter model-gateway build` 再重建 desktop-host，否则新预设静默缺席。
  - **验收**：单测 model-gateway 57/57（+zen 预设/端点/决策位断言）+ 全仓 502/502（排除并行会话在制 T-M6-12 包）；真机 CDP **20/20**：logo 10/10 实际加载、zen 面板（名称/副行/备注/获取 Key/大图 logo）、jev 决策 S1 位 + 无设为主脑 + 不进槽位下拉、假 Key 三态不被热更新覆盖、已关闭折叠区往返、外链白名单拒绝路径、curl/环境变量智能粘贴、全开全关/搜索/刷新持久。**待人类**：zen 粘真实 `oc_sk_` key 实测免费档是否放行第三方客户端（403 时会如实显示）、jev System One 适配工单排期。
- **品牌升级：鲸屿 / Whale Isle（2026-11-22 用户指令）**：
  - **命名与图标**：应用名定为「鲸屿」——鲸是桌面上陪你玩的小鲸，屿是承载她的桌面小岛；英文名 `Whale Isle`，标语「一座住在桌面上的鲸屿」。新图标为深空 squircle 上的蓝鲸侧身像（女仆扇贝头带 + 蝴蝶结 + 水花 + 星海底座），母版 SVG 导出 `icon.icns` / `icon.ico` / 16–1024 PNG 全套；`whale-isle-mark.svg` 与中控台/ WebUI 复用同一尾鳍 + 头带视觉语言。
  - **品牌单点事实源**：新增 `src/shared/brand.ts`（`APP_NAME/APP_NAME_EN/APP_TAGLINE/APP_DATA_DIR/BRAND_ASSETS`）；主进程窗口标题、About 面板、Dock 图标、中控台侧栏、`director/index.html` 标题/favicon、WebUI 标题与内联 logo、`package.json productName`、README 全部改为鲸屿，构建时 `assets/brand → dist/renderer/brand` 随包分发。
  - **数据与凭据迁移**：userData 从通用 `Electron` 一次性「薄迁移」到 `Whale Isle`（只拷 provider-vault / meter / memory / stardew-mods / IndexedDB / Local Storage，不覆盖已有文件、不动 `e2e-profile`，marker 幂等）；真实 key 在新目录用同一 Electron safeStorage 解密成功，Brain 启动无报错。
  - **macOS safeStorage 坑（实测）**：Keychain 服务名是「`<app name> Safe Storage`」，`app.setName('鲸屿')` 后旧密文**无法解密**；因此开发态 macOS 保留 `Electron` 作为 Keychain 身份（菜单栏 dev 仍显示 Electron），窗口/侧栏/Dock/About 显式用鲸屿；打包后 `productName` 为鲸屿，Keychain 自然切换。另为解密失败加 fail-closed try/catch（UI 显示未配置、绝不崩主进程或回落明文）。
  - **验收**：CDP 断言 `title=鲸屿 · 中控台`、侧栏 `鲸屿` + tagline tooltip + favicon 路径；WebUI `鲸屿 WebUI · 远程中控` + logo；`pnpm verify:gate` 5 过 / 0 跳过。
- **设计稿 v3「曜石」（apple-ui-design 三原则：Clarity/Deference/Depth）**：iOS 系统色板（#0A84FF 主 accent + 系统语义色）、true-black 分层底（避开死黑）、**光影七层系统**（ambient 环境光斑慢漂移 / 玻璃卡 blur30+内高光 / 发丝分隔线 / 双层柔影 / Sheen 文本光泽 / 状态光晕）、SF Pro+PingFang 节奏、pill 按钮（980px）+ hover scale 1.02、连续曲率圆角 8/12/16/20；tokens 变量名保持兼容（全部页面自动继承质感），shell-chat 全面精修、其余 6 页注入 ambient 光影层；深浅双主题（#f5f5f7 Apple 浅灰对等实现）。功能结构沿 v2 已确认的 7 页（Shell+聊天/Harness/插件管理/星露谷/供应商/桌宠/OBS），插件化信息架构保证新功能融洽插入。
- **设计稿 v2 重做（ui-ux-pro-max 工作流，决策 D4/D9/D10）**：`design/` 全套升级——设计系统由 skill 数据库生成（Modern Dark 开发者工具风格、密度 8/10、Expo.out/spring 动效规格）；run-green 主操作色（#22C55E，"code dark + run green"）替代蓝紫 AI 味（v3 中绿转为纯运行/成功语义色）；lucide SVG 全量替换 emoji（本地 vendor/lucide.min.js，UI 零 emoji）；深/浅双主题完整 token（shell.js 持久切换）；7 页结构确立并经 Chrome headless 深浅双主题截图验证。
- **产品功能设计 v2（定位升级）**：[docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md) 重写——从「Whale Isle 工作台」升级为**通用个人 AI 工作台**（用户决策 D6~D10）：桌宠/直播/星露谷等全部收编为**可开关插件**；插件系统对齐 dsh（Cordis 插件树/defineTool/三层约定）+ 兼容层规划；新增 **ACP Harness 层**（参考 pingdotgg/t3code，MIT 68.5k★，已克隆分析：providers-acp/线程/远程审批，`dsh --profile acp` 直连）；技术栈选型（React 19 + Tailwind v4 + zustand + motion + **lucide-react 图标** + Electron + WebUI 双形态 + Vite 评估）；主题系统（深/浅/跟随+主题色）；ROADMAP 新增 M6 批次 4 工单（Shell+插件内核 / ACP Harness / dsh 兼容层 / WebUI），原 T-M5-03 并入 T-M6-01、T-M5-07 并入 T-M6-02。

### Changed

- **默认启用 LLM 大脑（用户指令）**：`autodrive-host` 的 `brainMode` 默认 `'llm'` 且 `runner` 初始 planner 直接注入 `LlmPlanner`（DeepSeek key 就绪即用）；key 未配置时自动回落规则日程并在顶栏显示。真机验证：启动即 `{"mode":"llm","llmReady":true}`、顶栏按钮「LLM 大脑」、决策流 `planner=llm-xiaojing`；规则日程仍可一键切回。

### Fixed

- **背包满就整理、没箱子就造（T-M6-10 第三批真机，用户指令「别让我介入」）**：真机聊天「钓你个头，背包满了，先造箱子把用不上的放进箱子」却仍被下发 `tidy_backpack` 并继续钓鱼。修复五处闭环：① 聊天关键词把「造/做/合成 + 箱」提到泛化「背包满→tidy」之前，真机事件流 `decision planner=remote craft`（`chat_order craft`）；② LLM 工具参数归一化——`item: ["湿透的报纸"]` / JSON 字符串 / `{name}` 对象统一压成标量，避免网关校验失败；③ `hasChestItem` 认中文「**宝箱**」（此前只认「箱子/Chest」，包里有箱仍判「没箱子」去砍树）；④ 包里有箱时不再攒木，先摆箱：允许 0 空位摆放（摆下即腾一格），不在农场先 `travel_to Farm`，摆完 `chestPlaced` 置位；⑤ 无箱攒木改走文字地图 `findNearestTree → use_tool {tool:'axe',x,y,times:10}` 定向砍树，并修正「行首数字是绝对 y、不能再加 origin.y」的换算 bug（对照真机树坐标 (74,9) 实证）；`clear_area` 回执「没有可以清理」时农场改道森林只试一次，森林也空才放弃，不再 33 次空转。真机验证：`place_item 宝箱 (70,15)` → COMPLETED，`tidy_backpack purpose=fish` → COMPLETED（存 22 件、空位 1→23，如实提示工具已存入箱子）。验证：llm-planner 75/75、planner-rescue 12/12、全仓 791 tests 通过、分支 90.28%。**限制**：本轮 mock keychain 重启后 vault 无法解密，LLM 大脑真机路径未复跑，需正常钥匙串或重新粘贴 Key。
- **中文界面与人话回执（2026-11-23 用户反馈）**：① 回执不再显示原始 JSON——BWF 会把它收到的参数原样回显，`失败：背包里没有“["\u6E7F\u900F\u7684\u62A5\u7EB8"]”` 现在清洗为「背包里没有“湿透的报纸”」；数组/对象 map 均转成「a、b、c」，非法 JSON 保持原样不猜。② 英文工具名补中文、英文留在括号里：`先 craft Chest（50 木材）` → `先制作宝箱（craft Chest）（50 木材）`，`place_item` → `摆放物品（place_item）`（幂等，不套娃）。③ 参数键对齐 BWF schema：LLM 发 `{"items":[...]}` / `{"items":{"湿透的报纸":1}}` 给 `ship_items` 时自动收窄成 `item: "湿透的报纸"`，`craft` 的 `item` 归一为 `recipe`，`take_items` 数组合并为逗号串——从源头避免 BWF 回显整段 JSON。④ 中控台当前动作/回执时间线/聊天事件流显示中文工具名与中文状态（`FAILED` → `失败`），未知工具原样显示。⑤ 规划器提示词要求 `intent` 用中文，工具/配方英文名放括号。验证：adapter 12/12、llm-planner 77/77、全仓 798 tests、分支 90.09%。**未覆盖**：LLM 真实输出仍需钥匙串恢复后复验；OBS `/obs` 挂件仍显示英文工具名（只读技术图层）。
- **满包无箱子死循环（T-M6-10 真机 2026-11-23）**：真实存档春21 08:30、背包空位 0、全是【留着】收集包材料、农场无箱子时，规则模式反复执行 `tidy_backpack` 并 15 次 FAILED，游戏时间冻结（BWF `McpFreezeTime`）形成空转。修复：`Planner.observeReceipt` 回执反馈 + `RulePlanner` 有界救援阶梯（可出货→`donate_bundles`→有箱才 tidy 且只试一次→`wait` 求助，绝不重复同一工具）；`wait` 相同原因只发一次 watchdog/cycle-end。真机新增高价值出路：识别「背包扩到 N 格：Ng」与 `[BuyBackpack]` 坐标，钱够时自动去皮埃尔 `interact` 并 `dialogue choice 0` 购买（真机实测 12→24 格、2890→890g），扩容后自驾恢复 `travel_to COMPLETED → fish`、时钟 09:00→10:10、watchdog 0。验证：planner-rescue 8/8、autodrive 55/55。**第二批真机**又抓到 `AutoDriveRunner.start()` 并发重入导致双循环共用 ActionLock（fish 互斥 ERROR 33 条），已加重入锁并复验：扩容后 travel_to/fish/ship_items 全 COMPLETED、0 ERROR / 0 watchdog，19:00 睡觉→春22 06:00 换日→出货→钓鱼持续正常。**注意**：本轮用 `--use-mock-keychain` 启动，`brainMode=rule`，LLM 大脑路径未真机覆盖。
- **全功能真机回归修复（2026-11-22，用户指令「把所有功能都测试一遍」）**：
  - **浅色主题 legacy 面板黑块**：供应商/Harness/动作库仍在用 `bg-slate-900` 等深色写死类 → 浅色下把 `--color-slate-*` 色阶整体翻转（截图复验白卡）。
  - **饭碗/记忆 badge 不刷新**：回执扣米与换日日记不是推送式 → 15s 轮询 `rice:status`/`memory:stats`。
  - **`get_state` 省略背包段被误判**：BWF 对未变化段落会省略，`freeSlots` 回落 12 导致「满包」被当成「有空位」→ 双规划器记住上次解析值。
  - **贵重物拒扔导致救援卡死**：BWF 拒绝扔能卖 300g 的家具并建议扔鱼饵 → 记录 `rejectedTrash` 并新增鱼饵/种子兜底阶梯；等待态不再抢先触发。
  - **外部启动自驾按钮不刷新**：事件流收到 state/decision/receipt 即置 running。
  - **聊天 Markdown 行距过大**：气泡容器 `white-space: pre-wrap` 与列表块叠加 → 移除。
  - 记忆页 `lastDay` 回落最新日记、窄窗口统计条/按钮溢出、图谱 zoomToFit；桌宠舞台空状态改为「等待游戏状态…」。

- **工作台 UI v4「曜石 · 演进版」还原（用户指令：按最新设计稿更新，优先开源库）**：
  - **设计系统**：`design-tokens.css` 与 `design/tokens.css` 逐行同步（v4 深浅色板/玻璃卡/seg-tabs/switch/range/动效）；移除全局 `*` 重置（unlayered CSS 会压过 Tailwind utilities，导致全站 padding 失效的坑已修）。
  - **Shell**：244px 分组插件侧栏（交互中枢/声形与舞台/游戏与直播/平台与底层，动态 badge 与自动驾驶运行点）+ 顶栏面包屑/⌘K 搜索/语音/大脑/自驾/主题切换 + 饭碗 footer（进度条+投喂 5k）+ 聊天页 304px 右栏（get_state/动作时间线/快捷 P0/记忆与攻略上下文）。
  - **开源库优先**：`cmdk` 1.1（⌘K 命令面板，Radix Dialog 随包）、`sonner` 2.0（toast）、`react-markdown` 10 + `remark-gfm` 4（聊天 Markdown）、`react-force-graph-2d` 1.29（记忆力导向图谱）——不再手写命令面板/键盘导航/解析器/力导向布局。
  - **新页面**：**记忆图谱与日记**（真实 `memory:graph`/`memory:pin` IPC：92 节点/202 边/日记全文/检索命中高亮/钉住/隐私擦除）、**OBS 透明挂件**（5 图层开关 + 520px 棋盘格预演 + 真实饭碗/气泡 + STAGE_PROTOCOL 接线中标注）、**插件与权限策略**（9 插件热开关即时过滤侧栏、Policy 单咽喉与六大扩展点只读表）；`voice` 合并音色库+声音工坊（seg-tabs）、`pet` 合并透明舞台+动作库（真实 manifest 待机视频/双轨气泡/语音设置/今日目标）、星露谷三栏、聊天 Markdown+slash 浮层。全站移除彩色 emoji。
  - **契约**：新增 `MemoryNodeView/MemoryEdgeView/MemoryGraphView`（36 域跨语言重生成）。窗口默认 1360×860（min 1120×700）以承载 v4 三栏。
- **契约/后端补记**（并行批遗留）：`MemoryGraphView` 只读快照 + `memory:pin`；`autodrive-host` 暴露 `say/subscribe/getBrainMode` 供 WebUI 复用。

- **T-M5-18 背包容量自愈（用户指令「现在好像处理不了背包满了」）**：研读 BWF `GameActions.Tidy.cs`（tidy/store 依赖农场箱子，无箱必失败）与 feiyuos-stardew-ai-farmer `LESSONS.md`（满包 craft 会掉地上、任务物品绝对保留、白名单卖货）后重写救援策略——**确定性救援阶梯**：tidy（purpose 按时段）→ ship_items（排除法 + 值钱线索排序，工具/种子/肥料/鱼饵/炸弹/花束/吊坠/家具/【留着】任务物品不卖）→ eat（跳过任务鱼）→ trash（真垃圾）→ store → 任意非必需品；失败才降级，腾出空位即归零，全失败退化为 wait 不空转；被 BWF 拒绝的单品（家具/任务鱼/名字带 xN）自动记住换下一个。真机三段实证：`tidy FAILED(无箱子)` → `ship_items 沙丁鱼 COMPLETED 180g` → `travel_to Beach` → `fish`；另修复 `cleanItemName`（去 `xN`/品质词）与 RulePlanner 满包直接出货。
- **T-M6-06 星露谷 Mod 管理（用户指令「我还希望能管理星露谷的 mod」）**：契约新增 5 域（StardewModInfo/Snapshot/ToggleRequest/OpResult/Config → 33 域跨语言重生成）+ `packages/stardew-mods`（SMAPI manifest 注释/尾逗号容错、损坏 manifest 可见、目录扫描、`.disabled` 启停、解压目录安装重名 -2、三平台 Mods 路径猜测；48 it，分支 95.9%）+ 主进程 `mods-host`（配置落 userData、系统解压 zip 安装、打开目录）+ Shell 新增「Mod 管理」页（目录候选切换/列表开关/安装 ZIP/刷新）。真机：自动探测 Steam Mods 目录并列出 3 个真实 Mod（含 BWF 1.1.27），SaveBackup 启停往返成功。
- **对话控 AI（中文自然语言指令）**：Shell 聊天里直接说「先去海滩钓鱼吧」「先把多余的东西放到出货箱」即可插队——关键词直译（去海滩/农场/镇上/矿洞、钓鱼、整理背包、睡觉、浇水）优先，未命中再走 LLM 指令解析（白名单校验）；插队决策事件标记 `planner=remote`（中控台显示 P0 插队）。真机验证：关键词 → `decision remote travel_to 主人指令：去海滩`。

- **三票并行批 ✅（用户指令「分三个子 agent 一起做」，2026-11-22）**：
  - **T-M5-05 弹幕注意力中枢 `packages/live-stream-hub`**（dsh-livestream 思想重写，零依赖）：三级注意力调度（按**说话人数** 7/8/29/30 分档，τ 90/40/20s e^(-age/τ) 衰减，档位名额 4/2/1，刷屏单人不升档）+ 同观众 15s 合并（≤5 段）/礼物 3s 连击/进场 2.5s 聚拢（>20 人折叠）+ 300s 超龄清理/512 队列上限；防封护栏（block→频控 20 条/分→mask→warn 四级，UTF-16 安全截断 200 + 孤立代理对清洗）；事件中枢（契约 safeParse→护栏→4000 LRU 去重→150ms 批次 flush→订阅多播，单订阅者异常隔离）。**46 it 全绿（分支 92.5%）**；风暴集成复核：5 观众 100 条/秒不升档、频控丢 200 条、平台违禁 3/3 拦截、30 位说话人→busy、同 eventId 去重。
  - **T-M6-03 dsh 插件兼容层 `packages/plugin-kit`**（Cordis 语义，本包四维 100%）：manifest Zod Schema（7 扩展点/permissions/dshCompatible）、`defineTool`（zod 入参校验 + `{ok:false}` 异常包装）、`ToolRegistry`（重名拒绝/按插件批量注销）、事件总线（`domain:*` 通配/once/监听隔离）、`PluginHost`（register 即启用、父子树 disable 级联、LIFO 副作用回收、setup 崩溃回滚+errors 记账）、`adaptDshPlugin`（结构化最小面，未声明 schema 的外来工具默认 ask 审批）。**33 it 全绿**。
  - **T-M6-04 WebUI 形态（`webui-server` + `src/webui`）**：仅回环 `127.0.0.1:18780`、启动生成 device token（`?token=`/Bearer 双校验，无 token 401）、`/api/state`（运行态/大脑/记忆/语音 + 总线事件）、`/api/command`（复用 Shell 同款小鲸回话：人设+记忆+雷区反射+发声）、`/api/approve`（远程 ACP 审批直连 `resolvePermission`）、`/ws` 事件推送、`/renderer/*` 静态资源（路径穿越防护）；`WebUIClient` 指数退避自动重连。**62 it 全绿（本目录四维 100%）**；真机 curl/WS/指令/审批全通。`ws` 用 `createRequire` 延迟加载，避免 esbuild ESM 打包 `require('events')` 崩主进程。
- **真机自驾护栏（2026-11-22 真机抓到死循环后修复）**：`parseGameState` 新增 `背包空位` 解析；Rule/Llm 双规划器空位 0 → 确定性 `tidy_backpack`（不烧 token）；整理连续失败 → `ship_items`（从背包段解析可出货物品，跳过工具与「留着」任务物品）/无物可出 → `store_items`；同工具连续两次失败 → 换规则日程。真机复验：`tidy_backpack FAILED`（农场无箱子）→ `ship_items COMPLETED 2 个 小嘴鲈鱼 ≈125g` → 恢复钓鱼，死循环消失。长动作表补 `travel_to/interact/give_gift/tidy_backpack/store_items`，消除 30s 假超时。
- **中控台聊天体验（codex 式）**：`chat_reply/reflex_spray` 从绿色「COMPLETED 回执卡」改为**左对齐头像对话泡**（雷区反射带「炸毛反射 · 0 token」标签）；主进程事件环形缓冲（≤200 + 单调 `seq`）+ `autodrive:status` 水合，**刷新中控台不再丢对话**（真机刷新后立即渲染 18 条历史）；`autodrive-host` 暴露 `say/subscribe/getBrainMode`，WebUI 复用同一总线。

- **设计稿 v3 差异补齐 + T-M5-04 ✅ 记忆图谱（接续完善）**：
  - **UI 差异补齐**：聊天流新增**紫云朵内心戏卡**（violet dashed 渐变，设计稿 L2）；用户消息改独立右对齐蓝渐变气泡（设计稿 .bub.me）；桌宠双轨气泡换 v3 材质（think=紫云朵 dashed+小圆点尾巴 / dialog=深空玻璃+蓝边+内高光）并**接线 autodrive 事件**（decision.intent→云朵 12s 自动收、chat_reply/reflex→对话泡 10s）；修复回话重复插卡（只信主进程广播）。
  - **packages/memory-graph**（feiyuos-memory-graph MIT 思想重写，零外部依赖 D14）：`MemoryStore`（JSONL append-only+内存 Map/邻接表+墓碑压实 30% 阈值+半衰期 30 天/宽限 7 天/0.2 剪枝+pinned 永存+**正文消毒**剔路径/内部 id/密钥——修复 `skip_event` 被误掩码的正则误伤）；`retrieve`（中文 2-gram 词法召回→沿边 2 跳图扩展→加权 0.5 相似+0.3 重要+0.2 新近+0.3 钉住→topN，只召回 event/summary）+ `formatMemoryContext`（≤600 字 Token 预算）。
  - **主进程 `memory-host`**：回执自动入图谱（event+temporal 边，翻车事件重要度更高）；**换日自动写日记**（`春16日 日记：完成 N 项，翻车 M 次…`）；聊天问句检索注入 LLM system（「回答时自然使用记忆，不要编造」）；`memory:query/diary/stats/wipe` IPC。
  - **真机验收**：60s 自动驾驶 → 13 节点 15 边（lastDay 春16日）；检索「钓鱼」7 条命中；**聊天「你刚才都做了些什么」→ 小鲸答「刚才在春16日跟威利聊钓鱼的事，对话都推进好啦。米粒都差点饿没了呢～」**（记忆驱动+傲娇人设）；293 tests 全绿 + 门禁 4 道。
- **T-M5-17 ✅ 声音工坊 Voice Studio 全栈落地（契约→后端→UI→测试四件套）**：
  - **契约**（shared-protocol +4 域 → 28 域跨语言重生成）：`PauseConfig`（dsh-gpt-sovits 气口停顿 340/150/460 三档）；`TtsEmotionTuningParams`（5 情绪锚点独立 refText 必填+speed/temperature/topP/topK/pauseConfig/前置音效）；`SvcSingingTuningParams`（dsh-voice-studio RVC 调参：升降调 ±12 半音/indexRate 0.75/气声保护 0.33/人声伴奏混音电平）；`VoiceDesignRequest`（三路径：云端捏声/本地切片/权重导入强制 licenseScope）。
  - **后端**（`services/audio-ai-worker/voice_studio.py` +5 端点 FastAPI 子路由）：`/design`（内置「大肥鱼傲娇蓝鲸女仆」等提示词模板 → stub 生成+prompt 归档+试听 b64）；`/slice-extract`（Demucs 互斥+内存 <4GB 422 降级+确定性 3-8s 切片+ASR 草稿）；`/audition-tts`（**refText 空值 400 拦截 + autoFill 草稿兜底**——防内部 ASR 40s 卡顿；skipCache 实时渲染）；`/audition-svc`（**ResourceMutex：先挂 TTS→RVC→恢复**（mutexTrace 断言）+低内存 422+resourcesLow）；`/save-pack`（五锚点+RVC 原子写 `voice_matrix.json` + 热重载钩子；重复锚点/空 refText 拒绝）。
  - **UI**（`voice-studio-panel.tsx` Shell 第 7 页签「声音工坊」）：顶部音色卡（licenseScope+MPS 徽章）+「生成/提取新音色」三模式弹窗（AI 捏声线/上传切片/导入权重）；左侧 5 情绪调音台（refText 编辑+语速/表现力滑块+三档停顿数字框+快捷台词胶囊+试听按钮）；右侧 RVC 实验室（5 滑块+女声微调 +2/男转女 +12 快捷预设+副歌试听）；底部吸底栏（还原/保存到桌宠人设热重载通知）。
  - **测试**：pytest `test_voice_studio.py` 13 项（参数 100% 往返一致/空 refText 拦截+autoFill/互斥锁 trace/低内存降级/重复锚点拒绝/确定性切片）+ TS `voice-studio-contracts.spec.ts` 10 项（契约双侧对齐）；mypy --strict 零错（torch optional 检测 sys.modules 化）；278 tests 全绿。
- **工作台 UI 还原设计稿 v3「曜石」+ 音色库页（用户指令）**：director 全量重构——Tailwind 调色板整体映射 iOS 系统色（slate→近黑玻璃、sky→#0A84FF、emerald→#30D158 等，既有面板自动继承设计语言）+ `design-tokens.css`（光影七层/玻璃卡/pill/ambient 光斑/stagger 动效）+ lucide-react 图标体系（UI 零 emoji）+ 左侧插件导航（六面板路由：聊天/星露谷/动作库/音色库/Harness/供应商）+ 顶栏三态按钮（语音开/LLM 大脑/自动驾驶）。**音色库页**：5 候选音色卡（俏皮萌妹/嗲嗲学妹/清脆少女/傲娇大小姐/倔强朋友）× 五档情感试听（25 按钮，音高/语速参数标注）——点试听即合成播放，点「使用此音色」写 voiceId 全场景生效（聊天/播报/内心戏）。voice-host 新增 `voice:catalog`/`voice:audition` IPC。E2E：音色页 5 卡 25 试听按钮/切换持久/真机试听播放；全部门禁 4 道全绿。
- **D11 定稿音色 ✅「俏皮萌妹」五档情感语音（用户确认音色，mcode-tools 合成链）**：voice-host 接 `mcode-tools connector batch_text_to_audio`（voice_id `qiaopi_mengmei`，voice-preset.json 用户定稿五档）——**daily 软萌小女仆**（347Hz/happy/句尾上扬 2.6 半音）｜bright 俏皮上扬（+4 半音）｜**tsundere 傲娇炸毛**（480Hz/angry/speed1.6——雷区反射专属）｜**sleepy 慵懒气声**（193Hz/volume0.45——内心戏心声专属）｜surprised 惊喜元气。**D11 场景矩阵直接映射**：正式台词→daily、内心戏→sleepy 气声、P0 雷区→tsundere 炸毛；聊天 LLM 回话自动发声；合成失败回落 say 变调链（三层保底）。E2E 四段真机验收全过（daily 台词/sleepy 心声/tsundere 反射/LLM 回话「没看到我在浇水吗」傲娇语气同步播出）。技术修复：ESM require→静态 import、sp 别名清理。
- **D11 语音第一版 ✅（macOS say 引擎，零外部依赖 D14）**：`voice-host.ts`——正式台词正常语速 / **内心戏心声语速 0.82 + 省略号前置**（低语感）/ **P0 雷区反射 1.15× 语速并打断在播**（单端不变式）；同文本 8s 节流；队列串行。**接线**：chat:say 回话自动发声（LLM 回话→婷婷音色真机出声）；autodrive 回执短评（UNCERTAIN→「都怪石头突然长出来的！」心虚甩锅 / 钓鱼成功→「本鱼的手感是天赋！」）；Shell 顶栏语音开关+试听按钮。修复：voice:speak 双注册 → DI 重构（main 统一创建/注册一次，autodrive 注入使用）。Windows SAPI 留 T-M6-05 平台适配。E2E 六项真机全过（say 子进程实跑验证）。
- **T-M6-01 完整版 ✅ LLM 大脑真机闭环（聊天回话 + LLM 决策玩游戏）**：`LlmPlanner`（game-bridge-mcp）——get_state + 回执上下文 + **guide-forager 攻略检索注入**（按状态线索挑专题 ≤1200 字）→ model-gateway（vault safeStorage 解密 DeepSeek key → DELUXE 套餐六槽位绑定）→ JSON 决策协议（宽松提取 + **75 工具白名单越权拦截** + 坏输出重问一次 → **RulePlanner 兜底，大脑掉线自动驾驶不停摆**）；菜单态确定性绕过 LLM（不烧 token）。主进程 `planner:switch`（规则/LLM 热切换）+ `guides:load`（7 专题注入）+ **`chat:say` 聊天回话**（「大肥鱼」雷区反射 0-token 直出 → persona 傲娇人设主脑回话）。Shell 顶栏大脑切换按钮 + 聊天流渲染回话。**真机验收**：小鲸真 DeepSeek 回话（"防风草长得可好了，都冒两片叶子了～记得给我加餐哦"人设满分）；LLM 决策铁证——**看到背包满自己决定「吃海草腾一格，不然鱼没地方放」**（原创造，规则引擎无此文案）；切换+攻略注入 7 专题 ✓。修复：guides 相对路径 4 级（dist/main→仓库根）。
- **T-M5-15 ✅ guide-forager 攻略采集器（D15 全链路真机闭环）**：`tools/guide-forager`——MediaWiki API（parse wikitext）→ 清洗管线（模板折叠/链接展开/加粗列表时序修复/表格降噪/标题层级——清洗坑：列表正则会误伤 `**加粗**` 行首，必须列表先于加粗）→ 主题归档 markdown（frontmatter 来源署名 + sha1 去重）→ **BWF get_guide 直通**（导出 Mod guide/ 七专题：钓鱼/采矿/节日/结婚/沙漠/姜岛/农场类型）；真机验收：**游戏内 get_guide 钓鱼 返回刚抓的 wiki 最新攻略**（重启游戏重载生效）；wiki 拦 Node fetch(403) → CLI 走 curl 子进程；courtesyDelay 限速。单测 9 项（离线 fixture 全路径：清洗断言/去重/薄页跳过/错误透传/容错/双页混合）。
- **D16 饭碗档位联动（适当时机触发补全）**：autodrive 回执扣米（30 粒/回执模拟计量，真实计量待 T-M5-04 token_ledger）→ 档位边沿广播（hungry/starving/full/fed_buff）→ 桌宠档位动作（RICE_LEVEL_ACTION_MAP）；`rice:feed` 投喂 IPC（Shell/directorBridge.riceFeed）→ fed_buff。E2E 真机：投喂 90000 粒 → full 档 → happy_maid 池动作真实切换 ✓。
- **T-M6-02 ✅ ACP Harness 层 + T-M5-16 ✅ 动作库预览与情绪全映射（D16）**（2026-11-21 深夜）：
  - **agent-harness 包**：ACP v1 客户端（stdio JSON-RPC 双向、initialize/session/prompt/permission 流、鉴权错误 auth-required 事件、pending 清理、行协议 banner 容错）；providers 注册表（真机探测：gemini --acp 原生 ✓ / dsh --profile acp ✓ / claude-agent-acp 预留）；HarnessManager 全生命周期；**acp-simulator**（测试脚手架假 agent：流式 update/权限请求/审批回填）。真机验收：gemini + dsh 双握手 ✓、dsh 真实会话创建 ✓（API key 失效如实透传）；Shell 第 4 页签 Harness（providers 卡/对话流/审批卡 YNA）；协议实测修正（dsh 要求显式 jsonrpc 字段）。
  - **D16 动作库**：emotion-map 三层映射表（情绪五档/游戏回执七类/饭碗五档 → 语义槽位）+ classifyAutodriveReceipt；**playClip 单条零黑帧播放 API**（ambient 池条目不在槽位也可播，加载失败保留旧画面）；Shell 动作库页（11 槽位卡+77 氛围池分类网格+点击预览→桌宠窗即播 6s 回 idle）；pet-stage ambient 空闲随机链（30s→pickAmbient→6s）；**素材零闲置审计单测**（114 clips 槽位∪池全覆盖+无重复挂载）。E2E：11 槽位+77 池渲染、槽位预览（鲸尾拍地）、ambient 单条预览（放风筝.webm 即播）全真机通过。修复：ESM __dirname、预览视图切换复位。
  - **D15 攻略采集 guide-forager**：PRODUCT-DESIGN §2.10 设计 + ROADMAP T-M5-15 工单（wiki MediaWiki API/小黑盒→主题归档→BWF get_guide/LLM 检索/技能卡三路注入）。
  - 工程修复：better-sqlite3 ABI 双 node 环境断裂（PATH node26 vs pnpm node24）→ prebuild-install 对齐 pnpm 测试链 137；v8 覆盖率抖动确认（连跑两次 exit=0）。
- **T-M5-01 ✅ + T-M5-02 ✅ + T-M6-01 最小版 ✅ 端到端真机打通（2026-11-21 晚）**：
  - **素材**（T-M5-01）：dsh-pet 114 个 VP9-alpha webm（55MB）入库 `packages/pet-renderer/assets/blue-whale-maid/`（D14 随包分发）；契约扩展 `ambientPool`（77 条随机氛围池）跨语言重生成；`gen:pet-manifest` 生成器（11 语义槽位全覆盖 + sleep 循环段 + 池空兜底 `pickAmbient`）；manifest-asset.spec 3 项门禁。
  - **game-bridge-mcp 包**（T-M5-02）：`mcp-client`（SSE/JSON 双解析 + JSON 前缀括号平衡解析器 + 超时≠失败语义 + 长动作 10min 分层超时）；`action-lock`（单在途互斥 + stats + cancel 幂等清锁）；`StuckSentinel`（4min 游戏时间冻结→卡死哨兵，时钟可注入）；`RulePlanner` 确定性日程（morning-mail→farm-work→fishing→forage→homeward，体力<8% 强制睡觉防晕倒，菜单优先处理）；`autodrive` 编排器（get_state→哨兵→P0 插队→执行→回执多播，**不可解析状态/网络错误按 watchdog 处理而非盲跑**，错误详情透传修复，maxCycles 死循环防护）。
  - **宿主接线**：main `autodrive-host`（事件 webContents.send 单源多播到两窗 + autodrive:start/stop/directive/status IPC）；preload `directorBridge` 扩展（含 onAutodriveEvent 中继）；pet-stage 真形象加载（manifest 相对路径改写 + 114 webm 随包拷贝到 dist/renderer/pet-stage/assets）+ **autodrive 事件驱动动作映射**（UNCERTAIN→clumsy_panic / FAILED→rage_spray / 钓鱼收获→happy_maid / 决策→game_focus / state→thought 气泡）。
  - **Shell 三页签**（T-M6-01 最小版）：聊天（autodrive 事件流卡片化 + 启停按钮 + `/goto /fish /sleep /stop /forage` 指令 P0 插队）｜星露谷监控（get_state 摘要 + 回执统计 + 时间线）｜供应商配置（T-dir-01 全量迁移 providers-panel.tsx）；E2E 适配页签导航后全绿。
  - **真机端到端验证**：游戏重启后 BWF MCP bind → load_save 读档（泡泡湾 春16 06:00）→ Shell 点「启动自动驾驶」→ **小鲸真实接管游戏**：read_mail 7 封（COMPLETED）→ water_crops 浇水（COMPLETED）→ travel_to Beach 去钓鱼，游戏时间 06:00→06:50；`/fish 5` P0 插队 ✓；桌宠窗渲染真形象（待机呼吸.webm + DEV 水印 + 事件驱动切换动作）✓；监控页 15 条真实回执 ✓；`verify:gate` 4 道全绿（覆盖率攻坚：新增 game-bridge-mcp 20+ 用例至分支 90%+）。
- **D13 形象与直播增强**（用户 2026-11-21 补充）：PRODUCT-DESIGN 新增 §2.6 小鲸日记（SessionEvent→换日归纳→图谱入库，聊天可问"昨天做了什么"只答有据）/ §2.7 形象工坊（AI 生视频→绿幕→normalize→manifest 注册→试穿，精灵图逆向导入）/ §2.8 直播感知与点歌（进房模糊解析+翻旧账问候、tid 防双计、**送礼插队点歌**[小+1位/中+3位/大置顶]、歌单管理、违禁拦截/同曲冷却/限额）/ §2.9 方案方补充功能（远程互动、日记面板、弹幕抽奖、多形象轮换）；ROADMAP 新增 **T-M5-13 形象工坊**、**T-M5-14 小鲸日记面板**，扩展 T-M5-04（观众双写/日记/提炼）与 T-M5-08（歌单+插队+防呆）；ARCHITECTURE 新增 **ADR-7**（日志=证据链与记忆=可检索摘要职责分离，双路订阅）。
- **D11/D12 桌宠语音与状态气泡设计**（用户 2026-11-21 补充）：PRODUCT-DESIGN 新增 §2.4 语音场景矩阵（正式台词/内心戏发声[默认关，-30%音量+0.9x语速+排队制]/P0 反射/甩锅/碎碎念/播报级，六类触发点+节流护栏 8s/20s/30min）与 §2.5 状态气泡组（动作状态条常驻/今日目标卡折叠/事件弹泡 3.5s 收起/回执 ticker/直播简化/夜间呼吸条）；ARCHITECTURE 新增 **ADR-6**（语音 voice.ts 与气泡 status-bubble.ts 为 pet 插件独立总线订阅模块，非编排器内部件）；ROADMAP T-M5-02/T-M6-01 工单补充对应范围；pet-stage.html 设计稿重写为完整演示（三开关语音面板/心声云朵/台词弹泡+TTS 波形/脚下状态条/目标卡展开态/场景矩阵六卡）。
- **docs/ARCHITECTURE.md 架构师方案 v1**（定稿待用户确认）：C4 两级视图（系统上下文/容器拓扑：main 内嵌 WebUI Server + ACP Client + PluginHost）；**8 条 ADR**（WebUI 内嵌、渲染层总线单向流、PluginHost=@cordisjs/core 最大兼容 dsh、ACP v1 先行 v2 渐进、electron-rebuild 管线解 ABI、三层插件结构 main/renderer/shared）；插件系统技术规格（manifest/defineTool/六扩展点/policy 单咽喉/审批三键/审计链）；数据所有权矩阵（Dexie/SQLite/JSONL 各司）；单源多播数据流不变式；三轨并行开发计划（素材/Shell/游戏轨道 + 合流端到端验收）与风险登记册 R1~R8。

## [Unreleased] - 2026-11-21（第二轮）

### Fixed

- **救援架构转向：判断归大脑，机制归护栏（2026-11-22 用户指令「不要把卡死写成机制，让 AI 判断该怎么做」）**：本会话三轮硬编码补丁（阶梯→造箱自救→全预留牺牲+攒木状态机）证明穷举现场是打地鼠——改为**救援问询**：卡死签名检测保持确定性（最近 ≥2 条环境级结构性失败「没有箱子/craft Chest/材料不够或背包满」），命中后先问大脑——`RESCUE_SYSTEM` 给优先级原则（无损捐赠/撤预留 > 可再生牺牲 > 不可逆丢弃）与工具事实（craft 满包拒且不耗材、木材≥50 直接造、不足先腾格去农场 `clear_area include_trees` 砍树），**动作顺序由大脑现场自定**；护栏照旧——白名单、单日失败预算冷却、重复防护（刚失败同工具仅同物品拦截）、真纠错重问一次、问询 token 如实计入饭碗；大脑不可用/两次坏输出回落原确定性阶梯（降级为离线兜底）。`repeated` 双败护栏如实接管解卡后的过渡（换规则日程不停摆）。llm-planner **59/59**（大脑驱动全链：结构双败→问询自选 donate→bundle_info→donate 冷却→吃预留鱼→砍树→421 确定性 craft→case 8 摆箱→chestPlaced；护栏用例：冷却拒绝重问/同工具换物品放行/白名单坏输出回落 donate；8 个阶梯分支测试改「大脑离线」stub 继续守住兜底路径）+ 全仓 **618/618** + depcruise 全绿，应用已重启带新逻辑。
- **修正 think 标签泄漏到桌宠气泡（2026-11-22 用户截图反馈）**：LLM 有时在 `decision.intent`/`receipt.summary` 里原样带出 `<think>内心戏</think>`，而桌宠云朵泡是纯文本渲染（`textContent`），导致标签直接显示给主人。根因：`persona-brain` 已有 `stripThink`（11 项单测含未闭合标签），但**生产事件链从未调用**。修复在主进程单源多播 `broadcast()` 处统一清洗所有用户可见文本字段（decision.intent / receipt.summary / watchdog.detail），桌宠气泡、中控台事件流、WebUI 订阅全部受益；`chat_reply` 的语音也改用清洗后的可见文本（不再朗读标签）。另顺手补齐其他会话在制半成品的两处编译遗漏：`pet-stage/main.ts` 饭碗刷新用了未定义的 `applyRice`/`riceBudget`（改走已有 `riceStatus()`+`riceBowlWidget.setRatio()`）、`drag-throw.spec.ts` 缺 `Bounds` 类型 import。全仓 tsc 零错误，think.spec 11/11。
- **满包死锁改为「造箱子自救」（2026-11-22 用户真机反馈「应该造箱子腾背包空间而不是卡死」）**：真机 transcript 实证卡死模式——春21日 06:10 起 `tidy_backpack`↔`store_items`↔`donate_bundles` 无箱死循环，BWF 失败回执两次明说「先 craft Chest（50 木材）」而背包里就有木材。根因链（BWF `GameActions.cs` 源码实证）：**BWF Craft 满包直接拒绝且不消耗材料**（「材料不够或背包满了」）——feiyu「满包合成掉地上」教训对 BWF 不适用，却导致救援阶梯 case 7 硬门槛 `freeSlots>0`，满包时永远走不到造箱。修复三件：① **case 7 满包造箱自救**——木材 ≥50 且无箱时，满包先 trash 整格低价值材料（新 `pickChestSacrifice`：BWF 官方建议的石料/泥土/纤维，绝不碰木材/工具/【留着】）腾一格 → BWF craft 放行 → 上方「顺手造/摆箱」分支自动接住 → 摆箱 → tidy/store 全恢复；② **case 1 出货保木材**——造箱计划激活时（无箱且木材 ≥50）ship 跳过木材（先卖别的腾格还能赚钱，木材卖了箱子永远造不出）；③ **421 分支去掉 craft 的农场位置门**（BWF craft 无地点要求，链条不因玩家位置断）。真机死循环成为四步确定性自救：卖石/扔石腾格 → craft → place → 恢复正常日程；连「只有工具+木材」的绝境仍保留 wait 求助（reason 提示造箱）。单测 54/54（含全链回归：ship 保木材→craft→place→chestPlaced 置位→恢复正常决策）+ game-bridge 101/101。
- **满包造箱自救·现场二修正（用户复测仍卡死；get_state 直读背包实证）**：背包真身是「木材仅 x22（<50——BWF 那句「先 craft Chest（50 木材）」是模板建议、没看存货）且**全部非工具物品被 BWF【留着：收集包】预留**（两条预留鱼/牡蛎/蚌/木材/石头），前修的牺牲格被 KEEP_TAG 全挡。完整解法：① 新 `pickRenewableReserved`——全预留绝境只在**可再生**预留物里挑牺牲（可食用鱼优先 force 吃还能回体力、海边采集 force 扔；**攒箱本钱木材/石头绝不碰**），且排在新 **step 12**——位于捐赠（case 10）与撤过早预留（case 11）**之后**（预留材料的无损出路优先穷尽；单测实证放 case 7 会抢跑吃掉本可捐赠的鱼）；② **chestGathering 攒木状态机**——木材不足时进攒木模式：牺牲腾格后主流程接管 `travel_to Farm → clear_area {include_trees:true}`（BWF ClearArea 源码：不带坐标清周身、'T' 树用斧头 25 下）→ wood≥50 → craft → place；clear_area 单日失败预算耗尽（农场没树）→ 放弃当天造箱回落常规救援。真机现场全链九跳单测：donate（无损优先）→ bundle_info → donate 失败预算冷却 → **eat 预留鱼 force** → clear_area 砍树 → craft → place → 回规则日常（repeated 双败护栏如实接管）。llm-planner 56/56 + 全仓 **615/615** 全绿。
- **Console（原 Zen）保存并检测报错根因定位 + 复制 Key（2026-11-22 用户真机反馈，真实 key 隔离实例复现）**：用户在 Zen 保存 key 后检测报错——用其 vault 拷贝在 PET_STAGE_E2E 隔离实例复现出完整真相：**免费档 chat 对第三方客户端返回 429 `FreeUsageLimitError`（官方策略：免费模型仅 OpenCode 客户端内可用）、付费档返回 402 `Insufficient balance`（账户无按量余额）**。修复：① 检测改**定向两探**——免费档一次 + 付费档一次（免费档全档同错连试无信息量；401 Key 级错误即止），失败时逐档如实汇总「big-pickle：HTTP 429 FreeUsageLimit…；glm-5.3：HTTP 402 Insufficient balance…」用户一眼看懂该充哪边；② 修上一批的分类 bug：免费档 chat ≠ 决策协议（原把 big-pickle 等免费模型标 toolCalling=false 被 UI 当成决策类踢出检测），改以 `/inference/v1/models` 的 `type`+`cost` **服务端元数据**分类（决策/免费/普通 chat 三种 pill；embedding/image/realtime/video 不再混入模型列表，清单从 105 净化为 chat+decision）；③ **复制 Key（用户指令）**：`providers:copy-key` 主进程解密直写系统剪贴板（`clipboard.writeText`），明文不回传渲染层、界面不显示；④ **发现 Go 订阅的免费通道**：`opencode-go` 端点的 **`hy4-flash-free` 不占 Go 配额**（真机 1396ms 回话成功），已加进预设开箱可见——这才是用户实际可用的免费模型（Console 免费档被官方锁客户端，绕不过也不伪装 UA 破限制）。真机：23/23 回归（含 `pbpaste` 端到端验证假 key 真实入剪贴板）+ 真实 key 复验（429/402 逐档展示、copy-key ok+掩码、go 清单 5 模型含 1 免费）。
- **OpenCode Go 400 `MissingSessionID`（用户真机粘贴 key 后报错）**：按官方 Go API 规范补齐必需头 `x-opencode-session: ses_<stable>`（同一会话×槽位恒定，供路由与 Prompt Cache）+ 客户端 `User-Agent: xiaojing-workbench/1.0`；Base URL 迁移到 canonical `https://opencode.ai/inference/go/openai/v1` 与 `/anthropic/v1`；模型发现改走协议无关根 `https://opencode.ai/inference/go/v1/models`。真机验证：连接检测 1.5s 通过、拉取 5 个模型、网关真实回话 2.1s 并记账 `providerId=opencode-go/modelId=deepseek-v4.1-flash/426 tokens`。
- **服务商保存后不显示已连接 + OpenRouter 检测误报保存失败（用户真机反馈）**：① 根因——内置服务商 `commitProvider` 落 Dexie 时漏存 `keyMask`（`configured` 是从它派生的），「保存并检测」刚成功就回退「未配置」，重开面板 Key 明明在 vault 里却显示没连 → 补存 `keyMask/testOk`，且水合时逐家对账主进程 vault 掩码（`providerKeyMask` IPC），历史脏 override 自动修复；② OpenRouter 报错根因——检测用预设模型 ID（如 `anthropic/claude-sonnet`）已下架 → 404 被误读成「保存 key 报错」→ 改为**先拉真实 `/models` 清单再挑清单内模型测连**（清单校验 Key + 新模型自动并入），检测失败时如实区分「凭据已加密保存（掩码）· 连通检测未通过：<HTTP 原因>」与保存失败，状态行三态（绿已连接/琥珀检测未通过/灰未配置）；③ `syncBrain` 成功回调改 toast：此前异步 `setNotice` 会把「保存并检测」结果条约 1s 后整个覆盖成绿色「主脑已热更新」——失败路径红条刚出现就被绿条盖住，是用户误读「报错」的直接帮凶；④ 模型列表补齐设计稿已画的**搜索框**与新增**一键全部开启/关闭**（作用于全部模型而非过滤结果，全关时同步清空相关角色绑定）。真机 CDP 回归 **12/12 断言过**：假 Key 保存 → 如实「凭据已加密保存（sk-t••••••••cdef）· 检测未通过 HTTP 401（DeepSeek 官方回 Authentication Fails）」→ **刷新后掩码与琥珀态仍保持（keyMask 持久化核心回归）**→ 结果条 2.5s 后不被热更新覆盖 → 全关 (0/3)/全开 (3/3) → 搜索 reasoner 命中 1 行/空态文案 → OpenCode Go 5 模型在列。`pnpm verify:gate`：Gate 1/2/4 过、全量单测 500/500 过（唯一红项 `llm-planner.spec` 为并行会话未完成的 T-M6-12 防抖改动，与本批无关）。
- **星露谷自治安全性（T-M6-10 续）**：系统提示升级为人类玩家准则（界面优先/批量工具/失败换法/【留着】红线/23:00 回家/update_notes/农场规划/花钱规划）；新增确定性作息护栏（23:00 必回家睡觉、体力 <8% 先吃→回家→睡，先于背包救援执行）。

- **星露谷自治打磨·第一轮（T-M6-10）**：
  - **剧情菜单**：`当前界面` 改多行解析；选择题按 0 基 `choice` 回答（修复「这是个选择题，请用 choice」无限 FAILED）；起名界面 `set_name 小鲸`；过场无对话框 → `skip_event`。
  - **背包只剩家具**：解析文字地图找最近空地 `place_item`；被挡自动换相邻格/采纳 BWF 建议坐标；6 次仍失败 → `trash_item force=true` 兜底。
  - **长期箱子方案**：农场空闲且木材 ≥50 → `craft Chest` → `place_item` 摆箱；只剩【留着】收集包材料 → `donate_bundles` 捐掉腾格。
  - **长动作超时**：`clear_area/till_area/plant_seeds/place_item/set_name` 纳入长动作（修复 clear_area 30s 假 TIMEOUT）。
  - 单测新增 15+：菜单多行、choice/set_name/skip、家具摆放/建议坐标/force 丢弃、造箱/摆箱/捐赠、空地解析、长动作表；game-bridge 81 it，分支 90.35%。

- **T-M6-09 模型与服务商 v5（2026-11-22 用户指令）**：
  - **取消三档干饭套餐**：UI 只保留单一当前生效配置（Dexie 写入 → `brain:apply-config` 热更新）；默认模型 Tab 六槽位从「已启用服务商 × 已启用模型」中选择，文本角色可一键跟随主脑。
  - **OpenCode Go 内置**：`opencode-go` OpenAI（`/zen/v1`）与 Anthropic（`/zen/anthropic/v1`）双变体 + 5 个预设模型；契约新增 provider/variant `protocol`，gateway 支持 Anthropic `/messages`（x-api-key + anthropic-version，无 Authorization）；sanitizer 增 `oc_sk_`/`or_sk_`。
  - **自定义服务商**：Dexie `customProviders` 持久化；名称/协议/BaseURL/isFullUrl/模型手动增删启停；删除时同步清理角色绑定；provider 总开关与绿点。
  - **Magpie / CC Switch 只读导入**：主进程 `provider-importer`（Magpie JSON、CC Switch SQLite 经 `sqlite3 -readonly`、JSON 导出/旧 config.json），预览仅服务商名/协议/BaseURL/模型数/掩码；apply 阶段主进程直接 safeStorage 加密写 vault；`skip`（默认，已有凭据不覆盖）/`overwrite`；SQLite 只读有 fixture mtime+sha256 断言。
  - **UI**：providers 页按 `design/providers.html` 重构为 Master-Detail（256px 目录 + 专注面板）+ 双 Tab + 导入弹窗 + 添加自定义弹窗；零 emoji；浅色主题同步。
  - 修复：license-scanner 误把 tsc `build/` 编译产物当源码扫描（跳过 build），Gate 2 恢复 0 违规。

- **P0 正确性收尾（2026-11-22 用户选定方向）**：
  - **套餐/槽位真正驱动运行时**：新增 `BrainRuntimeConfig` 契约（38 域）；App 启动与供应商页每次改套餐/槽位/激活模型 → `brain:apply-config` → 主进程用 vault 里对应供应商 key 重建 `ModelGateway`，`planner:status` 如实返回 `providers/missingKeys`；不再硬编码 DELUXE。UI 顶栏大脑状态跨面板同步（`wb:brain`）。
  - **真实 Token 饭碗**：`token-meter`（`userData/meter/`）消费 gateway `onUsage` 真实 usage → JSONL 流水（slot/provider/model/输入输出/latency/米粒）+ 日预算 500,000（1 粒米 = 1 Token），支持跨重启、跨日重置与投喂 bonus；删除「1 回执 = 30 粒」模拟扣米。真机：聊天 478 tokens → 499,522 并跨重启保持。
  - **Gate 4 回环 E2E 接线**：`apps/desktop-host/e2e/gate4-loopback.spec.ts`（live-stream-hub 收弹幕 → persona 0-token 喷水 → 单端语音锁 COMPLETED/active≤1 → SQLite 记仇账本 + 0 token 断言 + 600 米粒记账），`verify:gate` 现在 **5 过 / 0 待接线**。
  - **wait 可见化**：planner 返回 wait 时广播 `watchdog stuck`，中控台显示停滞原因，不再只有静默 cycle-end。
  - 物品名归一剥离 `（手持）`；BWF「没有能扔的…」拒绝文案纳入黑名单解析，避免救援空转。

- **产品功能设计 v1 定稿**（[docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md)，用户决策 D1~D5）：基于 21 个参考仓库的代码级深挖（克隆至 `~/Documents/vibe/reference-clones/`，5 个分析代理并行产出文件级结论），确定六大子系统升级方案——桌宠素材包（dsh-pet 114 alpha webm）、记忆图谱引擎移植（feiyuos-memory-graph）、星露谷自动驾驶（BWF 主线+守护脚本层+CheatBridge 开关）、聊天主界面（Codex 式，D3 最高优先）、三级注意力调度公式移植、鱼鳍安全模板；ROADMAP 新增 M5 批次 12 张工单（T-M5-01~12），当前激活 T-M5-01。
- **docs/REFERENCES.md §4 第二轮代码级复评**：21 仓库总表（定位/可移植点/素材清单，含素材 alpha 与否实测）；D5 用户豁免声明（本地自用可移植、须登记来源）。
- **全界面高保真交互设计稿**（`design/`，决策 D4）：6 页 HTML——`index.html`（设计语言总览：色板/排版/语义）+ `chat.html`（Codex 式聊天主界面：会话列表/think 折叠/工具卡片三态/审批卡 YNA//指令菜单/模拟流式）+ `stardew.html`（自动驾驶监控：动作互斥大卡/真实回执时间线/看门狗六宫格/CheatBridge 开关+审计流水/技能卡/ASCII 地图）+ `providers.html`（Magpie 单屏：套餐/六槽位/供应商卡升级版）+ `pet-stage.html`（桌宠舞台：双轨气泡/饭碗挂件/剪影点击分区/114 动作库网格分类筛选）+ `obs-overlay.html`（18765 挂件：投票板/歌词卡/双轨气泡/弹幕互动）。共享 `tokens.css` 设计 token（深空玻璃拟态）。Chrome headless 截图全页视觉验证通过；设计数据取自真机实测状态（春16日/体力98/竹鱼竿/鳀鱼完美）。

## [Unreleased] - 2026-11-21

### Added

- **T-dir-01 ✅ Magpie 式模型供应商配置 + 客户端真机运行**（参考 [yetone/magpie](https://github.com/yetone/magpie)（MIT，39.6k★）单屏交互思想重写，未复制任何代码）：
  - 契约先行：`ModelProviderConfig` 新增 `activeModelId`（Magpie「一处配置供应商，处处选模型」），`gen:contracts` 跨语言重生成（JSON Schema 24 域 + Pydantic）。
  - 主进程 `provider-vault.ts`：API Key 经 Electron `safeStorage` 加密落盘 `userData/provider-vault.json`（明文只上行、永不下行，渲染进程只见掩码 `sk-1••••••••abcd`）；`providers:discover-models` 主进程 fetch OpenAI 兼容 `/models`；`providers:test-chat` 一次 `max_tokens=1` 真实请求验证 + 延迟回执。凭据库刻意避开 better-sqlite3（其 Node ABI 137 与 Electron ABI 139 无法同时服务 vitest 与 Electron 主进程，文件 KV 亦符合 AGENTS.md §1 的 SQLite 职责清单边界）。
  - preload 新增 `directorBridge`（saveProviderKey/providerKeyMask/discoverModels/testProviderChat）；director 窗口补挂 preload（此前无桥）。
  - director App 重构为 Magpie 单屏：9 张供应商卡（粘贴 Key → 加密保存 → 拉取模型 → 连接测试 → 选激活模型 + Region/Plan 胶囊切换端点）+ 六槽位绑定下拉（选项来自已发现模型，"providerId/modelId" 格式与干饭套餐契约一致）；状态合并 = 内置预设基底 + Dexie `providerOverrides` 覆盖层（重启持久）；套餐槽位绑定存 Dexie `diningProfiles`。E2E 选择器（`data-profile/data-active/data-binding/data-provider`）全兼容。
  - 构建修复：main bundle `external: ['electron','better-sqlite3']`（原生模块打进 ESM 会炸 Dynamic require）。
  - **E2E 稳定性修复**：`PET_STAGE_E2E=1` 时主进程 `app.setPath('userData', …/e2e-profile)`——开发实例与 E2E 并发共用 userData 会撞 IndexedDB LevelDB 锁（`Internal error opening backing store`）导致 director 白屏假死；隔离后 E2E 30s 超时 → 756ms 通过。
  - 真机验证：Electron 38 客户端启动，CDP DOM 验收（9 供应商卡 / 3 套餐胶囊 / 6 槽位下拉 / bridge 挂载）、IPC 链路实测（假 key 保存 → 掩码回读一致 → vault 文件只见密文 → 未存 key 拉模型报错不崩）；`pnpm verify:gate` 4 过全绿。

## [Unreleased] - 2026-11-15（第二轮）

### Added

- **T-M2-02 ✅ 情绪感知 TTS 混合路由**：契约先行（`TtsVoicePack`/`EmotionVoiceProfile`/`LipEnvelope`/`Viseme`/`TtsSynthesisResult` 进 shared-protocol，19→24 域，跨语言 JSON Schema + Pydantic 重生成）；Python `tts_engine/emotion_router.py`——情绪前缀解析（5 档）、参考音频匹配、本地 GPT-SoVITS 优先 + 云端降级（`degraded` 如实上报）、口型包络生成（viseme 序列 + 连续时间锚点 + 标点闭口停顿）、可插拔 `TtsBackend` 接口（真实 torch 推理后续接入，stub 同接口）；新增 `/tts/emotion` 与 `/tts/voice-pack` 端点；宿主侧 `tts-router.ts`——情绪→桌宠动作映射、参考音频选择、语音租约组装（ttl=时长+3000）、口型时间线采样，并接入 pet-stage 编排（语音锁 + 动作切换 + 口型驱动）。
- **T-M2-01 ✅ Python 音频 Sidecar 骨架与单端语音锁**（含覆盖率加固：全局分支 89.74% → 92.14%，补 13 项边界用例并删除 3 处契约不可达死分支）：`services/audio-ai-worker`（uv/Python 3.11 + FastAPI + WebSocket）——`/health` 硬件后端探测（mps/cuda/cpu，torch 可用时以其为准）、`/tts/synthesize` 确定性 WAV stub（同参同输出，供缓存语义）、`/ws/audio` JSON-RPC 通道（ping/speak + 四类错误码）；宿主侧 `AudioLeaseManager`——单端互斥（active≤1 不变式）、播放完成回执驱动生命周期、P0 抢占（INTERRUPTED_BY_P0）、TTL 强制释放（TTL_EXPIRED）、设备错误（AUDIO_DEVICE_ERROR）、队列 P0 优先+同级 FIFO、回执出站经 `AudioPlaybackReceiptSchema` 契约校验。
- **T-M1-05 ✅ 桌面舞台 UI 挂件与中控台模型配置页（M1 收官）**：pet-stage 双轨气泡（`<think>` 云朵半透明/正式对话，`computeBubbleLayout` 布局纯函数保证不重叠）+ 赛博饭碗挂件（15% 饥饿线 🥣 饿瘪态）；director 中控台——React 19 + Tailwind v4（esbuild 打包免 vite）三套餐胶囊一键切换写 Dexie `activeDiningProfile`（刷新持久恢复）、Magpie 六槽位绑定、CC Switch 风格供应商预设卡（Region/Plan 胶囊+掩码 Key）；E2E 真实 Electron 双窗口验证（几何不重叠+截图留证 artifacts/ + Dexie 键值+刷新恢复）。**M1 全部 5 张工单 DONE。**
- **T-M1-04 ✅ 「大肥鱼」三层人格引擎 persona-brain**：第 1 层系统提示模板填充（{name}/{title}/{owner}/{riceRatio}）；第 2 层 `<think>` 流式剥离（分块跨标签悬挂安全、未闭合兜底、跑题碎碎念 derailmentProbability）+ 情绪五档前缀解析（[傲娇反驳]→tsundere_refuse 等，供 T-M2-02 TTS 路由）；第 3 层雷区反射钩子（正则先行、命中即 `P0_INTERRUPT`、冷却窗口、加权预设台词直出 → 结构性不消耗主脑 Token；装载期正则编译防 ReDoS）；赛博饭碗经济（1粒米=1Token、15% 饥饿线 → hungry_lazy、下饭菜 Buff 过期/×2 热情/深度推理解锁）。
- **T-M1-03 ✅ 模型与供应商网关 model-gateway**：内置 9 家供应商预设（CC Switch 两步式思想重写：Region/Plan 胶囊 + Full URL 免拼接）；Magpie 思想 6 槽位绑定 + 干饭套餐切换（switchProfile 清粘性态）；粘性路由三策略（Prompt Cache 粘住 / 轮询 / 最快节点）；隐私脱敏（本机用户名/homeDir/绝对路径 POSIX+Windows/sk-/ghp_/AKIA/Bearer/明文 apiKey → `{{MASKED}}`，残留 0 断言）；429/5xx/401/403/网络错误 100ms 内静默 failover（400 请求级即抛）、回执仅由真实 HTTP 响应构建、usage 只记供应商实报字段（prompt/completion/prompt_cache_hit_tokens）。
- **T-M1-02 ✅ Electron 跨平台透明穿透宿主 desktop-host**：主进程（transparent/frameless/alwaysOnTop/skipTaskbar 透明桌宠窗 + passthrough/drag/screen IPC，坐标全 DIP 多屏合并 workArea 夹紧）；渲染层 pet-stage（WebmVideoRenderer 装配 + 50ms 离屏 1x1 Canvas alpha 采样状态机（仅翻转过 IPC）+ 拖拽测速→重力/边界反弹/落定冲击→Q 弹联动）；preload contextBridge（forceAlpha/onTestAlpha 测试钩子由 `PET_STAGE_E2E=1` 门控）；esbuild 构建编排（main ESM / preload CJS / stage IIFE）；playwright-core E2E 真实 Electron 验证（踩坑：透明后台窗 rAF 节流致 waitForFunction 假超时 → evaluate 轮询；`webContents.send` 仅 preload 可收 → 桥中继 CustomEvent）。
- **T-M1-01 ✅ 可插拔桌宠渲染引擎 pet-renderer**：契约先行——`PetAvatarManifest/PetAvatarClip` 进 shared-protocol（17→19 域，跨语言 Schema 重生成）；`IPetAvatarRenderer` 接口 + `WebmVideoRenderer`（双 video 交叉淡入零黑帧时序、脚底基准线 `computeFootlineLayout`、Q 弹 `squashAt` 阻尼振荡+体积守恒、`DEV_ONLY_NON_COMMERCIAL` 素材自动挂 [DEV-ASSET-ONLY] 水印徽标+署名）；`VideoFactory/RendererHost` 注入隔离 DOM（无头可测，真实 DOM 工厂归 T-M1-02 desktop-host）。
- **T-M0-04 ✅ AI 自测沙盒 mock-harness**：`stardew-mcp-simulator`（JSON-RPC 2.0 over WS，5 剧本确定性回放 + 动作互斥锁 + 0.1s 接管中止 + 回执出站契约校验）、`danmaku-storm-replay`（种子伪随机确定性生成、1000 条风暴 100% 过 NormalizedLiveEventSchema、雷区/点歌/Prompt 注入/连击/进房夹具）、`license-scanner.mjs`（台账+密钥+UNLICENSED+GPL-3.0 传染源，接管 Gate 2，自测 spec 对临时 fixture 实测报错）。
- **T-M0-03 ✅ 本地存储双引擎底座**：新增 `packages/local-store`——主进程 SQLite（`better-sqlite3` WAL：常客记仇/好感账本、Token 流水（1 粒米=1 Token 按槽位汇总）、点歌缓存索引、meta；`deleteViewer/wipeAllViewers/wipeAllData` 隐私一键擦除）+ 渲染进程 Dexie 配置库（`./dexie` 子路径隔离两端）；Gate 3 覆盖率 ≥90% 硬门槛生效（实测四维 100%）；新增 depcruise 规则 `local-store-runtime-only-storage`。
- **T-M0-02 ✅ 全局契约包与跨语言导出器**：`src/registry.ts` 契约注册表（17 域 + `CONTRACT_VERSION`）；`pnpm gen:contracts`（Zod → JSON Schema ×17 + workbench 合并视图 → Pydantic `protocol_models.py`，`$defs` 漂移即报错、`--use-annotated`/`--disable-timestamp` 确定性输出）；TS 契约单测 11 项 + Python 夹具回放 4 项（同一 fixture 双侧 probe）；Gate 3 接线（vitest + pytest）；Gate 1 增补 Python ruff + mypy --strict（生成物 assignment 豁免记录于 mypy.ini）。
- **T-M0-01 ✅ Monorepo 脚手架与架构边界锁**：`.dependency-cruiser.cjs` 六条机器边界规则（no-circular / shared-protocol 零依赖 / 运行时仅 zod / 渲染进程禁 SQLite / pet-renderer 禁跨层 / mock-harness 仅依赖契约）；`pnpm lint:deps` 接入 Gate 1；pre-commit 经 `core.hooksPath=.githooks` 强制 `verify:gate`。验证：临时探针（import `ws`）实测违规自动报错后恢复全绿。
- **9 份 `docs/REFERENCE-*.md` 复评档案**（基于 9 个真实仓库的第一轮复评：GitHub API 元数据 + LICENSE 原文 + README 全文 + 顶层结构，未逐行审计源码）：dsh-pet、dsh-stardew-blind-whale-farmer、dsh-douyin-agent（新增）、dsh-livestream（新增）、dsh-live-studio（新增）、dsh-live（新增，拉黑档案）、Dsh_douyin、dsh-video-storyboard、feiyu-os。
- 每份档案含：结论摘要 / 采用什么 / 不采用什么（为什么）/ 验证路径与回退 / 复评记录。

### Changed

- **docs/REFERENCES.md**：全部按真实仓库重写——许可证结论核实为：dsh-pet（代码 MIT / 大肥鱼形象与素材 CC BY-NC-SA 4.0）、BlindWhaleFarmer（**MIT**，原"待核实"解除）、dsh-douyin-agent（MIT）、dsh-video-storyboard（Apache-2.0）、dsh-livestream（代码 MIT / 素材 CC BY-NC-SA）、dsh-live-studio（MIT）、feiyu-os（代码 MIT / 文档 CC-BY-4.0）、Dsh_douyin（None + 内嵌 GPL-3.0 vendor）、dsh-live（None + 自述模拟指标）。
- **docs/THIRD_PARTY_NOTICES.md**：§2 按真实许可证重写；新增 `cortico-world-douyin-live`（GPL-3.0，⛔ 禁止 vendor 引入）条目；dyhub / CC Switch / Magpie / awesome-codex-pet 未提供仓库，保持"仅思想参考"。
- **AGENTS.md §2.2 许可证洁癖**：补充 GPL-3.0 传染红线、CC BY-NC-SA 4.0 素材精确化、Apache-2.0 NOTICE 要求。

### Security

- Gate 2 黑名单依据更新：`Dsh_douyin` / `dsh-live` 均确认 license=None；新增 GPL-3.0 传染禁令。

## [0.1.0] - 2026-11-15

### Added（项目奠基）

- **Monorepo 骨架**：pnpm workspace（`packages/*`、`apps/*`、`services/*`、`tools/*`）+ 严格 TS 基线（`strict` + `noUncheckedIndexedAccess`）；`mods/` 为 C# 不纳入 pnpm。
- **docs/SPEC.md**：《AI 桌宠与虚拟主播工作台》产品需求与技术架构总纲——4 项冻结决策（WS+JSON-RPC 2.0 总线 `18760` / Dexie+SQLite 双引擎 / OBS Browser Source `18765` 优先 / `uv` Python 3.11 硬件自适应）、六大模块详设、M0~M4 里程碑验收表。
- **AGENTS.md**：AI 自治开发最高宪章——五层铁笼（契约先行 / 仿真沙盒 / 四道门禁 / 防失忆工单流 / 运行时安全锁）、原子工单工作流、许可证硬性红线、主题复评速查表。
- **docs/ROADMAP.md**：M0~M4 共 20 张原子工单冻结清单，当前激活 `T-M0-01`；注明人工预置范围（T-M0-01 / T-M0-02 剩余工作）。
- **docs/VERIFY.md**：验收矩阵，强制分栏「Mock/沙盒已通过」与「待人类真机验收」。
- **docs/REFERENCES.md**：13 个开源参考项目清单、复评纪律与硬性红线（UNLICENSED 项目拉黑）。
- **docs/REFERENCE-*.md**：5 篇复评档案占位（dsh-pet / BlindWhaleFarmer / dsh-douyin / dsh-video-storyboard / feiyu-os）。
- **docs/THIRD_PARTY_NOTICES.md**：第三方许可证台账（含 dsh-pet 素材 `DEV_ONLY_NON_COMMERCIAL` 标记）。
- **packages/shared-protocol**：全局 Zod 契约初稿（桌宠渲染与语音锁 / 大肥鱼人格与赛博饭碗 / 模型网关与干饭套餐 / 星露谷 MCP 真实回执 / 直播事件总线五域）。
- **tools/scripts/verify-gate.mjs**：`pnpm verify:gate` 门禁编排器——Gate 1（tsc）与 Gate 2（许可证台账 + 密钥/禁源扫描）已接线，Gate 3/4 待 T-M0-03 / T-M0-04 接入。
- **Git 仓库初始化**（main 分支）。

### Security

- Gate 2 内置扫描：硬编码密钥特征（`sk-` / `ghp_` / `AKIA` / 明文 apiKey 赋值）与 UNLICENSED 项目源码痕迹（`fore-vip/dsh-live`、`newbeejmc/Dsh_douyin`）。

### Added（V2-P3-03c 真实 OS 输入注入接线，2026-11-26）

- **macOS CGEvent 真实注入**：自研 `tools/native/macos-input-helper.swift`（CoreGraphics 官方 API：permission/move/click/type/key/scroll 六类白名单动作，未授权 exit 3），宿主 `native-input-helper.ts` 按源码 SHA-256 版本化编译缓存（仅 `WHALE_ENABLE_OS_INPUT=1` 时编译，不拖慢默认启动），作为 `nativeInjector` 接入 `ComputerInputExecutor`；spawnSync 参数数组调用不走 shell，杜绝命令注入。
- **`[E2E-HOST]` 真实注入回归** `input-injection.e2e.spec.ts`：装配 → 租约 → 真实移动鼠标 → 指针读回精确落位 → 合成事件不误伤租约；无辅助功能权限环境自动断言 `permission_denied` fail-closed 路径。
- **真机验证结论**：Electron 开发进程 TCC 已授权（granted），live 模式注入通过；`V2-P2-06` 同日完成 `[REAL-DEVICE]` 游戏内像素形象目视核验；`V2-P3-03` 转 `DONE`（macOS 打包态 TCC 与 Windows SendInput 为后续发布工程项）。
