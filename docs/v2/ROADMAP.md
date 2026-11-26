# Whale Isle V2 完整开发路线图（P0–P5 · 唯一工单真源）

> **工单状态机（7 态唯一流转）**：  
> `PENDING` → `NEXT`（全局唯一激活待办）→ `DOING` → `IMPLEMENTED_UNVERIFIED`（代码与单测/仿真通过，待真机/真实平台验证） / `BLOCKED`（依赖或外部阻塞） → `DONE`（全部验收标准 + 真实验证证据齐全） | `REOPENED`（复测退回重开）  
> **铁律**：每完成一个工单必须同步更新本文件、[TRACEABILITY.md](./TRACEABILITY.md)、[CURRENT.md](./CURRENT.md) 与 [EVALUATION.md](./EVALUATION.md)；不得用 Mock/仿真通过冒充真机/真实平台 `DONE`。

---

## P0：工程底座、架构纠偏、数据库迁移与最小研发闭环

### `V2-P0-01`：V1 全仓审计、V2 首轮架构设计与接管文档
- **状态**：`DONE`
- **目标**：盘清 V1 代码资产、技术债、CrossPet/开源许可证边界，输出审计与基线架构。
- **依赖**：无
- **实现方案**：产出 [TAKEOVER-AUDIT.md](./TAKEOVER-AUDIT.md) 与 [ADR-001](./adr/ADR-001-v2-foundation.md)。
- **验收标准**：所有现状数据有代码行号与命令实测支撑，区分真实可用与 Stub。
- **测试方案**：`pnpm verify:gate` 全绿。
- **预计风险**：旧文档口径失真 → 已以源码实读校验。

### `V2-P0-02`：V2 运行时微内核 `@workbench/runtime-core` 与宿主接线
- **状态**：`DONE`
- **目标**：建立 V2 微内核骨架（Typed 事件总线、分级脱敏日志、配置与凭据接口、`CharacterCore` 基础态、急停与插件容器接线）并跑通真实 Electron 启动。
- **依赖**：`V2-P0-01`
- **实现方案**：新建 [packages/runtime-core](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/runtime-core/package.json) 与 [v2-kernel-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/v2-kernel-host.ts)。
- **退役与回滚**：作为 Strangler 底座增量接入，零破坏 V1 功能；回滚仅需移除宿主调用。
- **验收标准**：`WhaleKernel` 在 Electron 45 中进入 `running`，急停生效。
- **测试方案**：单包分支覆盖率 ≥90%，`verify:gate` 7/7 + `v2-kernel.e2e.spec.ts` 通过。
- **预计风险**：微内核膨胀 → 严格限制职责，禁止吞入业务域逻辑。

### `V2-P0-04`：完整需求追踪矩阵、架构纠偏（ADR-002）与开发宪章同步
- **状态**：`DONE`（本轮完成）
- **目标**：对齐 Blueprint 01–17 与第一轮审查 15 项指令，补全 `LifeRuntime`、12 域 `CharacterCore`、AI-first 游戏智能、`CoopRuntime`、完整 `Creative Studio`、多轨声音表演、直播与社区 L1–L3、类人记忆、额度矩阵、Evolution Lite 与插件真隔离。
- **依赖**：`V2-P0-02`
- **实现方案**：构建完整 `docs/v2/` 文档真源（[PRODUCT.md](./PRODUCT.md)、[REQUIREMENTS.md](./REQUIREMENTS.md)、[TRACEABILITY.md](./TRACEABILITY.md)、[CURRENT.md](./CURRENT.md)、[OPEN-SOURCE.md](./OPEN-SOURCE.md)、[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)、[EVALUATION.md](./EVALUATION.md)、[ADR-002](./adr/ADR-002-v2-architecture-revision.md)、[blueprint/](./blueprint/README.md) 与 [evidence/](./evidence/README.md)），修订 `ARCHITECTURE.md`、`ROADMAP.md` 与 `AGENTS.md` §5。
- **验收标准**：Blueprint 全部领域无遗漏映射，每项工单包含完整验收与回滚约束。
- **测试方案**：文档交叉审查 + 门禁校验。
- **预计风险**：需求范围大 → 通过 P0–P5 清晰分期与单角色先闭环管控复杂度。

