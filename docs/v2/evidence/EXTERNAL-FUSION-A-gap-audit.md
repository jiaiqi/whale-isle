# EXTERNAL-FUSION A · 鲸屿现状差距审计（对照九仓外部参考）

> 日期：2026-11-27 · 基准 commit：`dba66ec`（`origin/feat/whale-isle-v2`，已 fetch；高于 owner 指令文档审计基线 `7fcb3e3`）
> 性质：**只读审计与设计输入，不改任何产品代码、不加依赖、不改 ROADMAP/CURRENT 工单状态**。
> 证据分级沿用仓库口径：`[REAL-DEVICE]` / `[REAL-PLATFORM]` / `[E2E-HOST]` / `[SIMULATION]` / `UNVERIFIED`。
> 阅读范围：`packages/{shared-protocol,character-core,memory-graph,game-bridge-mcp,agent-harness,plugin-kit,runtime-core,local-store,model-gateway,persona-brain}`、`apps/desktop-host/src/main` 与 `renderer/director`、`tools/guide-forager`、`docs/v2/{CURRENT,ROADMAP,REQUIREMENTS,DESIGN-SYSTEM,ARCHITECTURE,evidence}`，以及 `/Users/jiaqi/Documents/vibe/reference-clones/` 九仓（固定 SHA 见 B 文档）。**未运行任何参考仓代码。**
> 配套文档：B 复用研究 · C 增量设计 · D 原子工单（`V2-P4-04A…J` 编号以此为准）· E 第一垂直切片。本文所有「对应工单」引用均指向 D 的编号。

---

## 0. 先记三条与现有文档的冲突（以实读为准）

| # | 冲突 | 实读事实（基准 `dba66ec`） | 影响 |
|---|---|---|---|
| C1 | `docs/v2/evidence/P3-04J-dsh-ecosystem-review.md` 与 item 18 审计报告称「主干 `a8bcc06` 的 `CAPTCHA_RE` 不含『验证码中间页』、且没有 feed 选择」 | 当前主干 `packages/character-core/src/social-douyin.ts:210-212` 的 `CAPTCHA_RE` **已包含「验证码中间页」**；`:23-25` 已有 `DOUYIN_FEED_KINDS = ['public','recommended','following']`，`:150-153` 有 `requestedFeed/usedFeed/fallbackReason`，`:192` 有 `isDouyinRequestedFeedVerified()` | PR #5 / #9 已合入 `dba66ec`，旧报告的「主干缺口」已过时；本文件与后续工单以 `dba66ec` 为准 |
| C2 | `docs/v2/CURRENT.md` 第 7 行写「PR #9 待 owner 决定是否合并」 | `origin/feat/whale-isle-v2` 的 HEAD `dba66ec` 就是 PR #9 的合并提交（`feat(social): 抖音只读改真浏览器…(#9)`） | CURRENT 的合并状态描述滞后；本单**不修改** CURRENT（避免与在途工作冲突），仅在此登记 |
| C3 | `docs/v2/ROADMAP.md` 同时存在两个 `V2-P3-07`：`:173` 是「星露谷建档批次 DONE」，`:180` 是「ADR-005 歌声/舞台批次 PENDING」 | 两个批次确实并行立项且同号 | 本单新增候选工单**不复用** `V2-P3-07`，改用 `V2-P4-04A…J` 子单，避免再制造同号冲突 |
| C4 | `docs/v2/evidence/README.md` 索引只登记到 `P3-stardew-auto-new-save-verification.md` | 目录中已有 `P3-04J/P3-04K/P3-04I`、`REAL-DEVICE-CHECKLIST.md`、`V2-P3-07-svc-svs-selection.md`、`tts-alternative-engine-eval.md` 等未登记文件 | 索引本就不完整；本单只按要求追加**本组**一行，不代补历史条目 |

另：`AGENTS.md` 头注释写「Gate 3 随 T-M0-03 接入、Gate 4 于 T-M6-08」，而 `tools/scripts/verify-gate.mjs:1-14` 与 `ROADMAP.md` 已演进为 **8 道**（2026-11-27 增补 `desktop-host build` 打包护栏）。本单按实际 8 道执行。

