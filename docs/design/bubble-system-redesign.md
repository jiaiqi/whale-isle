# Whale Isle `pet-stage` 气泡系统重设计说明

## 一、现状痛点与精修目标

1. **尺寸与位置受限**：旧版宽度上限固定为 `Math.min(stage.width * 0.46, 220)`（在 400px 舞台下仅 `184px`），且 `thought`/`dialog` 位置僵化，不感知角色朝向与悬浮挂件。
2. **首版反馈聚焦的 4 项精修**：
   - **连续融合尾巴**：消除尾巴与气泡轮廓的断开/贴片感，改用单条闭合 SVG 路径让尾巴从气泡边缘连续长出，支持上/下/左/右 8 向朝向；`thought` 保留虚线与更精致的 3 粒递减飘点；
   - **恢复原右下角半透蓝泡（`legacy`）**：保留原先右下角的经典半透明蓝玻璃对话泡作为独立第 7 种类型，并接入真实触发源；
   - **数据驱动情绪气泡变体**：在 7 种语义气泡外，使用数据驱动查表新增 7 种情绪样式（开心、生气、困倦、惊讶、思考、撒娇、害羞）；
   - **可商用随包字体扩展**：保留默认 `ShangShouGummy` 字体，新增手写感、圆体、正式体 3 类 SIL OFL 1.1 完整字库 WOFF2 随包分发，并配齐回退链防止豆腐块。

---

## 二、7 种语义气泡与连续融合尾巴（Q 版像素蓝鲸女仆 × Tidepaper）

所有气泡统一采用零彩色 Emoji 策略（纯内联 SVG 徽标）、`pointer-events: none`、`z-index: 7`（位于角色视频之上、任务卡 `z8` 与参考线 `z9` 之下），并在省电模式关闭模糊与阴影。

### 2.1 单条闭合 SVG 连续融合外壳原理（`buildBubbleShellPath` + `.pet-bubble__shell`）

- 每个气泡节点包含三层结构：`.pet-bubble__glass`（承载 `backdrop-filter` 毛玻璃并使用相同路径裁剪 `clip-path: path(...)`）、`.pet-bubble__shell`（四周各扩展 `pad = 14px` 绘区）、`.pet-bubble__body`（图标 + 文本 + 静音角标）。
- `buildBubbleShellPath` 按真实 DOM 尺寸生成**唯一一条 `M ... Z` 闭合路径**：在气泡四条边的对应方位切出贝塞尔入口，经控制点平滑拉出尾巴尖端再切线接回边线，不存在任何分离三角形或描边断点。
- `resolveTailDirection` 基于气泡中心/上下缘与角色头部锚点 `(xRatio, headYRatio)` 的相对坐标，动态计算 `bottom-left / bottom-center / bottom-right / top-left / top-center / top-right / left / right / none`。
- `thought` 类额外调用 `buildThoughtCloudDots` 在 8 方向生成 3 颗递减半径（`4.1 / 2.8 / 1.7`）的虚线描边思绪云粒。

### 2.2 7 种语义类型清单

| 语义类型 (`PetBubbleKind`) | 触发源 | 视觉语言（白/暗桌面均高对比） | 尾巴/挂饰 | 默认自动隐藏 | 优先级 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `reaction`（即时反应） | `reflex_*` 反射台词、互撞、戳脸/摇晃吐槽、彩蛋被抓 | 珊瑚星芒漫画泡：暖白珊瑚渐变 + 2px `#eb6b4b` 边框 | `sharp` 连续尖尾 | `6s` | 7（最高） |
| `dialog`（正式对话） | `chat_reply`、`pet:bubble(dialog)`、`speakWithEmotion` | 海盐瓷对白泡：冰蓝白微透 + 蓝鲸边 + 毛玻璃（含静音角标） | `pointer` 连续对白尾 | `10s`（TTS 期间由语音租约托管） | 6 |
| `legacy`（经典蓝玻） | `pet:say`（本机说一句话）、`chat_order` 观众指令回执 | 经典半透深海蓝：`rgba(20,56,104,0.74)`→`rgba(13,35,68,0.80)`、`rgba(56,162,255,0.80)` 描边、`13px / 1.55`、`16px` 圆角、默认位于角色右下方且避让底部饭碗 | `pointer` 连续对白尾 | `10s`（支持静音角标） | 5 |
| `notice`（系统通知） | 大活完成皇冠、`pet:bubble(notice)` | 深靛海图便签：深蓝底 + 3px 暖金左边界 + 金铃铛 SVG | `none` | `8s` | 4 |
| `thought`（内心戏） | `autodrive decision.intent`、睡眠梦话、`pet:bubble(thought)` | 星雾紫云朵泡：渐变紫雾底 + `4.5 3` 虚线描边 + 云朵 SVG | `cloud`（3 粒递减云粒） | `12s` | 3 |
| `hint`（互动提示） | 每日问候/节日登场、摸头哄好台词、工作跟随姿态台词 | 清透海盐气泡：柔海天蓝底 + 海浪微星 SVG | `soft` 连续柔尾 | `9s` | 2 |
| `status`（状态播报） | 游戏时钟（`星露谷 ...`）、`pet:state` 状态同步 | 深海青胶囊：圆润胶囊 + 脉冲声呐圆点 + `tabular-nums` 等宽数字 | `none` | `16s` | 1 |