### `V2-P0-03`：SQLite 存储收敛至内置 `node:sqlite`（含迁移/事务/恢复/打包验证）
- **状态**：`DONE`（2026-11-25 完成）
- **目标**：将 `@workbench/local-store` 从 `better-sqlite3` 迁移至 Node/Electron 内置 `node:sqlite`，彻底消除原生模块 ABI 冲突。
- **依赖**：`V2-P0-02`、`V2-P0-04`
- **实现方案**：重写 `packages/local-store/src/sqlite.ts` 使用 `DatabaseSync`；自动检测旧版 v1 库并备份后事务性升级 Schema；提供 `runInTransaction`、`checkIntegrity`、`openSqliteStoreWithRecovery` 与 `rollbackDatabaseFile`；移除 `better-sqlite3` 依赖与构建钩子。
- **退役与回滚**：保留旧 `.v1-backup.*.bak` 备份文件，失败时可调用 `rollbackDatabaseFile` 秒级回退数据，代码层可独立 revert 本次提交。
- **验收标准**：旧库数据零丢失迁移、事务错误回滚生效、损坏库自动备份重建、真实 Electron 进程内文件库读写与完整性自检通过。
- **测试方案**：`sqlite.spec.ts` 全量单测（含真实旧版库迁移/事务/损坏恢复）+ `desktop-host build` + `verify:gate` + Electron E2E。
- **预计风险**：`node:sqlite` 与 `better-sqlite3` 返回数值类型（如 `bigint` changes）差异 → 显式 `Number()` 转换并在单测覆盖。

### `V2-P0-05`：Evolution Engine Lite 隔离研发闭环落地
- **状态**：`DONE`（2026-11-25 完成）
- **目标**：在 P0 即落地轻量级隔离研发引擎，支持唯一工单调度、生产目录外独立 Git Worktree、Coding Agent CLI 适配、自动化门禁、独立 Diff/安全审查、PR 草案生成、失败报告与跨会话状态恢复。
- **依赖**：`V2-P0-03`
- **实现方案**：新建 `tools/evolution-lite`（Zero external deps beyond `zod`），实现 `EvolutionStateStore`、`GitWorktreeManager`（严格校验路径在生产仓外且禁止动 `main`）、`CliCodingAgentAdapter`、`IndependentReviewer`、`EvolutionLiteOrchestrator` 与 `pnpm evolution:lite` CLI。
- **退役与回滚**：纯独立工具包，不修改运行期 `apps/desktop-host`，可独立停用。
- **验收标准**：在真实临时 Git 仓库创建外部 Worktree 修改文件而不污染主仓，门禁/审查失败立即中止且不产 PR 草案，跨会话可恢复任务进度。
- **测试方案**：真实 `git init` 临时仓库 Worktree 集成测试 + 全流程编排单测（分支覆盖率 ≥90%）+ `verify:gate`。
- **预计风险**：不同系统 git worktree 路径软链接解析差异（macOS `/var` → `/private/var`）→ 使用 `realpathSync` 规范化路径比对。

---

## P1：单角色核心闭环（身份、真实语音、桌宠、记忆、供应商与星露谷 AI 自主共玩）

