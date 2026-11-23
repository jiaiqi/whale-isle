# SPEC — 《鲸屿 Whale Isle 产品需求与技术架构总纲》

> 状态：**核心产品定位、人设机制、技术选型与开源复评原则已完全闭环冻结。**
> 分工：本文件管「做什么 / 为什么」；[AGENTS.md](../AGENTS.md)（AI 自治开发最高宪章）管「AI 怎么改代码」；[ROADMAP.md](./ROADMAP.md) 是冻结的工单清单。

---

## 1. 冻结的 4 项底层工程默认决策

- **进程间通信与协议总线**：全局统一采用 **WebSocket + JSON-RPC 2.0（兼容 MCP 协议）**。Electron 主进程作为本地消息中心（端口默认 `18760`），统管桌宠渲染窗、主播中控台、OBS 浏览器挂件源、Python 音频 Sidecar 与《星露谷》SMAPI Mod。
- **本地数据持久化方案**：中控台前端状态缓存与配置即时响应采用 **Dexie.js (IndexedDB)**；跨进程共享的常客账本、桌宠长期记忆、Token 消耗流水与点歌缓存索引统一落盘至本地 **SQLite（Node 侧 `better-sqlite3`）**，做到 100% 本地优先、断网可用。
- **直播画面合成优先策略**：第一阶段优先采用 **OBS Browser Source（本地透明网页源，端口 `18765`）** 输出桌宠、双轨气泡、赛博饭碗、歌词与弹幕投票框，零 CPU 编码损耗且兼容 macOS/Windows；内置 FFmpeg 多路 RTMP 推流作为第二阶段可选模块接入。
- **Python 跨平台环境隔离**：音频与 AI 推理服务统一使用 **`uv`** 管理独立的 Python 3.11 虚拟环境，启动时自动探测硬件后端（macOS Apple Silicon 自动挂载 `mps`，Windows N 卡自动挂载 `cuda`，无独显自动回退 `cpu`）。

---

## 2. Monorepo 全局目录结构与模块边界

AI 自动开发最容易出现「跨模块乱引代码、把逻辑写进 UI 组件」的腐化问题，必须通过物理目录强制隔离职责：

```text
whale-isle/
├── AGENTS.md                        # AI 自治开发最高宪章（质量门禁、复评纪律、禁止事项）
├── docs/
│   ├── SPEC.md                      # 产品需求与架构规范（本文档）
│   ├── ROADMAP.md                   # 冻结的阶段迭代计划与任务工单状态
│   ├── VERIFY.md                    # 验收标准矩阵（严格区分 Mock 测试与真机实测）
│   ├── REFERENCES.md                # 开源参考项目清单与复评规则
│   └── THIRD_PARTY_NOTICES.md       # 第三方开源代码与素材许可证台账
├── packages/
│   ├── shared-protocol/             # [零依赖核心层] Zod 强类型契约：事件总线、MCP 回执、人设与配置 Schema
│   ├── pet-renderer/                # [渲染抽象层] IPetAvatarRenderer 接口、WebmVideoRenderer (dsh-pet)、预留 Live2D
│   ├── model-gateway/               # [模型网关层] CC Switch 供应商接入 + Magpie 角色路由/干饭套餐/Token 计量/脱敏
│   ├── persona-brain/               # [人格与记忆层] 三层人格引擎、0.1s 雷区反射钩子、<think> 解析、常客记仇账本
│   ├── game-bridge-mcp/             # [游戏控制层] MCP 客户端、动作互斥锁、uncertain 状态机、键鼠接管检测器
│   └── live-stream-hub/             # [直播编排层] dyhub/B站事件归一、P0/P1/P2 注意力队列、节目状态机、点歌队列
├── apps/
│   └── desktop-host/                # [Electron 跨平台宿主]
│       ├── src/main/                # 主进程：透明穿透窗管理、全局快捷键、SQLite 服务、Python Sidecar 守护
│       ├── src/renderer/pet-stage/  # 桌面透明桌宠窗口（WebM 渲染 + 双轨气泡 + 赛博饭碗小挂件）
│       ├── src/renderer/director/   # 主播中控台（React + Tailwind：模型配置、人设微调、直播控制台、切片导出）
│       └── src/renderer/obs-layer/  # OBS 专用透明浏览器源（高帧率字幕、点歌歌词滚屏、弹幕投票面板）
├── services/
│   └── audio-ai-worker/             # [Python 独立推理进程] FastAPI + WebSocket
│       ├── tts_engine/              # 本地 GPT-SoVITS v2 (MPS/CUDA) + 云端 OpenAI/SiliconFlow/FishAudio 混合路由
│       ├── svc_singing/             # Demucs v4 伴奏分离 + RVC v2 歌声转换 + 切片流式预缓冲 + 磁盘缓存池
│       └── asset_pipeline/          # 移植自 dsh-pet 的绿幕视频抠像、脚底对齐转 VP9-Alpha WebM 自动化工具链
├── mods/
│   └── stardew-mcp-mod/             # [C# SMAPI Mod] 基于 BlindWhaleFarmer 改造的跨平台星露谷状态感知与动作执行器
└── tools/
    └── mock-harness/                # [AI 自测沙盒] 模拟星露谷 MCP 服务端、模拟抖音高频弹幕发生器、音频回环校验器
```

