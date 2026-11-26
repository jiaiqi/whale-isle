# ADR-005：歌声系统与舞台形象的技术路线 —— SVC 优先、VRM 1.0 优先、多形象共存

- **状态**：Accepted（2026-11-27）
- **关联**：`REQ-VOX-02`、`REQ-VOX-03`、`REQ-VOX-04`、`REQ-PERF-02`、`REQ-EMB-02`、`REQ-EMB-03`、`V2-P3-01`、`V2-P4-01`、ADR-002、Blueprint 09 §8
- **上游依据**：owner 2026-11-27 产品级拍板（原文逐字收录于 §1，未做任何改写）
- **配套材料**：[P3-01-MATERIALS-NEEDED.md](../P3-01-MATERIALS-NEEDED.md)（素材清单与选型明细）

---

## 1. owner 决策原文（逐字收录，不改写、不简化、不删减）

> 以下为 owner 2026-11-27 的原话，**逐字收录**。后续任何技术决策都不得软化其中任何一条。

关于歌声系统和舞台形象的技术路线，做出以下产品决策：

### 1. 歌声系统：SVC 优先，长期兼容 SVS

初期优先通过 SVC 实现 AI 角色使用自己原创音色进行歌曲翻唱，尽快跑通真实点歌、演唱、伴奏混音、歌词、口型和舞蹈联动。

但 SVC 不是最终唯一方案。

长期需要同时支持：

- TTS：自然说话与情绪表达；
- SVC：专属音色歌曲转换；
- SVS：根据歌词、旋律和乐谱直接合成歌声；
- SVS + SVC：直接生成演唱后进行角色音色统一。

建立统一 Voice Identity 和 Singing Profile，每个 AI 角色拥有独立音色、说话习惯、情绪表达、音域、演唱风格和音乐偏好。

不能简单地将其他歌手的演唱换一个音色就认为已经实现了完整的角色演唱风格。

优先研究 CosyVoice、GPT-SoVITS、RVC、Seed-VC、DiffSinger、OpenUtau 等成熟项目，根据实际听感、自动化能力、硬件要求、延迟和许可证选择合适方案。

不要同时强制集成所有模型，不要将重型模型强制捆绑进主安装包。

### 2. 舞台形象：VRM 1.0 优先

3D 舞台优先使用 VRM 1.0，研究 Three.js、three-vrm、VRMA 及成熟开源虚拟角色项目。

优先跑通：

- 3D 角色加载；
- 全身骨骼动画；
- 自然待机与呼吸；
- 视线和表情；
- 音频驱动口型；
- 唱歌和舞蹈；
- 音乐节拍同步；
- 摄像机、灯光和舞台场景；
- 桌面与 OBS 输出。

3D 角色主要通过支持 3D 生成的大模型创建，传统建模软件用于必要的后处理、骨骼绑定、质量检查和格式导出。

Live2D 作为后续支持的精细化 2D 角色表现方案，不取消此项产品需求，但不阻塞第一个完整角色的开发。

### 3. 多种形象共存

保留现有 CrossPet、WebP、WebM 和 Sprite 等轻量桌宠表现。

同一个 AI 角色可以同时拥有：

- 桌面 2D 桌宠；
- Live2D 形象；
- VRM 3D 形象；
- 星露谷等游戏内的风格化角色；
- 虚拟舞台与直播形象。

所有形态共享同一角色身份、人格、记忆、情绪和声音。

建立统一表现接口和表演编排能力，不要将角色核心状态与具体渲染器强耦合。

### 4. 开发要求

请将上述决策纳入 ADR、REQUIREMENTS、ARCHITECTURE、TRACEABILITY 和 ROADMAP。

具体使用哪些模型、开源项目及实现方案，由你通过源码研究、PoC 和真实效果测试自主选择。

核心评价标准是角色声音自然、生动、有自己的风格，形象与动作灵活，整套系统能够自动化运行并持续扩展，而不是单纯完成技术接口接入。

---

## 2. 本 ADR 的技术展开

> 本节是工程侧对 §1 的展开，**不得反向修改 §1**。owner 已明确「具体使用哪些模型、开源项目及实现方案，由你通过源码研究、PoC 和真实效果测试自主选择」——本节记录的是当前技术判断，不是新的产品决策。

### 2.1 为什么 SVC 先行（而不是 SVS 先行）

owner 已经点明了关键约束：「**不能简单地将其他歌手的演唱换一个音色就认为已经实现了完整的角色演唱风格**」。这句话同时定义了 SVC 的能力边界与它的价值：