---

## 1. 审计方法

1. 以 `dba66ec` 工作树为唯一事实源，逐文件读实现、用 `grep -n` 定位符号与行号；行号以本文件写作时实读为准。
2. 对每条能力给四个判断：**已实现 / 已验证到什么等级 / 是否只有契约或 UI / 重复建设风险**，并给「可由哪仓补足 / 已被鲸屿原生覆盖」。
3. 「已验证」绝不外推：单测与仿真只记 `[SIMULATION]`，Electron E2E 只记 `[E2E-HOST]`，真实平台/真机只记 `[REAL-PLATFORM]`/`[REAL-DEVICE]`。
4. 「外部可补足」只表示**能力面**可借鉴；是否可复用代码另见 B 文档的许可证结论。

---

## 2. 逐项差距表

### 2.1 生命周期调度（LifeRuntime）

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | 活动仲裁（急停 / 手动接管 / 预算拦截 / 资源密集活动判定）、目标与承诺绑定、8 层中断栈与恢复、静态日程槽推荐、Token 与时长预算 | `packages/character-core/src/life-runtime.ts:117-168`（`selectActivity`）、`:171-207`（`interruptFor` / `resumeInterrupted`）、`:21`（`MAX_INTERRUPT_STACK=8`）、`:210-235`（`evaluateSchedule` 只在调用时算当前槽）、`:238-262`（`updateBudget`） |
| 已验证等级 | `[SIMULATION]` + `[E2E-HOST]`：`docs/v2/evidence/P1-character-life-verification.md` 记 `LifeRuntime` 分支覆盖 `92.33%`、`verify:gate` 7/7、Electron 45 E2E；无长时真机浸泡 | 同上证据文档 |
| 只有契约/UI | 否；但「下一次计划活动 / 为什么选它 / 为什么停」没有独立可观察结构，只有事件 `life:activity-changed` 的 `reason` 字符串 | `life-runtime.ts:156-165` |
| 真实缺口 | 无事件收件箱、无「单角色同一时间只跑一个自主回合」的锁与防重入、无 `pendingWake`、无「running 撞点作废不补跑」、无错过日程恢复、无事件游标持久化、无虚拟/真实时钟分离 | `life-runtime.ts` 全文无 `pendingWake/queue/inbox/lock/cursor` 符号；`evaluateSchedule` 是纯函数式时槽查询 |
| 重复建设风险 | **高**：若照搬 `dsh-living` 的 `runtime.mjs/clock.mjs` 会形成第二个活动仲裁权威 | 现有唯一权威是 `LifeRuntime` + `ActivityStateDomain`（`shared-protocol/src/character.ts:375-397`） |
| 可由哪仓补足 | `dsh-living`：`packages/core/lib/runtime.mjs:274-311`（`pendingWake`/`scheduleWake`/`tick`）、`clock.mjs:9-36,138-165`（正态网格五档 σ） | 见 B §2.1 |
| 已被原生覆盖 | 预算拦截、急停、手动接管、目标/承诺绑定已覆盖，且比参考仓更贴合 12 域模型 | `life-runtime.ts:117-134`、`character.ts:339-397` |
| 建议 | **增强** `LifeRuntime`，不新建 `LivingRuntime`；先加「事件收件箱 + 单回合锁 + 可注入时钟」三件 | 对应 `V2-P4-04H` |

