# PRODUCT-DESIGN — 产品功能设计 v2（通用个人 AI 工作台）

> 状态：**v2 已确认**（2026-11-21 用户两轮决策）｜ 上游：[SPEC.md](./SPEC.md)（架构总纲）、[ROADMAP.md](./ROADMAP.md)（工单执行）、[REFERENCES.md](./REFERENCES.md) §4（21+1 仓库代码级复评）
> **v2 变更**：产品定位从「Whale Isle 工作台」升级为**通用个人 AI 工作台**——桌宠/直播/游戏等全部收编为插件；新增插件系统（兼容 dsh）、Agent Harness 层（ACP 协议）、WebUI 形态、主题系统、lucide 图标体系。M0~M4 的全部既有成果映射为内核服务与首批插件，无推倒重来。

## 0. 用户决策记录（不可翻案除非用户改口）

| # | 决策 | 内容 |
| --- | --- | --- |
| D1 | 素材主体 | dsh-pet 114 个 VP9-Alpha webm 为主 + aboutme-pets 精灵图扩展角色包 |
| D2 | 星露谷引擎 | BWF MCP 主线 + feiyuos-stardew 守护层 + **CheatBridge（开关控制，默认关）** |
| D3 | 聊天优先级 | P0 最高：AI 输出/思考过程实时可见、对话指挥 AI、执行完回归自主 |
| D4 | 界面交付 | 先全界面高保真交互设计稿 → 确认 → 写代码 |
| D5 | 许可证豁免 | 本地自用不公开，参考代码/素材可移植（登记来源）；公开/商用前清洗 |
| **D11** | **桌宠语音**（2026-11-21 补充） | 桌宠有自己的声音：说话 + **内心戏也能用声音说出来**（可开关）；触发时机/排队/防刷屏由方案设计 |
| **D12** | **游戏状态气泡组**（2026-11-21 补充） | 桌宠上方/下方用气泡等展示游戏状态：正在做/准备做/今日目标等；完整收敛策略由方案补全 |
| **D16** | **素材全利用 + 动作库预览 + 情绪映射**（2026-11-21 补充） | dsh-pet 全部 114 动作/素材都要利用上：Shell 动作库页可预览全部动作（点击即播）；情绪五档/游戏事件/饭碗状态与动作完整对应（含 ambientPool 空闲随机氛围链），不允许素材闲置 |
| **D15** | **攻略自动采集**（2026-11-21 补充） | 自动搜集网上热门游戏攻略（小黑盒等社区 + 权威 wiki），结构化归档为 guide 专题库，丰富 AI 自动玩星露谷的玩法（按需检索注入决策 + 技能卡闭环互通） |
| **D14** | **独立运行硬约束**（2026-11-21） | **安装包安装后即可直接用**：所有代码/桌宠素材/Python worker 随包自包含，不依赖任何参考仓库或外部路径；星露谷游戏本体+Mod 由安装器引导一键安装（BWF 为 MIT 可随包分发 mod 文件）；本地 GPT-SoVITS 可选下载、云端 TTS 兜底；LLM 走用户自配供应商 |
| **D13** | **形象与直播增强**（2026-11-21 补充） | ① 默认 dsh-pet 形象+素材跑通 ② 游戏行为要有日志、要记得自己做过什么（记忆联动） ③ 未来支持自定义形象 + **AI 生成形象动作** ④ 直播要感知进房/发言/送礼并记忆 ⑤ 点歌：歌单 + 桌宠用自己的声音唱 + **送礼插队点歌**；其余适合功能由方案补充 |
| **D6** | **产品定位升级** | **通用的个人 AI 工作台**：桌宠、直播、AI 玩游戏等均为功能，做成**独立插件、可选择性开启** |
| **D7** | **插件系统** | 参考 **dsh（DeepSeek Harness）插件实现原理**（Cordis 插件树 / defineTool+registry / host-client-shared 三层），**最好兼容 dsh 插件** |
| **D8** | **Harness 层** | 集成 dsh / Codex Desktop / Claude Desktop 类开发 harness，或**调用这些 agent**；参考 **T3 Code**（pingdotgg/t3code，MIT，68.5k★）的设计实现——**采用 ACP（Agent Client Protocol）统一接入** |
| **D9** | **界面标准** | 现代化/美观/精致/交互动画丝滑优雅；**可切换主题、深浅色**；**减少 Emoji，用 lucide-react 等热门 SVG 图标库** |
| **D10** | **技术栈与形态** | **React 最新技术栈 + Electron**；最终是精致桌面端应用，**同时提供 WebUI** |

