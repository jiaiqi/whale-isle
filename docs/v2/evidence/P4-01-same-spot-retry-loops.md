# P4-01：秋8-秋9 三处「同一处反复试探」的真实死循环

真机 2026-11-28 秋8→秋9 连续暴露三个同源缺陷：**模型会在同一个不可改变的前置条件上反复试探**。三处都修了，修法统一——**只陈述事实，不指定动作**。

## 缺陷一：`explore_mine({"levels": 0})` 等于什么都不做

秋8 真实序列（体力 12/270、背包剩 1 格）：

```
DEC explore_mine {"levels": 5, "start_level": 15}
REC COMPLETED  下 0 层，敲 33 块，体力 12，停下原因：体力不够了
DEC explore_mine {"levels": 0}     ← 无效参数
REC FAILED     下 0 层，敲 0 块
DEC explore_mine {"levels": 0}     ← 又一次
REC FAILED     下 0 层，敲 0 块
```

### 修复（`0fcd593`）

- `normalizeToolArgs` 对 `explore_mine` 的 `levels` 加下限 1、上限 30；`start_level` 收敛到 1..120
- 生存提醒补组合事实：`体力 ≤10% 且背包 ≤2 格` 时点名「这种组合下矿/长采集几乎必然在原地停住」

## 缺陷二：同一界面被重复打开

秋9 书摊：

```
interact(109,26) → 对话框「我是马尔赛罗，欢迎来到我的书摊！」→ dialogue → 商店界面
close_menu
interact(109,26) → 又打开同一个书摊对话框 → dialogue
```

秋8 矿洞电梯菜单（体力只剩 12 时）：

```
interact(7,8) → 菜单：MineElevatorMenu → close_menu
interact(7,8) → 菜单：MineElevatorMenu → close_menu
```

### 修复（`b131bc0`）

原「反复开合界面」检测要求同窗口 ≥3 条，两次开合抓不到。新增按「工具 + 界面名」聚合的检测（≥2 次即提示），界面名从回执的「菜单：X」「对话框：X」提取。

## 缺陷三：玛妮卧室门口的死循环（最严重）

秋9 真实序列，**连续 11 次失败**（`interact` 7 次 + `move_to` 4 次）：

```
interact (13,7)  → FAILED  移动被打断：有界面打开了（DialogueBox）
                           对话框：只有玛妮的好朋友才能进入她的卧室。
dialogue {}      → COMPLETED 对话已推进。当前界面：无（可以自由行动）
move_to (13,8)   → FAILED  移动被打断：有界面打开了（DialogueBox）
dialogue {}      → COMPLETED 当前界面：无
interact (13,7)  → FAILED  移动被打断：有界面打开了（DialogueBox）
...重复
```

关键点：`dialogue` 每次都**成功**关闭了对话（回执写「当前界面：无」），但**一靠近就重弹同一句拒绝对话**。这是好感/剧情硬前置，当场无法绕过。

那一刻的 loopStats：`repeatedToolFail=21`、`uiOpenClose=16`。

### 修复（`8325392`）

- 检测「移动被打断 + 对话框 + 只有/才能/得先」组合，点名这是好感/剧情/时间门槛，说明「当场再试不会变」
- 另补一条：刚关过对话又报「有界面打开」时，先 `get_state` 确认真实界面，别在怀疑中反复重试同一坐标
- 普通对话打断（非拒绝对话）只给核对界面，不误报门槛结论

## 验证

| 项 | 结果 |
| --- | --- |
| `llm-planner.spec.ts` | 42/42（新增 levels 收敛、界面重复、书摊与电梯两种真机形态） |
| `state-hints.spec.ts` | 21/21（新增好感门点名、普通对话不误报） |
| `seed-table.spec.ts` | 14/14（T3 作物经济） |
| `pnpm verify:gate` | 8 过 / 0 跳过 / 0 待接线（每笔单独跑过） |

## 尚未验证

- 三处修复在**真实运行**中的效果需要重载构建后观察（出问题时跑的是 `0fcd593` 之前的构建）
- `uiOpenClose` 计数器语义有误导性：它统计「成功打开界面次数 + close_menu 次数」累计总数，不是循环次数。`4` 只是 2 次正常开合，`16` 才是异常。已记录，未改名（避免动验收脚本口径）。
