# V2-P2-06 游戏像素人物流水线（11 步）与 Stardew Avatar Mod 导出验证报告

- **工单**：`V2-P2-06`
- **结论口径**：`DONE`（2026-11-26 已完成 `[REAL-DEVICE]` 真机目视核验，见「三、真机目视核验（2026-11-26 补验）」；此前口径：像素流水线与导出核验契约、纯 Node RGBA PNG 编解码、11 步流水线与候选区审查门禁、`verifyStardewAvatarExport`、C# `WhaleIsleAvatar.dll` 0 警告 0 错误 Release 编译、`verify:gate` 7/7 与全部 4 个 Electron 45 E2E 套件全绿）
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
| 星露谷客户端内实机玩家外观目视核验 | `[REAL-DEVICE]` | 见「三、真机目视核验（2026-11-26 补验）」 | **通过**（`realDeviceInGameVisualVerified` 可置 true） |

## 三、真机目视核验（2026-11-26 补验，`[REAL-DEVICE]`）

**环境**：本机 Steam 星露谷 1.6.15 + SMAPI 4.5.2（4 mods：BlindWhaleFarmer、ConsoleCommands、SaveBackup、WhaleIsleAvatar），在档第1年夏17日 09:30（海滩农场，44297g，体力 268/270），BWF MCP（`http://127.0.0.1:18088/mcp`）实时应答。

**导出产物核验**：`Mods/WhaleIsleAvatar/` 含 `manifest.json`、`WhaleIsleAvatar.dll`（26,112 bytes）、`active-avatar.json`（`characterId: blue-whale-maid`、`spriteTier: 2x`、`hairColor: #3b82f6`、`spriteSheetPath: stardew-sprite-50c65bb7.png`）与贴图本体（192×256，2x 四方向 sprite sheet）。

**截图证据**（`artifacts/acceptance/`，gitignore 不入库）：

| 文件 | 内容 | 判定 |
| --- | --- | --- |
| `P2-06-game-window-2.png` | 博物馆内背面站立帧（面朝上） | 蓝紫长发 + 白蓝女仆装，非默认农夫（棕发绿衣） |
| `P2-06-ingame-avatar-crop4x.png` | 背面帧 4x 放大 | 白色女仆头饰、蓝白裙装与导出贴图背部帧一致，边缘无白底残留 |
| `P2-06-game-window-7.png` | `move_to (7,13)` 后正面帧 | BWF 回执「成功：已到达 (7,13)」，移动落位正常、脚底对齐地板 |
| `P2-06-ingame-avatar-front4x.png` | 正面帧 4x 放大 | 蓝紫长发、女仆头饰、面部腮红、鲸鱼尾巴装饰清晰，与导出贴图正面帧一致 |
| `P2-06-game-window-11.png` | `use_tool watering_can` 浇水动作帧 | 水花特效正常渲染，体力 268→266 与 BWF 回执一致 |
| `P2-06-exported-sprite-preview.png` | 导出贴图 `stardew-sprite-50c65bb7.png` 预览 | 192×256 四方向帧与游戏内形象逐帧一致 |

**一致性佐证**：BWF `get_state`（第1年夏17日 09:30、44297g、ArchaeologyHouse 室内、站 (3,10) 面朝上）与游戏画面 HUD（17日 星期三 09:30 / 44297 / 268/270 / 博物馆场景）逐项吻合，确认截图为该在档游戏的真实渲染画面。

**验收范围（诚实注明）**：目视核验覆盖当前导出的 **2x 档**贴图的正面/背面帧、移动落位与一次浇水工具动作帧；1×/4× 档未逐一进图目视（其 sheet 全帧均已经流水线 `validateSpriteSheet` QA 校验），如需换档导出可复用本次截图比对流程。
