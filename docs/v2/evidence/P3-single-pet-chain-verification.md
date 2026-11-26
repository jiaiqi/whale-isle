# 单桌宠全链路 E2E（启动 → 就绪 → 动作 → 回执 → 记忆）

> 证据等级：**`[E2E-HOST]` + `[SIMULATION]`**。真实 Electron 45 宿主 + 真实 IPC/preload + 真实 `AutodriveRunner`，
> 但游戏侧是 mock-harness 的活农场仿真，**不是** `[REAL-DEVICE]`；不得据此宣称真机通过。

## 1. 这条剧本补的是什么

此前各子系统分别有测试：`ui.e2e`（界面/租约）、`v2-kernel.e2e`（内核/语音）、`rule-7day` 与 `stuck-regressions`（`AutodriveRunner` + 农场仿真）。
但没有一条测试把「一个桌宠从点启动到留下记忆」串起来，也没有「宿主指向仿真 BWF」的能力——`autodrive` 只能连真实游戏端口。

本次补两块：

1. **宿主侧测试端点**：`index.ts` 在 `PET_STAGE_E2E=1` 时读取 `WHALE_E2E_BWF_ENDPOINT`，经 `resolveBwfEndpoint()`（`bwf-settings.ts`）决定 autodrive 连哪里；生产恒为 `undefined`，回落真实端口。端口联动回调在注入端点时不再覆盖（否则会被真实 `bwfMcpPort` 改回去）。
2. **单一剧本 E2E**：`apps/desktop-host/e2e/single-pet-chain.e2e.spec.ts`，在测试进程里起 `startBwfFarmSim()`（seed 11、12 株成熟草莓、12 格已开垦），把端点经 env 交给 Electron。

## 2. 剧本与断言（全部走真实 IPC/事件流，不碰 bubble 内部实现）

| 步骤 | 做法 | 断言 |
| --- | --- | --- |
| ① 启动 | 固定到星露谷共玩页并清掉历史「自动启动」勾选 → 点顶栏「启动」→ 提示里勾选「以后自动启动」→ 确认 | `[data-stardew-launch-prompt]` 出现并可确认（假启动器，`PET_STAGE_E2E`） |
| ② 就绪 | 切 `plannerSwitch('rule')`（不需要任何模型 Key） | `autodriveStatus().running === true` |
| ③ 动作 | 宿主 ping 与执行都打到仿真端点 | 仿真 `get_state` ≥1 次，且**非 `get_state` 的真实工具调用 ≥1 次** |
| ④ 回执 | 订阅 `onAutodriveEvent` | 至少 1 条 `receipt`（`tool !== 'autodrive'`），`status ∈ {COMPLETED, FAILED, UNCERTAIN}` 且 `summary` 非空 |
| ⑤ 记忆 | 用该回执摘要作为查询 | `v2MemoryQuery(q).hits.length > 0`（回执确经 `memoryHost.onReceipt` 落盘且可检索） |
| ⑥ 停 | `autodriveStop()` | `running === false` |

> 关键坑（已写进 spec 注释）：确认启动后 `start()` 会**再次**检查游戏健康；若提示里不勾「以后自动启动」，会再次弹回提示、runner 永远不启动。这一步不勾，测试会以 `running=false` 超时失败——第一版就是这么挂的。

## 3. 本机实跑

```
pnpm --filter @workbench/desktop-host build
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/single-pet-chain.e2e.spec.ts
→ Test Files 1 passed (1) / Tests 1 passed (1) / Duration 6.22s
```

已加入 `.github/workflows/ci.yml` 的 macOS Electron E2E 列表，CI 每次都会跑。

## 4. 能证明什么、不能证明什么

- **能**：宿主在「游戏不存在」的条件下，从 UI 启动开始，能连上 BWF 兼容服务、跑规则大脑、拿到真实三态回执、把回执写进记忆并被检索——这条链路本身没有断点。
- **不能**：不能证明真实《星露谷物语》+ SMAPI + BWF Mod 下同样成立（那属 `[REAL-DEVICE]`，已有 `soak:autodrive` 与真机验收清单）；也不能证明 LLM 大脑路径（本剧本用规则大脑，避免依赖 Key）。
- 仿真只覆盖 BWF 工具语义的一个子集；真实 Mod 的返回文案漂移仍要靠真机浸泡发现问题。

## 5. 待办（不在本单）

- LLM 大脑路径的同类剧本：需要可控的假模型网关，另立工单。
- 语音锁释放与桌宠气泡投影未纳入本剧本（气泡实现由 item 7 的 `threadfin` worktree 负责，避免冲突）。
