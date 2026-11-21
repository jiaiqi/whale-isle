# ARCHITECTURE — 系统架构与开发方案 v1（定稿待确认）

> 架构师文档 · 2026-11-21 · 上游：[PRODUCT-DESIGN.md](./PRODUCT-DESIGN.md) v2（产品决策 D1~D10）、[SPEC.md](./SPEC.md)（冻结技术决策）、[ROADMAP.md](./ROADMAP.md)（M5/M6 工单）、[REFERENCES.md](./REFERENCES.md) §4（21+1 仓库代码级结论）
> 每个关键技术决策以 **ADR-x** 编号记录（背景/选项/决策/后果），推翻须留痕。本文是 M5/M6 工单的实现规格；工单开工时的决策声明引用本文相应 ADR。

## 1. 系统上下文（C4-L1）

```
┌─────────── 使用者 ────────────┐
│ 主人(桌面) · 观众(直播间) · WebUI(手机/他机浏览器) │
└──────┬───────────┬──────┬────┘
       │键鼠/对话   │弹幕    │HTTP/WS(审批+面板)
┌──────▼───────────▼──────▼────────────────────────────┐
│              大肥鱼工作台 (本机)                        │
│  Electron 桌面端 ＋ WebUI Server ＋ audio-ai-worker   │
└──┬──────────────┬───────────────┬───────────┬────────┘
   │MCP(18080)    │OpenAI兼容      │ACP(stdio) │本地GPT-SoVITS
┌──▼─────────┐ ┌──▼─────────┐ ┌───▼──────┐ ┌──▼─────────┐
│ 星露谷      │ │ 云端LLM供应商│ │ coding   │ │ Python音频  │
│ BWF Mod    │ │ (9家预设)    │ │ agents   │ │ (uv/3.11)  │
│ (SMAPI)    │ │             │ │ (已装CLI) │ │            │
└────────────┘ └─────────────┘ └──────────┘ └────────────┘
```

**边界原则**：所有外部系统只经三类标准面接入——MCP（游戏）、OpenAI 兼容 HTTP（模型）、ACP（agent）。新增任何外部能力（新游戏/新 agent/新硬件）都必须翻译到这三类面之一，禁止散点直连。

## 2. 容器视图（C4-L2）与进程拓扑

| 容器 | 进程 | 职责 | 通信 |
| --- | --- | --- | --- |
| **desktop-host main** | Electron 主进程 (Node 22) | PluginHost（插件 main 层）、总线网关 WS+JSON-RPC `18760`、**ACP Client**（spawn agent 子进程）、provider-vault（safeStorage）、policy 执行点、audit 落盘、**WebUI Server 内嵌**（`18780` HTTP 静态+审批通道） | WS 出站广播 / IPC 到两个渲染窗 |
| **Shell 窗**（director 演进） | 渲染进程 sandbox+preload | Shell UI、插件 renderer 层（React 面板/卡片）、zustand 全局态 | preload `directorBridge` ↔ main IPC；**业务数据一律走总线事件**（单源多播） |
| **pet-stage 窗** | 渲染进程（透明/穿透） | 桌宠渲染、气泡、动作池 | preload 桥 + 总线转发的 CustomEvent（T-M1-02 既有机制） |
| **audio-ai-worker** | 独立 Python 3.11 (uv) | TTS 情绪路由 / SVC（Demucs+RVC）/ 语音锁 | HTTP `/tts/*` + WS `/ws/audio` |
| **外部：BWF Mod** | 游戏内 SMAPI | 星露谷执行器（81 工具） | MCP Streamable HTTP `18080` |
| **外部：agents** | CLI 子进程 | Claude Code / Codex / dsh | **ACP** over stdio（JSON-RPC） |

ADR-1（WebUI 独立进程 vs 内嵌 main）：**内嵌**。同一 Node 运行时零重复、总线直接复用；server 仅暴露静态 Shell 资源 + 总线 WS + 审批 API，`bind 127.0.0.1` + 首次启动生成 device token（浏览器配对）。后果：main 崩则 WebUI 同崩——可接受（同机服务），换来自愈简单（一个 watchdog）。

ADR-2（渲染进程数据访问）：渲染进程**禁止**直连任何外部 API/数据库（depcruise 既有规则），一切业务状态经总线事件单向流：`bus event → zustand store → React`。后果：WebUI 复用免费（同一事件流），测试只需 mock 总线。

## 3. 插件系统（D6/D7 核心）——组件视图

### 3.1 三层插件结构（对齐 dsh-plugin-yushe host/client/shared）

