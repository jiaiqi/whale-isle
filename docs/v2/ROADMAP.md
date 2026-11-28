#\n> 2026-11-28 14:19 V2-P4-01：参考复评确认本仓晨间计划未吃「今日节日/生日/可执行任务/季末」事实（planner已解析但day-plan未用）。新增 today-schedule.ts 解析节日名称地点时间窗、生日、带交付方式的任务、季末，汇总为事实段注入晨间计划，并允许计划项带 timeHint 时间安排；只陈述客观信息不指定玩法。今日安排事实回归5/5通过，包编译通过；完整门禁待执行。证据见 docs/v2/evidence/P4-01-today-schedule-facts.md。\n Whale Isle V2 完整开发路线图（P0–P5 · 唯一工单真源）

> 2026-11-28 14:08 V2-P4-01：恢复桌面客户端后发现真实 pet-window-prefs.json 累积13条窗口记录（12条为一次性伴生桌宠 pet-crosspet-claude-*，多个坐标完全相同）。根因是 save() 对已关闭窗口的持久化记录一律保留、仅对 pet- 前缀封顶12个，导致每次召唤-关闭都留孤儿记录。已改为不再写回临时召唤类窗口，常驻桌宠坐标保留不变；磁盘残留已清理为仅 default。pet-window-manager回归17/17通过；完整门禁待执行。证据见 docs/v2/evidence/P4-01-pet-window-config-leak.md。

> 2026-11-28 14:02 V2-P4-01【目标达成】真实到达第1年秋1日06:50并完成3次目标日动作（reachedTargetDay=true、targetDayActions=3）。两季共56游戏日、3075次真实动作、金钱500g→771g；本次运行62决策/1211s，clipped/overlap/emptyShell/watchdog全0，控制台错误0，语音完成3次，记忆2450节点，真实存档mtime零变化。秋1日完成社区中心「夏季采集」收集包并领夏季种子x30。证据归档 docs/v2/evidence/P4-01-two-season-acceptance.md 与 two-season-data/。仍未验：物理F7、Windows、人类听感、原生形象视觉抽验、多层重影整屏对照。

> 2026-11-28 13:59 V2-P4-01：夏28月光水母之舞真实执行 enter COMPLETED（在场29人）、greet 与27人打招呼成功。但 festival start 的「刘易斯没有问要不要开始…没有主活动」被回执分类误判 UNCERTAIN（原文含“可能”），与紧邻 FAILED 语义冲突，模型连续重试3次。已改为确定性结论判 FAILED，真正不确定仍保留；adapter回归17/17通过。完整门禁待执行。证据见 docs/v2/evidence/P4-01-festival-receipt-semantics.md。

> 2026-11-28 13:49 V2-P4-01：夏28真实出现生命47/120（39%）时旧30%阈值不提示任何风险，随后Farm↔Mine往返5次、白耗约4小时游戏时间（每次travel_to均COMPLETED且时钟推进，既不属无进展也不触发卡死哨兵）。生存提醒新增≤50%「生命过半偏低」前置提醒，不改写玩法。规划回归38/38通过；完整门禁待执行。证据见 docs/v2/evidence/P4-01-low-health-reminder.md。

> 2026-11-28 15:56 V2-P4-01：真机复核跨日失败账本——账本已在真实存档中持久化并在**新进程**里跨日保留（秋5 首次的 list_chests 花椰菜 / travel_to AnimalShop / interact (69,15)，到秋7 06:00 仍累计 4/3/3 次且标注跨日）。但模型仍在同一坐标重复失败，原因是提示段排在长篇「长期经验」之后被稀释、语义上也离「失败记忆」太远。已把跨日失败提示移到「失败与停滞记忆」紧后面、长期经验之前，并补齐可执行的下一步方向（站位不可达换相邻可站坐标、门未开先做别的事、物品不存在先 list_chests、路线不通改用中转地图），仍不指定具体动作。新增回归断言提示段位置。账本回归 9/9、planner 集成 40/40，门禁 8/8。提交 c738395。


> 2026-11-28 15:22 V2-P4-01：秋5 真机暴露「桌宠会忘」——夏28 已学到 (69,16) 站位不可达并写进心得本，秋5 却在同一坐标连续失败 3 次。根因：失败记忆窗口只有最近 8 条回执（跨日即冲掉）、心得本检索只看季节/地点/状态原文（召不回坐标级教训）。新增跨日失败动作账本 failed-action-ledger.ts：按「工具+关键参数」签名累计，随心得本同文件持久化（跨日跨进程保留），累计≥2 次生成只陈述事实的提示段（次数/参数/最近原文/跨日标记），不判定该怎么办、不改回执状态、不替模型选动作。接线拆到 failed-action-ledger-wiring.ts 以保持 llm-planner.ts ≤500 行硬门禁。账本回归 9/9、planner 集成 40/40，门禁 8/8。证据见 docs/v2/evidence/P4-01-cross-day-failed-action-ledger.md。修复的真实跨日效果需载入新构建后再观察。


> 2026-11-28 15:10 V2-P4-01：多日连续观察跑通秋1→秋5（真实回执 COMPLETED 105 / FAILED 30，决策 130，emptyShell/overlap/clipped/watchdog 全 0，真实存档 mtime 零变化）；晨间计划实测含「生日给潘妮送最爱的礼物」，今日安排事实注入生效。定位「空气泡」根因为零宽字符（String.trim() 不移除 U+200B）导致外壳照画正文无墨，改为清洗+展示前判定+渲染期兜底三层防御；秋2 暴露 special_orders 参数契约缺失（模型传 accept:true），已在工具提示写明 accept 只收 left|right。气泡回归 25/25，门禁 8/8。证据见 docs/v2/evidence/P4-01-multi-day-observation-and-empty-bubble.md。工单仍为唯一 NEXT。
> 2026-11-28 13:44 V2-P4-01：夏28真实出现take_items在同一坐标(69,16)四次失败「四周没有可站处」、另多处空箱，共10次调用；实测确认该箱内有木材x89但四周被箱子围死，属真实不可达。重复失败提示增补同工具层（≥3次、原因各异也提示换参数无益），两层并存。规划回归37/37通过；完整门禁待执行。夏28书摊循环0、空区域清理0，较夏27明显下降。

> 2026-11-28 13:41 V2-P4-01：夏28真实保存后载入新构建（存档mtime零变化，旧实例summary：clipped/overlap/emptyShell/watchdog全0）。同时发现夏27 upgrade_tool连续3次因同一缺口失败、熔炉“还在加工”重复探测，现有失败记忆只留最后一条签名。已补「重复失败动作」提示（按工具+原因归并，≥2次列出次数与原文，不指定玩法），规划回归36/36通过；完整门禁待执行。证据见 docs/v2/evidence/P4-01-repeated-failure.md。

> 2026-11-28 13:30 V2-P4-01：夏27真实出现书商摊同一坐标interact 11次、close_menu 10次，界面开合不消耗游戏时间，卡死哨兵（仅按时钟停滞）无法发现。提示层由仅覆盖空区域扩展为「重复无进展动作」：最近8条内空区域清理或反复开合界面达阈值时列出次数与原文，保留COMPLETED，不指定玩法。规划回归35/35通过；完整门禁待执行。证据见 docs/v2/evidence/P4-01-no-progress-loop.md。

> 2026-11-28 13:27 V2-P4-01：真实只读采样5点中3点状态超4000，2点把「任务」从中间切断，3500晨间上限多次切断「文字地图」。三处盲切改为按##章节预算，省略段标注原字数与只读工具，无章节状态也按行边界保留。规划/计划回归40/40通过；完整门禁待执行，真实效果需载入后复验。证据见 docs/v2/evidence/P4-01-state-context-budget.md。

> 2026-11-28 13:22 V2-P4-01：用户截图报告频繁空心气泡（仅有心情徽标、正文空白）。原因定位为读完正文后字体/尺寸重算把正文清空仍保留外壳，以及空间不足分支保留空壳；已改为保留当前页原文并隐藏不可容纳壳。真实 Electron 回归1/1通过（8.70s），验收脚本新增空心可见采样。完整门禁待执行，真机效果需载入后复验。证据见 docs/v2/evidence/P4-01-empty-bubble-shell.md。

> 2026-11-28 13:14 V2-P4-01：夏26真实出现重复空区域成功回执，提示层新增最近5条内的重复空结果次数与原文事实；保留COMPLETED，不改执行状态、不指定后续工具，提醒模型核对位置、范围与真实资源变化。新增回归，完整提交门禁待执行；真实效果需过夜后载入，当前运行仍b92acdb。证据见 docs/v2/evidence/P4-01-empty-result-context.md。

