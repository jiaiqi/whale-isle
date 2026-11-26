# CURRENT — V2 跨会话唯一交接检查点

> 任何新 AI 会话接手前只看本文件与 [ROADMAP.md](./ROADMAP.md)，严禁依赖对话历史猜测进度。每次完成或阻塞工单时必须同步更新。

## 1. 当前进度锚点

- **当前分支**：`feat/whale-isle-v2`（已发布并推送至 `origin/feat/whale-isle-v2`；已完成 P0 & P1、P2 全部 8 单、`V2-P3-01`、`ADR-003` Tidepaper 主视觉升级、`V2-P3-02`、**`V2-P3-03`**，并已合入 `feat/stardew-launcher`（`V2-P3-06` 一键启动器）与 `feat/tidepaper-v3.1`（Tidepaper v3.1 外壳 + 空状态插画））
- **上一已完成/交接工单**：`V2-P3-01` **真机补验**（统一表演系统；状态维持 `IMPLEMENTED_UNVERIFIED`——缺合法 `.moc3`/`.vrm` 与歌声后端权重，已列清单待 owner 提供）
- **当前唯一激活工单**：无（`V2-P3-04` Digital Life L1 已以 `IMPLEMENTED_UNVERIFIED` 封口，A–F 六子单全绿，证据 [P3-04-social-life-verification.md](./evidence/P3-04-social-life-verification.md)；2026-11-26 真机验收：`V2-P2-06`、`V2-P3-03`（3c 真实 CGEvent 注入接线）、`V2-P3-06`（中控台「启动」按钮真实点击）已转 `DONE`，`V2-P3-01` 完成真机补验但仍为 `IMPLEMENTED_UNVERIFIED`；下一候选 `V2-P3-05` 多被动桌宠同屏，或继续清真机验收积压 `V2-P2-08` / `V2-P3-02`）
- **同步 UI/设计基准约束（`ADR-003`）**：已上线 `design/tidepaper/` 默认主题令牌（`tidepaper` + 晨雾/夜潮 + 5 强调色），并在顶栏提供 `obsidian-tide` / `tide-deep` 实时切换及 `V2-P2`/`V2-P3-01`/`V2-P3-02`/`V2-P3-03` 实盘面板（[P3-tidepaper-ui-verification.md](./evidence/P3-tidepaper-ui-verification.md)）。
- **输入抢占口径（`ADR-004`）**：`ComputerUseLease` 只管 OS 合成输入/前台桌面控制；用户物理输入撤销它。`GameCharacterControlLease` 不受普通键鼠影响，只认 F7/UI 开关/P0 急停（T-M6-73）。P0 急停同时撤销两者。
- **本地客户端常驻约定**：用户要求每次完成任务后保持本地桌面端运行（`pnpm --filter @workbench/desktop-host start`）以便随时测试；推进新工单重新构建后务必保持客户端处于运行状态。

## 2. 本次 `V2-P3-01` 真机补验实际交付与验证证据

