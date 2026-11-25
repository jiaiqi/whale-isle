# ADR-002：Whale Isle V2 第一轮架构审查增补与产品纠偏决策

- **状态**：Accepted（响应用户 2026-11-25 第一轮架构审查反馈，立即生效）
- **关联文档**：[ARCHITECTURE.md](../ARCHITECTURE.md) · [REQUIREMENTS.md](../REQUIREMENTS.md) · [TRACEABILITY.md](../TRACEABILITY.md) · [ROADMAP.md](../ROADMAP.md) · [ADR-001](./ADR-001-v2-foundation.md)

---

## 1. 背景

在完成 V2 首轮接管审计与 `@workbench/runtime-core` 骨架落地后，产品与架构审查指出了原 V2 初稿中存在产品范围收缩过窄、游戏 AI 仍混入固定规则兜底、声音/表演与多人联机模型过简、缺少 `LifeRuntime`、以及将 Evolution Engine 延后到 P4 等结构性偏差。本 ADR 记录 11 项必须落地的架构决策，确保后续开发严格对齐 V2 最终产品愿景。

## 2. 核心架构决策（D-101 ~ D-111）

### D-101：引入独立的数字生活运行时 `LifeRuntime`
- **决策**：在核心域增加 `LifeRuntime`，负责自主活动选择、多时间尺度目标、兴趣驱动、自主日程、注意力调度、任务切换恢复、双方承诺及资源/时间/费用预算。
- **原则**：`GameRuntime`、`LiveRuntime`、`SocialRuntime`、`CreativeStudio` 是**角色拥有的能力接口**，不是彼此割裂的多个 AI 大脑。P1 先交付最小可用 `LifeRuntime` 协调器，避免空抽象。

### D-102：12 域模块化 `CharacterCore`（严防新 God Object）
- **决策**：明确角色核心的 12 个域及各自独立的数据所有权：
  `Identity`、`Personality`、`Preferences`、`Emotion`、`Motivation`、`Goals`、`Commitments`、`Relationships`、`Memory`、`Voice Identity`、`Embodiment`、`Activity State`。
- **防呆约束**：`CharacterRegistryCore` 只做轻量注册与跨窗状态索引，严禁把 12 域业务逻辑全部塞进一个类；角色人格与偏好必须支持由经历逐步演化。

### D-103：游戏 Agent 铁律——AI 自主判断第一，禁止静默退化为规则机器人
- **决策**：
  1. 禁止以大量硬编码情景规则（如「背包满必回家」「下雨必钓鱼」「低体力必睡觉」）代替 AI 决策；程序只负责可靠观察、寻路、工具执行、前置条件、控制权与真实回执验证。
  2. `RulePlanner` 仅保留作为**测试夹具、兼容对比或用户主动选择的模式**，不得作为默认数字生命行为。
  3. **当 LLM 不可用/超时/连续解析异常时，默认安全暂停高级自主决策并通知用户，严禁未经用户选择静默切入 `RulePlanner` 自动替代游玩。**
  4. 攻略知识保留来源、版本、适用条件、置信度与验证结果，仅作参考而非指令。

### D-104：真正的多人游戏与协作架构 `CoopRuntime` + 三层控制权租约分离
- **决策**：明确区分跨设备远程同步与真正多人联机，设立独立 `CoopRuntime` 域支持同机多 AI、多机多 AI、人机共玩联机、任务板、资源预留与模组/外观兼容检查。
- **三权分立**：
  - `ComputerUseLease`（设备级键鼠/屏幕控制租约，单机唯一）；
  - `GameCharacterControlLease`（单游戏角色/房间控制租约，含掉线释放）；
  - `LifeActivityAuthority`（角色当前自主活动调度权）。

### D-105：完整 `Creative Studio` 架构（模型调用 + 资产管线 + 全量 CrossPet 合法导入）
- **决策**：不把创作工坊简化为单一 2D 抠像；确立 `MediaGenerationGateway`（生图优先本地生图 Agent 或在线 API；3D 优先 3D 大模型，Blender 专司后处理/绑定/VRM 导出）、`Character Bible` 一致性、五类工坊、10 态资产发布与回滚，以及对 **CrossPet 全部可合法导入角色**的完整支持（严格执行非商业与商用/直播授权隔离门禁）。

### D-106：重构语音与统一表演系统（解除 `AudioLeaseManager` 单音轨阻塞）
- **决策**：
  - 区分 **TTS（说话）**、**SVS（歌声合成）**、**SVC（歌声转换）**；
  - 区分 **语音发言权（Speech Floor）**、**表演会话（Performance Session）**、**音频输出设备路由** 与 **多轨混音（AudioMixer：人声+伴奏+音效）**，避免单端语音锁阻塞音乐伴奏与后续合唱；
  - 统一 `PerformanceDirector` 驱动桌面/2D/3D/OBS 舞台的说话、唱歌、舞蹈、口型与歌词时钟同步，并支持角色自然沉默。基础真实语音与口型联动提前至 **P1**，系统 TTS 仅作降级方案。

### D-107：自主直播与社区数字生活分阶段成熟模型（L1 → L2 → L3）
- **决策**：
  - 直播由 `LifeRuntime` 按目标、兴趣、预算与授权决定，非定时死板开播；平台能力逐项实测。
  - 社区数字生活按 **L1（自主浏览/理解/兴趣形成）→ L2（自主草稿/用户审核）→ L3（平台规则与用户明确授权内自主互动发布）** 演进，不将永久人工点按每一条低风险互动作为终态；严格遵守 Per-Character 账号与 Browser Profile 隔离，绝不绕过验证码与平台规则。

### D-108：类人记忆与真删除语义
- **决策**：保留五类记忆与图谱，超越单一固定半衰期：增加重要度、情绪关联、巩固与回忆、模糊印象（记得常客但淡忘细节）、不确定性如实表达；严格区分**自然遗忘**与**用户主动删除**（真删除须级联覆盖衍生摘要与索引并留审计）。

### D-109：供应商与诚实额度矩阵扩展
- **决策**：研究借鉴 Magpie / Pi / 成熟 Harness，在网关与供应商页将 DeepSeek、MiniMax、Kimi、OpenCode、OpenRouter 等纳入统一支持矩阵，细化展示余额、5 小时窗、周/月额度、Token、请求次数、套餐权益与重置时间，每项记录数据来源、更新时间、适用范围、认证态与失败原因；不可查者恒标未知。

### D-110：Evolution Engine 拆分为 Lite（P0）与 Full（P4）提前建设
- **决策**：在 **P0** 即落地 `Evolution Engine Lite`（唯一工单调度、生产目录外独立 Git Worktree、Coding Agent 适配、自动门禁、独立审查、PR 草案、失败停机与跨会话恢复），支撑 V2 自身工程研发闭环；完整遥测复现与自动发布闭环保留至 P4。

### D-111：插件真实隔离与架构防腐败铁律
- **决策**：明确 `Capability Injection` 不是 JS 安全沙箱——内置可信模块与第三方不可信插件必须走独立隔离边界（独立进程/Worker + 真实权限执行点）；每个渐进重构工单必须显式记录：**防新旧双写状态策略、旧代码退役条件、兼容路径与回滚方案**；禁止 `EventBus` 替代明确接口，禁止内存环形缓存冒充持久事件存储。