```
plugins/<plugin-id>/
├── manifest.json        # id/name/版本/lucide图标/扩展点声明/权限声明(policy资源前缀)/dsh兼容标记
├── main.ts              # 主进程层：defineTool + 总线事件订阅 + 服务(可访问fs/net/child_process，经policy)
├── renderer.tsx         # Shell 层：面板路由组件 / 右栏卡片 / 侧栏元数据（React lazy 注册）
└── shared.ts            # 纯函数规则核心 + 契约类型（两端共用，可被单测覆盖）
```

### 3.2 PluginHost（主进程）

ADR-3（PluginHost 内核选型）：**直接采用 `@cordisjs/core`（MIT）作为插件容器**。理由：dsh/deepseek-harness 本身即 Cordis——`ctx.plugin()` 装载 dsh 插件即天然兼容（D7 的最大公约数）；typed events、插件树、可逆副作用（dispose）开箱即得。自实现 mini 容器会造成第二套插件语义。后果：引入 cordis 依赖（锁版本 + 薄封装 `packages/plugin-kit` 隔离 API 面）；Cordis 生态概念（Context/Service）对插件作者有学习成本——用 manifest 声明式封装屏蔽大部分。

- **工具注册**：`defineTool({name, schema(zod), policy, execute})` → registry → 总线 JSON-RPC 方法暴露（`tool.<plugin>.<name>`）→ LLM（autodrive）与 UI（Shell）同源调用。
- **事件**：插件内 `ctx.on('domain:event')` ↔ 总线广播互相桥接（`packages/plugin-kit/bridge.ts`）。
- **扩展点**（Shell 侧消费）：`sidebar.item` / `panel.route` / `aside.card` / `pet.animation` / `pet.line` / `overlay.widget`。
- **生命周期**：enable → ctx.plugin() 装载；disable → dispose（可逆副作用）→ 渲染层卸载组件+解绑事件。崩溃隔离：每个插件 main 层包 try/catch + cordis 容器隔离，插件挂不发核。
- **权限执行点**：policy 检查在 **main 层工具 execute 之前**（单一咽喉），deny 直接拒 + audit；ask 生成审批事件（总线广播到 Shell 卡片 + WebUI 通道），Y/N/A 语义回填（FeiyuOS 状态机）。凭据路径 `vault://` 硬拒——`allow_all` 也不能放行（代码级，非配置级）。

### 3.3 dsh 兼容层（T-M6-03）

- Cordis 插件原样 `ctx.plugin(import(...))`；defineTool 适配器把 dsh 工具签名翻译为我们的 tool 契约；typed events 映射到总线域。
- 兼容矩阵测试夹具：一个样例 dsh 插件（从 dsh-plugin-yushe 抽最小闭包）走完整 enable→调用→disable 断言。
- 不兼容即记录 REFERENCE 档案 + 适配说明，禁止为兼容改 dsh 插件源码。

## 4. Agent Harness（D8）——ACP 集成

ADR-4（ACP 版本策略）：**先落 ACP v1 稳定面，v2 特性（usage/plans/compaction/agent-terminal）渐进探测**（agent initialize 响应里协商）。理由：Registry 存量 agent 多为 v1；v2 预览易漂移（t3code 亦如此）。后果：v2 富信息（用量/计划）后置到 T-M6-02 第二步。

- **ACP Client**（主进程 `packages/agent-harness/`）：spawn `claude-agent-acp` / `codex acp` / `dsh --profile acp` 子进程，stdio JSON-RPC；生命周期（启动/重连/超时/崩溃重启——wd 模式）。
- **线程模型**：Thread = SessionEvent JSONL（userData/threads/<id>.jsonl，deepseek-harness 格式：模型所见必可从日志重建）；checkpoint = 线程内锚点（可回滚展示）；换 agent = 同线程追加 provider 段。
- **审批**：agent 工具请求 → 总线审批事件 → Shell 卡片 + WebUI 远程（`18780` 配对通道）；Y/N/A 回填 stdin。
- **用量归属**：按 provider 实例记账进 token_ledger（magpie agentOf 思路：每实例独立 token）。

## 5. 数据架构（所有权矩阵）

| 数据 | 存储 | 位置 | 隐私路径 |
| --- | --- | --- | --- |
| Shell/插件配置、providerOverrides、diningProfiles | Dexie (IndexedDB) | 渲染进程 | 设置页一键擦除 |
| API Keys（密文） | safeStorage + provider-vault.json | userData | 删除文件即失效 |
| 常客账本 / token_ledger / 点歌缓存 | SQLite（better-sqlite3 WAL） | userData/workbench.db | wipeAll 既有 API |
| 记忆图谱 | JSONL+墓碑压实（feiyuos-memory-graph 移植） | userData/memory/ | 按 scope 删节点 |
| 线程 SessionEvent / 审计 / 技能卡 | JSONL 追加 | userData/threads · audits · skills | 会话删除 + 轮转（5MB） |
| 星露谷长期笔记 | BWF 侧（update_notes，随存档） | 游戏存档 | 游戏侧管理 |