## 1. 产品定位（v2）

**「大肥鱼工作台」= 一个通用的个人 AI 工作台，桌面住着一条傲娇干饭蓝鲸女仆作为它的化身。**

- **工作台**（Workbench）：插件化个人 AI OS——聊天、开发 harness、记忆、自动化、监控，一屏统管
- **化身**（桌宠插件）：小鲸以桌宠形态在桌面陪伴、感知、代你操作
- **开箱插件**：AI 玩星露谷、抖音直播、点歌 SVC、工作跟随……全部按需开关
- **Harness**：通过 ACP 直连你已订阅的 coding agents（Claude Code / Codex / Cursor / dsh…），桌面与手机/浏览器随处审批
- 100% 本地优先、供应商自配（safeStorage 加密）、Model Gateway 统一路由计量

三层形态：

```
桌面端（Electron 38）——主形态：Shell 工作台 + 透明桌宠窗
WebUI（浏览器）——同源 React 渲染层经 HTTP/WS 访问本地 server，随处查看与审批
OBS 挂件（浏览器源 18765）——直播插件输出
```

## 2. 分层架构（内核 → 插件）

```
┌────────────────────────────────────────────────────────────────┐
│  Shell（工作台 UI）：侧栏导航（插件注册）· 聊天 · 面板 · 主题系统   │
├────────────────────────────────────────────────────────────────┤
│  插件层（可开关）                                                │
│   核心插件: pet(桌宠) · chat(persona 会话) · harness(ACP agents) │
│   功能插件: stardew(星露谷) · live(直播弹幕) · sing(点歌SVC)      │
│            memory(记忆图谱) · monitor(工作跟随) · storyboard(切片)│
├────────────────────────────────────────────────────────────────┤
│  内核服务（M0~M4 已建成，收编为内核）                              │
│   总线 WS+JSON-RPC 18760 · model-gateway（供应商路由/脱敏/计量）   │
│   persona-brain · local-store(SQLite+Dexie) · audio-ai-worker    │
│   provider-vault(safeStorage) · policy(权限/审批) · watchdog      │
├────────────────────────────────────────────────────────────────┤
│  宿主：Electron 38（主进程/渲染进程）⇄ WebUI 同源（HTTP/WS）      │
└────────────────────────────────────────────────────────────────┘
```

### 2.1 插件系统（D7，对齐 dsh / deepseek-harness 机制）

deepseek-harness 是 **"everything-is-a-plugin"**（Cordis 框架：插件树组合、可逆副作用、typed events）；DSH 生态插件（dsh-plugin-yushe 等）采用 **host(Node)/client(浏览器)/shared(纯函数规则核心) 三层 + 一文件一 defineTool + registry 汇总**。我们的插件系统与其同构：

