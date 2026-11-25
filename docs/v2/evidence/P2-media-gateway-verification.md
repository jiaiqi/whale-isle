# V2-P2-03 `MediaGenerationGateway` 与图片生成流水线验证报告

- **工单**：`V2-P2-03`
- **结论口径**：`IMPLEMENTED_UNVERIFIED`（十态资产契约、Character Bible 一致性提示编译、诚实供应商能力探测、候选区审查隔离与持久化、`verify:gate` 7/7 与全部 4 个 Electron 45 E2E 套件实测通过；真实在线图片 Key / 本机已登录 Codex 生图出图联调待 `[REAL-DEVICE]` 实机验证）
- **验证日期**：`2026-11-26`

## 一、实现摘要（严格 6 个业务源码文件）

1. **媒体网关、Character Bible 与十态资产溯源契约** [media.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/media.ts) & [index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/packages/shared-protocol/src/index.ts)：新增并导出 Blueprint 06 十态管线（`draft..restricted`）、`MediaProviderCapabilitySchema`、`CharacterBibleSchema`（含三视图 `referenceImages`、`traits`、`forbiddenChanges`）、`AssetProvenanceSchema`、`MediaCandidateItemSchema` 与 `MediaJobSnapshotSchema`。
2. **`MediaGenerationGateway` 网关与候选区审查隔离** [media-gateway.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/media-gateway.ts)：
   - `probeProviders`：区分本地 Coding Agent（`codex-cli` 诚实标注 `requiresOnlineBilling: true`；`gemini-cli` / `claude-acp` / `opencode-cli` 明确标 `supportsImageGen: false`）与在线 Image API（经 `provider-vault` 检测 Key）；
   - `compileBiblePrompt` & `selectApprovedReferences`：锁定角色外观要素、禁止修改项与已批准参考图权重选择；
   - `submitImageJob` & `inspectImageAsset`：产物先写入独立目录 `<userData>/media-candidates/<jobId>/`，校验图像魔数/PNG 尺寸/SHA-256 并写入 `AssetProvenance`（未审 `review_required` 或 `validation_failed`）；
   - `reviewCandidate` & `promoteApprovedCandidates`：仅允许状态为 `approved` 的候选进入发布，绝不绕过审查覆写已发布资产；支持磁盘 `job.json` 重启恢复与 `cancelJob`。
3. **Electron 宿主与 Preload/Bridge 接线** [v2-kernel-host.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/main/v2-kernel-host.ts)、[preload/index.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/preload/index.ts)、[bridge.ts](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/bridge.ts)：接入 `v2:media-providers` / `v2:media-jobs` / `v2:media-submit` / `v2:media-review` / `v2:media-cancel` 五路 IPC（明文 Key 永不下行渲染层）。

## 二、实测命令与结果

| 检查项 | 证据等级 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| 媒体网关与现有生图后端专项单测 | `[SIMULATION]` | `pnpm exec vitest run --coverage.enabled=false packages/shared-protocol/src/media.spec.ts apps/desktop-host/src/main/media-gateway.spec.ts apps/desktop-host/src/main/image-gen-client.spec.ts apps/desktop-host/src/main/codex-image-backend.spec.ts` | **4 文件 / 33/33 PASS**（1.10s） |
| 宿主编译与前端资源构建 | `[E2E-HOST]` | `pnpm --filter @workbench/desktop-host build` | exit 0（CSS 54ms） |
| 仓库全量自动化门禁 | `[SIMULATION]` + 静态门禁 | `pnpm verify:gate` | **7/7 PASS**（TS `strict` + `dependency-cruiser` + Python `ruff/mypy --strict` + 276 源文件零违规 + 0 高危漏洞 + 5 Lua + 全量单测覆盖率 ≥90% + Gate 4 回环 0.4s） |
| Electron 45 E2E（含 `v2MediaProviders` 实测） | `[E2E-HOST]` | `desktop.e2e` + `v2-obsidian-ui.e2e` + `v2-kernel.e2e` + `ui.e2e` | **3/3 PASS**（6.49s）+ **8/8 PASS**（12.61s） |
| 真实云端生图 Key 与本机 Codex 真机出图 | `[REAL-DEVICE]` | 待配置真实 Image API Key / `codex login` 后实测 | **UNVERIFIED**（缺外部付费生图凭据） |
