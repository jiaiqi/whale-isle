# 鲸屿 Whale Isle · 潮汐纸 Tidepaper 设计规范（主 UI/UX 参考基线）

> 依据：`docs/v2/blueprint/*`（V2 蓝图 + V2.1 自主游戏）、`docs/PRODUCT-DESIGN.md`（D1–D16 用户决策）、`docs/ROADMAP.md`（已实现功能）。  
> **定位声明（[ADR-003](../../docs/v2/adr/ADR-003-uiux-tidepaper-primary-and-themes.md)）**：本目录是 Whale Isle V2 的**主 UI/UX 参考设计高保真原型**（原 `design/v3/`），`design/theme-obsidian-tide/`、`design/theme-tide-deep/` 与 `design/theme-obsidian-v4/` 保留为**可选主题**。**本原型仅作高保真参考，实际 Electron + React 开发须结合真实后端成熟度、硬件边界、性能与无障碍需求因地制宜演进，严禁照搬未接线空壳或伪造指标。**  
> 本目录为纯静态 HTML + `tokens.css` + `shell.js` + lucide，双击任意 HTML 用 Chrome 打开即可。

---

## 1. 设计理念

**一张会呼吸的海图。** 前两版（v2 深海玻璃、v2-gemini）偏「仪表盘 / 科技感」。v3 换了一个方向：鲸屿首先是**一个角色的生活**，其次才是工具。所以：

| 关键词 | 落地方式 |
| --- | --- |
| **纸面 · 编辑感** | 暖白纸底 `--bg #F3EFE7`、墨蓝字 `--ink-1 #142036`；标题与关键数字用**衬线体**（Songti / Iowan），正文系统无衬线，数据等宽。像在读一本角色的日记，而不是看监控大屏。 |
| **珊瑚落日点睛** | 全站只有一个强调色 `--accent`（默认珊瑚 `#E5603F`，可切换 海蓝/鲸蓝/苔绿/紫藤）。主操作用墨色实心按钮，强调色只给「角色在场」「当前项」「最重要的那一个按钮」。 |
| **角色先于功能** | 首页先讲「她现在在干什么、心情如何、为什么这么做」，再讲指标。每个页面都尽量出现小鲸真实动作素材（`packages/pet-renderer` 的 114 个 VP9-Alpha webm）。 |
| **诚实** | 回执芯片 `COMPLETED / IN_PROGRESS / UNCERTAIN / FAILED` 语义永不弱化；证据标签区分 `SIMULATION` / `REAL-DEVICE` / `E2E-HOST`；许可证徽章与「NC 素材不可商用直播」阻断随处可见；无法读取的额度显示「未知」。 |
| **控制权永远在用户手里** | 顶栏常驻「停止 ⇧Esc」；游戏页四模式 HUD；所有 P4/P5 副作用汇入「审批收件箱」。 |
| **夜潮** | 暗色不是简单反色：深墨蓝底 + 暖白字 + 提亮的海图色，适合夜间与直播。 |

## 2. 文件结构

```
design/tidepaper/
├── tokens.css        设计令牌 + 全部组件（页面不得重复定义）
├── shell.js          外壳（侧栏/顶栏）、主题、⌘K、审批收件箱、紧急停止、通用交互接线
├── vendor/lucide.min.js
├── index.html        原型目录（封面）
├── home.html         总览（参考实现，新页面请先读它）
├── chat / character / voice / memory
├── embodiment / pet-stage(独立窗) / tray(独立窗)
├── game / knowledge / live / obs-overlay(独立窗) / life / remote(独立窗)
├── studio / assets / providers / plugins / harness / devices
└── security / evolution / settings / onboarding(独立窗)
```

## 3. 页面骨架

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>页面名 · 鲸屿 Whale Isle</title>
<link rel="stylesheet" href="tokens.css">
<style>/* 仅页面布局与页面专属小组件，一律使用 var(--token) */</style>
</head>
<body data-page="game" data-crumb="生活 / 游戏共玩">
<main class="page">
  <div class="page-head"> <div class="t"><div class="eyebrow">…</div><h1>…</h1><p>…</p></div> <div class="actions">…</div> </div>
  …
