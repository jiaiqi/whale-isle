# V2-P3-04I 抖音个性化流（推荐 / 关注）L1 只读验收证据

> 工单：`V2-P3-04H` 续（owner 2026-11-27 拍板「继续做个性化流」）
> 分支：`feat-social-douyin-personalized`（基于 `feat/whale-isle-v2` `a8bcc06`）
> 证据等级：**`IMPLEMENTED_UNVERIFIED`**。生产链路真实冒烟 **未通过**：owner 扫码登录成功，但抖音返回「验证码中间页」，按红线立即停止，未绕过、未继续硬刷。
> 本文件只覆盖「推荐 / 关注」两条个性化流的只读读取路径；**不覆盖**点赞、关注、评论、私信、发布等任何写操作——这些均未做、也未验证。

## 1. 结论（先说实话）

- **代码已实现**：新增 `public | recommended | following` 三种信息流；未登录、被平台重定向、个性化流无候选时，一律如实回落「公开精选」，并把 `requestedFeed / usedFeed / loggedIn / fallbackReason` 写进证据。只有「请求的那条流」本身被真实读到 ≥3 条，才允许把来源置真。
- **owner 已亲手扫码登录成功**：2026-11-27 09:56:49 CST，独立 `e2e-profile` 分区内出现 `sessionid` / `sessionid_ss` / `sid_guard` 等 Cookie（只检查名称，未读取/导出值）。AI 未代填密码、未接触账号凭据。
- **生产链路真实冒烟未通过**：推荐流需要先在精选页内点击「推荐」标签才能进入（直接访问 `/?recommend=1` 会被 302 到 `/jingxuan`）。接线修正后重跑时，抖音返回标题为 **「验证码中间页」** 的空白页，属于真实风控门槛。按红线立即停止，**未识别验证码、未绕过、未再发起真实请求**；`runnable` 保持 `false`，个性化流未置真。
- **真实平台只读探测（非生产冒烟）**：在已登录隔离 Profile 内，点击「推荐」标签后真实读到 **8 张推荐卡片**；直接打开 `/follow` 真实读到 **2 张关注卡片**（低于冒烟门槛 3）。这些是只读探测，**不能替代**生产冒烟，也不能据此把 `runnable` 置真。
- **未达 `DONE`**：真实个性化冒烟、真实验证码处理后的恢复流程、真实模型理解、多日浸泡均未验，状态记 `IMPLEMENTED_UNVERIFIED`（真实冒烟阻塞条件见 §4）。

## 2. 开工决策声明（采用 / 不采用 / 回退）

- **采用**：沿用既有四段端口（候选来源 → 逐条读取 → 理解 → 记账），只扩展 feed 选择与回落逻辑；推荐流由宿主在精选页内**点击站内「推荐」导航标签**进入（只读导航，不点赞/不关注/不评论/不发私信）；关注流直接打开 `/follow`，并从 `[data-e2e="video-info"][data-e2e-aweme-id]` 读取公开视频 id。
- **不采用**：① 不逆向签名接口或伪造请求；② 不识别/绕过验证码；③ 不把「登录成功」冒充「个性化流已验证」；④ 不把公开精选的回落证据冒充推荐/关注证据；⑤ 不引入第三方弹幕/浏览器方案。
- **回退**：登录态缺失 / 登录态读取失败 → 不打开个性化页，直接回落公开精选；个性化页零候选 → 检测登录墙后回落；推荐流被重定向 → 以最终 URL 判定实际流；验证码/风控 → `PERMISSION_DENIED(recoverable:false)` 立即停止。证据 7 天过期或个性化流未验证 → 来源 `verified=false`、执行器 `runnable=false`；切回公开精选（其证据仍有效）即可恢复公开只读。

## 3. 本次改动（6 个业务文件）

