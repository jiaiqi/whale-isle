# Tidepaper v3.1「潮汐纸 · 精修」中控台外壳验证证据

> **关联设计基线**：[DESIGN-SYSTEM.md](../DESIGN-SYSTEM.md) · [design/tidepaper/](../../../design/tidepaper/index.html) · [ADR-003](../adr/ADR-003-uiux-tidepaper-primary-and-themes.md)  
> **分支**：`feat/tidepaper-v3.1`（基于 `feat/whale-isle-v2` @ `05707af`）  
> **诚实结论口径**：**`DONE`（视觉与外壳层）**。纸面材质、信息架构、三层控制权条、在场胶囊、角色卡与外観分段容器已在真实 Electron 45 中通过浅/深 × 多主题截图复核；全部既有 E2E 选择器、快捷键与 WCAG AA 约束保持不变。`ComputerUseLease` 尚未由 `V2-P3-03` 接线，界面如实显示「未接入 · P3」，不伪造归属。

---

## 1. 修改范围（业务源码 12 个，按 ≤ 8 铁律拆分为 4 个提交）

| 文件 | 变更内容 |
| --- | --- |
| [design-tokens.css](../../../apps/desktop-host/src/renderer/director/design-tokens.css) | 纸面材质重做：`.card` 改实底 + 细边 + 极轻阴影，玻璃模糊只保留给 `obsidian-tide` / `tide-deep`；`--map-contour` 静态海图等高线与 `--paper-noise` feTurbulence 纸纹；删除 `ambient` 漂移动画；新增页头、眉标、`.kbd`、`.seg`、`.btn-stop`、56px 顶栏、在场胶囊、三层控制权条、急停横幅、角色卡向上菜单、命令面板底栏与 `--ring` 焦点环；新增 `--halt-bg` / `--halt-ink`，暗色主题急停表面压深保证白字 ≥4.5:1 |
| [styles.css](../../../apps/desktop-host/src/renderer/director/styles.css) | 新增 `@source "./shell/page-head.tsx"`，确保 PageHead 的 Tailwind 工具类被扫描 |
| [shell/page-head.tsx](../../../apps/desktop-host/src/renderer/director/shell/page-head.tsx) | **新增**统一页头组件：眉标 + 衬线 H1 + 描述 + meta + actions，附 `PageShell` 内容容器 |
| [shell/sidebar.tsx](../../../apps/desktop-host/src/renderer/director/shell/sidebar.tsx) | IA 重组为 此刻 / 角色 / 化身 / 生活 / 能力 / 治理（空组自动隐藏）；墨色方块 brand；底部角色卡播放真实待机 WebM，向上弹出角色菜单（保留 `[data-character-switch]` / `[data-character-option]` / `aria-checked`），「主角色」徽标移至副行避免角色名截断 |
| [shell/topbar.tsx](../../../apps/desktop-host/src/renderer/director/shell/topbar.tsx) | 56px 纸面顶栏 + 面包屑 + 260px 搜索触发器；新增真实数据在场胶囊（桌面/直播/游戏，无数据时整体隐藏）；外观改为分段容器，保留 `[data-skin-picker]` / `[data-theme-toggle]` / `[data-theme-system]` 与全部语音/大脑/游戏属性 |
| [shell/command-palette.tsx](../../../apps/desktop-host/src/renderer/director/shell/command-palette.tsx) | 受控查询；以 `>` 开头时顶部强制渲染「发给小鲸：…」并调用 `onSay`；新增底部快捷键提示条 |
| [v2/signature-widgets.tsx](../../../apps/desktop-host/src/renderer/director/v2/signature-widgets.tsx) | `ControlOwnershipHud` 重做为三层租约条（活动 · LifeActivity / 游戏角色 · GameCharacter / 桌面键鼠 · ComputerUse）；急停改为整条 rose 横幅 + 白色声呐；新增可选 `computerLease` 视图，未传入时如实标注「未接入 · P3」；全部 `data-v2-*` 选择器保留 |
| [App.tsx](../../../apps/desktop-host/src/renderer/director/App.tsx) | 接入 `CommandPalette.onSay`；Toaster 使用 `.wb-toast-item` 纸面样式 |
| [views/life-console-view.tsx](../../../apps/desktop-host/src/renderer/director/views/life-console-view.tsx) | Hero 改为 `PageHead`：眉标、衬线标题、描述与 `char_xiaojing` / 许可 / 存储 meta；活跃目标与主仆约定改为标题单行省略 + 右侧状态 chip，移除横向滚动 |
| [memory-panel.tsx](../../../apps/desktop-host/src/renderer/director/memory-panel.tsx) | 页头改 `PageHead`；Canvas 图谱颜色改为运行时解析 CSS token（事件=`--whale`、日记=`--green`、实体=`--amber`、概念=`--violet`），图例与颜色一致 |
| [plugins-panel.tsx](../../../apps/desktop-host/src/renderer/director/plugins-panel.tsx) | 页头改 `PageHead`，统一 `wb-page` 间距 |
| [providers-panel.tsx](../../../apps/desktop-host/src/renderer/director/providers-panel.tsx) | 页头改紧凑 `PageHead`，导入按钮与「服务商配置 / 默认模型」分段控件收进 actions |

