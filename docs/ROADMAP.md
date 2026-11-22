# ROADMAP — 冻结的阶段迭代计划与工单状态

> **工单状态机**：`NEXT`（当前唯一激活）→ `DOING` → `DONE`（verify:gate 全绿 + 文档同步完成）/ `BLOCKED`。
> **铁律**：任何时刻只能有一个 `NEXT` 工单，严禁跨工单抢跑；单工单修改业务源码文件 ≤ 8 个（详见 [AGENTS.md](../AGENTS.md) §2）。
>
> **当前激活工单：`T-M5-04` 记忆图谱引擎（D11 语音第一版已完成真机发声；T-M5-01/02/15/16、T-M6-01/02 均已 DONE）**

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
> - `T-M2-02` ✅ 已完成（2026-11-15）：情绪感知 TTS 混合路由——契约先行（`TtsVoicePack`/`EmotionVoiceProfile`/`LipEnvelope`/`TtsSynthesisResult` 进 shared-protocol，19→24 域跨语言重生成）；Python `tts_engine` 情绪路由（情绪前缀→参考音频匹配、本地 GPT-SoVITS 优先 + 云端降级如实上报 degraded、口型包络 viseme 序列生成）；宿主侧 `tts-router`（情绪→桌宠动作映射、参考音频选择、语音租约组装 ttl=时长+缓冲、口型时间线采样）。
> - `T-M2-01` ✅ 已完成（2026-11-15）：Python Sidecar 骨架（`services/audio-ai-worker`：uv 管理 Python 3.11 + FastAPI + WebSocket；`/health` 硬件后端探测 mps/cuda/cpu、`/tts/synthesize` 确定性 WAV stub、`/ws/audio` JSON-RPC 通道）+ 宿主侧 `AudioLeaseManager` 单端语音锁（dsh-pet 已核实机制工程化：单端互斥 active≤1 不变式、播放完成回执驱动、P0 抢占 INTERRUPTED_BY_P0、TTL 强制释放 TTL_EXPIRED、失败 AUDIO_DEVICE_ERROR、队列 P0 优先+同级 FIFO）；REFERENCE-dsh-pet 的 TTL 语音锁待核实项已核实并回写档案。
> - `T-dir-01` ✅ 已完成（2026-11-21，**用户指令插队**：真机测试 + 供应商 key 自配优先，原 NEXT 的 T-M2-03 回落 PENDING）：Magpie（yetone/magpie，MIT）式供应商配置——契约加 `activeModelId` 跨语言重生成；主进程 provider-vault（safeStorage 加密落盘 userData/provider-vault.json、渲染进程只见掩码、模型发现/连接测试走主进程 fetch 守 UI 边界）；preload directorBridge + director 补挂 preload；App 重构 Magpie 单屏（9 供应商卡 Key→拉模型→测试→选激活模型 + 六槽位下拉绑定，Dexie providerOverrides/diningProfiles 双层持久）；构建修复（better-sqlite3 external）与 E2E 隔离修复（PET_STAGE_E2E 独立 userData 防 IndexedDB LevelDB 锁互踩）；真机 Electron 38 验收 + verify:gate 4 过。
> - **真机游戏侧进展（2026-11-21）**：Stardew Valley 1.6.15 + SMAPI 4.5.2 + BWF Mod（已升级 1.1.6→1.1.27，修 MCP 端口 bind 问题）真机联调打通——MCP `http://127.0.0.1:18080/mcp`（Streamable HTTP，JSON/SSE 双格式摇摆），81 工具；已实测 load_save 读档「泡泡湾_454908853」+ 以小鲸人设游玩（读信/开垦播种浇水 15 防风草/威利剧情领竹鱼竿/钓鳀鱼/卖杂物）。发现待办：MCP tools/list 未标 required、长动作 45s "还在执行"语义、HTTP 超时≠失败不可重发——game-bridge-mcp TS 客户端（T-M3-01）需内置互斥锁+看门狗（"没反应查原因"）。

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
| **`T-M2-02`** | M2：本地语音与点歌 | **情绪感知 TTS 混合路由器**：实现本地 GPT-SoVITS v2 推理封装（绑定大肥鱼 5 组情绪参考音频）+ 云端 SiliconFlow/OpenAI TTS 自动降级路由 | `dsh-pet` | 传入 `[傲娇反驳]` 标签文本，断言正确匹配傲娇参考音频并返回有效音频流与口型包络 | **DONE** |
| **`T-M2-03`** | M2：本地语音与点歌 | **点歌台 SVC 歌声转换与流式切片缓存池**：集成 Demucs v4 伴奏分离 + RVC v2 变声，实现"前 25 秒预缓冲先唱 + 本地磁盘 MD5 缓存池"与违禁曲目拦截 | `dsh-livestream`、`Dsh_douyin`（仅思想） | 测试音频跑通分离与变声混音；二次点播同一首歌断言 `<50ms` 命中本地缓存直接返回 | **NEXT** |
| **`T-M2-04`** | M2：本地语音与点歌 | **DIY 绿幕转透明 WebM 素材自动化管线**：将 `dsh-pet` 的 Python + FFmpeg 绿幕抠像、脚底对齐脚本集成到中控台，支持一键生成商用自有宠物包 | `dsh-pet`、`awesome-codex-pet` | 输入测试绿幕 MP4，断言自动输出带 Alpha 通道的 `.webm` 与对齐后的 `manifest.json` | PENDING |
| **`T-M3-01`** | M3：星露谷共玩 | **星露谷 MCP 客户端与动作互斥状态机 `game-bridge-mcp`**：实现动作派发、互斥锁、`COMPLETED/FAILED/UNCERTAIN` 回执处理与卡死甩锅台词触发器 | `BlindWhaleFarmer` | 在 `stardew-mcp-simulator` 下跑通寻路卡石头返回 `UNCERTAIN`，断言触发 `clumsy_panic` 且不死循环 | PENDING |
| **`T-M3-02`** | M3：星露谷共玩 | **摸鱼/认真双态规划器与"下饭菜"加餐联动**：根据赛博饭碗余量与是否有"下饭菜 Buff"，动态切换星露谷效用权重（翻垃圾桶摸鱼 vs 高效种菜） | `BlindWhaleFarmer`、`dsh-douyin-agent` | 单测验证：默认态体力 `<45%` 自动去长椅摸鱼；投喂"红烧肉"后切换为认真女仆规划 | PENDING |
| **`T-M3-03`** | M3：星露谷共玩 | **键鼠一动即接管（Seamless Co-Play）**：检测玩家物理输入，0.1 秒内中断 AI 动作锁并将"大肥鱼"切换为场边解说陪玩模式，静默 8 秒后平滑恢复托管 | `BlindWhaleFarmer` | 模拟器注入 `isPlayerMovingPhysically: true`，断言 `<100ms` 释放控制权并触发护主夸奖台词 | PENDING |
| **`T-M3-04`** | M3：星露谷共玩 | **C# SMAPI Mod 跨平台适配构建**：基于 `BlindWhaleFarmer` 封装跨 Mac/Win 的 `stardew-mcp-mod`，对齐 JSON-RPC 2.0 状态树与硬件输入钩子 | `BlindWhaleFarmer` | `dotnet build` 在 macOS 与 Windows 目标框架下零警告编译生成 Mod 包 | PENDING |
| **`T-M4-01`** | M4：直播与切片 | **直播事件总线与三级注意力调度器 `live-stream-hub`**：接入 `dyhub` 抖音弹幕流，实现同观众弹幕合并、礼物连击合并、三道防封敏感词护栏与 P0/P1/P2 队列 | `dsh-livestream`、`dsh-live-studio`、`dyhub` | 用 `danmaku-storm-replay` 注入 100 条/秒弹幕与违规词，断言违规词 100% 拦截且 P0 零延迟插播 | PENDING |
| **`T-M4-02`** | M4：直播与切片 | **节目状态机、常客记仇账本与弹幕议会**：实现"打游戏 ↔ 点歌 ↔ 杂谈"防呆切换、进房翻旧账互动，以及关键抉择 20 秒弹幕扣 1/2/3 投票器 | `Dsh_douyin`（仅思想）、`dsh-live-studio` | 模拟游戏过夜等待或卡关超 15 秒，断言自动切入点歌或杂谈状态，画面绝不冷场发呆 | PENDING |
| **`T-M4-03`** | M4：直播与切片 | **OBS 透明浏览器挂件源与高光/翻车自动切片器**：提供 `http://localhost:18765` OBS 透明图层（双轨气泡+歌词+饭碗+投票板），并基于 45 秒环形缓存生成翻车复盘切片 | `dsh-video-storyboard`、`dsh-live`（仅思想） | 模拟"矿洞晕倒+弹幕哈哈哈哈激增"事件，断言自动导出带时间戳与毒舌复盘字幕的切片草稿 | PENDING |

