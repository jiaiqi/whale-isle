# Whale Isle V2 项目全面审计与参考研究报告（任务 A & 任务 B）

> **审计基准**：分支 `main` @ `f1ce271`（2026-11-25），基于实读代码、`pnpm verify:gate`（7/7 通过）与 `pnpm --filter @workbench/desktop-host build` 真实执行结果。  
> **原则**：严格区分 `[REAL-DEVICE]`（真机验证）、`[E2E-HOST]`（Electron 无头/CDP 验证）、`[SIMULATION]`（确定性仿真/单测）与 `UNVERIFIED / STUB`（未接线或骨架），不把界面或单测冒充为完整能力。

---

## 一、任务 A：现有项目全面审计

### 1.1 仓库规模与当前运行健康度

- **代码规模（非测试业务源码）**：总计约 **54,558 行**（`apps/desktop-host` 约 53,826 行含测试；11 个业务包共 ~26,800 行；2 个 sidecar 服务 ~5,000 行；4 个游戏 Mod 目录）。
- **门禁基线（接管时实测）**：
  - `pnpm verify:gate`：**7 过 / 0 跳过 / 0 待接线**（`tsc -b` + `dependency-cruiser` + Python `ruff` / `mypy --strict` + `license-scanner` 235 文件 + `pnpm audit` 0 high/critical + `luac -p` 5 Lua 文件 + `vitest` + `pytest` + 7 个星露谷卡死回归剧本 `S01–S07` + Gate 4 回环 0.4s）。
  - `pnpm --filter @workbench/desktop-host build`：通过（`esbuild` + `tailwindcss` v4.3.5 + 资产拷贝）。
  - 资产体量：`assets/`（约 1.9GB，含 `aboutme-pets` 与 `crosspet`，`.gitignore` 排除）、`packages/pet-renderer/assets/`（56MB，114 个 VP9-Alpha WebM）、`guide-forager/`（148KB，12 专题）、`release/`（5.6GB 本地打包产物）。

### 1.2 目录结构分析

| 层级 | 目录 | 职责与现状 |
| --- | --- | --- |
| **宿主应用** | `apps/desktop-host` | Electron 45.4.1 主进程（42+ `*-host.ts` 模块）、preload 桥、3 个渲染入口（`director` 中控台、`pet-stage` 透明桌宠、`tray-popover` 托盘浮窗）与内嵌 WebUI（`127.0.0.1:18780`） |
| **核心共享契约** | `packages/shared-protocol` | 50 域 Zod v4 Schema + JSON Schema + Python Pydantic 生成器（`pnpm gen:contracts`） |
| **模型与人格** | `packages/model-gateway`<br>`packages/persona-brain` | 多供应商预设（OpenAI/Anthropic/OpenCode/TypeSafe Jev）、粘性路由与 failover、隐私脱敏；三层人格（`<think>` 剥离、P0 雷区 0.1s 反射、赛博饭碗经济） |
| **存储与记忆** | `packages/local-store`<br>`packages/memory-graph` | SQLite（`better-sqlite3` 常客/流水/点歌 + `node:sqlite` 友谊/小本子）+ Dexie；JSONL 记忆图谱（2-gram + 2 跳扩展 + 30d 半衰期 + 换日日记） |
| **桌宠与模组** | `packages/pet-renderer`<br>`packages/stardew-mods` | Webm 双 `<video>` 零黑帧渲染、Spritesheet/PoseSkin 渲染器、Q 弹物理；SMAPI Mod 扫描、`.disabled` 启停与安装 |
| **游戏与直播** | `packages/game-bridge-mcp`<br>`packages/live-stream-hub` | `GameAdapter` 注册表（Stardew/Terraria/DST）、`LlmPlanner` / `RulePlanner`、攻略库与心得本；弹幕三级注意力调度 + 护栏（未接真实直播流） |
| **扩展与 Harness** | `packages/plugin-kit`<br>`packages/agent-harness` | Cordis 语义无依赖插件容器 + `defineTool` + `dsh` 适配；ACP v1 stdio 客户端（`gemini`/`dsh` 握手） |
| **独立服务** | `services/audio-ai-worker`<br>`services/dst-bridge-sidecar` | Python 3.11 (`uv`) FastAPI 音频骨架（440Hz WAV stub）；DST 本地 HTTP/专用服托管桥（:18100） |
| **游戏 Mod** | `mods/bwf-patches`、`mods/stardew-avatar-sync`、`mods/terraria-bridge`、`mods/dst-bridge` | BWF 补丁集、星露谷像素外观同步 Mod、泰拉瑞亚 tModLoader 桥（:18090）、DST Lua 桥 |
| **测试与工具** | `tools/mock-harness`、`tools/soak-real`、`tools/guide-forager`、`tools/scripts` | 仿真器与卡死剧本 `S01–S07`、真机浸泡工具、Wiki 攻略采集、门禁与打包脚本 |