> V2-P4-01 13:09续修：状态气泡统一容量分页并扩大最小宽度；角色加载、播放回调与动作音频按独立实例释放。Electron三泡共存及角色延迟重载回归3/3通过，最终音频归属修改后角色回归1/1通过；隔离存档推进夏26，仍未达到秋1目标，保持唯一NEXT。

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
  - **2026-11-27 增补**：默认档切商业 API 已落地为显式档位（`voiceEngineTier`，本地引擎降为可选离线档，`tierHonored` 如实报告是否兑现）；UI 直接渲染离线档体感代价；`StubLocalBackend` 冒名与 `supportsEmotion` 硬编码已修，`/health.tts` 走实测探针。仍待：**两家商业 TTS 真实 Key 的听感对拍**（owner 已批：MiniMax + OpenAI 都接；当前实例为 `--use-mock-keychain` 读不到真实凭据，真实 vault 缺 `openai-tts`，缺项见证据文档 §10.2）与 ZipVoice 内部验证（**已跑完**：RTF P50 0.475 / 一句话 1.2–2.9 秒 / 冷启动 0.61 秒 / 678 MB / ASR 回环 11/15 逐字一致，但权重 CC-BY-NC 不可商用不可随包、无情绪通道、未接 `fetch-engine.mjs` 与 Worker，见 [zipvoice-internal-validation.md](./evidence/zipvoice-internal-validation.md)），见 [TTS-local-engine-benchmark-verification.md](./evidence/TTS-local-engine-benchmark-verification.md) §9。**2026-11-27 小米 MiMo 已作为候选接入**（`MimoTtsProvider`，VoiceClone/VoiceDesign 两模式）：候选与稳定两家在架构上分离，不进自动兜底链、不设默认，`probe()` 不宣称情绪；真实 API **未实连**（缺 `mimo-tts` 凭据），首包/耗时/音色漂移/情绪全部未实测，另单列「限时免费风险」与切回路径，见 [mimo-tts-candidate-integration.md](./evidence/mimo-tts-candidate-integration.md)。
  - **2026-11-27 二轮增补**：① 修好分支上坏掉的 director 构建——渲染层不再经包桶入口拖进 `plugin-kit`（`node:*`）与 `runtime-core` 的 Node 模块，改用子路径入口 `@workbench/runtime-core/errors` 与 `@workbench/voice-runtime/browser`；② MiMo 补齐第三个模型 `mimo-v2.5-tts`（9 内置音色 / `(唱歌)` 前缀 / 唯一流式模型，适配器仍非流式），风格控制纠正为「user 自然语言指令 + assistant 前缀标签 + 正文内联标签对所有模型有效」，认证头做成 `bearer`/`api-key` 可配置（两种都未实测），`optimize_text_preview` 仅 voicedesign，`supportsStreaming` 由谎报的 `true` 改回 `false`；③ OpenRouter `google/gemini-3.8-flash-tts` 接为**第四家商用候选**（`/audio/speech` 原始字节、按 token 计费、情绪控制方式官方无说法一律不宣称）；④ 语音中心新增四张凭据输入卡（复用 `providers:save-key`，明文只上行、只显示掩码、保存即重探，来源标注凭据库 > 环境变量 > 未配置）；⑤ 修掉「试听一句」的 `spawnSync mcode-tools ENOENT`——`voice:audition` 原本无条件直调 mcode 且无路由，现改为优先走 V2 `VoiceProviderRouter`（选中商业 provider），无注入时才退回 mcode 且先探测。新增 [VOICE-PERSONA-xiaojing.md](./VOICE-PERSONA-xiaojing.md)（音色描述模板 + 五情绪映射 + 合规边界）。真实 API 仍全部未实连。
  - **2026-11-27 三轮增补（真机实连）**：MiMo `mimo-tts` / `mimo-voicedesign` 与 OpenRouter 均已实测通（5/5 + 5/5 + 3/3），认证头 `api-key` 与 `Bearer` 都已实测通；新增 `tools/scripts/vault-key.cjs` 让 bench 直接读凭据库（`--from-vault`，Key 只经管道进内存）。供应商 UI 重做：MiMo 三个模型收成「一个 Key · 三个模型」组 + 内置音色下拉（`voiceMimoBuiltinVoice`），OpenRouter 加模型输入（`voiceOpenRouterModel`，每次合成重读）；「限免」只给 MiMo（OpenRouter 按 token 计费，纠正错标）。新增「音色设计」页签（描述/文本/五情绪/optimize_text_preview/播放器/下载），「设为桌宠声线」写角色 VoiceIdentity 并切默认档，主进程每次合成重读描述。
  - **2026-11-27 四轮增补（漂移实测 + bench 修复）**：VoiceDesign 音色漂移**已实测**——同一描述 ×10 说话人余弦最小 0.4145，不能当固定声线；产品路径写死「VoiceDesign 出候选 → 人工挑 → VoiceClone 用自产音频锁死」（锁定稳定性在跑）。修复 bench 两处 bug：`voiceRef: 'bench_voice'` 占位串让 MiniMax 25/25 全拒（改为 `--voice` + 各 provider 默认音色，MiniMax → `qiaopi_mengmei`）；`voice_setting.emotion` 传 app 自定义键被拒（新增 `MINIMAX_EMOTION_MAP` 映射闭合枚举，未知情绪不传字段）。`group_id` 确认不需要。MiniMax 第三层是 Token Plan 用量用尽（账单问题）。MiniMax/OpenAI 的 `supportsStreaming` 同样从谎报的 true 改回 false。
  - **2026-11-27 五轮增补（owner 定主线 + 声线来源 UI + 门禁加构建）**：① owner 拍板「定 MiMo 主线」——默认档 `voiceCommercialProvider` 改为 `mimo-tts`，MiniMax 额度耗尽停用但 provider 与 BYOK 卡保留（卡上写明可自行填凭据恢复）；`CANDIDATE_TTS_PROVIDERS` 原本就不含 `minimax-tts`，无需改动。② 语音中心的「声线来源」重做成三卡：内置音色（9 个逐个可选、单独试听，`v2VoiceSynthesizePreview` 新增 `voiceRef`）、克隆声线（上传本地 wav → 试听 → 设为声线 → 清除，新 IPC `v2:voice-clone-sample-info/save/clear`，RIFF 校验 + 20MB）、设计声线（漂移提示 + 跳转设计台）；稳定两家与 OpenRouter 收进「备用供应商」。③ **measure**：VoiceClone 锁定一致性实测（自产参考 ×10 余弦均值 0.8342 / 最小 0.7500 / σ 0.0430）；daily 情绪稳定性实测（×10：时长 CV 6.2%、RMS σ 1.39dB、F0 中位 230.8–266.7Hz），新增 `tools/scripts/voice-stability.py`；OpenRouter 计费口径核对（token 计费，$0.50/M 入 · $9/M 出，实扣未测）与 30 个预置音色池（实调 Zephyr/Kore）。④ **门禁**：`verify:gate` 新增 Gate 1 打包护栏（`desktop-host build` 必过，owner 批准），由来是分支曾整天打不出 director 包而旧 dist 掩盖。**仍待**：owner 选音色方向（描述矩阵在跑）、其余四档情绪稳定性、唱歌听感、OpenRouter 实扣。
  - **2026-11-27 六轮增补（声线定稿 + 锁声线）**：owner 决赛圈两轮一致勾选四条声线（02 御姐冷·年轻 / **07 黏糊·调皮（默认）** / 08 黏糊·半睡 / 12 憨憨·偏低发呆），描述权威副本进契约层 `MIMO_TIMBRE_PRESETS`。**锁声线**：用 07 描述现场合成一条干净参考音频随包分发（`assets/voice/xiaojing-07-nianhu-piqi.wav`，台账标 `DEV_ONLY_NON_COMMERCIAL`），默认档改 `mimo-tts-voiceclone`；主进程 clone 源优先级「用户上传 → 随包基准 → 环境变量」；语音中心新增「声线库」（试听 = VoiceDesign 预览，锁定 = 现场生成参考音频并切档）；启动时把未被改过的默认人设描述迁移到 07。**回归**：clone 锁定 ×10 余弦均值 0.8373 / 最小 0.7723 / σ 0.0245（优于此前 0.8342/0.7500/0.0430）；五档情绪 ×3 的客观量档间跨度与档内波动同量级 → **客观量上五档没拉开**，听感留给 owner。**边界写死**：MiMo 限时免费且无商用条款，「MiMo 主线」不等于可以长期当商用默认依赖，商用前须换授权 TTS 并重做参考音频。
  - **2026-11-27 七轮增补（02/08/12 三候选锁定回归 + 设计版 vs 克隆版差异）**：owner 听 07 的**锁定版**后判「音色不对味」→ 三候选各做一套同法流程（各自同句参考音频 + clone ×10 + 五档情绪 ×3，78 次真实调用），**默认声线不动**（仍 07）。**锁定一致性**：02 0.8275/0.7189/σ0.0414、08 0.8705/0.7552/σ0.0395、12 **0.8912/0.8340**/σ0.0285（07 0.8373/0.7723/σ0.0245）→ 12 > 08 > 07 > 02。**关键测量**：clone 输出 vs 各候选 VoiceDesign 原样本的余弦 07 0.8409 / 02 0.7925 / 08 0.8811 / 12 0.8987，与各自内部一致性同量级 → **clone 没把音色改坏**，是「07 设计味本就不对味」，下一步是挑一条而不是修 clone（02 偏低 0.035 是唯一例外）。**五档情绪**：四条候选的档间跨度都与档内波动同量级 → 客观量上一律没拉开；另测得 12 基频仅 ~89–95Hz。**未做**：主观盲测、「更长更有情绪层次的参考音频再克隆一次」（按编排要求留待下一轮）。
  - **2026-11-27 八轮增补（情绪方法验证 + 音色定稿改为八九岁小女孩）**：owner 改判音色方向为「小萝莉，可爱、调皮、傲娇，8 岁左右」，此前四条成人向描述与产物全部作废（只留方法证据）。**情绪方法验证**（候选 12，六臂各 15 条真实调用）：直接「按档情绪参考 + 按档克隆」确实能把情绪锁住（F0 档间极差 130.11Hz vs 严格匹配对照 12.79Hz；参考对齐 14/15 vs 4/15），代价是**角色被换掉**（五条情绪参考彼此余弦仅 0.5158，克隆对他人参考 0.5041）；两段式参考保人（自相似 0.8150、身份 gap 0.1222）但情绪效果掉回对照水平（F0 26.75Hz、韵律判据未过）→ **该方法不接产品**；并如实记录预注册判据的缺陷（D/E 对照臂也会被判成立，M2 需改为 ≥3× 档内 σ 且 ≥3× 对照）。**音色定稿**：`MIMO_TIMBRE_PRESETS` 只剩 `07-tiancui-yuanqi`，随包参考音频换成新生成的 `assets/voice/xiaojing-07-tiancui-yuanqi.wav`（5.12s / F0 406.78Hz），clone 锁定 ×10 均值 **0.9059** / 最小 **0.8814** / σ 0.0148（与成人基线 0.8373/0.7723 并列写，儿童声线**没有**更差）；旧档案描述命中两个历史默认值时迁移；语音中心改定稿态。**三种表演**（调皮/傲娇/撒娇，同一句 ×3，指令 + 前缀标签 + 一个内联标签）：9/9 成功，客观量只有时长分开（5.17 vs 4.16s），F0 档间极差 12.9Hz vs 档内 σ 42–78Hz、RMS 1.06dB vs σ 1.2–3.5dB → **基频与响度没拉开**，听感待 owner 真机验收。02/08/12 与旧 07 参考音频撤出随包资源（归档本机 `artifacts/voice-archive-2026-11-27/`）。证据 §2.16.2 / §2.17。
  - **2026-11-27 九轮增补（表演重做：强度阶梯 A/B/C）**：owner 判「音色对，表演要重做，三档都要重做，主要是情绪太弱」→ 同一句 × 三档 × 三级（A 指令加「更外放」/ B 重写夸张指令 + 只用标点 / C 再加两个内联标签）× 每格 2 条 = 18/18 成功，**随包资产、默认声线、VOICE-PERSONA、UI 未动**。预注册判据（P1 Δ(F0) ≥ 2σ；P2 Δ(时长) ≥ 2σ 且 Δ(RMS) ≥ 2σ）跑前写死：**A 不成立**（Δ RMS 0.56 vs 3.37）、**B 成立**（Δ 时长 1.36 vs 0.83、Δ RMS 4.45 vs 2.74）、**C 不成立**（方差暴涨）。与上一版并排：Δ RMS 1.06 → 4.45dB（夸张指令 + 标点贡献最大）、Δ 时长 1.01 → 1.36s、Δ F0 12.8 → 51.0Hz（内联标签贡献最大）；**基频三档始终没分开**（B 级三档 348.1/347.8/347.8Hz）。C 级比同档 B 长 2.3–2.9s → 标签大概率生效（间接判断，非听感）。推荐 调皮 B-1 / 傲娇 B-2 / 撒娇 B-1（各带一个 C 备选），等 owner 听完再一次性接产品映射。产物 `artifacts/tts-ab/perform2-07-tiancui/`。
  - **2026-11-27 十轮增补（音色工坊 M1+M2 + 表演 B 级接线收档）**：owner 拍板「m2+m1吧」，正在进行的音色不再要 AI 出图确认，改由 owner 在工坊里自调。① **B 级接线**：`daily` / `bright` / `tsundere` 三档指令换成 §2.18 B 级原文（`resolveMimoEmotionHint()` 默认 B）；A/C 只作为工坊试戴强度暴露；`sleepy` / `surprised` 无阶梯数据不编模板；C 级内联标签仍标注「间接推断、未经听感」；写死否定结论「**音高区分情绪这条路在 MiMo 指令层上不成立**」；证据明写「owner 未逐条试听，将在工坊中自调」。② **音色工坊**：语音中心新增第四个页签（声线卡 / 一致性体检 / 生成候选 / 多句试戴 + 定格），合同在 `packages/shared-protocol/src/voice.ts`（拨盘选项、4 句试戴台词、候选/版本/体检 schema），逻辑在 `apps/desktop-host/src/main/voice-workshop.ts` + 六个 `v2:voice-workshop-*` IPC。③ **体检真实跑数（同句 ×10 ×3 次）**：bench 0.9059/0.8814/σ0.0148、工坊第一次 **0.8632/0.7296**/σ0.0451、第二次 **0.8795/0.7876**/σ0.0402 → 同一随包参考会在「锁得稳 / 偶尔飘」之间翻面，**判据保持原样不改**，UI 注明可重跑；§2.17 的单一数字今后必须带上波动区间。④ **边界**：出厂默认不动；用户定格只写 `userData/` 不进 git；M3（上传录音/音色包导入导出/换引擎重做）不做且不留半成品入口，但元数据存全；MiMo 限免，工坊如实显示会话调用数、配额耗尽直接报错不静默降级；`pet:sleep-status` 竞态仍只读记录不修。证据 §2.19。
  - **2026-11-27 十一轮增补（替代引擎速评：本机找不到「可商用 + 有情绪 + 实时」的自托管 TTS）**：owner 拍板「现在就排替代引擎速评」，判据先写死（许可可商用 + RTF P50 ≤ 0.35 才进听感对比）。**实测**：Kokoro-82M-v1.1-zh（Apache-2.0）RTF 0.316–0.338 / 固定 sid 余弦最低 0.9920 / 无语义情绪控制；MeloTTS-zh（MIT）RTF 0.221–0.267 / 余弦最低 0.9010 / 单一成年女声无情绪；Chatterbox Multilingual（MIT，`exaggeration` + 克隆 + 中文）稳态 **RTF 2.98–3.23（首条预热 12.4）→ 实时出局**；CosyVoice2 上游沿用前序 RTF 2.42。**许可出局**：Spark-TTS（CC-BY-NC-SA）、F5-TTS（CC-BY-NC）、ZipVoice（CC-BY-NC）、IndexTTS2（bilibili 自定义许可）、Fish Speech（社区许可，商用限营收）、Piper zh_CN（数据集许可 Unknown）；GPT-SoVITS 维持开发期基线。**CosyVoice2 ONNX/CoreML 移植**：ONNX 模块 Apache-2.0 + C++ 运行时 MIT，但预转换 GGUF 只到 CosyVoice3、macOS 需自配 GGML 1.x → 未成熟，未实测。证据 [tts-alternative-engine-eval.md](./evidence/tts-alternative-engine-eval.md)，试听素材 `artifacts/tts-ab/engine-eval/`。**结论：情绪+克隆路线继续走商业 API；仅当接受固定音色时才考虑 Kokoro**；听感（儿童感/情绪）待 owner。
  - **2026-11-27 十二轮决策（owner 拍板：放弃自托管语音）**：说话语音定为「**开发期 MiMo 主线（限时免费、页面无商用条款）+ 长期商业授权 TTS**」；「自托管优先 / 本机可跑通」**不再作为目标**，也不再把本地 Worker 当作可交付降级路径。依据：替代引擎速评 `b9d2632`（本机全部不过）。**唱歌链路不受影响**：SVC/SVS 属唱歌引擎，继续按 item 5 / ADR-005 执行（`V2-P3-07`）。`offline_preferred` 档位与 `planVoiceFallback()` 代码保留为可选实验能力，但文档、验收与路线图不得再写「离线优先」目标。
