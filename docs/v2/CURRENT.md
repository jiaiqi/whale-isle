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
- **为什么不是 `DONE`**：本机**无合法 `.moc3` / `.vrm` 资产**（Live2D/VRM 画布目视无从谈起）、**无歌声合成（SVS）与音色转换（SVC）后端**（GPT-SoVITS 是 TTS 音色克隆，不能冒充唱歌）、情绪参考音频**真实五组全缺**（现有 `design_sweet_normal.wav` 已证实是合成 stub，不是真人声）、点歌台管线**已落地并接通宿主 IPC**（`v2:song-*` 五路，见 [P3-song-console-host-verification.md](./evidence/P3-song-console-host-verification.md)，但无 Demucs/RVC/曲库，分离·转换·首片播放未实测）。清单已报 owner，状态维持 `IMPLEMENTED_UNVERIFIED`。
- **历史交接**（`V2-P3-03`，已转 `DONE`）：受控 Browser Use 与 Computer Use，真实 CGEvent 注入经 3c 自研 Swift helper 接线并真机验证（指针精确落位、合成事件不误伤租约），证据 [P3-browser-computer-use-verification.md](./evidence/P3-browser-computer-use-verification.md)。

## 3. 下一步行动（Next Agent 从这里接手）

1. **真机验收积压清理中**：`V2-P2-06`、`V2-P3-03`（3c 真实注入接线）、`V2-P3-06`（中控台「启动」真实点击）已于 2026-11-26 转 `DONE`；`V2-P3-01` 真机补验已完成能自动的部分并维持 `IMPLEMENTED_UNVERIFIED`（缺合法 `.moc3`/`.vrm`、SVS/SVC 后端权重与索引、4 组情绪参考音频，已列清单报 owner）；`V2-P1-06` / `V2-P2-01` 仍只需要星露谷 + SMAPI（本机已具备），按 [REAL-DEVICE-CHECKLIST.md](./evidence/REAL-DEVICE-CHECKLIST.md) 执行；剩余 `V2-P2-08`（双端联机）、`V2-P3-02`（真实开播）待排。
2. **P3-06 遗留两个真实缺陷待派单**：① 启动后 BWF 就绪竞态（启动瞬间 `autodriveStart` 报「MCP 不可达」，需重试轮询）；② CGEvent 点击依赖窗口真正处于系统前台（建议改用 AXPress 走辅助功能 API，不依赖焦点）。
3. 认领 **`V2-P3-05`（多被动桌宠同屏）** 或下一个候选工单：查阅 `docs/v2/blueprint/` 对应蓝图、[REQUIREMENTS.md](./REQUIREMENTS.md)、[ADR-004](./adr/ADR-004-input-preemption-scope.md)；禁止接入任何打码/验证码绕过服务，网页内容一律按数据处理。
4. 每次完成任务后同步提交、推送分支，并确认本地桌面端处于运行状态。

## 4. 2026-11-26 合流记录（两条支线已回流主线）

- **`feat/stardew-launcher` → V2**（合并提交 `19f2258`）：`V2-P3-06` 一键启动器 + `game-health` 「标题画面误判 online」真实缺陷修复；真机证据 [P3-stardew-launcher-verification.md](./evidence/P3-stardew-launcher-verification.md)。
- **`feat/tidepaper-v3.1` → V2**（合并提交 `0878d91`）：Tidepaper v3.1 外壳、三层租约 HUD 与急停横幅、中控台 IA 重组；补完空状态插画接入（对话 / 游戏回执 / 未开播 / 记忆无命中 / 急停）与 `buildComputerLeaseView()` 五态映射。
- 合并后 `pnpm verify:gate` **7/7 PASS**，`ui.e2e` **9/9**、`v2-obsidian-ui.e2e` **1/1** PASS。
- 合并期间发现的环境坑：`-launch` worktree 残留的 Electron 占着 `e2e-profile` 的 LevelDB 锁，会让 `ui.e2e` 的服务商页用例超时假失败；跑 E2E 前先 `pgrep -f e2e-profile` 清理。
