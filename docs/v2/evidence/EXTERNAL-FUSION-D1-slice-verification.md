# V2-P4-04A–D · 第一垂直切片施工与验证

日期：2026-11-27。基线：最新 `origin/feat/whale-isle-v2` 的 `01f9891`，工作分支 `fusion-slice`；本次派单明确授权顺序实施 04A–D，`V2-P4-01` 仍为唯一 NEXT，不变更其行为。

## 决策声明

采用 Envoy 外部 MCP 进程与只读工具白名单，原创 TypeScript 证据规范化/四态迁移，并复用现有 GuideLibrary、BWF 客户端及动作锁，数据统一写现有 `workbench.db`。不复制 Envoy 的 Python 内核、不引入 fish-soul 源码、不开放外部写/评论/发布；04A 仅实现本切片所需知识契约，观察版本/Outbox 留给 04F/G，04E 知识页面不在本单范围。
验证路径为契约兼容测试、真实临时文件/SQLite 重启测试、独立 fake MCP 进程、BWF 回环与 Electron IPC E2E，最终运行完整 `pnpm verify:gate`；零付费模型调用、不自动安装 Envoy/uv、无真实游戏可达时不发动作。失败回退本地 GuideLibrary，保留错误原因和已持久化证据；停用知识宿主即可退役新链路，既有攻略与 P4-01 不变。

## 设计与环境差异（如实记录，不改设计结论）

- 开始时工作树基于 `a1d9e5c`，缺失设计书；已快进至远端 `01f9891`，设计书 A–E 随之可直接读取。
- `uv 0.11.17` 可用，`envoy` 命令缺失，`~/WhaleIsle` 材料目录缺失。真实 Envoy 读取、owner 材料与 Evidence Pack 复现当前均无法验收，最高 `IMPLEMENTED_UNVERIFIED`。
- Envoy 实际工具为 `envoy_read/expand/search/replay`，并非设计 C 的示意 `material.stat/evidence.get`；适配器映射真实只读工具名，禁止 `envoy_knowledge` 等含写操作的复合工具。`envoy_read` 的返回是 `structuredContent = ReadResponse`（`material_id/source_revision/result/blocks/coverage/errors`），不是设计示意的扁平 `material/chunks` 对象；用的是只读投影，不照搬字段名。
- **真实 Envoy 不支持本地 Markdown/纯文本**：参考仓 `local_source.py` 的本地材料路径只处理 PDF/音视频，设计书里的 `.md` 示例与实现不一致。因此仿真的 `ready` 只验证鲸屿边界（解析、定位、digest、入库），**不代表真实 Envoy 能读 Markdown**；真实材料若为 `.md` 会得到 `blocked`，宿主保留原因并回退本地攻略，不生成假证据。
- 证据持久化实际为 4 张表（`knowledge_materials`、`knowledge_evidence`、`knowledge_units`、`knowledge_play_receipts`）。设计文字写「3 表」，但实玩回执必须独立落库才能重启复查，故增加回执表，不合并进 unit JSON。
- 04A 只交付本切片所需契约（材料/证据/适用性/回执/来源状态/导入与执行入参）。设计中的 social 观察版本与 Outbox 未实现，留给 04F/G；04E 知识 UI 页面未实现，本单只到 IPC 与 CLI。
- 进程回收：POSIX 用独立进程组 + SIGTERM → 250ms SIGKILL；Windows 目前只有 `child.kill`，**未真机验证**。
- CLI 为单人复跑工具，不与正在运行的桌面宿主共享同一把跨进程锁；运行前应先停止自主游玩并关闭竞争实例，文档与 CLI 帮助均按此口径，不声称已防跨进程争抢。

## 自动化证据（2026-11-27 实测）

### 四道门禁

```
pnpm verify:gate
✅ verify:gate 通过：8 过 / 0 跳过 / 0 待接线
```