**未改动**：`bridge.ts`、`preload`、`v2-kernel-host.ts`、`shared-protocol`、`runtime-core`。

---

## 2. 实测验证结果（2026-11-26）

### 2.1 类型、构建与准入门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`（`tsc -b`） | 退出码 `0`，零错误 |
| `pnpm --filter @workbench/desktop-host build` | 成功（main / preload / pet-stage / director + pet assets；Tailwind v4 编译约 48ms） |
| `pnpm verify:gate` | **7 过 / 0 跳 / 0 待接线**（Gate 1 类型与边界、Gate 1 Python、Gate 2 许可证与密钥 287 文件 0 违规、Gate 2 依赖漏洞 0 high/critical、Gate 2 DST Lua、Gate 3 确定性单测 1578 项、Gate 4 回环契约 0.4s） |

> 说明：worktree 首次门禁曾因缺少被 `.gitignore` 忽略的 CrossPet 角色包与已编译 `WhaleIsleAvatar.dll` 而红 4 项；补齐本机资产后 9/9 专项通过，完整门禁 7/7。此为 worktree 环境差异，不是源码回归。

### 2.2 Electron 45 E2E（真实客户端，`[E2E-HOST]`）

| 套件 | 结果 |
| --- | --- |
| `desktop.e2e.spec.ts` + `v2-kernel.e2e.spec.ts` + `v2-obsidian-ui.e2e.spec.ts` | **3/3 PASS**，7.34s |
| `ui.e2e.spec.ts` | **8/8 PASS**，14.31s |

`ui.e2e.spec.ts` 在既有「深浅主题 token 对比度」用例内新增急停表面断言：普通态 `.btn-stop`、其 `.kbd`、急停态 `.wb-halt-copy` 与 `[data-v2-hud-resume]` 均按浏览器实际计算色（含半透明叠层合成）计算，阈值 ≥4.5:1，晨雾与夜潮各跑一轮。

覆盖并保持不变的关键契约：`.wb-shell[data-skin|data-accent|data-theme-mode]`、`[data-tab][data-active]`、`[data-character-switch]`（innerText 含角色名）、`[data-character-option][aria-checked]`、`[data-voice-toggle][data-voice-backend]`、`[data-brain-toggle][data-brain-fallback][data-brain-model]`、`[data-game-picker]` / `[data-game-option]` / `[data-autodrive-toggle]`、`[data-skin-picker]` / `[data-skin-option]`（点击关闭）、`[data-accent-option]`（点击不关闭）、`[data-theme-toggle]` / `[data-theme-system]`、`[data-v2-control-hud][data-halted]`（非急停 innerText 含 `char_xiaojing`）、`[data-v2-hud-halt|resume|takeover|sleep]`、`[data-v2-sonar-ring]`、`data-testid="human-control-bar"`、`F8` / `F9` / `F10` / `⇧Esc` / `⌘K`。

> 环境备注：共享 `e2e-profile` 在残留 Electron 进程未退出时，整套运行偶发在启动阶段等待窗口超时（同一用例单独运行均通过）。清理残留进程后整套 8/8 通过，未观察到断言失败。

### 2.3 WCAG AA 对比度

**主题文字令牌（`--text-3` / `--green` vs `--surface-solid`）**

| 主题 | `--text-3` | `--green` |
| --- | --- | --- |
| Tidepaper 晨雾 | **5.94:1** | **5.89:1** |
| Tidepaper 夜潮 | **5.22:1** | **7.82:1** |
| Obsidian Tide | **5.15:1** | **8.40:1** |
| Tide Deep 暗 | **5.71:1** | **8.81:1** |
| Tide Deep 亮 | **5.42:1** | **5.69:1** |

**急停表面（修正前 → 修正后）**

