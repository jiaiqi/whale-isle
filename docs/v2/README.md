# Whale Isle V2 — 文档真源总索引

> **唯一真源原则**：在 `feat/whale-isle-v2` 及后续 V2 开发分支中，本目录（`docs/v2/`）是产品、架构、需求、工单与验收证据的唯一权威真源。

---

## 1. 产品与需求

| 文档 | 说明 |
| --- | --- |
| [PRODUCT.md](./PRODUCT.md) | 产品总定义、五大定位、核心原则、六大世界与「单主角色先行」边界 |
| [PRODUCT-REQUIREMENTS.md](./PRODUCT-REQUIREMENTS.md) | owner 原始需求原文（逐字搬运、只增不改：22 节 / 98 个 `REQ-*` / 12 条需求执行原则） |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 不可遗漏的 V2/V2.1 全量原始需求清单（`REQ-CORE` ~ `REQ-MULTI`） |
| [TRACEABILITY.md](./TRACEABILITY.md) | 需求 → 模块 → 工单 → 验证证据的全链路追踪矩阵 |

## 2. 架构、设计与规范

| 文档 | 说明 |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 三平面总体技术架构、`CharacterCore` 12 域模型与反腐败红线 |
| [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) | UI/UX 设计规范：**潮汐纸 Tidepaper 主基线 + 多可选主题体系** |
| [OPEN-SOURCE.md](./OPEN-SOURCE.md) | 开源复用策略、五级许可证矩阵与素材清源边界 |
| [TAKEOVER-AUDIT.md](./TAKEOVER-AUDIT.md) | V1 全仓接管审计基线与设计资产对比 |
| [adr/ADR-000-product-charter-and-risks.md](./adr/ADR-000-product-charter-and-risks.md) | 产品宪章级基线决策（`D-001`~`D-015`）与四大风险缓解矩阵 |
| [adr/ADR-001-v2-foundation.md](./adr/ADR-001-v2-foundation.md) | V2 基础架构与演进路线决策（UI 选型部分已由 ADR-003 修订） |
| [adr/ADR-002-v2-architecture-revision.md](./adr/ADR-002-v2-architecture-revision.md) | 第一轮架构审查增补决策（`D-101`~`D-111`：AI-First / `LifeRuntime` / 隔离等） |
| [adr/ADR-003-uiux-tidepaper-primary-and-themes.md](./adr/ADR-003-uiux-tidepaper-primary-and-themes.md) | 确立 **Tidepaper** 为主 UI/UX 基线并保留历史方案为可选主题 |

## 3. 执行、交接与验收

| 文档 | 说明 |
| --- | --- |
| [ROADMAP.md](./ROADMAP.md) | P0–P5 唯一工单队列与 7 态状态机真源 |
| [CURRENT.md](./CURRENT.md) | 跨会话进度恢复检查点（新接手 Agent 必读） |
| [EVALUATION.md](./EVALUATION.md) | 四级证据口径（`[REAL-DEVICE]`/`[E2E-HOST]`/`[SIMULATION]`）与 4 道门禁 |
| [evidence/README.md](./evidence/README.md) | P0–P2 各工单真实测试与验收证据归档索引 |

## 4. 原始蓝图与设计原型

- **原始蓝图归档**：[blueprint/README.md](./blueprint/README.md)（`MASTER` + `01`–`17`）
- **交互设计原型**：[../../design/README.md](../../design/README.md)（主基线 [tidepaper](../../design/tidepaper/index.html) + 可选主题）