> 物理目录即架构边界：依赖方向由 `dependency-cruiser` 在 Gate 1 强制校验（例如 UI 层严禁直接 import 数据库或绕过 `model-gateway` 直接调 LLM API）。

---

## 3. 核心业务模块详细设计

### 3.1 模块一：跨平台桌宠宿主与渲染引擎（`pet-renderer` & `desktop-host`）

- **透明渲染与跨平台一致体验**：
  - 利用 Electron Chromium 内核原生支持 VP9 Alpha 通道的特性，在 macOS 和 Windows 上统一加载 `dsh-pet` 的 `.webm` 透明视频资产包。
  - 采用双 `<video>` 标签无缝交叉淡入（Cross-fade）机制消除动作切换时的黑帧/闪白。
- **像素级鼠标穿透（Pixel-Perfect Click-Through）**：
  - 在 `pet-stage` 渲染进程中，每 50ms 对当前视频帧绘制到离屏 `1x1` Canvas 读取鼠标所在坐标的 Alpha 值：当 `alpha > 20`（鼠标在"大肥鱼"身体或气泡上）时，调用 `win.setIgnoreMouseEvents(false)` 允许拖拽、抚摸和右键菜单；当 `alpha <= 20`（透明空白处）时，调用 `win.setIgnoreMouseEvents(true, { forward: true })`，让鼠标点击直接穿透到底层的《星露谷》或桌面图标。
- **物理交互与语音回执锁**：
  - 完整移植 `dsh-pet` 的多显示器异构 DPI 边界碰撞、鼠标拖拽甩抛、落地 Q 弹挤压形变（Squash & Stretch）与脚底基准线对齐。
  - 实现**带 TTL 超时的单端语音播放锁**：任何模块触发桌宠说话或唱歌，必须获取 `AudioLease(ttlMs)`，待前端 WebAudio 触发 `onended` 真实回执或超时后才释放锁，彻底杜绝两段话叠音或动作嘴型错位。

### 3.2 模块二："大肥鱼（蓝鲸女仆）"三层人格引擎（`persona-brain`）

将"傲娇干饭蓝鲸女仆"全部转化为结构化的 `persona.json` 规范，后续新增第二个、第三个桌宠只需新建一份 JSON 与对应语音包：