| 表面 | 修正前 | 修正后 |
| --- | --- | --- |
| 晨雾急停横幅 / 急停 F8 按钮 | 5.82:1 | **5.82:1**（`#be2b41` + 白字） |
| 晨雾急停 F8 的 `F8` 键帽 | 5.82:1（白底白字叠层偏浅） | **7.76:1**（黑 18% 键帽 + 白字） |
| 夜潮急停横幅 / 急停 F8 按钮 | **2.74:1（不达标）** | **5.43:1**（`color-mix(in srgb, var(--rose) 68%, #000)` + 白字） |
| 夜潮急停 F8 的 `F8` 键帽 | 约 3.3:1（不达标） | **7.29:1**（黑 18% 键帽 + 白字） |
| 夜潮「恢复自主」白底按钮 | 2.74:1（rose 字） | **5.43:1**（深 rose 字） |

全部 ≥ 4.5:1；暗色压深规则覆盖 Tidepaper / Obsidian Tide / Tide Deep 所有暗色皮肤。

### 2.4 视觉 QA 截图（`[E2E-HOST]`，1440×920，无 `pageerror`）

目录：`artifacts/tidepaper-v3.1/`（本地 QA 产物，未入库）

- 晨雾：`life-mist.png`、`chat-mist.png`、`game-mist.png`、`providers-mist.png`、`plugins-mist.png`、`memory-mist.png`
- 夜潮：`life-night.png`、`chat-night.png`、`game-night.png`、`providers-night.png`
- 可选主题：`life-obsidian.png`、`game-obsidian.png`、`providers-obsidian.png`
- 状态：`halt-mist.png`、`halt-night.png`、`cmdk-say-mist.png`、`character-menu-mist.png`

复核结论：浅/深两套纸面均无模糊脏边；等高线与纸纹在可选玻璃主题下自动关闭；夜潮急停横幅已压深为深 rose，白字与「恢复自主」均清晰；生命中枢目标 / 约定列表为单行省略 + 右侧状态 chip，无横向滚动；`⌘K` 的 `>` 直达与焦点环正常。

---

## 3. 设计决策与改进

1. **纸面优先于玻璃**：Tidepaper 基线取消 `backdrop-filter`，改为实底卡 + 1px 细边 + 极轻阴影，避免长列表滚动时 GPU 负担与「雾面脏边」；`obsidian-tide` / `tide-deep` 仍保留玻璃语言，主题差异更明确。
2. **静态海图而非漂移动画**：等高线与纸纹为静态背景，`prefers-reduced-motion` 下角色卡视频隐藏并回退「鲸」字，减少持续合成开销。
3. **控制权条按真实可用度分层**：活动与游戏角色租约来自真实快照；`ComputerUseLease` 在 `V2-P3-03` 接线前显示「未接入 · P3」，并注明待接入工单，不用占位数据冒充。
4. **在场胶囊不猜测**：仅在有真实桌宠窗口、直播快照或游戏进程时显示，无数据时整体隐藏。
5. **页头统一**：四个页面共用 `PageHead`，眉标使用 11px 小型大写 + 图标，H1 使用 27px 衬线，建立编辑感层级。

---

## 4. 遗留问题与待接线

1. **`ComputerUseLease` 待接线（条件未满足）**：2026-11-26 10:41 检查 `git fetch` 与 `git log feat/whale-isle-v2`，最新仍为 `05707af`（`V2-P3-02`），`V2-P3-03` 尚未提交。条件满足后：rebase 到最新 `feat/whale-isle-v2`，按 [ADR-004](../adr/ADR-004-input-preemption-scope.md) 读取 `window.directorBridge.v2AutoSnapshot()` 的真实租约，传入 `ControlOwnershipHud.computerLease`；读取失败时回退「未接入 · P3」。
2. **空状态插画待接入（条件未满足）**：同一时点检查 `apps/desktop-host/assets/illustrations/` 在主工作区与 worktree 均不存在。Codex 产出 `*-light.webp` / `*-dark.webp` 后，需在 `scripts/build.mjs` 增加复制，并在 chat / memory / game / live / halted 空态按 `data-theme-mode` 切换。
3. **E2E 共享 profile 抖动**：整套 `ui.e2e.spec.ts` 在残留 Electron 未退出的机器上可能启动超时；建议 CI 在套件前后清理残留进程，或为每个用例分配独立 profile。该问题与本次 UI 改动无关。
4. **未做真机目视**：本轮视觉证据为 `[E2E-HOST]` 截图，真机高 DPI / 多显示器下的纸纹观感仍需 `[REAL-DEVICE]` 补验。