### `V2-P1-01`：模块化 `CharacterCore`（12 域）与最小 `LifeRuntime`
- **状态**：`DONE`（2026-11-25 完成）
- **目标**：落盘 12 域分权存储与 `LifeRuntime` 最小活动协调器，让小鲸拥有统一身份、目标、承诺、日程与偏好成长模型。
- **依赖**：`V2-P0-03`、`V2-P0-05`
- **实现方案**：拆出 `CharacterProfile`、`GoalManager`、`CommitmentLedger` 与 `LifeRuntime` 活动状态仲裁器；迁移 V1 `character-registry` / `character-persona` 至同一权威源，消除主进程双写。
- **退役与回滚**：保留旧 IPC 只读投影直到 `V2-P1-05` 切换完毕；异常可切回旧读路径。
- **验收标准**：切换模型/外观不丢失 `char_xiaojing` 身份与目标；游戏与桌宠消费同一活动态与情绪态。
- **测试方案**：12 域契约与状态一致性测试 + Electron E2E。
- **预计风险**：V1 `character-registry` 多宠字段兼容 → 通过映射适配器平顺过渡。

### `V2-P1-02`：真实 `VoiceProvider`、独立 `VoiceIdentity`、口型联动与多轨 `AudioMixer`
- **状态**：`IMPLEMENTED_UNVERIFIED`（2026-11-25 代码/单测/门禁 7/7/Electron 45 E2E 完成；待真机人工听感、云端 TTS Key 实测与 Windows SAPI 硬件验收）
- **目标**：P1 即交付真实可用角色语音与口型联动（不捆绑重型本地模型），改造 `AudioLeaseManager` 解除单音轨对伴奏/音效的阻塞。
- **依赖**：`V2-P1-01`
- **实现方案**：抽象 `VoiceProvider`（真实云端情绪 TTS API + 本地 Worker 接入，macOS `say`/Win SAPI 仅标为降级方案）；拆分发言权（Speech Floor）与 `AudioMixer` 多轨播放；输出音量包络/Viseme 驱动桌宠嘴型。
- **退役与回滚**：保留 `mcode-tools`/`say` 降级通道作为故障兜底。
- **验收标准**：真实语音流生成并驱动桌宠口型动画；说话与背景音不互锁；Windows/macOS 均有明确可用后端或诚实降级提示。
- **测试方案**：TTS Provider 契约与音频流测试 + 语音抢占与口型帧率测试 + 真机人工听感验收。
- **预计风险**：云端 TTS 首包延迟波动 → 流式分句预取与超时取消。

### `V2-P1-03`：模型供应商与四级诚实额度矩阵（DeepSeek / MiniMax / Kimi / OpenCode 等）
- **状态**：`IMPLEMENTED_UNVERIFIED`（2026-11-25 代码/单测/门禁 7/7/Electron 45 E2E 完成；DeepSeek/OpenRouter/OpenCode Go 已实测，待 Kimi 与 MiniMax Coding Plan 真实 Key 联调）
- **目标**：完善供应商网关与精细化额度中心，覆盖平衡/5h/周/月/Token/次数/套餐/重置时间，并如实记录来源、更新时间与不可查标记。
- **依赖**：`V2-P0-02`
- **实现方案**：参考 Magpie / Pi / 成熟 Harness，在 `shared-protocol` 新增 `ProviderQuotaReport` Schema，在主进程实现各主流厂商实测探针（DeepSeek/OpenRouter/OpenCode/MiniMax/Kimi/本地 CLI 状态），未实测字段强制标记 `unknown`。
- **验收标准**：已支持厂商返回实测额度与元信息；不可查询厂商不编造任何数值。
- **测试方案**：协议与解析器单测 + 真实脱敏 Key 隔离集成验证。
- **预计风险**：厂商私有接口变更 → Schema 宽松容错并在 UI 显示原始失败原因。

### `V2-P1-04`：类人五类记忆与经验成长（模糊印象、情绪关联、级联真删除）
- **状态**：`DONE`（2026-11-25 完成）
- **目标**：在 `memory-graph` 上实现 Working/Episodic/Semantic/Relational/Self 五分域、情绪加权回忆、模糊印象归纳、不确定性表达与覆盖衍生索引的真删除。
- **依赖**：`V2-P1-01`、`V2-P0-03`
- **实现方案**：升级图谱节点分类与巩固任务；区分自然衰减遗忘与显式删除（删除同步清理 SQLite 关联账本、图谱摘要与检索索引，保留审计条目）。
- **验收标准**：可记住“某人常来”而自然淡忘旧单句；主动删除后检索与日记不再出现被删内容。
- **测试方案**：记忆检索加权、模糊摘要与级联删除一致性单测。
- **预计风险**：误删关键系统设定 → 强制隔离 `Self`/`Audit` 保护域。

