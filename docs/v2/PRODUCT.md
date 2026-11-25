# Whale Isle V2 — 完整产品定义（Product Definition）

> **上游蓝图**：[Whale-Isle-V2-MASTER.md](./blueprint/Whale-Isle-V2-MASTER.md) · [01-产品愿景与完整PRD.md](./blueprint/01-产品愿景与完整PRD.md)  
> **关联文档**：[REQUIREMENTS.md](./REQUIREMENTS.md) · [TRACEABILITY.md](./TRACEABILITY.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)

---

## 一、一句话定义与五大定位

**Whale Isle（鲸屿）是一个开放式 AI Companion & Digital Life Platform。**

它不是单一功能的桌面挂件或硬编码聊天机器人，而是一个让 AI 角色拥有持续身份、独立人格、记忆、情绪、声音、多种身体（Embodiment）与自主行动能力的数字生命平台；同时由隔离在研发平面中的 Evolution Engine 持续演进、测试与维护鲸屿本身。

1. **AI Companion**：桌面透明陪伴、统一身份、人格、情绪、偏好、长期记忆与真实关系。
2. **AI Agent Platform**：模型供应商与诚实额度矩阵、MCP 双向接入、Agent Skills、外部 Harness 桥接、受控 Browser / Computer Use 与隔离插件体系。
3. **AI Digital Life**：由统一 `LifeRuntime` 协调的游戏共玩、攻略学习、社区浏览、创作、社交成长与直播表演。
4. **AI Creative Studio**：编排本地 Agent 与大模型生成 2D 立绘、像素资产、3D/VRM 骨骼模型、舞台与声音，并提供十态资产治理与授权门禁。
5. **AI Development Platform**：生产运行平面与研发平面严格分离，通过 `Evolution Engine`（Lite → Full）实现隔离 Worktree 研发、自动化门禁与跨会话恢复。

---

## 二、产品核心原则（不可违背）

1. **AI 是主体，桌宠是 AI 的身体**：同一 `characterId` 贯穿桌面桌宠、星露谷角色、游戏共玩、表演舞台、直播与未来社区账号。桌宠不只播动画，而是实时投射思考、情绪、说话/唱歌口型、歌词、目标与动作回执。
2. **一个 AI，多种身体（Identity Decoupled from Implementation）**：角色身份与具体 LLM 模型、Harness、TTS 供应商、渲染形式（WebM / Spritesheet / Live2D / VRM）及运行设备解耦；换模型或换电脑不丢身份与记忆。
3. **AI 自主判断优先，禁止规则树替代思考**：游戏与日常活动中，程序负责可靠观察、前置条件、互斥执行、安全边界与真实回执；目标、计划调整、建议协商、是否钓鱼/采矿/收拾背包由 AI 自主判断。模型不可用时安全暂停，绝不静默退化为固定规则机器人。
4. **控制权与透明度铁律**：用户任何时候拥有最高主权（急停 `Stop`、暂停 `Pause`、接管 `Takeover`、键鼠物理抢占、强制指令立即生效，普通建议可与 AI 协商）；所有行为、动作结果与额度均如实汇报，拒绝编造「已完成」或虚假余额。
5. **渐进式单角色闭环先于多角色扩展**：数据结构从第一天即支持多角色与多设备，但 P1–P4 集中以单一主角色 **小鲸（`char_xiaojing`）** 跑通完整能力闭环。

---

## 三、六大产品世界与七大核心场景

### 3.1 六大产品世界

| 产品世界 | 核心定位 | 对应蓝图 |
| --- | --- | --- |
| **1. Character World** | 角色身份、12 域模型、人格与偏好成长、情绪、五类记忆与真删除 | `03` / `05` / `08` |
| **2. Embodiment World** | 透明桌面窗、2D 舞台、Live2D、VRM 3D、游戏像素化身与多被动桌宠 | `05` / `06` / `07` |
| **3. Agent World** | 模型网关与诚实额度、MCP 双向、Skills、ACP Harness、隔离插件、Browser/Computer Use | `04` / `11` / `12` |
| **4. Digital Life World** | `LifeRuntime`、星露谷 AI-First 共玩与多人 `CoopRuntime`、直播舞台、L1–L3 社区生活 | `07` / `08` / `09` / `17` |
| **5. Creative World** | `MediaGenerationGateway`、生图/3D+Blender/像素/声音工坊、CrossPet 合法导入、十态 `AssetRegistry` | `06` |
| **6. Evolution World** | 独立 Worktree、Agent 编码、4 道门禁、独立审查、PR 草案与 P4 遥测自愈 | `10` / `15` |

### 3.2 目标场景

1. **桌面陪伴**：根据用户工作状态在安静陪伴、气泡思考、主动对话、拖拽交互间自然切换。
2. **AI 自主游玩与人机共玩**：第一阶段聚焦《星露谷物语》，支持单机 AI 玩、玩家随时协商/急停/接管，以及人类玩家 + 小鲸各自控制独立角色真实联机分工。
3. **AI 声音与虚拟表演**：拥有专属声线与说话/唱歌风格，支持 TTS 对话、SVS/SVC 唱歌、多轨混音、口型实时联动、双语歌词时间轴与舞蹈。
4. **AI 创作工坊**：基于 Character Bible 生成一致的角色立绘、像素 Mod 外观与经 Blender 绑定导出的可动画 VRM 3D 模型。
5. **自主直播与舞台互动**：由 `LifeRuntime` 驱动开播与节目切换，响应真实弹幕/礼物/关注/点歌（含曲库版权门禁），并同步至 OBS 舞台源。
6. **社区数字生活（L1→L3）**：从自主只读浏览与兴趣成长（L1），经草稿人工审核（L2），演进到官方规则与用户白名单内的受限自主互动（L3）。
7. **独立自主研发（Evolution Engine）**：安全隔离在生产代码外持续测试、审查与演进系统自身。

---

## 四、第一阶段硬边界：Single Primary Character First

### 主角色（小鲸 `char_xiaojing`）第一阶段必须具备
- 唯一稳定 `characterId`、12 域人格/偏好/情绪/目标/承诺模型与 `LifeRuntime`；
- 五类持续记忆（含模糊印象、情绪关联与覆盖衍生索引的级联真删除）；
- 独立 `VoiceIdentity`、跨平台真实 `VoiceProvider`、多轨 `AudioMixer` 与口型联动；
- 桌面透明形象、星露谷游戏控制、人机协作与游戏内外观同步；
- Creative Studio 创作入口、MCP/Skills/Harness/Browser/Computer Use 基础与直播/舞台统一接口。

### 其他角色（如被动伴侣桌宠）第一阶段范围
- **允许**：通过合法资产包（含 CrossPet 全量合法导入）拥有独立立绘、动作、基础设定、声音配置并在桌面同时展示、点击与拖拽反馈。
- **暂不要求（留至 P5 `V2-P5-01`/`02`）**：独立完整 `AgentRuntime`、独立长期自主日程、独立社交/直播账号、同机抢占桌面控制权、多 AI 多游戏实例自主协作。