### 2.2 记忆召回、巩固与防污染

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | 五类记忆、半衰期衰减（默认 30 天、情绪延长）、2-gram 词法召回、2 跳图扩展、加权重排（相似/重要/新近/钉住/情绪权重/情绪同向）、`clear|fuzzy|uncertain` 三档、模糊印象巩固、级联真删除、墓碑压实 | `packages/memory-graph/src/store.ts:57-58,133-166`（衰减）、`:282-285`（`recordRecall`）、`:321-375`（巩固）、`:396-461`（删除）、`:500-...`（压实）；`retrieve.ts:38-44`（不确定性）、`:71-147`（混合检索）、`:130-138`（`reasons` 已带 `sim/imp/recency/emo/mood-congruent/pinned/via-graph`） |
| 已验证等级 | `[SIMULATION]`：`P1-memory-growth-verification.md` 记 37 单测 + `verify:gate` + Electron E2E；无长时真实对话浸泡 | 同上 |
| 只有契约/UI | 否 | — |
| 真实缺口 | ① `reasons` 是粗粒度计分项，不是「R1–R8 通道枚举 + 无通道命中不得浮现」的召回契约；② 无 R8 舌尖/模糊轮廓（`partialHits`）；③ 无元记忆抑制（把「我记得我说过…」当新事实）；④ 无冷区 ≤20 字低保真与「不得作为当前行动依据」标签；⑤ 无受控关系词表；⑥ 无 `lockedFields` 保护用户手改字段 | `retrieve.ts:24,130-138`；`store.ts` 无 `META_HINTS/label20/why_recalled` 符号 |
| 重复建设风险 | 中：若另建「灵魂记忆」库会与 `MemoryGraph` 双权威 | `REQ-MEM-01/02`、`memory-graph/src/store.ts` 已是唯一图谱 |
| 可由哪仓补足 | `dsh-living`：`recall.mjs:2-3,21-28,81-140`（R1–R8 + `why_recalled`）、`memory.mjs:17-39,243`（`META_HINTS`、冷区「不得作为行动依据」）、`memory-extract.mjs:143-151` | 见 B §2.1 |
| 已被原生覆盖 | 半衰期、情绪同频、2 跳图扩展、模糊三档、级联删除已覆盖 | `store.ts` / `retrieve.ts` |
| 建议 | **增强** `memory-graph`：先扩召回原因枚举与冷区标签，再谈 R8；不引入外部存储 | 对应 `V2-P4-04H` |

### 2.3 人格成长与「防毒」闸门

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | `evolveTrait(trait, delta, reason, sourceEventId)` 单次调用即改写，范围钳制 `[0,1]`，记 `evolutionHistory` 与来源事件；偏好 `recordExperience` 有 source/reason/confidence | `packages/character-core/src/profile-stores.ts:108-142`、`:241-266` |
| 已验证等级 | `[SIMULATION]`：`P1-character-life-verification.md` / `V2-P1-04` 单测覆盖；无「多天多源」行为验证 | — |
| 只有契约/UI | 否 | — |
| 真实缺口 | 无 `candidate → 跨天多源确认 → active → 45 天衰减 / 反证退场`；无 `BAD_PATTERNS` 人格崩塌拦截；无每日情绪翻转上限；无「自产日程不得当既成事实」「工具能力短板不得写死」两条铁律；无脆弱共情护栏 | `profile-stores.ts:108-142` 无候选/阈值/过期逻辑；`persona-brain/src/persona-engine.ts` 有雷区反射但无 emotion guard |
| 重复建设风险 | 中：人格权威只能有一份（`PersonalityDomain`）；参考仓是独立人格库，不能引入 | `shared-protocol/src/character.ts:47-63` |
| 可由哪仓补足 | `dsh-fish-soul`（**根目录无 LICENSE，只能重写思想**）：`growth.js:7-19,41,88-101`、`mood-guard.js:11-26,69`、`soul-memory.js:593-626,712-733`；`dsh-living/notes.mjs:5-8,97-128` | 见 B §2.2 |
| 已被原生覆盖 | 变化历史与来源记录已覆盖；`CharacterCore` 12 域是更好的人格权威 | `profile-stores.ts:120-139` |
| 建议 | **重写思想**：把 `evolveTrait` 改成「候选池 + 证据阈值」两步，旧 API 保留为内部提交；绝不复制 fish-soul 源码 | 对应 `V2-P4-04H` |

