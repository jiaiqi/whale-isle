# CURRENT — V2 跨会话唯一交接检查点

> 任何新 AI 会话接手前只看本文件与 [ROADMAP.md](./ROADMAP.md)，严禁依赖对话历史猜测进度。每次完成或阻塞工单时必须同步更新。

## 1. 当前进度锚点

- **当前分支**：`feat/whale-isle-v2`（P0 & P1 全部核心工单已交付；P2 `V2-P2-01`..`V2-P2-06` 已交付为 `IMPLEMENTED_UNVERIFIED` 或部分 `DONE`）
- **上一已完成/交接工单**：`V2-P2-06` — **游戏像素人物流水线与 Stardew Avatar Mod 导出真机验证**（状态：`IMPLEMENTED_UNVERIFIED`）
- **当前唯一激活 `NEXT` 工单**：**`V2-P2-07` — `AssetRegistry`、舞台/场景/声音资产创作与版本回滚**（10 态资产发布、Hash 校验、非商业阻断与一键回滚）
- **同步 UI/设计基准约束（`ADR-003`）**：[design/tidepaper/](../../design/tidepaper/) 为 V2 首选 UI/UX 参考基线（`SPEC.md` + 25 页原型），Obsidian Tide / Tide Deep / Obsidian v4 保留为可选主题；渐进落地时须保留现有 React/IPC 真实绑定与诚实阶段标注。

## 2. 本次 `V2-P2-06` 实际交付与验证证据

- **契约先行** [packages/shared-protocol/src/media.ts](../../packages/shared-protocol/src/media.ts)：新增 `PixelPipelineStepSchema`、`PixelSpriteQaReportSchema`、`PixelAvatarJobRequestSchema`、`PixelAvatarJobSnapshotSchema`、`StardewAvatarExportVerificationSchema`。
- **核心流水线与核验器** [apps/desktop-host/src/main/pixel-avatar-v2.ts](../../apps/desktop-host/src/main/pixel-avatar-v2.ts)：
  - `encodeRgbaPng` / `decodeRgbaPng`：纯 Node（`node:zlib` + CRC32）8-bit RGB/RGBA PNG 编解码（支持 Filter 0–4）；
  - `PixelAvatarPipelineV2`：贯通完整 11 步像素流水线（游戏网格锁定 → CharacterBible 一致性提示编译 → PNG 解码 → 去白底 → 4×6 投影切格 → 全局等比脚底对齐 → 轮廓白晕清理 → 档位调色板收敛 → 精灵表 QA → SHA-256 溯源与非商用隔离 → 候选审批后原子导出至 `WhaleIsleAvatar`）；
  - `verifyStardewAvatarExport`：核验 `manifest.json`、`WhaleIsleAvatar.dll`（与仓库 `publish/` 哈希比对）、`active-avatar.json`、防路径穿越及贴图与 `spriteTier` 尺寸一致性（诚实固定 `realDeviceInGameVisualVerified: false`）。
- **宿主接线**：[v2-kernel-host.ts](../../apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](../../apps/desktop-host/src/preload/index.ts)、[bridge.ts](../../apps/desktop-host/src/renderer/director/bridge.ts) 接入 `v2:pixel-{jobs,run,review,export-stardew,verify-stardew}` 5 路 IPC。
- **真实验证**：`dotnet build` & `build-avatar-mod.mjs` 0 警告 0 错误暂存 `WhaleIsleAvatar.dll`、`pixel-avatar-v2.spec.ts` **4/4 PASS**、`desktop-host build` exit 0、`pnpm verify:gate` **7/7 PASS**、Electron 45 E2E Part 1 **3/3 PASS** + Part 2 `ui.e2e` **8/8 PASS**，详见证据 [P2-pixel-stardew-avatar-verification.md](./evidence/P2-pixel-stardew-avatar-verification.md)。
- **为什么不是 `DONE`**：尚未由人类在星露谷客户端内实机启动进图并目视确认 1×/2×/4× 贴图与手持工具帧表现（`realDeviceInGameVisualVerified: false`）。

## 3. 下一步行动（Next Agent 从这里接手）

1. 检查并认领 **`V2-P2-07`（`AssetRegistry`、舞台/场景/声音资产创作与版本回滚）**：先查阅 `packages/shared-protocol/src/media.ts`、`apps/desktop-host/src/main/{character-studio-v2.ts,pixel-avatar-v2.ts,media-gateway.ts,pipeline-3d.ts}` 与 `docs/v2/blueprint/06-AI创作工坊与资产流水线.md`（十态资产全生命周期、版本回滚、商业发布清源门禁），设计并落地统一持久化的十态 `AssetRegistry`、版本快照与一键回滚、舞台背景/音效资产创作包验证与导出清源检查。
2. 保持原子工单约束（单次修改 ≤ 8 个业务源码文件），全部验证通过并提交后自动推进至 `V2-P2-08`。
