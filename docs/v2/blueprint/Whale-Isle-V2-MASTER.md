# Whale Isle V2 --- 最终产品总纲与技术蓝图

> Blueprint 1.0 · 2026-11-25\
> 主仓库：<https://github.com/jiaiqi/whale-isle>

## 一句话定义

Whale Isle 是一个开放式 AI Companion & Digital Life Platform：让 AI
角色拥有稳定的数字身份、人格、记忆、声音、外观和行为能力，并在桌面、游戏、浏览器、社区、直播和虚拟舞台中持续活动；同时由独立的
Evolution Engine 自动开发、测试、维护和升级鲸屿本身。

## 一、核心产品结构

鲸屿由六个相互连接的产品世界组成：

1.  **Character World**：角色身份、人格、情绪、偏好、关系和记忆。
2.  **Embodiment
    World**：桌宠、2D、Live2D、VRM/3D、游戏内角色和舞台形象。
3.  **Agent World**：模型、工具、MCP、Skills、Harness、Browser
    Use、Computer Use。
4.  **Digital Life
    World**：游戏、学习、社区浏览、社交、创作、直播和日常活动。
5.  **Creative
    World**：图片/3D/声音生成、动画、游戏素材、舞台素材和资产管理。
6.  **Evolution World**：独立研发 Agent
    自动分析问题、开发、测试、审查、发布和回滚。

## 二、第一阶段产品原则：Single Primary Character First

先用一个主 AI 角色跑通所有核心功能。第一阶段不做多个完整自主 Agent。

主角色具备一个 Character ID、一个主要 Agent
Runtime、人格/情绪/偏好/记忆、专属声音/说话/唱歌风格、桌面桌宠、星露谷游戏化身、游戏控制和人机协作、图片/3D
资产创作入口、MCP/Skills/Harness/Browser/Computer
能力基础，以及直播和舞台接口。

其他角色第一阶段只要求独立形象、动画、角色设定、基础声音配置和多桌宠展示；不要求独立社交、直播、游戏或完整长期
Agent Runtime。

**一个 AI，多种身体。** Character Identity
与模型、Harness、声音、形象和设备解耦。同一角色可以同时在桌面、星露谷和舞台呈现，不需要为每种形态创建一个独立大脑。

## 三、核心架构

采用 Modular Monolith + 独立 Worker 起步。

核心模块： - Platform Core； - Agent Runtime； - Character Core； -
Personality/Emotion； - Memory/Relationship； - Model Gateway； - Media
Generation Gateway； - Voice/Singing Runtime； - Performance Engine； -
Desktop/Game/Stage Embodiment； - MCP/Skills/Plugin Runtime； - Harness
Bridge； - Browser/Computer Runtime； - Digital Life/Social Runtime； -
Live Runtime； - Asset Registry； - Account Vault； - Device
Registry； - Event Store/Observability。

外部模型、游戏、浏览器、社交平台和 Harness 全部通过 Adapter/Provider
接入。

## 四、图片与 3D 生成

鲸屿不自研通用图片/3D 生成模型。

### 图片

调用本地 Codex 或其他具备图像生成能力的 Coding
Agent，或者直接调用在线图片模型 API。通过 Media Generation Gateway
统一任务、状态、费用、结果和错误。

本地 CLI 只代表调用入口在本机，不代表模型推理一定在本地。

### 3D

优先调用 Hunyuan3D 等 3D 生成大模型；输入 Character
Bible、参考图和多视图；生成网格和材质；Blender
用于后处理、UV、骨骼、BlendShapes、优化和导出；最终形成可动画的
VRM/GLB，而不是只生成静态模型。

## 五、角色声音与人类感

每个角色拥有独立 Voice
Identity：音色、语言/口音、音域、韵律、咬字、说话节奏、情绪表现和唱歌风格。

分开建设 TTS（说话）、Singing Voice Synthesis（歌声合成）、Singing Voice
Conversion（授权声音转换）和 Performance
Engine（说话时机、沉默、表情、动作、口型和情绪）。

自然感不是单靠
TTS，而是人格、记忆、情绪、上下文、行为时机、声音和动作的共同结果。角色可以选择不说话。

## 六、游戏化身与星露谷

游戏化身分为玩家外观替换、AI 专属 NPC、完整可控 AI
游戏角色三个等级。现有 `mods/stardew-avatar-sync` 是 Level 1
的基础，需复核实际代码和运行测试。

技术路线： - Content Patcher：静态纹理、肖像和内容； - Whale Isle SMAPI
Mod：动态形象、状态和动作同步； - Game
Adapter：统一游戏状态和动作协议； - Coop
Runtime：任务分工、资源锁、进度和冲突处理。

多人联机时，所有需要显示自定义素材的客户端必须满足
Mod/资源兼容条件。不能假设本机替换会自动同步给其他玩家。

## 七、数字生活和社交

Digital Life Runtime 管理角色日程、内容探索、学习、兴趣和关系。

Browser/Computer Use： - Playwright 等确定性浏览器工具优先； - 视觉
Computer Use 用于缺乏结构化接口的场景； - 每个角色/账号独立 Browser
Profile； - 每台设备只有一个自动化键鼠主控 Lease； -
用户输入优先级最高。

