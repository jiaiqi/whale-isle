# EXTERNAL-FUSION D · 原子工单（`V2-P4-04` 外部参考融合）

> 日期：2026-11-27 · 鲸屿基准：`dba66ec`（`origin/feat/whale-isle-v2`）
> 性质：**工单设计文档，不改 `docs/v2/ROADMAP.md` 的任何状态**。本文件供 owner 批准后由老管家登记进 ROADMAP。
> 铁律：**唯一 `NEXT` 仍是 `V2-P4-01`**（单角色全链路整合）；本组全部为 `PENDING`，不得抢跑。
> 每个子工单业务源码 ≤ 8 文件（AGENTS §2.1 / §3.4）。

---

## 0. 编号与排期

**父工单**：`V2-P4-04`（`PENDING`）外部参考融合——证据化知识与诚实回执
**子工单**：`V2-P4-04A` … `V2-P4-04I`

| 子单 | 主题 | 依赖 | 建议顺序 | 状态 |
|---|---|---|---|---|
| `V2-P4-04A` | 契约扩展（证据 / 观察版本 / Outbox） | 无 | 1 | `PENDING` |
| `V2-P4-04B` | 知识证据化内核（状态机 + SQLite + GuideLibrary 融合） | 04A | 2 | `PENDING` |
| `V2-P4-04C` | Envoy MCP 适配器（只读、独立进程、失败降级） | 04A | 3 | `PENDING` |
| `V2-P4-04D` | **第一垂直切片验收**（星露谷攻略 → 证据 → 适用性 → 实玩回执） | 04B、04C | 4 | `PENDING` |
| `V2-P4-04E` | Tidepaper 知识页（能力组内，不新增顶级导航） | 04B、04D | 5 | `PENDING` |
| `V2-P4-04F` | 诚实回执与外部副作用（Outbox 三态 + 预算 fail-closed + 任务编排） | 04A | 与 04G 并行 | `PENDING` |
| `V2-P4-04G` | 观察版本与行为证据（社媒只读加固） | 04A | 与 04F 并行 | `PENDING` |
| `V2-P4-04H` | 生命回合调度 + 记忆召回 + 人格成长闸门 | 04F | 靠后 | `PENDING` |
| `V2-P4-04I` | 外部渠道桥接（会话映射 + 修游标） | 04F、真实平台授权 | 最后 | `BLOCKED` |
| `V2-P4-04J` | 模型能力探针与失败即停（小单） | 04A | 可随时插入 | `PENDING` |

**与现有主线的关系**：
- `V2-P4-01` 未完成前，本组不开工。理由：单角色链路是本组所有能力的宿主；链路没打通，证据化知识无法产生真实实玩回执。
- `V2-P4-02`（L2→L3 自主社交）**不应早于 `04F`/`04G`**：没有 Outbox 三态与观察版本，L2/L3 的写操作会重演 `dsh-douyin-bridge` 的游标缺陷。
- `V2-P4-03`（Evolution Full）与本组无强依赖。

---

## 1. `V2-P4-04A`：契约扩展（证据引用 / 知识单元状态 / 观察版本 / Outbox 三态）

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：Blueprint 17 §7.3；`REQ-GAME-01/02`、`REQ-MEM-01`、`REQ-SEC-02`；ADR-002 D-103（AI-First 诚实）、ADR-003（UI 不新建概念）
- **差距**：`packages/shared-protocol/src/knowledge.ts:61-79` 的 `GameKnowledgeItemSchema` 只有 `evidenceSummary` 字符串，无结构化证据引用；`social.ts` 无观察版本；全仓无外部副作用三态契约。
- **参考坐标**：`Envoy/knowledge_units.py:40-43`（material/evidence/locator/source_revision）、`Envoy/read_v1.py:57,335,383,424,502`（多模态 locator）；`LockyBee/dsh-douyin-agent/autonomous-watch.mjs:197-203`（`expected*`）；`dsh-fish-soul/lib/outbox.js:51-56,84-85`（三态语义，仅思想）。
- **改动文件（6）**：
  1. `packages/shared-protocol/src/knowledge.ts`（追加可选字段 + 新 schema）
  2. `packages/shared-protocol/src/social.ts`（`ObservationVersionSchema` + 请求可选字段）
  3. `packages/shared-protocol/src/outbox.ts`（**新建**）
  4. `packages/shared-protocol/src/index.ts`（导出）
  5. `packages/shared-protocol/src/knowledge.spec.ts`
  6. `packages/shared-protocol/src/outbox.spec.ts`（**新建**）
