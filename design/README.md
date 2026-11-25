# 鲸屿 Whale Isle · UI/UX 设计资产导航

> **主设计基线**：[tidepaper/index.html](./tidepaper/index.html)（**潮汐纸 Tidepaper** · 25 页全量交互原型）  
> **设计门户**：[index.html](./index.html) · **系统规范**：[docs/v2/DESIGN-SYSTEM.md](../docs/v2/DESIGN-SYSTEM.md) · **决策记录**：[ADR-003](../docs/v2/adr/ADR-003-uiux-tidepaper-primary-and-themes.md)

---

## 目录结构

| 目录 / 入口 | 定位 | 状态与用途 |
| --- | --- | --- |
| **`tidepaper/`** | **主 UI/UX 参考设计基线** | 25 页全量交互原型（晨雾 Light / 夜潮 Dark + 5 种强调色），涵盖总览、对话、角色、声音、记忆、化身与 114 动作库、星露谷共玩、攻略、直播间、OBS 叠加层、数字生活、手机远程、创作工坊、资产库、模型与饭碗、插件/MCP/Skills、Harness、设备租约、安全与进化引擎。 |
| **`theme-obsidian-tide/`** | **可选主题：曜潮 Obsidian Tide** | 16 文件，纯黑曜石深海 + 晨汐瓷白双主题，承接 `V2-P1-05` 当前运行壳层实现。 |
| **`theme-tide-deep/`** | **可选主题：深海屿光 Tide v5** | 12 页原型，深海鲸光青 `#3EE0CD` 视觉探索。 |
| **`theme-obsidian-v4/`** | **可选主题 / V1 基线：Obsidian v4** | 12 页原型，V1 已落地的桌面中控台、`providers` / `coop` / `stardew` 等早期基线。 |
| **`archive/`** | **历史归档（只读参考）** | 包含 `v1-v3-legacy/` 与 `whale-isle-v2-obsidian.html` 早期探索单页。 |
| **`vendor/`** | **共享离线图标库** | 本地 `lucide.min.js`，保证零外网 CDN 依赖打开所有原型。 |

---

## 原型使用原则

1. **高保真参考，而非死板合同**：`tidepaper/` 完整展示了产品蓝图（Blueprint 01–17）的界面想象与交互语义，但实际 React + Electron 开发须结合各模块真实后端成熟度、硬件窗口边界、性能与无障碍需求灵活调整。
2. **严禁空壳与假数据**：未接线的能力在真实应用中必须诚实标注状态，不可为了照搬原型而编造额度、码率或模拟状态。
3. **多主题兼容**：后续 UI 演进以语义化 CSS Token 对齐 `Tidepaper` 为主线，同时保留 `Obsidian Tide` 等方案作为可切换主题，不废弃既有 React 组件与测试资产。
