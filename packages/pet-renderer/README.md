# packages/pet-renderer — 渲染抽象层

> 状态：**M1 引擎已落地**（对应工单 `T-M1-01`，2026-11-15）｜ [SPEC §3.1](../../docs/SPEC.md)

## 职责

- `IPetAvatarRenderer` 可插拔渲染接口（预留 `Live2DRenderer`、`SpriteSheetRenderer` 扩展位）。
- `WebmVideoRenderer`：Chromium 原生 VP9-Alpha `.webm` 双 `<video>` 无缝交叉淡入（消除动作切换黑帧/闪白）、脚底基准线对齐、落地 Q 弹挤压形变（Squash & Stretch）、多显示器异构 DPI 边界碰撞。
- 资产清单 `manifest.json` 管理；内置素材强制挂载 `DEV_ONLY_NON_COMMERCIAL` 标记（Gate 2 / T-M1-01 断言）。

## 边界（dependency-cruiser 强制）

- ❌ 禁止 import `model-gateway` / `persona-brain` / `live-stream-hub` / `game-bridge-mcp` 的实现；仅允许依赖 `@workbench/shared-protocol` 的契约类型。
- ❌ 禁止直接调用 LLM API、SQLite、外部网络。

## 依赖方向

`pet-renderer` 只被 `apps/desktop-host`（pet-stage 渲染进程）组装调用。