ADR-5（SQLite 与 ABI 冲突的最终解法）：**账本等 SQLite 真需求在 T-M5-04 前立 `electron-rebuild` 管线工单**（CI 级，非临时 hack）：Node ABI（vitest）与 Electron ABI 各持一份预编译产物，`SqliteStore` 按运行时选择 binding 路径。在此之前主进程继续文件 KV/JSONL（既定边界不破坏）。后果：多一个构建步骤，换两项单测与主进程共用同一份真存储。

## 6. 一次指令的生命周期（贯穿数据流 · 单源多播）

```
主人输入「去钓鱼」(Shell)
  → renderer bus.send('chat.command', {text, priority:'P0'})
    → main autodrive 编排器: policy 检查 → 插队队列
      → persona-brain 系统提示 + <think> 流式
        → model-gateway(粘性路由/脱敏/计量→token_ledger)
          → LLM tool-calling → game-bridge-mcp(18080) → BWF 执行
            → 回执 COMPLETED/FAILED/UNCERTAIN
              → bus 广播 'stardew.receipt'  ┐
                  ├ Shell 聊天流(工具卡片)   │ 同一事件
                  ├ pet-stage 动作+台词气泡  │ 单源多播
                  ├ 右栏 aside 卡片          │
                  ├ OBS overlay (18765)      ┘
                  └ memory-graph 事件入库
```

核心不变式：**任何功能（含插件）都是总线事件的订阅者/发布者，不存在旁路**。这保证插件可插拔、WebUI 免费、全程可审计。

ADR-7（游戏日志与记忆的写入链）：autodrive 每步 SessionEvent JSONL（事件溯源）→ **两路订阅**：a) 记忆图谱抽取（事件→event 节点+viewer 实体，换日归纳为日记）；b) Shell 时间线/OBS。直播侧弹幕事件同样双写 grudge_ledger（即时账本）+ 记忆图谱（长期），下播提炼只读图谱。——「做过什么」永远可查（日志=证据链，记忆=可检索摘要），二者职责分离（dsh-fish capture.js growth_commit 唯一写入口 + dsh-pet 内部 id 永不进记忆正文两条既有铁律继续生效）。

ADR-6（语音与状态气泡 = 总线订阅者，非编排器内部件）：桌宠语音（D11）与状态气泡组（D12）**不进 autodrive 编排器**，而是 pet 插件的两个独立订阅模块：`voice.ts` 订阅 `stardew.receipt / chat.line / persona.think-段` 事件按 PRODUCT-DESIGN §2.4 场景矩阵产生语音租约（复用 AudioLeaseManager 队列与节流器）；`status-bubble.ts` 订阅 `stardew.state/goal` 维护气泡状态机（紧凑条⇄展开卡⇄弹泡 3.5s 收起）。后果：声音/气泡可独立开关（它们本身是扩展点）、WebUI 下桌宠窗不存在但状态条组件可复用在 Shell 卡片；编排器保持纯决策不掺表现层。

## 7. 安全架构（运行时安全锁落地）

1. **Policy 单咽喉**：所有 main 层工具调用过 policy（按 manifest 声明的资源前缀）；`vault://` 硬拒代码级。
2. **审批三键**：Y 执行 / N 拒绝回喂 LLM（小鲸会"知道"被拒） / A 本类全过（记录到会话级 allowlist，可撤销）。
3. **审计链**：policy 决定 + cheat 写操作 + harness 工具执行 → JSONL 追加（5MB 轮转）。
4. **CheatBridge**：插件级开关（默认关）+ policy `cheat://` ask + before/after 快照强制。
5. **运行期安全锁（AGENTS.md §3.5）**：LLM 永不接触代码执行工具——工具面白名单来自 manifest policy，模型无法越权发明能力。
6. **WebUI 安全**：bind 127.0.0.1 + device token 配对 + 总线写操作一律走审批（浏览只读放宽）。

## 8. 工程结构（monorepo 增量）

```
packages/
  shared-protocol/      # 24 域 → 插件/线程/policy 契约扩展（T-M6-01 起）
  plugin-kit/           # NEW: PluginHost 封装(cordis 薄层) + defineTool + 桥 + manifest schema
  agent-harness/        # NEW: ACP client + 线程/SessionEvent + 用量 (T-M6-02)
  memory-graph/         # NEW: feiyuos-memory-graph 移植 (T-M5-04)
  game-bridge-mcp/      # NEW: BWF MCP 客户端+互斥锁+看门狗 (T-M5-02)
  {model-gateway,persona-brain,local-store,pet-renderer,local-store}  # 既有=内核
apps/
  desktop-host/
    src/main/           # + plugin-host.ts · agent-host.ts · webui-server.ts · policy.ts · audit.ts
    src/renderer/shell/ # director 演进为 Shell：插件 renderer 动态注册
    src/renderer/pet-stage/  # 保持独立透明窗
services/audio-ai-worker/  # 既有
plugins/                   # NEW workspace 顶层：每个内置插件一个目录
tools/mock-harness/        # + plugin-harness(dsh 夹具) · acp-simulator(假 agent)
```