```json
{
  "id": "blue-whale-maid",
  "name": "小鲸（大肥鱼）",
  "title": "傲娇干饭蓝鲸女仆",
  "ownerAddressing": ["鱼片", "主人"],
  "avatarPack": {
    "renderer": "webm-alpha",
    "manifestPath": "assets/pets/blue-whale-maid/manifest.json",
    "tailMoodIndicator": true
  },
  "reflexRules": [
    {
      "id": "taboo-fat-fish",
      "triggerRegex": "(大肥鱼|胖鱼|肥鲸|多少斤|水桶腰|卡门)",
      "cooldownMs": 8000,
      "priority": "P0_INTERRUPT",
      "actionState": "rage_spray",
      "ledgerTag": "叫我大肥鱼的坏蛋",
      "presetVoicePool": [
        "才……才不是大肥鱼呢！这叫流线型深海水动力女仆！鱼片你再乱叫今晚不给你浇菜了！",
        "噗——（喷水抗议）你才胖！人家这叫饱满的算力储备，懂不懂呀！"
      ]
    }
  ],
  "innerVoiceConfig": {
    "enabled": true,
    "parseTag": "think",
    "bubbleStyle": "cloud-translucent",
    "derailmentProbability": 0.35,
    "derailmentThemes": ["今晚吃几碗白米饭配红烧肉", "偷偷观察鱼片今天写代码的侧脸", "刚刚路过的蝴蝶好漂亮"]
  },
  "riceBowlEconomy": {
    "dailyTokenBudget": 500000,
    "lowRiceThreshold": 0.15,
    "starvingActionState": "hungry_lazy",
    "sideDishBuffs": {
      "ragContextAttached": { "name": "攻略红烧肉", "intelligenceBoost": "high_reasoning", "durationSec": 600 },
      "giftReceived": { "name": "豪华海鲜饭", "workEthicMultiplier": 2.0, "durationSec": 300 }
    }
  },
  "stardewStrategyWeights": {
    "defaultMode": "lazy_smart_fish",
    "modes": {
      "lazy_smart_fish": {
        "farmingProfit": 0.3,
        "npcGossipAndTrashCan": 0.85,
        "miningCombat": 0.2,
        "slackingAndScenery": 0.9,
        "minStaminaToWork": 0.45
      },
      "serious_maid_for_owner": {
        "farmingProfit": 0.95,
        "npcGossipAndTrashCan": 0.3,
        "miningCombat": 0.75,
        "slackingAndScenery": 0.1,
        "minStaminaToWork": 0.15
      }
    }
  }
}
```

> ⚠️ 上面 JSON 为**示意样例**；运行期配置的权威形状以 `packages/shared-protocol` 的 Zod Schema（`PetPersonaConfigSchema` 等）为准，字段命名以 Schema 为准（如 `presetResponses` / `ledgerGrudgeTag` / `ownerTitles`），任何 `persona.json` 必须通过其校验。

### 3.3 模块三：模型与供应商网关（`model-gateway` — 融合 CC Switch & Magpie）

- **两步式供应商配置（CC Switch 范式）**：
  - 内置供应商预设库（DeepSeek 官方、SiliconFlow 硅基流动、OpenRouter、火山方舟、OpenAI、Anthropic、MiniMax、本地 Ollama / MLX / GPT-SoVITS）。
  - 支持同一厂商下通过 `Region（国内/海外）` 与 `Plan（按量 API / Coding 套餐）` 胶囊开关切换端点，提供 `/v1/models` 一键拉取测试与 `Full URL` 免拼接开关。
- **单屏 6 角色绑定与"干饭套餐"切换（Magpie 范式）**：
  - 单屏直观绑定 6 个槽位：`[主脑与内心戏]`、`[星露谷规划器]`、`[弹幕快反路由]`、`[翻车视觉复盘]`、`[日常说话 TTS]`、`[点歌演唱 SVC]`。
  - 顶部常驻 3 个全局 Profile 胶囊：**【🍚 省饭摸鱼档】**、**【🍱 豪华直播档】**、**【🛡️ 本地断网档】**。