---

## 三、数据驱动情绪气泡变体（`BUBBLE_MOOD_THEMES` + `TRIGGER_TO_MOOD`）

情绪风格完全通过 `BUBBLE_MOOD_THEMES` 与 `TRIGGER_TO_MOOD` 查表驱动，严禁条件分支堆砌；`status` 与 `notice` 保持 `tailKind: 'none'` 以维持胶囊/便签语义识别度，其余气泡同步切换尾巴造型、色调、描边、内联 SVG 徽标与 `@keyframes` 入场动效。

| 情绪 (`PetBubbleMood`) | 触发源映射 (`TRIGGER_TO_MOOD`) | 视觉基调与描边 | 尾巴 (`tailKind`) | 入场动效 | 内联 SVG 徽标 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `happy`（开心） | `greeting`、`happy` | 暖杏金渐变 + `#eca12c` 描边 | `soft` | `whaleMoodBounce` | 闪烁四角星 |
| `angry`（生气） | `reflex`、`grudge`、`shake` | 炽红漫画暖底 + `#e04838` 粗边与硬阴影 | `sharp` | `whaleMoodShake` | 十字怒筋符号 |
| `sleepy`（困倦） | `sleep` | 深宵夜蓝微透 + 虚线淡蓝描边 | `cloud` | `whaleMoodDrift` | 弯月伴 Zz |
| `surprised`（惊讶） | `bump`、`egg` | 明黄提亮底 + `#e88b1a` 粗边 | `sharp` | `whaleMoodPop` | 双感叹号 |
| `thinking`（思考） | `decision` | 浅靛水彩底 + `#4f85c9` 虚线描边 | `cloud` | `whaleMoodFloat` | 思绪螺旋线 |
| `coquettish`（撒娇） | `poke` | 樱粉柔光底 + `#e86ea2` 粉边 | `soft` | `whaleMoodWiggle` | 粉红小爱心 |
| `shy`（害羞） | `coax` | 羞红浅绯底 + `#e98480` 柔边 | `soft` | `whaleMoodShy` | 脸颊腮红斜线 |

---

## 四、可商用随包字体扩展与许可清单（`BUBBLE_FONTS`）

通过 `PetDesktopPrefsSchema.bubbleFontId` 与 `widgets.setFont(fontId)` 切换气泡字体；经检测现有 `crosspet` 8 套子集字体仅含 1,402 字（缺「倦娇惊懒撒浇皇讶」等常用字），因此新增字体均采用 Google Fonts 官方 **SIL Open Font License 1.1** 完整字符集转换为 WOFF2 随仓库及构建产物（`apps/desktop-host/scripts/build.mjs` → `dist/renderer/pet-stage/fonts/`）分发，并在 `docs/THIRD_PARTY_NOTICES.md` 台账同步登记。