- **契约变更**：见 C §3。全部为**可选字段或带默认值的新字段**；不改既有必填项，不重命名。
- **验收标准**：
  - 旧测试数据（P2-01 的 64 例）全部仍可 `parse` 通过；
  - `locator` 判别联合非法组合被拒；
  - `materialSha256` 非 64 位小写十六进制被拒；
  - `pnpm gen:contracts` 生成 TS / JSON Schema / Pydantic 均成功，Python 侧 `ruff + mypy --strict` 通过。
- **测试命令**：`pnpm --filter @workbench/shared-protocol test`、`pnpm typecheck`、`pnpm gen:contracts`、`pnpm py:type`
- **证据级别**：`[SIMULATION]`（纯契约单测）
- **风险**：字段命名与 Envoy 不一致导致后续映射反复 → 在 schema 注释里写死「鲸屿字段名优先，适配器负责翻译」。
- **回滚**：删除新增可选字段与 `outbox.ts`，无数据迁移，零影响。
- **前置**：无。

---

## 2. `V2-P4-04B`：知识证据化内核（四态状态机 + SQLite 表 + GuideLibrary 融合）

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：Blueprint 17 §7.3；`REQ-GAME-02`；ADR-002 D-103
- **差距**：`packages/game-bridge-mcp/src/guide-library.ts:65-111` 只解析 text 型 provenance；`:143-191` 兼容检查只看版本/Mod；`:227-299` 切分只按标题，无证据引用；`packages/local-store/src/sqlite.ts:79-115` 只有 4 张表，无知识表。
- **参考坐标**：`Envoy/knowledge_units.py:261-278,379-394`（编辑后回退 `candidate` 并留版本）、`Envoy/evidence_pack.py:84-113`（确定性 digest）。
- **改动文件（6）**：
  1. `packages/game-bridge-mcp/src/knowledge-evidence.ts`（**新建**：状态迁移单点 + digest + 过期/反证）
  2. `packages/game-bridge-mcp/src/guide-library.ts`（导入时产出带证据的单元，保留旧 API）
  3. `packages/local-store/src/sqlite.ts`（新增 3 表，`PRAGMA user_version` 迁移）
  4. `packages/local-store/src/knowledge-repo.ts`（**新建**：读写 + 幂等导入）
  5. `packages/game-bridge-mcp/src/knowledge-evidence.spec.ts`（**新建**）
  6. `packages/local-store/src/knowledge-repo.spec.ts`（**新建**）
- **契约变更**：消费 04A 的字段，不新增。
- **验收标准**：
  - 同材料 + 同参数 → 同 digest（逐字节稳定）；
  - 非法状态迁移（如 `candidate → promoted` 跳级）被拒并返回原因；
  - 知识被编辑 → 回退 `candidate`，旧版本可查；
  - `sourceRevision` 变化 → 证据降级 `partial`，不直接 `rejected`；
  - 旧 `guides/*.md` 仍可被 `GuideLibrary` 正常读取（离线可用）。
- **测试命令**：`pnpm --filter @workbench/game-bridge-mcp test`、`pnpm --filter @workbench/local-store test`、`pnpm verify:gate`
- **证据级别**：`[SIMULATION]`
- **风险**：迁移脚本在 owner 真实库上失败 → 迁移包在事务里，失败回滚 `user_version`；导入失败不阻断启动。
- **回滚**：不读新表即可；新表可 `DROP`，旧 `guides` 未动。
- **前置**：04A。

---