| 概念 | 设计 |
| --- | --- |
| 插件清单 | `manifest`：id/name/版本/图标（lucide）/**扩展点声明**/**权限声明**（Policy: allow/ask/deny 按资源前缀） |
| 工具注册 | `defineTool({name, schema, execute})` → registry 汇总 → 总线 JSON-RPC 暴露（LLM 与 UI 同源调用） |
| 事件 | typed events 总线订阅（`<域>:<事件>`），插件间零直接 import，全部走总线（depcruise 边界） |
| UI 扩展点 | 插件可注册：**侧栏入口 / 工作台面板 / 快捷卡片（右栏） / 桌宠动作+气泡台词 / OBS 挂件组件** |
| 生命周期 | enable/disable 热开关、设置持久化 Dexie、崩溃隔离（插件挂了不拖垮内核） |
| **dsh 兼容层** | `plugin-bridge`：适配 Cordis 插件与 defineTool 语义 → 我们的工具/事件模型；dsh 插件源码尽量原样装载（TS/JS 包），不兼容处写适配说明。dsh 本体亦可经 ACP 作为外部 agent 接入（双通道） |
| 权限与审计 | 危险操作（文件/执行/花钱/作弊桥）过 policy 审批卡（Y 执行 / N 拒绝回喂 / A 本类全过），审计 JSONL 轮转落盘（鱼鳍模式） |

### 2.2 Agent Harness 层（D8，参考 T3 Code）

T3 Code 是 **coding agents 的开源控制平面**（MIT）：本机跑 agent（Claude Code / Codex / Cursor / OpenCode / dsh…），一个界面统管线程、随时审批；**统一协议 = ACP（Agent Client Protocol v1/v2）**，agent 经 ACP Registry 或本地命令接入（如 `dsh --profile acp`）。

| 功能 | 设计（对标 t3code） |
| --- | --- |
| Provider 实例 | 设置→Providers：ACP Registry 搜索添加 / 本地 ACP 命令（可执行名+参数）/ 已装 provider 启停；凭据由 agent 自管（我们不碰订阅） |
| 线程（Thread） | 每任务一线程；中途切换 agent/模型（"让 Claude 把任务交给 Codex"）；checkpoint 与会话回放（对接 deepseek-harness SessionEvent 事件溯源） |
| 审批流 | 工具调用 → 审批卡（桌面点击 / **WebUI 远程审批**——桌面开线程、手机/浏览器批下一步的 t3 体验） |
| 终端/输出 | 流式输出 + 工具调用卡片 + 终端 VT 渲染（参考 t3code libghostty-vt 的思路，轻量版先做结构化卡片） |
| 与桌宠联动 | agent 线程状态 → 工作跟随插件 → 桌宠动画（mention/processing/success→动作映射，agent-pet 机制） |
| 用量归属 | 按 agent/provider 维度记账（magpie agentOf 思路）进饭碗 Token 流水 |

### 2.3 技术栈选型（D10，全部主流热门）

| 层 | 选型 | 说明 |
| --- | --- | --- |
| UI 框架 | **React 19**（已有） | 现有 director/pet-stage 基础上升级 Shell |
| 构建 | esbuild（现状）→ **Vite 7 评估迁移**（HMR 开发体验，WebUI 同链路） | 迁移单列工单，不阻塞 P0 |
| 样式 | **Tailwind CSS v4**（已有） | 主题经 CSS vars + `dark` class 切换 |
| 图标 | **lucide-react**（React 生态最热门 SVG 图标库，D9） | 全量替换 emoji；lucide 无的用自定义 SVG（鲸鱼 logo） |
| 动画 | **motion**（framer-motion 的新名字，React 动画事实标准） | 页面转场/卡片微交互/气泡弹出 |
| 状态 | **zustand**（最热门轻量状态库） | Shell 全局态（主题/插件开关/侧栏）；聊天流经总线事件 |
| Markdown/代码高亮 | react-markdown + shiki | 聊天/harness 输出渲染 |
| 桌面 | **Electron 38**（已有） | 主进程新增：ACP client（stdio JSON-RPC）、plugin host |
| WebUI | 同一 React renderer + 轻量 Node server（HTTP/WS 暴露总线） | bridge 抽象：IPC ↔ HTTP/WS 双实现，UI 代码零改动 |
| 桌宠 | 现有 pet-renderer（VP9-Alpha 双 video） | 保持 |

### 2.4 桌宠语音系统（D11 · 有自己的声音，内心戏也能说出来）