| 字体 ID (`PetBubbleFontId`) | 分类 / 字体名称 | 随包文件与构建路径 | 来源与许可口径 | 完整回退链 (`fallbackStack`) |
| :--- | :--- | :--- | :--- | :--- |
| `shangshou-gummy` | 默认 · 上首软糖体（`ShangShouGummy`） | `assets/pet-packs/fonts/上首软糖体.ttf`（`whale-pet://fonts/...`） | `dsh-pet` 随附（`DEV_ONLY_NON_COMMERCIAL`，仅本地开发自用，商用前须替换为自制/OFL 包） | `"ShangShouGummy","ZCOOLKuaiLe","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif` |
| `handwriting` | 手写感 · 龙藏体（`WhaleBubbleHandwriting`） | `apps/desktop-host/assets/fonts/long-cang.woff2`（`./fonts/long-cang.woff2`） | Google Fonts `ofl/longcang`，**SIL OFL 1.1**（允许商用与随包分发，见 `docs/licenses/long-cang-ofl-1.1.txt`） | `"WhaleBubbleHandwriting","Kaiti SC","STKaiti","KaiTi","PingFang SC","Microsoft YaHei",cursive,serif` |
| `rounded` | 圆体 · 站酷快乐体（`WhaleBubbleRounded`） | `apps/desktop-host/assets/fonts/zcool-kuaile.woff2`（`./fonts/zcool-kuaile.woff2`） | Google Fonts `ofl/zcoolkuaile`，**SIL OFL 1.1**（允许商用与随包分发，见 `docs/licenses/zcool-kuaile-ofl-1.1.txt`） | `"WhaleBubbleRounded","ShangShouGummy","Hiragino Maru Gothic ProN","PingFang SC","Microsoft YaHei",rounded,sans-serif` |
| `formal` | 正式体 · 站酷小薇体（`WhaleBubbleFormal`） | `apps/desktop-host/assets/fonts/zcool-xiaowei.woff2`（`./fonts/zcool-xiaowei.woff2`） | Google Fonts `ofl/zcoolxiaowei`，**SIL OFL 1.1**（允许商用与随包分发，见 `docs/licenses/zcool-xiaowei-ofl-1.1.txt`） | `"WhaleBubbleFormal","Songti SC","Noto Serif SC","SimSun","PingFang SC","Microsoft YaHei",serif` |

---

## 五、智能定位、放大预算与零重叠保证

1. **按同屏数量动态放大尺寸（`bubbleWidthBudget` + `estimateBubbleSize`）**：
   - **单气泡**：`dialog` / `notice` / `hint` 最宽可达 `Math.min(stageWidth * 0.76, 320)`（400px 舞台下为 **304px**），`thought` / `status` 最宽 **296px**，`reaction` 最宽 **260px**，`legacy` 保持经典紧凑上限 **220px**（双气泡下收紧至 **192px**）；
   - **三气泡同屏**：上限 `MAX_VISIBLE_BUBBLES = 3`，超出按 7 级语义优先级裁剪。
2. **上下文感知方向决策（`resolvePreferredSide`）与避障求解（`computeSmartBubbleLayout`）**：
   - 屏边避让优先，其次跟随角色朝向；
   - 实时采集 `workCardsLayer`（右上任务卡）与 `riceBowlWidget`（底部居中饭碗）占用区，并设置角色中心脸身保护区（`avatarGuard`）与左右翼紧凑宽度候选（`sideCompact`），`legacy` 优先贴合角色右下翼同时严守底线与饭碗避让；
   - 依序走「避开已有气泡 + 障碍物/脸身保护区」→「避开已有气泡 + 硬障碍物」→「垂直扫描 + 高度裁剪」→「极矮/窄舞台水平等宽分栏兜底」，数学保证零重叠与零越界；DOM `max-height` 严格锁定在 `placed.rect.height`。
3. **缩放适配与 `<think>` 双重净化**：
   - `applyStageScale()` 同步调用 `widgets.setStageBox(...)` 与 `syncBubbleContext()` 重排所有气泡；
   - `cleanBubbleText` 扩展支持全部 7 种类型：`thought` 提取 `<think>` 内文，其余 6 种（含 `legacy`）彻底剥离闭合/半截 `<think>` 标签。

---

## 六、验证口径（诚实区分）

- **单测验证（`bubbles.spec.ts`、`bubble-lifecycle.spec.ts`、`packages/shared-protocol/src/index.spec.ts`）**：覆盖 7 种语义契约（含 `legacy`）、7 种情绪变体与触发映射、4 套字体回退链与 `@font-face`、8 方向单条闭合 SVG 轮廓及 3 粒思绪云点、右下角经典蓝泡布局、极端尺寸舞台无重叠与 `<think>` 清洗。
- **`[E2E-HOST]`（`ui.e2e.spec.ts`、`pet-evolution.e2e.spec.ts`）**：真实启动 Electron 校验 `pointer-events: none`、`z-index: 7`、`hasShellSvg === true`、3 类随包字体 `document.fonts` 真实加载与 `fontFamily` 生效、单气泡突破 `220px`、多情绪同屏与经典蓝泡右下定位（避开底部饭碗）、朝向切换 DOM 镜像，以及 `pet-stage-bubbles.png`、`pet-stage-bubble-dialog.png`、`pet-stage-bubble-moods.png`、`pet-stage-bubble-legacy.png` 四张实际渲染截图视觉自检。
- **待人类宿主真机验收项**：在 macOS / Windows 桌面真实明暗壁纸下抽检 7 种语义 × 7 种情绪组合的观感、经典右下角半透蓝泡唤醒感与新字体文字排版节奏。