- **新增 `services/sing-worker/`**（FastAPI，端口 18880）：只转发到显式配置的 `WHALE_SING_SVS_ENDPOINT` / `WHALE_SING_SVC_ENDPOINT`；普通 TTS 单列 `ttsClone` 能力位并强制带「普通 TTS 不得当作 SVS/SVC 使用」告警；后端缺失 → 501 + 具体原因，**不返回任何伪造音频**；`neuralVerified` 仅在真实后端真返回音频时才置 `true`。
- **修复探测造假** [v2-kernel-host.ts](../../apps/desktop-host/src/main/v2-kernel-host.ts)：`new SingEngine()` **从未传 `workerEndpoint`**（原实现 `probeBackends` 必然返回 svs/svc 双 unavailable，探测形同虚设），现由 `WHALE_SING_WORKER` 显式注入。
- **探测明细回传** [performance.ts](../../packages/voice-runtime/src/performance.ts)：`probeBackends` 回传后端 `detail`（「Worker 在线但 SVS 能力未就绪：未配置 svs 后端…」），`realNeuralInferenceVerified` 严格取 Worker 回执，缺失即不置真。
- **度量工具** [measure-lyrics-clock-drift.mts](../../tools/scripts/measure-lyrics-clock-drift.mts)：真实墙钟 `process.hrtime.bigint` 25ms 采样驱动 `LyricsClockSync`，输出每行高亮偏差 JSON。
- **真机证据**（`[REAL-DEVICE]`，详见 [P3-performance-stage-verification.md](./evidence/P3-performance-stage-verification.md) 第 3 节）：三层探测 `Electron → sing-worker(18880) → GPT-SoVITS(9880)` 真实跑通；歌词时钟 max 偏差 **25ms** / P95 25ms（容差 60ms，4/4 命中）；跨 `live2d/vrm-3d/obs-stage/desktop-2d` 状态 `retained=true`（歌词行/口型/表情/舞蹈动作全保）；pet-stage 实为 WebM 双 `<video>` 渲染（0 canvas、60.4 FPS、P95 18.3ms、0 丢帧）；GPT-SoVITS 真实推理 HTTP 200 / 1.01s / 32000Hz / 2580ms（**属 TTS 非唱歌**，故不置真）。
- **门禁与单测**：`pnpm verify:gate` **7/7 PASS**；`performance.spec.ts` **5/5 PASS**（新增明细回传与 `neuralVerified` 门禁两例）；`services/sing-worker/test_sing_worker.py` **4/4 PASS**（无后端时 501 且不含 `audioBase64`）。
- **为什么不是 `DONE`**：本机**无合法 `.moc3` / `.vrm` 资产**（Live2D/VRM 画布目视无从谈起）、**无歌声合成（SVS）与音色转换（SVC）后端**（GPT-SoVITS 是 TTS 音色克隆，不能冒充唱歌）、情绪参考音频**真实五组全缺**（现有 `design_sweet_normal.wav` 已证实是合成 stub，不是真人声）、点歌台管线**已落地并接通宿主 IPC**（`v2:song-*` 五路，见 [P3-song-console-host-verification.md](./evidence/P3-song-console-host-verification.md)，但无 Demucs/RVC/曲库，分离·转换·首片播放未实测）。SVS/SVC 可部署候选与四层许可已核实（[O5-svs-svc-backend-research.md](./evidence/O5-svs-svc-backend-research.md)：SVS 首选 OpenVPI DiffSinger + OpenUtau，SVC 首选 RVC MIT 分支；官方 OpenCpop 检查点与 OpenVPI 声码器非商用、RMVPE 上游无 LICENSE，AGPL/GPL 分支禁入主线）。清单已报 owner，状态维持 `IMPLEMENTED_UNVERIFIED`。
- **历史交接**（`V2-P3-03`，已转 `DONE`）：受控 Browser Use 与 Computer Use，真实 CGEvent 注入经 3c 自研 Swift helper 接线并真机验证（指针精确落位、合成事件不误伤租约），证据 [P3-browser-computer-use-verification.md](./evidence/P3-browser-computer-use-verification.md)。

## 3. 下一步行动（Next Agent 从这里接手）

