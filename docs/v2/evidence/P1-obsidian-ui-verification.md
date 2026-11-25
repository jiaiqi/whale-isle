# V2-P1-05 Obsidian Tide 中控台重构与核心工作流界面验证报告

- **工单**：`V2-P1-05`
- **结论口径**：`DONE`（纯 UI/IPC 宿主界面重构，`pnpm --filter @workbench/desktop-host build`、`pnpm verify:gate` 7/7 与全部 4 个 Electron 45 E2E 套件实测全绿）
- **验证日期**：2026-11-26

## 一、实现与 Strangler 拆分摘要

1. **巨型 `App.tsx` 模块化拆解**：`apps/desktop-host/src/renderer/director/App.tsx` 由 1,466 行缩减为 **914 行**，按领域拆出：
   - [signature-widgets.tsx](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx)（403 行）：Obsidian Tide 四大签名组件（`SonarRing`、`ReceiptChip` 四态回执芯片、`LicenseBadge`、`ControlOwnershipHud`）及真实开发阶段标记 `StageBadge`。
   - [chat-view.tsx](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/views/chat-view.tsx)（390 行）：「聊天 · 小鲸」主交互流与实时监视侧栏，接入 `ReceiptChip` 与未接线通道 `StageBadge`（`P3`）。
   - [stardew-view.tsx](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/views/stardew-view.tsx)（430 行）：星露谷 / 泰拉瑞亚 / 饥荒三游戏共玩工作区与 Mod 子页，完整保留全部既有 `data-*` 选择器。
   - [life-console-view.tsx](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/views/life-console-view.tsx)（718 行）：「V2 生命中枢」面板，直连 `CharacterCore` 12 域、`LifeRuntime`、`AudioMixer`、四级诚实额度矩阵与五类记忆级联真删除。
2. **三态主题与全局快捷键**：
   - 在 [topbar.tsx](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/shell/topbar.tsx) 与 `App.tsx` 实现 `dark` / `light` / `system`（监听 `prefers-color-scheme`）三态切换，且保留 `[data-theme-toggle]` 深浅即时往返语义。
   - 全局快捷键 `F8`（无论焦点是否在输入框内均触发 `v2EmergencyHalt` + 停止自动驾驶）、`F9`（接管/交还切换，急停态按 `F9` 进入人类接管而非误跳回自主）、`F10`（睡眠安静切换）与 `⌘K`（扩展包含控制权与系统主题条目的命令面板）。
3. **样式与层叠上下文**：[design-tokens.css](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/design-tokens.css) 与 [styles.css](file:///Users/jiaqi/Documents/vibe/ai-vtuber-workbench/apps/desktop-host/src/renderer/director/styles.css) 增加 `hud` 网格区、声呐环动效及顶栏/侧栏显式层叠顺序（确保 `.wb-top` 下拉菜单不被 `.wb-hud` / `.wb-main` 遮挡）。

## 二、实测命令与结果

| 检查项 | 证据等级 | 命令 | 实测结果 |
| --- | --- | --- | --- |
| 宿主编译与 Tailwind v4 CSS 构建 | `[E2E-HOST]` | `pnpm --filter @workbench/desktop-host build` | exit 0（`main / preload / pet-stage / director` 全通过，CSS 49ms） |
| 现有中控台 UI 全链路 E2E | `[E2E-HOST]` | `pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/ui.e2e.spec.ts` | **8/8 PASS**（13.95s：气泡、三游戏切换、角色联动、WCAG AA 深浅对比度、服务商导入与插件审批全绿） |
| V2 Obsidian UI 与 HUD / 全页遍历 | `[E2E-HOST]` | `pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/desktop.e2e.spec.ts apps/desktop-host/e2e/v2-kernel.e2e.spec.ts apps/desktop-host/e2e/v2-obsidian-ui.e2e.spec.ts` | **3/3 PASS**（6.30s：HUD 急停/恢复、`F8`/`F9` 快捷键、三态主题、11 页零 `pageerror`、目标写入、BGM 混音轨启停、额度矩阵 `openai=unknown` 诚实展示、记忆写入+级联真删除） |
| 仓库全量门禁 | `[SIMULATION]` + 静态门禁 | `pnpm verify:gate` | **7/7 PASS**（TS `strict` + `dependency-cruiser` + Python `ruff/mypy` + 269 源文件零违规 + 0 高危漏洞 + 5 Lua + 全量单测覆盖率 ≥90% + Gate 4 回环 0.4s） |