## 3. `V2-P4-04C`：Envoy MCP 适配器（独立进程 / 只读白名单 / 失败降级）

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：Blueprint 04（Agent Harness / MCP）；`REQ-EXT-01`、`REQ-SEC-02`；ADR-002 D-103
- **差距**：`packages/agent-harness/src/mcp-bridge.ts` 有通用 `WhaleMcpClient`，但无外部知识源的启动、白名单与降级策略；宿主无「知识源可用性」状态。
- **参考坐标**：`Envoy/packages/envoy-cli/src/envoy_cli/mcp.py`（工具面）、`integrations/dsh/envoy-dsh/index.js:34-35,53-75`（链接路由每回合一次）、`Envoy/netpolicy.py:103-138`（私网拒绝 + Fake-IP 白名单）。
- **改动文件（5）**：
  1. `packages/agent-harness/src/mcp-envoy.ts`（**新建**：启动参数、白名单、超时、健康探测）
  2. `packages/agent-harness/src/mcp-envoy.spec.ts`（**新建**，fake MCP server）
  3. `apps/desktop-host/src/main/knowledge-host.ts`（**新建**：可用性状态 + 只读编排）
  4. `apps/desktop-host/src/preload/index.ts`（新增只读 IPC 通道）
  5. `packages/shared-protocol/src/ecosystem.ts`（知识源状态 schema，若已有同类则扩展）
- **契约变更**：新增「外部知识源状态」可选 schema（`available / unavailable / starting / error`），不新增必填。
- **验收标准**：
  - Envoy 缺失 / `uv` 缺失 / 启动超时 → `unavailable` + 人话原因，知识页回退本地攻略；
  - 只暴露读类工具；尝试调用白名单外工具被拒并审计；
  - 进程退出后无残留子进程（宿主退出即回收）；
  - **不做**：不下载 Envoy、不自动装 `uv`、不访问未授权 URL。
- **测试命令**：`pnpm --filter @workbench/agent-harness test`、`pnpm --filter @workbench/desktop-host build`、`pnpm verify:gate`
- **证据级别**：`[SIMULATION]`（fake MCP）；真实 Envoy 拉起 → `[REAL-DEVICE]`，人类在场，归 04D。
- **风险**：Python 环境差异导致启动失败 → 明确报错并给安装指引，不静默重试。
- **回滚**：`v2-knowledge.json` 的 `envoy.enabled=false`；删除适配器文件即可。
- **前置**：04A。

---

## 4. `V2-P4-04D`：**第一垂直切片验收**（星露谷攻略 → Envoy 证据 → GameKnowledge → 状态/适用性 → 真实实玩回执）

> 这是 owner 批准的**第一个垂直切片**。详见 `EXTERNAL-FUSION-E-first-vertical-slice.md`。

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：Blueprint 17 §7.3；`REQ-GAME-01/02/03`；ADR-002 D-103
- **差距**：知识目前是「markdown 文本 + 置信度数字」，没有「这条知识来自哪份材料的哪一段」；实玩回执与知识的关联未落库。
- **参考坐标**：`Envoy/evidence_pack.py:84-113`；`Envoy/knowledge_units.py:40-43`；鲸屿 `game-bridge-mcp/src/strategy-notebook.ts`（已有 verdict/confidence/source）。
- **改动文件（6）**：
  1. `apps/desktop-host/src/main/knowledge-host.ts`（扩展：切片编排）
  2. `apps/desktop-host/src/preload/index.ts`（只读查询通道）
  3. `apps/desktop-host/e2e/knowledge-slice.e2e.spec.ts`（**新建**，fixture 驱动）
  4. `tools/mock-harness/fixtures/knowledge-slice/`（**新建**：材料 + 期望证据包）
  5. `docs/v2/evidence/EXTERNAL-FUSION-D1-slice-verification.md`（**新建**，完工时写）
  6. `packages/game-bridge-mcp/src/knowledge-evidence.ts`（仅补「实玩回执 → 置信度演进」的单点函数）