| | SVC（歌声转换） | SVS（歌声合成） |
| --- | --- | --- |
| 输入 | 源演唱干声 + 目标音色模型 | 乐谱（MIDI/USTX）+ 歌词 + 音素 |
| 得到 | 换过音色的演唱 | 从零合成的演唱 |
| 缺什么 | **演唱风格**来自源歌手——音域、咬字、换气、颤音、情感处理都不是角色的 | 需要**声库训练**，中文可用声库极少且多为非商用 |
| 首期可行性 | 只需一个目标音色模型 + 一条干声分离链 | 需要乐谱数据集 + 每个角色一套声库训练 |

首期目标是「**尽快跑通真实点歌、演唱、伴奏混音、歌词、口型和舞蹈联动**」——这是一条**端到端链路**的验收，不是「音色质量」的验收。SVC 的链路最短（干声分离 → 转换 → 混音 → 口型/歌词/舞蹈），能最快让整条表演链路被真实数据点亮；而 SVS 的前置成本（声库、数据、训练管线）在 owner 未提供授权声源前根本起跑不了。

但 **SVC 不是终局**：它交付的是「角色的**音色**」在别人的演唱上，交付不了「角色的**演唱风格**」。Singing Profile（音域、演唱风格、音乐偏好）要真正落地，必须有 SVS 或 SVS+SVC 路径——即「先按角色自己的演唱参数合成歌声，再做音色统一」。因此长期架构上，SVC 与 SVS 必须是**同一个 `SingingProfile` 契约下的两个可切换实现**，而不是两个并列的孤立功能。

**结论**：阶段一做 SVC，但**契约层从第一天就按「SVC / SVS / SVS+SVC 三种实现」设计**，否则阶段二会推倒重来。

### 2.2 候选模型与本机现实

仓库已有两份许可调研（[O5-svs-svc-backend-research.md](../evidence/O5-svs-svc-backend-research.md)、[O5-svs-svc-weight-license-per-file.md](../evidence/O5-svs-svc-weight-license-per-file.md)），结论是本轮的直接输入：

- **Seed-VC**：GPL-3.0 且已归档 —— 传染性红线，**禁入主线**。
- **so-vits-svc**：AGPL-3.0，已归档 —— **禁入主线**。
- **GPT-SoVITS**：**只是 TTS / 音色克隆，不得当 SVS/SVC 使用**。这与现有 `SingEngine` 的诚实口径一致（普通 TTS 单列 `ttsClone` 且强制带告警）。
- **CosyVoice**：Apache-2.0，但本机 Apple Silicon 实测（见 [TTS-local-engine-benchmark-verification.md](../evidence/TTS-local-engine-benchmark-verification.md)）RTF 中位数 **2.42**、P95 **4.23**，一句话要等 17–43 秒 —— **本机自托管不可用**。它可以留在「研究清单」里，但**不能作为本机交付路径**。
- **RVC**：代码 MIT 分支（`qingbo1011`）可用，但官方权重仓带「仅供研究使用」条款，商用须重训；macOS 需选 MIT 分支（AGPL 分支排除）。
- **DiffSinger / OpenUtau**：SVS 路径首选可部署组合（代码 Apache-2.0 / MIT），但官方检查点与声库的许可均不闭合，且 OpenUtau 主要是 GUI 工具——**无人值守自动化调用能力需 PoC 验证**。

**重型模型不进主安装包**这条硬约束，直接决定了工程形态：歌声模型必须走**按需下载 + 独立 Worker 进程**的路子，复用已有的 `tools/scripts/fetch-engine.mjs` 引擎安装模式（`installed.json` 标记 + 字节数校验 + 不可用时**诚实降级**，绝不静默假装可用）。

### 2.3 分层：角色核心状态与渲染器解耦

owner 要求「不要将角色核心状态与具体渲染器强耦合」。落到代码上，`CharacterCore` 的 12 域（Identity / Personality / Preferences / Emotion / Motivation / Goals / Commitments / Relationships / Memory / **Voice Identity** / **Embodiment** / Activity State）里：