### `V2-P1-05`：Obsidian Tide 中控台重构与核心工作流界面（后续按 `ADR-003` 演进为 Tidepaper 主基线 + 多主题）
- **状态**：`DONE`（2026-11-26 完成；UI 主设计基线已于 `ADR-003` 修订为 `design/tidepaper/`，原 Obsidian Tide 保留为可选主题）
- **目标**：先按 Obsidian Tide（原 `design/v2-gemini/`，现 `design/theme-obsidian-tide/`）渐进拆分 1,466 行 `App.tsx`，交付真实控制权 HUD、四态回执芯片、许可徽章、声音/记忆/供应商与星露谷共玩主界面；后续 P2–P4 新页面与默认主题Token 遵循 [ADR-003](./adr/ADR-003-uiux-tidepaper-primary-and-themes.md) 与 [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) 以 `design/tidepaper/` 为主参考（原型仅供参考，按实际模块可用度渐进落地）。
- **依赖**：`V2-P1-01`、`V2-P1-02`、`V2-P1-03`、`V2-P1-04`
- **实现方案**：以功能模块组件替代巨型 `App.tsx`（1,466→914 行），落地四大签名组件、`system/dark/light` 三态主题、`F8/F9/F10/⌘K` 全局控制与「V2 生命中枢」面板，未实现能力页（P2/P3/P4）清晰标记 `StageBadge`。
- **退役与回滚**：通过视图组件逐步替换，原有 E2E 选择器全量保留，可按提交独立回滚。
- **验收标准**：零假数据按钮、深浅及跟随系统主题可用、控制台与快捷键可触发真急停与接管。
- **测试方案**：Playwright Electron UI 全页遍历与全部宿主 E2E + `pnpm verify:gate` 7/7 通过。
- **预计风险**：状态订阅与层叠上下文遮挡 → 已修正 `.wb-top > .wb-hud > .wb-main` 层叠与按需轮询。

### `V2-P1-06`：星露谷 AI-First 自主游玩与控制权执行闭环（纠偏核心）
- **状态**：`IMPLEMENTED_UNVERIFIED`（代码、租约与 12 项仿真验收通过，`verify:gate` 7/7 与 Electron 45 E2E 4 套件全绿；详见 [P1-stardew-ai-first-verification.md](./evidence/P1-stardew-ai-first-verification.md)。因缺真实《星露谷》+ SMAPI 客户端，真机 `F7` 接管与连续浸泡待 `[REAL-DEVICE]` 验证后方可转为 `DONE`）
- **目标**：彻底清除星露谷默认流程中的静默规则代驾与硬编码情景决策，跑通“自主决策 → 真实执行 → 桌宠同步 → 朋友协商/强制指令/急停/接管/取消 → 经验进记忆”完整真实闭环。
- **依赖**：`V2-P1-01`、`V2-P1-05`
- **实现方案**：修改 `BrainSwitch` 与 `LlmPlanner`：缺 Key 或 LLM 异常默认安全暂停并告知主人（`RulePlanner` 仅作用户显式开启或测试模式）；新增 `GameCharacterControlLease` / `PausedBrainPlanner` 完善在飞动作取消、过期指令拒绝（`generation/sessionId`）与 13 项控制权租约语义。
- **退役与回滚**：`RulePlanner` 保留作 `opt-in`（`allowRuleStandin`）测试与离线手动模式。
- **验收标准**：通过 Blueprint 17 §12 全部 12 个验收场景（满包自决、自主改变计划、建议协商、强制命令、Stop/Pause/Takeover 真游戏生效）与真机连续浸泡验证。
- **测试方案**：仿真剧本 `S01–S07` + `ai-first-v2.spec.ts` + Electron E2E（已过）+ 真机星露谷验证（待跑真机）。
- **预计风险**：大模型输出偶发不稳定 → 通过结构化输出校验与动作前置条件拦截兜底。

