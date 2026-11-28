# P4-01：今日安排事实注入晨间计划

## 决策声明

参考 ValleyServer/ValleyWhale 的 `Knowledge.TodaysFestival()` 与 `GameActions.Town.DailyQuestHint()`（源码级复评确认），把「今天是什么日子」作为**结构化事实**喂给晨间计划，并允许模型为每条目标标注时间安排（`timeHint`）。仅陈述游戏已给出的客观信息，不替模型决定玩法、不校验计划内容，符合 AI-first 红线。

不采用：程序按节日/天气自动生成固定日程表（会变成硬编码玩法规则树）；也不把任务当成必须完成的强制清单。

## 真实缺口（源码 + 真机核实）

- `planner.ts` 已解析 `festival`/`birthday`，`state-hints.ts` 有节日提示，但 **`day-plan.ts` 的晨间计划完全没吃这些输入**：计划是「LLM 自由自拟」，没有「今日节日时间窗」「今日可执行任务」。
- 真机状态 `## 任务` 段富含可执行信息（如「乔迪的请求 → give_gift npc=Jodi」「镇长的短裤 → travel_to AnimalShop 后 interact 13,7」），晨间计划同样未使用。
- 参考复评明确指出：这是本仓与 ValleyServer 的主要差距（「按季节节日编排的一天」vs「自由发挥」）。

## 实现

- 新增 `packages/game-bridge-mcp/src/today-schedule.ts`：
  - `parseTodayFestival`：从「今日：…节日 月光水母之舞（Beach，22:00-00:00(次日)）」提取名称/地点/时间窗（时间窗自身含括号，取到最外层右括号）。
  - `parseTodayBirthday`、`parseActionableQuests`（只取带「怎么交」的任务，最多 5 条）、`isSeasonEndDay`（28 日）。
  - `buildTodayScheduleFacts`：汇总为一段事实；无任何事实时返回空串，不塞空标题。
- `llm-prompt.ts` 晨间计划新增 `todayFacts` 段落，并允许 `timeHint`；system 提示要求「像人一样按一天时间推进」，但明确「要不要做、做哪几件、几点做由你自己决定」。
- `day-plan.ts` 的 `DayPlanItem` 新增可选 `timeHint`（仅展示，不驱动行为）。

## 验证

- `today-schedule.spec.ts` **5/5 通过**：节日名称/地点/时间窗、无节日、带交付任务过滤、纯目标类排除、季末判定、无事实返回空。
- 过程中三次失败均如实修正：① 原正则按「（」截断丢失地点与时间窗；② 任务行原文是「。。怎么交」（双句号）；③ 时间窗自身含 `(次日)` 括号，需取最外层右括号。测试期望也按真实格式校正（标题含描述更有用）。
- `pnpm --filter @workbench/game-bridge-mcp build` 通过；完整 `pnpm verify:gate` 待执行。