- **粘性路由组（Sticky Routing）与隐私脱敏网关**：
  - 会话内固定路由至同一 API Key 节点以最大化命中 DeepSeek Context Caching（降低 80% 静态人设与星露谷地图描述的"吃白饭"速度）；节点报 429/5xx 时 100ms 内静默切换备用 Key。
  - 所有发往云端模型的 Prompt 自动经过本地正则脱敏器，屏蔽本机用户名、绝对路径、API Key 与剪贴板隐私。

### 3.4 模块四：本地显卡优先 + 混合云端音频引擎（`audio-ai-worker`）

- **日常说话轨（Emotional TTS）**：
  - 本地优先使用 **GPT-SoVITS v2**（macOS `mps` / Windows `cuda`），为"大肥鱼"预置 5 组 5 秒情绪参考音频（`[嘴甜常态]`、`[傲娇反驳]`、`[破防喷水]`、`[困倦摸鱼]`、`[干饭兴奋]`）。
  - 大模型回复格式强制带有情绪前缀（如 `[傲娇反驳] 哼，本鱼才没有偷懒！`），网关自动剥离前缀并路由至对应参考音频生成语音，同时驱动桌宠切换对应 `.webm` 动作。
- **点歌演唱轨（Streaming SVC 点歌台）**：
  - **处理流水线**：收到点歌指令 → 校验违禁曲目黑名单 → 命中本地缓存池（`cache/songs/blue-whale-maid_<hash>.ogg`）则直接秒播 → 未命中则调用 **Demucs v4** 分离人声与伴奏 → 先对前 25 秒人声切片执行 **RVC v2 (RMVPE)** 声线转换并与伴奏混音 → 桌宠进入 `sing` 舞台状态开唱，后台异步完成剩余切片并无缝拼接落盘。

### 3.5 模块五：《星露谷物语》MCP 具身代理与丝滑共玩（`game-bridge-mcp`）

- **真实执行回执铁律**：
  - 吸收 `BlindWhaleFarmer` 核心机制，C# SMAPI Mod 将游戏内的农田坐标、背包、体力、时间、周围 NPC 封装为结构化状态树，并将动作封装为原子级 MCP Tools（如 `till_soil`, `water_crops`, `talk_to_npc`, `go_to_location`）。
  - **严禁大模型口嗨代替结果**：每次动作返回明确的 `COMPLETED | FAILED(reason) | UNCERTAIN(timeout/blocked)`。当返回 `FAILED` 或 `UNCERTAIN` 时，自动触发"大肥鱼"的冒失甩锅台词（"呜哇！石头自己跳出来绊倒本鱼了！"），并写入短期记忆防止死循环撞墙。
- **键鼠一动即接管（Seamless Co-Play）**：
  - Mod 实时监听本地物理键鼠/手柄输入。一旦检测到主人（鱼片）按下方向键或点击鼠标，**0.1 秒内挂起 AI 动作锁**，桌宠立即切换为"场边解说陪玩模式"（"哇，鱼片亲自操作了！快帮我把那个矿石敲掉~"）；当物理输入静默超过 8 秒，自动弹窗询问或平滑接回自动驾驶权。

### 3.6 模块六：直播大脑、注意力调度与高光切片（`live-stream-hub`）

- **三级注意力优先级队列（Attention Arbiter）**：
  - **P0（即时抢占）**：主人接管指令、"大肥鱼"雷区关键词反射、高价值礼物（投喂红烧肉）、星露谷生命值濒危。
  - **P1（节拍器调度，每 4~6 秒一拍）**：当前点歌演唱、合并后的高频弹幕问答、弹幕议会（20 秒投票决定游戏走向）、阶段性任务完成汇报。
  - **P2（空闲填补）**：进房欢迎（查询"常客记仇/好感账本"翻旧账）、无弹幕时的内心戏碎碎念或节目状态机切换（打游戏 ↔ 中场点歌 ↔ 杂谈读评论）。
- **高光/翻车切片自动打点（基于 `dsh-video-storyboard` 思路）**：
  - 维护本地 45 秒环形视频/事件缓存。当出现"大肥鱼在矿洞晕倒"、"炸毁自家农田"、"弹幕哈哈哈哈密度激增"时，自动截取录像并在下播后调用视觉模型生成带毒舌复盘字幕的短视频草稿，严格受每日视觉预算上限控制。

