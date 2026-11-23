# ARCHITECTURE — 鲸屿 Whale Isle 系统架构与演进方案 v2

> 架构师文档 · 2026-11-23（v2 同步真实代码拓扑）· 上游：[PRODUCT-DESIGN.md](./PRODUCT-DESIGN.md) v2、[SPEC.md](./SPEC.md)、[ROADMAP.md](./ROADMAP.md)（M0~M7）、[REFERENCES.md](./REFERENCES.md) §4
> 每个关键技术决策以 **ADR-x** 编号留痕（背景 / 选项 / 决策 / 后果）。本文与当前仓库代码保持严格同步，后续所有工单与 Agent 均以此为准。

## 1. 系统上下文（C4-L1）

```text
┌─────────────────────────── 使用者 ───────────────────────────┐
│   主人（桌面端）  ·  观众（直播间弹幕）  ·  远程浏览器（WebUI）   │
└────────┬──────────────────┬───────────────────────┬──────────┘
         │键鼠 / 对话        │弹幕 / 礼物             │HTTP / WS (:18780)
┌────────▼──────────────────▼───────────────────────▼──────────┐
│                 鲸屿 Whale Isle（本地优先桌面工作台）             │
│   Electron 主进程 + 中控台 Shell + 透明桌宠窗 + 内嵌 WebUI       │
└───┬──────────────────┬──────────────────┬────────────────────┘
    │每游戏独立 HTTP     │LLM / 决策 HTTP    │ACP (stdio)    │本地音频 HTTP/WS
┌───▼────────────┐ ┌───▼──────────────┐ ┌─▼─────────────┐ ┌▼────────────────┐
│ 多游戏桥接层     │ │ 模型与决策网关     │ │ Coding Agents │ │ audio-ai-worker │
│ · 星露谷 :18080 │ │ · OpenAI/Anthropic│ │ · gemini --acp│ │ · TTS 情绪路由   │
│ · 泰拉瑞亚:18090│ │ · OpenCode Go/Zen │ │ · dsh --acp   │ │ · 声音工坊/RVC   │
│ · 饥荒DST :18100│ │ · TypeSafe Jev S1 │ │ · claude(预留) │ │ · Python 3.11   │
│ · 本地 Ollama   │ │ · 本地 Ollama     │ └───────────────┘ └─────────────────┘
└────────────────┘ └──────────────────┘
```

**边界原则**：所有外部能力经四类标准面接入——**每游戏独立 HTTP 桥接（`GameAdapter`）**、**模型与决策网关（OpenAI / Anthropic / TypeSafe System One）**、**ACP stdio（外部 Coding Agents）**、**本地音频 Sidecar（`:18790`）**。

## 2. 容器视图（C4-L2）与进程拓扑

| 容器 | 进程 / 运行时 | 职责 | 通信方式 |
| --- | --- | --- | --- |
| **desktop-host main** | Electron 主进程（Node） | 多游戏自驾编排、聊天与多角色人设、记忆图谱宿主、Token 饭碗计量、安全凭据库（`safeStorage`）、Magpie/CC Switch 只读导入、ACP Client、星露谷 Mod 管理、内嵌 WebUI 服务（`18780`） | 单源多播（IPC 到渲染窗 + WS 推 WebUI） |
| **中控台 Shell 窗** | 渲染进程（React 19 + Tailwind v4） | v4「曜石」分组侧栏、聊天、记忆力导向图谱、声音工坊/音色库、桌宠舞台/114 动作库、星露谷/泰拉瑞亚/DST 面板、Mod 管理、OBS 预演、Harness、模型与服务商（v5.5）、插件与策略 | `directorBridge` preload IPC（渲染层禁直连外网与 SQLite） |
| **pet-stage 窗** | 透明置顶渲染进程 | VP9-Alpha 双 `<video>` 零黑帧渲染、脚底基准线、像素级 Alpha 穿透、拖拽抓取点与位置持久化、双轨气泡、多角色/多桌宠联机池 | preload 桥 + CustomEvent 中继 |
| **WebUI / OBS 服务** | 内嵌于 main（`127.0.0.1:18780`） | 远程状态查看、小鲸同款对话指令、ACP 远程审批；后续 OBS 透明挂件合并至同服务 `/obs` 路由（见 ADR-9） | HTTP + WebSocket（`/ui` token 鉴权） |
| **audio-ai-worker** | 独立 Python 3.11（`uv`） | 情绪感知 TTS 路由、声音工坊 5 端点（捏声/切片/调音/RVC 互斥锁/保存）、点歌 SVC 管线 | HTTP `:18790` + WS `/ws/audio` |
| **多游戏外部执行面** | 游戏内 Mod / 本地 Sidecar | 星露谷 BWF SMAPI Mod（`:18080`）、泰拉瑞亚 tML `terraria-bridge`（`:18090`）、饥荒 DST Lua Mod + `dst-bridge-sidecar`（`:18100`） | 每游戏独立本机 HTTP（见 ADR-10） |

