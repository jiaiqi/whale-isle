# 潮汐纸 Tidepaper 主基线与 P2/P3 中控台升级实测证据（`ADR-003` / `REQ-UI-01`）

> **关联决策与需求**：[ADR-003](../adr/ADR-003-uiux-tidepaper-primary-and-themes.md) · [DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md) · `REQ-UI-01`  
> **诚实结论口径**：**`DONE`**（中控台前端主题令牌、外壳与 V2 实盘面板已切换至 Tidepaper 主视觉并保留 Obsidian Tide / Tide Deep 可选主题，WCAG AA ≥4.5:1 对比度、全门禁 7/7 与 Electron 45 全量 E2E 通过，且已按用户要求常驻拉起本地桌面客户端）。

---

## 1. 修改范围（业务源码 7 个，符合 ≤ 8 铁律）

| 文件 | 变更内容 |
| --- | --- |
| [design-tokens.css](../../../apps/desktop-host/src/renderer/director/design-tokens.css) | 确立 Tidepaper 晨雾 Mist（`#F3EFE7` 暖白纸面 / `#142036` 墨蓝字迹 / `#D14D2C` 珊瑚落日强调）与夜潮 Night Tide（`#0D1220` 深墨蓝）为默认主令牌；兼容 WCAG AA ≥4.5 对比度；保留 `obsidian-tide` 与 `tide-deep` 可选皮肤及 5 种 Tidepaper 强调色（`coral/sea/whale/kelp/plum`） |
| [styles.css](../../../apps/desktop-host/src/renderer/director/styles.css) | 新增衬线展示字体 `.wb-display`、眉标 `.wb-eyebrow` 与引文 `.wb-serif-quote` 排版工具类 |
| [sidebar.tsx](../../../apps/desktop-host/src/renderer/director/shell/sidebar.tsx) | 导航调整为 Tidepaper「此刻 / 角色与化身 / 生活与舞台 / 能力与治理」分组并增加底栏主角色实时活动与情绪卡 |
| [topbar.tsx](../../../apps/desktop-host/src/renderer/director/shell/topbar.tsx) | 顶栏新增「皮肤风格与强调色选择器 `[data-skin-picker]`」并保留 `light/dark/system` 三态切换与游戏/大脑/语音直连开关 |
| [signature-widgets.tsx](../../../apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx) | `ControlOwnershipHud` 对齐 Tidepaper 纸面质感与衬线角色锚点，保留全部 `data-v2-*` 签名组件 |
| [life-console-view.tsx](../../../apps/desktop-host/src/renderer/director/views/life-console-view.tsx) | 重构 Tidepaper Character-First Editorial Hero；新增真实 `V2-P3-01` 统一表演舞台（2D/Live2D/VRM/OBS 无缝切换、试演原创唱跳+双语歌词时钟、NC 直播版权拦截）与 `V2-P2` 资产/Blender/星露谷 Mods 兼容实盘摘要 |
| [App.tsx](../../../apps/desktop-host/src/renderer/director/App.tsx) | 默认切换 `skin='tidepaper'` / `themeMode='light'` / `accent='coral'` 并持久化；兼容 `Shift+Esc` 与 `F8` 急停，命令面板新增多皮肤快捷切换 |

---

## 2. 实测验证结果（2026-11-26）

- `pnpm typecheck` & `pnpm --filter @workbench/desktop-host build`：退出码 `0`（Tailwind CSS v4 编译 51ms）
- `pnpm verify:gate`：**7/7 PASS**（284 个源文件许可证/密钥零违规、全仓单测 ≥90% 分支覆盖、Gate 4 回环 0.3s）
- Electron 45 E2E Part 1（[v2-obsidian-ui.e2e.spec.ts](../../../apps/desktop-host/e2e/v2-obsidian-ui.e2e.spec.ts)、[desktop.e2e.spec.ts](../../../apps/desktop-host/e2e/desktop.e2e.spec.ts)、[v2-kernel.e2e.spec.ts](../../../apps/desktop-host/e2e/v2-kernel.e2e.spec.ts)）：**3/3 PASS**
  - 实测默认 `data-skin="tidepaper"` + `data-accent="coral"`、实时切换 `obsidian-tide` / `tide-deep` / `sea`、`vrm-3d` 切换、原创唱跳歌词同步与零 `pageerror`。
- Electron 45 E2E Part 2（[ui.e2e.spec.ts](../../../apps/desktop-host/e2e/ui.e2e.spec.ts)）：**8/8 PASS**（验证 Tidepaper 晨雾与夜潮双模式下的 `--text-3` / `--green` ≥4.5:1 WCAG AA 对比度）。
