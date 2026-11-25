# RUNBOOK — M8 星露谷全自动跑通（T-M6-67 ~ T-M6-71）

> 本手册是 [ROADMAP.md](./ROADMAP.md)「M8 批次」的**执行说明**：每张工单的文件计划、关键接口、实现步骤、单测、真机测试步骤与完成判据。人类或编码代理（Codex / Claude Code / Kiro）照此逐张执行。
> **范围**：T-M6-67 → 68 → 69 → 73 → 70 → 72 → 71 串行（T-M6-72 见 §4B，T-M6-73 见 §4C）。`T-M6-66` 按用户指令（2026-11-25）**跳过**，相关前提见 §0.3。
> **口径铁律**：沿用 AGENTS.md——仿真结果标 `[SIMULATION]`，真机结果标 `[REAL-DEVICE]`，不得互相替代；单工单业务源码 ≤ 8 个文件；每张工单收尾必须 `pnpm verify:gate` 全绿 + ROADMAP/VERIFY/CHANGELOG 同步。

---

## 0. 通用前置（每次真机测试前过一遍）

### 0.1 本机环境

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| Xcode 命令行工具 | 已安装（当前缺失，`git` 不可用） | `xcode-select --install` → `git --version` |
| Node / pnpm | Node ≥ 22.5，依赖已装 | `node -v && pnpm -v && pnpm install` |
| 星露谷 | Stardew Valley 1.6.15 + SMAPI 4.5.2 | SMAPI 控制台首行 |
| BWF | Blind Whale Farmer 1.1.27 + `mods/bwf-patches/` 补丁版 DLL；**本机实测 MCP 端口为 18088**（以 BWF `config.json` 的 `McpPort` 为准） | `curl -s http://127.0.0.1:18088/settings` 含 `showHud` 键 |
| 工具清单 | 记录一次 BWF 实际工具名，后文工具名**以此为准** | 见 0.2 |
| 防休眠 | 浸泡期间 Mac 不睡眠、不锁屏 | 另开终端 `caffeinate -dimsu` |
| 截图权限 | 运行 soak 的终端已获「屏幕录制」权限 | 系统设置 → 隐私与安全性 → 屏幕录制 |

### 0.2 记录 BWF 工具清单（只做一次，结果入库）

```bash
curl -s -X POST http://127.0.0.1:18080/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' > docs/evidence/bwf-1.1.27-tools.json
```

后文出现的 `read_mail / water_crops / harvest_crops / ship_items / buy / plant_seeds / sleep / fish / forage / tidy_backpack / wait` 等工具名，均以这份清单为准；不一致时改代码常量，不改清单。

### 0.3 跳过 T-M6-66 带来的约束

- **LLM Key**：不依赖桌面端 vault 持久化。`soak:real` 是独立的无头进程，Key 从环境变量读（见 §1.3），只在本机终端里设置，不写文件、不进日志。
- **BWF 版本**：不做启动校验。每次真机测试前人工执行 0.1 的 `/settings` 检查，并把结果写进现场包的 `meta.json`。
- **11-24 修复复验**：不单独做，由 T-M6-67 首次 1 日浸泡顺带覆盖（夏 2 日海滩无鱼竿场景出现时看报告）。

### 0.4 星露谷与桌面端设置

1. 游戏「选项 → 窗口非活动时暂停游戏」**关掉**。否则切到终端时游戏暂停，时钟不走，会被误判为卡死。
2. 存档：`泡泡湾_454908853`。**每轮测试前先备份**：
   ```bash
   cp -R ~/.config/StardewValley/Saves/泡泡湾_454908853 ~/StardewSaveBackups/泡泡湾_$(date +%Y%m%d-%H%M)
   ```
3. **桌面端「鲸屿」的自动驾驶必须停掉**（或者直接退出 App）。BWF 同时只该有一个驱动方，否则两个 runner 会抢动作。
4. 浸泡期间动键鼠**不会**打断 AI（BWF 只认 F7 接管键）。但手动操作会和 AI 抢角色，测试期间别碰游戏窗口；真要介入请用「临时介入」开关或 F7（T-M6-73）。
5. 关掉通知弹窗和自动更新，避免抢焦点。

---

## 1. T-M6-67 — `soak:real` 真机浸泡工具

### 1.1 目标

一条命令连上真实 BWF，无人值守跑 N 个游戏日：实时算指标，自动判定卡死，卡死时落盘现场包，结束出报告。

### 1.2 设计决策

- **无头进程，不挂桌面端**：用 `tsx` 直接 import `packages/game-bridge-mcp/src` 里的 `AutodriveRunner / StardewAdapter / RulePlanner / LlmPlanner`。（`soak-autodrive.mjs` 注释已经说明 dist 是无扩展名 ESM，纯 Node 加载不了；`tsx` 已在 devDependencies 中。）
- **判定逻辑写成纯函数**，可单测；CLI 只负责组装。
- **独立观察者**：长动作（钓鱼、远距离 `travel_to`）期间 runner 不发 `state` 事件，所以另起一个只读 `BwfMcpClient`，每 30s `get_state` 取时钟。用 `--observer-ms=0` 可以关掉（如果发现并发读状态影响 BWF，就关掉，退回只用事件流里的时钟，并把长动作超时放宽到 10 分钟）。
- **新建 workspace 包 `tools/soak-real/`**，结构照 `tools/mock-harness`，vitest glob 会自动纳入 Gate 3。

### 1.3 文件计划（7 个）

| 文件 | 作用 |
| --- | --- |
| `tools/soak-real/package.json` / `tsconfig.json` | 包骨架（不计业务源码） |
| `tools/soak-real/src/stuck-detector.ts` | 卡死判定纯函数 + 失败签名归一化 |
| `tools/soak-real/src/day-tracker.ts` | 游戏日切分、每日闭环清单、金币曲线、累晕/2:00 遣返判定 |
| `tools/soak-real/src/evidence.ts` | 现场包落盘（事件、状态、规划器、截图、存档） |
| `tools/soak-real/src/report.ts` | 生成 `report.md` + `summary.json` |
| `tools/soak-real/src/cli.ts` | 参数解析、组装 runner、主循环、退出码 |
| `packages/game-bridge-mcp/src/planner.ts` + `llm-planner.ts` | 各加一个只读的 `debugSnapshot()`（冷却表、`rescueTried`、`avoidTools`、objective） |
| 根 `package.json` | 加 `"soak:real": "tsx tools/soak-real/src/cli.ts"` |

外加 `*.spec.ts` 测试文件（不计入 8 文件预算）。

### 1.4 关键接口