## M5 批次：体验升级（2026-11-21 新增，源于 21 仓库代码级复评与用户决策 D1~D5）

> 需求总纲见 [PRODUCT-DESIGN.md](./PRODUCT-DESIGN.md)；复评索引见 [REFERENCES.md](./REFERENCES.md) §4。**当前激活：`T-M5-01`**（用户指令：P0 三连，M2-03/M3/M4 原工单按 M5 融合后推进）。

| 工单编号 | 分期 | 工单名称与核心交付物（单工单 ≤ 8 文件） | 开工前必查参考 | 自动化门禁校验指令与断言（Gate） | 状态 |
| --- | --- | --- | --- | --- | --- |
| **`T-M5-01`** | P0 | **官方素材包移植与 manifest 管线**（✅ 2026-11-21 DONE）：dsh-pet 114 个 alpha webm → pet-renderer 素材库；manifest 三层合并（categories/weights/sleep 三段）；aboutme-pets 精灵图逆向脚本移植为扩展角色包管线；素材台账登记 | dsh-pet、aboutme-pets | 断言：≥100 动作可渲染、sleep 三段接力首尾帧对齐、manifest 条目级覆盖生效、台账含来源路径 | NEXT |
| **`T-M5-02`** | P0 | **game-bridge-mcp 客户端与人格化自动驾驶**（✅ 2026-11-21 DONE：真机 E2E 游戏被驱动）：MCP 客户端（SSE/JSON 双解析）+ 动作互斥锁 + 看门狗（分层超时/卡死哨兵/cancel 兜底）+ 人格化规划器（get_state→persona-brain→LLM→回执→总线多播）+ 守护层（换日总控/强制睡觉）+ CheatBridge 开关（默认关+审计）；**语音触发挂点**（D11：场景矩阵六类触发 → voice 订阅模块 → AudioLeaseManager 租约，节流 8s/20s/30min） | BWF、feiyuos-stardew、feiyuos-pc-body | 仿真剧本断言：uncertain→clumsy_panic 不死循环；游戏时间 4min 不动→诊断触发；超时不重发；CheatBridge 关闭时直写被拒 | PENDING |
| **`T-M5-03`** | P0 | **聊天主界面 v1（D3）**：会话列表侧栏 + 流式回复 + Markdown + `<think>` 折叠 + 工具调用卡片（动作回执/语音锁实时态）+ 对话控 AI（指令插队 P0，执行完回归自主）+ 审批卡片（Y/N/A） | deepseek-harness agent-loop、FeiyuOS Y/N/A | E2E：流式渲染断言；注入"去钓鱼"指令断言插队 P0；`<think>` 折叠；审批卡拒绝后动作不执行 | PENDING |
| **`T-M5-04`** | P1 | **长期记忆图谱引擎移植**（✅ 2026-11-22 DONE：memory-graph 包+memory-host+真机记忆驱动回话）：feiyuos-memory-graph 节点/边/检索/遗忘/压实全量移植对接 local-store；**小鲸日记（换日自动归纳当日事件→日记条目入图谱）**；下播提炼（12 观众/次）；**观众感知双写（进房/发言/送礼 → grudge_ledger + 图谱 event+viewer 实体，常客翻旧账问候）**；聊天自问「昨天做了什么」检索作答 | feiyuos-memory-graph、dsh-livestream distill | 单测：检索 top5 加权正确；30 天半衰期衰减；同实体≥3 事件归纳主题；JSONL 原子写；日记生成幂等；观众双写一致性 | PENDING |
| **`T-M5-05`** | P1 | **三级注意力调度与弹幕中枢**：dsh-livestream attention 公式移植（人数分档/e^(-age/τ)/连击结算/聚拢欢迎）+ 事件中枢（去重/合并/批量 flush）+ clip.js/budget.js | dsh-livestream、dsh-fish | danmaku-storm-replay 断言：100 条/秒分档正确；同观众合并；违规词 100% 拦截 | PENDING |
| **`T-M5-06`** | P1 | **渲染参数单出口重构与交互质感**：engine.js 范式重写参数管理 + mood 纯函数 + gaze 注射 + alpha 剪影点击分区 | dsh-desktop-petbox | 断言：呼吸/眨眼/注视/口型并发不覆盖（每帧单出口）；剪影命中分区正确 | PENDING |
| **`T-M5-07`** | P1 | **工作跟随**：本地 AI CLI 会话 jsonl 监听→事件映射→桌宠动画/气泡（改文件轮询为总线 WS 推送） | agent-pet、crosspet | 断言：mention/processing/success→动画映射；BIG_JOB_TOOLS 大活判定 | PENDING |
| **`T-M5-08`** | P2 | **点歌台 SVC 与歌词挂件**：点歌正则解析→队列→Demucs/RVC 管线（小鲸音色演唱）+ OBS 歌词卡 + **歌单管理页（Shell 面板）+ 送礼插队（价值→权重：小+1位/中+3位/大置顶+专属感谢）** + 防呆（违禁曲拦截/同曲冷却 30min/每人每小时 3 首） | Dsh_douyin、dsh-livestream | 二次点播 <50ms 缓存命中；违禁曲拦截；礼物插队排序断言 | PENDING |
| **`T-M5-09`** | P2 | **OBS 挂件与 STAGE_PROTOCOL**：18765 透明浏览器源 + 版本化 SSE 契约 + transitions 帧匹配防叠影 | dsh-livestream stage | 契约版本协商断言；切换零叠影 | PENDING |
| **`T-M5-10`** | P2 | **高光/翻车切片器**：ffmpeg 采集管线 + 五阶段切点链 + 宫格分镜 + LRU 缓存 | dsh-video-storyboard、dsh-live | 模拟翻车事件→自动导出带字幕切片草稿 | PENDING |
| **`T-M5-11`** | P2 | **model-gateway v2 协议互译**：OpenAI/Anthropic/Gemini 流式互译（含工具调用）、tier+临期 failover、agent 用量归属、掩码回填 | magpie | 四协议互译单测 100% 分支；tier 选号断言；掩码回填残留 0 | PENDING |
| **`T-M5-12`** | P2 | **PC 身体安全模板与看门狗自愈**：鱼鳍安全边界（黑名单/审计/急刹/信号量）+ 进程看护 | feiyuos-pc-body | 灾难命令 100% 拦截；审计 JSONL 轮转；kill 后 ~70s 自愈 | PENDING |
| **`T-M5-13`** | P2 | **形象工坊（D13③）**：自定义形象 + AI 生成动作管线——AI 生视频提示词模板→绿幕→chroma→normalize（640×360 alpha）→manifest 条目注册→试穿预览；精灵图逆向导入 | dsh-pet scripts、aboutme-pets | 素材规格自动校验（alpha/帧率/时长）；生成→注册→pet-stage 即时切换断言；台账登记 | PENDING |
| **`T-M5-14`** | P1 | **小鲸日记面板（D13②）**：Shell 日历视图翻阅每日日记 + 记忆图谱力导向可视化 + 周报复盘（TTS 播报+切片联动入口） | feiyuos-memory-graph viewer | 日历翻阅 E2E；周报生成幂等；图谱检索入口可用 | PENDING |
| **`T-M5-16`** | P0 | **动作库预览与情绪全映射（D16）**（✅ 2026-11-21 DONE：E2E 全通+零闲置审计）：Shell pets 页签（11 槽位卡+ambientPool 分类网格+点击预览 IPC→桌宠窗即播）；情绪五档/游戏事件/饭碗三层映射表 + ambient 空闲随机链（30s→pickAmbient→6s 回 idle）+ **素材零闲置审计**（114 clips 全覆盖断言） | dsh-pet（animationWeights/余额分档）、T-M5-01 manifest | 单测：114 clips 覆盖率审计断言；E2E：pets 页点击 → 桌宠窗 src 切换；ambient 链确定性（rng 注入） | NEXT（并入 T-M6-01 桌宠插件范围先行） |
| **`T-M5-17`** | P0 | **声音工坊 Voice Studio**（✅ 2026-11-22 DONE：契约 4 域+后端 5 端点+工坊 UI+13 pytest+10 契约测试） | dsh-voice-studio、dsh-gpt-sovits | 参数往返 100%；refText 空拦截；互斥锁 trace；低内存降级 | DONE |
| **`T-M5-15`** | P1 | **攻略采集器 guide-forager（D15）**（✅ 2026-11-21 DONE：真机 get_guide 读到 wiki 新攻略）：星露谷 wiki（MediaWiki API）+ 小黑盒热榜 → 正文提取→主题分类→hash 去重→`guide-forager/<主题>.md` 归档+索引；**三路注入**：BWF get_guide 专题导出 / LLM Planner 检索上下文 / 技能卡互引；周更+开播前触发 | 星露谷 wiki、小黑盒、BWF Guide.cs | 单测：抓取→清洗→分类→去重确定性（fixture）；导出文件可被 get_guide 读取断言；限速与 robots 合规断言 | PENDING |
| **`T-M6-05`** | P2 | **独立安装包（D14）**：electron-builder（macOS dmg + Win nsis）——素材/worker/契约生成物打进 resources；首启向导（星露谷+Mod 一键安装引导、GPT-SoVITS 可选下载、供应商 key 配置）；全功能离线自包含验证 | electron-builder | 干净环境（无参考仓库路径）安装→启动→桌宠渲染→autodrive 依赖注入断言；安装包体积 <200MB（不含可选 GPT-SoVITS） | PENDING |

