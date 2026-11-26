# V2-P2-07 `AssetRegistry`、舞台/场景/声音资产创作与版本回滚验证报告

- **工单**：`V2-P2-07`
- **结论口径**：`DONE`（本工单为纯本地十态资产治理、SHA-256 快照防篡改、商业清源过滤与本地舞台/音效创作质检底座，不依赖外部云端或真实游戏客户端；已在单元测试、`pnpm verify:gate` 7/7（全局覆盖率 ≥ 90%）与全部 4 个 Electron 45 真实宿主 E2E 套件中完成全链路闭环验证）
- **验证日期**：`2026-11-26`

## 一、实现摘要（严格 5 个业务源码文件）

1. **统一十态资产仓库与音画质检契约** [media.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/media.ts)：新增并导出 `AssetRegistryCategorySchema`（9 类资产）、`StageSceneInspectionSchema`、`SoundAssetInspectionSchema`、`AssetVersionRecordSchema`、`AssetRegistryEntrySchema`、`AssetIntegrityCheckSchema`、`CommercialCleanExportResultSchema`。
2. **十态 `AssetRegistryV2` 与舞台/声音工坊** [asset-registry-v2.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/asset-registry-v2.ts)：
   - **舞台/桌面背景创作与质检**：`inspectStageSceneAsset`（PNG/WebP/JPG 魔数、PNG 宽高与宽高比、720p HD 门槛警告）与 `createProceduralStageScenePng`（3 套原创海洋/舞台主题渐变 PNG）；
   - **声音/音效创作与质检**：`inspectAudioAsset`（RIFF/WAVE `fmt `/`data` 块解析、真实采样率/声道/位深/时长/16-bit 峰值削波检测 + OGG/MP3/M4A 魔数嗅探）与 `synthesizeSfxWav`（5 档原创 16-bit PCM WAV 防削波合成）；
   - **十态版本库、防篡改与一键回滚**：`AssetRegistryV2` 将每个版本拷贝至 `<userData>/asset-registry/snapshots/<assetId>/<versionId>/` 不可变快照目录，`transitionStatus` 门禁禁止 `validation_failed` 审批/发布，`verifyIntegrity` 检出文件缺失/字节篡改并阻断发布/回滚，`rollbackAsset` 一键将当前版置 `deprecated`（附 `rolled_back` 审计记录）并恢复目标历史版本为 `published` 激活；
   - **商业/直播清源打包过滤**：`exportCleanBundle` 复用 `evaluateAssetDistributionPolicy` 与 SHA-256 校验，严禁未发布、篡改或 `CC BY-NC-SA 4.0` / `DEV_ONLY` 资产进入商业/直播导出目录，并写出审计清单 `export-manifest.json`。
3. **宿主 9 路 V2 IPC 接线** [v2-kernel-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/preload/index.ts)、[bridge.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/bridge.ts)：挂载 `v2:asset-{list,get,register,transition,verify,rollback,export-clean}`、`v2:stage-scene-create`、`v2:sound-sfx-create`。

## 二、实测命令与结果

| 检查项 | 证据等级 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| 舞台背景/音效合成、十态治理、篡改拦截、清源导出与一键回滚单测 | `[SIMULATION]` | `pnpm exec vitest run --coverage.enabled=false apps/desktop-host/src/main/asset-registry-v2.spec.ts` | **3/3 PASS**（62ms） |
| 宿主编译与前端资源构建 | `[E2E-HOST]` | `pnpm --filter @workbench/desktop-host build` | exit 0（CSS 51ms） |
| 仓库全量自动化门禁 | `[SIMULATION]` + 静态门禁 | `pnpm verify:gate` | **7/7 PASS**（280 源文件 0 违规 / 全局分支覆盖率 ≥90% / Gate 4 0.4s） |
| Electron 45 E2E（含 v1→v2→回滚→SHA-256→商业清源阻断全链路） | `[E2E-HOST]` | `PET_STAGE_E2E=1 pnpm exec vitest run --config vitest.e2e.config.mts ...` | Part 1 **3/3 PASS** + Part 2 `ui.e2e` **8/8 PASS**（27.56s） |
