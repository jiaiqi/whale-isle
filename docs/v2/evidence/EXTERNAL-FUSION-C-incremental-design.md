# EXTERNAL-FUSION C · 增量技术设计（目标架构 / 契约增量 / 迁移 / 安全 / UI / 验收 / 回滚）

> 日期：2026-11-27 · 鲸屿基准：`dba66ec`（`origin/feat/whale-isle-v2`）
> 性质：**设计文档，不含产品代码**。所有 schema 字段名为设计意图，最终以 `packages/shared-protocol` 落地的 Zod 为准。
> 前置：`EXTERNAL-FUSION-A-gap-audit.md`（差距）、`EXTERNAL-FUSION-B-reuse-research.md`（复用决策）。
> 原则（owner 明令）：不建平行内核 / 平行人格 / 平行记忆库；外部能力一律 Adapter / Worker / MCP；契约先行；L1 只读不动。

---

## 1. 目标架构

### 1.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染层  apps/desktop-host/renderer（Tidepaper v3.1）          │
│   知识页（能力组内）· 回执 Chip · 许可证徽章 · 空态诚实文案     │
└───────────────▲──────────────────────────────────────────────┘
                │ IPC（preload 白名单，已有模式）
┌───────────────┴──────────────────────────────────────────────┐
│ 宿主主进程 apps/desktop-host/src/main                         │
│   v2-kernel-host.ts（编排）· 新增 knowledge-host.ts（薄）      │
└───────────────▲──────────────────────────────────────────────┘
                │ 明确业务接口（禁止用 EventBus 代替接口）
┌───────────────┴──────────────────────────────────────────────┐
│ 领域包                                                        │
│  runtime-core（租约/预算/Outbox/风险/KILL）                    │
│  character-core（LifeRuntime / Social / Content / Interest）   │
│  memory-graph（记忆）· persona-brain（人格）                   │
│  game-bridge-mcp（GuideLibrary / StrategyNotebook / 动作锁）    │
│  agent-harness（MCP 客户端 / 任务编排）                        │
└───────────────▲──────────────────────────────────────────────┘
                │ MCP（STDIO/HTTP，JSON-RPC 2.0）
┌───────────────┴──────────────────────────────────────────────┐
│ 外部能力进程（不进仓库、不 vendor、不共享内存）                 │
│  Envoy MCP（Python/uv）· 未来其它 MCP Server                   │
└──────────────────────────────────────────────────────────────┘

