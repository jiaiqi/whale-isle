# Whale Isle `pet-stage` 气泡系统重设计说明

## 一、现状痛点与设计目标

1. **尺寸偏小**：旧版宽度上限固定为 `Math.min(stage.width * 0.46, 220)`（在 400px 舞台下仅 `184px`），且 `max-height` 存在 `+16px` DOM 溢出余量，长句易截断。
2. **位置僵化**：旧版 `thought` 死锁左上、`dialog` 死锁右上头部侧方，完全不感知角色朝向、窗口贴边位置或悬浮挂件（`workCards` / `riceBowl`）。
3. **语义单调**：仅区分为 `thought` 和 `dialog` 两类，问候、时钟状态、皇冠通知、戳脸/互撞吐槽混为一谈。

重设计围绕 **「更大范围 · 智能感知 · 语义丰富 · 和谐统一」** 四个核心方向展开。

---

## 二、6 种语义气泡与视觉语言（Q 版像素蓝鲸女仆 × Tidepaper 潮汐纸）

所有气泡统一采用零 Emoji 策略（纯内联 SVG 徽标）、`ShangShouGummy` 字体链、`pointer-events: none`、`z-index: 7`（位于角色视频之上、任务卡 `z8` 与参考线 `z9` 之下），并在省电模式关闭模糊与阴影。

| 语义类型 (`PetBubbleKind`) | 触发源 | 视觉语言（白/暗桌面均高对比） | 尾巴/挂饰 | 默认自动隐藏 | 优先级 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `reaction`（即时反应） | `reflex_*` 反射台词、互撞、戳脸/摇晃吐槽、彩蛋被抓 | 珊瑚星芒漫画泡：暖白珊瑚底 + 2px 珊瑚红边框 + 硬像素阴影 | `sharp` 锐角尖尾 | `6s` | 6（最高） |
| `dialog`（正式对话） | `chat_reply` / `chat_order`、`pet:say`、`speakWithEmotion` | 海盐瓷对白泡：冰蓝白微透 + 蓝鲸边 + 柔和内高光（含静音角标） | `pointer` 对白尾 | `10s`（TTS 期间由语音租约托管） | 5 |
| `notice`（系统通知） | 大活完成皇冠、`pet:bubble(notice)` | 深靛海图便签：深蓝底 + 3px 暖金左边界 + 金铃铛 SVG | `none` | `8s` | 4 |
| `thought`（内心戏） | `autodrive decision.intent`、睡眠梦话、`pet:bubble(thought)` | 星雾紫云朵泡：渐变紫雾底 + 虚线描边 + 星云 SVG | `cloud` 双圆云粒 | `12s` | 3 |
| `hint`（互动提示） | 每日问候/节日登场、摸头哄好台词、工作跟随姿态台词 | 清透海盐气泡：柔海天蓝底 + 海浪微星 SVG | `soft` 柔圆尾 | `9s` | 2 |
| `status`（状态播报） | 游戏时钟（`星露谷 ...`）、`pet:state` 状态同步 | 深海青胶囊：圆润胶囊 + 脉冲声呐圆点 + `tabular-nums` 等宽数字 | `none` | `16s` | 1 |

---

## 三、智能定位、放大预算与零重叠保证

1. **按同屏数量动态放大尺寸（`bubbleWidthBudget` + `estimateBubbleSize`）**：
   - **单气泡**：`dialog` / `notice` / `hint` 最宽可达 `Math.min(stageWidth * 0.76, 320)`（400px 舞台下为 **304px**，较旧版 184px 提升 **+65%**），`thought` / `status` 最宽 **280px**；
   - **双气泡**：`dialog` / `notice` 最宽 **256px**，其余 **216–224px**；
   - **三气泡同屏**：上限 `MAX_VISIBLE_BUBBLES = 3`，超出按语义优先级裁剪，确保舞台不拥挤。
2. **上下文感知方向决策（`resolvePreferredSide`）**：
   - **屏边避让优先**：窗口靠近/贴靠屏幕右缘（`edgeHint = 'right'`）时主侧切换至左向展开，靠近左缘时切至右向展开，避免贴边文字视觉压迫；
   - **角色朝向跟随**：解析 `SpritesheetRenderer` 当前动作片段 `facing` 与巡逻镜像 `flipX`，默认面向哪侧，对话/反应主气泡即顺着朝向一侧自然展开，内心戏自动摆到对侧形成均衡构图；
   - **尾巴动态指向（`resolveTailDirection`）**：根据气泡最终坐标相对于角色头部锚点 `(xRatio, headYRatio)` 的方位，动态计算 `bottom-left / bottom-right / bottom-center / left / right / none`。
3. **障碍物避让、避脸保护与三阶段防重叠求解（`computeSmartBubbleLayout`）**：
   - 实时采集 `workCardsLayer`（右上任务卡）与 `riceBowlWidget`（底部居中饭碗）占用区作为 `occupied`；
   - 引入角色中心脸身软保护区（`avatarGuard`）与侧翼紧凑宽度贴合候选（`sideCompact`），在保证气泡互不重叠的同时优先让出蓝鲸主体面部与身躯；
   - 依序尝试「避开已放置气泡 + 障碍物/人物保护区」→「避开已放置气泡 + 硬障碍物」→「垂直扫描 + 高度裁剪」→「极矮/窄舞台水平等宽分栏兜底」；
   - DOM `max-height` 严格锁定在 `placed.rect.height`（移除旧版 `+16px` 溢出余量），结合 `-webkit-line-clamp` 优雅省略，彻底杜绝真实 DOM 重叠。
4. **缩放适配与 `<think>` 双重净化**：
   - `applyStageScale()` 同步调用 `widgets.setStageBox(...)` 与 `syncBubbleContext()` 重排所有气泡；
   - `cleanBubbleText` 扩展支持全部 6 种类型：`thought` 提取 `<think>` 内文，其余 5 种彻底剥离闭合/半截 `<think>` 标签。

---

## 四、验证口径（诚实区分）

- **单测验证（`bubbles.spec.ts`、`bubble-lifecycle.spec.ts`、`packages/shared-protocol/src/index.spec.ts`）**：覆盖 6 种契约、自适应尺寸、朝向/屏边/障碍物智能求解、6 轨并发裁剪、极端尺寸舞台无重叠与 `<think>` 清洗。
- **`[E2E-HOST]`（`ui.e2e.spec.ts`、`pet-evolution.e2e.spec.ts`）**：真实启动 Electron 校验 `pointer-events: none`、`z-index: 7`、`ShangShouGummy` 字体链、单气泡突破 `220px`、多气泡组合零重叠、朝向切换 DOM 镜像与 `data-tail` 翻转及截图留证。实测同时定性：原 `pet-evolution.e2e.spec.ts:138` 的彩蛋关窗超时并非气泡回归，而是共享 `e2e-profile` 下本机运行中 AI CLI 经 `cliLogWatcher` 自动召唤跨 AI 桌宠窗导致的窗口计数过宽误报（目标彩蛋窗本身在 `eggCatch` 后 6s 准时销毁），现已收敛为精确校验目标 `egg.agentId` 窗口关闭。
- **待人类宿主真机验收项**：在 macOS / Windows 桌面真实明暗壁纸下抽检 6 种语义气泡的视觉观感、文字排版呼吸感与连播节奏。