- **目标**：P1 即交付真实可用角色语音与口型联动（不捆绑重型本地模型），改造 `AudioLeaseManager` 解除单音轨对伴奏/音效的阻塞。
- **依赖**：`V2-P1-01`
- **实现方案**：抽象 `VoiceProvider`（**真实云端情绪 TTS API**：开发期 MiMo 主线、长期商业授权 TTS；`say`/Win SAPI 仅标为降级方案）。**本地/自托管语音不再作为交付目标**（owner 2026-11-27 拍板放弃，依据替代引擎速评 `b9d2632`：本机没有「可商用 + 有情绪 + 实时」的自托管 TTS）；`offline_preferred` 档位仅作为历史实验能力保留，不进产品承诺。拆分发言权（Speech Floor）与 `AudioMixer` 多轨播放；输出音量包络/Viseme 驱动桌宠嘴型。
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
- **状态**：`IMPLEMENTED_UNVERIFIED`（代码、租约与 12 项仿真验收通过，`verify:gate` 8/8 与 Electron 45 E2E 4 套件全绿；详见 [P1-stardew-ai-first-verification.md](./evidence/P1-stardew-ai-first-verification.md)。2026-11-28 已在真实《星露谷》+ SMAPI + Keychain LLM/MiMo 隔离新档跑通完整第 1 天到第 2 天清醒 `06:00`（`reachedDay2=true`、`watchdogs=[]`、`clippedCount=0`、`overlapCount=0`），详见 [P4-01-llm-chain-verification.md](./evidence/P4-01-llm-chain-verification.md)；真机 `F7` 物理热键、全量 13 项控制语义逐项实按与多日持续浸泡仍待 `[REAL-DEVICE]` 验证后方可转为 `DONE`）
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
- **`V2-P2-06`（`DONE`）：游戏像素人物流水线与 Stardew Avatar Mod 导出真机验证**（`@workbench/shared-protocol/media` 像素与导出核验契约、纯 Node PNG 编解码、`PixelAvatarPipelineV2` 11 步流水线与候选审批导出、`verifyStardewAvatarExport`、`WhaleIsleAvatar.dll` Release 编译暂存、`verify:gate` 7/7 + Electron 45 E2E 全绿；2026-11-26 `[REAL-DEVICE]` 真机目视核验通过：游戏内玩家外观为蓝鲸女仆像素形象，与导出贴图正/背帧一致，移动落位与浇水动作帧正常，详见 [P2-pixel-stardew-avatar-verification.md](./evidence/P2-pixel-stardew-avatar-verification.md)）
- **`V2-P2-07`（`DONE`）：`AssetRegistry`、舞台/场景/声音资产创作与版本回滚**（`packages/shared-protocol/src/media` 十态仓库/音画质检/清源契约、`AssetRegistryV2` 不可变快照 + SHA-256 防篡改 + 一键回滚 + `CC BY-NC-SA 4.0` 商用/直播强拦截、原创三主题舞台背景与 5 档无削波 WAV 音效合成及 9 路 V2 IPC 完成，`verify:gate` 7/7 + 3 专项单测 + Electron 45 E2E 全绿，详见 [P2-asset-registry-stage-sound-verification.md](./evidence/P2-asset-registry-stage-sound-verification.md)）
- **`V2-P2-08`（`IMPLEMENTED_UNVERIFIED`）：真实星露谷人机联机协作（`CoopRuntime` v1）**（`packages/shared-protocol/src/coop` 契约、`CoopRuntimeV1` 任务板/防误卖资源预留/成员独立 `GameCharacterControlLease`/断线宽限与超时释放锁防死锁、`evaluateCoopModsCompatibility` + `@workbench/stardew-mods` 本机实盘兼容预检及 8 路 V2 IPC 完成，`verify:gate` 7/7 + Electron 45 E2E 全绿，详见 [P2-coop-runtime-v1-verification.md](./evidence/P2-coop-runtime-v1-verification.md)；双端星露谷客户端真机联机实玩待 `[REAL-DEVICE]`）
- **`V2-P2-09`（`PENDING`，owner 暂缓）：星露谷 farmhand 联机 AI 控制与实例隔离**（勘察与方案见 [P2-09-farmhand-split-screen-audit.md](./evidence/P2-09-farmhand-split-screen-audit.md)：farmhand 在同机分屏下**有条件可行**——游戏侧支持多 `Game1` 实例与 `Context.ScreenId`，但现版 BWF 是进程级单例、零分屏感知，直接跑会控制错人；隔离推荐 spawn 注入绝对路径 `XDG_CONFIG_HOME`，不动 `HOME`）。**owner 决策（2026-11-26）：先不做分屏功能，先把一个桌宠的功能走通**——本单整体暂缓，已交付的 A/B/C/E/F 保留在 `feat/whale-isle-v2` 不回滚，等单桌宠链路走通后再启动 D。拆为 A–F 六子单：
  - `V2-P2-09A`（`IMPLEMENTED_UNVERIFIED`）契约：`StardewLaunchOptionsSchema` 增 `isolateDataDir`（绝对路径强校验），新增 `StardewScreenBindingSchema`；
  - `V2-P2-09B`（`IMPLEMENTED_UNVERIFIED`）隔离启动：启动器与联机队友实例注入 `XDG_CONFIG_HOME`/`XDG_DATA_HOME`（不动 `HOME`），Steam 策略与相对路径显式拒绝；单测 74 例全绿，真机「owner 存档零写入」待验；
  - `V2-P2-09C`（`IMPLEMENTED_UNVERIFIED`）宿主联机身份绑定：`CoopParticipant.bodyBinding` + `CoopBodyLeaseViewSchema` 契约先行，`CoopRuntimeV1` 新增按身体的绑定/改绑、`participantOfBody` 解析、按身体的「玩家一动即接管」判定与跨身体动作路由拦截，宿主 4 路 IPC（`v2:coop-body-bind`/`-body-leases`/`-human-takeover`/`-action-route`）；单测 15/15 + Electron 45 E2E 1/1 全绿；**真机 bodyBinding 值来源（BWF 按 `Context.ScreenId` 上报）属 `V2-P2-09D`，尚未开工**；
  - `V2-P2-09D`（`PENDING`，owner 暂缓）BWF 分屏感知补丁：按 `Context.ScreenId` 路由动作。owner 决策（2026-11-26）：「先不做分屏功能，先把一个桌宠的功能走通」——本单与全部分屏相关子单一起按下，等单桌宠链路走通后再启动，不再挂「等 owner 完成 cabin + 手柄前置」的阻塞理由；
  - `V2-P2-09E`（`IMPLEMENTED_UNVERIFIED`）按屏「玩家一动即接管」与 `ABORTED_BY_HUMAN_TAKEOVER` 回执：`CoopInFlightActionSchema`/`CoopTakeoverAbortReceiptSchema` 契约先行，`beginBodyAction`（同身体动作互斥锁）/`finishBodyAction`（只接受真实三态回执）/接管时按身体中止并产出回执，宿主 2 路新 IPC；单测 9/9 + E2E 2/2 全绿；**真机接管事件来源属 D（`BLOCKED`），D 放行前本单不得 `DONE`**；
  - `V2-P2-09F`（`IMPLEMENTED_UNVERIFIED`）分屏 farmhand 沙盒剧本骨架：3 个确定性剧本（host 屏输入不抢租约 / farmhand 屏一动接管并中止 / 缺身体标识不判定）+ 重放一致性回归，4/4 全绿；**剧本输入为手工编排数据，`[SIMULATION]`，真机屏幕标识来源属 D（`BLOCKED`），不得记为 `[REAL-DEVICE]`**。