既有底座：audio-ai-worker 情绪 TTS（T-M2-02）+ AudioLeaseManager 单端语音锁 active≤1（T-M2-01）。本节定义「**何时说话、说什么、怎么排队、怎么不吵**」：

| 场景 | 触发点（autodrive 事件挂点） | 声音策略 | 气泡联动 |
| --- | --- | --- | --- |
| **正式台词**（对主人/观众） | 回执 COMPLETED 短评 · 目标变更 · 直播互动 | 情绪匹配参考音频（五档）· 正常音量 | 对话气泡 + TTS 波形，可回看 |
| **内心戏发声**（默认关，可开） | `<think>` 每段推理结束抽 1 句精华 | 同音色 + 音量 -30% + 语速 0.9x，字幕带「心声」标签；**绝不打断正式台词**（语音锁排队） | think 云朵 + 音量图标 |
| **P0 反射** | 雷区词命中 | 预设台词直出（不烧主脑）· 打断既有语音（INTERRUPTED_BY_P0 既有机制） | 即时气泡 + rage_spray |
| **冒失甩锅** | UNCERTAIN 回执 | clumsy_panic 台词池随机 · 节流 20s | 气泡 + 动作 |
| **碎碎念** | 空闲 >10min 随机 | derailment 主题 · 节流 30min | 云朵气泡（默认不发声） |
| **播报级** | 今日目标制定 / 换日结算 / 睡觉前 | 目标链摘要 TTS（≤3 句） | 目标卡 + 语音 |

收敛护栏（防吵）：语音锁 active≤1 不变式；同类节流（回执短评 8s / 甩锅 20s / 碎碎念 30min）；开播时正式台词优先观众、主人私语转字幕；设置三开关：说话总开关 / 内心戏发声 / 碎碎念（音量与冷却可调）。

### 2.5 游戏状态气泡组（D12 · 正在做/准备做/今日目标，收敛策略补全）

数据源 = stardew 插件广播的 `stardew.state/receipt/goal` 总线事件；渲染在桌宠窗锚点（脚底基准线）坐标系，Q 弹/拖拽随动，多组件经 computeBubbleLayout 扩展槽位互不重叠：

| 组件 | 位置 | 默认形态 | 展开 |
| --- | --- | --- | --- |
| **动作状态条**（常驻） | 脚下线下方（不遮挡形象） | 单行紧凑：`钓鱼中 2/3 · 01:47 · 下一步:翻垃圾桶(16:00)` | hover/点击 → 目标卡 |
| **今日目标卡** | 状态条上方弹出 | 默认折叠 | 清单：done ✓ / 进行中 2/5 / 计划 / 看护锁定（20:00 睡觉） |
| **事件弹泡** | 头顶 | 触发 3.5s 自动收起为状态条 | 大事件（升级/UNCERTAIN）带动作 + 语音 |
| **回执 ticker** | 状态条右段 | 最近 1 条（`✓ 鳀鱼(完美)`） | 点击进 Shell 时间线 |
| **直播简化** | 检测 OBS 开播 | 隐藏目标卡与内心戏，仅主气泡 + 台词 | 主人鼠标靠近 1s 恢复完整 |
| **夜间/睡觉** | 游戏时段判定 | 呼吸状态条（仅动作 + 睡眠计时） | — |

### 2.6 游戏工作日志与小鲸日记（D13② · 做过什么要有据可查）

数据链：autodrive 每步决策与回执已按 deepseek-harness SessionEvent JSONL 事件溯源（模型所见必可从日志重建）→ 日志级：
- **实时日志**（Shell 星露谷面板时间线，已有设计）
- **小鲸日记**（每日自动汇总）：换日结算时记忆图谱归纳当日事件 → 生成日记条目（做了什么/遇到谁/赚了多少/翻车点）→ 存入记忆图谱 event 节点 + Shell 日志面板可查
- **周报/复盘**：每周日晚 TTS 播报 + 切片联动（本周高光/翻车 Top3）
- 查询入口：聊天直接问「你昨天做了什么」→ 记忆图谱检索作答（不自欺：只答日志里有据的）

