# V2-P2-06 游戏像素人物流水线（11 步）与 Stardew Avatar Mod 导出验证报告

- **工单**：`V2-P2-06`
- **结论口径**：`IMPLEMENTED_UNVERIFIED`（`packages/shared-protocol/src/media.ts` 像素流水线与导出核验契约、纯 Node RGBA PNG 编解码、`PixelAvatarPipelineV2` 11 步流水线与候选区审查门禁、`verifyStardewAvatarExport`、C# `WhaleIsleAvatar.dll` 0 警告 0 错误 Release 编译与 `publish/` 暂存、`verify:gate` 7/7 与全部 4 个 Electron 45 E2E 套件全绿；实机星露谷客户端界面未启动人工目视核验，仍以 `realDeviceInGameVisualVerified: false` 诚实标注并保留待真机目视验收）
- **验证日期**：`2026-11-26`

## 一、实现摘要（严格 5 个业务源码文件）

1. **像素流水线与 Stardew 导出核验契约** [media.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/media.ts)：新增并导出 `PixelPipelineStepSchema`、`PixelSpriteQaReportSchema`、`PixelAvatarJobRequestSchema`、`PixelAvatarJobSnapshotSchema` 与 `StardewAvatarExportVerificationSchema`（固定声明 `realDeviceInGameVisualVerified: false`）。
2. **11 步像素流水线、纯 Node PNG 编解码与 Mod 导出校验** [pixel-avatar-v2.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/pixel-avatar-v2.ts)：
   - `encodeRgbaPng` / `decodeRgbaPng`：基于 Node 内置 `node:zlib` 与 IEEE CRC32 实现无原生依赖的 8-bit RGB/RGBA PNG 编解码（支持 Filter 0–4 反滤波与畸形块拦截）；
   - `PixelAvatarPipelineV2`：贯通 ① 目标游戏网格规格（1×/2×/4×）→ ② `CharacterBibleStore` + `compileStardewSpritePrompt` 一致性锁定 → ③ 源 PNG 解码 → ④ 四向连通去白底 → ⑤ 4×6 投影切格 → ⑥ 全局等比脚底对齐缩放 → ⑦ 轮廓白晕清理 → ⑧ 档位调色板收敛 → ⑨ `validateSpriteSheet` 与空帧超限 QA 写盘 → ⑩ SHA-256 溯源与 `evaluateAssetDistributionPolicy` 许可门禁 → ⑪ 审批后原子导出至 `Mods/WhaleIsleAvatar`（支持单人主目录与联机隔离 profile）；
   - `verifyStardewAvatarExport`：校验证书 `manifest.json`（`WhaleIsle.AvatarSync`）、`WhaleIsleAvatar.dll` 与仓库 `publish/` 哈希比对、`active-avatar.json` Schema、防路径穿越及贴图尺寸与 `spriteTier` 一致性。
3. **宿主 5 路 V2 IPC 接线** [v2-kernel-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/preload/index.ts)、[bridge.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/bridge.ts)：挂载 `v2:pixel-jobs` / `v2:pixel-run` / `v2:pixel-review` / `v2:pixel-export-stardew` / `v2:pixel-verify-stardew`。

## 二、实测命令与结果

| 检查项 | 证据等级 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| `WhaleIsleAvatar` C# SMAPI Mod 编译与暂存 | `[E2E-HOST]` 构建产物 | `dotnet build mods/stardew-avatar-sync/WhaleIsleAvatar.csproj -c Release -nologo && node tools/scripts/build-avatar-mod.mjs` | **0 Warning / 0 Error**（1.20s），`WhaleIsleAvatar.dll`（26,112 bytes）暂存至 `mods/stardew-avatar-sync/publish/` |
| 11 步像素流水线、PNG 编解码与隔离 Mods 导出核验 | `[SIMULATION]` + 真实 DLL 核验 | `pnpm exec vitest run --coverage.enabled=false apps/desktop-host/src/main/pixel-avatar-v2.spec.ts` | **4/4 PASS**（217ms，覆盖 `1x/2x/4x`、候选审批拦截、单人与联机 profile 导出、真实 DLL SHA-256 匹配校验） |
| 宿主编译与前端资源构建 | `[E2E-HOST]` | `pnpm --filter @workbench/desktop-host build` | exit 0（CSS 87ms） |
| 仓库全量自动化门禁 | `[SIMULATION]` + 静态门禁 | `pnpm verify:gate` | **7/7 PASS**（279 源文件 0 违规 / 全局覆盖率 ≥90% / Gate 4 0.4s） |
| Electron 45 E2E（含 `v2PixelJobs` / `v2PixelVerifyStardew`） | `[E2E-HOST]` | `PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts ...` | Part 1 **3/3 PASS**（6.41s）+ Part 2 `ui.e2e` **8/8 PASS**（19.07s） |
| 星露谷客户端内实机玩家外观目视核验 | `[REAL-DEVICE]` | 本机 Steam `Mods/WhaleIsleAvatar` 存在但未启动 GUI 游戏进图实拍 | **UNVERIFIED**（`realDeviceInGameVisualVerified: false`，待人类进星露谷查看 1×/2×/4× 贴图与持物动画对齐） |