| 文件 | 改动 |
| --- | --- |
| `packages/character-core/src/social-douyin.ts` | 新增 `DOUYIN_FEED_KINDS` / URL / 标签 / `DouyinFeedKindSchema`；证据增加 `requestedFeed / usedFeed / loggedIn / fallbackReason`；新增 `isDouyinRequestedFeedVerified()`；来源支持 `selectFeed()`、登录态判定、重定向识别、登录墙/空流回落；`openFeed?()` 端口；冒烟支持 `feed` 参数；补充「验证码中间页」识别。 |
| `packages/character-core/src/social-douyin.spec.ts` | 新增 10 例个性化流与回落测试（含推荐点击端口、未登录回落、登录态读取失败、平台重定向、登录墙、空流、证据字段、旧证据兼容、验证码中间页），共 **29 例**。 |
| `apps/desktop-host/src/main/electron-browser-engine.ts` | 实现 `openFeed('recommended')`：加载精选页 → 点击「推荐」标签 → 等待 `recommend=1` 且出现卡片；关注流补 `video-info[data-e2e-aweme-id]` 卡片抽取；`ElectronDouyinSession` 转发 `openFeed`。 |
| `apps/desktop-host/src/main/v2-kernel-host.ts` | 证据文件增加 `preferredFeed` 与 `byFeed`（旧证据自动回填）；按首选流注册来源；快照返回 `feed / feedVerified / selection / byFeed`；冒烟与新增 `v2:social-douyin-feed` IPC 支持 feed；能力矩阵按最新可用证据登记。 |
| `apps/desktop-host/src/preload/index.ts` | 新增 `v2SocialDouyinFeed`。 |
| `apps/desktop-host/src/renderer/director/bridge.ts` + `views/life-console-view.tsx` | 类型与生活页：信息流下拉（公开精选 / 推荐 / 关注）、真实冒烟按当前流执行、展示请求流/实际流/回落原因、登录态与证据；明确「扫码只保存登录态，登录后仍需冒烟才算该流已验证」。 |

## 4. 真实读数与阻塞（本机 macOS，2026-11-27）

### 4.1 owner 扫码登录

| 字段 | 真实值 |
| --- | --- |
| 检测到登录态时间 | `2026-11-27 09:56:49 CST` |
| 隔离分区 | `Whale Isle/e2e-profile/Partitions/whale-char_xiaojing-douyin-owner` |
| Cookie 名称（只检查名称） | `sessionid`、`sessionid_ss`、`sid_guard`、`passport_csrf_token` |
| 凭据处理 | 未读取值、未导出、未写入仓库/聊天；Cookie 只存本机隔离 Profile |

### 4.2 真实只读探测（非生产冒烟，不能置真）

| 时间 | 流 | 最终 URL | 读到卡片 | 备注 |
| --- | --- | --- | --- | --- |
| `09:59:20 CST` | 推荐（页内点击「推荐」标签） | `https://www.douyin.com/?recommend=1` | **8** | `feed-item` 8 个；卡片含公开视频 id / 标题 / 作者 / 日期。原始证据 [P3-04I-douyin-recommended-probe.json](./P3-04I-douyin-recommended-probe.json) |
| `09:59:42 CST` | 关注 | `https://www.douyin.com/follow` | **2** | 单屏轮播当前只渲染 2 张卡片，低于冒烟门槛 3；原始证据 [P3-04I-douyin-following-probe.json](./P3-04I-douyin-following-probe.json) |

> 直接访问 `https://www.douyin.com/?recommend=1`（未点标签）会被服务端重定向到 `/jingxuan`；即使已登录也一样。因此推荐流必须走页内标签，不能只靠 URL。

### 4.3 生产链路真实冒烟（失败，已停止）

| 字段 | 真实值 |
| --- | --- |
| 冒烟时间 | `2026-11-27 10:04:01 CST`（epoch `1795745041325`） |
| 请求流 / 实际流 | `recommended` / `public` |
| `loggedIn` | `true` |
| `fallbackReason` | `platform_redirected` |
| 候选 / 读到 | **0 / 0** |
| `ok` | **false** |
| `failureKind` | **`captcha`**（真实风控「验证码中间页」；原始冒烟代码当时未识别该页，`rawFailureReason` 保留为「没有可读候选」） |
| `failureReason`（归档标注） | 抖音返回「验证码中间页」（真实风控门槛），已立即停止，未绕过/未重试 |
| 真实页面标题（临时诊断） | **「验证码中间页」**，正文为空 |
| 诊断证据 | [P3-04I-douyin-captcha-intermediate.json](./P3-04I-douyin-captcha-intermediate.json) |
| 冒烟原始结果 | [P3-04I-douyin-personalized-smoke.json](./P3-04I-douyin-personalized-smoke.json) |
| 冒烟后执行器 | `executorReady=false`、`runnable=false`、来源 `verified=false` |