社交平台按官方开放能力和授权逐项适配。抖音、Bilibili、小红书读写能力不同。不能绕过验证码、访问控制或平台限制。默认先只读和草稿，再按权限开放有限写入。

## 八、记忆

五类记忆：Working、Episodic、Semantic、Relational、Self Memory。

每条记忆有来源、时间、置信度、重要性和保留策略。原始事件与主动回忆索引分开。角色可以忘记或不确定，但不能编造记忆。用户可以查看、纠正和删除。

## 九、直播与舞台

Live Runtime
统一接收平台支持的弹幕、关注、礼物等事件。通过去重、过滤、排序和合并，避免每条弹幕都调用模型。

Stage Runtime 支持桌面、2D、3D
舞台；说话、唱歌、跳舞；歌词开关和时间轴；口型和动作同步；OBS/直播输出。

点歌必须检查歌曲、伴奏、歌词和声音使用权。平台直播 API 能力需逐项验证。

## 十、Evolution Engine

独立研发平面，不与生产 Runtime 混在一起。

流程： Runtime Telemetry → Issue Triage → Plan → Worktree → Coding Agent
→ Tests/Replay → Independent Review → PR → Approval → Release Candidate
→ Staged Deploy → Monitor/Rollback。

直播时可以分析、开发和测试；代码级发布尽量安排维护窗口。安全配置可在
Schema 校验和回滚机制下热更新。

## 十一、路线图

  阶段    交付
  ------- ----------------------------------------
  V2-00   仓库审计、架构冻结、许可证和测试基线
  V2-01   Evolution Engine 最小研发闭环
  V2-02   单角色身份、人格、记忆和状态
  V2-03   专属声音、自然说话和表现
  V2-04   星露谷游戏化身、控制和协作
  V2-05   图片/3D Creative Studio 与资产流水线
  V2-06   MCP、Skills、Harness、Browser/Computer
  V2-07   直播、舞台、唱歌和歌词
  V2-08   Digital Life、社区只读、内容理解和记忆
  V2-09   多桌宠展示
  V2-10   多角色自主生活和多设备协作


## V2.1 核心增补：自主游戏智能与人机共玩

鲸屿的游戏 AI 不是规则脚本。它应根据游戏状态、目标、人格兴趣、游戏知识、个人经历和用户意见，自主选择行动、动态调整计划。背包满时可以评估建箱子和整理；也可以根据天气、资源、时间和兴趣临时决定钓鱼、下矿或探索。不要用大量固定情景规则替代判断。

AI 可以学习 Wiki、攻略、玩家经验、Mod 文档和自己的游戏经历，但必须保留来源、版本、适用条件和置信度；攻略是参考，不是必须遵循的命令。它要结合当前存档、游戏状态和自身经验灵活应用。

用户可以像朋友一样聊天、建议和讨论。AI 可以同意、不同意或提出折中方案。建议与明确指令不同：明确任务应优先执行；Stop/Pause/Take Over 等快捷控制优先级最高，确保用户随时能够停止自主控制或接管角色。

完整设计、领域模型、决策循环、攻略学习、控制权模式、快捷命令和验收用例见 [17-自主游戏智能与人机共玩系统](17-自主游戏智能与人机共玩系统.md)。

## 十二、最重要的工程约束

-   不盲目重写 Whale Isle；
-   不一次性创建大量空模块；
-   不把 Stub 当作完成；
-   不把 Mock 当作真实平台测试；
-   不让生产 Agent 直接改生产代码；
-   不让多个 Agent 抢同一台电脑；
-   不把账号凭证放进普通文件；
-   不未经授权发布内容；
-   不把非商业素材用于商业直播；
-   不让更换模型改变角色身份；
-   所有自动化都有状态、日志、取消和回滚；
-   所有里程碑有验收标准和测试证据。

## 详细文档

请结合本目录其余文档阅读： - [产品愿景与完整
PRD](01-产品愿景与完整PRD.md) - [总体技术架构](02-总体技术架构.md) -
[领域模型与数据契约](03-领域模型与数据契约.md) -
[Agent/Harness/MCP/Skills/插件](04-Agent-Harness-MCP-Skills-插件系统.md) -
[人格、声音与表演](05-角色人格声音与表演系统.md) - [AI
创作工坊](06-AI创作工坊与资产流水线.md) -
[游戏化身与星露谷协作](07-游戏化身与星露谷协作.md) - [Digital Life
与社交记忆](08-Digital-Life社交浏览与记忆.md) -
[直播舞台音乐](09-直播舞台音乐与互动.md) - [Evolution
Engine](10-Evolution-Engine自主研发系统.md) -
[安全与治理](11-安全隐私权限与治理.md) -
[技术选型与开源复用](12-技术选型与开源项目复用.md) -
[现有仓库审计与迁移](13-现有Whale-Isle仓库审计与迁移.md) -
[路线图与验收](14-实施路线图与验收标准.md) - [Agent
开发宪章](15-Agent开发宪章与任务模板.md) -
[决策记录与风险](16-决策记录与风险清单.md)