- Gate 1：`tsc -b` 零错误、dependency-cruiser 零违规、Python ruff/mypy 通过、desktop-host 四入口打包通过。
- Gate 2：license-scanner 362 个源文件 0 违规；`pnpm audit` 0 high / 0 critical。
- Gate 3：全量单测通过（本单新增用例见下）。
- Gate 4：回环 E2E 0.4s < 15s。

同一天首次门禁曾失败一次，原因与本单改动无关：Electron 二进制安装残缺（`failed to create directory …Electron Helper (Renderer).app/Contents: File exists (os error 17)`），导致 `pixel-avatar-v2.spec.ts` 在导入阶段失败。重新安装后该 spec 3 passed / 1 skipped，随后完整门禁通过。原始失败日志留在本机 `.verify-gate/failure-2026-11-27T12-22-46-538Z.log`（该目录 gitignored，未入库）；重试通过不抹掉这次失败记录。

### 本单专项单测

```
pnpm exec vitest run --coverage.enabled=false \
  packages/shared-protocol/src/knowledge-evidence.spec.ts \
  packages/game-bridge-mcp/src/knowledge-evidence.spec.ts \
  packages/agent-harness/src/mcp-envoy.spec.ts \
  packages/local-store/src/knowledge-repo.spec.ts \
  apps/desktop-host/src/main/knowledge-host.spec.ts
Test Files  5 passed (5)
     Tests  38 passed (38)
```

覆盖率（只统计本单新增核心文件，v8 分支）：

| 文件 | 语句 | 分支 | 函数 | 行 |
| --- | --- | --- | --- | --- |
| `packages/game-bridge-mcp/src/knowledge-evidence.ts` | 100% | 99.17% | 100% | 100% |
| `packages/local-store/src/knowledge-repo.ts` | 92.72% | 95.45% | 91.66% | 95.45% |
| `packages/agent-harness/src/mcp-envoy.ts` | 98.27% | 91.2% | 100% | 100% |

`desktop-host/src/main/**` 按仓库既有口径不计入 v8（由 Electron E2E 覆盖）。剩余未覆盖分支为 Windows 平台分支与两处 `error instanceof Error ? … : String` 的兜底侧，macOS 单测不可达。

### 四段链路与四个反例的用例映射

| 判据 / 反例 | 覆盖用例 |
| --- | --- |
| ① Envoy 只读 owner 材料 | `mcp-envoy.spec.ts` 真实子进程握手、读取、材料未被改写、审计 `READ:`；白名单拒绝 `envoy_knowledge/comment/publish/delete` |
| ② 来源/版本/摘要/许可齐全，同材料同参数 digest 复现 | `knowledge-evidence.spec.ts` 固定期望包与 digest 复现/篡改；`knowledge-host.spec.ts` 两次导入 digest 相同 |
| ③ 候选入库、四态生命周期、保留来源与适用条件 | `knowledge-evidence.spec.ts` 四态迁移、编辑降级、材料缺失/修订失效；`knowledge-repo.spec.ts` 原子导入、历史版本、真实 close/reopen |
| ④ 真实 `get_state` 参与适用性、复用动作与三态回执、SQLite 复查 | `knowledge-host.spec.ts` 真实 HTTP 回环：get_state → 执行 → 前后状态与回执落库；`knowledge-slice.e2e.spec.ts` 重启后原文仍在 |
| 反例：材料缺失 | 删除材料后 `failed`、不执行、不发动作（host spec + E2E） |
| 反例：Envoy 不可用 | 缺 envoy/uv/目录、hang、exit、no-tool、is-error、blocked（不支持本地 Markdown）逐项 `unavailable` 并回退本地攻略 |
| 反例：BWF 不可达 | `game()` 返回 null → `unavailable`，无回执；即使入参夹带 `ownerOverride` 也无法绕过（Zod strip） |
| 反例：执行前后状态无变化 | `water_crops` 完成但状态不变 → `suspicious=true`、`UNCERTAIN`，不升 evidenceLevel |

### Electron 宿主 E2E（`[E2E-HOST]` + `[SIMULATION]`）