## 3. 核心架构决策记录（ADR-1 ~ ADR-11）

- **ADR-1（WebUI 内嵌主进程）**：WebUI Server 内嵌于 Electron main（`127.0.0.1:18780`），启动生成 device token，直接复用同一事件总线与记忆/语音/自驾宿主，零跨进程状态同步开销。
- **ADR-2（渲染进程零直连）**：渲染进程禁止直连外部模型 API、文件系统或 SQLite（由 `dependency-cruiser` 机器强制）；明文 API Key 永不下行，仅在主进程 `safeStorage` 加密落盘。
- **ADR-3（外部插件兼容内核）**：`packages/plugin-kit` 封装 Cordis 语义（`manifest` / `defineTool` / 事件隔离 / LIFO 副作用回收 / `adaptDshPlugin`），兼容 dsh 生态插件。
- **ADR-4（ACP v1 先行）**：`packages/agent-harness` 锁定 ACP v1 stdio JSON-RPC（实机已打通 `gemini --acp` 与 `dsh --profile acp`，预留 `claude-agent-acp`），支持流式事件与 Y/N/A 远程审批。
- **ADR-5（主进程凭据与存储隔离）**：为规避 Node（vitest）与 Electron 原生模块 `better-sqlite3` 的 ABI 冲突，主进程运行时凭据采用 `safeStorage + provider-vault.json`，Token 流水与记忆图谱采用 JSONL 追加落盘；CC Switch SQLite 导入采用只读 CLI 通道，绝不修改原库。
- **ADR-6（语音与状态气泡独立订阅）**：桌宠语音（`voice-host`）与双轨气泡作为单源多播总线的独立订阅模块，不耦合进自驾规划器内部。
- **ADR-7（日志证据链与记忆摘要分离）**：游戏回执与会话事件按序落盘保留证据链；记忆图谱（`packages/memory-graph`）只存消毒后的可检索事件节点、边与换日自动日记（半衰期 30d / 钉住永存 / ≤600 字检索预算）。
- **ADR-8（插件化务实分层 · v2 新增）**：不再强行将所有内置页面拆为动态加载的三层插件。**核心内置能力**（聊天、记忆、声形、模型与服务商、多游戏自驾）作为一等公民直连主进程统一事件总线；`packages/plugin-kit` 专注托管**外部扩展与 `dsh` 兼容插件**及资源前缀 Policy 拦截（`vault://*` 代码级硬拒）。
- **ADR-9（WebUI 与 OBS 透明挂件同端口分路由 · v2 新增）**：原规划的独立 OBS 端口 `18765` 合并至现有内嵌本地服务 `18780`——`/ui` 与 `/api/*` 维持回环 + device token 鉴权，`/obs` 暴露只读透明挂件浏览器源（`STAGE_PROTOCOL=1`），减少一套端口与事件转发维护面。
- **ADR-10（多游戏 `GameAdapter` 与「判断归大脑、机制归护栏」· v2 新增）**：
  - 正式搁置早期 `18760` 中心 WS 网关设计稿，改为**每游戏模组/Sidecar 独立本机 HTTP + `GameAdapter` 统一适配层**（`packages/game-bridge-mcp/src/adapter.ts`）。星露谷 BWF（`18080`）原样包装为 `StardewAdapter`，泰拉瑞亚（`18090`）与饥荒 DST（`18100`）各自注册适配器与零 token 规则兜底。
  - 游戏卡死自救采用**救援问询架构**：确定性检测结构性卡死签名 → 向大脑发问询并注入原则与工具事实 → 由大脑现场决定动作顺序；护栏仅负责工具白名单、单日失败冷却、同物防重与离线阶梯兜底，避免硬编码穷举现场。
