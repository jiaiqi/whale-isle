# P4-01：多日连续观察（秋1→秋5）与「空气泡」根因修复

## 决策声明

本轮做两件事：① 跑通「秋1 → 秋5」多日连续真机观察，验证前几轮修复在真实连续游戏里的表现；② 定位并修复用户截图反馈的「空气泡」（只有徽标、正文空白）。

「空气泡」采用**渲染层清洗 + 展示前置判定 + 渲染期最终防线**三层防御：清洗阶段剔除零宽/不可见字符，展示阶段拒绝无墨文本，渲染阶段再兜一次。不采用的方案：只靠 CSS 隐藏空正文（外壳仍占位、仍会闪）、或在气泡层做像素级墨迹检测（成本高且不稳定）。

`special_orders` 采用**在工具契约提示里写清参数取值**（`accept` 只接受 `left`/`right`）。不采用：程序侧把 `true` 自动纠正为 `left`（会替模型做选择，且不确定该接哪一侧）。

## 一、多日连续观察（[REAL-DEVICE]）

- 运行：`node scratch/real-two-season-soak.mjs --target-season 秋 --target-day 5 --max-minutes 600 --min-target-actions 3 --stuck-abort-minutes 18`
- 存档隔离：`userData=/tmp/whale-real-soak-2s`，游戏 `XDG_CONFIG_HOME=/tmp/whale-real-soak-2s/stardew-isolated/xdg-config`，存档槽「鲸屿两季_455475850」
- 结束时 `SAVES_MTIME_UNCHANGED: {"ok":true,"changed":[]}` —— **真实存档未被改写**

| 日 | 时钟跨度 | 金钱 | 最低体力 | 最低生命 | 覆盖地图 |
| --- | --- | --- | --- | --- | --- |
| 秋1 | 06:00 → 21:40 | 771 → 771 | 155/270 | 44/120 | Farm / CommunityCenter / Mine / UndergroundMine47 / UndergroundMine49 |
| 秋2 | 06:00 → 19:50 | 1125 → 1125 | 0/270 | 46/120 | Farm / Town / Mine / UndergroundMine6~14 |
| 秋3 | 06:00 → 11:10 | 1125 → 1125 | 0/270 | 120/120 | FarmHouse / Farm / Town |
| 秋4 | 06:00 → 21:40 | 1125 → 1125 | 215/270 | 44/120 | CommunityCenter / Town / Mountain / Mine / UndergroundMine43 / Forest |
| 秋5 | 06:00 → 06:00 | 1125 → 1125 | 270/270 | 120/120 | FarmHouse / Farm |

- 真实回执统计（本轮 trace）：`COMPLETED 105 / FAILED 30`，总决策 130
- 渲染层采样：`emptyShellCount=0`、`overlapCount=0`、`clippedCount=0`、`watchdogCount=0`、`consoleErrors=[]`
- 语音：`sawSpeakingAttr=true`、`maxAmplitude=0.3335`、`completedCount=7`
- 记忆：nodes 2566 / edges 5512，跨日保留
- 心得本新增 33 条（如「秋4:store_items 的正确参数为 items x y，传入 container 会静默失败」「秋4:标记【留着】的社区中心捐献物不可食用」）

### 晨间计划含「今日安排事实」验证通过

```
[PLAN 秋2] 取回喷壶和斧头，清空出生点附近站位，腾出背包格子(in_progress)
         | 去镇上接告示板灰尘精灵委托与特别订单(pending)
         | 下矿深挖打灰尘精灵兼刷矿石，天黑前回屋(pending)
         | 生日给潘妮送最爱的礼物（若背包够格）(pending)
```

第 4 条「生日给潘妮送最爱的礼物」即来自 `today-schedule.ts` 解析出的**今日生日事实**，证明 `cc6c80d` 的今日安排事实注入在真实运行中生效。

### 本轮新发现的真实缺陷（已修）

