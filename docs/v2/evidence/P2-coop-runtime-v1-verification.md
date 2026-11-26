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