### 2.4 社交浏览 L1、观察版本与兴趣证据

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | L1 只读契约（`interactionMode: z.literal('readonly')`）、运行时二次拦截、平台能力矩阵「授权 + 已实测」双门禁、三种抖音 feed（公开/推荐/关注）、验证码/登录墙立即停、7 天证据 TTL、三段式执行器（候选→逐条读取→理解）、预算与中途打断、理解配额 | `packages/shared-protocol/src/social.ts:128-129`；`packages/character-core/src/social-runtime.ts:38-40,82,118`；`social-douyin.ts:23-25,150-153,192,210-212,217-235,466-...`；`social-executor.ts:27-40,102-209,212-225` |
| 已验证等级 | **`[REAL-PLATFORM]`**：`P3-04K-douyin-real-browser-verification.md` 记 Chrome 158 + 专用 Profile + 回环 CDP，未登录公开精选 60 卡、推荐探测 9 卡、关注 0 卡，生产冒烟两轮 `itemsRead=3/ok=true`；关注流因账号无可读作品**未置真**；明确「本轮没撞到验证码 ≠ 已解决风控」 | 同上 |
| 只有契约/UI | 「观察版本」没有契约：`SocialBrowseItemReader.read()` 只返回 `{textContent, usedMultimodal?}`，不返回 `observationId/stateVersion/targetIdentity/expiresAt/leaseId` | `social-executor.ts:33-35` |
| 真实缺口 | ① 模型思考 30 秒后不重读页面再执行（无 `execute(expected*)` 语义）；② 无「目标视频/页面已变 → 废弃旧决策」；③ 无送模型前的四道零成本前筛（广告/时长/关键词/已读）；④ 无兴趣的**行为证据层**（实际停留/完播 vs 模型自评）；⑤ 无「同一作品只计一次」去重键；⑥ 无风控码分级冷却与只读放行的停损闸（当前 L1 只需要「停」，但 L2 前必须有） | `social-executor.ts:132-186`（循环只查 lease/预算/打断，不查页面身份）；`interest-sink.ts:39-41,64-113`（只有 `interestRelevance × sentiment`，无 dwell/completion） |
| 重复建设风险 | **高**：参考仓大多是「完整抖音自主 Agent + 写操作」，照搬会越 L1 红线并形成第二套浏览内核 | `social-runtime.ts` / `social-douyin.ts` 已是唯一 L1 通道 |
| 可由哪仓补足 | `LockyBee/dsh-douyin-agent`：`autonomous-watch.mjs:197-203,454`（`expectedVideoId/expectedImageKey/expectedLiveRoomId` + `observed-video-changed`）；`persona-memory.mjs` 行为阈值；`dsh-douyin-studio`：`feed.mjs:90-105`（四道前筛）、`risk.mjs:15-18,50`、`killswitch.mjs:2-29`；`dsh-douyin-bridge`：`browser.mjs:19-31,490-521`（三件套 + `location.href` 校验）、`comment.mjs:6-31,73-75`（`?modal_id=`） | 见 B §2.5–2.9 |
| 已被原生覆盖 | L1 契约、只读执行器、能力矩阵、验证码即停、7 天 TTL、真实平台读数均已覆盖 | 同上 |
| 建议 | **增强** `social-executor`/`browser-runner`：加观察版本与执行前重核；兴趣加行为证据；保持 L1 只读 | 对应 `V2-P4-04G` |

### 2.5 内容理解与证据定位

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | 窄端口 `UnderstandingGatewayPort`、多模态消息（文本 + base64 图）、模型输出 JSON 放宽解析 + Zod 终审、`modelId` 取回执真实路由、`usedMultimodal` 布尔、页面正文 4000 字上限、模型不可用抛错不静默退化 | `packages/character-core/src/content-understanding.ts:23,31-37,58-63,99-140` |
| 已验证等级 | `[SIMULATION]`：`P3-04-social-life-verification.md` 记 8 例单测；**真实模型多模态理解未联调**（同证据文档「待真实验证」） | 同上 |
| 只有契约/UI | 否；但「看到了什么」只有 `usedMultimodal: boolean`，没有逐条来源定位 | `content-understanding.ts:136` |
| 真实缺口 | 无 `materialId/evidenceRef/locator`；无视频帧/字幕/ASR 是否真实存在的校验；无覆盖范围与 `gaps`；无「模型说看过 ≠ 真看过」的可核查结构 | `content-understanding.ts:57-63`（输出只有 summary/topics/sentiment/interestRelevance） |
| 重复建设风险 | 中：Envoy 是完整 Python 基础设施，整仓复制会形成第二套材料/证据内核 | `shared-protocol/src/knowledge.ts` 已是知识契约源 |
| 可由哪仓补足 | `Envoy`（Apache-2.0）：`packages/envoy-core/src/envoy_core/schemas/read_v1.py:57,335,383,424,502`（locator / partial）、`packages/envoy-cli/src/envoy_cli/local_video.py:31-168`（帧/ASR 真存在）、`dsh_douyin_tools/video-understanding-lab/evidence.py:7-35`（引用校验） | 见 B §2.3 / §2.7 |
| 已被原生覆盖 | 多模态消息契约、网关路由、注入防护、诚实失败已覆盖 | `content-understanding.ts:3-9` |
| 建议 | **扩展契约 + 新 Adapter**：知识/证据走 Envoy MCP，理解结果只增加可回溯引用；不复制 Python | 对应 `V2-P4-04A/04B/04D` |

