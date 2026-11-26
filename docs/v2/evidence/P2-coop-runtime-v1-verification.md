# V2-P2-08 真实星露谷人机联机协作（`CoopRuntime` v1）验证报告

- **工单**：`V2-P2-08`
- **结论口径**：`IMPLEMENTED_UNVERIFIED`（`@workbench/shared-protocol/coop` 联机契约、`@workbench/game-bridge-mcp/coop-runtime` 任务板/防误卖资源预留/独立控制租约/Mod 兼容检查/断线宽限与防死锁超时恢复、8 路 V2 IPC、`verify:gate` 7/7 与全部 4 个 Electron 45 E2E 套件（含真实本机 `/Users/jiaqi/.../Mods` 扫描 `v2CoopModCompat`）全部实测通过；双端真实《星露谷》+ SMAPI 客户端开房联机协同游玩仍待 `[REAL-DEVICE]` 验证）
- **验证日期**：`2026-11-26`

## 一、实现摘要（严格 7 个业务源码文件）

1. **联机协作契约** [coop.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/coop.ts) & [index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/index.ts)：新增并导出 `CoopRoomStatusSchema`、`CoopConnectionStateSchema`、`CoopParticipantSchema`、`CoopTaskItemSchema`、`CoopResourceReservationSchema`、`CoopModCompatibilityReportSchema`、`CoopRuntimeSnapshotSchema`。
2. **`CoopRuntimeV1` 核心运行时与 Mod 兼容检查** [coop-runtime.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/game-bridge-mcp/src/coop-runtime.ts) & [game-bridge-mcp/src/index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/game-bridge-mcp/src/index.ts)：
   - **成员独立控制租约**：人类房主（`human`）与 AI 队友（`ai`）各自持有独立 `GameCharacterControlLease`，互不争抢角色操作权限；P0 全局急停联动一键锁死全部 AI 成员；
   - **Task Board（`proposed → accepted → running → completed | failed | blocked`）**：原子抢占全部 `resourceLocks`（部分失败自动回滚释放），支持 `handoffTask` 释放旧锁移交队友，并严格依据 `COMPLETED | FAILED | UNCERTAIN` 真实回执推进（`UNCERTAIN` 转 `blocked` 而非伪造完成）；
   - **重要资源预留与防误卖保护**：人类标记 `sell_forbidden` / `keep` 的作物/物品无论是否同队均禁止触发 `sell` 动作，TTL 到期自动释放；
   - **多人 Mod 兼容检查**：`evaluateCoopModsCompatibility` 检测 AI 端 BWF 就绪度、版本冲突、启停差异与 `WhaleIsle.AvatarSync` 外观可见性差异警告；
   - **断线恢复与防死锁**：心跳超时进入 `reconnecting` 宽限期（暂停 AI 写入并暂留资源锁），宽限期内重连推进租约世代淘汰旧指令，超时进入 `offline` 自动释放全部锁并将 `running` 任务置 `blocked` 供队友接管。
3. **宿主 8 路 V2 IPC 接线与实盘 Mods 扫描** [v2-kernel-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/preload/index.ts)、[bridge.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/bridge.ts)：挂载 `v2:coop-{snapshot,room-create,participant-join,task-action,resource-reserve,resource-check,mod-compat,recovery}` 并与 `v2:emergency-halt` 联动。

## 二、实测命令与结果

| 检查项 | 证据等级 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| `CoopRuntimeV1` 单测与分支覆盖 | `[SIMULATION]` | `pnpm exec vitest run --coverage.include='packages/game-bridge-mcp/src/coop-runtime.ts' packages/game-bridge-mcp/src/coop-runtime.spec.ts` | **5/5 PASS**（100% Stmts/Funcs/Lines，90% Branch） |
| 宿主编译与前端资源构建 | `[E2E-HOST]` | `pnpm --filter @workbench/desktop-host build` | exit 0（CSS 45ms） |
| 仓库全量自动化门禁 | `[SIMULATION]` + 静态门禁 | `pnpm verify:gate` | **7/7 PASS**（282 源文件 0 违规 / 全局覆盖率 ≥90% / Gate 4 0.4s） |
| Electron 45 E2E（含人机分工、防误卖、任务回执、掉线重连与本机真实 Mods 兼容扫盘） | `[E2E-HOST]` | `PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts ...` | Part 1 **3/3 PASS** + Part 2 `ui.e2e` **8/8 PASS**（20.09s） |
| 双端真实《星露谷》+ SMAPI 联机开房协同实玩 | `[REAL-DEVICE]` | 待启动双实例星露谷客户端建立联机房间并协同完成一日种地/收获 | **UNVERIFIED**（缺真实双端游戏运行期验收） |

---

## 三、2026-11-26 真机补验（宿主 IPC 层 `[REAL-DEVICE]`）

