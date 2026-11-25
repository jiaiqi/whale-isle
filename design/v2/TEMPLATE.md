# 鲸屿 V2 设计稿 · 页面规范契约（design/v2）

> 所有页面必须遵守本契约。参考实现：`home.html`（有右栏）、`game.html`（最饱满）。

## 页面骨架

```html
<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
<meta charset="UTF-8">
<title>页面名 — 鲸屿 V2</title>
<link rel="stylesheet" href="tokens.css">
<style> /* 仅本页专属布局类，前缀用页名缩写，如 .lf-xxx */ </style>
</head>
<body data-page="home" data-crumb="分组 · 页面名">
<div class="strata"></div>
<div class="wv2-shell">
  <main class="wv2-main"><div class="wv2-wrap">
    <!-- 内容：以 .sec-h 分区 -->
  </div></main>
  <!-- 可选右栏：<aside class="wv2-aside"> 若存在则自动变三栏 -->
</div>
<script src="vendor/lucide.min.js"></script>
<script src="shell.js"></script>
<script>lucide.createIcons(); if (window.pageInit) pageInit();</script>
</body>
</html>
```

## 硬性规则

1. **只复用 tokens.css 的类与变量**；本页专属样式写在页内 `<style>`，不修改 tokens.css / shell.js / 其他页面。
2. **零 emoji**，图标一律 `<i data-lucide="名字"></i>`（末尾 `lucide.createIcons()`）；数据用 `.mono` / `.num`。
3. **简体中文文案**；品牌名、字段名、枚举值保留英文（`COMPLETED`、`confidence`、`assetVersionId`）。领域字段与蓝图一致。
4. **数据要具体可信**：ID 用 `#a4f2` / `char_9f3k` 形态；数值带单位与时间；置信度、版本号、哈希前缀都要出现。
5. 每页 ≥5 个分区，分区标题：`<div class="sec-h"><i data-lucide="…" class="sm"></i>标题<span class="ln"></span><span class="cnt">补充</span></div>`。
6. 交互最小实现：`.seg[data-mutex]` 分组互斥、`.sw` 开关由 shell.js 接管；页面自有交互写 `pageInit()`。
7. 不引入任何外部网络资源；不用框架；静态 HTML 即最终交付物。

## 常用组件速查（见 tokens.css）

- 容器：`.card` `.card-hover` `.inset` `.hud`（游戏控制台深色玻璃）
- 徽章：`.pill .pill-tide|blue|green|amber|violet|red`；许可 `.lic .mit|apache|nc|unl`；回执 `.receipt .ok|warn|fail|run`
- 状态：`.dot .tide|green|amber|red|blue|violet|off` `.pulse`；声呐 `.sonar(.amber|.red|.violet)` + `.core` + `.ring` + `.sonar-label`
- 数据：`.kv > .k + .v`、`.meter > i`、`.tbl`、`.stat > .n + .l`、`.conf`
- 结构：`.grid2/.grid3/.grid4`、`.row/.row-wrap/.col`、`.sec-h`、`.note`、`.hairline`
- 流程：`.steps > .step(.done|.now|.fail) + .link`；看板 `.kb-col > .kb-head + .kb-card`
- 记忆 `.mem(.pinned) > .type`；目标 `.goal > .src + h4 + p`；时间轴 `.tl > .tl-item(.done|.now) > .tm + .t`
- 气泡 `.bubble(.ai|.user|.sys) > .who + 文本`；键位 `.kbd`；分段 `.seg > .seg-tab(.on)`；开关 `.sw(.on)`
- 矩阵格 `.mx-ok|.mx-ui|.mx-no|.mx-ask`；阶梯 `.ladder-item(.on) > .lv + .t + .d`；头像 `.avatar`
- 控制权：`.hud` + `.seg`（自主/协作/指令/接管）+ `.hud-emg`（紧急停止）
- 布局文字：`.grad-text` 极光渐变字（仅品牌时刻）、`.why`（解释"为什么"的虚线框）

## 语调

克制、工程感、像给资深玩家与工程师看的控制台，不是营销页。解释性文案回答"为什么这样设计"，引用蓝图编号（如「17 §9.2」）。