### 1.3 技术栈评估

| 技术项 | 当前选型 | 评估结论 | 演进策略 |
| --- | --- | --- | --- |
| **桌面壳** | Electron 45.4.1 + React 19.2 + TypeScript 5.9.2 | **适合长期演进**。多屏透明穿透、safeStorage、WebM Alpha 与跨平台打包已跑通 | 保留，补齐 V2 内核边界与异步 safeStorage |
| **构建打包** | `tsc -b` + `esbuild` + `@tailwindcss/cli` v4 | **快速轻量**，但前端缺少开发期 HMR 与代码分块 | V2 初期保留零阻断打包；UI 重构期可评估 Vite 接入 |
| **契约体系** | Zod 4.6.7（原生 `z.toJSONSchema`）→ TS / JSON Schema / Pydantic | **核心优势**，强类型跨语言防漂移 | 保留，从 `shared-protocol/src/index.ts` 单文件按域拆分 |
| **数据存储** | Dexie + `better-sqlite3` + `node:sqlite` + JSONL | **存在分裂**：同时维护两套 SQLite 驱动引发 ABI 风险 | V2 统一收敛至 Node/Electron 内置 `node:sqlite` + JSONL 审计流 |
| **音频服务** | Python 3.11 (`uv`) FastAPI + macOS `mcode-tools`/`say` | FastAPI 骨架尚为 440Hz stub；真实 TTS 强依赖 macOS CLI | 保留 Sidecar 形态，抽象 `VoiceProvider` 接口接入真实跨平台引擎 |

### 1.4 已有功能清单（诚实区分：真实可用 vs 部分/仿真 vs 未接线）

| 能力域 | 真实可用度 | 已有证据 / 缺口说明 |
| --- | --- | --- |
| **星露谷自主游玩 & 人机共玩** | ✅ **核心可用（真机已跑）** | `LlmPlanner` + `RulePlanner`、攻略采集与心得本、BWF HTTP MCP（`:18088`）、`playerInControl` 补丁、临时接管、外观同步 Mod 均有真机证据；仍待人类验真机按 F7 与 7 日连续 LLM 浸泡 |
| **模型网关与密钥安全** | ✅ **核心可用（真机已跑）** | `safeStorage` v2 隔离 vault、10+ 服务商预设、OpenAI/Anthropic 双协议、429 failover、脱敏、Token 饭碗与真余额查询（DeepSeek/OpenRouter/OpenCode Go） |
| **透明桌宠渲染与多窗** | ✅ **核心可用（E2E + macOS 真机）** | 114 个 WebM + `aboutme-pets` + `crosspet`、像素穿透、拖拽甩抛、工作跟随、托盘浮窗均可用；Windows 11 未实机验证 |
| **ACP Harness & 插件内核** | ⚠️ **部分可用** | `gemini --acp` / `dsh --profile acp` 实机握手通；`plugin-kit` + `plugin-host` 可发现 `index.mjs` 但未形成安全隔离的 V2 内置能力底座 |
| **语音与唱歌** | ⚠️ **半真实 / 半 Stub** | macOS `mcode-tools → say → afplay` 可发声且语音锁闭环；但 `services/audio-ai-worker` 仍返回 440Hz WAV stub，RVC/Demucs 点歌与 Windows 语音未接线 |
| **直播、OBS、多游戏（泰拉/DST）** | ⚠️ **仅仿真/未真机闭环** | `live-host` 仅跑本地 replay 样本，未接 `dyhub`；OBS `/obs` 为只读挂件；泰拉瑞亚与 DST 仅编译/仿真通过，真机未验收（已按 M8 收敛决策冻结） |
| **社区生活 / Evolution Engine** | ❌ **仅设计稿（未实现）** | 仅存在蓝图与静态 HTML 原型，无运行代码 |

### 1.5 代码质量与技术债务