- **ADR-11（TypeSafe Jev System One 作为结构化判断首选 · 2026-11-23）**：
  - **背景**：官方 `POST /v1/systemone` 提供带 `choice` / `noul` / `score` 类型、候选分布与置信度的结构化答复；`typesafe/jev-router` 则是聊天协议模型，适合常规对话接入，但不等同于原生 System One 判断调用。
  - **决策**：对边界明确、输入和候选可控、结果可校验的判断点，优先使用 `typesafe-jev` 官方直连 System One。首批候选为聊天指令意图分类、弹幕快反注意力/风险分类、游戏真实回执异常归因；普通聊天与开放式自驾规划仍使用现有 chat 模型和 `GameAdapter` 规划接口，不把 System One 当作游戏执行器。
  - **安全与回退**：每个判断点需显式定义状态、问题、候选/criteria、置信度与 margin 阈值；按 shared-protocol 的 Zod 契约校验答复。低置信或含混结果交给原有流程、离线规则或人工处理；无论模型选择什么，执行仍受游戏工具白名单、动作互斥锁和真实回执约束，模型输出本身不构成动作完成证据。
  - **取舍与后果**：优先原生 System One，避免把分类任务伪装成自由文本 chat 并自行猜解析；OpenRouter `typesafe/jev-router` 可作为聊天形态的普通模型选择，但不替代原生结构化判断。此 ADR 记录接入优先级，不代表运行时判断节点已经接线；具体契约与首批节点仍由 `T-M6-14` 实现并验证。

## 4. 数据所有权矩阵

| 数据域 | 存储引擎 | 位置 | 隐私与清理 |
| --- | --- | --- | --- |
| UI 偏好、自定义服务商、默认模型绑定、逐模型测速与余额缓存 | Dexie（IndexedDB） | 渲染进程 | 设置页可重置 |
| 服务商 API Key（密文） | Electron `safeStorage` | `userData/provider-vault.json` | 明文不下行，删除即失效 |
| Token 真实计量与赛博饭碗 | JSONL + 状态快照 | `userData/meter/` | 1 粒米 = 1 Token，支持跨日重置 |
| 记忆图谱与换日日记 | JSONL Append-Only + 邻接表 | `userData/memory/` | 正文自动消毒 + `memory:wipe` 一键擦除 |
| 常客记仇账本 / 点歌缓存索引 | SQLite（`packages/local-store`） | `userData/workbench.db` | `wipeAllViewers` / `wipeAllData` |
| 星露谷 / 泰拉瑞亚 / DST 攻略 | Markdown 归档（`guide-forager/`） | 仓库根 / 打包 `extraResources` | 来源署名 + SHA1 去重 |

## 5. 当前代码库结构（Monorepo）

```text
packages/
  shared-protocol/      # 50 域 Zod 契约 + JSON Schema + Pydantic 跨语言导出器
  pet-renderer/         # VP9-Alpha 双 video 零黑帧渲染引擎 + 114 官方动作资产
  model-gateway/        # 10+ 内置预设（含 OpenCode Go/Console、TypeSafe Jev）、OpenAI/Anthropic 协议、脱敏与路由
  persona-brain/        # 三层人格、<think> 剥离、P0 雷区反射、饭碗经济
  game-bridge-mcp/      # GameAdapter 多游戏注册表 + Stardew/Terraria/DST 适配器 + LlmPlanner 救援问询
  memory-graph/         # 零依赖记忆图谱（2-gram + 2 跳扩展 + 半衰期 + 换日日记）
  live-stream-hub/      # 弹幕三级注意力调度 + 合并/连击 + 四级防封护栏
  plugin-kit/           # Cordis 语义插件内核 + defineTool + dsh 兼容层
  local-store/          # SQLite 常客/流水底座 + Dexie 配置库
  agent-harness/        # ACP v1 stdio 客户端 + gemini/dsh 探测 + 审批流
  stardew-mods/         # SMAPI Mod 扫描、启停与 ZIP 安装管理
apps/
  desktop-host/         # Electron 宿主（main / preload / director 中控台 / pet-stage 透明窗 / webui）
services/
  audio-ai-worker/      # Python 3.11 (uv) FastAPI：情绪 TTS + 声音工坊 + RVC 互斥锁
  dst-bridge-sidecar/   # 饥荒 DST 双面 HTTP 桥接（:18100）与本地专用服托管
mods/
  stardew-mcp-mod/      # 星露谷 C# SMAPI 桥接目录
  terraria-bridge/      # 泰拉瑞亚 C# tModLoader 模组（:18090，已编译 .tmod）
  dst-bridge/           # 饥荒 DST Lua 服务器权威模组（Klei 653007 通道）
tools/
  mock-harness/         # 星露谷/泰拉瑞亚/DST 仿真器 + 弹幕风暴回放 + 许可证/密钥扫描器
  guide-forager/        # MediaWiki 攻略采集清洗与导出管线
design/                 # v4「曜石」高保真交互原型（v3 归档于 design/v3-archive/）
```