### 2.6 攻略知识库与「知识单元」状态机

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | `GameKnowledgeItem`（sourceType/sourceUri/sourceTitle/gameVersion/modContext/confidence/applicability/knownLimitations/contradictoryEvidence/status）、Markdown 攻略按 `##/###` 切节、头部/YAML 溯源解析、版本与 Mod 兼容评估（compatible/uncertain/outdated/mod-mismatch）、每轮 ≤800 字索引 + `read_guide` 按需读全文、实玩心得 `StrategyNotebook`（adopt/defer/reject + confidence + 按存档 JSON 持久化） | `packages/shared-protocol/src/knowledge.ts:61-79`；`packages/game-bridge-mcp/src/guide-library.ts:143-191,227-299,398-452,463-497`；`packages/game-bridge-mcp/src/strategy-notebook.ts:191-277`；`apps/desktop-host/src/main/autodrive-host.ts:116-120,626-636` |
| 已验证等级 | `[SIMULATION]`：`P2-guide-learning-verification.md` 记 64 专项单测 + `verify:gate` + Electron E2E；**真实多日实机校验未完成**；`P3-07` 的 `[REAL-DEVICE]` 只验证建档/启动，不验证攻略知识 | 同上 |
| 只有契约/UI | 部分：`GameKnowledgeItem` 有 schema 与兼容评估，但没有「知识单元」持久化状态机与 UI 知识页；`StrategyNotebook` 是按存档 JSON，不是知识库 | `strategy-notebook.ts:235-277` |
| 真实缺口 | 无 `materialId/evidenceRef/locator/sourceRevision/sourceContentHash/knowledgeRevision/lastVerifiedAt/executionReceiptRefs`；无 `candidate→verified→promoted→archived` 四态；无「原文或定位一变即退回 candidate 并保留旧版本」；无「实践回执绑定」；无 `prerequisites/counterexamples` 的独立结构（只有自由文本 `knownLimitations/contradictoryEvidence`）；无知识依赖图与 Skill 编译 | `knowledge.ts:61-79` 字段清单；`guide-library.ts` 无状态机/无哈希/无回执 |
| 重复建设风险 | **最高**：Envoy 的 `knowledge_units.py` 是完整知识引擎；若整仓搬入会形成第二套知识/证据库 | `REQ-GAME-03` + `knowledge.ts` 应为唯一契约 |
| 可由哪仓补足 | `Envoy`：`knowledge_units.py:1-7,40-43,261-278,379-394`（四态与证据强绑定）、`evidence_pack.py:1-9,84-113,757 行`（确定性证据包）、`skill_compiler.py:22-30,58-107,265 行`（依赖图 → `SKILL.md`） | 见 B §2.3 |
| 已被原生覆盖 | 版本/Mod 降权、来源字段、实玩心得 verdict 已覆盖 | `guide-library.ts:143-191`、`strategy-notebook.ts` |
| 建议 | **扩展契约 + 外部 MCP Adapter**：知识状态机与证据包由 Envoy 提供或按思想重写；鲸屿只存「知识单元 + 证据引用 + 实践回执」 | 对应 `V2-P4-04A/04B/04D` |