```ts
// stuck-detector.ts
export type StuckKind = 'clock-stall' | 'repeat-failure' | 'bwf-self-pause' | 'sentinel';
export interface StuckVerdict { kind: StuckKind; signature: string; detail: string; at: number }

/** 失败签名：工具名 + 去掉数字/坐标/物品名后的原因模板 + 地点 */
export function failureSignature(tool: string, summary: string, location: string): string;

export class StuckDetector {
  constructor(opts?: { clockStallMs?: number /*180_000*/; repeatThreshold?: number /*3*/; repeatWindow?: number /*30 条回执*/ });
  /** 喂 runner 事件；返回本次是否新判定卡死（同一签名冷却 5 分钟内只报一次） */
  onEvent(e: AutodriveEvent, now: number): StuckVerdict | null;
  /** 观察者时钟；时钟不推进 ≥ clockStallMs 且当前不在“睡觉/过场/菜单等待”白名单内 → clock-stall */
  onClock(clock: string | null, stateText: string, now: number): StuckVerdict | null;
}
```

**四条卡死判定：**

1. **clock-stall**：游戏时钟连续 180s（现实时间）不推进。豁免：正在 `sleep`，或时钟已过换日点（显示存档界面），或状态文本含过场/存档字样。
2. **repeat-failure**：同一个失败签名在最近 30 条回执里出现 ≥ 3 次，并且这期间时钟没有前进超过 1 小时（游戏时间）。
3. **bwf-self-pause**：回执或状态文本出现「已暂停游戏」「秒没有动作」。
4. **sentinel**：runner 自己发出 `watchdog kind=stuck` 事件。

```ts
// day-tracker.ts
export interface DayRecord {
  dayKey: string;            // "Y1-春-16"
  moneyStart: number; moneyEnd: number;
  loop: { mail: boolean; water: boolean; harvest: boolean; ship: boolean; buySeeds: boolean; plant: boolean; sleptBefore2am: boolean };
  passedOut: boolean;        // 体力 ≤ 0 或文本含「累晕」
  forcedHome2am: boolean;    // 换日前最后时钟 ≥ 01:50 且当天没有 sleep COMPLETED
  stuckCount: number;
  receipts: { completed: number; failed: number; timeout: number };
}
```

每日闭环各项都以「当天出现对应工具的 `COMPLETED` 回执」为准。`water` 遇雨天自动记为完成，`buySeeds` / `plant` 在冬季或季末不可种植时记 `N/A`（报告里单列，不算失败）。

### 1.5 现场包结构

```
artifacts/soak/<runId>/
├── meta.json          # 参数、git HEAD（读 .git/HEAD 与 refs）、BWF /settings 快照、开始时间
├── events.jsonl       # 全量事件流（每行一条，带 ts）
├── summary.json
├── report.md
└── stuck/<序号>-<kind>/
    ├── verdict.json
    ├── last50.jsonl   # 最近 50 条事件 + 回执
    ├── state.txt      # 判定瞬间 get_state 原文
    ├── planner.json   # debugSnapshot()
    ├── screen.png     # screencapture -x（失败不阻塞，写 screen.err）
    └── save/          # 当前存档目录的拷贝
```

### 1.6 CLI

```bash
pnpm soak:real -- --days 1                     # 默认：LLM 开（有 Key 时），观察者 30s
pnpm soak:real -- --days 2 --no-llm            # 纯规则
pnpm soak:real -- --days 7 --on-stuck=continue # 卡死后继续跑、累计（默认 continue）
pnpm soak:real -- --max-hours 3                # 现实时间上限保护
```

- LLM Key 环境变量：`WHALE_SOAK_PROVIDER`（预设 id）、`WHALE_SOAK_API_KEY`、`WHALE_SOAK_MODEL`，可选 `WHALE_SOAK_BASE_URL`。缺任一项时自动降级为 `--no-llm`，并在报告开头写明。
- `--on-stuck=stop`：首次卡死即停（调试用）。
- 退出码：`0` 达标；`1` 有卡死或闭环不达标；`2` 连接/参数错误。
- `Ctrl+C`：先 `stopAndWait()`，再写报告，不丢数据。

### 1.7 实现步骤

1. 写 `stuck-detector.ts` + spec：用假时钟、假事件覆盖四条判定、白名单豁免、冷却去重、签名归一化（「背包里没有鱼竿」带不同坐标，签名应相同）。
2. 写 `day-tracker.ts` + spec：跨日切分、雨天浇水豁免、2:00 遣返、累晕、冬季 N/A。
3. 给两个 planner 加 `debugSnapshot()`（只读，返回普通对象），补 1 条单测。
4. 写 `evidence.ts`：截图和存档拷贝失败只写 `.err`，不抛异常。spec 用临时目录跑一遍。
5. 写 `report.ts` + spec：给定 `DayRecord[]` 与卡死列表，快照对比 Markdown。报告包含：总览（达标与否）、每日表、失败签名 Top10、卡死清单（链接到现场目录）、金币折线（Markdown 表 + 可选 SVG）。
6. 写 `cli.ts`：组装 `StardewAdapter → AutodriveRunner`（`stepDelayMs` 用生产值），`onEvent` 依次喂给 detector、tracker 和 events.jsonl；判定卡死后调用 evidence。
7. 根 `package.json` 加脚本。跑 `pnpm typecheck && pnpm test && pnpm verify:gate`。

### 1.8 真机测试

| 步骤 | 操作 | 期望 |
| --- | --- | --- |
| 1 | 过一遍 §0，载入存档，停在早上 06:00 | — |
| 2 | `pnpm soak:real -- --days 1 --no-llm` | 终端每分钟输出一行进度（时钟、金币、成功率） |
| 3 | 放着不动直到换日 | 生成 `report.md`，1 个 `DayRecord` |
| 4 | **故意制造卡死**：跑之前在游戏里把鱼竿放进箱子，再把手动位置移到海滩 | 应触发 `repeat-failure`，或者规划器正确绕开（两种结果都记录） |
| 5 | **故意制造 BWF 自暂停**：`--days 1` 运行中执行 `kill -STOP <soak pid>`，等 130s 后 `kill -CONT` | 恢复后判定 `bwf-self-pause` 或 `clock-stall`，现场包完整 |
| 6 | 打开 `stuck/*/` | 7 个文件齐全；`screen.png` 能看到游戏画面 |
| 7 | 有 Key 时再跑一次 `--days 1`（LLM 开） | 报告开头标明「LLM：开（模型名）」 |

### 1.9 完成判据

