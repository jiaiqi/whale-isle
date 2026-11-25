# Whale Isle V2 — UI/UX 设计体系规范（潮汐纸 Tidepaper 主基线 + 多可选主题架构）

> **主设计资产源**：[design/tidepaper/](../../design/tidepaper/index.html)（**潮汐纸 Tidepaper** · 25 页全量可交互原型 · [SPEC.md](../../design/tidepaper/SPEC.md)）  
> **可选主题资产源**：[design/theme-obsidian-tide/](../../design/theme-obsidian-tide/index.html)（曜潮 Obsidian Tide，当前 `V2-P1-05` 运行基线） · [design/theme-tide-deep/](../../design/theme-tide-deep/index.html)（深海屿光 Tide v5） · [design/theme-obsidian-v4/](../../design/theme-obsidian-v4/index.html)（V1 Obsidian v4）  
> **决议依据**：[ADR-003](./adr/ADR-003-uiux-tidepaper-primary-and-themes.md)（2026-11-26 修订 [ADR-001](./adr/ADR-001-v2-foundation.md) 分歧 1：确立 Tidepaper 为主 UI/UX 参考基线，保留既有方案为可选主题）

---

## 一、设计理念与多主题切换架构

### 1.1 主基线：潮汐纸（Tidepaper）

鲸屿首先是一个 AI 角色的数字生活，其次才是控制面板。**潮汐纸（Tidepaper）** 采用「一张会呼吸的海图」作为主视觉隐喻：

1. **纸面 · 编辑感与字符秩序**：
   - **晨雾（Light，原型默认）**：暖白纸底 `#F3EFE7`、表层 `#FBF9F4`、墨蓝字迹 `#142036`、珊瑚落日点睛 `#E5603F`（支持珊瑚 / 海蓝 / 鲸蓝 / 苔绿 / 紫藤 5 种强调色切换）。标题与关键数字使用衬线体（`--font-display`），正文系统无衬线，ID/回执/延迟使用等宽字体（`tabular-nums`）。
   - **夜潮（Dark）**：深墨蓝底 `#0D1220` 与暖白字 `#EEE9DF`，提亮海图语义色，适配夜间长时陪伴与直播导演场景。
2. **角色先于功能**：总览页优先交代「小鲸此刻在每个身体里做什么、心情与内心戏、为什么这么做」，再呈现统计指标与系统健康；交互尽量联动真实角色动作素材（VP9-Alpha `.webm`）。
3. **语义化 Token 多主题架构**：
   - 实际前端工程通过语义化 CSS Token 驱动主题切换，将 **Tidepaper（晨雾 / 夜潮）** 作为默认主主题方向，并将 **Obsidian Tide（曜石深海 / 晨汐瓷白）**、**Tide Deep**、**Obsidian v4** 保留为**可选主题（Optional Themes）**，支持 `system` 自动跟随操作系统浅深色。
   - 不废弃 `V2-P1-05` 已拆分的 React 模块、IPC 通道与四大签名组件，按渐进方式演进样式令牌与新增视图。

---

## 二、绝对工程约束与原型落地边界

1. **原型仅供参考，严禁死板照搬**：`design/tidepaper/` 是高保真交互参考稿，展示完整产品愿景（Blueprint 01–17）；实际开发中必须结合当前模块的后端真实能力、性能预算（如 114 个 WebM 动画按需加载/懒加载）、多窗口硬件边界、可访问性及 Electron 实机反馈灵活调整与裁剪。
2. **零外网 CDN 图标依赖**：所有图标统一由本地 `lucide-react` / 离线图标包渲染，**禁止正文/按钮中使用彩色 Emoji 充当系统图标**。
3. **零虚假指标**：严禁渲染假码率、假观众数或编造余额；未接入后端或不可查询项必须显式展示「未接线 / 未知 / 不可查询 / 待真机验证」。
4. **证据口径诚实**：严禁把 `[SIMULATION]` 或 `[E2E-HOST]` 标成 `[REAL-DEVICE]`。

---

## 三、统一角色锚点与多独立硬件表面