---

## P2：攻略增强、开放生态、完整创作工坊与真实人机联机

- **`V2-P2-01`（`IMPLEMENTED_UNVERIFIED`）：攻略学习闭环增强**（`GameKnowledgeItem` / `GuideProvenance` / `GameRuntimeContext`、`GuideLibrary` 版本与 Mod 兼容检查、`StrategyNotebook` 置信度与反例积累、`LlmPlanner` 实玩回执验真与夜间复盘全通；`verify:gate` 7/7 + 64 专项单测 + Electron 45 E2E 全绿，详见 [P2-guide-learning-verification.md](./evidence/P2-guide-learning-verification.md)；待真实《星露谷》多日实机校验）
- **`V2-P2-02`（`IMPLEMENTED_UNVERIFIED`）：开放生态与插件进程隔离**（第三方插件主进程直连已退役、Worker Isolate 沙箱与 `PolicyBroker` P0–P5 达成 `REQ-SEC-01 DONE`；双向 MCP HTTP/STDIO、受控脱敏 Server、`SkillRegistry` 与 7 家 Harness 执行器完备，`verify:gate` 7/7 与 Electron 45 E2E 全绿，详见 [P2-ecosystem-isolation-verification.md](./evidence/P2-ecosystem-isolation-verification.md)；待外部新 CLI 真机实测）
- **`V2-P2-03`（`IMPLEMENTED_UNVERIFIED`）：`MediaGenerationGateway` 与图片生成流水线**（`@workbench/shared-protocol/media` 十态资产与溯源、`MediaGenerationGateway` 诚实探测+Character Bible+候选区审查隔离+磁盘恢复与宿主 IPC 完成，`verify:gate` 7/7 + 33 专项单测 + Electron 45 E2E 全绿，详见 [P2-media-gateway-verification.md](./evidence/P2-media-gateway-verification.md)；待真实在线生图 Key / 已登录 Codex 出图实测）
- **`V2-P2-04`（`IMPLEMENTED_UNVERIFIED`）：3D 大模型生成与 Blender 自动化后处理流水线**（`@workbench/shared-protocol/media` 3D/VRM 契约、`inspectGlbOrVrm` 二进制骨骼/口型质检、`detectBlenderToolchain` + 无头后处理脚本与 `Pipeline3dManager` 4 路 V2 IPC 完成，`verify:gate` 7/7 + 6 专项单测 + Electron 45 E2E 全绿，详见 [P2-3d-blender-pipeline-verification.md](./evidence/P2-3d-blender-pipeline-verification.md)；本机缺 Blender 与 Hunyuan3D 服务待真机验收）
- **`V2-P2-05`（`IMPLEMENTED_UNVERIFIED`）：Character Bible、2D/Live2D 创作与 CrossPet 全量合法导入**（`@workbench/shared-protocol/media` Character Bible / Live2D QA / 授权门禁 / CrossPet 契约、`CharacterBibleStore` + `inspectLive2dOrLayered2d` + `evaluateAssetDistributionPolicy` + `CharacterStudioV2.importCrossPetPack` 10 路 IPC 完成，`verify:gate` 7/7 + 30 角色真实 CrossPet 全量导入单测 + Electron 45 E2E 全绿，详见 [P2-character-studio-crosspet-verification.md](./evidence/P2-character-studio-crosspet-verification.md)；外部 `.moc3` 真机舞台渲染待 `V2-P3-01` 与实机素材验收）
- **`V2-P2-06`（`IMPLEMENTED_UNVERIFIED`）：游戏像素人物流水线与 Stardew Avatar Mod 导出真机验证**（`@workbench/shared-protocol/media` 像素与导出核验契约、纯 Node PNG 编解码、`PixelAvatarPipelineV2` 11 步流水线与候选审批导出、`verifyStardewAvatarExport`、`WhaleIsleAvatar.dll` Release 编译暂存、`verify:gate` 7/7 + Electron 45 E2E 全绿，详见 [P2-pixel-stardew-avatar-verification.md](./evidence/P2-pixel-stardew-avatar-verification.md)；星露谷进图内外观目视核验待 `[REAL-DEVICE]`）
- **`V2-P2-07`（`DONE`）：`AssetRegistry`、舞台/场景/声音资产创作与版本回滚**（`packages/shared-protocol/src/media` 十态仓库/音画质检/清源契约、`AssetRegistryV2` 不可变快照 + SHA-256 防篡改 + 一键回滚 + `CC BY-NC-SA 4.0` 商用/直播强拦截、原创三主题舞台背景与 5 档无削波 WAV 音效合成及 9 路 V2 IPC 完成，`verify:gate` 7/7 + 3 专项单测 + Electron 45 E2E 全绿，详见 [P2-asset-registry-stage-sound-verification.md](./evidence/P2-asset-registry-stage-sound-verification.md)）
- **`V2-P2-08`（`IMPLEMENTED_UNVERIFIED`）：真实星露谷人机联机协作（`CoopRuntime` v1）**（`packages/shared-protocol/src/coop` 契约、`CoopRuntimeV1` 任务板/防误卖资源预留/成员独立 `GameCharacterControlLease`/断线宽限与超时释放锁防死锁、`evaluateCoopModsCompatibility` + `@workbench/stardew-mods` 本机实盘兼容预检及 8 路 V2 IPC 完成，`verify:gate` 7/7 + Electron 45 E2E 全绿，详见 [P2-coop-runtime-v1-verification.md](./evidence/P2-coop-runtime-v1-verification.md)；双端星露谷客户端真机联机实玩待 `[REAL-DEVICE]`）