---

## P3：统一 2D/3D 表演舞台、自主直播、受控浏览器/桌面与被动多宠

- **`V2-P3-02A`（`IMPLEMENTED_UNVERIFIED`，owner 2026-11-27 授权独立支线）：直播互动编排第一切片（规则卡 / 点赞目标 / 投喂榜）**。目标：现有事件驱动三张 OBS 卡、默认关闭且持久化的中控台设置、确定规则匹配/同人冷却/全局节流/去重/周期一次触发/同分同名次；复用气泡与四重版权点歌门禁，不依赖 SVC。依赖：`V2-P3-02`；验证：新增编排单测、临时 userData 的 Electron 设置保存与重启恢复、真实 `/obs` 渲染和转义、完整门禁，见 [P3-02A 证据](./evidence/P3-02A-live-engagement-verification.md)。7 个业务源码文件，配置可即时关闭或独立 revert，进度/榜单仅保留本场单一状态；待真机：平台增量归一与 OBS 实播观感。后续切片：累计赠礼触发、动作/语音表演与真实播放回执、SVC 真唱；不改变 `V2-P4-01` 的 `NEXT`。

- **`V2-P3-01`（`IMPLEMENTED_UNVERIFIED`）：统一表演系统（Sing Engine SVS/SVC + 舞蹈 + 歌词时钟 + 2D/3D StageRuntime）**（`packages/shared-protocol/src/voice` 契约、`evaluateSongRights` 四重授权门禁、`LyricsClockSync` / `parseBilingualLrc`、`SingEngine` 严格区分 SVS/SVC 与普通 TTS、`PerformanceDirector` 6 层仲裁与自然沉默权、`StageRuntime` 跨 `desktop-2d / live2d / vrm-3d / obs-stage` 无缝保留角色/歌词/口型切换与宿主 8 路 `v2:perf-*` / `v2:stage-*` IPC 完成；`verify:gate` 7/7 + Electron 45 E2E 4 套件全绿，详见 [P3-performance-stage-verification.md](./evidence/P3-performance-stage-verification.md)；2026-11-26 真机补验：`services/sing-worker` 部署并把 `SingEngine.workerEndpoint` 真正接上（此前从未注入，探测形同虚设），真机三层探测 `Electron → sing-worker(18880) → GPT-SoVITS(9880)` 跑通，SVS/SVC 如实 `unavailable`、普通 TTS 单列 `ttsClone` 且 detail 强制带「普通 TTS 不得当作 SVS/SVC 使用」告警；歌词时钟真实墙钟度量 max 偏差 25ms / P95 25ms（容差 60ms）；跨 `live2d/vrm-3d/obs-stage/desktop-2d` 状态 `retained=true`；pet-stage 实为 WebM 视频渲染（0 canvas、60.4 FPS、0 丢帧）、无 `.moc3`/`.vrm` 资产故画布观感无从谈起；GPT-SoVITS 真实推理实测 HTTP 200 / 1.01s / 32000Hz / 2580ms（**属 TTS 非唱歌**，故仍不置 `realNeuralInferenceVerified`）；仍缺合法 `.moc3`/`.vrm`、歌声合成与音色转换后端权重及索引、真实五组情绪参考音频；**2026-11-26 点歌台宿主接线完成**：`v2:song-capabilities/request/snapshot/cancel/shutdown` 五路 IPC 接通 `SongConsole` → audio-ai-worker `/api/song/*` → SQLite `song_cache_index` → 首切片 `afplay` 挂载（真实退出回执），缓存键覆盖源文件指纹/声线模型/全部调参，真实 Electron IPC 验证门禁拒绝、违禁黑名单、后端缺失逐项 unavailable、取消与退出清理、失败不落缓存；**无 Demucs/RVC/曲库，分离、转换与首片播放均未实测**，详见 [P3-song-console-host-verification.md](./evidence/P3-song-console-host-verification.md)；状态维持 `IMPLEMENTED_UNVERIFIED`）
- **`V2-P3-02`（`IMPLEMENTED_UNVERIFIED`）：LifeRuntime 驱动的直播中控与 OBS 舞台（真实平台流接入 + 曲库版权门禁）**（`packages/shared-protocol/src/live` 契约、`LiveRuntimeV2` 弹幕去重护栏/礼物合并/四重版权点歌门禁/`probeLivePlatformEndpoint` 诚实降级探测、OBS 舞台同步、场次摘要、宿主 7 路 `v2:live-*` IPC 与 Tidepaper 中控控件完成；`live-runtime.ts` `91.66%` 分支 + `verify:gate` 7/7 + Electron 45 E2E 4 套件全绿，详见 [P3-live-runtime-obs-verification.md](./evidence/P3-live-runtime-obs-verification.md)；真实抖音/B站/YouTube 测试直播间开播实测待 `[REAL-DEVICE]`；2026-11-26 **OBS 本地闭环实测**：obs-websocket 5.7.6 真实握手并完成建场景/建 browser_source/截图/删场景全链路，overlay 事件前后两帧像素确有变化（13186→19775 B）且 OBS 窗口实拍可见卡片，OBS 音频输入收到真实电平（44 帧、峰值 0.0884）；同时发现本机 OBS 33.0.3 开启浏览器源硬件加速时 `browser_source` 全黑（连本地静态页也黑），关闭后正常，已还原原设置；仍未开播、未接触推流密钥，本 app 音频进 OBS 受 TCC 与虚拟声卡阻塞，详见 [P3-02-obs-local-closure-verification.md](./evidence/P3-02-obs-local-closure-verification.md)）
- **`V2-P3-03`（`DONE`）：受控 Browser Use 与 Computer Use（Per-Character Profile 隔离 + `ComputerUseLease` 单主控互斥）**（`packages/shared-protocol/src/browser-computer.ts` 契约、`AccountVault` / `BrowserProfileMgr` 按角色隔离与级联删除、`ComputerUseLeaseManager` 设备级单主控 + 心跳/TTL + 用户物理输入 ≤1s 抢占、`DeterministicBrowserRunner` 确定性动作与逐步 guard、CAPTCHA/登录挑战 `awaiting_human` 人工交接、P5 一次性确认 token、提示词注入按数据处理不提权、`powerMonitor` 输入监控与 feature flag 默认关闭的 OS 输入执行器骨架，及宿主 `v2:auto-*` IPC 与 HUD 双租约胶囊；ADR-004 回归验证游戏租约不受用户输入影响；runtime-core `90.16%` 分支 + `verify:gate` 7/7 + Electron 45 E2E 3/3 与 `ui.e2e` 9/9 全绿；2026-11-26 3c 真机补验完成——自研 Swift helper（CoreGraphics CGEvent）编译接线 + `[E2E-HOST]` 真实注入 e2e 通过（live 模式指针精确落位读回、合成事件不误伤租约、无权限 fail-closed 如实降级），详见 [P3-browser-computer-use-verification.md](./evidence/P3-browser-computer-use-verification.md)；macOS 打包态 TCC 授权流程与 Windows SendInput 为后续发布工程项，真实站点风控实测属 P3-04 范畴）
- **`V2-P3-04`（`IMPLEMENTED_UNVERIFIED`）：Digital Life L1（自主浏览、多模态内容理解、兴趣形成与日常调度）**（owner 2026-11-26 批准拆分为 A–F 六个原子工单，依赖 A →（B ∥ C）→ D → E → F，全部完成；`verify:gate` 7/7 × 6 次推送 CI 全绿 + `[E2E-HOST]` 全链路 1/1，详见 [P3-04-social-life-verification.md](./evidence/P3-04-social-life-verification.md)；真实供应商多模态联调、真实平台浏览与 scheduler 自动发起循环待 `[REAL-DEVICE]`/后续增强；**抖音公开精选页只读已由 `P3-04H` 在真实平台跑通，个性化流/直播弹幕/多日浸泡仍未接**）
  - `P3-04A`（`DONE`）：契约先行——`social.ts` L1 只读浏览会话/平台能力矩阵/内容理解/兴趣信号 + `model.ts` 多模态消息 parts（9 例契约单测，纯本地可验）
  - `P3-04B`（`DONE`）：model-gateway 多模态映射与脱敏（OpenAI image_url / Anthropic image block 双协议映射、文本与图片 URL 脱敏、supportsVision=false 预检跳过、入站契约校验；6 例新单测，包分支覆盖 94.27%；真实供应商多模态调用联调随 P3-04 整链验收）
  - `P3-04C`（`DONE`）：SocialRuntime L1 只读浏览内核（会话状态机 planned→active⇄paused/awaiting_human→completed/aborted、能力矩阵门禁「授权+已实测」双条件、L1 互动能力契约外再拦、maxItems/maxDurationMs 预算自动收官、事实事件广播；5 例单测，social-runtime.ts 分支覆盖 93.33%；runner 抓取接线归入 P3-04D 管线）
  - `P3-04D`（`DONE`）：内容理解管线与兴趣沉淀（`content-understanding.ts` 窄网关端口 + 多模态消息编排 + JSON 抽取 Zod 终审 + modelId 取回执真实路由；`interest-sink.ts` 兴趣信号确定性映射 ±0.5 封顶 + 噪声门槛 + PreferenceStore(topics) 带来源历史 + 记忆窄端口 event/concept 派生链；dependency-cruiser 边界经端口注入反转保持；8 例单测）
  - `P3-04E`（`DONE`）：日程调度接线与状态可见（social 计入 LifeRuntime 资源密集活动预算守卫、SocialRuntime.updateCapabilities 热更新、宿主装配 SocialRuntime+理解管线+兴趣沉淀（网关复用 autodrive `chatViaGateway` 同一 Key/饭碗计量、记忆端口接 memoryHost）、9 路 `v2:social-*` IPC、能力矩阵落盘 `v2-social-capabilities.json` 原子写、中控台生活页 L1 浏览面板；38+2 例单测、v2-kernel/ui e2e 全绿。暂缓项如实记录：scheduler tick 自动发起会话的循环未接（当前手动/事件驱动）、pet-stage 浏览状态投影归 P3-04F）
  - `P3-04F`（`DONE`）：mock-harness 站点仿真与 E2E 验收（social-site-sim 确定性仿真站 3 例单测 + social-life.e2e 全链路 1/1：能力门禁→规划→runner 真实读取→预算收官→无 Key 诚实报错→pet-stage 思考泡投影；证据文档已归档）
  - `P3-04G`（`IMPLEMENTED_UNVERIFIED`）：自主发起策略 scheduler tick（owner 2026-11-26 四条口径全部落成：默认关闭 / 每日 ≤2 次且累计 ≤30 分钟 / 间隔 90–150 分钟 ±20% 抖动 / 收官或失败冷却 ≥60 分钟 / 本地 00:00–08:00 禁发 / 连续 2 次失败当日停发；单次预算 20 条 · 10 分钟 · 理解 ≤8 次；P0 急停立即 abort 在跑会话；暂停/急停、用户玩游戏/直播/用电脑、平台未实测、模型不可用逐项拦截并给出人话原因；桌宠气泡改为只报开始/收官，不再逐条刷屏；新增 23 例确定性单测，`verify:gate` 7/7）。**续：L1 浏览执行器骨架已并入本单**（候选来源抽象 / 逐条读取 / 内容理解配额 / 中途打断 / 双门禁，`social-executor.spec.ts` 12 例全过）；宿主 `allowLocalFixture=false` 且**不注册任何候选来源**，`status()` 恒 `runnable=false`，`executorReady` 仍为 false → 开关打开也不会发起。**G 时点真实平台浏览一律不接**（首个真实平台由下方 `P3-04H` 接入）；无 `[E2E-HOST]`/真机验证，详见 [P3-04G-social-autostart-verification.md](./evidence/P3-04G-social-autostart-verification.md)
  - `P3-04H`（`IMPLEMENTED_UNVERIFIED`）：抖音 L1 只读真实平台接入（owner 2026-11-27 拍板「首个真实平台 = 抖音」）。新增 `packages/character-core/src/social-douyin.ts`（精选公开页候选 + 视频页公开字段读取 + 验证码/登录墙立即停 + 7 天证据 TTL + 18 例单测）；宿主接独立 `persist:whale-char_xiaojing-douyin-owner` Profile（隐藏读窗 / 可见扫码登录窗 / Cookie 只落本机 profile，不代填密码、不存凭据），`executorReady`/`runnable` 仅在真实冒烟通过后置真并登记能力矩阵 `douyin/read_public`；生活页新增「真实冒烟（读 3 条）」「打开登录窗（扫码）」与证据/上次 tick 展示，**默认仍关**。**真实读数**：候选 5 → 读到 3、0 失败、26.3s（2026-11-27 09:10:55 CST），真实会话 `bs-65e7a249` 3 条 / `completed` / 27.6s；公开精选页本次**无需 owner 扫码**（`loggedIn=false`）。**未验**：个性化推荐/关注流（代码由 `P3-04I` 接续，真实冒烟受阻）、真实验证码/风控页面样本、真实模型内容理解、多日浸泡；`P3-04H` 时点扫码不会改变 feed，只保存登录态。`pnpm verify:gate` **8/8**，证据 [P3-04H-douyin-l1-verification.md](./evidence/P3-04H-douyin-l1-verification.md)
  - `P3-04I`（`IMPLEMENTED_UNVERIFIED`，真实冒烟受阻）：抖音个性化流「推荐 / 关注」L1 只读（owner 2026-11-27「继续做个性化流」）。三种 feed（公开精选 / 推荐 / 关注）；未登录、登录态读取失败、平台重定向、登录墙、空流一律**如实回落公开精选**并把 `requestedFeed / usedFeed / loggedIn / fallbackReason` 写进证据；只有请求的那条流自己读到 ≥3 条才置真（`isDouyinRequestedFeedVerified`），公开精选证据不冒充个性化。宿主按 `byFeed` 分流存证（旧证据自动回填）、新增 `v2:social-douyin-feed` 与 feed 参数冒烟；生活页增加流选择与请求/实际/回落展示。推荐流桌面 Web 直连 `/?recommend=1` 会被 302 到 `/jingxuan`，改由宿主在精选页内**点击「推荐」导航标签**进入（只读）；关注流补 `video-info[data-e2e-aweme-id]` 抽取。**真实读数**：owner 2026-11-27 09:56:49 扫码登录成功（只检查 Cookie 名称）；09:59 只读探测推荐流 **8 张卡片**、关注流 **2 张卡片**（非生产冒烟，不置真）；10:04 生产冒烟遇到抖音 **「验证码中间页」**，按红线立即停止、未绕过/未再刷，`ok=false`、`runnable=false`。**未验**：真实个性化冒烟（阻塞于真实验证码，需 owner 亲手处理后冷却重约）、关注流门槛（当前账号只渲染 2 条）、真实验证码恢复流程、真实模型理解、多日浸泡。单测 **29 例**、`verify:gate` **8/8**，证据 [P3-04I-douyin-personalized-verification.md](./evidence/P3-04I-douyin-personalized-verification.md)
  - `P3-04K`（两段同号：① CDP 只读驱动 `DONE`（真机只读复验完成）；② 受限自动顶层评论 `IMPLEMENTED_UNVERIFIED`（真实发送待验））。**①** 抖音只读读取路径换成「真浏览器 + 独立持久 Profile + CDP」（`P3-04J` §4 Option A）。新增 `cdp-browser-engine.ts`：macOS 按 Chrome→Edge 探测（缺失即 BLOCKED，不下载）、专用 Profile `~/Library/Application Support/Whale Isle/douyin-browser-profile`（绝不用 owner 日常 Chrome Profile）、`--remote-debugging-port` + `--remote-debugging-address=127.0.0.1` 仅回环、自有 marker + `/json/version` 探活保证单实例（不硬拉第二个）、退出只清 lock/marker 不删 Profile、Cookie 只查名称不读值、CDP 请求 20s 兜底超时；`electron-browser-engine.ts` 保留为回退驱动，按 `v2-douyin-browser.json` 切换（macOS 默认 `cdp-real`）。页面读取脚本抽到 `douyin-page-reader.ts` 供两驱动共用。**真机读数（Chrome 158.0.8127.88）**：未登录公开精选 60 卡→无验证码；owner 11:12:54 扫码后 Cookie 名称出现 `sessionid/sessionid_ss/sid_guard`；推荐探测 9 卡、关注探测 0 卡（「暂时没有更多作品」）；生产冒烟连续两轮 `itemsRead=3`、0 失败、6.3–6.9s、`ok=true`，**全程未出现「验证码中间页」**，故推荐流本轮置真、关注流因账号无可读作品仍不可运行；并明确「本轮没撞到 ≠ 已解决风控」。单测 **55 例**（新增驱动/契约 25 例），证据 [P3-04K-douyin-real-browser-verification.md](./evidence/P3-04K-douyin-real-browser-verification.md)。**2026-11-27 item 20 四项补强（仅单测 `[SIMULATION]`）**：启动参数补防后台节流三件套（未加 stealth/UA 覆盖）、`Page.navigate` 后校验 `location.href` 并重试一次、`/video/<id>` 被重定向时降级 `?modal_id=<awemeId>`（撞验证码绝不降级）、验证码改按「可见且 >120×120」的 DOM 元素判定、标题命中验证码页仍按正则立即停；两个 spec **68 例**全过，真机只读复跑待 owner 授权。**②** 受限自动顶层评论（owner 2026-11-27 明确优先）。保留 L1 浏览 `readonly`，浏览正常收官后由独立 `DouyinCommentExecutor` 对**他人公开视频**尝试一条顶层评论；模型决定是否评论、无逐条审核；默认关闭，发送前 SQLite `BEGIN IMMEDIATE` 预留额度，失败/跳过/不确定同样占额度，`pending` 重启转 `uncertain` 不自动重发；验证码/登录墙即停；生活页可按自然日翻页查看原文与结果，开启开关不会伪造实测时间。默认预算：日 10 次尝试、时 3 次、间隔 180s、同视频 30 天冷却、本地 00–08 禁发。决策见 [ADR-006](./adr/ADR-006-douyin-bounded-comments.md)。**已验证**：46 例单测 + 真实 Electron 本地仿真 E2E 1/1（16.99s）+ 真实构建主应用中控台 UI/IPC 实测（默认关闭、未验证状态、种入仿真记录展示与按日期查看）+ `verify:gate` 8/8。**未验**：真实已登录抖音评论 DOM、真实平台单条发送与回读、真实模型「浏览→评论」长循环（P3-04I 生产冒烟仍阻塞于验证码，本轮未重试/未绕过）。证据 [P3-04K-douyin-bounded-comments-verification.md](./evidence/P3-04K-douyin-bounded-comments-verification.md)；`P3-04J` 保留为生态调研编号。**2026-11-27 评论端口下沉（PR #10）**：评论能力提取为 Electron/CDP **共用端口**（`createDouyinCommentPort`，两驱动只注入 `navigate/evaluate/sleep/now`，DOM 脚本共用），CDP 驱动不再缺评论入口；`cdp-browser-engine.ts` 的 R1 由「严格只读」改为「只读 + **受限评论**（ADR-006）」，其余禁令逐条保留；新增端口/判定单测 23 例 + 仿真 CDP 端点 E2E 1/1 证明 `cdp-real` 下评论端口正确注入；仍未向抖音发起任何真实评论、`lastVerifiedAt` 保持 0。**2026-11-27 复核返工（PR #10）**：① 回执归属改为「发送前读当前账号 `sec_uid`（否则昵称+头像）→ 新评论作者必须是本人」才继续重载确认，作者缺失/不符判 `uncertain`；② `v2:social-comment-verify` 入口抓 `commentGeneration`，每个 await 后比对，中途暂停/改设置即中止；③ 暂停条件收窄为验证码/登录墙/账号异常，结构性错误与 `uncertain` 只回报、不关开关（`social-comment-pause.ts`）；④ 三个评论 IPC 增加主框架 + renderer 路径 sender 校验；⑤ 评论护栏先去空白/标点并全角转半角再匹配，补 `威信`/`vx`/`v信`/`v薇` 变体，手机号允许分隔符，@ 剥离无需前置空白，并写明「护栏是兜底，不是安全边界」。新增 11 例单测 + Electron E2E 两条断言（缺端口 `failed`/无 `sent`/0 点击；结构性错误不暂停、验证码才暂停）。
