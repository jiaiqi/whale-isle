# P0 阶段验证证据归档（`V2-P0-01` ~ `V2-P0-05`）

> **分支与基线**：`feat/whale-isle-v2`（上游基线 `main` @ `f1ce271`）  
> **测试环境**：macOS arm64 · Node `v24.22.2` · pnpm `12.16.1` · Electron `45.4.1` · Vitest `5.1.0`

---

## 一、提交序列与审计产物

1. **`8369185` (`V2-P0-01` + `V2-P0-02`)**：建立全仓审计、初版架构与 `@workbench/runtime-core`（`WhaleKernel` 接入 Electron 主进程与 Preload IPC）。
2. **`801394f` (`V2-P0-04`)**：完成 Blueprint 01–17 + MASTER 全量需求对照、架构修订、`ADR-002`、P0–P5 路线图及 `AGENTS.md` §5 宪章同步。
3. **`fabf298` (`V2-P0-03`)**：将 `@workbench/local-store` 全量收敛至内置 `node:sqlite`，彻底移除 `better-sqlite3` 与原生编译依赖。
4. **`5e4ed16` (`V2-P0-05`)**：落地独立研发平面 `tools/evolution-lite`，支持唯一工单队列、生产仓外隔离 Git Worktree、CLI 适配、门禁、独立审查与跨会话恢复。

---

## 二、分项实测证据记录

### 1. `@workbench/runtime-core`（`V2-P0-02`）
- **类型**：`[SIMULATION]` + `[E2E-HOST]`
- **单测与覆盖率**：4 个测试文件全部通过；覆盖率 `99.12%` Stmts / `90.25%` Branch / `100%` Funcs。
- **Electron 宿主启动**：`apps/desktop-host/e2e/v2-kernel.e2e.spec.ts` 在真实 Electron 45.4.1 进程中验证 `WhaleKernel` 进入 `running` 状态、快照查询与急停信号联动。

### 2. `@workbench/local-store` 收敛至 `node:sqlite`（`V2-P0-03`）
- **类型**：`[SIMULATION]` + `[E2E-HOST]` + 实机打包
- **单测与覆盖率**：`packages/local-store` 3 个测试文件 / 26 个用例通过；覆盖率 `97.74%` Stmts / `92.06%` Branch / `100%` Funcs。
  - 验证项：真实 v1 旧版 SQLite 库检测与 WAL 写入前物理备份（`*.v1-backup.*.bak`）、`rollbackDatabaseFile()` 字节级回滚、`runInTransaction` 嵌套 Savepoint 与失败自动回滚、`checkIntegrity()` 与 `openSqliteStoreWithRecovery()` 损坏隔离重建。
- **Electron 运行期验证**：`v2-kernel.e2e.spec.ts` 调用真实 Preload IPC `v2StorageCheck()` 通过（真实 `node:sqlite` 文件落盘读写与完整性检查）。
- **打包验证**：`pnpm --filter @workbench/desktop-host build` 与 `electron-builder --mac dir --arm64` 成功产出 `release/mac-arm64/鲸屿 Whale Isle.app`（零 `better-sqlite3` 原生构建步骤）。

### 3. Evolution Engine Lite（`V2-P0-05`）
- **类型**：`[SIMULATION]` + 真实临时 Git 仓库集成测试
- **单测与覆盖率**：`tools/evolution-lite` 3 个测试文件 / 7 个用例在模拟 Hook 环境变量（`GIT_DIR=.git GIT_INDEX_FILE=.git/index`）下全绿；覆盖率 **`98.08%` Stmts / `91.44%` Branch / `100%` Funcs / `98.34%` Lines**。
- **真实 Git Worktree 集成**：在 `tmpdir` 执行真实 `git init` 与 `git worktree add/remove`，证明生产目录零污染、路径强校验禁止仓库内建 worktree 及禁用 `main`/`baseBranch`。
- **CLI 验证**：`pnpm evolution:lite status` 正常读写状态并输出恢复摘要。

### 4. 全仓自动化门禁与 Electron E2E（commit `5e4ed16` `.githooks/pre-commit`）
- **命令**：`pnpm verify:gate`（由 `git commit` 钩子自动执行）
- **结果**：**`7 过 / 0 跳过 / 0 待接线`**（退出码 `0`）：
  - Gate 1 类型与边界（TS `tsc -b` + `dependency-cruiser` 零违规 + Python `ruff` / `mypy --strict`）：PASS
  - Gate 2 许可证与密钥（`license-scanner` 扫描 **251 个源文件**，0 违规；`pnpm audit --audit-level high` 0 漏洞；`luac -p` 5 Lua PASS）：PASS
  - Gate 3 确定性单测（Vitest 全仓 + Pytest + 7 个星露谷卡死回归剧本 `S01–S07`）：PASS
  - Gate 4 回环契约 E2E（`[SIMULATION]` 0.3s < 15s）：PASS
- **Electron E2E**：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts` **2/2 PASS**。

---

## 三、诚实保留的未验证边界

- **真实旧库现场迁移**：`V2-P0-03` 迁移逻辑已在自动化单测通过，但真实用户历史现场的 `better-sqlite3` 存量 `.sqlite` 文件仍待在真实升级场景中抽检一次。
- **真实外部 Coding Agent CLI 执行**：`tools/evolution-lite` 已验证真实的 `git worktree` 生命周期、命令构造与进程生命周期；直接唤醒外部付费 CLI（如 `codex` / `claude`）修改仓库仍待配置真实 Key 后实测。