**失败与停止过程（不隐藏）**：

1. 首次扫码后冒烟（`openFeed` 尚未接线）走的是 `/?recommend=1`，被平台重定向到公开精选，证据如实记录 `usedFeed=public / fallbackReason=platform_redirected`。
2. 发现推荐必须页内点击标签后，补上 `openFeed` 并重跑；此时页面返回「验证码中间页」。
3. 看到验证码标题后**立即停止**，没有再发起真实请求，也没有尝试识别/绕过验证码。临时诊断代码随后已移除。
4. 已补上「验证码中间页」识别与单测：今后遇到该页会在动手前抛 `PERMISSION_DENIED / CAPTCHA_REQUIRED`，`recoverable:false`，执行器立即中止。因红线要求停止，本次没有重跑验证该修复后的真实表现。

### 4.3.1 验证码复核（2026-11-27 10:20 CST，仍未通过）

- owner 口头告知「验证码处理过了」后，按约定只做**一次**复核；生产链路仍返回验证码：`requestedFeed=recommended`、`usedFeed=recommended`、`loggedIn=false`、候选 0、`ok=false`，`failureReason` 为「抖音触发验证码/风控门槛，立即停止，绝不绕过」。
- 说明：验证码可能是在 owner 日常浏览器里处理，而自动化隔离 Profile 未通过；同时登录态已丢失（`loggedIn=false`）。已立即停止，**未再重试、未尝试换 IP/UA/延时绕过**。
- 原始证据：[P3-04I-douyin-captcha-retry.json](./P3-04I-douyin-captcha-retry.json)。

### 4.4 证据与 runnable 口径

- 证据文件按流分开存：`byFeed.public / recommended / following`；旧文件只有 `latest` 时按 `requestedFeed` 自动回填。
- 只有 `isDouyinRequestedFeedVerified(evidence)` 为真（该流自己读到 ≥3 条、证据 ≤7 天）才把来源置真；公开精选的回落证据不会把推荐/关注置真。
- 本次 `recommended` 证据 `ok=false`；`preferredFeed=recommended` → `runnable=false`。切回 `public` 时仍可复用此前真实通过的公开精选证据（≤7 天）。

## 5. 红线执行情况（逐条对照 owner 原文）

| owner 红线 | 实际执行 |
| --- | --- |
| **只读**：不点赞、不关注、不评论、不发私信、不改账号状态 | 只做页面加载、只读 DOM 文本、页内点击「推荐」导航标签；`DouyinWebSession` 无写操作入口；`interactionMode=readonly`。 |
| 不绕过验证码/风控/登录墙；触发就停、如实报、不硬刷 | 本次真实触发「验证码中间页」→ 停止，未识别/绕过；补上识别后测试覆盖 `CAPTCHA_REQUIRED`。未再发起请求。 |
| 只用 owner 自己的账号会话；不新建账号；凭据不进仓库/聊天 | owner 亲手扫码；只检查 Cookie 名称；无密码代填、无凭据落仓库/聊天。 |
| 不碰语音/工坊代码、不动 `pet:sleep-status` | 改动只在社交源/浏览器引擎/宿主/生活页，未触碰 voice/workshop/`pet:sleep-status`。 |
| 遵守平台条款与限速；默认关，owner 打开才跑 | 默认 `enabled=false`；逐条 ≥2.5s；本次冒烟 limit=5；触发风控后立即停。 |

## 6. 自动化测试（`[SIMULATION]`）