- **`V2-P3-05`：多被动桌宠同屏展示（独立形象/动作/基础音色，主从隔离）**
- **`V2-P3-06`（`DONE`）：星露谷一键启动器与真实就绪探活**（`stardew-launcher.ts` 实现「安装探测 → 直接 spawn SMAPI → 等 BWF `get_state` 真实应答才置 `ready`」，已在运行去重、子进程 detached 不随宿主退出；回退 `open steam://rungameid/413150`；标题画面自动 `load_save({})`；顺带修复 `game-health.ts` 把「标题画面返回 200 + isError:false」误判为 `online` 的编造就绪缺陷。真机两种启动方式均实测进档，见 [P3-stardew-launcher-verification.md](./evidence/P3-stardew-launcher-verification.md)；2026-11-26 `[REAL-DEVICE]` 补验完成：中控台顶栏「启动」按钮**真实 CGEvent 点击**端到端验证（不调 IPC）——点按钮 → 启动弹窗 → 确认 → 游戏拉起并自动读档（`saveLoadRequested/autoLoadSave`）→ BWF 真实应答 → 自动驾驶接管（帧连拍证据 `P3-06-before-click.png` / `P3-06-after-click-driving.png`），详见 [P3-stardew-launcher-verification.md](./evidence/P3-stardew-launcher-verification.md) 第 6 节；本次抓到两个真实缺陷：①启动后 BWF 就绪竞态需重试（2026-11-26 已修：`AutodriveRunner.start()` 支持 `readyTimeoutMs`/`readyPollMs` 就绪重探，宿主注入 90s 窗口 + 2s 间隔，等待期间 `stop()` 安静取消、不误报不可达；单测 4 例，`[SIMULATION]` 级，真机冷启动等待表现待复验）；②CGEvent 点击需窗口前台（未修，属单桌宠链路待办）；Windows/Linux 仍仅纯函数单测、Steam 回退会打开 Terminal）
- **`V2-P3-07`（`DONE` · 星露谷建档批次：第一个桌宠从 0 自动建档/建角色，单机 + 联机房主 + 默认存储隔离 + 中文双保险）**（证据详见 [P3-stardew-auto-new-save-verification.md](./evidence/P3-stardew-auto-new-save-verification.md)；与下方同号 ADR-005 歌声/舞台路线为两条并行立项的 P3 批次）：
  - `V2-P3-07A`（`DONE`，commit `358f5a8`）：契约先行——`packages/shared-protocol/src/stardew-launch.ts`（`StardewLaunchOptions`/`LaunchStatus`/`LanHostStatus`/`LaunchPrefs`/`NewSaveConfig` 8 种农场类型与 locale 映射，跨语言生成 JSON Schema + Pydantic）及 `StardewAvatarSyncSchema.syncDisplayName`；
  - `V2-P3-07B`（`DONE`，commit `2f9d7e8` + `f8d7d2a`）：BWF 第 3 份增量补丁（`WHALE_BWF_MCP_PORT` / `WHALE_STARDEW_LANG`、`EnsureLanguage()`、`create_new_save`、扩展 `load_save`、`GET /settings` 带 `runtime`/`lan` 与 `1.6` 未认领小屋槽位 `isUnclaimedFarmhand` 判定）及 `WhaleIsleAvatar` `SyncDisplayName` 防覆写；已 Release 编译部署本机 `Mods/`（原 DLL 已保留 `.bak-*` 备份）；
  - `V2-P3-07C`（`DONE`，commit `6a746bc`）：硬化 `BwfMcpClient.ping()`（拒绝标题画面与 `isError=true`；分支覆盖 `92.59%`）与 `game-health.ts`（`probeBwfRuntime()` + `requireLanHost` 门禁）；
  - `V2-P3-07D`（`DONE`，commit `3ff7e8b`）：`stardew-launch-prefs.ts`（默认 `isolated` 隔离 + `zh` 中文 XML 双保险）、`stardew-launcher.ts`（`always_new`/`continue_or_create`/`load_only`/`manual`、`TITLE_NOT_READY`/`LANGUAGE_LOADING` 重试、`BWF_PATCH_MISSING` 快败、`coop_host` LAN 监听等待）与宿主 IPC/preload/bridge（不吞 `safeParse` 错误）；2026-11-27 `[REAL-DEVICE]` R1（常规目录只读续玩 `泡泡湾_454908853` + `AutodriveRunner` `wait` COMPLETED + `Saves/` 零变动）、R2（后台零 CGEvent 隔离中文单机从 0 建档 + P2-06 2× 精灵表 + `SaveGameInfo` 未覆写农夫名）、R3（后台隔离中文联机房主 + 2/2 空余小屋 + `lsof` UDP 24642 监听）、R4（切换 `bak-1.1.27-stock` 1.81s 快败 `BWF_PATCH_MISSING` + 恢复补丁版 `/settings` 全能力位回归）全部通过；
  - `V2-P3-07E`（`DONE`，commit `cceccd6` + `WHALE_E2E_REAL_STARDEW_LAUNCHER=1` 真机 UI 实测）：中控台一键「从 0 单机开玩」「从 0 联机房主开玩」、存储模式开关（默认隔离 ↔ 常规）、折叠表单、弹窗与 `⌘K` 入口；Electron E2E 10/10 与 `[REAL-DEVICE]` 真实中控台点击 `[data-stardew-new-singleplayer]` 拉起 SMAPI 建档 `鲸屿_455395474`（17.53s 翻绿，退出还原干净、owner 存档零变动）全部通过。

