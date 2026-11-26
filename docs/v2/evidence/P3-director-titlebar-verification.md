# 中控台 macOS 自绘窗口顶栏验证证据（owner 直接反馈）

> **触发**：owner 2026-11-26 反馈——中控台在 macOS 深色模式下沿用系统原生标题栏，是一条黑条，与 Tidepaper 暖色浅底内容割裂；要求顶栏自绘并跟随软件主题，但**必须保留系统红绿灯**（关闭/最小化/缩放），不做假按钮。
> **分支**：`feat-console-titlebar-self`（PR #2，已 rebase 到最新 `origin/feat/whale-isle-v2`；不自动合入主线）。
> **诚实口径**：macOS 上已用真实 Electron 45 窗口 + 真实鼠标事件（CGEvent）复核拖动、双击缩放与全屏；Windows / Linux 仅改回退策略（保留原生边框），**没有真机执行**，不得按已通过理解。

---

## 1. 修改范围（业务源码 5 个，≤ 6 上限）

| 文件 | 变更 |
| --- | --- |
| [main/index.ts](../../../apps/desktop-host/src/main/index.ts) | `createDirectorWindow` 仅在 `process.platform === 'darwin'` 时加 `titleBarStyle: 'hiddenInset'` + `trafficLightPosition: { x: 18, y: 14 }`；Windows/Linux 保持原生边框。决策依据写进函数上方注释（Windows 的 `titleBarOverlay` 需按主题双向同步按钮区、且没有 macOS「双击=系统缩放」语义；Linux 各 WM 支持不一）。桌宠窗与托盘浮窗未动。 |
| [renderer/director/shell/titlebar.tsx](../../../apps/desktop-host/src/renderer/director/shell/titlebar.tsx) | **新增** 40px 自绘顶栏：左侧 80px 红绿灯安全区 + 鲸屿品牌（mark + 字标）+ 右侧窗口级标签「桌面中控台」；整条 `-webkit-app-region: drag`，无交互子元素故不需要 `no-drag`。`usesCustomTitleBar()` 用 `navigator.platform||userAgent` 判定是否渲染（只影响布局，不参与安全决策，因此不新增 IPC）。 |
| [renderer/director/App.tsx](../../../apps/desktop-host/src/renderer/director/App.tsx) | macOS 时渲染 `<TitleBar />`、给 `.wb-shell` 加 `has-titlebar`、并让侧栏 `showBrand={false}`（品牌移到顶栏，避免 40px 内出现两次「鲸屿」）。 |
| [renderer/director/shell/sidebar.tsx](../../../apps/desktop-host/src/renderer/director/shell/sidebar.tsx) | 导出 `BrandMark` 供顶栏复用；新增 `showBrand` 开关（默认 true，Windows/Linux 行为完全不变）。 |
| [renderer/director/design-tokens.css](../../../apps/desktop-host/src/renderer/director/design-tokens.css) | Shell 网格新增 `titlebar` 行（`--titlebar-h` 默认 0，`.has-titlebar` 时 40px）；`.wb-titlebar` 背景/边框/文字全部走 `--bg` / `--stroke` / `--text-1..3`，玻璃主题沿用与 `.wb-top` 相同的 `color-mix + backdrop-filter`；侧栏无品牌时补 8px 顶部呼吸位。 |

未改动：`preload`、`bridge.ts`、`shared-protocol`、桌宠窗口、托盘浮窗、气泡相关文件。

---

## 2. 自动化门禁与 E2E

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（`tsc -b`，零错误） |
| `pnpm --filter @workbench/desktop-host build` | 通过（main / preload / pet-stage / director） |
| `pnpm verify:gate` | **7 过 / 0 跳 / 0 待接线**（Gate 1 类型与边界、Gate 1 Python、Gate 2 许可证与密钥、Gate 2 依赖漏洞、Gate 2 DST Lua、Gate 3 确定性单测、Gate 4 回环契约） |
| `pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/ui.e2e.spec.ts apps/desktop-host/e2e/v2-obsidian-ui.e2e.spec.ts` | **2 文件 / 10 用例 PASS**，31.04s（既有选择器、快捷键、主题对比度断言全部保持） |

---

## 3. 真机验证（macOS 26 本机，Electron 45）

> 方式：`PET_STAGE_E2E=1` + `--use-mock-keychain` 启动真实宿主，Playwright 驱动渲染层，窗口操作使用真实 CGEvent（鼠标点击/拖拽）；整窗截图用 `screencapture -R <窗口 bounds>` 获取，含系统红绿灯。

