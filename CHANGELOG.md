# Changelog

本项目的所有显著变更将记录在本文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

### Changed

- **设计稿 v3「曜石」（apple-ui-design 三原则：Clarity/Deference/Depth）**：iOS 系统色板（#0A84FF 主 accent + 系统语义色）、true-black 分层底（避开死黑）、**光影七层系统**（ambient 环境光斑慢漂移 / 玻璃卡 blur30+内高光 / 发丝分隔线 / 双层柔影 / Sheen 文本光泽 / 状态光晕）、SF Pro+PingFang 节奏、pill 按钮（980px）+ hover scale 1.02、连续曲率圆角 8/12/16/20；tokens 变量名保持兼容（全部页面自动继承质感），shell-chat 全面精修、其余 6 页注入 ambient 光影层；深浅双主题（#f5f5f7 Apple 浅灰对等实现）。功能结构沿 v2 已确认的 7 页（Shell+聊天/Harness/插件管理/星露谷/供应商/桌宠/OBS），插件化信息架构保证新功能融洽插入。
- **设计稿 v2 重做（ui-ux-pro-max 工作流，决策 D4/D9/D10）**：`design/` 全套升级——设计系统由 skill 数据库生成（Modern Dark 开发者工具风格、密度 8/10、Expo.out/spring 动效规格）；run-green 主操作色（#22C55E，"code dark + run green"）替代蓝紫 AI 味（v3 中绿转为纯运行/成功语义色）；lucide SVG 全量替换 emoji（本地 vendor/lucide.min.js，UI 零 emoji）；深/浅双主题完整 token（shell.js 持久切换）；7 页结构确立并经 Chrome headless 深浅双主题截图验证。
- **产品功能设计 v2（定位升级）**：[docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md) 重写——从「AI VTuber 工作台」升级为**通用个人 AI 工作台**（用户决策 D6~D10）：桌宠/直播/星露谷等全部收编为**可开关插件**；插件系统对齐 dsh（Cordis 插件树/defineTool/三层约定）+ 兼容层规划；新增 **ACP Harness 层**（参考 pingdotgg/t3code，MIT 68.5k★，已克隆分析：providers-acp/线程/远程审批，`dsh --profile acp` 直连）；技术栈选型（React 19 + Tailwind v4 + zustand + motion + **lucide-react 图标** + Electron + WebUI 双形态 + Vite 评估）；主题系统（深/浅/跟随+主题色）；ROADMAP 新增 M6 批次 4 工单（Shell+插件内核 / ACP Harness / dsh 兼容层 / WebUI），原 T-M5-03 并入 T-M6-01、T-M5-07 并入 T-M6-02。

### Added

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

### Added

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