- **`V2-P3-07`（`PENDING`，owner 2026-11-27 拍板后新增 · ADR-005 歌声/舞台批次）：歌声系统与舞台形象技术路线（ADR-005）**

  > 路线决策见 [ADR-005](./adr/ADR-005-singing-and-stage-technology-route.md)（owner 原文逐字收录）；素材与选型明细见 [P3-01-MATERIALS-NEEDED.md](./P3-01-MATERIALS-NEEDED.md)。
  > **验收铁律（owner 原文）**：核心评价标准是「角色声音自然、生动、有自己的风格，形象与动作灵活，整套系统能够自动化运行并持续扩展，而不是单纯完成技术接口接入」。**PoC 通过 ≠ 需求达成**；本单系歌声/形象类，最高只能标 `IMPLEMENTED_UNVERIFIED`，直到有真实素材 + 真实听感/真机画面证据。

  - **2026-11-27 阶段一前置结论（`[DOC-ONLY]`，不接入）**：选型定稿 + 素材清单已交，见 [V2-P3-07-svc-svs-selection.md](./evidence/V2-P3-07-svc-svs-selection.md)。SVC 代码只剩 RVC（MIT）可进，Seed-VC（GPL-3.0）/ so-vits-svc（AGPL-3.0）排除；SVS 主线 DiffSinger（Apache-2.0）+ OpenUtau（MIT）；RVC 底模「仅供研究」、RMVPE 无 LICENSE、OpenCpop/OpenVPI 声码器权重非商用 → 商用须自训。五组情绪参考音实缺四组（`sweet_normal` 只有合成 stub），录制规格与授权声明模板已写死。**本轮未下载权重、未跑推理、未改代码**；阶段二（真唱最小闭环）阻塞于 owner 授权素材与可追溯 `.pth`。

  **阶段划分（三阶段，顺序不可颠倒）**：

  - **阶段一（`V2-P3-07A`~`V2-P3-07D`，`PENDING`）：SVC 翻唱 + VRM 1.0 一个完整角色跑通**
    - `V2-P3-07A`（`IMPLEMENTED_UNVERIFIED`）**契约先行**：`SingingProfile` / `SingingMode`（`svc | svs | svs_svc`）/ `VoiceIdentity` 的 Zod 契约（`packages/shared-protocol`），以及 `Embodiment` 域「多形态并存」数据模型；契约层从第一天就按三种实现设计，不做只支持 SVC 的窄契约。
      - **2026-11-27 已落部分**：`packages/shared-protocol/src/singing.ts`（`VoiceIdentity` 含授权声明/监护人/权重许可、`SingingProfile` 含路线/音域/风格/情绪参考、`SingingMaterialManifest` 含逐文件事实与问题码、`SingingReadiness`，以及 24kHz/5s/−3dBFS 情绪素材与 ≥10 分钟训练干声规格常量，已登记 `registry.ts` 并生成 JSON Schema + Pydantic）；`packages/voice-runtime/src/singing-profile.ts`（`checkSingingMaterial` / `summarizeSingingMaterials` / `resolveSingingReadiness`，商用渠道 + 非商用权重/未授权声源/儿童无监护人授权一律 blocker，文案写死「商用必须自训底模/声库」）；单测 39/39。**`Embodiment` 多形态模型仍未做**，故本项不标 `DONE`。
      - **2026-11-27 素材链路落地**：`apps/desktop-host/src/main/singing-materials.ts`（真实 WAV 头 + PCM 样本 → 采样率/位深/声道/时长/峰值/头尾静音/SHA-256，流式读取不整文件进内存；`consent.json` 只读声明编号；manifest 落 `userData/singing/materials.json` 只存事实）+ 三个 IPC `v2:singing-materials-dir/state/scan` + 中控台点歌台页签「演唱素材」面板（目录可复制、六组覆盖、逐文件问题、`ready`/`commercialReady` 两行结论）。owner 2026-11-27 拍板情绪参考音按**六组**验收（`clumsy_panic` + `happy_rice` 并存），契约常量与扫描器已按六组实现。单测 10/10（扫描器）+ 39/39（契约与判定）；点歌台页签另有「打开文件夹」入口（`v2:singing-materials-open-dir`，目录不存在先创建；E2E 只断言入口存在、不点击，避免干扰 owner 用机）与 `[E2E-HOST]` 断言（六组 chip、扫描后 ready=否、blockers 含授权声明与引擎未安装、commercialReady=否）。
    - `V2-P3-07B`（`PENDING`）**SVC 落地**：干声分离 → 目标音色转换 → 伴奏混音的端到端链路接上现有点歌台；歌声模型走**独立 Worker + 按需下载**（`fetch-engine.mjs` 模式），主安装包不含权重；GPL/AGPL 项目禁入；普通 TTS / GPT-SoVITS 一律不得当 SVC。
    - `V2-P3-07C`（`PENDING`）**VRM 1.0 真实渲染**：Electron 舞台窗口内的 WebGL VRM 运行时，覆盖加载/骨骼/待机呼吸/视线表情/音频驱动口型/歌舞/节拍同步/摄像机灯光场景；桌面与 OBS 双输出一致；与现有 `WebmVideoRenderer`（双 `<video>`，不占 WebGL）资源隔离。  - **2026-11-27 素材侧先行**：owner 定调「保留蓝鲸女仆设定、素材必须原创重做」，规格已写死到 [P3-01-MATERIALS-NEEDED.md](./P3-01-MATERIALS-NEEDED.md)（VRM 1.0 结构、humanoid 骨骼、必须含 `aa/ih/ou/ee/oh` 与五情绪 preset、`meta` 七个许可字段取值、≤80k 面 / ≤8 材质）。同文件写清两条硬事实：VRM 1.0 **没有 viseme 概念**；生成式 3D **不能直接产出 VRM**，必须先 VRoid 或生成网格后进 Blender 人工补表情与 springBone（插件只能走 MIT 分支）。素材到位前本单维持 `PENDING`。
    - `V2-P3-07D`（`PENDING`）**一个完整角色端到端**：同一角色走完「点歌 → 演唱 → 伴奏混音 → 歌词 → 口型 → 舞蹈 → 桌面 + OBS 输出」，并以真实素材（owner 提供的授权声源与 `.vrm` 资产）完成真机听感与画面验收。
    - **阶段一的前置阻塞（必须如实记为 `BLOCKED`，不得绕过）**：① 训练/转换用**授权声源**由 owner 提供；② `.vrm` 资产由 owner 提供或经 `V2-P2-04` 流水线产出；③ 歌声模型权重的许可须先逐文件核实（见 `O5-svs-svc-weight-license-per-file.md`）。
  - **阶段二（`V2-P3-08`，`PENDING`）：SVS 与 SVS+SVC + 角色自己的演唱风格**
    - `V2-P3-08A`（`PENDING`）SVS 实现（乐谱 + 歌词 + 音素 → 歌声）：DiffSinger / OpenUtau 路线的可部署性与**无人值守自动化**能力须先 PoC 验证；官方检查点与声库许可须闭合，否则自训。
    - `V2-P3-08B`（`PENDING`）SVS+SVC 串联（先生成演唱 → 再统一音色），把角色的音域/演唱风格真正落到 `SingingProfile` 上——这是「SVC 交付音色、SVS 交付演唱风格」差异的收口。
    - `V2-P3-08C`（`PENDING`）**Live2D 精细化 2D 形象**：作为后续 2D 方案落地，**不取消该产品需求**；排在 VRM 之后，不阻塞阶段一。
    - `V2-P3-08D`（`PENDING`）多形象并存 UI 与资产治理：同一角色多形态并存的可视化切换与 `AssetRegistry` 许可门禁联动。
  - **阶段三（`V2-P3-09`，`PENDING`）：自动化与持续扩展**
    - `V2-P3-09A`（`PENDING`）歌声/形象链路的**无人值守自动化**：点歌 → 自动演唱 → 自动混音 → 自动口型与舞蹈的端到端自动运行，失败时诚实降级并给出人话原因。
    - `V2-P3-09B`（`PENDING`）**持续扩展机制**：新歌声引擎/新渲染器的接入成本收敛到「实现接口 + 声明能力」，且不影响既有形态。

  **本单明确不做的事**：不同时强制集成所有歌声模型；不把重型模型捆绑进主安装包；不在阶段一之前就宣称角色演唱风格已实现。