- **契约变更**：无新增（消费 04A/04B）。
- **验收标准**（最小集）：
  1. owner 授权的攻略材料被真实读取，产出 `materialId + evidenceId + locator + SHA-256`；
  2. 知识单元从 `candidate` → `verified` 必须满足「证据存在 + 定位可复核」；
  3. 结合真实游戏状态（`get_state`）判断适用性：版本/Mod 不匹配 → `uncertain` 并说明原因；
  4. 按知识执行动作 → 拿到 BWF 真实三态回执（`COMPLETED | FAILED | UNCERTAIN`），**模型台词不算回执**；
  5. 回执落 SQLite，可在知识页复查；
  6. **没有真实读取/执行就不得宣称闭环**——缺任一环节，状态最高 `IMPLEMENTED_UNVERIFIED`。
- **测试命令**：`pnpm verify:gate`；`pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/knowledge-slice.e2e.spec.ts`
- **证据级别**：`[E2E-HOST]`（fixture）+ `[REAL-DEVICE]`（真实星露谷，人类执行）
- **风险**：真实游戏状态不稳定导致回执抖动 → 记录原始 `get_state` 快照，失败如实记 `FAILED`。
- **回滚**：关闭知识源开关，回到纯本地攻略；已落库证据保留只读。
- **前置**：04B、04C；真实部分需 owner 在场。

---

## 5. `V2-P4-04E`：Tidepaper 知识页（能力组内，不新增顶级导航）

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：`REQ-UI-01`；ADR-003；`docs/v2/DESIGN-SYSTEM.md` v3.1
- **差距**：`apps/desktop-host/src/renderer/director/shell/sidebar.tsx:27-67` 的「能力」组只有 `providers / plugins / harness`，无知识入口；知识数据无 UI。
- **参考坐标**：`docs/v2/evidence/P2-guide-learning-verification.md` 的攻略 UI 既有形态（复用视觉语言，不复制布局）。
- **改动文件（5）**：
  1. `apps/desktop-host/src/renderer/director/pages/knowledge.tsx`（**新建**）
  2. `apps/desktop-host/src/renderer/director/shell/sidebar.tsx`（能力组加一项）
  3. `apps/desktop-host/src/renderer/director/app.tsx`（路由）
  4. `apps/desktop-host/src/renderer/director/pages/knowledge.css`（**新建**，纸面材质复用既有 token）
  5. `apps/desktop-host/e2e/knowledge-page.e2e.spec.ts`（**新建**）
- **契约变更**：无。
- **验收标准**：
  - 四段结构（来源带 / 知识列表 / 证据抽屉 / 实玩回执区）；
  - 空态有下一步动作，无假卡片、无假指标；
  - `evidenceLevel` 与 `unitState` 徽章真实反映数据；
  - 不新增顶级导航；窄窗不破版；WCAG 对比度 ≥4.5；
  - `[E2E-HOST]`：打开页面 → 空态 → 导入 fixture → 显示证据 → 点开抽屉。
- **测试命令**：`pnpm --filter @workbench/desktop-host build`、`pnpm verify:gate`
- **证据级别**：`[E2E-HOST]`
- **风险**：知识页与攻略页职责混淆 → 文案区分「知识 = 带证据的事实 / 攻略 = 行动手册」。
- **回滚**：隐藏导航项（配置开关），页面文件保留。
- **前置**：04B、04D。

---

## 6. `V2-P4-04F`：诚实回执与外部副作用（Outbox 三态 + 预算 fail-closed + 任务编排）

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：Blueprint 04；`REQ-AUTO-01`、`REQ-PERF-02`；ADR-002 D-103
- **差距**：仓库无 Outbox 表与三态；`packages/runtime-core/src/automation-security.ts` 有 P5 与租约，但无「外部副作用可能已发生」的持久语义；`packages/agent-harness/src/harness.ts:312` 只有单任务执行，无任务树/审批/取消传播。
- **参考坐标**：`dsh-fish-soul/lib/outbox.js:51-56,84-85,193-243`（三态 + 重启迁移，仅思想）；`dsh-douyin-studio/lib/budget.mjs:18-21,132-158`（fail-closed）、`killswitch.mjs:2-29`（只挡写）、`risk.mjs:15-18,50`（冷却不影响读）；`milancat-bot/lib/engine.js:329,489,1131,1612,2042`（审批/取消/派发）。
- **改动文件（7）**：
  1. `packages/runtime-core/src/outbox.ts`（**新建**）
  2. `packages/runtime-core/src/outbox.spec.ts`（**新建**）
  3. `packages/runtime-core/src/automation-security.ts`（预算 fail-closed + 只挡写）
  4. `packages/local-store/src/sqlite.ts`（`outbox` 表；若 04B 已建则复用）
  5. `packages/agent-harness/src/harness.ts`（任务树 / 审批 / 取消传播）
  6. `packages/agent-harness/src/harness.spec.ts`（扩展）
  7. `packages/runtime-core/src/automation-security.spec.ts`（扩展）