| 项目 | 结果 |
| --- | --- |
| 几何 | `[data-wb-titlebar]` = `{ x:0, y:0, w:1360, h:40 }`；`.wb-top` y=40、`.wb-side` y=40；侧栏内 `.wb-brand` 数量 0（品牌只在顶栏出现一次）；`padding-left: 80px`、`-webkit-app-region: drag` |
| 主题一致性 | 浅色顶栏 `color(srgb 0.9561 0.9412 0.9110)` 与 `.wb-top` 完全一致、与侧栏差值 < 0.001；深色顶栏 `color(srgb 0.0541 0.0745 0.1310)` 与 `.wb-top` 完全一致。截图见下 |
| 红绿灯 | 系统按钮原生绘制（AX 树含 close / minimize / full screen 三键）；灯组圆心落在 40px 中线（y=20），灯组右缘约 74px，与 80px 安全区不重叠 |
| 拖动 | CGEvent 从顶栏 (700,20) 按住拖到 (760,130)：窗口 bounds `(280,46) → (340,125)`，确实移动 |
| 双击缩放 | CGEvent 双击顶栏：`isMaximized() false → true`，bounds `1360×860 → 1920×956`（系统 zoom，**不是全屏**）；再次双击恢复 `1360×860`（可逆） |
| 全屏 | `setFullScreen(true)` → bounds `1920×1080`，系统红绿灯隐藏，顶栏完整位于 y=0 且无遮挡；退出全屏可恢复 |
| 截图 | 本地 `artifacts/director-titlebar/`（未入库）：`titlebar-light.png`、`titlebar-dark.png`、`titlebar-fullscreen.png`；纯内容截图 `web-light.png` / `web-dark.png` |

---

## 4. 平台回退与未验证项

1. **Windows / Linux 未真机执行**：两平台保留 `frame: true` 原生边框，渲染层不渲染 40px 顶栏、侧栏保留原有品牌行，代码路径与改动前一致；但仍需 Windows 11 / Linux 真机确认（按 T-M6-60 的既有待办口径）。
2. **无边框窗口的系统菜单**：`hiddenInset` 下窗口不再有原生标题文字；`title` 仍为「鲸屿 · 中控台」（Dock/任务切换可见），未新增自绘窗口菜单。
3. **全屏下的 80px 左侧留白**：系统红绿灯在全屏时隐藏，留白保留但无遮挡；是否在全屏时回收该留白留待 owner 观感决定。
4. **高 DPI / 多显示器**：截图在本机 Retina 2x 下取得，未覆盖外接非 Retina 屏与跨屏拖动。

---

## 5. rebase 到最新主干后的复验（2026-11-26）

- **基线**：`origin/feat/whale-isle-v2` @ `54b2322`（已含表现力语音方案、引擎下载器、`P3-04G` 自主社交调度器/执行器、OBS selfcheck 修复等 8 个提交）。
- **方式**：rebase（非 merge），本单提交重放后 SHA = `f8b4425`，历史保持线性。
- **冲突 2 个文件，均双方保留**：
  - `CHANGELOG.md`：主干新增的「引擎下载器 + 本地引擎安装判定」「自主社交发起策略 `P3-04G`」两节原样保留在前，本单顶栏一节接在其后，再接原有「单桌宠全链路 E2E」节。
  - `docs/VERIFY.md`：主干新增的 `P3-04G` 自主发起策略、本地语音引擎安装判定两行与真机待验三行全部保留，本单的顶栏验证行与 Windows/Linux 待验行追加在各自表尾。
  - 自动合并（无冲突）：`apps/desktop-host/src/main/index.ts`（主干只改桌宠气泡订阅，本单只改 `createDirectorWindow`）、`docs/v2/CURRENT.md`（本单小节改为 §6 置于主干 §5 之后）。
- **复验结果**：`pnpm verify:gate` **7 过 / 0 跳 / 0 待接线**（Gate 2 扫描文件数 319 → 322）；`ui.e2e` + `v2-obsidian-ui.e2e` **2 文件 10 用例 PASS**（30.36s）；顶栏几何与配色和 rebase 前完全一致（40px、浅色 `color(srgb 0.9561 0.9412 0.9110)`、深色 `color(srgb 0.0541 0.0745 0.1310)`、`padding-left: 80px`、`drag`），CGEvent 真机复核双击 zoom/unzoom（1920×956 可逆）、拖拽 `(280,46)→(340,125)`、全屏 1920×1080 红绿灯隐藏且顶栏无遮挡。截图：`artifacts/director-titlebar/post-rebase-{light,dark,fullscreen}.png`（本地未入库）。