---

## P4：单角色全功能闭环、自主社区交互与 Evolution Engine Full

- **`V2-P4-01`（`NEXT`，`P3-04K` 已封口为 `IMPLEMENTED_UNVERIFIED` 后恢复唯一激活主线）：单角色“小鲸”全产品链路端到端整合与长时真机验收**（owner 决策「先把一个桌宠走通」后成为唯一激活主线；软件链路 E2E 6/6 + `MemoryGraph`/`KnowledgeHost` + 伴随反应 + `.pet-bubble-voice` + `dockToGame` 默认贴边右下角三端同步已落地；2026-11-28 凌晨完成 `BwfStateSectionCache` 省略段水合、BWF 调试 HUD 同步隐藏、动态目标链、长动作超时与零待浇水/未读信提示、报错气泡短句与自适应上下避让，并于真实 macOS Keychain（DeepSeek + MiMo 锁声）+ 隔离中文新档完整跑通 **第1年春1日 06:00 → 过夜结算（170g→406g，夜间复盘 2 条心得）→ 春2日 06:00**（`669s`、`reachedDay2=true`、`TIMEOUT=0`、`watchdogs=[]`、`overlapCount=0`、`clippedCount=0`、`maxAmplitude=0.5038`、`sawMutedVisible=false`、真实个人存档 zero-mutation），证据 [P4-01-llm-chain-verification.md](./evidence/P4-01-llm-chain-verification.md)；仍待真机：终改后多日第 2 天起连续浸泡与 `StrategyNotebook` 演进、游戏内物理 `F7` 热键、13 项控制语义全量实按与 Windows 端验证）
  - **2026-11-28 日间续验进行中**：隔离两季游玩推进至夏24，目标秋1尚未完成；巡检每2分钟。Todo编号、历史时间与末项移除修复后完整门禁8/8，长气泡分页与DOM回归继续验证。工单仍为唯一 `NEXT`，详见 [计划修复证据](./evidence/P4-01-day-plan-repair.md)。
