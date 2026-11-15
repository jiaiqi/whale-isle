# ROADMAP — 冻结的阶段迭代计划与工单状态

> **工单状态机**：`NEXT`（当前唯一激活）→ `DOING` → `DONE`（verify:gate 全绿 + 文档同步完成）/ `BLOCKED`。
> **铁律**：任何时刻只能有一个 `NEXT` 工单，严禁跨工单抢跑；单工单修改业务源码文件 ≤ 8 个（详见 [AGENTS.md](../AGENTS.md) §2）。
>
> **当前激活工单：`T-M2-02`（M2「本地语音与点歌」进行中）**

> ⚠️ **预置说明（2026-11-15）**：仓库骨架（pnpm workspace / tsconfig / .gitignore）、docs 全套文档与 `shared-protocol` Zod 契约初稿由人工会话预先落盘。
> - `T-M0-01` ✅ 已完成（2026-11-15）：dependency-cruiser 架构边界、pre-commit（`core.hooksPath=.githooks`）、`lint:deps` 接入；
> - `T-M0-02` ✅ 已完成（2026-11-15）：`src/registry.ts` 契约注册表 + `pnpm gen:contracts` 导出器（Zod → 17 份 JSON Schema + workbench 合并视图 → Pydantic `protocol_models.py`）+ TS/Python 双侧夹具单测。
> - `T-M0-03` ✅ 已完成（2026-11-15）：`packages/local-store` 双引擎底座（SQLite 常客账本/Token 流水/点歌缓存 + 一键擦除；Dexie 中控台配置库），覆盖率纳入 Gate 3 ≥90% 门槛。
> - `T-M0-04` ✅ 已完成（2026-11-15）：`tools/mock-harness` 三仿真器落地（stardew-mcp-simulator 5 剧本 / danmaku-storm-replay 确定性风暴 / license-scanner 接管 Gate 2）。**M0 全部 4 张工单 DONE，Gate 4（全链路 E2E）按设计待 M1/M2 宿主与音频服务就绪后接线。**
> - `T-M1-01` ✅ 已完成（2026-11-15）：`PetAvatarManifest/PetAvatarClip` 契约进 shared-protocol（跨语言重生成）；`packages/pet-renderer` 落地 `WebmVideoRenderer`（双 video 零黑帧交叉淡入 / 脚底基准线 / Q 弹 / DEV 素材水印），VideoFactory/RendererHost 注入式无头可测。
> - `T-M1-02` ✅ 已完成（2026-11-15）：`apps/desktop-host` 落地（transparent+frameless+alwaysOnTop+skipTaskbar、50ms 1x1 Canvas alpha 穿透状态机（仅翻转过 IPC）、拖拽甩抛物理+落地 Q 弹、多屏合并 workArea 夹紧、PET_STAGE_E2E 门控测试钩子）；playwright-core E2E 真实 Electron 验证通过（rAF 节流坑：透明后台窗 waitForFunction 假超时，改 evaluate 轮询）。
> - `T-M1-03` ✅ 已完成（2026-11-15）：`packages/model-gateway` 落地——CC Switch 两步式预设库（9 家）/Region/Plan 胶囊/Full URL 免拼接 + Magpie 6 槽位绑定与干饭套餐切换 + 粘性路由（PROMPT_CACHE_STICKY/ROUND_ROBIN/LOWEST_LATENCY）+ 隐私脱敏（路径/密钥/用户名 → {{MASKED}}）+ 429/5xx/网络错误 100ms 内静默 failover（400 即抛）+ usage 仅记供应商实报。
> - `T-M1-04` ✅ 已完成（2026-11-15）：`packages/persona-brain` 落地三层人格引擎——第 1 层系统提示模板填充、第 2 层 `<think>` 流式剥离（跨块悬挂安全/未闭合兜底/跑题碎碎念）+ 情绪五档前缀解析、第 3 层雷区反射钩子（装载期正则编译防 ReDoS/冷却窗口/预设台词直出结构性不烧主脑）+ 赛博饭碗经济（1粒米=1Token/15% 饥饿线/hungry_lazy/下饭菜 Buff 过期×2 热情）。
> - `T-M1-05` ✅ 已完成（2026-11-15）：pet-stage 双轨气泡（云朵半透明 `<think>` / 正式对话）+ 赛博饭碗挂件（布局纯函数保证不重叠）+ `[DEV-ASSET-ONLY]` 水印署名；director 中控台（React 19 + Tailwind v4，esbuild 打包）——三套餐胶囊一键切换写 Dexie `activeDiningProfile` 刷新持久恢复、六槽位绑定、供应商预设卡。**M1 全部 5 张工单 DONE。**
> - `T-M2-01` ✅ 已完成（2026-11-15）：Python Sidecar 骨架（`services/audio-ai-worker`：uv 管理 Python 3.11 + FastAPI + WebSocket；`/health` 硬件后端探测 mps/cuda/cpu、`/tts/synthesize` 确定性 WAV stub、`/ws/audio` JSON-RPC 通道）+ 宿主侧 `AudioLeaseManager` 单端语音锁（dsh-pet 已核实机制工程化：单端互斥 active≤1 不变式、播放完成回执驱动、P0 抢占 INTERRUPTED_BY_P0、TTL 强制释放 TTL_EXPIRED、失败 AUDIO_DEVICE_ERROR、队列 P0 优先+同级 FIFO）；REFERENCE-dsh-pet 的 TTL 语音锁待核实项已核实并回写档案。