- `social-douyin.spec.ts` **29 例**（原 18 + 新 11），覆盖：
  - 三种 feed 选择与 `openFeed` 端口调用；
  - 已登录推荐流直读、不回落；
  - 未登录请求推荐 → 不打开个性化页，回落公开精选并标记 `not_logged_in`；
  - 登录态读取失败 → 按未登录回落，不假装已登录；
  - 推荐流被重定向 → `platform_redirected`；
  - 推荐流零候选 + 登录墙 → `login_wall`；
  - 关注流零候选 → `empty_preferred`；
  - 个性化回落证据仍可用，但 `isDouyinRequestedFeedVerified=false`；
  - 已登录推荐流冒烟 → `requestedFeed=usedFeed=recommended` 且请求流验证通过；
  - 旧证据缺 feed 字段 → 按公开精选解析，不冒充个性化已验证；
  - 「验证码中间页」标题 → `CAPTCHA_REQUIRED`，只加载 1 页即停。
- 与执行器等相关用例由 `pnpm verify:gate` Gate 3 全量运行。

## 7. 门禁与构建

命令：`pnpm verify:gate`（8 道）。真实输出摘要：

```text
✅ PASS  Gate 1 类型与边界          tsc -b + dependency-cruiser
✅ PASS  Gate 1 类型与边界(Python)  ruff + mypy
✅ PASS  Gate 1 打包护栏            main / preload / pet-stage / director
✅ PASS  Gate 2 许可证与密钥        339 源文件 0 违规
✅ PASS  Gate 2 依赖漏洞            0 high / 0 critical
✅ PASS  Gate 2 DST Lua 语法        5 个 Lua 文件
✅ PASS  Gate 3 确定性单测          vitest + pytest
✅ PASS  Gate 4 回环契约 E2E        0.4s < 15s

✅ verify:gate 通过：8 过 / 0 跳过 / 0 待接线
```

**失败留档**：首次 `verify:gate` 为 **7 过 / 1 败**，Gate 1 打包护栏失败：生活页从 `@workbench/character-core` 值导入 feed 常量，把主进程 `node:fs/path/crypto` 打进渲染包。修正为渲染层本地只读标签 + type-only 导入后，打包与全量门禁通过；失败原始日志保留在 `.verify-gate/`（gitignore），重试通过不代表该次失败没发生。

## 8. 仍待人类 / 后续

- **真实个性化冒烟**：当前阻塞于抖音真实风控「验证码中间页」。需要 owner 亲手处理验证码并等待平台冷却后，再约一次扫码/冒烟；AI 不识别、不绕过、不硬刷。恢复后应先跑 `recommended`，再视账号页面情况跑 `following`。
- **关注流门槛**：本账号 `/follow` 当前只渲染 2 张可读卡片，低于冒烟门槛 3；需要更多关注内容或后续实现只读翻页后再验。
- **真实风控恢复流程**：本次已真实遇到验证码并停止，但「owner 处理后如何恢复、是否需重新扫码」尚未完整演练。
- **真实模型理解**：本次未触发真实模型理解调用。
- **多日浸泡**：默认关闭、每日 ≤2 次 / ≤30 分钟、00–08 禁发、失败冷却等仍为单测 + 手工验收，未做多日真机浸泡。
- **平台条款**：页面结构/风控策略可能变化；结构变化时源会如实失败，不伪造候选。

## 9. 证据文件

- [P3-04I-douyin-recommended-probe.json](./P3-04I-douyin-recommended-probe.json)：已登录后点击「推荐」标签的真实只读探测（8 张卡片）。
- [P3-04I-douyin-following-probe.json](./P3-04I-douyin-following-probe.json)：已登录 `/follow` 真实页面结构（2 张卡片）。
- [P3-04I-douyin-personalized-smoke.json](./P3-04I-douyin-personalized-smoke.json)：生产链路真实冒烟失败结果与执行器状态。归档时按同批验证码诊断补 `failureKind=captcha` 与显式 `failureReason`，原始归因保留在 `rawFailureReason`，未改写原始读数。
- [P3-04I-douyin-captcha-intermediate.json](./P3-04I-douyin-captcha-intermediate.json)：真实「验证码中间页」临时诊断输出（诊断代码已移除）。
- [P3-04I-douyin-captcha-retry.json](./P3-04I-douyin-captcha-retry.json)：owner 称验证码已处理后的单次复核，仍返回验证码且 `loggedIn=false`，已停止。