## 9. 开发方案：三轨并行 + 合流（M5/M6 执行计划）

```
轨道A(素材)   T-M5-01 官方webm移植+manifest ──────────────┐
轨道B(Shell)  T-M6-01 Shell+插件内核(chat并) ── T-M6-03 dsh兼容层 ── T-M6-04 WebUI
轨道C(游戏)   T-M5-02 game-bridge+自动驾驶 ──┬───────────────┘
                                            └→ 合流验收: 全自动玩+聊天指挥+插件开关+WebUI审批 E2E
(后置) T-M6-02 ACP Harness 依赖 B 的 Shell 审批卡；T-M5-04 记忆图谱依赖 ADR-5 rebuild 管线
```

| 工单 | 预估文件 | 门禁映射 | 回退方案 |
| --- | --- | --- | --- |
| T-M5-01 | assets/ ~6 文件（素材批量+manifest+台账） | Gate1/2/3 + 视觉断言 | 素材格式异常→回退 v1 DEV 水印素材，管线独立重跑 |
| T-M6-01 | plugin-kit 4 + shell 6 + shared-protocol 2 | + 插件 E2E（禁用卸载断言） | cordis 不合→自实现 mini 容器（API 面已隔离） |
| T-M5-02 | game-bridge-mcp 5 + plugins/stardew 4 | + 仿真 5 剧本 + 看门狗断言 | BWF 协议漂移→mock-harness 先行闭环 |
| T-M6-02 | agent-harness 5 + shell harness 面板 4 | + ACP 夹具 + 审批 E2E | v2 协议漂移→锁 v1 |
| T-M6-03 | plugin-kit/bridge 3 + 夹具 3 | + dsh 样例插件全生命周期 | 个别插件不兼容→记录档案按需适配 |
| T-M6-04 | webui-server 3 + bridge 双实现 4 | + 双宿主渲染断言 + 远程审批 E2E | 安全存疑→仅本地回环+只读模式先行 |

**里程碑验收（M5+M6 全绿 = 一次端到端演示）**：启动工作台 → 插件页开启 stardew → 小鲸自动读档玩星露谷（回执流+桌宠联动）→ 聊天输入 /goto 指令插队 → Harness 页派活给 Claude Code 并远程审批 → 关掉 stardew 插件系统无痕卸载 → WebUI 手机端看到同一状态并批准一个 pending 操作。

## 10. 独立运行（D14 硬约束）

**自包含原则**：仓库是唯一事实源——素材入 git（pet-renderer/assets 55MB ✓）、契约生成物可重生成、Python worker 随包；运行时零 `~/Documents/vibe/reference-clones` 引用，参考仓库仅存于开发期分析。
**打包（T-M6-05）**：electron-builder；BWF Mod（MIT）文件随包，首启向导一键复制进游戏 Mods；GPT-SoVITS 本地模型为可选下载（云端 TTS 兜底）；CI 干净环境冒烟测试（无外部路径依赖）。

## 11. 风险登记册

| # | 风险 | 概率/影响 | 缓解 | 回退 |
| --- | --- | --- | --- | --- |
| R1 | cordis API 演进破坏兼容 | 中/中 | 锁版本+plugin-kit 薄封装 | mini 容器自实现（ADR-3 已留面） |
| R2 | dsh 插件依赖 node 原生模块或越权 | 中/高 | policy 单咽喉+manifest 权限声明+兼容矩阵夹具 | 不兼容插件标记 unsupported |
| R3 | ACP v2 预览漂移 | 中/中 | v1 先行、v2 特性探测开关 | 锁 v1（ADR-4） |
| R4 | better-sqlite3 ABI 双运行时 | 高/中 | ADR-5 rebuild 管线独立工单 | 文件 KV/JSONL 过渡（现状） |
| R5 | BWF MCP 长动作超时语义 | 中/高 | 看门狗：超时≠失败，get_state 确认制 | cancel_action 兜底 |
| R6 | 总线事件风暴（弹幕+回执） | 低/中 | 事件中枢批量 flush 150ms + 去重（dsh-livestream 机制） | 订阅端背压丢弃策略 |
| R7 | WebUI 暴露面 | 低/高 | 127.0.0.1 + token 配对 + 写操作强制审批 | 关闭 WebUI 开关（本身是插件） |
| R8 | 素材授权未来商用 | 低/低（D5 豁免） | 素材台账登记来源 | 商用前整包清洗（REFERENCES §3） |
