# Changelog

本项目的所有显著变更将记录在本文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
