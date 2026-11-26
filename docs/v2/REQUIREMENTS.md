# Whale Isle V2 — 不可遗漏的原始需求清单（Requirements Baseline）

> 本文为工程化归纳版，原始原文（owner 原文，逐字）见 [PRODUCT-REQUIREMENTS.md](./PRODUCT-REQUIREMENTS.md)。

> **原则**：本清单汇集 [blueprint/](./blueprint/README.md)（`MASTER` + `01`–`17`）与第一轮架构审查的全部原始产品需求。**禁止因当前未实现或技术复杂度高而擅自删减需求。**  
> **追踪映射**：每一项需求的实现模块、对应工单、依赖与真实验证口径均严格映射到 [TRACEABILITY.md](./TRACEABILITY.md)。

> **编号约定**：本文采用工程化编号（`REQ-CORE` / `REQ-CHAR` / `REQ-VOX` / `REQ-PERF` / `REQ-EMB` …），**与 [PRODUCT-REQUIREMENTS.md](./PRODUCT-REQUIREMENTS.md) 的原文 98 条编号（`REQ-VOICE-*` / `REQ-STAGE-*` / `REQ-AVATAR-*` 等）不是同一套**，两者前缀刻意错开、不互相占用。引用时以 [TRACEABILITY.md](./TRACEABILITY.md) 的映射为准。

---

## 一、平台底座与治理（`REQ-CORE`）

- **`REQ-CORE-01` 微内核底座**：统一生命周期管理、Typed 事件总线、分级脱敏日志、配置与凭据接口，采用 Strangler Pattern 渐进重构 V1。
- **`REQ-CORE-02` 存储引擎收敛**：本地 SQLite 统一迁移至 Node/Electron 内置 `node:sqlite`，彻底消除原生模块 ABI 冲突，并具备旧版迁移备份、Savepoint 事务、损坏自愈与物理回滚。
- **`REQ-CORE-03` 跨会话治理**：建立唯一激活工单、7 态状态机（`PENDING | NEXT | DOING | IMPLEMENTED_UNVERIFIED | BLOCKED | DONE | REOPENED`）与零聊天依赖的仓库级恢复文件（[CURRENT.md](./CURRENT.md)）。

## 二、角色核心、数字生活与记忆（`REQ-CHAR` / `REQ-LIFE` / `REQ-MEM`）

- **`REQ-CHAR-01` 12 域模块化角色架构**：拆分 `Identity / Personality / Preferences / Emotion / Motivation / Goals / Commitments / Relationships / Memory / Voice Identity / Embodiment / Activity State` 各自独立数据所有权，同一 `characterId` 贯穿全场景，避免新 God Object。
- **`REQ-CHAR-02` 经历驱动的人格成长**：角色喜好、说话习惯与特质随真实互动和经历渐进演化，保留变化来源与历史，不限于静态人设 Prompt。
- **`REQ-LIFE-01` 统一数字生活运行时 `LifeRuntime`**：单一协调器负责自主活动选择、多时间尺度目标、兴趣驱动、日程安排、注意力调度、中断恢复、双方承诺与资源/时间/费用预算；游戏、直播、社交、创作皆为其调度的能力域。
- **`REQ-MEM-01` 类人五类记忆与模糊印象**：区分 Working / Episodic / Semantic / Relational / Self，结合重要度、情绪权重、主动回忆巩固形成模糊印象（记得常客而不必强记原话），记不清时如实表达不确定。
- **`REQ-MEM-02` 记忆查看、纠正与级联真删除**：严格区分自然衰变遗忘与用户手动删除；显式删除必须同步覆盖原始事件、衍生摘要、关系账本与检索索引，仅保留不可删除的删除审计记录。

## 三、声音、表演与化身表现（`REQ-VOX` / `REQ-PERF` / `REQ-EMB`）

