# P1 阶段验证证据归档 — `V2-P1-04`（类人五类记忆与经验成长）

> **分支**：`feat/whale-isle-v2`  
> **状态口径**：**`DONE`**（纯本地记忆图谱、SQLite 账本级联、门禁 7/7 与 Electron 45 E2E 全部实测通过，无未验外部平台阻塞）  
> **测试环境**：macOS arm64 · Node `v24.22.2` · pnpm `12.16.1` · Electron `45.4.1` · Vitest `5.1.0`

---

## 一、实现摘要

1. **五类记忆与审计契约（`packages/shared-protocol/src/memory.ts`）**：定义 `MemoryCategory`（`working | episodic | semantic | relational | self`）、`MemoryRetentionPolicy`（`ephemeral | standard | consolidated | protected_self`）、`MemoryUncertaintyLevel`（`clear | fuzzy | uncertain`）、`MemoryCorrectionEntry`、`MemoryDeletionAudit`（严格无明文）与 `FuzzyImpression`。
2. **类人记忆图谱升级（`packages/memory-graph/src/{store.ts,retrieve.ts}`）**：
   - 五类记忆显式分类与 `Self` 保护域防误删；
   - `emotionWeight` 延长半衰期 + `currentEmotionValence` 情绪同向回忆加权 + `recordRecall` 主动回忆巩固；
   - `consolidateRelationalImpressions` 将散落互动归纳为持久模糊印象（旧单句随时间自然淡忘，仍记得某人常来）；
   - `correctNode` 支持用户手动纠正并保留修订历史；
   - `hardDelete` 严格区分自然衰变（`naturalDecayed`）与用户显式真删除：级联删除衍生摘要/日记（`derivedFromIds` / `instance` 边）、原子重写 `nodes.jsonl`/`edges.jsonl` 擦除磁盘原文、联动 SQLite `grudge_ledger` 删表（`deleteViewerByUid`）并落盘无明文 `deletion-audit.jsonl`。
   - `retrieve` 与 `formatMemoryContext` 显式区分 `clear` / `fuzzy`（`[模糊印象]`）/ `uncertain`（`请如实表达不太确定、切勿编造`）。
3. **Electron 宿主接线（`apps/desktop-host`）**：`v2-kernel-host.ts` 与 `preload/index.ts` 暴露 `v2:memory-add`、`v2:memory-query`、`v2:memory-consolidate`、`v2:memory-correct`、`v2:memory-hard-delete`、`v2:memory-deletion-audits` 通道，并联动 `CharacterCore.profile.updateMemoryRef` 与 SQLite `deleteViewerByUid`。

---

## 二、实测证据记录

### 1. 记忆图谱、SQLite 与契约单测（`[SIMULATION]`）
- **命令**：`pnpm exec vitest run packages/memory-graph/src/memory-graph.spec.ts packages/memory-graph/src/memory-v2.spec.ts packages/shared-protocol/src/memory.spec.ts packages/local-store/src/sqlite.spec.ts`
- **结果**：4 个测试文件 / **37 个用例全部通过**。
- **覆盖率**：
  - `packages/memory-graph/src`：`96.98%` Stmts / `87.32%` Branch / `96.87%` Funcs / `99.33%` Lines。
  - `packages/local-store/src/sqlite.ts`：`97.29%` Stmts / `92.3%` Branch / `100%` Funcs / `97.77%` Lines。
  - `packages/shared-protocol/src/memory.ts`：`100%` Stmts / `100%` Branch / `100%` Funcs / `100%` Lines。

### 2. 全仓四道自动化门禁（`pnpm verify:gate`）
- **结果**：**`7 过 / 0 跳过 / 0 待接线`**（退出码 `0`）：
  - Gate 1 类型与边界（TS `tsc -b` + `dependency-cruiser`）：PASS
  - Gate 1 类型与边界（Python `ruff` + `mypy --strict`）：PASS
  - Gate 2 许可证与密钥（`license-scanner` 扫描 **265 个源文件**，0 违规；`pnpm audit --audit-level high` 0 漏洞；`luac -p` 5 Lua PASS）：PASS
  - Gate 3 确定性单测（全仓 Vitest 含全局 ≥90% 分支门槛 + Pytest + 7 个卡死回归剧本 `S01–S07`）：PASS
  - Gate 4 回环契约 E2E（`[SIMULATION]` `0.4s < 15s`）：PASS

### 3. Electron 45 构建与宿主集成 E2E（`[E2E-HOST]`）
- **构建**：`pnpm --filter @workbench/desktop-host build` 通过。
- **E2E 命令**：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`
- **结果**：**2/2 PASS**。
  - 在真实 Electron 45.4.1 主进程中验证：`self` 记忆被 `v2MemoryHardDelete` 拦截（`PROTECTED_SELF_MEMORY`）、2 条关系记录通过 `v2MemoryConsolidate` 归并为模糊印象、显式 `v2MemoryHardDelete` 后 `v2MemoryQuery` 零命中且 `v2MemoryDeletionAudits` 留存无明文审计。