### 2.7 Agent Harness、MCP 与任务编排

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | `WhaleMcpClient`（STDIO + Streamable HTTP，tools/resources/prompts）、`WhaleMcpServer`（受控能力 + 鉴权 + 审计）、`HarnessManager`、ACP 客户端（`session/new` / `prompt` / 权限响应 / `session/cancel`）、7 家 Harness 预设、`executeHarnessTask` | `packages/agent-harness/src/mcp-bridge.ts:52-186,207-283`；`harness.ts:16,312-...`；`acp-client.ts:55-132`；`providers.ts:20-66` |
| 已验证等级 | `IMPLEMENTED_UNVERIFIED`：`P2-ecosystem-isolation-verification.md` 记 Worker 隔离、双向 MCP、7 家执行器与 E2E；**外部新 CLI 真机联调待验** | 同上 |
| 只有契约/UI | 无任务树 UI；`harness-panel.tsx` 只有会话/任务基础视图 | `apps/desktop-host/src/renderer/director/harness-panel.tsx` |
| 真实缺口 | 无任务编排层（主任务→子任务依赖→Worker 复用→交接→取消传播→产物→主角色汇总）；无 Worker 级权限范围与预算/并发；无「子 Agent 会话失效重建但不重放外部副作用」；无未审查 Skills 的候选区 | `harness.ts` 无 `dispatchTask/runHandoff/askApproval/taskTree` 符号；`acp-client.ts:131` 只有单会话 cancel |
| 重复建设风险 | **高**：已有 ACP HarnessManager，不能再实现第二套 Harness | `REQ-EXT-01`、`harness.ts:16` |
| 可由哪仓补足 | `milancat-bot`：`lib/engine.js:329,489,1131,1220,1455,1612,2042`（审批/取消/子回合/Agent 复用/交接/派单）、`insideDir:189`、`egressSend:216` | 见 B §2.4 |
| 已被原生覆盖 | MCP 双向、ACP 会话、权限响应、审批令牌已覆盖 | `mcp-bridge.ts` / `acp-client.ts` |
| 建议 | **增强**：在 `HarnessManager` 之上加任务编排层；Worker 只做能力执行者，不建第二人格 | 对应 `V2-P4-04F` |

### 2.8 权限、安全、预算与可靠副作用

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | `ComputerUseLease`（设备级单主控 + TTL + 用户输入抢占）、`BrowserRuntime` P0–P5 策略门禁（P4 审批/P5 一次性确认）、`AccountVault` / `BrowserProfileMgr`、`PolicyBroker`、Worker Isolate 沙箱、游戏三态回执 `COMPLETED|FAILED|UNCERTAIN`、`token_ledger` / `song_cache_index` / `grudge_ledger` | `packages/runtime-core/src/automation-security.ts:393,632,708-740,64-66`；`browser-runner.ts:7,164,196`；`packages/game-bridge-mcp/src/adapter.ts:19`、`action-lock.ts:6`；`packages/local-store/src/sqlite.ts:79-115` |
| 已验证等级 | `DONE`/`[REAL-DEVICE]`：`P3-browser-computer-use-verification.md`（CGEvent 真机注入）、`P3-stardew-auto-new-save-verification.md`（R1–R5 真机）、`P2-ecosystem-isolation`；真实 Windows SendInput 与 TCC 打包态待验 | 同上 |
| 只有契约/UI | 否 | — |
| 真实缺口 | ① 无统一外部副作用 Outbox（`queued/sending/delivered/unknown/failed`、稳定目标身份、顺序、时效、重启把 `sending` 降 `unknown`、未知永不自动重放）；② 无全局预算账本（LLM/TTS/多模态/浏览器/Worker 并发/授权外发统一计量、账本坏了 fail-closed）；③ 无持久化任务队列/死信/重试上限；④ 无物理级 `KILL` 总闸（读放行写阻断）；⑤ 无风控码分级冷却；⑥ 无「临时能力代理」（一次性 token/白名单/体积/超时） | 全仓 grep 无 `outbox/Outbox`；`local-store/src/sqlite.ts` 只有三张账本表，无 outbox/knowledge/task 表；`automation-security.ts` 有 P5 但无 KILL 文件 |
| 重复建设风险 | 中高：若每个域自建计数器/重试会绕开全局控制 | `REQ-SEC-01/02`、`AGENTS.md` 第五层 |
| 可由哪仓补足 | `dsh-fish-soul/lib/outbox.js:51-56,84-85,193-243`（三态 + 重启降级 + 顺序）；`dsh-douyin-studio/budget.mjs:18-21,132-158`（fail-closed）、`queue.mjs:7-8,22,70-101`（5 次转 dead）、`killswitch.mjs:2-29`、`risk.mjs:15-18,50`；`dsh_douyin_tools/action-proxy.mjs:5-28` | 见 B §2.2 / §2.6 / §2.7 |
| 已被原生覆盖 | 租约、P0–P5、账号隔离、游戏三态回执已是更好底座 | `automation-security.ts` / `adapter.ts` |
| 建议 | **新增** `runtime-core` 统一 Outbox + 预算账本 + 任务队列；游戏回执作为第一条真实链路验证 | 对应 `V2-P4-04F` |