存储：node:sqlite（主进程单一权威）· Dexie（仅 UI 即时态）
契约：packages/shared-protocol（Zod 单点事实源 → TS / JSON Schema / Pydantic）
```

### 1.2 与现有架构的关系（明确「不加什么」）

| 诱惑 | 决定 | 理由 |
|---|---|---|
| 新建 `life-runtime-v2` 包 | ❌ 不建 | `LifeRuntime` 已在 `character-core/src/life-runtime.ts`；只在其内部补「单回合 + pendingWake」 |
| 新建知识库微服务 / 第二套 SQLite | ❌ 不建 | 知识落 `local-store` 的同一 `node:sqlite`；外部 Envoy 自己的库只作**材料源**，不作鲸屿权威 |
| 把 Envoy 的 Python 代码搬进来 | ❌ 不搬 | 会引入第二套证据内核 + Python 依赖树；走 MCP 进程 |
| 用 `EventBus` 串知识/回执 | ❌ 不用 | AGENTS §5.4 明令；用明确接口（`KnowledgeService` / `OutboxService`） |
| 内存 RingBuffer 当日志 | ❌ 不用 | 回执必须落 SQLite |
| 双写（旧 JSON + 新 SQLite） | ❌ 禁止 | 迁移用一次性导入 + 读旧写新，不留长期双写 |

---

## 2. 模块变更范围

| # | 模块 / 文件 | 变更类型 | 内容 | 归属子工单 |
|---|---|---|---|---|
| 1 | `packages/shared-protocol/src/knowledge.ts` | 扩展 | 证据引用、知识单元状态、来源修订、摘要哈希 | `V2-P4-04A` |
| 2 | `packages/shared-protocol/src/social.ts` | 扩展 | 观察版本（`expected*`）、行为证据样本 | `V2-P4-04A` |
| 3 | 新建 `packages/shared-protocol/src/outbox.ts` | 新增 | 外部副作用三态 + 尝试次数 + 目标身份 | `V2-P4-04A` |
| 4 | `packages/game-bridge-mcp/src/guide-library.ts` | 扩展 | 知识点从 markdown 片段升级为带证据引用的单元 | `V2-P4-04B` |
| 5 | 新建 `packages/game-bridge-mcp/src/knowledge-evidence.ts` | 新增 | 证据包校验、状态机、过期与反证 | `V2-P4-04B` |
| 6 | `packages/local-store/src/sqlite.ts` | 扩展 | 新表 `knowledge_units` / `knowledge_evidence` / `outbox` / `task_tree` | `V2-P4-04B`（表随首个使用者建） |
| 7 | 新建 `packages/agent-harness/src/mcp-envoy.ts` | 新增 | Envoy MCP 适配器（只读白名单、超时、失败降级） | `V2-P4-04C` |
| 8 | `apps/desktop-host/src/main/knowledge-host.ts` | 新增 | 知识查询 / 晋升 / 拒绝的 IPC 编排 | `V2-P4-04D` |
| 9 | `apps/desktop-host/src/renderer/director/pages/knowledge.tsx` | 新增 | Tidepaper 知识页（能力组内） | `V2-P4-04E` |
| 10 | `apps/desktop-host/src/renderer/director/shell/sidebar.tsx` | 修改 | 「能力」组内加一项，**不新增顶级导航** | `V2-P4-04E` |
| 11 | `packages/runtime-core/src/outbox.ts` | 新增 | 三态持久化 + 重启 `sending→unknown` | `V2-P4-04F` |
| 12 | `packages/runtime-core/src/automation-security.ts` | 扩展 | 预算 fail-closed、风险冷却只挡写、KILL 只挡写 | `V2-P4-04F` |
| 13 | `packages/agent-harness/src/harness.ts` | 扩展 | 任务树 / 审批 / 取消传播（借 milancat 形状） | `V2-P4-04F` |
| 14 | `packages/character-core/src/social-executor.ts` | 扩展 | 执行前 `expected*` 再核验 | `V2-P4-04G` |
| 15 | `packages/character-core/src/interest-sink.ts` | 扩展 | 行为证据阈值（停留/完成/快划） | `V2-P4-04G` |
| 16 | `packages/character-core/src/life-runtime.ts` | 扩展 | 单回合锁 + pendingWake + 唤醒网格 | `V2-P4-04H` |
| 17 | `packages/memory-graph/src/retrieve.ts` | 扩展 | 召回通道 `why` + 冷区只读轮廓 | `V2-P4-04H` |
| 18 | `packages/character-core/src/profile-stores.ts` | 扩展 | 成长候选 → 跨日法定 → 45 天衰减 | `V2-P4-04H` |
| 19 | 新建 `packages/character-core/src/channel-bridge.ts` | 新增 | 外部联系人映射 + 修游标（**BLOCKED**） | `V2-P4-04I` |

> 每行都对应一个 ≤8 文件的原子工单；本表是**总量视图**，不是一次交付。

---

## 3. `shared-protocol` 契约增量（设计草案）

> 兼容策略：**只做可选字段新增与枚举扩展**；旧记录默认值可解析；不做破坏性重命名。落地后必须 `pnpm gen:contracts` 并让 Python/C# 侧编译通过。

### 3.1 证据引用（`knowledge.ts`）

```ts
// 设计草案，非最终代码
export const EvidenceLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), startLine: z.number().int().nonnegative(), endLine: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('web'), selector: z.string().min(1).optional(), url: z.string().url() }),
  z.object({ kind: z.literal('video'), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('pdf'), page: z.number().int().positive() }),
  z.object({ kind: z.literal('image-region'), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
]);

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1),
  materialId: z.string().min(1),
  locator: EvidenceLocatorSchema,
  sourceRevision: z.string().min(1).optional(),   // 网页 etag / 文件 mtime / 视频页版本
  materialSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  extraction: z.enum(['complete', 'partial', 'failed', 'unknown']).default('unknown'),
  capturedAt: z.string().min(1),
});
```

**为什么这样切**：`materialId` 指向材料（权威），`evidenceId` 指向「材料里的一个可复核位置」。两者分开，才能表达「同一材料多处引用」与「材料重抓后旧证据失效」。对齐 Envoy `knowledge_units.py:40-43` 与 `read_v1.py:57,335,383,424,502` 的字段语义，但**用 Zod 重新定义**，不复制其实现。

### 3.2 知识单元状态（`knowledge.ts` 扩展 `GameKnowledgeItemSchema`）

```ts
export const KnowledgeUnitStateSchema = z.enum(['candidate', 'verified', 'promoted', 'archived']);
export const EvidenceLevelSchema = z.enum([
  'real-device', 'real-platform', 'e2e-host', 'simulation', 'unverified',
]);

