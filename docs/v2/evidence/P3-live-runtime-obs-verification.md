# P3-02 实测证据 — `LifeRuntime` 驱动的直播中控与 OBS 舞台（`V2-P3-02`）

> **关联需求**：`REQ-LIVE-01`（由 `LifeRuntime` 驱动的直播中控、平台适配器、弹幕护栏、礼物合并、点歌版权门禁与 OBS 舞台同步）  
> **诚实结论口径**：**`IMPLEMENTED_UNVERIFIED`** —— 共享契约、`LiveRuntimeV2`（复用 `LiveEventHub`）、`checkLivestreamSongRights` 四重版权拦截、`probeLivePlatformEndpoint` 诚实断连/降级探测、礼物合并感谢、OBS 舞台投影与场次摘要、7 路 `v2:live-*` IPC、Tidepaper 中控面板、`verify:gate` 7/7 及 Electron 45 全量 E2E 均已实测通过；因尚未接入真实抖音/B站/YouTube 线上测试直播间开播收流，按宪章标记 `IMPLEMENTED_UNVERIFIED`。

---

## 1. 本次修改清单（业务源码恰好 8 个，符合 ≤ 8 铁律）

| 文件 | 职责与交付 |
| --- | --- |
| [packages/shared-protocol/src/live.ts](../../../packages/shared-protocol/src/live.ts) | 新增 `LivePlatformId`、`LiveConnectionState`、`LivePlatformAdapterStatus`、`LiveSongQueueItem`、`LiveGiftThankBatch`、`LiveObsStagePayload`、`LiveSessionSummary`、`LiveRuntimeSnapshot` 与请求入参契约 |
| [packages/shared-protocol/src/index.ts](../../../packages/shared-protocol/src/index.ts) | 导出 `./live` |
| [packages/live-stream-hub/src/live-runtime.ts](../../../packages/live-stream-hub/src/live-runtime.ts) | 实现 `checkLivestreamSongRights`、`probeLivePlatformEndpoint` 与 `LiveRuntimeV2`（弹幕过滤/去重、礼物/进场/点赞合并感谢、曲库版权排麦、`popNextAuthorizedSong`、OBS 舞台同步与下播总结） |
| [packages/live-stream-hub/src/index.ts](../../../packages/live-stream-hub/src/index.ts) | 导出 `live-runtime` |
| [apps/desktop-host/src/main/v2-kernel-host.ts](../../../apps/desktop-host/src/main/v2-kernel-host.ts) | 注册授权/NC 示例曲库，接入 `v2:live-*` 7 路 IPC，并联动 `CharacterCore` 活动态、`PerformanceDirector`、`StageRuntime` 与 P0 急停 |
| [apps/desktop-host/src/preload/index.ts](../../../packages/desktop-host/src/preload/index.ts) | 暴露 7 路 `v2Live*` Preload API |
| [apps/desktop-host/src/renderer/director/bridge.ts](../../../apps/desktop-host/src/renderer/director/bridge.ts) | 补全 `DirectorBridge` 强类型接口 |
| [apps/desktop-host/src/renderer/director/views/life-console-view.tsx](../../../apps/desktop-host/src/renderer/director/views/life-console-view.tsx) | 接入 `V2-P3-02` 直播中控开关、下播归档与公开直播点歌版权拦截测试控件 |

测试文件：`packages/live-stream-hub/src/live-runtime.spec.ts`、`apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`。

---

## 2. 实测命令与结果（2026-11-26 现场执行）

- `pnpm typecheck` & `pnpm --filter @workbench/desktop-host build`：退出码 `0`
- `pnpm exec vitest run packages/live-stream-hub/src/live-runtime.spec.ts --coverage.include='packages/live-stream-hub/src/live-runtime.ts'`：
  - **3/3 PASS**（`live-runtime.ts`：**99.09% Stmts / 91.66% Branch / 100% Funcs / 100% Lines**）
- `pnpm verify:gate`：**7/7 PASS**（`license-scanner` 286 个源文件 0 违规，全仓单测 ≥90% 分支覆盖、Python/Lua 检查与 Gate 4 回环均通过）
- Electron 45 E2E Part 1（`desktop.e2e.spec.ts`、`v2-kernel.e2e.spec.ts`、`v2-obsidian-ui.e2e.spec.ts`）：**3/3 PASS**
  - `v2-kernel.e2e.spec.ts` 实测 `douyin_dyhub` 无真实端点降级 (`degraded`, `realPlatformVerified: false`)、拦截 `dev_only_non_commercial` 点歌、放行 `鲸屿晨雾` 并自动驱动 `PerformanceDirector` 开唱、OBS 舞台同步弹幕/礼物批次/歌曲与下播总结统计。
- Electron 45 E2E Part 2（`ui.e2e.spec.ts`）：**8/8 PASS**

---

## 3. 尚未完成的真机实测缺口（`IMPLEMENTED_UNVERIFIED` 原因）

1. **真实线上直播平台测试账号收流验证 `[REAL-DEVICE]`**：抖音（dyhub 桥接）、Bilibili 开放平台、YouTube Live 真实测试直播间的弹幕、礼物、关注与风控官方能力仍待申请真实房间权限并逐项开播实测。
2. **OBS Browser Source 真实推流观感验证 `[REAL-DEVICE]`**：OBS 真实场景叠加与虚拟声卡路由待连入真实 OBS Studio 客户端开播复核。