- 单测：detector、tracker、report、evidence 全绿，Gate 3 覆盖率不低于 90%。
- `[REAL-DEVICE]`：1 个游戏日完整 `report.md` + 至少 1 份人为制造的卡死现场包，登记到 VERIFY.md。
- ROADMAP：T-M6-67 → `DONE`，T-M6-68 → `NEXT`。

---

## 2. T-M6-68 — 卡死现场 → 永久回归剧本

### 2.1 关键发现（开工前必读）

现有 `tools/mock-harness/src/stardew-simulator.ts` 是 **WebSocket JSON-RPC**，工具名也是 `move_to_tile / water_crops_batch` 这一套，**和 BWF 的 HTTP MCP 不同构**，不能直接拿来回放真机现场。要新建一个 **BWF 同构的 HTTP 回放服务**，参考 `packages/game-bridge-mcp/src/multi-runner.spec.ts` 里的 `startFakeBwf`（`tools/call` + `content[{type:'text'}]` + `isError`）。

### 2.2 文件计划（6 个）

| 文件 | 作用 |
| --- | --- |
| `tools/mock-harness/src/bwf-replay-server.ts` | BWF 同构 HTTP 假服务，按剧本 JSON 驱动 |
| `tools/mock-harness/src/stuck-scenario.ts` | 剧本 Zod schema + 加载器 |
| `tools/mock-harness/src/pack-to-scenario.ts` | 现场包 → 剧本草稿转换器（CLI） |
| `tools/mock-harness/src/stuck-regressions.spec.ts` | 遍历全部剧本跑 AutodriveRunner 并断言 |
| `tools/mock-harness/scenarios/stuck/*.json` | 剧本数据（不计业务源码） |
| `docs/STARDEW-STUCK-LEDGER.md` | 卡死台账 |

### 2.3 剧本格式

```jsonc
{
  "id": "S02-no-rod-fish-loop",
  "signature": "fish|背包里没有鱼竿|Beach",
  "source": "T-M6-10 2026-11-24 真机截图 / artifacts/soak/<runId>/stuck/01-repeat-failure",
  "initialState": "## 基本状态\n时间：第1年夏2日 07:10 …（get_state 原文）",
  "rules": [
    { "tool": "fish", "receipt": { "text": "背包里没有鱼竿", "isError": true } },
    { "tool": "forage", "receipt": { "text": "已采集 2 个 …", "isError": false }, "advanceMinutes": 30 },
    { "tool": "*", "receipt": { "text": "完成", "isError": false }, "advanceMinutes": 10 }
  ],
  "llmScript": ["{\"tool\":\"fish\",\"args\":{},\"intent\":\"去钓鱼\"}"],  // 可选：LLM 相关卡死用录制的输出
  "expect": {
    "maxCycles": 40,
    "maxSameFailure": 2,
    "mustCallOneOf": ["forage", "wait"],
    "clockMustAdvance": true
  }
}
```

- 回放服务维护一个当前状态文本，按 `advanceMinutes` 改写时钟行，以 `/时间：第\d+年[春夏秋冬]\d+日 \d{2}:\d{2}/` 为锚点。
- `"freezeUntilMutation": true` 模拟 BWF 120s 自暂停：时钟冻结，直到收到任意变更类工具调用。
- `llmScript` 存在时，用假 `chat()` 依次吐出脚本内容，吐完后返回无法解析的内容，以覆盖 LLM 失败分支。

### 2.4 首批剧本（≥ 5 个，取自 T-M6-10 与 VERIFY 已有证据）

| ID | 场景 | 来源 | 期望脱困 |
| --- | --- | --- | --- |
| S01 | 满包、无箱子、非工具物品全带【留着】、木材 22 < 50 | VERIFY「满包造箱自救·现场二」 | 牺牲可再生预留物 / 出货，空位 > 0 |
| S02 | 夏 2 日 07:10 海滩，没有鱼竿，LLM 反复 fish | T-M6-10 2026-11-24 | ≤ 2 次 fish 失败后转 forage 或 wait |
| S03 | 剧情多行选择题，`dialogue` 解析失败无限循环 | T-M6-10 第一轮 | 选 choice 0 并推进 |
| S04 | BWF 120s 自暂停，春 24 06:00 FarmHouse 冻结 | VERIFY「春24 冻结死锁」 | keepalive `wait` 后时钟推进 |
| S05 | `tidy ↔ store ↔ donate` 无箱子循环 | transcript-20261122-182601 | 救援阶梯走完后 `wait` 求助，不再循环 |
| S06 | LLM 连败 → 规则兜底不知失败、继续 fish | T-M6-10 2026-11-24 根因 | 回执转发给 fallback，规则避开 fish |

状态文本用 VERIFY/ROADMAP 里记录的原文片段拼出最小可复现版本，并在 `source` 字段写明出处。

### 2.5 台账格式（`docs/STARDEW-STUCK-LEDGER.md`）

| 签名 | 首次出现 | 频次（累计浸泡） | 剧本 | 修复工单 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `fish\|背包里没有鱼竿\|Beach` | 2026-11-24 | 3 | S02 | T-M6-10 | 已修 / 回归中 |

**规则**：每次 `soak:real` 跑完，按报告里的失败签名 Top10 更新频次；新签名先建剧本（红），修复后变绿，再改状态。修复顺序按频次从高到低。

### 2.6 实现步骤

1. `stuck-scenario.ts`：Zod schema + `loadScenarios(dir)`，加 schema 单测。
2. `bwf-replay-server.ts`：`start(): Promise<{endpoint, calls, close}>`，同时支持 JSON / SSE 两种响应（参考 `mcp-client.spec`）。
3. `stuck-regressions.spec.ts`：每个剧本一条 `it`。`AutodriveRunner` 的 `maxCycles = expect.maxCycles`、`sleep` 用 no-op，断言 `calls` 序列满足 `expect`。
4. 写 S01–S06。**先在 T-M6-10 修复前的提交上确认剧本会失败**（或用 `RulePlanner` 的旧行为开关），确认剧本真能抓到问题；再在当前 main 上转绿。拿不到旧提交时，至少手动删掉对应修复的一行，确认会变红。
5. `pack-to-scenario.ts`：`pnpm tsx tools/mock-harness/src/pack-to-scenario.ts artifacts/soak/<run>/stuck/<id>` 产出剧本草稿，`expect` 部分由人补全。
6. `verify-gate.mjs` 不用改：剧本在 vitest 里，Gate 3 自动纳入。在 gate 输出里打印剧本数量，方便看。

### 2.7 真机测试

从 T-M6-67 真机产出的现场包里挑一份，跑转换器 → 补 `expect` → 当前代码上应**复现失败**（红）→ 修复 → 转绿 → 台账登记。整条链路走通一次，就算本工单真机部分完成。