1. **巨型“上帝文件”与过度集中编排**：
   - `apps/desktop-host/src/renderer/pet-stage/main.ts`（1,686 行）
   - `packages/shared-protocol/src/index.ts`（1,500 行）
   - `apps/desktop-host/src/main/index.ts`（1,476 行，直接组装 40+ host 与定时器）
   - `apps/desktop-host/src/renderer/director/App.tsx`（1,466 行）
   - `apps/desktop-host/src/main/autodrive-host.ts`（983 行，同时承载网关构建、饭碗计量、记忆入库、语音播报、聊天指令与多游戏适配）
2. **事件总线割裂**：`PluginHost` 内部 `EventBus`、`autodrive-host` 自建 `eventHistory + busListeners`、`main/index.ts` 散落的 `webContents.send` 并存，缺乏带信封与因果链的统一内核事件总线。
3. **缺少一等公民 `CharacterCore`**：身份分散在 `pet-prefs.json`、`character-registry.ts`、`character-persona.ts`、`voice-bindings.ts` 和 `friendship.sqlite` 五处，没有统一的运行时情绪/表达/控制权仲裁模型。
4. **可观测性薄弱**：全局依赖 `console.log`/`console.warn`，缺少分级结构化日志、错误码体系、环回日志查询与统一的敏感字段脱敏器。
5. **文档与资产风险**：根 `docs/ROADMAP.md` 存在历史状态并列问题；随包与本地携带 ~1.9GB `CC BY-NC-SA 4.0` 非商用素材（`blue-whale-maid`、`aboutme-pets`、`crosspet`），商用前必须经过清源管线替换。

### 1.6 V1 模块处置矩阵（Keep / Refactor / Rewrite / Retire）

| 模块 / 包 | 处置建议 | 理由 |
| --- | --- | --- |
| `packages/shared-protocol` | **Keep + Split** | 跨语言 Zod 契约底座极佳；按域拆分为子模块文件，避免 1500 行单文件 |
| `packages/model-gateway` | **Keep + Extend** | 协议路由、failover、脱敏与真实余额逻辑成熟；补充统一 Quota 诚实分级接口 |
| `packages/persona-brain` | **Keep + Refactor** | 三层人格与 0.1s 雷区反射保留；与即将建立的 `CharacterCore` 统一情绪模型融合 |
| `packages/memory-graph` | **Keep + Extend** | JSONL 图谱与换日日记可用；补齐五类记忆分类（Working/Episodic/Semantic/Relational/Self）与纠正/来源字段 |
| `packages/pet-renderer` | **Keep + Extend** | `IPetAvatarRenderer`、零黑帧 WebM 与 Spritesheet 保留；后续在 `pet-stage` 拆分 `main.ts` 并预留 Live2D/3D 适配 |
| `packages/game-bridge-mcp` | **Refactor** | `GameAdapter`、`LlmPlanner` 与 `S01–S07` 剧本价值极高；需将规则兜底与核心规划接口进一步与宿主解耦 |
| `packages/plugin-kit` | **Keep + Wrap** | Cordis 生命周期与崩溃隔离已实现；由 V2 `runtime-core` 包装为统一插件宿主与能力权限门控 |
| `packages/agent-harness` | **Keep + Extend** | ACP v1 客户端已真机握手；后续补充 MCP Client/Server、Skills 注册与 Browser/Computer Use 租约 |
| `packages/stardew-mods`、`tools/mock-harness`、`tools/soak-real`、`tools/guide-forager` | **Keep** | 已在真机/Gate 中验证稳定，继续服务 V2 游戏验证与门禁 |
| `packages/local-store` | **Refactor** | 消除 `better-sqlite3` 双引擎，统一迁移至 `node:sqlite` + Dexie |
| `apps/desktop-host/src/main/index.ts` & `autodrive-host.ts` | **Refactor (Strangler)** | 不推倒重写；通过引入 `WhaleKernel`（`@workbench/runtime-core`）逐步剥离生命周期、事件、状态、配置与日志 |
| `apps/desktop-host/src/renderer/director/App.tsx` | **Refactor (Incremental)** | 按设计稿「六世界 × 十页面」与状态库逐步拆分页面壳层 |
| `services/audio-ai-worker` (stub 部分) | **Rewrite (Adapter)** | 保留 FastAPI 进程边界，替换 440Hz stub 为真实跨平台 TTS/SVC Provider |
| `docs/ROADMAP.md` 多头并发描述 | **Retire / Consolidate** | V2 分支以 `docs/v2/ROADMAP.md` 作为唯一工单真源 |

---

## 二、任务 B：设计稿与参考项目研究

### 2.1 设计稿对比与选型结论

