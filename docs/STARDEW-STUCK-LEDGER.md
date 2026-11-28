# 星露谷卡死台账（STARDEW-STUCK-LEDGER）

> **用途**：真机卡死签名 ↔ 回归剧本 ↔ 修复工单的一一对应表（T-M6-68）。
> **签名口径**：`工具｜原因模板｜地点`，由 `tools/soak-real/src/stuck-detector.ts` 的 `failureSignature()` 归一化
> （抹掉坐标 / 引号物品 / 星级 / 数字 / `<think>`），与 `soak:real` 报告、现场包 `verdict.json` 完全同口径。
> **规则**：每次 `soak:real` 跑完，按 `report.md` 的失败签名 Top10 更新「频次（累计浸泡）」；**新签名先写剧本（红），修复后变绿，再改状态**。修复顺序按频次从高到低。
> **剧本位置**：`tools/mock-harness/scenarios/stuck/*.json`；由 `stuck-regressions.spec.ts` 逐条驱动**真实** `AutodriveRunner`（生产编排循环 + 真实 `RulePlanner` / `LlmPlanner`），跑在 BWF 同构 HTTP 回放服务上，接入 Gate 3。

## 台账

| 签名 | 首次出现 | 频次（累计浸泡） | 剧本 | 修复工单 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `tidy_backpack\|农场上没有箱子 先 craft Chest 木材\|Farm` | 2026-11-22（VERIFY 满包造箱自救·现场二） | 真机 ≥2（2026-11-22 用户复测仍卡死）；浸泡 **0**（T-M6-71 尚未执行） | `S01-full-bag-reserved-wood22` | T-M6-10 / T-M6-70（LLM 读满包提醒与失败记忆选 `eat force`） | 已修 / 回归中 |
| `fish\|背包里没有鱼竿\|Beach`（死硬模型 3 连败熔断 + 代驾接手） | 2026-11-24（T-M6-10 真机：夏2 07:10 Beach 连败） | 真机 1 轮连续 ≥3 次同签名；浸泡 **0** | `S02-no-rod-fish-loop` | T-M6-10 / T-M6-70（3 次全局熔断 + 中途代驾回执同步） | 已修 / 回归中 |
| `dialogue\|失败 这是选择题 需要 choice\|Farm` | 2026-11-22（T-M6-10 第一轮：剧情多行选择题） | 真机 1 轮无限 FAILED；浸泡 **0** | `S03-story-choice-multiline` | T-M6-10（多行「选项」块解析 + 自动 `choice: 0`） | 已修 / 回归中 |
| `clock-stall\|第1年春24日 06:00\|FarmHouse` | 2026-11-23（VERIFY「T-M6-10 春24 冻结死锁」） | 真机连续多日复现；浸泡 **0** | `S04-bwf-self-pause-freeze` | T-M6-10（90s 无变更 → keepalive `wait {minutes:1}`） | 已修 / 回归中 |
| `tidy_backpack\|农场上没有箱子\|Farm` | 2026-11-22（`transcript-20261122-182601`：tidy↔store↔donate 无箱死循环） | 真机 1 轮 3 次循环；浸泡 **0** | `S05-tidy-store-donate-loop` | T-M6-10（`rescueTried` 只 tidy 一次 → `wait` 求助） | 已修 / 回归中 |
| `fish\|背包里没有鱼竿\|Beach`（LLM 离线 → 规则代驾不知失败） | 2026-11-24（T-M6-10 根因：回执未转发 fallback） | 真机 1 轮 ≥3 次同签名；浸泡 **0** | `S06-fallback-ignores-failure` | T-M6-10 / T-M6-70（`BrainSwitch` 代驾 + 回执转发） | 已修 / 回归中 |
| `fish\|背包里没有鱼竿\|Beach`（正例：LLM 读失败记忆自主换 `forage`） | 2026-11-25（T-M6-70 RUNBOOK §4.9 正例） | 浸泡 **0** | `S07-llm-failure-memory-forage` | T-M6-70（`buildFailureMemorySection` 注入签名与换做法提示） | 已修 / 回归中 |

