# Whale Isle V2 跨会话交接进度（Progress Checkpoint）

> 本文件是面向任何新接手 Coding Agent 的跨会话单点进度恢复文件（不依赖聊天上下文）。每次完成或阻塞工单必须更新本文件。

- **当前开发分支**：`feat/whale-isle-v2`（上游基线 `main` @ `f1ce271`）
- **当前唯一激活工单**：`V2-P0-03`（迁移 `packages/local-store` 至内置 `node:sqlite`，验证迁移/事务/恢复/打包）
- **下一排队工单**：`V2-P0-05`（Evolution Engine Lite）→ 随后正式进入 P1（`V2-P1-01` 起）

## 1. 工单状态快照

| 工单 | 状态 | 说明与证据 |
| --- | --- | --- |
| `V2-P0-01` | `DONE` | 全仓审计与参考审查完成，产物 [TAKEOVER-AUDIT.md](./TAKEOVER-AUDIT.md) |
| `V2-P0-02` | `DONE` | `@workbench/runtime-core` 落地并接入 Electron 主进程，commit `8369185`，`verify:gate` 7/7 + `v2-kernel.e2e.spec.ts` 通过 |
| `V2-P0-04` | `DONE` | 完成 Blueprint 01–17 全量需求追踪矩阵、[ADR-002](./ADR-002-v2-architecture-revision.md)、修订架构/路线图与 `AGENTS.md` §5 |
| `V2-P0-03` | `NEXT` | 待将 `packages/local-store/src/sqlite.ts` 迁移至 `node:sqlite` 并通过迁移/事务/恢复/Electron 实测 |
| `V2-P0-05` | `PENDING` | Evolution Engine Lite（隔离 Worktree、Agent 适配、自动门禁、独立审查、PR 草案） |

## 2. 新会话接手必查项

1. 阅读 [AGENTS.md](../../AGENTS.md)（含 §5 V2 增补宪章）。
2. 阅读 [ROADMAP.md](./ROADMAP.md) 确认唯一 `NEXT` / `DOING` 工单，不跨工单抢跑。
3. 阅读 [REQUIREMENTS-MATRIX.md](./REQUIREMENTS-MATRIX.md) 与 [ARCHITECTURE.md](./ARCHITECTURE.md) 确认接口边界与真实/未验证口径。
4. 运行 `git status --short`（注意仓库内存在未跟踪的设计稿目录 `design/v2*`、`design/v3`、`docs/Whale-Isle-V2-Blueprint`、`whale-isle-v2-obsidian.html`，严禁删除或误 `git add -A`）。
5. 常用校验指令：
   - 构建：`pnpm --filter @workbench/desktop-host build`
   - 门禁：`pnpm verify:gate`
   - Electron E2E：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`