### 2.8 完成判据

- 至少 6 个剧本全绿，接入 Gate 3；人为回退任一修复时对应剧本变红（在 PR 描述里贴证据）。
- 台账与剧本一一对应。
- ROADMAP：T-M6-68 → `DONE`，T-M6-69 → `NEXT`。

---

## 3. T-M6-69 — 规则规划器每日闭环底线

### 3.1 目标

没有 LLM 时，`RulePlanner` 也能独立完成每日闭环。这是 T-M6-71 的保底：LLM 挂了也能跑满 7 天。

### 3.2 现状

`planner.ts` 660 行。`RulePlanner` 的阶段是 `morning-mail / farm-work / fishing / forage`，18:30 就回家，**没有买种子和播种环节**，也没有季节与成熟期判断。

### 3.3 文件计划（≤ 6 个）

| 文件 | 作用 |
| --- | --- |
| `packages/game-bridge-mcp/src/rule-schedule.ts`（新） | 日程状态机，从 `RulePlanner` 拆出 |
| `packages/game-bridge-mcp/src/seed-table.ts`（新） | 季节种子表 + 成熟期 / 季末判断 |
| `packages/game-bridge-mcp/src/planner.ts` | `RulePlanner` 改为调用日程 + 前置检查 |
| `packages/game-bridge-mcp/src/state-hints.ts` | 补解析：种子数、已开垦空地、商店营业 |
| `tools/mock-harness/src/bwf-farm-sim.ts`（新） | 轻量农场仿真（多日） |
| `tools/mock-harness/src/rule-7day.spec.ts`（新） | 7 日纯规则闭环测试 |

### 3.4 日程（优先级从高到低）

1. **生存护栏**（任何时候先判）：
   - 体力 < 15% → 停止干活，回家；< 8% → 原地 `sleep`（沿用）；
   - 时钟 ≥ 24:00 → 强制 `travel_to FarmHouse` + `sleep`；
   - 血量 < 30% → 沿用现有逻辑。
2. **菜单 / 过场**：沿用 `handleMenu`。
3. **背包空位 = 0**：沿用救援阶梯（ship → donate → tidy 一次 → wait 求助）。
4. **晨间**：`read_mail` → 有作物则 `water_crops`（雨天跳过）→ `harvest_crops`。
5. **出货**：背包里有可卖物 → `ship_items`。
6. **购种**（满足全部条件才去）：
   - 皮埃尔商店营业：9:00–17:00，周三休息，节日休息；
   - 当前季节有种子能在季末前成熟（`seed-table`）；
   - 金币 ≥ 预算（保留 ≥ 100g，最多买「空地数」份，单次 ≤ 金币 × 60%）；
   - 背包里该种子数 < 空地数。
7. **播种**：有种子且有已开垦空地 → `plant_seeds`；没有空地且体力 > 40% → `till_area`（数量有上限，比如 ≤ 15 格，避免把体力耗光）。
8. **填充**：有鱼竿且背包有空位 → `fish`；否则 `forage`；都被避开（`avoidTools`）→ `wait` 求助。
9. **收工**：22:00 回家睡觉。从原来的 18:30 推迟，做成可配置项 `bedtime`，T-M6-71 取 22:00。

### 3.5 种子表（初版，数值以游戏内商店为准，可调）

| 季节 | 种子 | 价格 | 成熟天数 | 备注 |
| --- | --- | --- | --- | --- |
| 春 | 防风草种子 | 20g | 4 | 便宜、稳定 |
| 夏 | 辣椒种子 | 40g | 5 | 可重复收获 |
| 秋 | 小白菜种子 | 50g | 4 | |
| 冬 | — | — | — | 不种植，只做填充 |

规则：`季内剩余天数 ≥ 成熟天数`，否则当天不买不种（报告里记 N/A）。

### 3.6 `bwf-farm-sim.ts`（轻量农场仿真）

- 状态：日期 / 时钟 / 金币 / 体力 / 背包（工具、种子、作物、杂物）/ 农田格子（空、已开垦、已播种 d 天、可收获）/ 天气（按种子确定）/ 星期。
- 每个工具调用：推进固定分钟数、消耗体力、改状态；`sleep` 换日、作物生长、出货结算。
- 输出与 BWF `get_state` 同格式的文本（标题段落与真机一致，以 §0.2 的真实样例为模板）。
- 和 S 系列剧本不同：这里是「活」的世界，用来测多日闭环。

### 3.7 测试

- `seed-table` 单测：季末、冬季、价格预算。
- `rule-schedule` 单测：每条优先级分支、周三不去商店、17:00 后不去商店、雨天不浇水、24:00 强制回家。
- `rule-7day.spec.ts`：农场仿真里纯规则跑 7 天，断言：
  - 每天闭环项全部完成（N/A 除外），0 次累晕，0 次 2:00 遣返；
  - 第 7 天金币 > 第 1 天；
  - `chat()` 调用次数 = 0；
  - 跨季：从春 26 开始跑，到夏 4 应切换种子。
- 回归：T-M6-68 的全部剧本保持绿。

### 3.8 真机测试

1. §0 前置，存档停在某天 06:00（最好是春季中旬）。
2. `pnpm soak:real -- --days 2 --no-llm`。
3. 看报告：每日闭环 6 项是否打勾、卡死 0、金币趋势。
4. 出现新卡死 → 走 T-M6-68 流程补剧本 → 修复 → 重跑，直到 2 天 0 卡死。

### 3.9 完成判据

- 单测与 7 日仿真全绿，剧本全绿，`verify:gate` 通过。
- `[REAL-DEVICE]`：`--no-llm` 真机 2 个游戏日，0 卡死，闭环 2/2。
- ROADMAP：T-M6-69 → `DONE`，T-M6-70 → `NEXT`。

---

## 4. T-M6-70 — LLM 全权决策模式

> **2026-11-25 设计变更**：开启 LLM 大脑后，AI 按自己的想法玩：自己决定每天做什么，依据游戏状态、人设、攻略和自己的心得。主人通过聊天沟通，但做不做由 AI 判断。用户决策：LLM 不可用时**临时切规则**；生存风险**只提醒不强制**。原「LLM 降为目标层」方案作废。攻略学习单独拆到 §4B（T-M6-72）。

### 4.1 两种模式

| 模式 | 每一步由谁决定 | 依据 |
| --- | --- | --- |
| 大脑开 | LLM | `get_state`、人设、当日计划、攻略索引与心得（T-M6-72）、最近回执与失败记忆、主人的话 |
| 大脑关 | `RulePlanner`（T-M6-69） | 固定日程 + 资源前置检查 |
| 大脑开但 LLM 不可用 | `RulePlanner` 临时代驾 | 恢复后立即交回 LLM |

