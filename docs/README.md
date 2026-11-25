# Whale Isle 文档导航与分层说明

> 本仓库同时包含 **V2 现行文档真源**、**全仓共享合规与参考档案**，以及 **V1 历史基线文档**。查阅或修改时请按以下分层定位，避免混淆口径。

---

## 一、V2 现行唯一真源（`docs/v2/`）

在 `feat/whale-isle-v2` 及后续 V2 开发中，所有产品定义、架构约束、设计规范、工单排队与验收记录均以 [docs/v2/README.md](./v2/README.md) 为准：

- 核心入口：[CURRENT.md](./v2/CURRENT.md)（当前交接进度）· [ROADMAP.md](./v2/ROADMAP.md)（唯一工单源）· [DESIGN-SYSTEM.md](./v2/DESIGN-SYSTEM.md)（Tidepaper 主设计规范与多主题体系）
- 架构决策：[ADR-000](./v2/adr/ADR-000-product-charter-and-risks.md) · [ADR-001](./v2/adr/ADR-001-v2-foundation.md) · [ADR-002](./v2/adr/ADR-002-v2-architecture-revision.md) · [ADR-003](./v2/adr/ADR-003-uiux-tidepaper-primary-and-themes.md)
- 交互原型：[../design/README.md](../design/README.md)（主基线 `design/tidepaper/` + 可选主题 `design/theme-*`）

---

## 二、全仓共享合规、许可证与参考资料（原位保留）

以下文件被 `AGENTS.md` 与 `tools/mock-harness/src/license-scanner.mjs`（Gate 2）直接按固定路径读取，保持位于 `docs/` 根目录不变：

- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)：第三方依赖与素材版权台账（Gate 2 强校验）
- [licenses/](./licenses/dsh-pet-2026.txt)：上游许可证原文留存
- [REFERENCES.md](./REFERENCES.md) 与 `docs/REFERENCE-*.md`：开源参考项目复评档案（开工前必查）
- [examples/plugins/hello-whale/](./examples/plugins/hello-whale/)：插件开发示例
- [decisions/M8-stardew.md](./decisions/M8-stardew.md) & [STARDEW-STUCK-LEDGER.md](./STARDEW-STUCK-LEDGER.md)：M8 星露谷决策与卡死台账

---

## 三、V1 历史基线与归档文档（只读留档）

以下文档记录 V1（M0–M8）阶段的实现与测试历史，已由 `docs/v2/` 接替为 V2 开发真源，保留供追溯与对比：

- [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRODUCT-DESIGN.md](./PRODUCT-DESIGN.md) · [SPEC.md](./SPEC.md) · [PLUGINS.md](./PLUGINS.md)
- [ROADMAP.md](./ROADMAP.md) · [VERIFY.md](./VERIFY.md) · [RUNBOOK-M8-STARDEW.md](./RUNBOOK-M8-STARDEW.md)
