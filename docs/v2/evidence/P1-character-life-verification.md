# P1 阶段验证证据归档 — `V2-P1-01`（模块化 `CharacterCore` 12 域与最小 `LifeRuntime`）

> **分支**：`feat/whale-isle-v2`  
> **测试环境**：macOS arm64 · Node `v24.22.2` · pnpm `12.16.1` · Electron `45.4.1` · Vitest `5.1.0`

---

## 一、实现摘要与决策核验

1. **契约先行（`@workbench/shared-protocol`）**：新增 `packages/shared-protocol/src/character.ts`，按域建模 12 个独立域（`Identity` / `Personality` / `Preferences` / `Emotion` / `Motivation` / `Goals` / `Commitments` / `Relationships` 引用 / `Memory` 引用 / `Voice Identity` / `Embodiment` / `Activity State` 与 `LifeRuntime` 日程/预算/中断栈）。
2. **模块化核心（`@workbench/character-core`）**：拆分为 `PersonaProfileStore`、`PreferenceStore`、`EmbodimentRegistry`、`EmotionStateEngine`、`GoalManager`、`CommitmentLedger`、`LifeRuntime` 与组合根 `CharacterCore`（支持原子持久化 `v2-character-core.json` 与损坏隔离备份恢复）。
3. **宿主单源接线（`apps/desktop-host`）**：`v2-kernel-host.ts` 持有权威 `CharacterCore`，并与 `index.ts`（`switchDefaultCharacter` 外观切换）、`character-persona.ts`（`bindCharacterCorePrompt`）、`autodrive` 事件流（决策/回执情绪刺激/手动接管控制模式）及 `preload/index.ts`（`v2CharacterSnapshot` / `v2AddGoal` / `v2AddCommitment` / `v2RecordPreference` / `v2BindModel` / `v2SelectActivity`）同步。

---

## 二、实测证据记录

### 1. 契约与核心包确定性单测（`[SIMULATION]`）
- **命令**：`pnpm exec vitest run packages/character-core/src/character-core.spec.ts packages/shared-protocol/src/character.spec.ts`
- **结果**：2 个测试文件 / **7 个用例全部通过**。
- **覆盖率**：
  - `@workbench/character-core`：`98.68%` Stmts / `92.33%` Branch / `98.92%` Funcs / `99.43%` Lines（超过 Gate 3 ≥90% 硬指标）。
  - `packages/shared-protocol/src/character.ts`：`100%` Stmts / `100%` Branch / `100%` Funcs / `100%` Lines。
- **核心验证点**：
  - 切换运行模型（`bindModel`）与切换桌面外观（`applyLegacyAppearance`）后，`char_xiaojing` 身份、目标、约定与人格演进完整保留并支持磁盘重加载；
  - 特质微调与长期偏好随经历演化并记录来源历史，情绪受刺激衰减且 `canElevateToolPermission() === false`；
  - `LifeRuntime` 支持活动仲裁、中断栈压入/恢复、日程评估、预算耗尽拦截以及急停拒绝自主切入；
  - 损坏快照文件自动隔离至 `*.corrupt.*.bak` 并干净恢复。

### 2. 全仓四道自动化门禁（`pnpm verify:gate`）
- **结果**：**`7 过 / 0 跳过 / 0 待接线`**（退出码 `0`）：
  - Gate 1 类型与边界（TS `tsc -b` + `dependency-cruiser` 含新增 `character-core-boundary`）：PASS
  - Gate 1 类型与边界（Python `ruff` + `mypy --strict`）：PASS
  - Gate 2 许可证与密钥（`license-scanner` 扫描 **257 个源文件**，0 违规；`pnpm audit --audit-level high` 0 漏洞；`luac -p` 5 Lua PASS）：PASS
  - Gate 3 确定性单测（全仓 Vitest 含全局 ≥90% 分支门槛 + Pytest + 7 个卡死回归剧本 `S01–S07`）：PASS
  - Gate 4 回环契约 E2E（`[SIMULATION]` `0.4s < 15s`）：PASS

### 3. Electron 45 构建与宿主集成 E2E（`[E2E-HOST]`）
- **构建**：`pnpm --filter @workbench/desktop-host build` 通过。
- **E2E 命令**：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`
- **结果**：**2/2 PASS**（`desktop.e2e.spec.ts` + `v2-kernel.e2e.spec.ts`）。
  - 在真实 Electron 45.4.1 主进程中验证：12 域 `v2CharacterSnapshot()` 返回 `char_xiaojing`、新增目标与约定并绑定模型及切换桌面外观后身份与目标零丢失、`v2SelectActivity` 同步更新 `activityState` 与 `expression`、急停后拒绝 `life_runtime` 活动切入并在 `v2Resume` 后恢复、真实 `node:sqlite` `v2StorageCheck()` 正常。

---

## 三、诚实保留的未验证边界

- **旧 UI 面板切换（`V2-P1-05`）**：V1 `pet:character-list` / `pet:character-select` 与 `character-registry` 只读投影按计划保留至 `V2-P1-05` Obsidian Tide UI 拆分时统一切换。
- **真实语音与游戏实机闭环**：本工单聚焦身份与生活协调骨架，真实跨平台语音流（`V2-P1-02`）与星露谷真机 AI-First 验收（`V2-P1-06`）将在后续对应工单完成。