---

## P3：统一 2D/3D 表演舞台、自主直播、受控浏览器/桌面与被动多宠

- **`V2-P3-01`（`IMPLEMENTED_UNVERIFIED`）：统一表演系统（Sing Engine SVS/SVC + 舞蹈 + 歌词时钟 + 2D/3D StageRuntime）**（`packages/shared-protocol/src/voice` 契约、`evaluateSongRights` 四重授权门禁、`LyricsClockSync` / `parseBilingualLrc`、`SingEngine` 严格区分 SVS/SVC 与普通 TTS、`PerformanceDirector` 6 层仲裁与自然沉默权、`StageRuntime` 跨 `desktop-2d / live2d / vrm-3d / obs-stage` 无缝保留角色/歌词/口型切换与宿主 8 路 `v2:perf-*` / `v2:stage-*` IPC 完成；`verify:gate` 7/7 + Electron 45 E2E 4 套件全绿，详见 [P3-performance-stage-verification.md](./evidence/P3-performance-stage-verification.md)；真实神经 SVS/SVC 推理与 Cubism/VRM 画布真机观感待 `[REAL-DEVICE]`）
- **`V2-P3-02`（`IMPLEMENTED_UNVERIFIED`）：LifeRuntime 驱动的直播中控与 OBS 舞台（真实平台流接入 + 曲库版权门禁）**（`packages/shared-protocol/src/live` 契约、`LiveRuntimeV2` 弹幕去重护栏/礼物合并/四重版权点歌门禁/`probeLivePlatformEndpoint` 诚实降级探测、OBS 舞台同步、场次摘要、宿主 7 路 `v2:live-*` IPC 与 Tidepaper 中控控件完成；`live-runtime.ts` `91.66%` 分支 + `verify:gate` 7/7 + Electron 45 E2E 4 套件全绿，详见 [P3-live-runtime-obs-verification.md](./evidence/P3-live-runtime-obs-verification.md)；真实抖音/B站/YouTube 测试直播间开播实测待 `[REAL-DEVICE]`）
- **`V2-P3-03`（`IMPLEMENTED_UNVERIFIED`）：受控 Browser Use 与 Computer Use（Per-Character Profile 隔离 + `ComputerUseLease` 单主控互斥）**（`packages/shared-protocol/src/browser-computer.ts` 契约、`AccountVault` / `BrowserProfileMgr` 按角色隔离与级联删除、`ComputerUseLeaseManager` 设备级单主控 + 心跳/TTL + 用户物理输入 ≤1s 抢占、`DeterministicBrowserRunner` 确定性动作与逐步 guard、CAPTCHA/登录挑战 `awaiting_human` 人工交接、P5 一次性确认 token、提示词注入按数据处理不提权、`powerMonitor` 输入监控与 feature flag 默认关闭的 OS 输入执行器骨架，及宿主 `v2:auto-*` IPC 与 HUD 双租约胶囊；ADR-004 回归验证游戏租约不受用户输入影响；runtime-core `90.16%` 分支 + `verify:gate` 7/7 + Electron 45 E2E 3/3 与 `ui.e2e` 9/9 全绿，详见 [P3-browser-computer-use-verification.md](./evidence/P3-browser-computer-use-verification.md)；真实 CGEvent/SendInput 注入、macOS TCC 打包态授权与真实站点风控待 `[REAL-DEVICE]`）
- **`V2-P3-04`（`DOING`）：Digital Life L1（自主浏览、多模态内容理解、兴趣形成与日常调度）**（owner 2026-11-26 批准拆分为 A–F 六个原子工单，依赖 A →（B ∥ C）→ D → E → F）
  - `P3-04A`（`DOING`）：契约先行——`social.ts` L1 只读浏览会话/平台能力矩阵/内容理解/兴趣信号 + `model.ts` 多模态消息 parts
  - `P3-04B`（`PENDING`）：model-gateway 多模态映射与脱敏
  - `P3-04C`（`PENDING`）：SocialRuntime L1 只读浏览内核
  - `P3-04D`（`PENDING`）：内容理解管线与兴趣沉淀
  - `P3-04E`（`PENDING`）：日程调度接线与状态可见
  - `P3-04F`（`PENDING`）：mock-harness 站点仿真与 E2E 验收