// GameKnowledgeItemSchema 追加（全部 optional，旧数据不受影响）
evidenceRefs: z.array(EvidenceRefSchema).default([]),
unitState: KnowledgeUnitStateSchema.default('candidate'),
evidenceLevel: EvidenceLevelSchema.default('unverified'),
supersedes: z.array(z.string().min(1)).default([]),
supersededBy: z.string().min(1).optional(),
expiresAt: z.string().min(1).optional(),
```

**映射既有五态**：现有 `status`（`unverified | partially-verified | verified | outdated | rejected`）**保留不动**，`unitState` 是「知识生命周期」，`status` 是「事实可信度」。两者是正交维度：一条 `verified` 的知识可以被 `archived`（被新版本取代），一条 `rejected` 的知识通常 `archived`。**不合并**，避免破坏已有 64 个 P2-01 单测与 UI。

`evidenceLevel` 直接复用 `docs/v2/` 的证据分级词汇，禁止把 `simulation` 标成 `real-device`（AGENTS §2.4）。

### 3.3 观察版本（`social.ts` 扩展）

```ts
export const ObservationVersionSchema = z.object({
  expectedVideoId: z.string().min(1).optional(),
  expectedImageKey: z.string().min(1).optional(),
  expectedLiveRoomId: z.string().min(1).optional(),
  observedAt: z.string().min(1),
});

// 浏览请求追加可选字段
observationVersion: ObservationVersionSchema.optional(),
```

对齐 `LockyBee/dsh-douyin-agent` `autonomous-watch.mjs:197-203,454` 的 `expected*` 思想；**不引入写操作**，只用于「读到的和准备读的是不是同一个东西」。

### 3.4 外部副作用三态（新建 `outbox.ts`）

```ts
export const OutboxStateSchema = z.enum([
  'pending',   // 已决定要做，尚未发出
  'sending',   // 已发出，未拿到结果（崩溃即 unknown）
  'retry',     // 确定没发出，可安全重试
  'unknown',   // 可能已发出，禁止自动重发，交人判断
  'delivered', // 有外部回执证明成功
  'failed',    // 确定失败且不可重试
]);