仓库中存在四代设计资产：
1. **Obsidian v4（`design/`，当前运行中控台基线）**：`#050507` 纯黑曜石底 + Apple 玻璃材质 + 系统蓝 `#0a84ff` + 分组插件侧栏 + `⌘K` + `lucide-react` 零 emoji。
2. **V2 入口原型（`whale-isle-v2-obsidian.html`）**：将 v4 壳层升级为 13 个 V2 页面框架（含角色创作工坊、声音身份、社区生活、自主进化），确立了「左侧导航 + 右侧 `GET_STATE` 实时监控 + 顶栏三开关」的信息结构。
3. **Tide v5（`design/v2/`，12 文件）**：提出「深海屿光」视觉母题（鲸光青 `#3EE0CD`）、**六世界 × 十页面** IA，以及 **声呐环 / 回执芯片 / 许可徽章 / 控制权 HUD** 四个签名组件（注：该稿部分使用了“小莓”命名）。
4. **Obsidian Tide（`design/v2-gemini/`，16 文件）**：融合 `whale-isle-v2-obsidian.html` 的曜石深海/晨汐瓷白双主题（含 `system` 跟随）与 `design/v2/` 的六世界十页 + 四个签名组件，锚定单一主角色 **小鲸**，明确 `pet-stage` 与 `tray-popover` 独立双窗硬件边界。
5. **Tidepaper v3（`design/v3/`）**：暖白纸感 + 衬线数字的探索稿，气质偏向静态手账，对高频游戏状态与多工作流监控承载较弱。

**设计体系决策**：选用 **Obsidian Tide（`design/v2-gemini/` + `whale-isle-v2-obsidian.html`）** 作为 V2 目标设计体系——保留当前已落地的 Obsidian v4 Tailwind tokens 工程资产，按“先内核壳层、后语义组件、再逐世界迁移”渐进演进，零推倒浪费。

### 2.2 CrossPet（`lokicorvus/crosspet` v1.4.1）深度审查

- **许可证二段式**：源码 **MIT**；`characters/` 目录立绘、设定与生图提示词为 **CC BY-NC-SA 4.0**（署名 上善无形 / ZipZipPipe 等，**严禁商用**）。
- **已验证可借鉴/复用点**：
  1. **状态-姿态-台词映射表**：`character.json` 的 `pose` 映射、`lines{pose: string[]}` 多档台词池、`correctedPose`（出错/打断反应）、`longThink` 延时切换与 `BIG_JOB_TOOLS` 大活判定。
  2. **关系成长机制**：`friendship.js`（10 颗心 / 每日上限 15 分）与按天回溯的小本子（已在 `packages/local-store/src/friendship.ts` 移植）。
  3. **多 AI 工作跟随钩子思想**：9 类 CLI hook 与静默观察。
- **不采用部分**：不移植其 C#（Windows）/ Swift（macOS）/ Web 三宿主架构与更新脚本；不把其 `CC BY-NC-SA 4.0` 美术素材作为最终商业发行资产，商用发布前通过创作工坊生成自有版权资产替换。

### 2.3 开源许可证与依赖风险清单

| 类别 | 项目 | 许可证 | 处置规范 |
| --- | --- | --- | --- |
| **安全可商用代码** | `dsh-pet` (代码)、`BlindWhaleFarmer`、`Junimo-MCP`、`TerraBlind`、`dst-ai-companion`、`feiyu-os`、`magpie`、`t3code`、`deepseek-harness`、`crosspet` (代码) | **MIT** | 可移植或参考，保留版权头与 `docs/licenses/` 归档 |
| **需留 NOTICE** | `dsh-video-storyboard` | **Apache-2.0** | 必须保留 NOTICE 与署名 |
| **仅非商用开发测试** | `dsh-pet` 大肥鱼 114 WebM、`aboutme-pets` 9 角色、`crosspet` 角色包、`上首软糖体.ttf` | **CC BY-NC-SA 4.0 / 未明示** | 强制标记 `DEV_ONLY_NON_COMMERCIAL`；进入商业/公开直播前阻断并走自研替换管线 |
| **绝对红线（禁抄码）** | `newbeejmc/Dsh_douyin`、`fore-vip/dsh-live`、`Journey-Together` | **UNLICENSED** | 严禁复制一行源码；Gate 2 自动拦截 |
| **传染性红线（禁引入）** | `cortico-world-douyin-live`、`TShock`、`HEROsMod`、`dst-admin-go` | **GPL-3.0** | 严禁 vendor 引入，防止整仓传染 |