### 2.7 形象工坊（D13③ · 自定义形象 + AI 生成动作，P2）

管线（移植自 dsh-pet scripts 全链 + aboutme-pets 逆向脚本 + 3 份 AI 生视频提示词）：
1. 文字描述/参考图 → AI 生视频（豆包绿幕 10s·16:9·脚底 85% 对齐提示词模板）
2. 绿幕 → chroma 抠像 → normalize（脚底对齐/尺寸归一 640×360 VP9 alpha）→ webm
3. manifest 条目级注册（动作名/分类/权重，三层合并覆盖）
4. 预览试穿（pet-stage 即时切换 DEV 水印校验）→ 发布为「我的形象包」
- 素材规格校验自动化（alpha 通道/帧率/时长上限），不合格自动返工重生成
- 支持从精灵图（aboutme-pets 格式）逆向导入

### 2.8 直播感知与点歌（D13④⑤ · 对齐 dsh-livestream/Dsh_douyin 成熟机制）

**观众感知与记忆**（记忆图谱联动）：
- 进房：viewerLookup 名字→UID 模糊解析 → 首次见面打招呼（新观众）/ 翻旧账问候（常客：记忆里的上次互动）→ grudge_ledger + 记忆图谱双写
- 发言：三级注意力调度（quiet/normal/busy 分档 + e^(-age/τ) 衰减）→ 中毒性/雷区词过滤 → 回应（含同观众短时弹幕合并）
- 送礼：tid 记账防 COMBO 双计 → 感谢台词（按礼重分级）→ 礼物插队点歌（见下）→ 好感度结算
- 全部进记忆图谱（event 节点 + viewer 实体），下播提炼：12 观众/次 LLM 总结、原话即删、逐条注入过滤

**点歌台**：
- 解析：`^(点歌|我想听|来一首) <歌名>` → 歌单页（Shell 面板 + OBS 歌词卡）
- 队列：FIFO 基础 + **送礼插队**（礼物价值→优先级权重：小礼物+1 位、中+前插 3 位、大礼置顶+专属感谢台词+歌词卡标点歌人）
- 演唱：查歌（缓存池 MD5 命中 <50ms）→ Demucs 伴奏分离 → RVC v2 变声（小鲸音色）→ 前 25s 预缓冲先唱 → 歌词逐行联动
- 防呆：违禁曲目拦截（license-scanner 思想复用）· 同曲冷却 30min · 每人每小时限 3 首 · 歌单支持主播禁歌清单

### 2.9 独立运行与打包（D14）

- **自包含清单**：Electron 壳 + 全部 TS 产物 + pet-renderer 素材（55MB webm 入库 ✓）+ audio-ai-worker（uv 环境内嵌或首次启动自动装 Python 3.11）+ shared-protocol 生成物。
- **外部依赖分级**：① 必需随包：无 ② 首启引导安装：星露谷游戏（用户自购）+ BWF Mod（MIT，安装包内带 mod 文件一键复制到游戏 Mods 目录）③ 可选增强：本地 GPT-SoVITS 模型（大体积单独下载，云端 TTS 默认兜底）④ 用户凭据：LLM key（应用内配置，已实现）。
- **打包**：electron-builder（macOS dmg + Windows nsis），素材与 worker 打进 asar/resources；单列工单 T-M6-05。

### 2.10 攻略采集器 guide-forager（D15）

目的：AI 玩法不局限于内置 guide/攻略.md，持续吸收社区最新玩法（钓鱼点位/下矿技巧/节日攻略/赚钱路线/送礼表）。