</main>
<!-- 浮层直接放 body 下：.modal / .drawer / .menu（shell 会自动保留在外壳外） -->
<script src="vendor/lucide.min.js"></script>
<script src="shell.js"></script>
<script>/* 页面交互 */</script>
</body></html>
```

- 独立窗口（桌宠舞台、OBS、托盘、手机远程、首次引导）：`<body data-shell="none">`，不生成侧栏。
- `data-page` 必须与 shell.js `NAV` 中的 id 一致：`home chat character voice memory embodiment pet-stage game knowledge live life studio assets providers plugins harness devices security evolution settings`。
- 宽页面（如直播导演台、游戏页）可用 `<main class="page wide">`；全幅工作台可用 `.page.flush`。

## 4. 组件速查（全部在 tokens.css）

| 类别 | 类名 |
| --- | --- |
| 排版 | `h1 h2 h3 h4` `.display` `.eyebrow` `.muted .faint .small .tiny` `.mono` `.num`（衬线等宽数字） `.serif-quote`（内心戏/引用） `.t-coral/.t-sea/...` |
| 布局 | `.row(.top/.wrap/.between)` `.col` `.stack-8/12/16/24` `.gap-*` `.spacer` `.grid .g2 .g3 .g4 .g5` `.span-2/3/all` |
| 页头 / 区块 | `.page-head > .t + .actions`；区块标题 `.sec > h2 + .line + .aside` |
| 卡片 | `.card` + `.pad/.pad-lg/.raised/.sunken/.ghost/.hover/.selected/.ink/.tint-{coral,sea,whale,sun,plum,kelp,rose}`；结构 `.card-h > h3 + .sub + .tools`、`.card-b`、`.card-f` |
| 指标 | `.stat > .k .v(small) .d(.up/.down)` |
| 按钮 | `.btn` + `.primary`（墨色主操作）`.accent`（全页最多 1–2 个）`.ghost .soft .danger .danger-soft` 尺寸 `.xs .sm .lg .icon`；`.btn-group`；紧急停止 `.btn-stop` |
| 标签 | `.chip` + 色 `coral sea whale kelp sun plum rose accent ink outline` + `.sm/.lg`；可点 `.chip.click`（容器 `data-chips="single|multi"`） |
| 状态 | `.dot.ok/.warn/.err/.info/.live/.sea/.plum` + `.pulse`；`.kbd` |
| 回执 | `.receipt.completed / .progress / .uncertain / .failed / .played / .queued`（文案大写英文） |
| 许可 | `.lic.mit / .apache / .ncsa / .devonly / .gpl / .unlicensed / .blocked / .own` |
| 证据 | `.evi.sim`（SIMULATION）`.evi.real`（REAL-DEVICE）`.evi.host`（E2E-HOST）`.evi.pending`（待真机） |
| 权限 | `.perm.p0 … .p5` |
| 记忆 | `.mem.working / .episodic / .semantic / .relational / .self` |
| 表单 | `.field > label + .input/.select/.textarea + .hint`、`.input-group`、`.switch(.sm) > input + .tr`、`.seg > button(.on)`、`.tabs > button(.on)`、`input.range`（`data-out="#id" data-unit="%"`）、`.check > input` |
| 数据 | `.meter(.thin/.thick/.striped) > i` 用 `style="--v:60%"` + 色 `sea kelp sun rose whale plum ink`；`.kv`(dl)；`.table(.click)`；`.list > .li(.click/.on) > .ic + .body(b+span)`；`.tile(.sm/.lg) + 色`；`.avatar(.sm/.lg) + .c1…c6` |
| 叙事 | `.bubble.ai / .user / .think / .sys`；`.timeline > .tl-item(.ok/.warn/.err/.now) > .tm`；`.steps > .step(.done/.now/.fail) > .n` + `.step-line(.done)`；`.callout.info/.warn/.danger/.ok` |
| 其他 | `.code`（.k .s .n .c 高亮）`.wave-bars(.live) > i style="--h:40%;--i:3"`、`.orb.{speaking,thinking,gaming,singing,resting,listening,offline} > .core`、`.empty`、`.skeleton`、`.typing > i*3`、`[data-tip="提示"]` |
| 浮层 | `.modal(.lg) > .modal-h/.modal-b/.modal-f`、`.drawer(.lg) > .drawer-h/.drawer-b/.drawer-f`、`.menu > button / .sep`、`.toast`（用 JS） |
| 动效 | `.rise .rise-1…6` 入场；`@keyframes float / breathe / blob / eq / ticker / slide-in` 可直接复用 |

## 5. 交互接线（shell.js 自动处理，零 JS）

| 写法 | 效果 |
| --- | --- |
| `<div class="tabs" data-group="g"><button class="on" data-tab="a">` + `<div class="tab-panel on" data-panel="a" data-group="g">` | 页签切换 |
| `<div class="seg" data-group="g"><button data-v="x">` + `[data-panel="x"][data-group="g"]` | 分段切换（无 group 时仅切换高亮，并派发 `change` 事件，`e.detail` = 值） |
| `data-open="id"` / `data-close` | 打开 / 关闭 `.modal` 或 `.drawer` |
| `data-toast="文案" data-kind="ok|warn|err|info" data-icon="lucide名"` | 轻提示 |
| `data-menu="menuId"` | 在元素下方弹出 `.menu` |
| `data-href="x.html"` | 整块可点击跳转 |
| `<video data-clip="待机呼吸休闲" autoplay loop muted playsinline>` | 自动指向桌宠素材 |

JS API：`WI.toast(msg, kind, icon)`、`WI.open(id)`、`WI.close()`、`WI.clip(name)`、`WI.halt()`、`WI.resume()`、`WI.wire(root)`（动态插入 DOM 后调用以接线 + 渲染图标）、`WI.icons()`、`WI.$ / WI.$$`、`WI.rnd(arr)`、`WI.setTheme / setAccent`。事件：`wi:halt`、`wi:resume`。

## 6. 统一事实（所有页面保持一致）

- **主角色**：小鲸 `char_xj01`，傲娇干饭蓝鲸女仆，Primary Runtime。「大肥鱼」是她的**雷区词**（触发 0.1s 喷水反驳 + 记仇账本）。被动桌宠：小柚 `char_xy02`、墨墨 `char_mm03`（Passive，只有形象/动画/基础声音）。
- **此刻**：2026-11-25 周三 22:14。星露谷「鲸屿农场」春 14 日 10:40，晴，明天雨；目标：浇完东侧防风草 → 皮埃尔买花椰菜种子；后天下矿。
- **端口**：消息总线 18760、OBS 叠加层 18765、BWF MCP 18088、泰拉瑞亚桥 18090、DST sidecar 18100。
- **模型**：主力 DeepSeek-V3.2；Magpie 六角色路由：对话 / 内心戏 / 游戏决策 / 记忆提炼 / 弹幕 / 视觉复盘；备选 Kimi K2、GLM-4.6、Qwen3、Claude（经 Harness）；TTS：本地 GPT-SoVITS v2（5 组情绪参考音）→ SiliconFlow 云端降级；歌声：RVC v2 + Demucs；图片：Codex CLI / 在线图片 API；3D：Hunyuan3D + Blender 后处理。
- **饭碗**：每日 ¥18，已吃 ¥5.76，剩 68%；<15% 播 `余额-分文不剩`。
- **游戏**：星露谷（BWF Mod 主线）、泰拉瑞亚（tModLoader terraria-bridge）、饥荒 DST（服务器侧 Lua + sidecar）。控制模式：自主 / 协作 / 指令 / 手动接管；优先级：紧急停止/接管 > 强制命令 > 直接任务 > 共同计划 > AI 自主目标 > 待机；快捷键：`⇧Esc` 停止、`F8` 暂停/恢复、`T` 接管、`R` 交还。
- **直播**：抖音弹幕主线 dyhub；三级注意力 P0/P1/P2；同观众短时合并；送礼插队点歌；点歌须过曲库授权；OBS 叠加层。
- **记忆**：Working / Episodic / Semantic / Relational / Self；每条有来源、置信度、重要性、保留策略、固定标记；可查看 / 纠正 / 删除。
- **权限**：P0 读非敏感 → P5 私信/删除/支付（每次确认）。
- **进化**：独立工作区 `whale-isle-dev`；自主等级 L1–L5，默认 L1–L3；示例 PR #218 `fix(game): 背包满时评估建箱/整理而非固定回家`。
- **许可**：dsh-pet 形象素材 `CC BY-NC-SA 4.0` → `DEV_ONLY_NON_COMMERCIAL`；代码 MIT；dsh-video-storyboard Apache-2.0；Dsh_douyin/dsh-live 无许可证（只参考思想）；GPL 组件禁止 vendor。

### 桌宠素材名（`data-clip` 可用值，114 个中常用的）

待机呼吸休闲、工作状态-思考冒泡、工作状态-忙碌点按、工作状态-雀跃庆祝、工作状态-垂头叹气冒汗、工作状态-清点归档、工作状态-原地踱步张望、深度思考碎碎念、碎碎念-对屏碎碎念、碎碎念-发呆碎碎念、点击回应-元气挥手、点击回应-开心跃动、点击回应-傲娇生气、点击回应-害羞惊讶、点击回应-挠痒咯咯笑、被鼠标拖拽悬空反馈、玩水枪、玩游戏气急败坏、写代码、下五子棋、吃Token、吃饭·碗饭、吃晚餐、吃白饭、期待开饭、大口吃零食、余额-钱袋满溢、余额-钱袋如常、余额-数金皱眉、余额-袋空如洗、余额-分文不剩、优雅女仆舞、可爱宅舞、轻快摇摆舞、悠闲哼歌、小提琴演奏、吹笛子、女仆屈膝礼仪、睡觉-开始、睡觉-循环、睡觉-起来、原地小憩沉眠、哈欠连天、打瞌睡被惊醒、超大伸懒腰、开心小跑、螃蟹走路、东张西望、被吓一跳、拆礼物、收红包、放烟花、鲸鱼吐泡泡特效、蓝鲸现世、照镜子、整体换装试色、小幅度原地360度旋转展示、轻快记录、撸猫、萌化小幽灵、用鲸鱼尾巴拍打地面、凭空生花、扑克魔术。
（完整列表见 `packages/pet-renderer/assets/blue-whale-maid/`。素材四周留白较多，作为头像/卡片时建议 `transform: scale(1.5~1.8)`。）

## 7. 文案与视觉规则

1. 全中文界面，专有名词保留英文（MCP、Skill、Harness、Provider、PR）。文案具体、有角色温度，**禁止 lorem / 「示例文本」**。
2. **禁止 emoji**，图标一律 lucide（`<i data-lucide="name">`），图标语义：角色 `user-round`、化身 `shapes`、模型 `bot`、创作 `wand-sparkles`、游戏 `gamepad-2`、直播 `radio`、进化 `dna`/`git-branch`、安全 `shield-check`、凭证 `key-round`/`lock`、记忆 `database`、饭碗 `wheat`、停止 `octagon-x`。
3. 颜色只用 token 变量；插画/示意图允许局部自定义色，但需同时适配暗色。
4. 每页 `accent` 按钮 ≤ 2 个；主操作优先 `.btn.primary`。
5. 列表/卡片入场用 `.rise` 错峰；动效克制，持续动画只给「活着」的元素（在场、直播、执行中）。
6. 失败与不确定必须显眼；沙盒数据标 `SIMULATION`；未实测的平台能力标「待验证」。

## 8. 校验

```bash
# 截图（light/dark）并打印页面报错；检查图标名
node <scratch>/shot.js page.html light && node <scratch>/shot.js page.html dark 1440 0
node <scratch>/check-icons.js design/v3
```