- **契约变更**：消费 04A 的 `outbox.ts`。
- **验收标准**：
  - 进程重启后 `sending` 全部变 `unknown` 并记审计；
  - `unknown` **不自动重发**；`retry` 可安全重发；
  - 账本读取失败 → 拒绝新的付费调用（fail-closed），并给出人话原因；
  - `KILL` 与风险冷却只挡写，只读不受影响；
  - 父任务取消传播到子任务，子会话被真实终止（非仅标记）。
- **测试命令**：`pnpm --filter @workbench/runtime-core test`、`pnpm --filter @workbench/agent-harness test`、`pnpm verify:gate`
- **证据级别**：`[SIMULATION]`
- **风险**：状态机与既有 `COMPLETED/FAILED/UNCERTAIN` 混用 → 显式区分「副作用状态」与「游戏回执状态」，不做同义合并。
- **回滚**：Outbox 默认不启用（无外部写通道时为零开销）；任务树可退回单任务。
- **前置**：04A。

---

## 7. `V2-P4-04G`：观察版本与行为证据（社媒只读加固）

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：`REQ-SOC-01`；ADR-002 D-103；AGENTS L1 只读红线
- **差距**：`packages/character-core/src/social-executor.ts:33-35` 读取端口只回 `{textContent, usedMultimodal?}`，无「读到的是不是准备读的那个」；`interest-sink.ts:39-41` 的 `signalDelta` 无行为证据门槛；`social-douyin.ts` 无执行前再核验。
- **参考坐标**：`LockyBee/dsh-douyin-agent/autonomous-watch.mjs:197-203,454`；`persona-memory.mjs:17,34-42`（`sustainedSeconds` / `completionRatio` / `quickSkipSeconds`）。
- **改动文件（5）**：
  1. `packages/character-core/src/social-executor.ts`（执行前 `expected*` 校验，不匹配即 `decision-discarded`）
  2. `packages/character-core/src/interest-sink.ts`（行为证据阈值 + 证据字段）
  3. `packages/character-core/src/social-douyin.ts`（把实际读到的 `videoId` 回填）
  4. `packages/character-core/src/social-executor.spec.ts`
  5. `packages/character-core/src/interest-sink.spec.ts`
- **契约变更**：无（消费 04A 的 `ObservationVersionSchema`）。
- **验收标准**：
  - 页面在决策与执行之间变化 → 放弃该次执行，记原因，不重试；
  - 兴趣信号只在满足停留/完成阈值时产生，快划不计正兴趣；
  - 仍是 L1 只读：无点赞/评论/关注/私信；
  - 现有 55 例抖音相关单测全绿。
- **测试命令**：`pnpm --filter @workbench/character-core test`、`pnpm verify:gate`
- **证据级别**：`[SIMULATION]`；真实平台复验归后续，需 owner 在场。
- **风险**：阈值在真实平台过严导致零信号 → 阈值可配，默认保守；先记录后调参，不先放宽。
- **回滚**：`observationVersion` 为可选，不传即旧行为。
- **前置**：04A。

---

