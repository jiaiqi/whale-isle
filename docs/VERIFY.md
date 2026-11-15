# VERIFY — 验收标准矩阵

> **铁律**：严禁将静态代码阅读、单元测试或仿真沙盒测试（`[SIMULATION]` / `[E2E-HOST]`）冒充为真机实测（`[REAL-DEVICE]`）。
> 每行证据必须附**真实终端输出摘要**（命令 + 关键断言行），禁止"应该能过"式描述。
> 填写流程：AI 完成工单 → 跑 `pnpm verify:gate` → 在「Mock/沙盒验证已通过项」补一行证据 → 真机相关项**永远**留在右栏等人类宿主亲手验收。

## 状态总览（按里程碑）

| 里程碑 | Mock/沙盒验证已通过项（`[SIMULATION]` / 单测 / 编译） | 待人类宿主真机验收项（`[REAL-DEVICE]`） | 最近更新 |
| --- | --- | --- | --- |
| M0 地基与铁笼 | （未开始） | 无需真机：宿主查看 `pnpm verify:gate` 全绿即可放行 | — |
| M1 大肥鱼复活 | （未开始） | 在 Mac 桌面拖拽"大肥鱼"；输入框打一句"大肥鱼"，确认瞬间喷水破防并弹出 `<think>` 内心戏气泡 | — |
| M2 本地语音与点歌 | （未开始） | 听 Mac M 系列芯片本地生成的傲娇语音延迟；点一首歌听她用自己的声音唱出来 | — |
| M3 星露谷共玩 | （未开始） | 打开《星露谷》看她翻垃圾桶/种菜；晃一下鼠标，确认她立刻停手变场边啦啦队 | — |
| M4 直播与切片 | （未开始） | 在 OBS 添加 `http://localhost:18765` 浏览器源，挂测试直播间看她边玩星露谷边回弹幕、记仇和唱歌 | — |

## 证据记录格式（每条一行）

```
| <工单号> | <验证方式：[SIMULATION]/[E2E-HOST]/[REAL-DEVICE]> | <命令与关键断言摘要> | <日期> |
```

## Mock/沙盒验证已通过项

| 工单 | 验证方式 | 证据摘要 | 日期 |
| --- | --- | --- | --- |
| T-M0-01 | `[SIMULATION]`（规则引擎） | `pnpm lint:deps`：`no dependency violations found (7 modules, 5 dependencies cruised)`；临时探针 `zz-tmp-violation.ts`（import `ws`）实测命中 `shared-protocol-runtime-only-zod` 报错且 exit≠0，删除探针后恢复全绿 | 2026-11-15 |
| T-M0-01 | 编译 | `pnpm verify:gate`：Gate 1（tsc -b + depcruise）PASS、Gate 2（台账+密钥扫描）PASS，Gate 3/4 按计划待 T-M0-03/04 接线 | 2026-11-15 |
| T-M0-02 | `[SIMULATION]`（契约单测） | TS 侧 `pnpm test`：11 passed（大肥鱼夹具 parse/默认值/非法值拒绝/语音锁 TTL 边界/回执枚举/干饭套餐槽位）；Python 侧 `pnpm py:test`：4 passed（同一夹具回放 + 默认值一致性）——夹具双侧 probe 通过 | 2026-11-15 |
| T-M0-02 | 编译 | `pnpm gen:contracts`：17 份 JSON Schema + workbench 合并视图（17 $defs 去重冲突检测）→ `protocol_models.py`（0 个 Any 化残留）；`mypy --strict` Success（仅生成物 assignment 豁免，理由记录于 mypy.ini）；`ruff` All checks passed | 2026-11-15 |

## 待人类宿主真机验收项

| 里程碑 | 验收内容 | 状态 | 验收日期 |
| --- | --- | --- | --- |
| — | （暂无——各里程碑真机抽检项见上方状态总览） | ⏳ | — |