1. **真机验收积压清理中**：`V2-P2-06`、`V2-P3-03`（3c 真实注入接线）、`V2-P3-06`（中控台「启动」真实点击）已于 2026-11-26 转 `DONE`；`V2-P3-01` 真机补验已完成能自动的部分并维持 `IMPLEMENTED_UNVERIFIED`（缺合法 `.moc3`/`.vrm`、SVS/SVC 后端权重与索引、4 组情绪参考音频，已列清单报 owner）；`V2-P1-06` / `V2-P2-01` 仍只需要星露谷 + SMAPI（本机已具备），按 [REAL-DEVICE-CHECKLIST.md](./evidence/REAL-DEVICE-CHECKLIST.md) 执行；剩余 `V2-P2-08`（双端联机）与 `V2-P3-02`（真实开播）待排；`V2-P3-02` 的 **OBS 本地闭环已实测**（obs-websocket 5.7.6 真实握手 + 测试场景 + overlay 画面变化 + 音频电平，见 [P3-02-obs-local-closure-verification.md](./evidence/P3-02-obs-local-closure-verification.md)），发现本机 OBS 浏览器源硬件加速开启时全黑、关闭正常（已还原设置），真实开播仍待平台账号与授权。
2. **P3-06 遗留两个真实缺陷**：① 启动后 BWF 就绪竞态——**已修**（2026-11-26）：`AutodriveRunner.start()` 新增 `readyTimeoutMs`/`readyPollMs` 可注入就绪重探，等待期发 `watchdog/heartbeat` 事件说明「第 N 次重探」，宿主 `autodrive-host.ts` 注入 90s 窗口 + 2s 间隔；等待中 `stop()` 安静取消而不误报「MCP 不可达」；默认 `readyTimeoutMs=0` 保持旧行为，原有单 ping 失败即抛错的老用例继续通过；新增单测 3 例（重探后成功 / 窗口耗尽仍抛错 / 等待中取消），`[SIMULATION]` 级，**真机冷启动等待表现待复验**；② CGEvent 点击依赖窗口真正处于系统前台（建议改用 AXPress 走辅助功能 API，不依赖焦点）——**未修**，属单桌宠链路待办。
3. **点歌台中控台面板已接入**（2026-11-26，`[E2E-HOST]`）：`点歌台` 页签展示四个原子能力真实状态、提交/取消点歌与真实播放回执，缺后端时如实 `unavailable`/`rejected`；证据见 [P3-song-console-host-verification.md](./evidence/P3-song-console-host-verification.md) 第 6 节。`positionMs` ↔ 真实播放头已闭合：`tools/native/macos-audio-helper.swift`（AVAudioPlayer）每 100ms 回报 `currentTime` 驱动 `tickClock`，不可用时回退 `afplay` 并如实标 `realPlayhead=false`（见同文档第 7 节）。
4. **`V2-P2-09`（farmhand 联机与分屏，owner 暂缓）**：**owner 决策（2026-11-26）：「先不做分屏功能，先把一个桌宠的功能走通」**——`V2-P2-09` 整体与 `V2-P2-09D` 一起按下（D 记 `PENDING` + 「owner 暂缓，等单桌宠走通后再启动」，不再挂「等 cabin + 手柄前置」理由）；已交付的 A（契约）、B（XDG 隔离启动）、C（宿主联机身份绑定）、E（按屏接管 + 在飞动作中止回执）、F（分屏沙盒剧本骨架）保留在 `feat/whale-isle-v2` 不回滚，均 `IMPLEMENTED_UNVERIFIED`，其中 E/F 的真机项仍 `BLOCKED`，不得用沙盒通过冒充真机。勘察见 [P2-09-farmhand-split-screen-audit.md](./evidence/P2-09-farmhand-split-screen-audit.md)。
5. 认领 **`V2-P3-05`（多被动桌宠同屏）** 或下一个候选工单：查阅 `docs/v2/blueprint/` 对应蓝图、[REQUIREMENTS.md](./REQUIREMENTS.md)、[ADR-004](./adr/ADR-004-input-preemption-scope.md)；禁止接入任何打码/验证码绕过服务，网页内容一律按数据处理。
6. 每次完成任务后同步提交、推送分支，并确认本地桌面端处于运行状态。

## 4. 2026-11-26 合流记录（两条支线已回流主线）