---

## 4. AI 全程自动化开发与质量控制体系（AI-Native QA Harness）

> 详细章程落在 [AGENTS.md](../AGENTS.md)，此处仅记录设计动机：全部用 AI 自动写代码开发跨平台复杂软件时，最常见的四大死法是——
> **① 跨会话失忆导致架构腐化**、**② 模块间接口靠"猜"导致联调全崩**、**③ AI 自己写全套 Mock 假测试骗你说"测试通过"**、**④ 缺乏真实游戏/直播间环境导致 AI 无法自闭环调试**。
> 对应解法为「五层铁笼」：契约先行、本地仿真沙盒、四道自动化门禁、防失忆原子工单流、运行时安全锁。

---

## 5. 全周期开发路线图与里程碑验收表（Roadmap & Milestones）

整个工程切分为 **5 个可由 AI 逐步自动构建、每步都有清晰验收标准的里程碑**：

| 里程碑 | 核心交付目标 | AI 自动化验收标准（Gate） | 你（人类宿主）只需做的 3 分钟真机抽检 |
| --- | --- | --- | --- |
| **M0：工程地基与契约铁笼** | 搭建 Monorepo、Zod 跨语言协议生成、SQLite 基础层、仿真沙盒工具与 `pnpm verify:gate` 门禁脚本 | 4 道 CI 门禁全部跑通；契约生成脚本零报错 | 无需手动测 UI，查看 `verify:gate` 绿灯即可放行 |
| **M1："大肥鱼"桌面复活 + 模型网关** | Electron 跨平台透明穿透窗、移植 `dsh-pet` WebM 渲染与物理引擎、实现 CC Switch + Magpie 模型网关与"大肥鱼"人设（内心戏气泡+饭碗+雷区反射） | Playwright 自动验证透明穿透、双轨气泡渲染、雷区正则 <100ms 拦截与粘性路由故障转移 | 在 Mac 桌面上拖拽"大肥鱼"，在输入框打一句"大肥鱼"，看她是否瞬间喷水破防并弹出 `<think>` 内心戏气泡 |
| **M2：本地 GPU 语音与点歌台** | Python `uv` Sidecar 服务、GPT-SoVITS 情绪语音路由、Demucs+RVC 切片流式唱歌、语音 TTL 播放回执锁 | 音频回环测试验证：连续发 5 条消息绝不叠音；点歌首切片生成的 OGG 文件非空且二次点歌命中缓存 <50ms | 听一下 Mac M 系列芯片本地生成的傲娇语音延迟，点一首歌听她用自己的声音唱出来 |
| **M3：《星露谷》自动驾驶与丝滑共玩** | 基于 `BlindWhaleFarmer` 改造 C# SMAPI Mod、接入摸鱼/认真双态权重、实现真实回执与翻车找补、键鼠一动即接管 | `stardew-mcp-simulator` 5 个标准剧本（含 `uncertain` 卡死与玩家接管）100% 断言通过 | 打开《星露谷》，看她自己去翻垃圾桶/种菜；你晃一下鼠标，看她是否立刻停手变成场边啦啦队 |
| **M4：抖音直播大脑、OBS 图层与切片** | 接入 `dyhub` 弹幕流、P0/P1/P2 注意力调度、常客记仇账本、节目状态机、OBS 透明挂件源与高光翻车切片 | `danmaku-storm-replay` 高并发弹幕压测不崩、敏感词 100% 拦截、环形缓存正常导出切片草稿 | 在 OBS 添加 `http://localhost:18765` 浏览器源，挂测试直播间看她边玩星露谷边回弹幕、记仇和唱歌 |

> 原子级工单清单（M0~M4 共 20 张工单）见 [ROADMAP.md](./ROADMAP.md)；验收证据分栏记录见 [VERIFY.md](./VERIFY.md)。