### 4.2 每日计划

- **起床后**（换日后第一次可自由行动时）调用一次「计划」prompt，输出：
  ```json
  {"plan":[{"goal":"浇水收菜","why":"昨天种的防风草今天熟"},{"goal":"去皮埃尔买夏季种子","why":"明天换季"}],"mood":"有点困但想赚钱"}
  ```
- 计划存进 runner 状态，每轮决策 prompt 都带上，并标出已完成和进行中的项。
- LLM 在任一步输出里可以带 `planUpdate`（增删改项 + 理由），比如下雨了、主人提议、发现新机会。
- 计划和每次修订都广播 `plan` 事件，UI 显示当日计划，桌宠气泡用人设口吻念一句。
- 计划完全不做规则校验，只校验 JSON 格式。

### 4.3 聊天：普通消息是建议，`/` 开头是强制命令

**普通消息（不以 `/` 开头）＝建议**

- 主人消息进入「主人说」上下文段，标明时间。下一轮决策时 LLM **必须**额外输出：
  ```json
  {"reply":"哼，现在去矿洞？天都快黑了……明天一早再去！","stance":"decline","tool":"water_crops","args":{},"intent":"先把菜浇了"}
  ```
  `stance` 取 `accept / modify / decline`。
- `reply` 走现有的气泡和语音，同时写入聊天记录；`stance` 写进事件流，用来统计采纳率。
- 主人这条消息保留在上下文里，直到 LLM 表态，或者过了 2 个游戏小时。

**`/` 开头＝强制命令（2026-11-25 用户指令：「/ 后面发的 AI 必须听，除非完全不可行」）**

1. **快捷命令**：直接映射工具，P0 插队执行，不经过 LLM。保留现有 `App.tsx` 的 `parseDirective`：`/goto <地点>`、`/fish <次数>`、`/sleep`、`/forage`、`/state`、`/stop`（中止当前动作）。
2. **`/自然语言`**：比如「/去皮埃尔买 10 包防风草种子」「/今天别下矿」。
   - 修复现在的问题：`parseDirective` 的 `default` 分支会把不认识的 `/xxx` 当成工具名发出去。改成：命令词不在快捷表里，就整句作为**强制目标**交给 LLM。
   - prompt 里单独一段「主人的命令（必须执行）」，排在当日计划之前。
   - LLM 输出 `stance` 只允许 `execute / infeasible`：
     ```json
     {"stance":"execute","reply":"知道啦知道啦，这就去买……","tool":"travel_to","args":{"location":"SeedShop"},"intent":"执行主人命令：买防风草种子"}
     {"stance":"infeasible","reason":"今天周三，皮埃尔不开门","alternative":"明天 9 点一开门就去买","reply":"主人，今天皮埃尔休息呀！明早第一个去～"}
     ```
   - 收到 `decline` / `modify` 或没表态：**拒收**，在下一轮 prompt 里注明「这是强制命令，只能执行或说明为什么完全做不到」，然后重问。连续 2 次不合规算 LLM 无法解析（进入 4.7 的代驾判定）。
   - `infeasible` 必须给出具体原因（缺前置条件、工具不存在、游戏规则不允许、营业时间不对等），可以附带替代方案；原因和替代方案写进事件流，在气泡里如实告诉主人。
   - 命令持续有效，直到完成（LLM 输出 `commandDone` 且最近回执是 COMPLETED）、判定不可行，或主人发 `/cancel`。期间优先于当日计划，完成后回到计划。
   - 说话语气仍按人设（可以嘴硬），但必须照做。
3. **LLM 不可用时**：快捷命令照常执行；`/自然语言` 走 `chat-directive` 现有的关键词映射（去海滩、钓鱼、整理背包、睡觉……），映射不了就如实回复「大脑离线，现在只能执行快捷命令」，不能假装接了单。

**硬停止**只有两个：「停止自驾」按钮和「临时介入」开关（T-M6-73），外加 `/stop` 中止当前动作。动键鼠不会打断 AI。`chat-directive.ts` 只负责区分普通消息、快捷命令和强制目标，然后转发和记录。

### 4.4 要删掉的（大脑开时）

`llm-planner.ts` 里所有「规则替模型做主」的分支：满包救援改写、`repeated → fallback.decide()`、`LOW_SPACE_BLOCKED` 拦截、体力/时间护栏改写、冷却后硬切规则，以及 objective 的规则化推进。LLM 可用期间 `RulePlanner.decide` 一次都不调用。

### 4.5 要保留的（基础保障，不替模型选玩法）

- 「临时介入」开关（T-M6-73）与「停止自驾」按钮；动键鼠不打断 AI；
- 120s keepalive（防 BWF 自暂停）；
- `ActionLock` 单飞互斥；
- 工具白名单 + 参数校验（不合法算「无法解析」）；
- 全局熔断：同一失败签名 + 时钟不推进 → 暂停 30s 并气泡求助，不替模型选动作。

### 4.6 决策 prompt 组成（每轮）

1. 人设（沿用 `autodrive-host` 的 persona prompt）；
2. 当日计划（含完成进度）；
3. 当前状态摘要（`get_state` 精简 + `state-hints`）；
4. **生存提醒段**（醒目，只提醒）：体力比例、距 02:00 剩余时间、血量、背包空位；
5. **失败记忆段**：最近失败签名、连败次数、时钟停滞时长，并写明「上次这样做失败了，换个做法」；
6. 攻略索引 + 相关心得（T-M6-72 提供；T-M6-72 之前先沿用现有 `pickGuideContext`）；
7. 主人的命令（`/自然语言`，必须执行，排在计划之前，实际插在第 2 段前面）+ 主人说（未表态的普通消息）；
8. 工具白名单 + 输出格式 `{tool, args, intent, planUpdate?, reply?, stance?, reason?, alternative?, commandDone?}`。

### 4.7 LLM 不可用判定与切换

- 判定：没 Key；单次超时（沿用 gateway 超时）；连续 3 次输出无法解析或不在白名单。
- 切换：发 `brain` 事件（`llm → rule-standin`），UI 显示「规则代驾中」。
- 恢复探测：代驾期间每现实 2 分钟试一次 LLM，成功即交回并发事件。
- 代驾时 `RulePlanner` 正常接收 `observeReceipt`（保持 S06 的修复有效），并且必须能在一天中任意时间接手。

### 4.8 文件计划（≤ 8 个）

