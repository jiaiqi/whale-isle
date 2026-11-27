# P3-04K 抖音只读「真浏览器 + 独立持久 Profile + CDP」验证

> 记录时间：2026-11-27 11:04–11:37 CST（UTC 03:04–03:37）
> 分支：`feat-douyin-browser-cdp`（基于 `origin/feat/whale-isle-v2` `ecc82a1`）
> 本文件只记录**真实平台只读读数**；未做任何点赞/关注/评论/私信/发布，未绕过验证码，未改 UA、未做 stealth、未逆向签名接口。

---

## 1. 本轮要回答的问题

`P3-04J` §4 的前提：仓库内没有任何项目能证明「真浏览器 + 独立持久 Profile」可以避免抖音的「验证码中间页」。因此本轮**不是**要「保证通过」，而是要**如实记录换了真浏览器驱动之后还会不会撞验证码**。

必须区分两件事：

- **事实 A（未登录公开页）**：匿名可读的公开精选页本来就不该有登录/验证码门槛。
- **事实 B（登录后的个性化流）**：`P3-04I` 在 10:04 的生产冒烟中撞到「验证码中间页」；本轮要看换驱动后是否仍撞。

`P3-04I` 的结论不能外推到本轮，本轮也不把「这次没撞到」写成「以后不会撞」。

---

## 2. 驱动与运行环境（无凭据）

| 项 | 读数 |
| --- | --- |
| 浏览器 | **Google Chrome 158.0.8127.88**（macOS；按 Chrome → Edge 顺序探测，Chrome 命中即止） |
| 驱动 | `cdp-real`（新增 `apps/desktop-host/src/main/cdp-browser-engine.ts`） |
| 专用 Profile | `~/Library/Application Support/Whale Isle/douyin-browser-profile`，**不是** owner 日常 Chrome 的 `Default` user-data-dir，也不是 Electron `persist:` 分区 |
| CDP 监听 | `127.0.0.1:9333`（`--remote-debugging-address=127.0.0.1`，仅回环；无 `0.0.0.0`） |
| 启动参数 | `--user-data-dir=<专用目录>`、`--remote-debugging-port=9333`、`--remote-debugging-address=127.0.0.1`、`--no-first-run`、`--no-default-browser-check`、`--disable-search-engine-choice-screen`、`about:blank` |
| 未添加 | 无 `--headless`、无 `--disable-blink-features=AutomationControlled`、无 UA 覆盖、无任何反检测补丁 |
| 单实例 | 自有 marker（`whale-cdp-instance.json`）+ `/json/version` 探活；已运行则复用，**绝不强拉第二个实例** |
| 浏览器关闭 | 本轮验证期间窗口持续保留；仅在 `/tmp` 探针脚本退出时断开 CDP 连接，浏览器进程未退出 |

登录完全由 owner 在可见窗口亲手扫码完成：未代填密码、未读取/导出任何 Cookie 值，只检查 Cookie **名称** `sessionid` / `sessionid_ss` / `sid_guard`。

---

## 3. 逐步真实读数

所有原始 JSON 都在本目录，字段未被后续编辑（只新增文件，不改旧读数）。

### 3.1 启动与未登录公开页（事实 A）

[launch.json](./P3-04K-douyin-real-browser-launch.json) — 11:04:25，真浏览器启动成功，首页标题「抖音-记录美好生活」。

[launch-read.json](./P3-04K-douyin-real-browser-launch-read.json) — 11:05:06，未登录打开 `/jingxuan`：

- URL：`https://www.douyin.com/jingxuan`
- 标题：`抖音精选电脑版 - 抖音旗下优质视频平台`
- 正文长度：**6 582** 字符
- 卡片：**60**
- 验证码：**无**
- 页面提示「登录」但公开卡片可读，因此不构成登录墙（`detectDouyinBlock` 归为 `login` 提示，只读流程不因它中断）

> 事实 A 结论：真浏览器 + 专用 Profile 下，匿名公开精选页可正常读，无验证码。这与「未登录本来就不该有门槛」的预期一致，**不能**用来推断登录后的个性化流。

### 3.2 登录确认

[login-status.json](./P3-04K-douyin-real-browser-login-status.json) — 11:12:02，owner 刚扫码后第一次只读检查：Cookie 名称里还没有会话名（`cookieCount=33`，`loggedIn=false`），如实记为「尚未登录」，没有猜测。

[login-confirmed.json](./P3-04K-douyin-real-browser-login-confirmed.json) — 11:12:54 复查：Cookie 名称出现 **`sessionid` / `sessionid_ss` / `sid_guard`**（`cookieCount=66`，`loggedIn=true`），当前页 `/jingxuan`。Cookie 值未读取、未打印、未落盘。

### 3.3 推荐流只读探测

[recommended-probe.json](./P3-04K-douyin-real-browser-recommended-probe.json) — 11:13:12，`openFeed('recommended')`（精选页内点「推荐」标签，未登录直连 `/?recommend=1` 会被 302 到 `/jingxuan`）：

- 最终 URL：`https://www.douyin.com/?recommend=1`
- 标题：`抖音精选电脑版 - 抖音旗下优质视频平台`
- 正文长度：73 字符（壳页面，正文主要在卡片里）
- 卡片：**9**
- 验证码：**无**
- `verifiedByThreshold=true`（卡片 ≥3；但这只是**探测**，不置真执行器——置真只认生产冒烟）

### 3.4 关注流只读探测

[following-probe.json](./P3-04K-douyin-real-browser-following-probe.json) — 11:14:54，`/follow`：

- URL：`https://www.douyin.com/follow`
- 标题：`抖音-记录美好生活`
- 正文长度：101 字符，正文含「暂时没有更多作品 / 可以在搜索或在推荐关注你感兴趣的人」
- 卡片：**0**
- 验证码 / 登录墙：**均无**
- `verifiedByThreshold=false`