## 8. `V2-P4-04H`：生命回合调度 + 记忆召回 + 人格成长闸门

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：`REQ-LIFE-01`、`REQ-MEM-01/02`、`REQ-CHAR-01`；ADR-002 D-103
- **差距**：`life-runtime.ts:210-235` 只有静态时段判定，无单回合锁/pendingWake；`memory-graph/src/retrieve.ts:130-138` 只有 `sim/imp/recency` 等打分理由，无「为何被想起」的通道语义与冷区只读；`profile-stores.ts:108-142` 的 `evolveTrait` 单次调用即改值，无候选/跨日法定/衰减/反证。
- **参考坐标**：`dsh-living/runtime.mjs:274-311`、`clock.mjs:9-36,138-165`、`recall.mjs:21-28,81-140`、`memory.mjs:243`；`dsh-fish-soul/growth.js:7-19,88-101`、`mood-guard.js:11-26`；`soul-memory.js:593-626,712-733`（仅思想，根无 LICENSE）。
- **改动文件（6）**：
  1. `packages/character-core/src/life-runtime.ts`
  2. `packages/memory-graph/src/retrieve.ts`
  3. `packages/character-core/src/profile-stores.ts`
  4. `packages/character-core/src/life-runtime.spec.ts`
  5. `packages/memory-graph/src/retrieve.spec.ts`
  6. `packages/character-core/src/profile-stores.spec.ts`
- **契约变更**：可能新增「唤醒原因 / 召回通道」可选字段（届时按 04A 流程先改契约）。
- **验收标准**：
  - 单回合锁：并发唤醒只执行一次，其余合并为一次后续 tick，不积压；
  - 唤醒网格零模型调用（可用虚拟时钟单测证明）；
  - 每条召回带机器可读 `channels[]` 与 `why`；冷区记忆只作模糊轮廓、不作行动依据；
  - 人格特质变更必须满足「≥2 通道且跨 ≥2 天」或「单通道 ≥5 次跨 ≥3 天」；45 天无新证据降权；反证可退场；
  - 现有 `V2-P1-04` 记忆测试与 `V2-P1-01` 生命周期测试全绿。
- **测试命令**：`pnpm --filter @workbench/character-core test`、`pnpm --filter @workbench/memory-graph test`、`pnpm verify:gate`
- **证据级别**：`[SIMULATION]`；长时浸泡 → `[E2E-HOST]` / `[REAL-DEVICE]` 另记。
- **风险**：改动核心状态机影响面大 → 拆成 2 个提交（调度 / 成长），各自可回滚；保留旧路径开关。
- **回滚**：`v2-life.json` 的 `turnLock.enabled=false`、`growthGate.enabled=false`，回到当前行为。
- **前置**：04F（预算与取消语义先稳定）。

---

## 9. `V2-P4-04I`：外部渠道桥接（会话映射 + 修游标）

- **状态**：`BLOCKED`
- **阻塞条件**：① owner 明确授权某个外部渠道的读写范围（当前 L1 只读，不接受写）；② 真实平台账号与合规确认；③ `V2-P4-02` 的 L2 授权边界先落地。
- **蓝图 / 需求 / ADR**：`REQ-SOC-01`、`REQ-LIVE-01`
- **差距**：无渠道桥接；且外部参考存在**已知缺陷**必须先反修。
- **参考坐标**：`pcmxiao/dsh-douyin-bridge/lib/bridge.mjs:797-827`（`rec.lastRelayedSeq = ev.seq` 在 `sendDM` 之前，`:809`，失败不回滚 → **禁止照搬**）；`lib/browser.mjs:29-31`（防冻结三件套）、`:490-521`（导航后 `location.href` 校验）；`contact-authorization.mjs:2-53`（稳定身份 `conv:sha256` + `identityVersion`）。
- **改动文件（预计 5，开工时再定）**：`character-core/src/channel-bridge.ts`（新建）、`runtime-core/src/outbox.ts`（消费）、宿主 IPC、契约扩展、测试。
- **契约变更**：渠道消息归一 schema（届时先改 shared-protocol）。
- **验收标准**：
  - 游标只在 `delivered` 后推进；`unknown` 不重发；
  - 联系人身份用稳定哈希，昵称变更不新建会话；
  - 崩溃重启后不重复投递、不丢消息（可重放测试证明）。