- **源适配器（优先级序）**：① 星露谷官方/中文 wiki（MediaWiki API——结构化最干净，首选）② 小黑盒社区热榜攻略 ③ 篝火营地/B 站攻略专栏；全部仅本地缓存、限速、尊重 robots。
- **管线**：抓取 → 正文提取（readability）→ markdown 清洗 → 主题分类（钓鱼/采矿/节日/结婚/农场/赚钱，对齐 BWF guide 专题枚举）→ 内容 hash 去重 → 落盘 `guide-forager/<主题>.md` + 索引（更新时间/来源/热度）。
- **注入点（三路同源）**：
  1. **BWF Guide.cs 互通**：导出为 Mod 的 guide/ 专题格式（`get_guide topic` 直接可读——零协议改造）；
  2. **LLM Planner 检索**：决策上下文按需附专题片段（token 预算控制 ≤2k）；
  3. **技能卡闭环**：翻车经验与攻略互相引用（SKILL-*.md ↔ guide-forager 索引）。
- **更新策略**：每周定时 + 开播前触发；去重按内容 hash；来源与作者署名保留（D14 台账）。
- **法律边界**：本地自用缓存（D5）；公开分发前须清除抓取内容或获得授权。

### 2.11 动作库预览与情绪映射（D16）

- **动作库页（Shell pets 页签）**：读 pet-renderer manifest → 分组展示——11 语义槽位卡（每卡列其 clips）+ ambientPool 按分类分组（吃/玩/时节/余额/小动作/睡眠接力/文字）→ 点击任一动作 → IPC 转发桌宠窗**立即播放预览**（播放 6s 回落 idle）；同页展示情绪五档 ↔ 动作映射表（可点击验证）。
- **映射三层**（事件唯一事实源 → 动作）：
  1. **情绪五档**（persona-brain emotionTag）：傲娇反驳→`rage_spray`（玩水枪等池）、开心→`happy_maid`、生气→尾拍/气急败坏、难过→`hungry_lazy`、平静→`idle`；
  2. **游戏事件**（autodrive receipt）：UNCERTAIN→`clumsy_panic`、COMPLETED(钓鱼/收获)→`happy_maid`、decision→`game_focus`、TIMEOUT→`thinking_tail_wag`、睡觉→`sleep_mute` 三段；
  3. **饭碗/余额**：<15% 饿瘪→`hungry_lazy`、投喂→`eat_rice`（dsh-pet 余额分档动画思想）。
- **ambient 空闲随机链**：桌宠无事件 30s → `pickAmbient` 按分类权重随机播 6s 回 idle（dsh-pet animationWeights 思想落地）——77 条池全部可达。
- **素材零闲置审计**：单测断言 manifest 114 clips 全部被「槽位 ∪ 池 ∪ 映射表」覆盖（gen 脚本保证 + pets 页可视化核验）。

### 2.12 方案方补充的功能（PM/架构师视角精选，与主线强相关）

| 功能 | 说明 | 落点 |
| --- | --- | --- |
| **远程互动** | WebUI/手机：摸头、投喂下饭菜、点歌、发弹幕指令——远程陪伴 | T-M6-04 扩展 |
| **歌单管理页** | Shell 面板：队列/历史/禁歌清单/点歌统计 | T-M5-08 |
| **小鲸日记面板** | Shell 面板：日历视图翻阅每日日记 + 记忆图谱可视化 | T-M5-14 新增 |
| **弹幕抽奖/投票** | 弹幕议会已有投票；补抽奖（送礼获券）互动 | T-M5-05 扩展 |
| **多形象轮换** | 扩展角色包切换（节日限定/换装） | T-M5-13 后置 |
| **攻略采集器** | wiki/小黑盒攻略抓取→主题归档→get_guide/LLM 检索/技能卡三路注入 | T-M5-15 新增 |

## 3. 六大子系统 → 插件映射（v1 → v2 无损收编）

