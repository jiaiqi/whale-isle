# CURRENT — V2 跨会话唯一交接检查点

> 任何新 AI 会话接手前只看本文件与 [ROADMAP.md](./ROADMAP.md)，严禁依赖对话历史猜测进度。每次完成或阻塞工单时必须同步更新。

## 1. 当前进度锚点

- **当前分支**：`feat/whale-isle-v2`（P0 & P1 全部核心工单已交付；P2 `V2-P2-01`..`V2-P2-05` 已交付为 `IMPLEMENTED_UNVERIFIED` 或部分 `DONE`）
- **上一已完成/交接工单**：`V2-P2-05` — **Character Bible、2D/Live2D 创作与 CrossPet 全量合法导入**（状态：`IMPLEMENTED_UNVERIFIED`）
- **当前唯一激活 `NEXT` 工单**：**`V2-P2-06` — 游戏像素人物流水线与 Stardew Avatar Mod 导出真机验证**（11 步像素流水线 + `stardew-avatar-sync` 导出与游戏内外观核验）
- **同步UI/设计基准约束（`ADR-003`）**：[design/tidepaper/](../../design/tidepaper/) 为 V2 首选 UI/UX 参考基线（`SPEC.md` + 25 页原型），Obsidian Tide / Tide Deep / Obsidian v4 保留为可选主题；渐进落地时须保留现有 React/IPC 真实绑定与诚实阶段标注。

## 2. 本次 `V2-P2-05` 实际交付与验证证据

- **契约先行** [packages/shared-protocol/src/media.ts](../../packages/shared-protocol/src/media.ts)：新增 `CharacterBibleUpsertRequestSchema`、`CharacterBibleAttachRefRequestSchema`、`Live2dLayerRoleSchema`、`Live2dAssetInspectionSchema`、`AssetDistributionChannelSchema`、`LicenseDistributionCheckSchema`、`Asset2dStudioPackageSchema`、`CrossPetImportRequestSchema`、`CrossPetImportedEntrySchema`、`CrossPetImportResultSchema`。
- **核心引擎与合规导入** [apps/desktop-host/src/main/character-studio-v2.ts](../../apps/desktop-host/src/main/character-studio-v2.ts)：
  - `CharacterBibleStore`：持久化 `<userData>/character-bibles/`、参考图 QA 与候选区审批晋升（联动 `MediaGenerationGateway`）；
  - `inspectLive2dOrLayered2d`：Cubism `model3.json`/`.moc3`/纹理/`cdi3.json`/口型 `LipSync` 与 2D 分层包质检 + 路径防穿越；
  - `evaluateAssetDistributionPolicy`：`CC BY-NC-SA 4.0` / `DEV_ONLY` / 未审图本机个人允许且附署名，公开直播/商用/再分发全链路硬阻断；
  - `CharacterStudioV2.importCrossPetPack`：真实扫描并合法导入随包 `assets/pet-packs/crosspet/characters` 全部 30 角色（8 基础 + 7 皮肤 + 15 彩蛋），写入 `.provenance.json`、注册 2D 包并绑定 8 个基础 Character Bible。
- **宿主接线**：[v2-kernel-host.ts](../../apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](../../apps/desktop-host/src/preload/index.ts)、[bridge.ts](../../apps/desktop-host/src/renderer/director/bridge.ts) 接入 10 路 V2 IPC。
- **真实验证**：`character-studio-v2.spec.ts` **5/5 PASS**（含真实 30 角色全量导入）、`desktop-host build` 0 错误、`pnpm verify:gate` **7/7 PASS**、Electron 45 E2E Part 1 **3/3 PASS** + Part 2 `ui.e2e` **8/8 PASS**，详见证据 [P2-character-studio-crosspet-verification.md](./evidence/P2-character-studio-crosspet-verification.md)。
- **为什么不是 `DONE`**：真机外部 Cubism Live2D `.moc3` 舞台切换与在线 AI 生图 2D 分层实产尚未真机验证（Live2D 运行时渲染器与舞台统一切换将于 `V2-P3-01` 落地）。

## 3. 下一步行动（Next Agent 从这里接手）

1. 检查并认领 **`V2-P2-06`（游戏像素人物流水线与 Stardew Avatar Mod 导出真机验证）**：先读取 `apps/desktop-host/src/main/pixel-sprite-pipeline.ts`、`apps/desktop-host/src/main/stardew-avatar-host.ts`、`mods/stardew-avatar-sync/` 与 `docs/v2/blueprint/06-AI创作工坊与资产流水线.md` 像素节，先核实本机是否有 `stardew-avatar-sync` 产物与星露谷 Mods 目录，按原子工单（≤8 业务文件）完善 11 步像素流水线 QA、Character Bible 联动与 `stardew-avatar-sync` 导出闭环（若缺真实星露谷客户端则诚实标为 `IMPLEMENTED_UNVERIFIED` 并附编译/导出/单测/E2E 实证）。
2. 每完成一个工单后保持 `pnpm verify:gate` 7/7、Electron 45 E2E 全绿，并同步更新 V2 文档矩阵。
