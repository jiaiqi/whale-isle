# `V2-P3-04G` 自主社交发起策略（scheduler tick）验收证据

> 日期：2026-11-26 · 分支 `feat/whale-isle-v2` · 证据等级：`[SIMULATION]` + 确定性单测（**无真机自主浏览**）
> owner 口径来源：2026-11-26 拍板的四条参数（默认关闭 / 每日 ≤2 次且 ≤30 分钟 / 00–08 禁发 / 连续 2 次失败当日停发）

---

## 1. 这次到底交付了什么，没交付什么

**交付**：一层确定性策略 + 宿主 tick + 生活页四块 + 单测。它回答「现在能不能开始」，并保证不该发起时一定不发起、该停时一定停。

**没交付（如实写）**：**L1 浏览执行器**（候选来源 + 逐条读取 + 内容理解调用）没有接入。因此宿主把 `executorReady` 固定为 `false`，`evaluate()` 会以 `executor_not_ready` 拦截——**开关打开也不会发起**。理由：没有执行器时发起只会得到一个 10 分钟、`itemsViewed=0` 的空会话，白吃当日 2 次额度，还会被记成失败，是"看起来在工作"的假功能。

这也意味着：`noteStarted()/noteEnded()` 的生产路径目前跑不到，只在单测里被验证。这一点不粉饰。

---

## 2. 参数 → 生效位置对照（owner 逐条核对用）

| owner 口径 | 默认值 | 契约（默认值定义） | 判定/生效位置 |
| --- | --- | --- | --- |
| 默认关闭 | `enabled=false` | `packages/shared-protocol/src/social.ts:209` | `social-runtime.ts:337`（`autostart_off`） |
| 每日 ≤2 次 | `maxSessionsPerDay=2` | `social.ts:211` | `social-runtime.ts:345`（`daily_sessions_exhausted`） |
| 累计 ≤30 分钟 | `dailyBudgetMs=30min` | `social.ts:212` | `social-runtime.ts:348`（`daily_budget_exhausted`）+ 发起时把单次 `maxDurationMs` 钳到当日剩余 |
| 间隔 90–150 分钟 | `minIntervalMs=90min` / `maxIntervalMs=150min` | `social.ts:213-214` | `social-runtime.ts:351`（`interval_wait`）+ `nextIntervalMs()` |
| ±20% 抖动 | `jitterRatio=0.2` | `social.ts:216` | `nextIntervalMs()`（两次随机：区间取值 + 抖动） |
| 冷却 ≥60 分钟 | `cooldownMs=60min` | `social.ts:217` | `social-runtime.ts:351`（`cooldown`，失败/中止走这一档） |
| 夜间 00:00–08:00 禁发 | `quietHoursStart=0` / `quietHoursEnd=8` | `social.ts:219-220` | `social-runtime.ts:339`（`quiet_hours`）+ `shouldAbortActive()` 让跨 00:00 的在跑会话按 `quiet_hours` 收官 |
| 连续 2 次失败当日停发 | `maxConsecutiveFailures=2` | `social.ts:221` | `social-runtime.ts:342`（`consecutive_failures`），跨日重置 |
| 单次 20 条 | `sessionMaxItems=20` | `social.ts:223` | 透传 `decision.maxItems` → `planSession({maxItems})` |
| 单次 10 分钟 | `sessionMaxDurationMs=10min` | `social.ts:224` | 透传 `decision.maxDurationMs`（会被当日剩余预算钳制） |
| 内容理解 ≤8 次 | `maxUnderstandingCalls=8` | `social.ts:226` | 透传 `decision.maxUnderstandingCalls`（执行器接入后由其计数） |
| P0 急停立即 abort + 停 tick | — | — | `v2-kernel-host.ts` 急停 handler：遍历在跑会话 `abort(..., 'user_stopped')`；tick 因 `halted` 直接不触发 |
| 暂停自主生活不触发 | — | — | `social-runtime.ts:338`（`life_halted`，读 `LifeRuntime.activityState().halted`） |
| 用户玩游戏/直播/用电脑让路 | — | — | `v2-kernel-host.ts` `socialAutostartFacts().userBusy`：`autodrive.runner.isRunning()` / `liveRuntime.snapshot().active` / `computerLeaseMgr.listActive().length > 0` |
| 模型不可用安全暂停并提示 | — | — | `social-runtime.ts:362`（`model_unavailable`，读 `autodrive.getBrainMode().llmReady`） |
| 平台能力未实测不发起 | — | — | `social-runtime.ts:360`（`platform_unverified`） |
| 桌宠气泡只报开始/收官 | — | — | `apps/desktop-host/src/main/index.ts`：移除 `social.session.viewed` 逐条投影，改订阅 `social.session.started` 说一句 |