> 说明：S02 与 S06 共用同一签名（同为 Beach 无鱼竿），但失败路径不同（LLM 直接连败 vs LLM 交出控制后规则兜底继续），因此拆成两个剧本；台账按「签名 + 根因」登记，不合并。
> 浸泡频次全为 0 是**如实记录**：T-M6-67 的 `soak:real` 尚未在真机执行（本机 BWF 18080 未监听），不得用人工复测次数冒充浸泡频次。

## 剧本 ↔ 根因 ↔ 回退验证（红/绿证据）

每个剧本都做过「删掉对应修复的一行 → 剧本变红 → 还原 → 变绿」验证；详细命令与失败断言见 ROADMAP T-M6-68 决策声明。

| 剧本 | 回退位置 | 回退后表现（红） |
| --- | --- | --- |
| S01 | `packages/game-bridge-mcp/src/planner.ts` `pickRenewableReserved()` 强制返回 `null` | 救援阶梯落到 `wait`，从未 `eat`，`mustCallWithArgs` 失败 |
| S02 | `llm-planner.ts` `decideCore()` 冷却工具接受条件失效（`cooledTools.size < 0`） | 同一 `fish` 失败 6 次（上限 2） |
| S03 | `planner.ts` 选择题决策 `args: { choice }` → `args: {}` | `dialogue` 失败 8 次（上限 0） |
| S04 | `autodrive.ts` keepalive 阈值 `>= 90_000` → `>= Infinity` | 时钟永不推进、无 `wait` 调用 |
| S05 | `planner.ts` `if (!this.rescueTried.has('tidy_backpack'))` → `if (true)` | `tidy_backpack` 失败 14 次（上限 1） |
| S06 | `llm-planner.ts` 删除 `this.fallback.observeReceipt?.(...)` | `fish` 失败 2 次（上限 1），规则兜底不知失败 |

## 新增卡死签名的流程

1. 真机 `pnpm soak:real -- --days N` 跑出卡死现场包 `artifacts/soak/<run>/stuck/<id>/`。
2. 转换草稿：`pnpm tsx tools/mock-harness/src/pack-to-scenario.ts artifacts/soak/<run>/stuck/<id> --out /tmp/draft.json`。
   `signature` 直接复用 `failureSignature()`；`rules` 来自 `last50.jsonl` 真实回执；`expect` 是占位值。
3. 人工补全 `expect`（`maxCycles` / `maxSameFailure` / `mustCallOneOf` / `clockMustAdvance` / `mustCallWithArgs`）、`initialState` 与 `source`，按 `S<NN>-<slug>` 改名放进 `scenarios/stuck/`。
4. 在**未修复**的代码上确认剧本变红（否则说明剧本没覆盖该问题，改剧本，不改断言）。
5. 修复后转绿，在本台账追加一行；`stuck-regressions.spec.ts` 会自动纳入 Gate 3。

> 口径提醒：本台账与全部剧本目前均为 `[SIMULATION]`（回放服务 + 真实编排器），**不等于真机验收**。「真机现场包 → 转换 → 红 → 修 → 绿」整条链路尚未执行，已在 `docs/VERIFY.md` 登记待真机。

## 2026-11-28 夏24日巡检：长动作期间状态陈旧（待优化）

`[REAL-DEVICE]` 12:41:54执行explore_mine(levels=5,start_level=5)，12:46巡检最后汇总state仍显示06:00；隔离SMAPI记录逐层进入5–9层，原生游戏截图12:46:32经macOS Vision OCR读到夏24日12:20。不能把长动作未返回汇总状态直接记作卡死，也不能把陈旧state当成实时状态。建议中控台明确标示动作执行中、最近状态时间；本轮尚未修改该UI。

## 2026-11-28 夏24日：过期营业条件继续影响意图

`[REAL-DEVICE]` 12:46:18真实回执为矿洞5→10层成功、游戏时钟12:00；12:46:22下一轮却仍以“威利还没开门”为意图继续下矿5层。此前鱼店失败发生在06:00、回执明确09:00开门，因此该意图与最新时钟矛盾。补充提示的当前时钟最终锚点、历史条件的时效边界和依据资源/电梯/当日时限自主选择批量规模；不新增规则决策树。提示需下次重载后实测，当前不记已解决。