## 6. 活跃工程风险与收口清单

| # | 风险 / 待收口项 | 影响 | 应对方案 |
| --- | --- | --- | --- |
| R1 | M7 泰拉瑞亚 / DST 尚未完成真机加载闭环 | 高 | 人类宿主加载 `terraria-bridge.tmod` 与配置 DST `cluster_token.txt`，逐项回填 `VERIFY.md` 右栏 |
| R2 | `autodrive-host.ts` 仍集中编排多游戏、persona 与 planner，后续扩展成本偏高；动态提示词、adapter 规则规划器、记忆日键热切换已实现 | 中 | 新逻辑沿 `GameAdapter` seam 接入；Host 拆分留待独立小工单，继续执行单工单业务源码 ≤8 文件约束 |
| R3 | 最新 macOS arm64 DMG 为 297,394,499 bytes，仍高于 `<200MB` 目标；打包态攻略路径已改为随包资源 | 中 | 纯前端 esbuild 依赖已移入 `devDependencies`，`guide-forager/` 与 persona fixture 使用 `extraResources`；后续按实际产物继续压缩并复测字节数 |
| R4 | 本地无 Developer ID 签名 | 低 | macOS 安装后执行 `xattr -dr com.apple.quarantine`；公开发布前再接入签名与公证 |
| R5 | TypeSafe Jev 原生 System One 尚未接入运行时判断节点（`T-M6-14`）；ADR-11 已明确优先接入的有界判断点 | 低 | `T-M6-14` 依 ADR-11 先接入聊天指令意图、弹幕快反分类或游戏回执归因之一；保持 Zod 校验、置信度门槛与既有安全护栏 |
| R6 | 开源与开发素材授权边界 | 中 | Gate 2 持续扫描密钥、UNLICENSED 与 GPL-3.0 传染源；商用前按 `THIRD_PARTY_NOTICES.md` 替换 `DEV_ONLY_NON_COMMERCIAL` 素材 |
| R7 | **多游戏 / 多桌宠状态隔离**：单例 autodrive 与联机 agent 池共用 `autodrive:event` 通道，渲染层未按会话归属过滤；切换游戏或同时运行两端点时可能把动作回执混到当前面板 | 高 | 事件链路与 P0 指令强制携带 `sessionId / gameId / generation`；渲染层只消费当前会话；增加「双 runner 并发 + 跨游戏切换」E2E；见 `T-M6-27` |
| R8 | **交付基线**：约 100 项工作区变化、69 个未跟踪文件、关键交付物未进 HEAD；泰拉瑞亚/DST/GameAdapter/sidecar 等在 HEAD 中不存在 | 高 | 按逻辑分批整理并提交；从干净 clone 跑 install/build/gate/启动；打 tag 再出安装包；见 `T-M6-28` |
| R9 | **门禁与验收**：无 CI；C#/Lua 构建不在统一门禁；真实 Electron E2E 未被 verify:gate 强制；无长时间 soak；泰拉瑞亚/DST 标 DONE 但真机未验收 | 高 | 引入 CI 工作流；把模组构建与核心 UI E2E 纳入门禁；建立 soak/跨日/断线/接管验收；工单状态显式区分「代码 DONE」与「真机已验收」；见 `T-M6-29` |
| R10 | **依赖与运行时安全**：Electron 与 Zod 的高危告警、契约层 Zod 主版本不一致 | 已收口 | **2026-11-23 完成（T-M6-30）**：Electron 38.8.6 → **45.4.1**、Zod 3.25.76 → **4.6.7**（全仓统一，移除 `zod-to-json-schema`，改用原生 `z.toJSONSchema`）；`pnpm audit --audit-level high` 无 high/critical；CI 与 `pnpm audit:high` 持续阻断。残留：Electron 45 的 `safeStorage` 同步 API 已弃用（功能正常），待后续迁移 async 版 |
| R11 | **能力边界与产品口径**：插件装载、直播闭环、OBS `/obs`、点歌、GPT-SoVITS 声音工坊、跨平台语音、独立安装包自包含等存在「UI/算法已有但运行时未接线或仍是 stub」的缺口 | 高 | 页面显式展示实际后端与未接线状态；文档把「算法完成 / 运行时接线 / 真机验收」分开；按最小真实链路逐个收口；见 `T-M6-31`。**2026-11-23 进展**：README 已改为如实能力边界表；语音顶栏已展示实际后端（`mcode / say / 未适配`，`T-M6-33`）；插件页/直播页仍待显式未接线标注 |