## 工单总表（M0~M4 · 20 张原子工单）

| 工单编号 | 所属里程碑 | 工单名称与核心交付物（单工单 ≤ 8 个文件） | 开工前必查参考项目 | 自动化门禁校验指令与断言（Gate） | 状态 |
| --- | --- | --- | --- | --- | --- |
| **`T-M0-01`** | M0：地基与铁笼 | **Monorepo 脚手架与架构边界锁**：完善 `pnpm-workspace.yaml`、`tsconfig.base.json`、`dependency-cruiser` 规则与 `docs/` 骨架 | `feiyu-os`（确定性准入） | `pnpm verify:gate` 基础框架跑通，违规跨包引用自动报错 | **DONE** |
| **`T-M0-02`** | M0：地基与铁笼 | **全局契约包 `shared-protocol` 与跨语言导出器**：落地 Zod 契约，并生成 JSON Schema 与 Python Pydantic 模型 `protocol_models.py` | `dsh-livestream`、`BlindWhaleFarmer` | 契约单测 100% 通过；生成的 Python 模型通过 `mypy` 严格校验 | **DONE** |
| **`T-M0-03`** | M0：地基与铁笼 | **本地存储双引擎底座**：实现主进程 SQLite（常客账本、Token 流水、点歌缓存表）与渲染进程 Dexie.js 配置库封装 | `dsh-live-studio`、`dsh-pet` | 内存 SQLite 单元测试验证：常客记仇标签读写、记忆一键删除（隐私合规）通过 | **DONE** |
| **`T-M0-04`** | M0：地基与铁笼 | **AI 自测仿真沙盒 `tools/mock-harness`**：编写星露谷 MCP 模拟器（5 大剧本）、抖音弹幕风暴回放器与许可证扫描器 | `BlindWhaleFarmer`、`dsh-douyin-agent` | 沙盒自检测试在 3 秒内跑完 5 个游戏剧本与弹幕压测流，标记 `[SIMULATION]` | **DONE** |
| **`T-M1-01`** | M1：大肥鱼复活 | **可插拔桌宠渲染引擎 `pet-renderer`**：实现 `IPetAvatarRenderer` 接口与 `WebmVideoRenderer`（双 `<video>` 无缝切换、脚底基准线对齐、Q 弹形变） | `dsh-pet` (`REFERENCE-dsh-pet.md`) | 组件单测验证状态切换零黑帧；内置素材自动挂载 `DEV_ONLY_NON_COMMERCIAL` 水印标记 | **DONE** |
| **`T-M1-02`** | M1：大肥鱼复活 | **Electron 跨平台透明穿透宿主 `desktop-host`**：实现 Mac/Win 无边框置顶透明窗、离屏 Canvas Alpha 像素级鼠标穿透、多屏 DPI 拖拽甩抛 | `dsh-pet` | Playwright Electron E2E 验证：`alpha > 20` 拦截点击，`alpha <= 20` 穿透点击 | **DONE** |
| **`T-M1-03`** | M1：大肥鱼复活 | **模型与供应商网关 `model-gateway`**：实现 CC Switch 两步式预设+Region/Plan 切换、Magpie 6 角色路由、干饭套餐切换、粘性路由与隐私脱敏 | `CC Switch`、`Magpie`、`dsh-douyin-agent` | 模拟上游 429 报错，断言 100ms 内静默切换备用 Key；敏感路径 100% 替换为 `{{MASKED}}` | **DONE** |
| **`T-M1-04`** | M1：大肥鱼复活 | **"大肥鱼"三层人格引擎 `persona-brain`**：实现 `blue-whale-maid` 配置加载、`<think>` 内心戏流式剥离、0.1s"大肥鱼"雷区正则拦截与赛博饭碗扣费 | `dsh-pet`、`dsh-douyin-agent` | 输入含"大肥鱼"文本，断言 `<10ms` 返回 `P0_INTERRUPT` + `rage_spray` 且不消耗主脑 Token | **DONE** |
| **`T-M1-05`** | M1：大肥鱼复活 | **桌面舞台 UI 挂件与中控台模型配置页**：渲染头顶半透明 `<think>` 内心戏云朵气泡、正式对话气泡、赛博饭碗挂件及 CC Switch/Magpie 风格设置界面 | `dsh-live-studio`、`dsh-pet` | Playwright 截图断言双轨气泡同时显示不重叠；套餐胶囊一键切换 Dexie 状态同步 | **DONE** |
| **`T-M2-01`** | M2：本地语音与点歌 | **Python 跨平台音频 Sidecar 骨架与单端语音锁**：用 `uv` 搭建 FastAPI/WS 服务（自动识别 Mac `mps` / Win `cuda`），在宿主端实现带 TTL 的单端语音播放回执锁 | `dsh-pet` | 并发注入 5 条语音请求，断言严格串行播放或按 P0 抢占，绝不出现双音轨重叠 | **DONE** |
| **`T-M2-02`** | M2：本地语音与点歌 | **情绪感知 TTS 混合路由器**：实现本地 GPT-SoVITS v2 推理封装（绑定大肥鱼 5 组情绪参考音频）+ 云端 SiliconFlow/OpenAI TTS 自动降级路由 | `dsh-pet` | 传入 `[傲娇反驳]` 标签文本，断言正确匹配傲娇参考音频并返回有效音频流与口型包络 | **NEXT** |
| **`T-M2-03`** | M2：本地语音与点歌 | **点歌台 SVC 歌声转换与流式切片缓存池**：集成 Demucs v4 伴奏分离 + RVC v2 变声，实现"前 25 秒预缓冲先唱 + 本地磁盘 MD5 缓存池"与违禁曲目拦截 | `dsh-livestream`、`Dsh_douyin`（仅思想） | 测试音频跑通分离与变声混音；二次点播同一首歌断言 `<50ms` 命中本地缓存直接返回 | PENDING |
| **`T-M2-04`** | M2：本地语音与点歌 | **DIY 绿幕转透明 WebM 素材自动化管线**：将 `dsh-pet` 的 Python + FFmpeg 绿幕抠像、脚底对齐脚本集成到中控台，支持一键生成商用自有宠物包 | `dsh-pet`、`awesome-codex-pet` | 输入测试绿幕 MP4，断言自动输出带 Alpha 通道的 `.webm` 与对齐后的 `manifest.json` | PENDING |
| **`T-M3-01`** | M3：星露谷共玩 | **星露谷 MCP 客户端与动作互斥状态机 `game-bridge-mcp`**：实现动作派发、互斥锁、`COMPLETED/FAILED/UNCERTAIN` 回执处理与卡死甩锅台词触发器 | `BlindWhaleFarmer` | 在 `stardew-mcp-simulator` 下跑通寻路卡石头返回 `UNCERTAIN`，断言触发 `clumsy_panic` 且不死循环 | PENDING |
| **`T-M3-02`** | M3：星露谷共玩 | **摸鱼/认真双态规划器与"下饭菜"加餐联动**：根据赛博饭碗余量与是否有"下饭菜 Buff"，动态切换星露谷效用权重（翻垃圾桶摸鱼 vs 高效种菜） | `BlindWhaleFarmer`、`dsh-douyin-agent` | 单测验证：默认态体力 `<45%` 自动去长椅摸鱼；投喂"红烧肉"后切换为认真女仆规划 | PENDING |
| **`T-M3-03`** | M3：星露谷共玩 | **键鼠一动即接管（Seamless Co-Play）**：检测玩家物理输入，0.1 秒内中断 AI 动作锁并将"大肥鱼"切换为场边解说陪玩模式，静默 8 秒后平滑恢复托管 | `BlindWhaleFarmer` | 模拟器注入 `isPlayerMovingPhysically: true`，断言 `<100ms` 释放控制权并触发护主夸奖台词 | PENDING |
| **`T-M3-04`** | M3：星露谷共玩 | **C# SMAPI Mod 跨平台适配构建**：基于 `BlindWhaleFarmer` 封装跨 Mac/Win 的 `stardew-mcp-mod`，对齐 JSON-RPC 2.0 状态树与硬件输入钩子 | `BlindWhaleFarmer` | `dotnet build` 在 macOS 与 Windows 目标框架下零警告编译生成 Mod 包 | PENDING |
| **`T-M4-01`** | M4：直播与切片 | **直播事件总线与三级注意力调度器 `live-stream-hub`**：接入 `dyhub` 抖音弹幕流，实现同观众弹幕合并、礼物连击合并、三道防封敏感词护栏与 P0/P1/P2 队列 | `dsh-livestream`、`dsh-live-studio`、`dyhub` | 用 `danmaku-storm-replay` 注入 100 条/秒弹幕与违规词，断言违规词 100% 拦截且 P0 零延迟插播 | PENDING |
| **`T-M4-02`** | M4：直播与切片 | **节目状态机、常客记仇账本与弹幕议会**：实现"打游戏 ↔ 点歌 ↔ 杂谈"防呆切换、进房翻旧账互动，以及关键抉择 20 秒弹幕扣 1/2/3 投票器 | `Dsh_douyin`（仅思想）、`dsh-live-studio` | 模拟游戏过夜等待或卡关超 15 秒，断言自动切入点歌或杂谈状态，画面绝不冷场发呆 | PENDING |
| **`T-M4-03`** | M4：直播与切片 | **OBS 透明浏览器挂件源与高光/翻车自动切片器**：提供 `http://localhost:18765` OBS 透明图层（双轨气泡+歌词+饭碗+投票板），并基于 45 秒环形缓存生成翻车复盘切片 | `dsh-video-storyboard`、`dsh-live`（仅思想） | 模拟"矿洞晕倒+弹幕哈哈哈哈激增"事件，断言自动导出带时间戳与毒舌复盘字幕的切片草稿 | PENDING |