| 文件 | 作用 |
| --- | --- |
| `packages/game-bridge-mcp/src/llm-planner.ts` | 删除强制改写，只留决策主流程（≤ 500 行） |
| `packages/game-bridge-mcp/src/llm-prompt.ts`（新） | prompt 组装（§4.6 各段） |
| `packages/game-bridge-mcp/src/llm-utils.ts`（新） | 从 llm-planner 迁出的解析与归一化工具函数 |
| `packages/game-bridge-mcp/src/day-plan.ts`（新） | 当日计划 schema、存储、修订、进度标记 |
| `packages/game-bridge-mcp/src/brain-switch.ts`（新） | 大脑开/关/代驾状态机与恢复探测 |
| `packages/game-bridge-mcp/src/autodrive.ts` | 接入计划、主人消息队列、brain-switch；`plan`/`brain`/`chat-stance` 事件 |
| `apps/desktop-host/src/main/autodrive-host.ts` | 组装；reply 走气泡与语音 |
| `apps/desktop-host/src/main/chat-directive.ts` | 区分普通消息 / 快捷命令 / 强制目标，转发与记录；`App.tsx` 的 `parseDirective` default 分支改为强制目标（如超预算拆到 T-M6-70b） |

`index.ts` 导出调整、UI 显示计划和代驾状态如果超出预算，拆一个小工单 T-M6-70b。

### 4.9 测试

- LLM 可用时 `RulePlanner.decide` 调用 0 次（spy）。
- 体力 5%、时钟 01:40 时 LLM 选 `fish`，原样执行，prompt 含生存提醒。
- 失败一次后，下一轮 prompt 含失败签名和「换做法」。
- 换日后生成一次计划；`planUpdate` 生效；`plan` 事件发出。
- 普通聊天：`decline` 时不执行建议且 `reply` 进气泡；`accept` 时下一步与建议一致；2 个游戏小时没表态则过期。
- 强制命令：快捷命令直达工具；`/自然语言` 下 LLM 输出 `decline` 被拒收并重问，连续 2 次不合规进入代驾判定；`infeasible` 没有 `reason` 被拒收；`execute` 后命令持续到 `commandDone` + COMPLETED；`/cancel` 结束；LLM 离线时关键词映射或如实回复；未知 `/xxx` 不再被当成工具名发出去。
- 没 Key → 代驾 → 恢复后交回，双向事件；连续 3 次乱码 → 代驾。
- 回归剧本：S01/S03/S04/S05 保持绿；S02/S06 按新语义调整 `expect`（脚本化 LLM 坚持 fish 时应在熔断阈值内暂停求助；另加正例：看到失败记忆后改选 forage），并写决策声明。
- `llm-planner.ts` ≤ 500 行。

### 4.10 真机测试

| 轮次 | 命令 | 记录 |
| --- | --- | --- |
| A | `pnpm soak:real -- --days 2 --llm --endpoint http://127.0.0.1:18088/mcp` | 卡死数、代驾占比、token 用量、金币、累晕/遣返（只记录）、每日计划内容 |
| B（对照） | `pnpm soak:real -- --days 2 --no-llm --endpoint http://127.0.0.1:18088/mcp` | 同上 |

桌面端手动测：
- 3 条普通聊天：「去鱼店买根鱼竿」「现在去矿洞」「快回家睡觉」，记录每条的 `stance` 和 `reply`，确认是 AI 自己判断的，而且符合人设。
- 3 条强制命令：「/去鱼店买根鱼竿」（应执行）、「/现在去矿洞」（深夜也应执行）、周三发「/去皮埃尔买种子」（应回 `infeasible` 并说明不开门）。再发一次 `/fish 3` 确认快捷命令直达。

### 4.11 完成判据

- 单测、剧本全绿；`verify:gate` 通过；`llm-planner.ts` ≤ 500 行。
- `[REAL-DEVICE]` A/B 报告各 2 天，每日计划、聊天表态如实登记。
- ROADMAP：T-M6-70 → `DONE`，T-M6-72 → `NEXT`。

---

## 4B. T-M6-72 — 攻略学习与经验心得

### 4B.1 目标

AI 能读攻略、判断攻略说的是否适合当前局面，再决定采不采纳；并从自己的游玩结果里总结经验，验证或推翻攻略，下次决策用上。

### 4B.2 现状

`guide-forager/` 有 7 篇专题（钓鱼、采矿、节日、结婚、沙漠、姜岛、农场类型），宿主每篇只读前 4000 字。`pickGuideContext` 只在状态文本命中关键词时塞入某专题的前 1200 字。缺少新手开局、作物收益这类日常最需要的内容。BWF 自带 `get_guide` 工具。

### 4B.3 设计

1. **攻略库索引化**（`guide-library.ts`）
   - 每篇按 `##`/`###` 切小节，生成 `{topic, sectionId, title, summary(≤80字), text}`；summary 取首段，不调用 LLM。
   - 每轮 prompt 只放**索引**：当前季节、地点相关的专题，给出小节标题与 summary，总长 ≤ 800 字。
   - 新增宿主侧伪工具 `read_guide{topic, section}`：由宿主直接返回小节全文（≤ 2000 字），**不发往游戏、不占动作锁、不推进时间**；同一轮最多读 2 节，读完再决策。
2. **补采攻略专题**（`guide-forager` 配置，内容不计业务源码）：开局前几周、四季作物收益、社区中心收集包、赚钱路线、工具升级。来源与许可沿用 T-M5-15 的流程，frontmatter 写明出处。
3. **攻略分析 → 心得**：读完一节后，LLM 在决策输出里附带
   ```json
   {"insight":{"source":"四季作物收益#春季","claim":"草莓春季收益最高","when":"春 13 蛋节买种，且金币 ≥ 1000","verdict":"defer","why":"现在才春 5，钱也不够，先种防风草"}}
   ```
   `verdict` 取 `adopt / defer / reject`。宿主校验后写入心得本。
4. **每晚复盘**：在 LLM 决定 `sleep` 之前（或 24:00 后第一次决策时）调用一次「复盘」prompt，输入当天计划完成情况、回执统计、金币变化、失败签名 Top3 和相关心得；输出新增或修改的心得（可把 `defer` 改成 `adopt`，或标记 `refuted` 并写实测数据），外加明日打算（作为第二天计划 prompt 的输入）。每天只复盘一次，换日键保证幂等。
5. **心得本**（`strategy-notebook.ts`）
   - 按存档分文件：`userData/stardew-notes/<saveName>.json`，Zod 校验。
   - 字段：`id, source, claim, when, verdict, why, evidence[], createdDay, updatedDay, hits`。
   - 上限 200 条：先淘汰 `refuted` 且久未引用的，再淘汰 `hits` 最低的。
   - 检索：按季节、地点、当日计划关键词、`when` 条件做简单打分，每轮取前 5 条注入 prompt（复用 `memory-graph` 的 retrieve 如果合适，以代码为准）。
   - 决策输出引用了某条心得（`usedInsight: id`）时 `hits+1`，并写入事件流，方便追溯「这一步是因为哪条心得」。