> **范围声明（诚实口径）**：本节是在**真实运行的 Electron 宿主**里驱动 `CoopRuntimeV1` 的 8 路 V2 IPC，验证宿主接线与运行时行为**真实可用**；
> 它**不等于**「双端真实《星露谷》客户端联机开房协同实玩」——后者需要第二台机器或第二个 Steam 账号（见第 4 节），本机不具备。

### 3.1 本机前置盘点

| 项 | 实测 |
| --- | --- |
| 星露谷安装 | `~/Library/Application Support/Steam/steamapps/common/Stardew Valley`（macOS 版，`Contents/MacOS/Mods`） |
| 本机 Mods | 4 个：`BlindWhaleFarmer`、`WhaleIsleAvatar`、`ConsoleCommands`、`SaveBackup` |
| BWF Mod | `Darian.BlindWhaleFarmer` v1.1.27，MinimumApiVersion 4.0.0，无依赖 |
| Avatar Mod | `WhaleIsle.AvatarSync` v0.3.0-dev.1，MinimumApiVersion 4.0.0 |
| Steam 登录账号 | **仅 1 个**（`userdata/395340529`），无第二账号 |

### 3.2 8 路 V2 IPC 真机全链路实测（逐项通过）

在真实 Electron 宿主（CDP `127.0.0.1:9333`）逐路调用并断言行为：

| IPC | 实测输入 | 实测结果 |
| --- | --- | --- |
| `v2CoopRoomCreate` | `gameId=stardew` + 共享目标 | `ok=true`，`roomId=coop-79a29614` |
| `v2CoopParticipantJoin` ×2 | `human` 房主 + `ai` 队友 | 双双 `ok=true`，`p-human-1` / `p-ai-1` 均 `connected` |
| `v2CoopTaskAction` `propose` | AI 提议「种下春季作物」，锁 `tile:10:20` | `ok=true`，`taskId=task-598289ad`，`status=proposed` |
| `v2CoopTaskAction` `accept` → `start` | 同上 taskId | `accepted` → **`running`**，`resourceLocks=['tile:10:20']` 保留 |
| `v2CoopResourceReserve` | 房主把 `crop:parsnip:batch-1` 标 `keep` | `ok=true`，预留生效 |
| `v2CoopResourceCheck` `sell` | AI 试图出售该作物 | **`allowed=false`**：「已阻断出售：crop:parsnip:batch-1 已被 p-human-1 标记为保留/禁售（房主标记留种）」 |
| `v2CoopResourceCheck` `use` | AI 试图占用该作物 | **`allowed=false`**：「资源冲突：crop:parsnip:batch-1 正由 p-human-1 占用（keep）」 |
| `v2CoopTaskAction` `outcome` | 回执 **`UNCERTAIN`**（寻路被石头挡住） | `ok=true`，`status=**blocked**` —— **未伪造为 completed**（真实执行回执铁律） |
| `v2CoopRecovery` `disconnect` → `reconnect` | 模拟网络抖动 | `connected` → **`reconnecting`** → **`connected`** |
| `v2CoopModCompat` | 扫本机真实 Mods 目录 | `compatible=true`、`canStartCoop=true`、`hostModCount=4`、`peerModCount=4`、`bwfReady=true`、`avatarSyncReady=true`、`mismatches=[]`、`warnings=[]` |
| `v2CoopSnapshot` | 最终快照 | `roomId=coop-79a29614`、`status=**active**`、`sharedGoal` 原样回显、participants 2 名 `connected`、tasks 1 条 `status=blocked` 且锁仍在、reservations 1 条 `keep` |

**注**：`v2CoopModCompat` 此次 host 与 peer 指向**同一目录**（本机仅此一份 Mods），因此 `mismatches` 必然为空——这只证明**扫描与比对逻辑在本机真实目录上跑得通**，不构成「双端 Mod 集合一致」的结论。

## 四、真机双端联机仍缺的前置（需 owner 提供）

1. **第二台机器或第二个 Steam 账号**：本机 `userdata` 只有 1 个账号，无法在同一台机器上以两个客户端进同一联机农场（Steam 默认禁止同游戏多实例）。
2. **联机农场内的 farmhand 槽位**：需要房主端在游戏内「添加/管理农场工」并让 AI 端以 farmhand 身份加入，才能验证 `WhaleIsle.AvatarSync`「仅替换本端玩家」在双端下的外观差异（`evaluateCoopModsCompatibility` 已具备该差异告警能力，但**尚无真实差异样本**）。
3. **BWF 在 farmhand 身份下的行为**：需实测 AI 作为非房主玩家时 BWF MCP 的动作回执（寻路/用工具是否仍以真实回执返回），当前所有 BWF 实测均为**单客户端房主**场景。

> 上述均为外部账号/设备前置，Agent 无法自行获取；已按调度要求单列清单报 owner，不阻塞其余工单推进。