- **测试命令**：届时定义。
- **证据级别**：`[SIMULATION]` → `[REAL-PLATFORM]`
- **风险**：平台风控与合规 → 未获授权不开工。
- **回滚**：关闭渠道桥接。
- **前置**：04F、04G、`V2-P4-02`。

---

## 10. `V2-P4-04J`：模型能力探针与失败即停

- **状态**：`PENDING`
- **蓝图 / 需求 / ADR**：Blueprint 04（Provider Registry）；`REQ-MOD-01`；ADR-002 D-103
- **差距**：`packages/model-gateway/src/gateway.ts:290` 只有 `supportsVision` 预检，缺统一能力矩阵（图像输入 / 附件 / 工具调用 / 最大上下文）；能力不足时没有统一「明确停止」路径。
- **参考坐标**：`AAAjzx111-dsh-douyin-agent/native-watch-decision.mjs:3,17-34`（检查 `inputModalities` / `saveImages` / 引用完整性，不足即停）；整仓拒绝，仅借概念。
- **改动文件（4）**：
  1. `packages/shared-protocol/src/model.ts`（能力矩阵可选字段）
  2. `packages/model-gateway/src/gateway.ts`（统一探针 + 失败即停）
  3. `packages/model-gateway/src/gateway.spec.ts`
  4. `packages/shared-protocol/src/model.spec.ts`
- **契约变更**：`ModelCapabilities` 增补可选字段（`imageInput` / `fileAttachments` / `toolCalling` / `maxContextTokens`），全部带默认值。
- **验收标准**：能力不足 → 返回明确原因并停止，不静默退化；旧供应商配置无需修改即可解析；现有 `supportsVision` 行为不变。
- **测试命令**：`pnpm --filter @workbench/model-gateway test`、`pnpm verify:gate`
- **证据级别**：`[SIMULATION]`；真实供应商探针 → `[REAL-DEVICE]` 另记。
- **风险**：不同供应商能力字段命名不一 → 适配层归一，契约只保留鲸屿语义。
- **回滚**：删可选字段，回到单点 `supportsVision`。
- **前置**：04A。

---

## 11. 与现有 ROADMAP 的冲突点（需 owner / 老管家裁决）

1. **`V2-P3-07` 重号**：`docs/v2/ROADMAP.md` 中 `V2-P3-07` 出现两次（星露谷建档批次 `DONE` 与 ADR-005 歌声/舞台批次 `PENDING`，约 173 行与 180 行）。本组编号 `V2-P4-04` 与其无冲突，但建议一并修号。
2. **`V2-P4-01` 是 `NEXT`**：本组全部 `PENDING`，不改变唯一 NEXT。
3. **`AGENTS.md` §2.3 写「四道门禁」，实际 `verify-gate.mjs` 已 8 项**（Gate 1 拆出 Python 与打包护栏、Gate 2 拆出依赖漏洞与 Lua 语法）。本组验收统一按「`pnpm verify:gate` 全绿」表述，不回写旧计数。
4. **`docs/v2/CURRENT.md` 基线陈旧**：文中仍写 `feat-douyin-browser-cdp` 分支与 PR #9 待决，而 `origin/feat/whale-isle-v2` HEAD 已是 PR #9 合并后的 `dba66ec`。本单不修改 `CURRENT.md`，仅提示老管家在下一工单时刷新。

---

## 12. 完工口径（每个子工单通用）

- 跑 `pnpm verify:gate` 并附真实输出摘要；
- 更新 `docs/v2/ROADMAP.md`（状态）、`docs/v2/CURRENT.md`（交接）、`docs/v2/TRACEABILITY.md`（需求映射）、`docs/v2/evidence/`（证据）；
- 区分 `[SIMULATION]` / `[E2E-HOST]` / `[REAL-DEVICE]` / `[REAL-PLATFORM]`；
- 涉及真实游戏/平台/硬件而未经人类验收 → 最高 `IMPLEMENTED_UNVERIFIED`；
- 每个子工单写明**退役条件与回滚方案**（AGENTS §5.4）。