- **`REQ-VOX-01` 独立 `VoiceIdentity` 与真实说话语音**：P1 即交付跨平台真实可用语音服务（云端情绪 TTS 或本地 Worker），系统 TTS（`say` / Win SAPI）仅作为明确降级方案；输出实时音量包络/Viseme 驱动桌宠口型。
- **`REQ-VOX-02` 说话 / SVS / SVC 分离与多轨 `AudioMixer`**：严禁将普通 TTS 当作唱歌；区分歌声合成（SVS）与授权音色转换（SVC）；拆分说话发言权与多轨混音，禁止语音锁阻塞背景伴奏与音效，点歌必须检验曲库与伴奏授权。
- **`REQ-VOX-03` 统一 `Voice Identity` 与 `Singing Profile`**：每个 AI 角色拥有独立音色、说话习惯、情绪表达、**音域、演唱风格与音乐偏好**；歌声系统 **SVC 优先**（用角色自己原创音色翻唱），长期同时支持 TTS / SVC / SVS / SVS+SVC（先生成演唱再统一音色）四种形态；**严禁把普通 TTS 或「给别人的演唱换一个音色」当作角色演唱风格已实现**。
- **`REQ-VOX-04` 歌声模型按需安装、许可红线与诚实降级**：重型歌声模型（SVC/SVS 权重）**不捆绑进主安装包**，走按需下载 + 独立 Worker 进程；GPL/AGPL 项目与其分支禁入主线；训练素材与声源**必须 owner 提供且有权使用**（模型许可 ≠ 声音人格权，商用直播 / 衍生模型 / 再分发三项授权分别留档）；后端缺失或越权时如实报 `unavailable`，绝不静默假装可用。
- **`REQ-PERF-01` 统一 `PerformanceDirector`**：跨桌面、2D 舞台、3D 舞台与 OBS 同步表达说话、唱歌、舞蹈、双语歌词时间轴与表情，允许角色保有自然沉默权。
- **`REQ-PERF-02` 统一表现接口与表演编排**：所有形象形态经同一表现接口接收表演指令（表情 / 口型 / 骨骼动作 / 视线 / 歌词 / 节拍），并由统一编排层驱动；**角色核心状态（身份 / 人格 / 记忆 / 情绪 / 声音）与具体渲染器解耦**——新增一种形象形态不得改动角色核心状态。
- **`REQ-EMB-01` 桌面多态化身与被动多宠**：透明窗口零黑帧 WebM/Spritesheet 渲染与像素穿透交互；支持一个完整主角色 + 多个仅具独立立绘/动作/基础音色的被动桌宠同屏，含全部合法 CrossPet 角色。
- **`REQ-EMB-02` 统一 `Embodiment` 跨维度接口**：支持同一角色在桌面 2D、Live2D 与 VRM 3D 舞台间无缝切换。
- **`REQ-EMB-03` 多种形象共存**：保留现有 CrossPet / WebP / WebM / Sprite 轻量桌宠表现；同一 AI 角色可同时拥有桌面 2D 桌宠、Live2D 形象、VRM 3D 形象、游戏内风格化角色与虚拟舞台/直播形象，**所有形态共享同一身份、人格、记忆、情绪与声音**；`Embodiment` 域只记录资产指针，不承载渲染细节。
- **`REQ-EMB-04` VRM 1.0 优先的 3D 舞台**：3D 舞台以 VRM 1.0 为优先格式，真实渲染而非仅数据结构；覆盖角色加载、全身骨骼动画、自然待机与呼吸、视线与表情、音频驱动口型、唱歌与舞蹈、音乐节拍同步、摄像机/灯光/舞台场景，以及桌面与 OBS 双输出；3D 资产以支持 3D 生成的大模型产出为主，传统建模软件负责后处理、骨骼绑定、质量检查与格式导出；**Live2D 作为后续精细化 2D 方案，不取消该产品需求但不阻塞第一个完整角色的开发**。

## 四、AI 自主游戏、攻略学习与多人联机（`REQ-GAME`）

- **`REQ-GAME-01` AI-First 自主游戏智能**：严禁编写情景硬编码策略树（如满包必清包、下雨必钓鱼、低体力必睡觉）；LLM 不可用时安全暂停高级自主决策并通知用户，`RulePlanner` 仅限显式手动启用或测试回归。
- **`REQ-GAME-02` 真实控制权执行与动作回执**：急停、暂停、手动接管与强制指令在真实执行层立即生效，具备在飞动作 `cancel_action`、过期指令拒绝（`sessionId`/`generation`）与真实结果回执。
- **`REQ-GAME-03` 游戏攻略知识学习闭环**：记录来源、游戏版本、Mod 上下文、适用范围、置信度与实际验证结果（含反例更新），作为参考知识而非死板命令。
- **`REQ-GAME-04` 真实多人协作 `CoopRuntime`**：区分跨设备同步与真实联机游戏；支持同机多 AI、多机多 AI 与真人+AI 各自控制独立角色联机分工、任务板、资源预留、客户端 Mod 兼容检测与断线恢复。
- **`REQ-GAME-05` 游戏内角色形象同步与多游戏扩展**：支持玩家外观替换（Level 1）→ 专属 NPC 同步（Level 2）→ 联机可控化身（Level 3），首期打通星露谷 `stardew-avatar-sync` 真机联机验证，P5 解冻 Terraria / DST / Minecraft。