---

## 3. 单测（确定性，不 sleep、不依赖真实时钟）

`packages/character-core/src/social-runtime.spec.ts` 共 **29 例**（原 6 例 + 新增 23 例），新增覆盖：

- 默认关闭；默认参数与 owner 口径逐项相等（一条断言把 12 个默认值全钉住，防止以后被人悄悄改宽）
- 夜间边界：`00:00` 拦、`07:59` 拦、`08:00` 放行；跨午夜禁发（22:00–06:00）两侧都拦；起止相同 = 不禁发
- 会话跨 00:00 → `shouldAbortActive()` 为真
- 暂停/急停、已有会话、平台未实测、执行器未接入、模型不可用、用户忙 —— 六种拦截原因各不相同且都带人话 detail
- 失败后冷却 60 分钟：冷却内拦、61 分钟后放行
- 连续 2 次失败当日停发；跨日自动重置
- 中止（用户急停）走冷却但**不计入**连续失败
- 成功后排下次：注入固定随机序列，`r=(0.5,0.5)` → 收官 +120 分钟；`r=(0,0)` → 收官 +72 分钟（抖动下限仍 ≥ 冷却）
- 每日 ≤2 次；累计 ≤30 分钟（用 25 分钟后单次预算被钳到 5 分钟，用满后拦）
- 跨日重置次数与用量，但昨夜的冷却不被绕过（23:30 收官 + 60 分钟 → 次日 00:10 仍拦）
- `snapshot()` 四块数据（下次可发起 / 今日用量 / 最近 5 次 / 执行器状态）与记录上限
- 非法设置直接抛错；`min>max` 归一化交换

> 说明：测试与实现同文件族的合并（`social-runtime.ts` + `social-runtime.spec.ts`）是为了守住「单工单 ≤8 个业务源码文件」的红线，不是把两个关注点混在一起——策略段有独立段落注释与独立 describe 块。

---

## 4. 门禁

`pnpm verify:gate` → **7 过 / 0 跳过 / 0 待接线**（Gate 1 类型与边界、Python、Gate 2 许可证/依赖/Lua、Gate 3 确定性单测、Gate 4 回环 E2E 全绿；license-scanner 扫描 320 个源文件 0 违规）。

---

## 5. 仍然缺的（不得记为已验收）

1. **执行器未接入** → 自动发起永不发生（`executor_not_ready` 恒定）。
2. **无 `[E2E-HOST]`/`[REAL-DEVICE]` 验证**：生活页四块只在类型与构建层面通过，没有跑一次真实 Electron 截图断言。
3. **tick 的 60 秒节拍**没有在长时运行中浸泡过（急停、跨夜、休眠唤醒后的行为未实测）。
4. 桌宠气泡改动会使 `social-life.e2e.spec.ts` 里「在读：」这条断言只剩「收官」分支可命中——需要在该 e2e 里补一条"不再逐条刷屏"的负向断言（本次未改该文件，避免与 item 7 的气泡文件并发冲突）。

下一步（另立工单）：L1 浏览执行器（候选来源 + 逐条读取 + 理解配额）→ 打开 `executorReady` → 补 E2E。