6. **只读界面**：中控台星露谷页加「当日计划」和「心得本」两个只读面板（如果超出文件预算，拆成 T-M6-72b）。

### 4B.4 文件计划（≤ 8 个）

| 文件 | 作用 |
| --- | --- |
| `packages/game-bridge-mcp/src/guide-library.ts`（新） | 切块、索引、`read_guide` |
| `packages/game-bridge-mcp/src/strategy-notebook.ts`（新） | 心得 schema、存取、淘汰、检索 |
| `packages/game-bridge-mcp/src/reflection.ts`（新） | 每晚复盘 prompt 与结果合并 |
| `packages/game-bridge-mcp/src/llm-prompt.ts` | 注入攻略索引与心得；输出格式加 `insight / usedInsight` |
| `packages/game-bridge-mcp/src/llm-planner.ts` | 处理 `read_guide` 伪工具循环与 insight 落盘 |
| `apps/desktop-host/src/main/autodrive-host.ts` | 加载攻略库、心得本路径（按存档名） |
| `tools/guide-forager/src/forage.ts` | 新专题采集配置 |
| 中控台星露谷面板（1 个文件） | 计划 + 心得只读展示 |

### 4B.5 测试

- 切块：标题层级、空节、超长节截断，索引在同一输入下稳定。
- `read_guide`：不调用 transport，不进 ActionLock，同一轮超过 2 次被拒。
- 心得：schema 校验、上限淘汰顺序、检索打分、`hits` 计数。
- 复盘：sleep 前触发一次、同一天不重复、LLM 乱码时跳过且不影响睡觉。
- 端到端（回放服务 + 脚本化 LLM）：读攻略 → 产出 `defer` 心得 → 两天后条件满足 → 决策引用该心得 → 复盘改为 `adopt`。

### 4B.6 真机测试

1. `pnpm soak:real -- --days 2 --llm --endpoint http://127.0.0.1:18088/mcp`。
2. 检查心得本文件：至少有 1 条来自攻略的心得，并且有 `verdict` 和理由。
3. 检查事件流：至少 1 次决策带 `usedInsight`，至少 1 次复盘修改了已有心得。
4. 抽查 3 条心得是否合理（人工判断，记入 VERIFY）。

### 4B.7 完成判据

- 单测与端到端剧本全绿；`verify:gate` 通过。
- `[REAL-DEVICE]` 满足 4B.6 的 2–3 条，心得本样例归档到 `docs/evidence/`。
- ROADMAP：T-M6-72 → `DONE`，T-M6-71 → `NEXT`。

---

## 4C. T-M6-73 — 临时介入开关

> 2026-11-25 用户指令：动键鼠时 AI 不要停；在界面上加开关，临时介入控制。顺序排在 T-M6-69 之后、T-M6-70 之前（T-M6-70 的「交还后告诉 LLM 主人做了什么」依赖它）。

### 4C.1 现状（已核对代码）

- **BWF 本身不会因普通键鼠输入停 AI**：只认 `TakeOverKey`（默认 F7）切换 `PlayerInControl`（`ModEntry.cs` 262–265 行）。接管态下 AI 动作一律被拒，**不冻结时间、不做 120s 自暂停**（343、403、410 行）。
- **MCP 没有切换接管的入口**：`SetPlayerInControl` 只能按键触发。
- **宿主侧没有星露谷的键鼠检测**（只有泰拉瑞亚的 `TakeoverWatch.cs`，属冻结范围）。
- 所以「动键鼠不停」在星露谷上已经成立，要做的是：清掉文档里的旧口径 + 加开关 + 介入/交还的完整流程。

### 4C.2 流程

```
           [我来操作]                                      [交还给 AI]
runner: running ──▶ human ──────────────────────────────▶ resuming ──▶ running
          │  ① ActionLock.cancel（在途动作）               │ ① BWF playerInControl=false
          │  ② 停决策循环、停 keepalive                    │ ② get_state，和介入前快照做差异
          │  ③ 记介入前快照                                │ ③ 差异摘要写进下一轮 prompt
          │  ④ BWF /settings playerInControl=true          │    「主人刚刚亲自玩了 X 分钟：…」
          ▼                                               ▼
       发 control 事件（human）                         发 control 事件（ai）
```

- 差异摘要包括：地点、游戏时间、金币、体力、背包增减（按物品名合并）、当前界面。
- 规则模式交还时：按当前时间重新定位当天日程，不从早上重来。
- **F7 同步**：每次 `get_state` 文本里出现【玩家接管中】，就自动进入 `human`；消失（且不是开关触发的）就自动交还。
- **旧 DLL 降级**：`/settings` 回读里没有 `playerInControl` 键时，只停宿主 runner，UI 提示「游戏里按 F7 可完全接管；更新 BWF 补丁后开关可直接接管」。

### 4C.3 文件计划（≤ 8 个）

| 文件 | 作用 |
| --- | --- |
| `mods/bwf-patches/2026-11-25-player-in-control-settings.patch`（补丁，不计业务源码） | `ApplyRemoteSettings` 支持 `playerInControl` → `SetPlayerInControl`；`SettingsSnapshot` 回报该键 |
| `packages/game-bridge-mcp/src/autodrive.ts` | `human` 态：`pauseForHuman()` / `resumeFromHuman()`，`control` 事件，F7 文本检测 |
| `packages/game-bridge-mcp/src/handover-diff.ts`（新） | 介入前后状态差异摘要（纯函数） |
| `apps/desktop-host/src/main/bwf-settings.ts` | 写 `playerInControl` 并回读确认 |
| `apps/desktop-host/src/main/autodrive-host.ts` | IPC `autodrive:intervene`/`autodrive:handback`，广播状态 |
| `apps/desktop-host/src/main/tray-host.ts` + 浮窗渲染入口 | 托盘开关 |
| `apps/desktop-host/src/main/pet-context-menu.ts` | 桌宠右键菜单开关 |
| 中控台星露谷面板（1 个文件） | 顶栏开关 + 状态条 |
| `tools/soak-real/src/stuck-detector.ts` | `human` 态期间不判卡死（复用 `control` 事件） |