- **`V2-P4-04A`–`D`（`IMPLEMENTED_UNVERIFIED`，2026-11-27 派单支线；`V2-P4-01` 仍为唯一 `NEXT`）：外部参考融合第一垂直切片（Envoy 只读材料 → Evidence Pack → 候选知识 → 真实 `get_state` 实玩回执）**（代码与自动化证据完成：04A 知识契约兼容扩展（材料/证据/适用性/回执/来源状态/导入与执行入参，`GameKnowledgeItem` 新字段全部有默认值）；04B `node:sqlite` 新增 4 张知识表与原子导入/历史版本/回执持久化，迁移失败不留半表；04C 独立 Envoy MCP 只读适配（`envoy_read` 白名单、realpath 授权目录、隔离环境与进程组回收、缺 envoy/uv/材料逐项 `unavailable` 并回退本地攻略）；04D 宿主 IPC 7 条固定通道 + CLI 复跑入口，真实 BWF `get_state` 参与适用性、复用 `ActionLock` 与三态回执，状态无变化判 `UNCERTAIN/suspicious`。`pnpm verify:gate` **8/8**；本单 5 文件 38 用例、Electron E2E 1/1（2968ms）、已进 macOS CI。**未验证**：真实 Envoy/owner 材料读取（本机 envoy 与 `~/WhaleIsle` 材料目录均缺失，真实 probe 如实 `unavailable`）、真实 Envoy 两次 digest 复现、真实游戏同链路、Windows 子进程树回收；参考 Envoy 本地材料不支持 Markdown 的冲突已记录。证据 [EXTERNAL-FUSION-D1-slice-verification.md](./evidence/EXTERNAL-FUSION-D1-slice-verification.md)；04A 的 social 观察版本/Outbox 留 04F/G，04E 知识 UI 未做）
- **`V2-P4-02`：Social Digital Life L2 → L3（草稿审核到规则与授权边界内自主社交互动发布）**
- **`V2-P4-03`：Evolution Engine Full（脱敏遥测、问题自动复现回放、策略化合并与灰度回滚）**
- **`V2-P4-05`（`DONE`，2026-11-27）：内部开发预览构建 `0.2.0-dev.2`**（owner 口径：本版只保证「能装、能跑」，商用素材清源推后；从冻结 SHA `e4019f3` 打包 macOS arm64 DMG `2,322,093,040 B` / sha256 `1f87e71b…`，两个 Swift helper 预编译随包 `Contents/Resources/native/darwin-arm64/` 并带 sha256 清单，安装副本独立 userData 启动后中控台/桌宠/气泡正常、音频 helper 日志 `origin=prebuilt`、安装副本直接执行 `permission`/`probe` 通过；`pnpm verify:gate` **8/8**；证据 [PREVIEW-BUILD-e4019f3-verification.md](./evidence/PREVIEW-BUILD-e4019f3-verification.md)。**未验证**：真实音频播放、OS 输入端到端注入、真实星露谷/抖音/OBS、Windows 包、签名与公证；包内素材只盘点未清源）

---

## P5：多自主 AI 角色、多设备协作与扩展游戏生态

- **`V2-P5-01`：多完整自主 AI 角色运行时、独立账号与记忆空间隔离**
- **`V2-P5-02`：跨设备 `DeviceRegistry` 与多 AI 多人联机游戏协作（`CoopRuntime` Full）**
- **`V2-P5-03`：多游戏适配器真机解冻与扩展（Terraria / Don't Starve Together / Minecraft）**