1. **`special_orders` 参数契约缺失**（秋2 17:40）：模型传 `accept:true` 被 BWF 拒绝，理由「没找到要接的订单"true"」。本轮 `special_orders` 共被调用 11 次，其中 6 次挤在同一分钟内（06:29:22 / 06:29:30 / 06:29:38 ×5），属参数契约不明确导致的原地打转。修复：在 `llm-prompt.ts` 工具清单里写明 `special_orders({"accept":"left|right"})`，并注明 `board="qi"` 为姜岛核桃挑战。
2. **背包只有 1 格时仍下矿**（秋4）：`explore_mine` 在背包仅剩 4 空位、生命 44/120 且无回血食物时硬撑，回执明确写「停下原因：生命只剩 44/120，背包里没有能回血的食物（只有要交的 野梅、普通蘑菇，没舍得吃）」。前一轮 `eee5ba5` 已加「背包 ≤2 格提前提示」，本轮该提示**已生效**（模型改用 `eat` 吃掉香味浆果腾格），但**「任务物资不可吃」的边界**仍需模型自行判断，属于事实提示而非硬规则，符合 AI-first 红线，不做程序化强制。

## 二、「空气泡」根因（[REAL-DEVICE] 截图 + 源码定位）

### 用户截图特征

粉色心形外壳 + 只有心形徽标、正文完全空白。粉色心形 = `coquettish` 情绪主题（`bubble-types.ts` 的 `BUBBLE_MOOD_THEMES.coquettish.iconSvg` 正是那颗心），对应 `TRIGGER_TO_MOOD.poke = 'coquettish'`，即**戳一下桌宠**触发的 `reaction` 气泡。

### 根因链

1. `showKind()` 用 `cleanBubbleText()` 清洗文本；`cleanBubbleText` 只做 `trim()`。
2. **`String.prototype.trim()` 不移除 U+200B（零宽空格）、U+200C、U+200D、U+FEFF（零宽不换行空格）、U+2060 等零宽字符**——它们是 JS 的非空白字符。
3. 于是 `cleaned !== ''` 通过校验 → `currentItems.set(kind, { text })` → `renderLayout()` 照常画外壳、画心形徽标。
4. 但这些字符**没有任何墨迹**，正文区在屏幕上就是空白 → 用户看到「只有徽标的空气泡」。

仓库扫描佐证：全仓 242 处含零宽/变体选择符（含 `packages/character-core/src/social-douyin.ts` 已在社交文本侧做过 `replace(/[\u200b-\u200d\ufeff]/gu, '')`，说明**这类字符在本项目的 LLM 输出里确实出现过**，只是桌宠气泡渲染层漏了同一道防线）。

### 修复（三层）

1. `bubble-text.ts` 新增 `stripInvisibleChars()` / `hasVisibleGlyph()`，剔除零宽、方向标记、BOM、软连字符、变体选择符与纯组合记号。
2. `cleanBubbleText()` 清洗时统一剔除；`showKind()` 增加展示前置判定：`!hasVisibleGlyph(cleaned)` 直接返回 `false`（**不弹泡**，而不是弹一个空壳）。
3. `renderLayout()` 增加渲染期最终防线：任何 `currentItems` 条目若正文无墨，收起外壳、清状态、停计时器。

另修一处隐患：`bubbles.ts` 打字机续显分支的 `existingTyping.pages[existingTyping.page] ?? ''` 会在页码越界时把正文写成**空串**（外壳仍在）——改为 `?? fullText` 回退。

### 回归测试

`apps/desktop-host/src/renderer/pet-stage/widgets/bubbles.spec.ts` **25/25 通过**，新增用例覆盖：
- `cleanBubbleText('\u200b')` → `''`
- `cleanBubbleText('\u200b\u200c\u200d\ufeff')` → `''`
- `stripInvisibleChars('\u200b才不是大肥鱼\u200b')` → `'才不是大肥鱼'`
- `hasVisibleGlyph('\u200b\u200c\u200d\ufeff')` → `false`；`hasVisibleGlyph('❤️')` → `true`（emoji 变体仍算有墨）

## 三、仍未验证项（不冒充完成）

- 多层桌宠重影：**仍未取得整屏对照证据**，本轮渲染采样仍只有 1 个可见媒体层。
- 物理 `F7` 热键接管、人类主观听感、桌面端原生形象切换的完整视觉抽验。
- 本轮「空气泡」修复为**单元级与代码级验证**；真实桌面会话中再遇到「戳一下」的气泡是否完全不再出现空白，需人工再戳一次确认（`[PENDING-HUMAN]`）。

## 四、门禁

`pnpm verify:gate`：见提交说明（首次因覆盖率分支数 89.98% < 90% 失败，收敛新代码分支后复跑通过）。