## 五、创作工坊与数字资产治理（`REQ-CR`）

- **`REQ-CR-01` `MediaGenerationGateway` 与生图一致性**：编排具备生图能力的本地 Agent（如 Codex）或在线图片模型 API，通过 Character Bible 保证三视图与特征一致，产物先入候选区审查而不覆盖已发布资产。
- **`REQ-CR-02` 3D 生成与 Blender 自动化后处理**：优先调用 Hunyuan3D 等 3D 生成大模型产生网格与材质，再由 Blender 自动完成法线/UV/减面/骨骼绑定/BlendShapes/VRM 导出与质量检查。
- **`REQ-CR-03` 全品类素材制作、CrossPet 导入与授权清源**：支持像素 Sprite Sheet（含星露谷导出）、桌面/舞台背景、音效与 CrossPet 合法全量导入；十态 `AssetRegistry` 强校验来源与授权，自动拦截 `CC BY-NC-SA 4.0` 等非商用素材进入直播或商业分发。

## 六、模型生态、开放扩展、安全、自动化、直播与自演进（`REQ-MOD` / `REQ-EXT` / `REQ-SEC` / `REQ-AUTO` / `REQ-LIVE` / `REQ-SOC` / `REQ-UI` / `REQ-EVO` / `REQ-MULTI`）

- **`REQ-MOD-01` 模型网关与四级诚实额度矩阵**：覆盖 DeepSeek / MiniMax / Kimi / OpenCode / OpenRouter / Ollama 等；统一查询余额、5h/周/月配额、Token、次数、套餐与重置时间，强制标注数据源、获取时间与错误，不可查询项绝不编造。
- **`REQ-EXT-01` 开放生态层**：双向 MCP Client/Server、Agent Skills 标准兼容、ACP/外部 Harness（Codex / Claude / Gemini / OpenCode / Pi / OpenHands）执行级接入。
- **`REQ-SEC-01` 插件真实进程隔离**：明确废弃将 `Capability Injection` 当安全沙箱的做法；第三方不可信插件必须在独立 Worker/子进程运行，经主进程 Policy Broker 执行 P0–P5 权限硬拦截。
- **`REQ-SEC-02` 密钥与多账号隔离**：OS 钥匙串加密永不下行明文；Per-Character 社交凭据（`AccountVault`）与独立 `BrowserProfile` 隔离；严禁绕过验证码、反自动化或平台认证。
- **`REQ-AUTO-01` 受控 Browser Use 与 Computer Use**：确定性脚本（Playwright）优先于 AI 视觉浏览；设备级 `ComputerUseLease` 保证同机单主控，用户物理键鼠输入 ≤ 1 s 撤销该租约；**游戏角色租约 `GameCharacterControlLease` 不受普通键鼠影响**（保持 `T-M6-73`，只认 F7 / 界面开关 / P0 急停），详见 [ADR-004](./adr/ADR-004-input-preemption-scope.md)。
- **`REQ-LIVE-01` `LifeRuntime` 驱动的直播与 OBS 舞台**：真实接入平台直播间事件、弹幕注意力调度与点歌授权拦截，同步双语歌词与舞台表演。
- **`REQ-SOC-01` 社区数字生活 L1 → L2 → L3**：经历 L1 只读学习与兴趣沉淀、L2 草稿生成人工审核，到 L3 平台规则与用户白名单授权内的自主互动发布；平台官方能力必须逐项实测。
- **`REQ-UI-01` Tidepaper 主基线与多主题工作台 UI**：以 **Tidepaper（`design/tidepaper/`）** 为主 UI/UX 参考基线，保留 **Obsidian Tide（`design/theme-obsidian-tide/`）** 等既有设计为可选主题（原型仅供参考，实际开发按真实能力渐进落地）；渐进拆解巨型 `App.tsx`，交付真实控制权 HUD、4 态回执、许可徽章，严格标注未接线页面状态，零假指标。
- **`REQ-EVO-01` / `02` Evolution Engine（Lite P0 → Full P4）**：研发平面与运行平面物理隔离；P0 跑通唯一工单 + 外部 Worktree + Agent + 门禁 + 独立审查 + PR + 跨会话恢复；P4 接入脱敏遥测、复现回放与灰度回滚。
- **`REQ-MULTI-01` P5 多角色与多设备扩展**：单角色“小鲸”全闭环验收完成后，解锁多完整自主角色、跨设备协同与多游戏正式扩展。