```
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/knowledge-slice.e2e.spec.ts
✓ 04D 知识第一切片 IPC > 导入 fixture、复现摘要、真实回环动作、关闭并重启后回执仍可复查 2968ms
Test Files  1 passed (1) · Tests  1 passed (1)
```

真实 Electron 主进程 + preload + 磁盘 SQLite；Envoy 与 BWF 均为仿真，**不是真实 Envoy/游戏验收**。该文件已加入 `.github/workflows/ci.yml` 的 macOS E2E 列表；远端 CI 实际结果以 PR checks 为准。

### 真实环境探测（非仿真）

```
pnpm exec tsx tools/scripts/knowledge-slice.ts --data-dir /tmp/fusion-cli-probe --output /tmp/fusion-cli-probe.json
exit=2
sourceStatus.state = unavailable
reason = 外部知识源不可用：未找到 envoy；owner 授权材料目录不存在；回退本地攻略
materialCount=0, packCount=0, receiptCount=0, unitCount=157（本地攻略候选，evidenceRefs 为空）
```

摘要见 [EXTERNAL-FUSION-D1-cli-probe.json](./EXTERNAL-FUSION-D1-cli-probe.json)。这是真实缺失证据：没有安装 Envoy、没有伪造 owner 材料，也没有产生任何外部证据或实玩回执。

## 待真机验收（未通过前不得称闭环）

1. owner 放置有许可声明的授权材料，安装 Envoy 后真实读取并记录版本与材料 SHA；若材料为 Markdown，需先确认所装 Envoy 版本是否支持，否则只能得到 `blocked`。
2. 同材料、同参数重跑两次 Evidence Pack，digest 相同；本地 fixture 通过不能代替此项。
3. 真实 `get_state` 的版本/Mod/季节/日期可解析且参与适用性核对。
4. 人类在场执行一次游戏动作，记录 BWF 原文与前后状态；不可达时记录 `unavailable`，不造回执。
5. 真实重启后回查 SQLite；04E 页面复查留给后续 UI 工单。
6. Windows x64 的 Envoy 子进程树回收未验证。

## 复跑方式

```bash
# 全量门禁
pnpm verify:gate

# 本单单测
pnpm exec vitest run --coverage.enabled=false \
  packages/shared-protocol/src/knowledge-evidence.spec.ts \
  packages/game-bridge-mcp/src/knowledge-evidence.spec.ts \
  packages/agent-harness/src/mcp-envoy.spec.ts \
  packages/local-store/src/knowledge-repo.spec.ts \
  apps/desktop-host/src/main/knowledge-host.spec.ts

# 宿主 E2E（需先构建 dist；E2E 自身会拉起真实 Electron）
pnpm --filter @workbench/desktop-host build
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/knowledge-slice.e2e.spec.ts

# 真实环境探测 / 导入 / 执行（必须显式数据目录，避免写入正在使用的宿主库）
pnpm exec tsx tools/scripts/knowledge-slice.ts --data-dir /tmp/knowledge-probe
pnpm exec tsx tools/scripts/knowledge-slice.ts --data-dir /tmp/knowledge-probe \
  --materials-root ~/WhaleIsle/knowledge-materials/owner-authorized \
  --import ~/WhaleIsle/knowledge-materials/owner-authorized/<材料> --topic <主题> --license owner-authorized
```

## 能力域结论（复用 / 重写 / 拒绝）

- **复用**：现有 `WhaleMcpClient` STDIO JSON-RPC、`StardewAdapter`/BWF HTTP、`ActionLock`、Runner 控制租约、`GuideLibrary`、`node:sqlite` 单一权威库、既有三态回执分类器（原行为不改）。
- **重写**：Evidence Pack 规范化与 digest、原文定位、四态生命周期与适用性判定、材料冲突降级；全部原创 TypeScript 实现，不抄 Envoy 代码。
- **拒绝**：vendored Envoy/Python 内核、平行知识库、任意 MCP 通用调用口、写/评论/发布工具、fish-soul 代码与素材、模型台词当回执、无状态变化的「成功」。
