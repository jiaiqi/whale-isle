# P4-01：节日无主活动回执语义

## 决策声明

采用在回执分类层把 BWF 原文「刘易斯没有问要不要开始…这个节日没有主活动」判定为**确定结论**（FAILED），不再因原文措辞含「可能」而升级为 UNCERTAIN；参考 BWF 源码 `GameActions.Festival.cs:374` 的 `!asked` 分支语义，自行实现。不改写游戏行为、不替模型决定参加哪个节日，仅在状态分类上消除自相矛盾的「不确定」。

验证：以夏28 月光水母之舞真机原文为样本写回归；覆盖该文案判 FAILED、真正不确定的仍判 UNCERTAIN，并确认既有四态分类未回归。再跑完整门禁。

## 真实反例（夏28 22:10）

`festival start` 连续三次：

1. `UNCERTAIN`：「刘易斯没有问要不要开始（可能还没到时间，或者这个节日没有主活动）」
2. `FAILED`：「主活动还没结束（等太久了）」
3. 再次 `start`（挂起中）

BWF 源码 `GameActions.Festival.cs:365-376` 中该分支是 `if (!asked && …)` 的**确定性结论**：本节日没有刘易斯宣布的主活动。原文「可能还没到时间」只是措辞，却被 `adapter.ts` 的 `/UNCERTAIN|不确定|可能|unknown/` 命中，判成 UNCERTAIN，与紧邻的 FAILED 语义冲突，模型因此反复重试。

## 实现

`classifyStardewReceipt` 在 `isError` 分支新增前置判断：文案命中 `没有问要不要开始` 或 `没有主活动` 时，`uncertain = false`，直接判 FAILED；其余（含真正的「可能卡住」）维持原 UNCERTAIN 规则。

## 验证

- `adapter.spec.ts` **17/17 通过**（无覆盖率门槛运行），含该文案判 FAILED、`UNCERTAIN 状态未知` 与「可能卡在界面里」仍判 UNCERTAIN。
- 完整 `pnpm verify:gate` 待执行。
