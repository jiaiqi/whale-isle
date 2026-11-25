# Whale Isle V2 跨会话交接进度（Progress Checkpoint）

> 本文件是面向任何新接手 Coding Agent 的跨会话单点进度恢复文件（不依赖聊天上下文）。每次完成或阻塞工单必须更新本文件。

- **当前开发分支**：`feat/whale-isle-v2`（上游基线 `main` @ `f1ce271`）
- **当前唯一激活工单**：`V2-P2-01`（攻略学习闭环增强）
- **刚完成待真机补验工单**：`V2-P1-06`（`IMPLEMENTED_UNVERIFIED` — 缺真实《星露谷》+ SMAPI 客户端联调）
- **下一排队工单**：`V2-P2-02`（开放生态与插件进程隔离）

## 1. 工单状态快照

| 工单 | 状态 | 说明与证据 |
| --- | --- | --- |
| `V2-P0-01` | `DONE` | 全仓审计与参考审查完成，产物 [TAKEOVER-AUDIT.md](./TAKEOVER-AUDIT.md) |
| `V2-P0-02` | `DONE` | `@workbench/runtime-core` 落地并接入 Electron 主进程，commit `8369185`，`verify:gate` 7/7 + `v2-kernel.e2e.spec.ts` 通过 |
| `V2-P0-04` | `DONE` | 完成 Blueprint 01–17 全量需求追踪矩阵、[ADR-000](./adr/ADR-000-product-charter-and-risks.md)、[ADR-002](./adr/ADR-002-v2-architecture-revision.md)、完整 `docs/v2/` 文档真源与 `AGENTS.md` §5（`801394f`、`e637def` 及蓝图融合提交） |
| `V2-P0-03` | `DONE` | `@workbench/local-store` 全量迁移至 `node:sqlite` 并移除 `better-sqlite3`（commit `fabf298`）；26/26 单测 + Electron 45 `v2StorageCheck()` + `electron-builder --mac dir` 通过 |
| `V2-P0-05` | `DONE` | `tools/evolution-lite` 落地（commit `5e4ed16`）：唯一工单队列、隔离 Git Worktree、CLI 适配、门禁、独立审查、PR 草案与跨会话恢复；`verify:gate` 7/7 通过，详见证据 [P0-foundation-verification.md](./evidence/P0-foundation-verification.md) |
| `V2-P1-01` | `DONE` | `@workbench/character-core`（12 域分权存储 + `LifeRuntime`）与 Electron 主进程单源接线完成（commit `fb86b24`）；`character-core` 92.33% 分支覆盖、`verify:gate` 7/7 + Electron 45 E2E 2/2 通过，详见证据 [P1-character-life-verification.md](./evidence/P1-character-life-verification.md) |
| `V2-P1-02` | `IMPLEMENTED_UNVERIFIED` | `@workbench/voice-runtime`（真实 `VoiceProvider`、独立 `VoiceIdentity`、WAV/文本口型同步、`SpeechFloorArbiter` + 多轨 `AudioMixer`）与宿主接线完成（commit `fe59ece`）；`verify:gate` 7/7 + Electron 45 E2E 2/2 通过，待真机人工听感、云端 TTS Key 与 Windows SAPI 硬件验收，详见 [P1-voice-mixer-verification.md](./evidence/P1-voice-mixer-verification.md) |
| `V2-P1-03` | `IMPLEMENTED_UNVERIFIED` | 四级诚实额度契约与探针矩阵（DeepSeek / Kimi / OpenRouter / SiliconFlow / OpenCode Go / MiniMax Coding Plan / Ollama / CLI）接入主进程 IPC（commit `b2348b0`）；`quota-probes.ts` 90.86% 分支覆盖、`verify:gate` 7/7 + Electron 45 E2E 2/2 通过，待 Kimi / MiniMax Coding Plan 真实 Key 实测，详见 [P1-provider-quota-verification.md](./evidence/P1-provider-quota-verification.md) |
| `V2-P1-04` | `DONE` | `@workbench/memory-graph` 五类记忆、情绪加权回忆、模糊印象归纳、手动纠正与级联真删除（覆盖 SQLite `deleteViewerByUid` + 磁盘 JSONL 重写 + 无明文审计）及宿主 IPC 完成（commit `319c350`）；37 单测、`verify:gate` 7/7 与 Electron 45 E2E 2/2 通过，详见 [P1-memory-growth-verification.md](./evidence/P1-memory-growth-verification.md) |
| `V2-P1-05` | `DONE` | Obsidian Tide 中控台重构、`App.tsx` Strangler 拆解（1,466→914 行）、四大签名组件、`system/dark/light` 三态主题、`F8/F9/F10/⌘K` 与「V2 生命中枢」面板完成（commit `a9a5786`）；`verify:gate` 7/7 + 4 个 Electron 45 E2E 套件全绿，详见 [P1-obsidian-ui-verification.md](./evidence/P1-obsidian-ui-verification.md) |
| `V2-P1-06` | `IMPLEMENTED_UNVERIFIED` | AI-First 纠偏（`GameCharacterControlLease`、`PausedBrainPlanner` 清除默认静默规则代驾、13 项控制指令与 12 项 Blueprint 17 §12 仿真验收）、`verify:gate` 7/7 与 Electron 45 E2E 4 套件全绿；待真实《星露谷》+ SMAPI 真机联调与浸泡，详见 [P1-stardew-ai-first-verification.md](./evidence/P1-stardew-ai-first-verification.md) |
| `V2-P2-01` | `NEXT` | 攻略学习闭环增强（来源 / 游戏版本 / Mod 条件 / 置信度 / 实玩验证 / 反例更新，不把攻略当命令） |

## 2. 新会话接手必查项

1. 阅读 [AGENTS.md](../../AGENTS.md)（含 §5 V2 增补宪章）。
2. 阅读 [ROADMAP.md](./ROADMAP.md) 确认唯一 `NEXT` / `DOING` 工单，不跨工单抢跑。
3. 阅读 [PRODUCT.md](./PRODUCT.md)、[REQUIREMENTS.md](./REQUIREMENTS.md)、[TRACEABILITY.md](./TRACEABILITY.md)、[ARCHITECTURE.md](./ARCHITECTURE.md) 与 [EVALUATION.md](./EVALUATION.md) 确认产品范围、接口边界与真实验证口径（设计规范见 [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)，开源合规见 [OPEN-SOURCE.md](./OPEN-SOURCE.md)）。
4. 运行 `git status --short` 确认工作区干净（`design/v2-gemini/`、`whale-isle-v2-obsidian.html`、`design/v2/`、`design/v3/` 与 `docs/v2/blueprint/` 已归档入库）。
5. 常用校验指令：
   - 构建：`pnpm --filter @workbench/desktop-host build`
   - 门禁：`pnpm verify:gate`
   - Electron E2E：`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts`
