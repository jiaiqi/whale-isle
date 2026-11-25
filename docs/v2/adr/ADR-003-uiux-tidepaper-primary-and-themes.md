# ADR-003：确立潮汐纸（Tidepaper）为主 UI/UX 参考基线并保留多可选主题

- **状态**：Accepted（2026-11-26 经用户确认，修订 [ADR-001](./ADR-001-v2-foundation.md) 分歧 1）
- **关联文档**：[DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md) · [ADR-001](./ADR-001-v2-foundation.md) · [REQUIREMENTS.md](../REQUIREMENTS.md) · [TRACEABILITY.md](../TRACEABILITY.md) · [design/README.md](../../../design/README.md)

---

## 1. 背景与决策动因

1. 在完成 `V2-P1-05`（Obsidian Tide 运行壳层重构与四大签名组件落地）后，团队产出了覆盖 V2/V2.1 全量 25 个页面（含独立桌宠舞台、托盘浮窗、OBS 叠加层、手机远程陪伴、8 步首次引导、114 动作库、攻略心得与进化引擎）的 **潮汐纸 Tidepaper** 高保真交互原型（原 `design/v3/`，现整编为 `design/tidepaper/`）。
2. 用户经全套原型审阅后明确确立：后续 UI/UX 设计与产品体验演进**以 Tidepaper（潮汐纸）为主**，同时将此前设计的 **Obsidian Tide（曜潮）**、**Tide Deep（深海屿光）** 与 **Obsidian v4** 保留为**可选主题**。

---

## 2. 正式决策

1. **主 UI/UX 参考基线：`design/tidepaper/`**
   - 采用 **Tidepaper（潮汐纸）** 作为 Whale Isle V2 主视觉与交互参考基线：晨雾（Light）暖白纸面 + 墨蓝字迹 + 珊瑚点睛（支持 5 种强调色），配套夜间/直播专用「夜潮（Dark）」模式，核心理念为「角色先于功能」。
2. **多主题保留策略（零推倒浪费）**
   - 已在 `V2-P1-05` 落地的 **Obsidian Tide**（`design/theme-obsidian-tide/`）以及 **Tide Deep**（`design/theme-tide-deep/`）、**Obsidian v4**（`design/theme-obsidian-v4/`）保留为**可选主题（Optional Themes）**。
   - 前端架构通过语义化 CSS Token 层承载主题切换，既有 React 模块拆分、IPC 通道、四大签名组件与 Electron E2E 测试资产全部保留复用，不推倒重做。
3. **原型与工程落地的现实边界（强制声明）**
   - `design/tidepaper/` 是高保真原型参考稿，**不是逐像素锁死的硬合同**。
   - 实际开发中须结合具体模块的后端成熟度、性能开销（如 114 个 WebM 列表虚拟化/按需加载）、独立窗口硬件边界（`director` / `pet-stage` / `tray-popover` / `obs-overlay`）、无障碍与真机反馈因地制宜地落地与调整；**严禁为对齐原型页面而铺设未接线空壳或虚假指标**。

---

## 3. 后果与执行方式

- 新建或重构 UI 页面时，优先以 `design/tidepaper/` 的信息架构、交互节奏与角色温度为参考，并将公共语义 Token 逐步对齐「Tidepaper 默认 + Obsidian Tide 等主题可切换」。
- 在 `V2-P1-05` 已交付的壳层之上，按 P2–P4 工单进度渐进演进各领域视图。