export const OutboxEntrySchema = z.object({
  entryId: z.string().min(1),
  channel: z.string().min(1),
  targetIdentity: z.object({
    kind: z.enum(['session', 'contact', 'room']),
    id: z.string().min(1),
    identityVersion: z.number().int().positive().default(1),
  }),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  state: OutboxStateSchema,
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(5),
  lastError: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
```

**关键语义**（借 `dsh-fish-soul/lib/outbox.js:51-56,84-85`，重写实现）：
- `retry` 才允许自动重发；`unknown` 一律不自动重发，UI 显示「可能已发送，请人工确认」。
- 进程重启时把所有 `sending` 迁移为 `unknown` 并记审计。
- **游标只在 `delivered` 后推进**——这是对 `dsh-douyin-bridge/lib/bridge.mjs:797-827` 缺陷（先推游标再发送、失败不回滚）的直接反修。

---

## 4. 数据与迁移

### 4.1 SQLite（`packages/local-store/src/sqlite.ts`）

| 表 | 关键列 | 说明 |
|---|---|---|
| `knowledge_units` | `knowledge_id PK`、`game_id`、`unit_state`、`evidence_level`、`confidence`、`superseded_by`、`expires_at`、`updated_at` | 权威副本；UI 与 MCP 都读这里 |
| `knowledge_evidence` | `evidence_id PK`、`knowledge_id FK`、`material_id`、`locator_json`、`source_revision`、`material_sha256`、`extraction` | 一条知识多份证据 |
| `knowledge_materials` | `material_id PK`、`origin_uri`、`title`、`fetched_at`、`sha256`、`license_scope` | 材料来源与许可标记 |
| `outbox` | `entry_id PK`、`channel`、`target_identity_json`、`state`、`attempts`、`updated_at` | 外部副作用 |
| `task_tree` | `task_id PK`、`parent_id`、`state`、`approval_json`、`created_at` | 任务编排（`V2-P4-04F`） |

**迁移策略**：
1. 只加表/加列，不改既有列；用 `CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version` 递增。
2. `guides/*.md` 现有攻略**不删**：首次启动做一次 `guides → knowledge_units(candidate)` 的幂等导入（以 `knowledge_id = hash(gameId + topic + claim)` 去重），导入失败不影响攻略可用。
3. 回滚：新表保留但不读；旧路径 `GuideLibrary` 原样可用（见 §7）。

### 4.2 Dexie（渲染层）

**不加新表**。知识页数据经 IPC 从主进程读，Dexie 只存 UI 偏好（筛选、展开状态）。理由：跨进程权威已在 SQLite，Dexie 再存一份就是双写。

---

## 5. 权限与安全

| 面 | 设计 | 依据 |
|---|---|---|
| Envoy 进程 | 子进程启动，工作目录独立；`env` 白名单；不继承 owner 全量环境变量；退出即回收 | `plugin-kit` Worker 隔离思路；§5.4「进程内 Capability Injection 不算沙箱」 |
| 网络 | 只允许 Envoy 自己声明的抓取白名单；鲸屿侧不代理任意 URL；拒绝私网字面量 IP（借 `Envoy/netpolicy.py:103-138`，含 Fake-IP 放行） | SSRF 防御 |
| 工具白名单 | 只暴露读类工具（`knowledge.search` / `evidence.get` / `material.stat`）；**不暴露任何写/发布/删除工具** | L1 只读 |
| 失败降级 | Envoy 不可用 → 知识页显示「外部知识源不可用」并回退到本地 `GuideLibrary`；**不静默假装有证据** | ADR-002 D-103 |
| 证据完整性 | 材料 SHA-256 + `sourceRevision`；证据包 digest 由规范化 JSON 计算（同材料同参数 → 同 digest） | `Envoy/evidence_pack.py:84-113` 思想 |
| 预算 | fail-closed：账本读不出 = 拒绝新的付费调用（借 `dsh-douyin-studio/lib/budget.mjs:18-21`） | REQ-PERF / 饭碗 |
| 停损 | `KILL` 只挡写与外部副作用，只读永远放行 | `dsh-douyin-studio/lib/killswitch.mjs:2-29` |
| 风险冷却 | 只屏蔽写；读不受影响；30→360 分钟指数 | `dsh-douyin-studio/lib/risk.mjs:15-18,50` |
| 红线 | 不做签名逆向、不做指纹伪装、不接管日常 Chrome、不调未公开接口、不做无人授权写操作 | owner 明令 + `AGENTS.md` §2.2 |

**审计**：所有 MCP 调用进现有 `WhaleMcpClient` 的审计通道（`agent-harness/src/mcp-bridge.ts:52-186`），记录工具名、耗时、结果码、证据 ID；**不记录正文全文**（避免把 owner 材料外泄到日志）。

---

## 6. UI / UX 融合（Tidepaper v3.1）

### 6.1 位置

- 知识页挂在「**能力**」组（`sidebar.tsx:27-67` 的 `providers / plugins / harness` 之后），**不新增顶级导航**（ADR-003 + DESIGN-SYSTEM 硬约束）。
- 入口名：`知识`（与「攻略」区分：攻略是行动手册，知识是带证据的事实）。

### 6.2 页面结构（四段，不做 Dashboard 堆砌）

1. **来源带**：材料列表（标题 / 来源类型 / 抓取时间 / 许可徽章 / SHA-256 前 8 位）。空态文案：「还没有材料。先让 Envoy 读一份你授权的攻略。」
2. **知识列表**：每条一行 `claim` + `unitState` 徽章 + `evidenceLevel` 徽章 + 置信度条（**真实值**，无数据则显示 `—`）。
3. **证据抽屉**：点开显示 `locator`（行号 / 时间码 / 页码）+ `sourceRevision` + `extraction` 状态；可「打开材料」跳原文件/原网页。
4. **实玩回执区**：最近一次「按这条知识执行」的三态回执（`COMPLETED | FAILED | UNCERTAIN`）+ 游戏内截图/日志引用（若有）。**没有回执就显示「尚未实玩验证」**，不允许用模型台词充当回执。

### 6.3 四签名组件复用

| 组件 | 用法 |
|---|---|
| Presence / Sonar | 页面头部显示小鲸「正在读材料」的在场态（真实状态，无动画造假） |
| Receipt Chip | 每条知识右侧显示最近回执三态；`UNCERTAIN` 用中性色 + 文案「不确定」 |
| License Badge | 材料来源徽章：`CC BY-NC-SA`（DEV_ONLY）/ `Apache-2.0` / `MIT` / `未知许可`（红色，禁止商用） |
| Control Ownership HUD | 显示当前是否由小鲸自主读取，还是 owner 手动触发 |

### 6.4 禁止项

- 禁止「知识覆盖率 87%」这类无分母的漂亮指标；有分母才显示。
- 禁止空壳页：无数据时显示空态与下一步动作，不摆假卡片。
- 禁止 emoji 图标 / CDN 字体；只用现有内联 SVG 与系统字体。

---

## 7. 测试与验收

| 层级 | 内容 | 门槛 |
|---|---|---|
| 契约单测 | 新 schema 的默认值、拒绝非法 `sha256`、`locator` 判别联合、旧数据反序列化 | 新增分支 ≥90% |
| 领域单测 | 证据包同输入同 digest；`sending→unknown` 重启迁移；`retry` 可重发 / `unknown` 不可重发；状态机非法迁移被拒 | 触及包分支 ≥90% |
| 回放测试 | 用固定 fixture（材料 + 期望证据包）跑确定性比对，**不联网** | 全绿 |
| `[E2E-HOST]` | Electron 启动 → 打开知识页 → 读到空态 → 导入 fixture → 显示证据 → 点开抽屉 | 全绿 |
| `[REAL-DEVICE]` | 真实星露谷 + SMAPI：按一条知识执行 → 拿到 `COMPLETED/FAILED/UNCERTAIN` 真回执 | **人类执行**，未过不得标 DONE |
| `[REAL-PLATFORM]` | Envoy 真实读取 owner 授权材料 → 真实 Evidence Pack | 人类在场，记录命令与输出 |
| 门禁 | `pnpm verify:gate` 8 项全绿 | 必须 |

**证据口径**：任何 `[SIMULATION]` 结果不得写进 `[REAL-DEVICE]` 栏（AGENTS §2.4 / §5.1）。

---

## 8. 风险、开关与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| Envoy 进程拖慢启动 | 懒启动：首次打开知识页才拉起；启动超时 5s 直接降级 | 配置 `v2-knowledge.json` 的 `envoy.enabled=false`，回到纯本地攻略 |
| 证据哈希误判（材料重抓后全失效） | `sourceRevision` 可选；哈希不匹配只降级为 `partial`，不直接标 `rejected` | 关掉哈希强校验开关 |
| 新表污染旧库 | 只加表不改列；导入幂等 | `DROP TABLE` 新表即可，旧 `guides` 未动 |
| 知识页变成第二套攻略 UI | 知识页只读 + 晋升动作；攻略页不动 | 隐藏导航项（配置开关） |
| 状态机被绕过 | 状态迁移集中在 `knowledge-evidence.ts` 单点，其他模块只调用 | 回退到 `status` 五态旧逻辑 |
| 外部渠道桥接丢消息 | 游标只在 `delivered` 后推进（反修 `bridge.mjs` 缺陷） | 关闭渠道桥接，保留人工转发 |

**退役条件**（AGENTS §5.4 要求）：
- 若 6 个月内知识页周活 < 阈值且无实玩回执增长 → 保留数据表，下线页面入口。
- 若 Envoy MCP 连续 3 个版本无法在 macOS 稳定启动 → 移除适配器，保留 Evidence Pack 契约与本地材料导入。
- 任何子工单回滚都不得改动 `shared-protocol` 已发布的必填字段（只可加可选字段）。

---

## 9. 与现有文档的接口

- `docs/v2/ROADMAP.md`：子工单 `V2-P4-04A…I` 由 owner 在 D 文档批准后登记；**本单不改状态**。
- `docs/v2/TRACEABILITY.md`：新增 `REQ-GAME-0x`（知识证据化）与 `REQ-MEM-0x`（记忆增强）映射，待工单开工时补。
- `docs/v2/DESIGN-SYSTEM.md`：知识页遵循 v3.1 纸面材质与四签名组件，不新增设计 token。
- `docs/THIRD_PARTY_NOTICES.md`：Envoy 以**外部进程**引用，需登记名称、版本（`332638b`）、许可证 Apache-2.0 与 NOTICE 位置；不登记为 vendored 代码。