> 关注流 0 卡片是**真实读数**，不是「没读到」，也不是验证码；当前账号的关注流确实没有可读作品。因此关注流本轮**不置真**。

### 3.5 生产冒烟（与 `v2:social-douyin-smoke` 等价）

冒烟链路：`DouyinBrowseCandidateSource` + `runDouyinSmoke({limit:5})`，`minItems=3`，请求流 `recommended`，逐条只读打开视频页并抽取公开字段。

| 时间 | 证据 | 候选 | 读到 | 失败 | 耗时 | ok | 验证码 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 11:16:40（首轮） | [smoke.json](./P3-04K-douyin-real-browser-smoke.json) | 5 | 1 | 4 | 10.2s | false | 无 |
| 11:22:12（加长单条等待后） | [smoke-after-item-render-fix.json](./P3-04K-douyin-real-browser-smoke-after-item-render-fix.json) | 5 | 2 | 3 | 10.7s | false | 无 |
| 11:29:00 | [smoke-after-spa-wait-fix.json](./P3-04K-douyin-real-browser-smoke-after-spa-wait-fix.json) | 5 | **3** | **0** | 6.9s | **true** | 无 |
| 11:36:32 | [smoke-after-readiness-fix.json](./P3-04K-douyin-real-browser-smoke-after-readiness-fix.json) | 5 | **3** | **0** | 6.3s | **true** | 无 |

说明（不掩盖中间失败）：

- 首轮 4 条失败不是验证码，也不是「没有内容」，而是视频详情页冷启动渲染慢；单页诊断 [video-page-diagnostic.json](./P3-04K-douyin-real-browser-video-page-diagnostic.json) 与 [video-page-after-wait.json](./P3-04K-douyin-real-browser-video-page-after-wait.json) 证明了同一页面约 15s 后标题/h1/作者都会出现。
- 第二轮只读到 2 条，仍未达标，如实保留。
- 11:29 的第三轮先把「用『有标题无正文』猜验证码」的早退条件换成只认 `detectDouyinBlock(...)==='captcha'`，避免把 SPA 过渡态误判成风控，随即读到 3 条。
- 11:36 的第四轮再修正「就绪判据」：视频详情页不能拿侧栏推荐卡片当已读完，必须等 h1/detail 字段；同时给 CDP 请求加 20s 兜底超时。该轮同样 `itemsRead=3`。
- 最后两轮连续 `itemsRead=3`、0 失败、`ok=true`，样本文案为真实视频标题/作者/话题（见证据 JSON 的 `samples`）。两轮之间代码有演进，因此两轮都保留，不合并成一次。

---

## 4. 结论（按事实分开写）

### 4.1 验证码

- **本轮登录后的所有步骤（推荐探测、关注探测、两轮成功冒烟）均未出现「验证码中间页」或任何验证码/风控拦截。**
- 失败模式从 `P3-04I` 的「验证码中间页」变成了「视频详情页冷启动渲染慢」，属于可解释的加载时序问题，不是风控。
- **但不能据此宣称本方案解决了风控。** 这是单一账号、单一时段、两轮成功冒烟的样本；`P3-04I` 的验证码是真实发生过的。若后续再撞到验证码，正确行为仍是立即停止、保留窗口、由 owner 手动完成、不重试不绕过。
- 因此明确写：**本方案不保证规避抖音验证码/风控；本轮只证明「这次没撞到」。**

### 4.2 置真与未置真

| 项 | 结论 |
| --- | --- |
| 推荐流（`recommended`） | **本轮达到置真门槛**：`requestedFeed=recommended`、`usedFeed=recommended`、`loggedIn=true`、`itemsRead=3 ≥ 3`、`readFailures=0` |
| 关注流（`following`） | **不置真**：真实读到 0 卡片（账号关注流无作品），不是验证码、不是读取失败 |
| 执行器 / `runnable` | 只有生产冒烟证据（≤7 天）通过才置真；本轮证据支持推荐流置真，关注流仍不可运行 |
| 验证码恢复流程 | 代码与单测已就绪（停止 + 保留窗口 + 给 owner 可操作指引），本轮**没有真实验证码样本**可复验 |

### 4.3 没做什么（红线复核）

- 未点赞、未关注、未评论、未发私信、未发布、未改账号状态。
- 未识别/绕过/重试验证码；未换 IP/UA/延时硬刷。
- 未逆向或伪造 `x-secsdk-web-signature` / `a_bogus` 等签名接口。
- 未改 UA、未加 stealth/自动化隐藏参数。
- 未使用 owner 日常 Chrome Profile，未新建账号，凭据未进仓库/聊天/日志。
- 未触碰语音、工坊、桌宠状态代码。

---

## 5. 代码落点

- 新增 `apps/desktop-host/src/main/cdp-browser-engine.ts`：Chrome/Edge 探测、专用 Profile、CDP 单实例、Cookie 名称检查、`RealBrowserDouyinSession`（与 `ElectronDouyinSession` 同契约）。
- 新增 `apps/desktop-host/src/main/douyin-page-reader.ts`：页面读取脚本单点，Electron 与 CDP 共用，避免选择器漂移。
- `apps/desktop-host/src/main/electron-browser-engine.ts`：保留为回退驱动，改用共享读取脚本。
- `apps/desktop-host/src/main/v2-kernel-host.ts`：按 `v2-douyin-browser.json`（`driver: 'cdp-real' | 'electron'`，macOS 默认 `cdp-real`）选择驱动；默认仍关，owner 打开才跑。
- `packages/character-core/src/social-douyin.ts`：验证码文案改为可操作指引（停止、保留窗口、手动处理后重新发起）。