## M6 批次：通用工作台内核（2026-11-21 v2 新增，用户决策 D6~D10）

> 需求总纲见 [PRODUCT-DESIGN.md](./PRODUCT-DESIGN.md) §2（分层架构/插件系统/Harness/技术栈）；**实现规格与 ADR 决策见 [ARCHITECTURE.md](./ARCHITECTURE.md)**（进程拓扑 / 三层插件 / PluginHost=cordis / ACP v1 先行 / 数据所有权 / policy 单咽喉 / 三轨并行计划 / 风险登记册 R1~R8）。产品定位升级为**通用个人 AI 工作台**：插件化 + ACP Harness + WebUI + 主题系统 + lucide 图标。

| 工单编号 | 分期 | 工单名称与核心交付物（单工单 ≤ 8 文件） | 开工前必查参考 | 自动化门禁校验指令与断言（Gate） | 状态 |
| --- | --- | --- | --- | --- | --- |
| **`T-M6-01`** | P0 | **工作台 Shell 与插件内核**（🟨 2026-11-22 LLM 大脑完成：聊天回话/雷区反射/攻略注入/LlmPlanner 真机验收；插件内核 Cordis 化待续）：Shell 布局（侧栏导航树=插件注册/顶栏主题切换/右侧快捷卡区）+ 插件 manifest/defineTool/registry/事件总线订阅/enable-disable 热开关 + 插件管理页 + zustand + lucide-react 全量图标 + 深/浅/跟随系统主题 + motion 动效规格；**并入 T-M5-03**：聊天主界面（think 折叠/工具卡片/审批卡/对话指挥）；**并入 D11/D12**：pet 插件 renderer 层——状态气泡组（动作状态条/目标卡/事件弹泡，ADR-6 status-bubble 状态机）+ 语音设置三开关 | deepseek-harness（Cordis）、dsh-plugin-yushe（defineTool）、t3code（Shell/Providers）、magpie（UI 模式） | E2E：插件禁用后其侧栏项/卡片消失且事件解绑；主题切换 CSS vars 全量生效；lucide 图标零 emoji 断言（lint 扫描 UI 源码）；聊天流式/think 折叠/审批卡 E2E | NEXT（T-M5-01 完成后） |
| **`T-M6-02`** | P0 | **ACP Harness 层**（✅ 2026-11-21 DONE：真机 gemini+dsh 双握手验收）：ACP v1/v2 client（stdio JSON-RPC）+ Provider 实例管理（Registry 搜索/本地命令如 `dsh --profile acp`）+ 线程/中途换 agent/checkpoint 回放 + 工具调用审批卡（桌面+远程）+ 按 agent 用量记账；**并入 T-M5-07：线程状态→桌宠工作跟随动画** | t3code（providers-acp.md/thread）、magpie（agentOf） | 契约单测：ACP initialize/session 流程夹具；审批卡拒绝→工具不执行且回喂；线程状态→动画映射断言 | PENDING |
| **`T-M6-03`** | P1 | **dsh 插件兼容层 plugin-bridge**：Cordis 插件树/defineTool/typed events → 本工作台工具/事件模型适配器 + 插件装载器（host/client/shared 三层约定）+ dsh 插件兼容测试夹具 | deepseek-harness、dsh-fish、dsh-plugin-yushe | 夹具断言：一个样例 dsh 插件原样装载成功且 defineTool 注册的工具经总线可调；禁用/崩溃隔离 | PENDING |
| **`T-M6-04`** | P1 | **WebUI 形态**：bridge 抽象双实现（Electron IPC ↔ HTTP/WS）+ 轻量本地 server（总线/静态资源/vault 代理）+ 远程审批（桌面开线程、浏览器批审批）+ Vite 迁移评估 | t3code（desktop/server/web 多端）、magpie（本地网关） | 同一 renderer 组件在两种宿主下渲染断言；远程审批 E2E（WebUI 拒绝→桌面动作不执行） | PENDING |