1. **单一主角色锚点**：全局视觉与监控数据严格锚定主角色 **小鲸（`char_xiaojing` / 原型代号 `char_xj01`）**，被动伴侣（小柚 / 墨墨）仅展示弱存在感独立形象与基础配置，杜绝不同页面出现互相冲突的角色人设。
2. **独立渲染表面（按硬件边界解耦）**：
   - **中控台（`director`）**：负责身份、对话、角色、声音、记忆、化身动作库、游戏共玩、攻略心得、直播导演台、数字生活、创作工坊、资产库、模型与饭碗、插件/MCP/Harness、设备租约、安全与进化引擎。
   - **透明桌宠窗（`pet-stage`）**：独立无边框置顶透明窗，负责 WebM / Spritesheet（预留 Live2D / VRM）动画、鼠标像素级穿透（`ignoreMouseEvents`）、拖拽悬空反馈、双轨气泡（内心戏云朵 / 正式对话）、游戏状态气泡组与赛博饭碗挂件，**不强行嵌死在中控台内部**。
   - **托盘浮窗（`tray-popover`）**：独立约 `344–368px` 菜单栏快捷浮窗，负责即时状态、饭碗余量、安静/暂停/接管/开播快捷切与最近 3 条真实回执。
   - **OBS 叠加层与手机远程 WebUI（`obs-overlay` / `remote`）**：独立输出源与局域网远程陪伴/审批/遥控视图。

---

## 四、四大签名组件与全局快捷键契约

### 四大核心签名组件
1. **声呐 / 在场状态标识（Sonar / Presence）**：统一投射小鲸的 9 态即时表演状态（`idle / listening / thinking / speaking / singing / dancing / gaming / reacting / resting`），以 Embodiment Runtime 仲裁结果为准。
2. **四态回执芯片（Receipt Chip）**：严格区分 `IN_PROGRESS` / `COMPLETED` / `UNCERTAIN` / `FAILED`（语音复用 `PLAYED`），`FAILED` 与 `UNCERTAIN` 永远不允许被样式弱化为绿色；游戏与工具调用必须展示真实 Mod/进程回执。
3. **许可徽章（License Badge）**：直观标出 `MIT` / `APACHE-2.0` / `DEV_ONLY_NON_COMMERCIAL`（`CC BY-NC-SA 4.0`）/ `UNLICENSED` / `NO_LIVE_RIGHTS`，非商用素材进入商业发行或公开直播上下文时强制红色阻断确认按钮。
4. **控制权 HUD（Control Ownership HUD）**：置顶常驻显示设备级 `ComputerUseLease`、游戏角色级 `GameCharacterControlLease`（自主 / 协作 / 指令 / 手动接管）与活动级 `LifeActivityAuthority` 归属，提供一键停止与物理接管入口。

### 全局快捷键契约（支持用户自定义映射）
- **`⌘K` / `Ctrl+K`**：全局快速跳转、记忆/能力检索与命令面板。
- **`⇧Esc` / `F8`**：P0 紧急停手 / 暂停自主，立即中止在飞动作并将全部游戏与键鼠控制权退回人类用户（代码中保持与 `V2-P1-05` 既有绑定兼容并支持设置页重映射）。
- **`T` / `R`（或 `F9`）**：玩家物理接管角色与交还控制租约。
- **安静陪伴模式（如 `F10`）**：切换小鲸安静陪伴 / 睡眠静音，暂停主动发声与打扰。

---

## 五、IA 演进与 Strangler 渐进重构路径

- 推荐按「此刻 / 角色 / 化身 / 生活 / 创作 / 能力 / 治理」领域导航组织中控台（对齐 `design/tidepaper/` 完整布局与「六大产品世界」映射）；实际页面随后端模块真实可用度渐进上线，不一次空壳铺满未接线页面。
- 基于 `V2-P1-05` 已拆分的 `apps/desktop-host/src/renderer/director/` 模块，在 P2–P4 逐步将默认视觉令牌演进至 **Tidepaper** 并保留 **Obsidian Tide** 等为可选主题；所有控制按钮直连主进程内核 IPC（严禁绕过 `directorBridge` 与 `WhaleKernel`）。