超出 8 个就把托盘和右键菜单拆成 T-M6-73b。

### 4C.4 测试

- `handover-diff`：地点/时间/金币/背包增减、空变化、解析失败。
- `autodrive`：`pauseForHuman` 时调了 cancel、之后 0 次决策、0 次 keepalive；`resumeFromHuman` 后差异摘要进入 planner 上下文、循环恢复；【玩家接管中】文本 → 自动 `human`，文本消失 → 自动交还。
- `bwf-settings`：写入成功回读一致；旧 DLL 无该键 → 降级标记。
- `stuck-detector`：`human` 期间时钟不动也不判 `clock-stall`。
- Electron E2E：中控台、托盘、右键菜单三处开关状态同步。
- 回归：S01–S06 全绿。

### 4C.5 真机测试

1. 打补丁版 BWF（构建流程同 `mods/bwf-patches/README.md`），重启游戏。
2. 开自驾。在游戏窗口里按方向键、晃鼠标。期望：AI 不停。
3. 点「我来操作」。期望：AI 1 秒内停，HUD 显示接管中，三处开关同步。
4. 手动买一包种子，点「交还给 AI」。期望：AI 气泡提到主人买了种子，然后继续。
5. 游戏里按 F7 / 再按 F7。期望：开关自动跟着切换。
6. 用旧 DLL 重复第 3 步。期望：宿主停住，并有降级提示。

### 4C.6 完成判据

- 单测、E2E、剧本全绿；`verify:gate` 通过。
- `[REAL-DEVICE]` 4C.5 第 2–5 步通过，登记 VERIFY。
- ROADMAP：T-M6-73 → `DONE`，T-M6-70 → `NEXT`。
- `docs/VERIFY.md` 里 M3 行「晃一下鼠标确认她立刻停手」的旧口径改成「动键鼠不停，用开关介入」。

---

## 5. T-M6-71 — 验收：7 个游戏日无人干预

### 5.1 预检（开跑前全部打勾）

- [ ] `pnpm verify:gate` 全绿，`main` 是干净的已提交状态，记下 commit
- [ ] §0 全部前置完成（防休眠、窗口失焦不暂停、存档已备份、桌面端自驾已停）
- [ ] BWF `/settings` 快照已存
- [ ] LLM 环境变量已设置（大脑开，全权决策）
- [ ] 预留约 2.5 小时现实时间不用这台 Mac（临时介入抽检除外）

### 5.2 执行

```bash
caffeinate -dimsu &                                  # 防休眠
pnpm soak:real -- --days 7 --llm --on-stuck=continue --max-hours 3 --endpoint http://127.0.0.1:18088/mcp
```

### 5.3 临时介入抽检（≥ 3 次，人工）

分别在第 2、4、6 个游戏日中午左右做：

1. 先在游戏窗口里随便按几下方向键、晃晃鼠标。期望：AI **不停**，事件流里没有中止回执。
2. 点中控台（或托盘、桌宠右键菜单）的「我来操作」。期望：1 秒内 AI 停手，在途动作被中止，三处开关同时亮起，游戏 HUD 显示接管中。
3. 手动做点事（走几步、买个东西），然后点「交还给 AI」。期望：AI 气泡提到主人刚做的事，然后继续玩。
4. 另做一次：在游戏里按 F7 接管、再按 F7 交还。期望：开关自动跟着切换。

**注意**：介入期间不计卡死、不计时钟停滞，报告里单列介入时长；交还后 3 分钟内 AI 没恢复动作，算失败。

### 5.4 判定（LLM 自主模式口径，2026-11-25 用户决策）

| 指标 | 通过条件 | 数据来源 |
| --- | --- | --- |
| 连续运行 | 7 个 `DayRecord`，LLM 大脑开 | report.md |
| 卡死 | 0（抽检接管除外） | 卡死清单 |
| 进展 | 第 7 天金币 > 第 1 天 | 金币曲线 |
| 学习 | 新增心得 ≥ 7 条；每晚复盘 7/7 | 心得本文件 + `reflection` 事件 |
| 自主性 | 每日计划 7/7 生成 | `plan` 事件 |
| 介入 | 动键鼠不打断；开关/F7 介入 3/3 即停即回 | `human` 态事件 + 人工记录 |
| 只记录（不判失败） | 规则代驾占比、聊天建议采纳率、token 用量、累晕次数、2:00 遣返次数、每日闭环完成项 | report.md |

`soak:real` 的报告和退出码要同步这套口径：`--llm` 时按上表判定，`--no-llm` 时仍按每日闭环 7/7 判定。这部分改动放在 T-M6-72 里做（`tools/soak-real/src/report.ts`、`day-tracker.ts` 增加计划、复盘、心得统计），文件预算不够就拆成 T-M6-72b。

**任一门槛不过**：按失败签名走 T-M6-68 补剧本 → 修复 → 重新执行 §5（从 §5.1 预检开始，存档回滚到备份）。

### 5.5 收尾（通过后）

1. 把 `artifacts/soak/<runId>/` 归档到 `docs/evidence/M8-acceptance/`：report.md、summary.json 和截图要保留；存档拷贝太大，不入库，只记路径。
2. `docs/VERIFY.md` 加一行 `[REAL-DEVICE]` 验收记录：commit、存档、模型、7 日指标。
3. README「当前能力边界」把星露谷一行改为「**7 日无人干预验收通过**（日期、commit）」。
4. ROADMAP：T-M6-71 与 T-M6-10 → `DONE`；顶部收敛决策加一句「M8 已验收，可按优先级解冻其他方向」。
5. CHANGELOG 记一条。

---

## 6. 给编码代理的派单模板

每次只派一张工单，把下面这段连同本手册对应章节一起给代理：

```
项目：/Users/jiaqi/Documents/vibe/ai-vtuber-workbench
先读 AGENTS.md、docs/ROADMAP.md「M8 批次」、docs/RUNBOOK-M8-STARDEW.md 第 <N> 节。
只做工单 <T-M6-xx>，不要碰其他工单，业务源码 ≤ 8 个文件。
按手册里的「文件计划 / 关键接口 / 实现步骤」实现，测试写全。
完成标准：pnpm typecheck、pnpm test、pnpm verify:gate 全部通过；
更新 ROADMAP（本工单 DONE、下一张 NEXT）、CHANGELOG。
真机测试步骤（手册里「真机测试」小节）需要真实游戏，做不了就在 VERIFY.md 右栏登记“待真机”，不要伪造 [REAL-DEVICE] 结果。
接口和手册不一致时，以仓库实际代码为准，并在 ROADMAP 决策声明里写明差异。
```