- **`V2-P3-05`：多被动桌宠同屏展示（独立形象/动作/基础音色，主从隔离）**
- **`V2-P3-06`（`IMPLEMENTED_UNVERIFIED`）：星露谷一键启动器与真实就绪探活**（`stardew-launcher.ts` 实现「安装探测 → 直接 spawn SMAPI → 等 BWF `get_state` 真实应答才置 `ready`」，已在运行去重、子进程 detached 不随宿主退出；回退 `open steam://rungameid/413150`；标题画面自动 `load_save({})`；顺带修复 `game-health.ts` 把「标题画面返回 200 + isError:false」误判为 `online` 的编造就绪缺陷。真机两种启动方式均实测进档，见 [P3-stardew-launcher-verification.md](./evidence/P3-stardew-launcher-verification.md)；剩余缺口：中控台按钮触发路径未单独录屏、Windows/Linux 仅纯函数单测、Steam 回退会打开 Terminal）

---

## P4：单角色全功能闭环、自主社区交互与 Evolution Engine Full

- **`V2-P4-01`：单角色“小鲸”全产品链路端到端整合与长时真机验收**
- **`V2-P4-02`：Social Digital Life L2 → L3（草稿审核到规则与授权边界内自主社交互动发布）**
- **`V2-P4-03`：Evolution Engine Full（脱敏遥测、问题自动复现回放、策略化合并与灰度回滚）**

---

## P5：多自主 AI 角色、多设备协作与扩展游戏生态

- **`V2-P5-01`：多完整自主 AI 角色运行时、独立账号与记忆空间隔离**
- **`V2-P5-02`：跨设备 `DeviceRegistry` 与多 AI 多人联机游戏协作（`CoopRuntime` Full）**
- **`V2-P5-03`：多游戏适配器真机解冻与扩展（Terraria / Don't Starve Together / Minecraft）**