### 2.9 模型能力探测与多模态适配

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | `supportsVision=false` 的请求前预检（`MODEL_NO_VISION`）、供应商预设能力位、回执 `modelId` 真实路由 | `packages/model-gateway/src/gateway.ts:290`；`presets.ts:30`；`content-understanding.ts:25-29,137` |
| 已验证等级 | `[SIMULATION]`：`gateway.spec.ts:820-828` 有视觉预检单测；真实供应商多模态联调未完成 | 同上 |
| 只有契约/UI | 否 | — |
| 真实缺口 | 无「模型不能接收真实视频画面 → 明确停止观看任务」的运行时闸；无输出结构/附件保存完整性/超时取消的统一能力探针；无「探针结果带 `checkedAt` 与来源」的契约 | `node_modules` 外无 `inputModalities` / `attachments.saveImages` 等符号；`AAAjzx111/native-watch-decision.mjs:8-34` 是外部实现 |
| 重复建设风险 | 低（增强现有网关即可） | `REQ-MOD-01` |
| 可由哪仓补足 | `AAAjzx111/dsh-douyin-agent/native-watch-decision.mjs:3,17-34`（模态/附件/输出完整性校验）；`dsh_douyin_tools/action-proxy.mjs`（能力代理） | 见 B §2.6 / §2.7 |
| 已被原生覆盖 | 视觉预检、供应商能力位、真实 `modelId` 回执已覆盖 | `gateway.ts:290` |
| 建议 | **增强** `model-gateway`：能力探针契约 + 失败即停；不替换 MiMo 语音引擎 | 对应 `V2-P4-04J` |

### 2.10 外部会话桥接

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | 无（当前只有社交 L1 浏览，不接外部私信/群聊） | `packages/shared-protocol/src/social.ts` 无 channel/session 映射契约 |
| 已验证等级 | `UNVERIFIED`（未实现） | — |
| 只有契约/UI | 否 | — |
| 真实缺口 | 无 Channel Adapter、无稳定联系人身份（`conv:<sha256>`）、无历史基线（首次接入不把历史当新消息）、无自发消息不回灌、无会话序号去重、无 Outbox 投递、无授权撤销 | — |
| 重复建设风险 | 高：若每个渠道一套聊天大脑，会分裂角色身份与记忆 | `REQ-SOC-01` L1–L3 |
| 可由哪仓补足 | `dsh-douyin-bridge/lib/bridge.mjs`（会话映射/历史基线/序号去重，但 `relayPending` 有游标缺陷 `:797-827`）；`LockyBee/contact-authorization.mjs:2-53`（稳定身份） | 见 B §2.8 / §2.5 |
| 已被原生覆盖 | 无；但已有 `MemoryGraph`/`CharacterCore` 可承载统一对话 | — |
| 建议 | **最后做**：先有 Outbox + 稳定身份 + 平台授权，再接真实渠道 | 对应 `V2-P4-04I` |

### 2.11 UI / 可观察性