- **身份 / 人格 / 记忆 / 情绪 / 声音**是**唯一真源**，任何渲染器都只读。
- **Embodiment 域**只记录「这个角色有哪些形象形态、各自指向哪份资产」，**不记录渲染细节**。
- 渲染器（WebM / Sprite / Live2D / VRM / OBS 舞台）实现**同一个表现接口**，通过 `StageRuntime` 注册与切换；切换时保留并重放表情、口型、歌词、舞蹈状态（现有 `StageRuntime` 已具备该语义，缺的是真实渲染实现）。
- OBS 是**一路输出**，不是独立的一套角色状态——桌面窗口和 OBS 窗口共享同一个角色核心状态与同一份表演时间轴。

这条解耦的关键检验标准是：**新增一种形象形态，不应该改动 `CharacterCore` 的任何一行**。如果做不到，就是耦合没解开。

### 2.4 VRM 1.0 优先的技术含义

现有 `Vrm3dStageAdapter`（`packages/pet-renderer/src/stage-runtime.ts`）目前**只维护 BlendShape 权重与动画 tag 的数据结构，没有任何真实 WebGL 渲染**——`inspectState()` 返回的是数据快照，不是画面。这一点在 [P3-performance-stage-verification.md](../evidence/P3-performance-stage-verification.md) 里已如实记录（无 `.vrm` 资产，画布视觉渲染无从谈起）。

VRM 1.0 优先意味着阶段一要补的是**真实渲染器**，不是把现有 stub 接得更漂亮。选型与字段映射细节见 [P3-01-MATERIALS-NEEDED.md](../P3-01-MATERIALS-NEEDED.md)。

### 2.5 Live2D 的定位（不取消、不阻塞）

owner 的口径是「**不取消此项产品需求，但不阻塞第一个完整角色的开发**」。工程含义：

- Live2D 相关工作**保留在路线图里**，排在 VRM 阶段之后。
- 阶段一交付 VRM 时，**不得把 Live2D 的能力一起算作完成**——两者是不同渲染后端，验收口径独立。
- 现有的 `Live2dStageAdapter` 保持可用（它同样只有数据结构、没有真实 Cubism 运行时），不删、不降级、不合并进 VRM 路径。

### 2.6 「PoC 通过 ≠ 需求达成」

owner 的评价标准是「角色声音自然、生动、有自己的风格，形象与动作灵活，整套系统能够自动化运行并持续扩展，**而不是单纯完成技术接口接入**」。因此：

- 任何涉及歌声、形象、表演的工单，**最高只能标 `IMPLEMENTED_UNVERIFIED`**，直到有真实素材 + 真实听感/真机画面的验收证据。
- 接口接上了（`SingEngine` 探针返回 `available`、`StageRuntime` 能切到 `vrm-3d`）**不算**阶段完成。
- 验收证据必须区分 `[SIMULATION]`（回放/仿真）/ `[E2E-HOST]`（Electron 内真实渲染）/ `[REAL-DEVICE]`（真机画面与真实听感），三者在证据文档里不得混写。

---

## 3. 后果与约束

| 约束 | 落点 |
| --- | --- |
| 歌声模型不进主安装包 | 独立 Worker + 按需下载（`fetch-engine.mjs` 模式），缺失时诚实降级 |
| 不得把 GPT-SoVITS 或普通 TTS 当 SVS/SVC | 沿用 `SingEngine` 现有口径：`ttsClone` 单列 + 强制告警文案 |
| GPL/AGPL 禁入 | Seed-VC / so-vits-svc / RVC 的 AGPL 分支 / `openvpi/vocoders` 代码仓全部排除 |
| 训练素材与声源必须 owner 提供且有权使用 | 模型许可 ≠ 声音人格权；商用直播、衍生模型、再分发三项授权需分别留档 |
| 角色核心状态不得与渲染器耦合 | 新增形象形态不得改动 `CharacterCore`；`Embodiment` 域只存资产指针 |
| 阶段顺序 | 阶段一 = SVC 翻唱 + VRM 1.0 一个完整角色跑通；Live2D 排其后 |
| 诚实状态 | 歌声/形象类工单最高 `IMPLEMENTED_UNVERIFIED`，PoC 通过不等于需求达成 |

---

## 4. 状态与后续

- 本 ADR 只做**路线决策**与**约束固化**。具体模型选型、PoC 计划、素材清单在 [P3-01-MATERIALS-NEEDED.md](../P3-01-MATERIALS-NEEDED.md) 与 ROADMAP 阶段划分中展开。
- 后续若 owner 变更任一口径（尤其「SVC 优先」「VRM 优先」「Live2D 不取消不阻塞」「重型模型不进主包」这四条），须**新开 ADR 修订**，并在 §1 保留原原文、另起章节记录变更，不得就地改写。