- **`feat/stardew-launcher` → V2**（合并提交 `19f2258`）：`V2-P3-06` 一键启动器 + `game-health` 「标题画面误判 online」真实缺陷修复；真机证据 [P3-stardew-launcher-verification.md](./evidence/P3-stardew-launcher-verification.md)。
- **`feat/tidepaper-v3.1` → V2**（合并提交 `0878d91`）：Tidepaper v3.1 外壳、三层租约 HUD 与急停横幅、中控台 IA 重组；补完空状态插画接入（对话 / 游戏回执 / 未开播 / 记忆无命中 / 急停）与 `buildComputerLeaseView()` 五态映射。
- 合并后 `pnpm verify:gate` **7/7 PASS**，`ui.e2e` **9/9**、`v2-obsidian-ui.e2e` **1/1** PASS。
- 合并期间发现的环境坑：`-launch` worktree 残留的 Electron 占着 `e2e-profile` 的 LevelDB 锁，会让 `ui.e2e` 的服务商页用例超时假失败；跑 E2E 前先 `pgrep -f e2e-profile` 清理。

## 5. 单桌宠链路优先（owner 决策 2026-11-26）

> owner 原话：「先不做分屏功能，先把一个桌宠的功能走通」。分屏线（`V2-P2-09` A–F）整体按下、成果不回滚；`V2-P3-05` 多被动桌宠同屏也随之排到单桌宠走通之后。

**实现侧可不等 owner 推进的缺口（按优先级）**：

| # | 缺口 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | P3-06 缺陷① BWF 就绪竞态 | ✅ 已修（本日） | `readyTimeoutMs`/`readyPollMs` 就绪重探 + `stop()` 安静取消；单测 3 例 `[SIMULATION]`，真机冷启动待复验 |
| 2 | P3-06 缺陷② CGEvent 点击依赖前台窗口 | 降级为验收基建（不影响产品链路） | 该缺陷只影响「自动验收脚本用坐标点自家按钮」，产品里按钮由人点。真解需要 `AXUIElementCopyElementAtPosition` **按目标 pid 作用域**命中（而不是 systemWide，后者仍会被遮挡窗吃掉）+ `kAXPressAction`，但这套能力在通用坐标点击路径上没有合法生产者（`ComputerInputStep` 不带 pid），硬接会变成死代码；建议验收脚本侧先 `bringToFront` 保证前台，或等真有「按元素点击」需求时单立工单 |
| 3 | P3-04E 遗留：scheduler tick 自动发起社交会话的循环 | 待做（属产品增强，需先定自治口径） | 当前只有手动/事件驱动；接确定性 tick 循环不难，但「多久自动发起、预算多少、急停怎么算」是 owner 可感知的自治行为，建议先出方案再实现，避免替 owner 定产品口径 |
| 4 | 单桌宠全链路单一剧本 E2E | ✅ 已落地（`[E2E-HOST]`+`[SIMULATION]`） | 宿主 `PET_STAGE_E2E` 下可用 `WHALE_E2E_BWF_ENDPOINT` 指向仿真 BWF（`resolveBwfEndpoint()`，生产恒回落真实端口）；`single-pet-chain.e2e.spec.ts` 串起「启动 → 就绪 → 规则动作 → 三态回执 → 记忆可检索」，6.2s 通过并已进 macOS CI。未覆盖：LLM 大脑同链路、语音锁释放与气泡投影（气泡归 item 7） |

**必须等 owner 的（不自行推进）**：

- item 5 歌声：音色来源与权重授权未给书面许可前，不下载/不集成任何歌声权重，不生成可分发合成样本；「中文产品音色无符合项」结论不变。
- item 4 `V2-P3-02` 真实开播：等 owner 完成 obs-websocket 密码 / 屏幕录制授权 / D 路径首次弹窗三步；obs-websocket 密码是 owner 凭据，不代开、不代改。
- `V2-P3-01` 视觉：缺合法 `.moc3`/`.vrm` 与情绪参考音频。
- 表现力语音（item 10）：方案已出、**未实现、未下载任何权重**，见 [docs/design/expressive-voice-plan.md](../design/expressive-voice-plan.md)；等 owner 拍三件事（CosyVoice2 最小集 ≈4.07 GB 下载批准 / 首装 ≈6 GB 体积口径 / 原创音色走「本地随机嵌入」还是「一次性云端 voice design」）。
