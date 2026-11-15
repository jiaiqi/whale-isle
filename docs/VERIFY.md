# VERIFY — 验收标准矩阵

> **铁律**：严禁将静态代码阅读、单元测试或仿真沙盒测试（`[SIMULATION]` / `[E2E-HOST]`）冒充为真机实测（`[REAL-DEVICE]`）。
> 每行证据必须附**真实终端输出摘要**（命令 + 关键断言行），禁止"应该能过"式描述。
> 填写流程：AI 完成工单 → 跑 `pnpm verify:gate` → 在「Mock/沙盒验证已通过项」补一行证据 → 真机相关项**永远**留在右栏等人类宿主亲手验收。

## 状态总览（按里程碑）

| 里程碑 | Mock/沙盒验证已通过项（`[SIMULATION]` / 单测 / 编译） | 待人类宿主真机验收项（`[REAL-DEVICE]`） | 最近更新 |
| --- | --- | --- | --- |
| M0 地基与铁笼 | （未开始） | 无需真机：宿主查看 `pnpm verify:gate` 全绿即可放行 | — |
| M1 大肥鱼复活 | （M1-01/02 已过沙盒+真实 Electron E2E） | **OS 级真实点击穿透与鼠标拖拽手感**（E2E 只能验证状态机与坐标夹紧，无法模拟 OS 级点击落点）；输入框打一句"大肥鱼"，确认瞬间喷水破防并弹出 `<think>` 内心戏气泡 | — |
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
| T-M1-02 | `[E2E-HOST]`（Playwright Electron） | `pnpm test`：78 passed（desktop-host 新增 11 项）——真实 Electron 38 启动：alwaysOnTop API 真值 + meta 双证（transparent/frameless/skipTaskbar）；alpha 状态机 force(255/21)→interactive、force(20/0)→passthrough（阈值 20 边界全覆盖，经 passthrough:get 主进程回读）；dragTo(999999,999999) 被合并 workArea 夹紧、dragTo(40,40) 精确落位；测试钩子由 PET_STAGE_E2E=1 门控；覆盖率四维 90.3–97.1% 达标 | 2026-11-15 |
| T-M1-01 | `[SIMULATION]`（组件单测） | `pnpm test`：67 passed（pet-renderer 新增 18 项）——零黑帧时序断言（show(new) 严格先于 hide(old)/detach(old)；新片加载失败旧画面保留不黑屏）、同动作短路/force 重切/切换互斥 SWITCH_IN_PROGRESS、DEV 素材自动挂 [DEV-ASSET-ONLY] 徽标+署名（COMMERCIAL 不挂）、脚底布局纯函数（0.5→620/1.0→440）、Q 弹（落地压扁/体积守恒/收敛/强度截断 3）、加权选片含权重全 0 退化；工厂优先级 bug（load > 构造器）由测试暴露并修复；覆盖率 ≥90% 门槛达标 | 2026-11-15 |
| T-M0-04 | `[SIMULATION]`（沙盒自检） | `pnpm test`：46 passed（6 文件；mock-harness 新增 19 项）——stardew-mcp-simulator 5 剧本全断言（含互斥锁 ACTION_IN_FLIGHT / UNCERTAIN×2→FAILED 防死循环 / 接管中止 <100ms 实测 / 回执出站经 StardewMcpActionReceiptSchema 校验）；danmaku-storm-replay 5 项（1000 条 100% 过 Schema、同 seed 确定性回放、雷区/点歌/Prompt 注入/连击夹具齐备）；license-scanner 5 项（临时 fixture 实测密钥/禁源/GPL 报错 exit≠0 + 真实仓库全绿）；5 剧本顺序执行实测 <3000ms；mock-harness 纳入全局覆盖率后四维 92.2–96.9%（≥90% 门槛达标） | 2026-11-15 |
| T-M0-03 | `[SIMULATION]`（存储单测） | `pnpm test`：27 passed（含 local-store 15 项：记仇标签去重读写/好感榜单/隐私一键擦除/Token 流水 1粒米=1Token 汇总/点歌缓存命中计数/文件库 WAL 重开持久化/脏数据容错；Dexie fake-indexeddb 3 项）；覆盖率四维 100%（门槛 ≥90%） | 2026-11-15 |
| T-M0-02 | 编译 | `pnpm gen:contracts`：17 份 JSON Schema + workbench 合并视图（17 $defs 去重冲突检测）→ `protocol_models.py`（0 个 Any 化残留）；`mypy --strict` Success（仅生成物 assignment 豁免，理由记录于 mypy.ini）；`ruff` All checks passed | 2026-11-15 |

## 待人类宿主真机验收项

| 里程碑 | 验收内容 | 状态 | 验收日期 |
| --- | --- | --- | --- |
| — | （暂无——各里程碑真机抽检项见上方状态总览） | ⏳ | — |