| v1 子系统 | v2 归属 | 备注 |
| --- | --- | --- |
| 桌宠本体（素材/渲染/交互） | 核心插件 **pet** | 素材包/manifest/参数单出口/mood/剪影分区不变；新增加「工作台化身」职责（agent 状态可视化） |
| 大脑与人格 | 内核 **persona-brain** + 核心插件 **chat** | 记忆图谱移植后挂 memory 插件；准入闸进内核调度 |
| 星露谷共玩 | 插件 **stardew** | BWF 主线+守护层+CheatBridge 开关不变；监控面板成为插件面板 |
| 聊天与中控台 | 核心插件 **chat**（Shell 一级页面） | Codex 式会话 + 对话指挥 + 工具卡片 |
| 直播与弹幕 | 插件 **live** + **sing** + **storyboard** | 注意力调度/点歌/切片各自独立插件 |
| 安全与运维 | 内核 **policy + watchdog** | 鱼鳍模板/审批卡/看门狗全局生效 |

新增：**harness**（ACP agents，2.2）、**monitor**（工作跟随 jsonl 监听→桌宠联动）、**plugin-manager**（Shell 内置设置页：插件开关/权限/扩展点一览）。

## 4. UI 架构与设计系统 v2

| 项 | 设计 |
| --- | --- |
| Shell 布局 | 左侧栏（可拖宽）：插件注册的导航树 + 会话列表；中央内容区（面板路由）；右侧快捷卡片区（各插件注册的状态卡）；顶栏：全局搜索、模型胶囊、**主题切换（深/浅/跟随系统）**、插件管理入口 |
| 主题系统 | CSS vars 三层 token（基元→语义→组件）；**深色（主）+ 浅色 + 跟随系统**；主题色可选（鲸蓝/极夜紫/暖砂）——tokens.css 已具备底层 |
| 图标 | lucide-react 全量；尺寸语义 14/16/18px；**emoji 仅保留聊天内容与桌宠台词内的使用**（D9：UI 一律 SVG） |
| 动效 | motion 驱动：面板转场 200ms ease-out、卡片 hover 微浮、气泡弹跳（与桌宠 Q 弹同曲线语言）、流式打字机；`prefers-reduced-motion` 尊重 |
| 精致度 | 8pt 网格、14px 卡片圆角、双层阴影+内高光玻璃、焦点环无障碍；参照 magpie 单屏信息密度 + t3code 多端一致性 |
| 设计稿 | v1 六页（design/）作为界面骨架沿用；**v2 重做项**：① emoji→lucide 全替换 ② Shell 导航+插件管理页 ③ harness 页（Providers/线程/审批）④ 主题切换演示（深/浅）⑤ 动效规格标注 |

## 5. 路线图（v2 调整）

执行顺序原则：**素材先行（不依赖 Shell）→ Shell 内核 → 聊天与 harness 是 Shell 第一批页面 → 功能插件逐个收编**。

- **T-M5-01** 素材包移植（不变，独立于 Shell）—— **当前激活**
- **T-M6-01** 工作台 Shell 与插件内核（zustand/主题/lucide/插件 manifest+registry+开关页；chat 迁为 Shell 页面 = T-M5-03 并入）
- **T-M6-02** ACP Harness 层（provider 实例/线程/审批卡/用量归属；桌宠工作跟随联动 = T-M5-07 并入）
- **T-M5-02** 星露谷自动驾驶插件（game-bridge-mcp + 看门狗 + CheatBridge；监控面板 = 插件面板）
- **T-M6-03** dsh 插件兼容层（plugin-bridge：Cordis/defineTool 适配 + 装载器 + 兼容测试夹具）
- **T-M6-04** WebUI 形态（bridge 双实现 + 轻量 server + 远程审批）
- 后续 P1/P2：记忆图谱（T-M5-04）、注意力调度（T-M5-05）、渲染参数单出口（T-M5-06）、点歌（T-M5-08）、OBS（T-M5-09）、切片（T-M5-10）、网关 v2（T-M5-11）、PC 安全模板（T-M5-12）

> 设计稿 v2 重做（§4⑤）在 T-M6-01 开工前完成并再次经用户确认。
