# 鲸屿 Whale Isle — AI 桌宠与虚拟主播工作台

> 一座住在桌面上的鲸屿。傲娇干饭蓝鲸女仆「**小鲸（大肥鱼）**」：桌面桌宠 × 《星露谷》丝滑共玩 × 抖音直播中控，**100% 本地优先、断网可用**。
> 支持 macOS（Apple Silicon / `mps`）与 Windows（x64 / `cuda`）。仓库代号仍为 `ai-vtuber-workbench`。

## 文档导航（AI 编程代理与人类宿主必读）

| 文档 | 作用 |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | **AI 自治开发最高宪章**：五层铁笼、原子工单流、四道门禁、许可证红线 |
| [docs/SPEC.md](./docs/SPEC.md) | 产品需求与技术架构总纲（4 项冻结决策、模块详设） |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | M0~M4 · 20 张原子工单清单与当前状态 |
| [docs/VERIFY.md](./docs/VERIFY.md) | 验收矩阵（严格区分 Mock/沙盒 与 真机实测） |
| [docs/REFERENCES.md](./docs/REFERENCES.md) | 开源参考项目清单与复评规则 |
| [docs/THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md) | 第三方许可证台账 |

## 仓库结构

```text
packages/   shared-protocol（Zod 契约）· pet-renderer · model-gateway · persona-brain · game-bridge-mcp · live-stream-hub
apps/       desktop-host（Electron 主进程 + pet-stage 桌宠窗 + director 中控台 + obs-layer OBS 源）
services/   audio-ai-worker（Python/uv：TTS + SVC 点歌 + 素材管线）
mods/       stardew-mcp-mod（C# SMAPI）
tools/      mock-harness（AI 自测沙盒）· scripts（门禁脚本）
```

## 快速开始（人类宿主）

```bash
pnpm install
pnpm typecheck      # Gate 1：类型编译
pnpm verify:gate    # 四道门禁一键校验（Gate 3/4 随 M0 工单逐步接线）
```

## 点火指令（驱动 AI 自动开发，直接复制发送）

> 前置：把你的 `REFERENCES.md` 与各篇 `REFERENCE-*.md` 原始资料放进 `docs/` 目录（当前仓库已放置占位档案，待补充）。

```text
请先完整阅读仓库根目录下的 AGENTS.md、docs/REFERENCES.md 和 docs/ROADMAP.md。
严格按照 AGENTS.md 中的「原子工单工作流（Single-Ticket Loop）」与「四道自动化门禁」要求，
现在开始认领并执行第一个工单 T-M0-01（紧接着按顺序推进到 T-M0-04 完成 M0 基建）。
每完成一个工单：
1. 必须先输出你的复评决策声明（采用什么/不采用什么/验证与回退方案）；
2. 编写代码并真实运行 pnpm verify:gate；
3. 只有当门禁 100% 绿灯后，才更新 docs/ROADMAP.md 与 docs/VERIFY.md 并进入下一个工单。现在开始执行 T-M0-01。
```

## 版本管理约定

- 使用 Git 管理；每个工单 `verify:gate` 全绿后提交一次，提交信息注明工单号（如 `feat(T-M0-03): SQLite 常客账本底座`）。
- 运行期产物（`data/`、`cache/`、`recordings/`）与密钥（`.env*`）一律不入库（见 `.gitignore`）。