| 维度 | 结论 | 真实源码 / 证据 |
|---|---|---|
| 已实现 | Tidepaper v3.1 六组 IA（此刻/角色/化身/生活/能力/治理）、生命中枢、记忆、游戏共玩、Harness、模型与饭碗、插件/MCP/技能等页；四态回执芯片、许可徽章、控制权 HUD | `apps/desktop-host/src/renderer/director/shell/sidebar.tsx:27-67`；`docs/v2/DESIGN-SYSTEM.md:45-57`；`P3-tidepaper-v3.1-shell-verification.md` |
| 已验证等级 | `DONE`（视觉与外壳层）+ `[E2E-HOST]`：`verify:gate` + WCAG + Electron E2E | 同上 |
| 只有契约/UI | 「知识与学习」「Agent 任务中心」「生命中枢理由列」「数字生活看到了什么」尚未成页 | `sidebar.tsx:58-63` 能力组只有 providers/plugins/harness |
| 真实缺口 | 无知识页（材料→证据查看器→知识单元卡→实践回执→版本历史）；无任务树/审批/产物/汇总；生命中枢缺「活动流 + 理由列」；记忆缺 `why_recalled` 命中通道与纠正/回溯；数字生活缺逐条证据（帧/字幕/音频分别标注） | `life-console-view.tsx`、`memory-panel.tsx`、`harness-panel.tsx` 现有结构 |
| 重复建设风险 | 低（增强既有页面即可） | `ADR-003` + `DESIGN-SYSTEM.md:25-31` |
| 可由哪仓补足 | 主要是设计思想：Envoy 的来源定位、LockyBee 的「看到了什么」证据面、studio 的「没抽帧就是 `frames:false`」诚实口径 | 见 B |
| 已被原生覆盖 | Tidepaper 令牌、四态芯片、许可徽章、HUD 已是更好底座 | `DESIGN-SYSTEM.md` |
| 建议 | **不新增一级导航**；知识页挂到「能力」组，任务中心增强 Harness 面板，其余增强既有页 | 对应各工单的 UI 子项 |

### 2.12 item 20 的 CDP 四项补强（与融合相邻的低风险缺口）

| 项 | 当前 `dba66ec` 事实 | 参考依据 |
|---|---|---|
| 防后台节流三件套 | `apps/desktop-host/src/main/cdp-browser-engine.ts:781-786` 只有 `--remote-debugging-port` / `--remote-debugging-address` / `about:blank`，**无** `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding` / `--disable-background-timer-throttling` | `dsh-douyin-bridge/lib/browser.mjs:29-31` |
| 导航后 `location.href` 校验 | `:489` 有读 `location.href` 的方法，但未见 `Page.navigate` 后强制校验离开 `about:blank` 的代码 | `dsh-douyin-bridge/lib/browser.mjs:490-521` |
| `?modal_id=` 直达 | `douyin-page-reader.ts:27-31` 已覆盖 `data-e2e-aweme-id`，未见单条视频 `?modal_id=` 路径 | `dsh-douyin-bridge/lib/comment.mjs:6-31,73-75` |
| 真验证码可见尺寸过滤 | `douyin-page-reader.ts` 主要走 `detectDouyinBlock` 文本判定，未见 `width/height > 120` 过滤常驻隐藏 iframe | `dsh_douyin_tools/vendor/douyin-mcp/mcp_server.py:818-826` |

> 这四项**不属于**本单的四交付物范围，也不改任何代码；仅作为「观察版本」工单（`V2-P4-04G`）的第一批可落地实例登记在此，避免遗漏。

---

## 3. 结论汇总

1. **鲸屿的原生底座比参考仓更适合承载「单一角色」**：`CharacterCore` 12 域、`LifeRuntime` 活动仲裁、`MemoryGraph` 五类记忆、`SocialRuntime` L1、游戏三态回执、P0–P5 权限——这些**不应被参考仓替代**。
2. **真正缺的不是功能，是四层「可核查性」**：① 生命节奏的单回合调度与恢复；② 知识/证据的来源定位与版本状态机；③ 外部副作用的三态投递；④ 观察版本与执行前重核。
3. **最容易造成拼装化的是知识库与任务编排**：两者都必须「扩展既有契约 + Adapter/Worker」，不能新建平行内核。
4. **第一垂直切片选「Envoy + 星露谷攻略」是合理的**：它同时检验证据契约、知识状态机、真实实践回执与 Tidepaper 知识页，且不触碰 L1 写操作红线。
