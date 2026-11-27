# P3-04J · 外部 dsh 系抖音生态仓库调研：哪些值得鲸屿借鉴

> 日期：2026-11-27 · 分支：`research-external-dsh-repos`（基线 `feat/whale-isle-v2` @ `a1d9e5c`）· 状态：**只读调研，未改任何产品代码**
> 调研对象：7 个外部仓库，克隆到仓库外的 `/tmp/dsh-research/`（未克隆进本仓库，未改动被克隆仓库任何文件，未执行其安装脚本 / 依赖 / 二进制，未发起任何抖音真实请求）
> 触发背景：抖音 L1 只读接入（PR #5，`feat-social-douyin-personalized` @ `2de7e86`，未合并）生产链路真实冒烟撞上抖音「验证码中间页」→ 停止；本报告要回答的是「别人做同类事是用什么架构绕开这个技术门槛的」

---

## 1. 一句话结论

**借鉴三件事**：①「**真浏览器 + 真 profile + CDP**」而不是嵌入式 Chromium 驱动抖音（我们目前是 Electron 隔离 partition，这是我们撞上验证码中间页最可能的架构原因）；②「**风控码分级冷却**」（命中即停写、冷却时长按次数指数升级、读动作不受影响）；③「**兴趣只由真实行为证据推导**」（停留时长/完播比例/跳过，而不是画面主题）。**不借鉴三件事**：① 任何点赞/关注/评论/发布/私信/**@真人** 的写操作；② **纯 HTTP 逆向签名路线**（自算 `x-secsdk-web-signature` / `a_bogus`、整组照抄网页端公共参数）；③ 任何 UA 伪装 / stealth / 反检测。**DSH 生态位：不接。** 理由：DSH 宿主是 Windows 优先、插件规范与我们的 Electron + Zod 契约架构正交，接入等于为别人的宿主重写一层适配器，且我们自己的 `shared-protocol` 契约层已经是更好的单点事实源——真要开放生态，应该开放**我们自己的**契约，而不是兼容 DSH。

---

## 2. 七个仓库逐个一节

### 2.1 `LockyBee/dsh-douyin-agent`（109★）

**定位**：DSH 原生抖音助手（插件版 + Windows 独立软件版），自述「本机专用 Microsoft Edge 中浏览抖音电脑版，采样真实画面交给模型，按人格和实际观看行为更新兴趣」（`README.md:3`）。npm 包名 `dsh-douyin-browser-local`，版本 1.4.7（`package.json:3`）。

**技术栈**：Node.js ≥22.13（`package.json` `engines.node`）+ Playwright（`@playwright/cli` 0.1.22 / `@playwright/mcp` 0.0.83，`package.json` `dependencies`）+ Windows 专用（`package.json` `os: ["win32"]`）。DSH 宿主版本区间 `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.3.0-0`（`package.json` `engines.dsh` / `peerDependencies`）。

**许可**：MIT。LICENSE 文件第 1 行 `MIT License`，第 3 行 `Copyright (c) 2026 LockyBee and contributors`。**注意：GitHub API 报 `licenseInfo.spdxId = none` 是误判——LICENSE 文件确实存在且是标准 MIT 原文。**

**关键做法**

| 做法 | 出处 |
| --- | --- |
| **真 Edge + 持久 profile + 有窗口**：`chromiumImpl.launchPersistentContext(profile, { channel: 'msedge', headless: false, viewport: null, ignoreDefaultArgs: ['--mute-audio'], args: ['--remote-debugging-port=...', '--remote-debugging-address=127.0.0.1', '--autoplay-policy=no-user-gesture-required'] })` | `browser-host.mjs:132-135` |
| 宿主归属核对（只有自己命名的页才算「受管页」） | `core.mjs:722`、`browser-launcher.mjs:37-64` |
| **验证码/登录页检测**：`loginRequired = /扫码登录\|验证码登录\|登录后即可\|手机扫码登录/`；`verificationRequired = [...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible) \|\| /请完成下方验证\|请完成验证\|安全验证\|拖动滑块/` | `core.mjs:327-328`（同式见 `watch-mode.mjs:18`） |
| 撞验证码即停并把窗口留给本人（模型侧硬约束写进 system prompt） | `api-agent.mjs:82-83` |
| 撞验证码 → 返回 `needs_user`，文案「抖音需要验证码。窗口已保留，请手动完成后再发起任务。」 | `api-agent.mjs:323-327` |
| 自检项「登录与验证码」→ `CAPTCHA_REQUIRED` / `LOGIN_REQUIRED`，resolution 明写「大肥鱼不能代过验证码」 | `diagnostics.mjs:107-110` |
| **预算**：默认策略 `{ enabled: false, windows: ['00:00-24:00'], dailyMinutes: 10, dailyRequests: 30 }`（`video-limits.mjs:9`）；只记**实际播放**的活动区间，重启不清当天用量（`video-limits.mjs:49`、`accrue()` `:89-96`） | `video-limits.mjs:9,49,89-96` |
| 请求额度按日预留、越限抛 `watchStatus:'limited'` | `video-limits.mjs:134-136` |
| 时段判定（Asia/Shanghai，支持跨零点、合并重叠区间） | `video-limits.mjs:36-47` |
| **兴趣只由行为证据推导**：`BEHAVIOR_THRESHOLDS = { maxWallSeconds: 30, progressRateTolerance: 1.25, progressSlackSeconds: 0.25, sustainedSeconds: 8, shortVideoSeconds: 2, completionRatio: 0.6, quickSkipSeconds: 3 }`（`persona-memory.mjs:17`）；进度样本要能通过 `progressSample()` 的重算/卡顿/回退/拖动校验（`:34-42`）；按作品汇总 like/dislike/neutral 计数（`projectedInterests()` `:86-94`） | `persona-memory.mjs:17,34-42,86-94` |
| 人格学习拒绝在登录/验证/私信遮挡页面取证（`PERSONA_EVIDENCE`） | `persona-memory.mjs:19-27` |
| **用量账本**：按日 JSONL，只存计数不存提示词/联系人/凭据；未报告用量的请求标 `unknownRequests` 而不是当零 | `usage-ledger.mjs:19-48` |
| 记忆访问视图：`createAccessView()` 做 scope / 私聊 / 群聊 / supersedes / 冲突检测 | `memory-policy.mjs:44-101` |

**值得借鉴**
1. **真浏览器 + 持久 profile + `headless: false` 有窗口**（`browser-host.mjs:132-135`）。这是「架构上让平台不把正常浏览判成异常」的核心手段：不伪装，只是用一个真实浏览器看真实网页。
2. **验证码检测式清单**（`core.mjs:327-328`）——他们列了 `请完成下方验证/请完成验证/安全验证/拖动滑块` 四种文案 + 三个容器选择器。**但没有「验证码中间页」**，这是他们没覆盖到的形态（我们撞到的正是这个），见 §5。
3. **「兴趣只由行为证据推导」的阈值表**（`persona-memory.mjs:17`）：`sustainedSeconds: 8` / `completionRatio: 0.6` / `quickSkipSeconds: 3` / `progressRateTolerance: 1.25`。这套「进度样本可信性校验」（`:34-42`）值得对照我们的 `InterestSink.signalDelta()`——他们防的是「伪造进度」，我们目前只防「幅度噪声」。
4. **用量账本把「未报告」显式标为未知**（`usage-ledger.mjs:16,45`），而不是当零消耗——这个诚实口径值得抄思路。
5. **预算只记实际播放**（`video-limits.mjs:49`）：入口开着但没播的时间不计入配额。

**不借鉴及原因**
- 写操作全线（点赞/评论/分享/私信/转发/续火花）：越过我们 owner 拍板的 L1 只读红线（§6）。
- 「兴趣记忆与 QQ 机器人互通」（`memory.mjs` / `memory-policy.mjs` 的 qq / douyin / dsh 三平台 scope）：我们的记忆图谱已有自己的主体隔离模型，不引。
- Windows 专用实现（注册表、`msedge.exe` 硬编码路径、`tasklist`）——不适用于我们的 macOS 宿主。

---

### 2.2 `dafeiyu1314520/dsh-douyin-agent`（17★）

**定位**：「在专用浏览器里自主刷抖音的 DSH 插件」。npm 包名 `dsh-douyin-agent`，版本 1.4.7。

**技术栈**：与 LockyBee 同源（同一份代码的 fork）。最新提交 `8116834 "1.4.7: find Node under resources/runtime/*/dependencies and end the round when startup fails"`。

**许可**：MIT，LICENSE 第 3 行仍为 `Copyright (c) 2026 LockyBee and contributors`——**fork 未改版权行**。

**关键做法**：与 2.1 同源。差异化点是它多了 `autonomous-replies.mjs` / `capture-session.mjs` / `frame-composite.mjs` / `frame-grab.mjs` / `daily-report.mjs` / `diary-writer.mjs` 等文件（LockyBee 上游已把 diary/report 拆走了）。

**值得借鉴**：无新增（内容与 2.1 重复）。它的存在本身说明**同一个上游有多个 fork 在跑**，对我们判断「这条路可行、但需要持续跟版本」有参考价值。

**不借鉴及原因**：无独立价值；若未来要引用其代码，仍以 LockyBee 上游的 MIT 版权行为准（见 §7 三层划分）。

---

### 2.3 `AAAjzx111/dsh-douyin-agent`（0★）

**定位**：同名不同作者，实际是 LockyBee 上游的**再 fork**，npm 包名 `dsh-douyin-agent-plus`，版本 1.4.9（比上游 1.4.7 新）。最新提交 `0c6a9a9 "chore: 发布为 npm 包 dsh-douyin-agent-plus@1.4.9"`。

**技术栈**：同源。

**许可**：MIT，LICENSE 第 3 行 `Copyright (c) 2026 LockyBee and contributors`。

**关键做法**：同源。其独有文件仍是 `autonomous-replies.mjs` / `capture-session.mjs` / `frame-composite.mjs` / `frame-grab.mjs` / `daily-report.mjs` / `diary-writer.mjs`。

**值得借鉴**：无。

**不借鉴及原因**：0★、fork 的 fork、无人维护信号。**特别提示**：它比上游版本号更高（1.4.9 > 1.4.7），如果只按版本号「取最新」会取到最没有社区验证的那份——我们引用时应锁定上游 LockyBee。

---

### 2.4 `regrevia/Envoy` → `integrations/dsh/envoy-dsh`（273★，Python 主体）

**定位**：「蒸馏一切链接：长视频、长 PDF、网页 → 带来源定位的材料」。本路径是它的 DSH 集成包。

**技术栈**：Node（`index.js` / `launch.cjs`）+ 通过 `@deepseek-ai/dsh-mcp-client` 挂载 Envoy 的 stdio MCP bridge；Agent Skill 注册到 `ctx.skills`；监听 `agent/pre-step` 事件注入路由消息。DSH 版本要求 `engines.dsh >= 0.1.5`（`integrations/dsh/envoy-dsh/README.md`「Requirements」节）。

**许可**：`integrations/dsh/envoy-dsh/LICENSE` 为 **Apache License 2.0**（文件第 1-3 行 `Apache License / Version 2.0, January 2004 / http://www.apache.org/licenses/`）；同目录有 `NOTICE`。**Envoy 主仓的 LICENSE 需与本子目录分开确认——本报告只核实了 `integrations/dsh/envoy-dsh/` 这一层的 Apache-2.0。**

**关键做法**

| 做法 | 出处 |
| --- | --- |
| 插件形态：npm 包 + `cordis.bundle.yml`（bundle patch）+ `package.json` 的 `dsh` 字段（`bundle.patch` / `client.platform` / `client.inject`） | `integrations/dsh/envoy-dsh/package.json`、`cordis.patch.yml` |
| Skill 注册到公开 `ctx.skills` 服务；`inject = ['skills']`；`export const name = 'envoy-dsh'` | `integrations/dsh/envoy-dsh/index.js:34-35` |
| Skill candidate 结构：`{ name, description, invocation: { modelInvocable, userInvocable }, provider, source: 'bundled', resourceBase, rank, locator }` | `integrations/dsh/envoy-dsh/index.js:53-75` |
| **首步链接路由**：监听 `agent/pre-step`，本轮第一步且用户消息含公开 http(s) 链接时，前置一条 user-role 路由消息，指向 `mcp__envoy__*` 工具 | `integrations/dsh/envoy-dsh/index.js:1-27`、`:94-140` |
| 幂等：`LINK_ROUTING_MARKER = '[envoy-link-routing]'` + `LINK_ROUTING_FIRST_STEP = 1` 双保险 | `integrations/dsh/envoy-dsh/index.js:94-100` |
| **登录墙显式建模为 `challenge_required` + 人这一步**（import cookies for one site scope, or sign in once），而不是编造内容 | `integrations/dsh/envoy-dsh/README.md`「What changes when it is installed」表「Login wall」行 |
| **来源定位**：`material_id` 可引用；视频按时间轴读，ordered segments + keyframes + ASR transcripts 可定位到 `[mm:ss]` | `integrations/dsh/envoy-dsh/README.md` 首段与「Distill any link」节 |
| 读不到时给 `partial` + 明确命名 gap，而不是 plausible guess | 同上表「Unreadable page」行 |
| 跨平台 launcher 用纯 Node（`launch.cjs`）而非 POSIX shell，Windows 也能挂 | `integrations/dsh/envoy-dsh/launch.cjs`、`cordis.patch.yml` 注释块 |

**值得借鉴**
1. **「带来源定位的材料」这个概念本身**：`material_id` + `[mm:ss]` 级定位 + 「读不到就 `partial` 并点名 gap」。对照我们的 `ContentUnderstandingPipeline`（`packages/character-core/src/content-understanding.ts`）：我们目前是「逐条读取 → 配额内理解 → 记账」，**没有给理解结果一个可回溯的稳定引用**。值得借鉴的是：**在契约里给每条理解结果加一个 source locator（URL + 页内锚点 / 时间戳区间 + 内容哈希）**，让记忆落盘时能指回原始位置，也让「我看过这条」和「我记得这条」可区分。这条是纯架构设计，不涉及抄代码。
2. **「challenge_required + 人这一步」作为一等状态**：不是「失败」，而是「需要人完成某一步，并且状态可枚举」。我们的 `detectDouyinBlock()`（`packages/character-core/src/social-douyin.ts:217-236`）已经返回 `DouyinBlockKind`，方向一致；但 Envoy 把「人该做什么」写进状态本身，值得对齐。
3. **MCP 挂载 + Skill 注册的宿主扩展形态**：如果我们以后要开放第三方扩展，这是可参考的架构形状（但不是 DSH 那套，见 §4 结论）。

**不借鉴及原因**
- `envoy.read/1` 协议本身、版本化 `envoy.capabilities/1`：与我们的 Zod 契约体系重复，且 `integrations/skills/envoy/SKILL.md` 是 Envoy 自己的 skill 正文，**引用需保留 Apache-2.0 NOTICE**（见 §7）。
- 它的 launcher 里那段 base64+gzip 的内联 Node 载荷（`cordis.patch.yml` 的 `-e` 参数）：是为绕过 Windows `cmd.exe` 8191 字符命令行上限的权宜之计，我们不需要。

---

### 2.5 `Britneycode/dsh-fish-soul`（49★，2026-11-26 更新）

**定位**：「鱼 · 单角色人格与按人记忆…B站/抖音小号私信与自己刷视频」。单角色 `feiyu`，v0.19.4。

**技术栈**：Node ESM（`"type": "module"`，`package.json`），DSH 插件，`inject` 走 `cordis.patch.yml` + `dsh.client.inject: ["slots"]`。

**许可**：⚠️ **仓库根目录没有 LICENSE 文件**（`find . -iname '*LICENSE*'` 只命中 `lib/channels/vendor/douyin-bridge/LICENSE`）。但 `package.json` 有 `"license": "MIT"`，`README.md:170-172` 有「## 许可 / MIT」章节。**结论：无 LICENSE 文件，仅 package.json + README 标注 MIT**——归到 §7 的「引用代码前需再确认」档。

另外 `lib/channels/vendor/douyin-bridge/` 是 vendored 的第三方代码，其 `README.md` 明确写「取自 `pcmxiao/dsh-douyin-bridge` v0.1.0（commit `6e4bb7f`，2026-10-27），MIT 许可」，同目录有 MIT LICENSE；`lib/vendor/douyin-bogus.js` 头部写「来源：npm 包 `douyin-im@1.1.0` 的 `lib/anti-bot/aBogus.js`（`zhinjs/douyin-im`，MIT）」。

**关键做法**

| 做法 | 出处 |
| --- | --- |
| **两条路，默认纯 HTTP**：`douyin.browse.mode` = `http`（默认）/ `browser`（旧路，失败时自动退回） | `lib/douyin-browse.js:7-13` |
| **纯 HTTP 签名**：自己算 `x-secsdk-web-signature` = `md5(uifid_timestamp_SALT_query)`，`SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E'`（project 34 = douyin_web） | `lib/douyin-http.js:35-37,79-83` |
| `a_bogus`（SM3+RC4）用于 `comment/*` 端点 | `lib/douyin-http.js:93-97`、`lib/vendor/douyin-bogus.js` |
| **整组照抄网页端公共参数**（device_platform/aid/channel/version_code/screen_*/browser_*/engine_*/os_*/cpu_core_num…） | `lib/douyin-http.js:42-78` |
| **登录态**：cookie 落盘 `~/.dsh/fish-soul/douyin-cookie.json`；没有就从**正在跑的浏览器**用 CDP `Network.getCookies` 抓一次明文（Chrome 的 Cookies 文件是 DPAPI+AES 加密 + 浏览器开着时锁文件，copy 不了） | `lib/douyin-http.js:6-10` |
| **真浏览器 + 独立 user-data-dir**：`--remote-debugging-port` + `--user-data-dir`，`browserProcesses()` 清僵尸进程、**只删锁文件不删 profile** | `lib/channels/vendor/douyin-bridge/browser.mjs:294-310`、`:175-190`、`:300-304` |
| **验证码检测**：`/滑块验证\|安全验证\|请完成验证\|拖动滑块/` 或页面里存在 `rc-verifycenter\|verifycenter\|captcha` 的 iframe | `lib/douyin-social.js:217-221` |
| **「没读到验证码」与「没有验证码」必须分开**（否则等于把「不知道」当「不用验证」） | `lib/douyin-social.js:730-733`、`:1172` |
| **会话 ID 作为一等公民**：单聊会话 ID 形如 `0:1:<uidA>:<uidB>` 自带双方 uid，昵称只作展示不再参与授权判断 | `docs/douyin-identity-validation.md`「证据链」节、`lib/douyin-conversation.js` |
| 三道闸门：读按会话挑、入库要求可推出对端、发送必须逐段用会话 ID 校验 | `docs/douyin-identity-validation.md`「三道闸门」节 |
| 兴趣/记忆：从 `aweme/detail` + 评论抽结构化摘要（文案/话题/BGM/贴纸 OCR/图文张数/热评） | `lib/douyin-browse.js:40-76`（`extractWorkSummary`） |
| 每条停 5–20 秒后划走；`perDay` 上限 | `lib/douyin-browse.js:3`、`:178` |

**值得借鉴**
1. **「没读到」与「没有」必须分开**（`lib/douyin-social.js:730-733`）：如果我们未来要加验证码/风控识别的「三态」（未确认 / 确认无 / 确认有），这个区分是必须的，否则会把「不知道」当「不用验证」。**对我们当前尤其重要**——我们的 `detectDouyinBlock()` 是二态（captcha / login / 无），检测不到就当没有。
2. **会话 ID 作为身份一等公民**（`docs/douyin-identity-validation.md`）：昵称不可信、会话 ID 可自证。这是「以后要做写操作时」的身份基础，但**我们的 L1 只读暂时用不上**——记为「待议」。
3. **贴纸 OCR / 图文张数 / BGM 作为结构化摘要字段**（`lib/douyin-browse.js:40-76`）：我们的 `buildDouyinItemText()` 目前只抽标题/作者/话题/正文。可以借鉴「把一条视频能稳定抽到的结构化字段列全」这个思路（纯设计）。

**不借鉴及原因（红线）**
- **纯 HTTP 逆向签名路线整条不借鉴**：`lib/douyin-http.js` 的 `secsdkSignature()`（`:79-83`）、`aBogusSignature()`（`:93-97`）、`douyinBaseParams()`（`:42-78`）以及 `lib/vendor/douyin-bogus.js`（整份 SM3+RC4 实现）。这明确越过我们已写死的红线：「不逆向签名接口或伪造请求」（`docs/v2/evidence/P3-04I-douyin-personalized-verification.md` §2「不采用」①）。**本报告不给出任何实施路径。**
- **写操作全线**：点赞（`CLICK_LIKE_JS`，`lib/douyin-browse.js:125-131`）、发评论、回私信、@提醒、发表情包——越过 L1 只读红线。
- **用 CDP `Network.getCookies` 把明文 cookie 抓出来落盘**：见 §4 的专项判断——**判断为「不借鉴」**（理由：它把登录凭据从浏览器沙箱里搬到了磁盘明文文件，扩大了凭据暴露面，与我们「Cookie 只留本机隔离 Profile、不导出」的设计取向相反；且它只有在走纯 HTTP 路线时才有必要，而我们不走那条路）。
- `lib/vendor/douyin-bogus.js`（MIT，出处 `zhinjs/douyin-im`）：即使许可证允许，**它服务于我们不走的路线**，不进我们仓库。

---

### 2.6 `dbbdbdhdbxb-design/dsh-douyin-studio`（3★）

**定位**：「抖音自动化插件：用 CDP 驱动真 Chrome 刷推荐、回评论、发作品、记事件」。自述「它是给单个账号、私人在自己的机器上用的工具，不是给陌生人批量运营的服务」（`README.md:10`）。

**技术栈**：Node ESM + **自实现零依赖 CDP 客户端**（`lib/cdp.mjs`，不依赖 Playwright/Puppeteer）；DSH 插件，`cordis.patch.yml` 挂 `id: douyin-studio`；另有 CLI `node tools/dy.mjs`（44 条命令）。

**许可**：MIT。LICENSE 第 1 行 `MIT License`，第 3 行 `Copyright (c) 2026 辰辰辰chen`。`package.json:38` 亦标 `"license": "MIT"`。

**关键做法**

| 做法 | 出处 |
| --- | --- |
| **零依赖 CDP 客户端**，端口可配可探测（默认 9334）；教训写在文件头注释 | `lib/cdp.mjs:1-13`、`:22` |
| **真 Chrome/Edge + 独立 `--user-data-dir`**；**「绝不起第二个——第二个会抢同一个 profile，把登录态搞坏」** | `lib/cdp.mjs:76-79`、`:87-99` |
| profile 路径写死会导致「明明登过却又要扫码」且日志不报错——三个坑写进注释 | `lib/cdp.mjs:25-35` |
| **登录态只活在浏览器 profile 里**，不存密码、不存 cookie 到库里 | `README.md:90` |
| 扫码登录：**打开抖音首页 → 看有没有登录 → 没登录它自己会弹二维码 → 截那块图**；二维码 2–3 分钟过期，每次现截不缓存；二维码是 `#douyin_login_comp_scan_code` 里的 `<img>`（179×179），不是 canvas | `lib/login.mjs:1-14`、`:38-44` |
| **风控冷却**：`RISK_CODES = [352, 412, 2154, 3002]`；`RISK_RE = /(-352\|-412\|风控\|频繁\|操作太快\|too\s*many\|rate\s*limit\|captcha\|验证码\|安全验证)/i`；按次数指数升级 `30 → 60 → 120 → 360` 分钟封顶 6 小时；**只挡写动作，读不受影响** | `lib/risk.mjs:15-18`、`:50-60`、`:68-78` |
| **停损总闸**：一个文件挡住所有写操作（回评/私信/@/分享/发布/删除/队列重试），只读不受影响 | `README.md:97-109`、`lib/killswitch.mjs` |
| **预算四道约束**：通道日限 → 通道小时限 → 通道最小间隔 → 单人/单楼日限，最后卡总闸；默认 `perDay {comment:20, dm:15, at:10, own:5, publish:5}`、`perHour {comment:6,dm:5,at:4,own:3,publish:2}`、`minGapSec {comment:45,dm:60,at:60,own:30,publish:120}`、`totalPerDay: 40`、`perPeerPerDay {dm:2,comment:2}`、`perThreadPerDay: 1` | `lib/budget.mjs:38-60` |
| **账本坏了 = 一律拒绝（fail-closed）**：「宁可今天不回，也不要风控账号」 | `lib/budget.mjs:18-21` |
| **走 web API 而非 DOM 解析**（`/aweme/v1/web/...`），DOM 只做接口做不了的活 | `README.md:27-28`、`lib/api.mjs` |
| 抽帧拼图 3×2，15 秒片子 47 KB；**没抽就是 `frames: false`，绝不假装看过**；「描述要么来自真的看过那张图的调用方，要么就承认没看，不拿封面凑」 | `README.md:41-44`、`lib/watch.mjs:1-15` |
| 首跑必须 dry（`$DOUYIN_STUDIO_HOME/first-run.json`），真发不许 `declare: none` | `README.md:94-95` |

**值得借鉴（这是本次调研对我们最直接可操作的一份）**
1. **风控冷却的完整形状**（`lib/risk.mjs`）：①风控码白名单 `[352,412,2154,3002]` + 文本正则双通道判定；②按命中次数**指数升级**冷却时长；③**只挡写、读不受影响**（「出事的时候更需要看清楚现场」，`lib/risk.mjs:4-5`）；④冷却到期自动自愈（`riskState()` `:34-40` 对过期态直接返回未冷却，不写盘）。这套形状可以直接映射到我们未来任何「平台返回异常」的处置，即使我们当前只读。
2. **停损总闸 + 读不受影响**（`README.md:97-109`）：一个文件（或我们的等价物）能一键停掉所有写操作。这与我们 owner 红线「触发就停、如实报、不硬刷」的语义高度一致——**是「我们已经有了、可以更明确化」的方向**。
3. **fail-closed 的账本**（`lib/budget.mjs:18-21`）：账本损坏时宁可今天不回。这条我们可以直接对照我们的预算守卫。
4. **「没抽就是 `frames: false`，绝不假装看过」**（`README.md:41-44`）：这是我们 `ContentUnderstanding` 「解析失败不编造」原则的同构表达，值得作为我们 gate 的对齐引用。
5. **真 Chrome + 独立 user-data-dir + 「绝不起第二个」**（`lib/cdp.mjs:76-99`）：如果我们采纳真浏览器路线，「同一份 profile 只允许一个浏览器实例」这条必须写进我们的实现约束。

**不借鉴及原因**
- 全套写操作（发作品、评论、私信、@、分享、删除）——越过 L1 只读红线。
- **直接调抖音 web API**（`README.md:27-28`）：这是接口逆向路线，虽与我们的「不伪造请求」红线不完全重合（他们不自己算签名，而是从页面 XHR 里截获），但**我们当前 L1 的定位是「页面只读」，不是「接口直连」**；是否走这条路属于另一个工单的决策，不在本单范围。
- `lib/cdp.mjs` 的自实现 CDP 客户端：零依赖是优点，但我们要接的是「真浏览器 + CDP」，用成熟库（Playwright / chrome-remote-interface）成本更低、风险更小；**不必抄它的实现**，只借鉴它注释里的三条教训。

---

### 2.7 `kdcadmin/dsh_douyin_tools`（51★）

**定位**：「deepseek 自动刷抖音的 dsh 插件，能读评论，@你的账号，点赞视频和发布视频」。npm 包名 `dsh-douyin-life`（README 标题为「dsh-douyin-life（刷抖音）」）。

**技术栈**：Node 宿主半边（`index.js`，`export const name = 'douyin-life'`，`inject = ['webServer','tools','settings','llm','credentials','attachments']`，`index.js:48-49`）+ **Python MCP 半边**（`vendor/douyin-mcp/mcp_server.py`，FastMCP over stdio）+ Playwright 驱动本机 Chrome（`channel="chrome"`）。

**许可**：MIT。LICENSE 第 3 行 `Copyright (c) 2026 TiAmoSS`。`package.json:15` 亦标 `"license": "MIT"`。

**关键做法**

| 做法 | 出处 |
| --- | --- |
| **复用用户日常 Chrome 的默认 user-data-dir**（注释：「默认 profile 里就是本人已经登录的那个抖音」），只加 `--remote-debugging-port` | `index.js:1562-1568`、`:1591-1597` |
| **Chrome 已在跑时不强来**：`chromeRunning()` 检测到就返回 `needClose: true` + 提示「带着同一个默认 profile 再拉一次不会开调试端口，先把所有窗口关掉」 | `index.js:1570-1577`、`:1583-1597` |
| **验证码 → 自动切带界面**：`.need-captcha` 标记文件存在时 `DOUYIN_HEADLESS='0'`；标记消失后自动切回无头 | `index.js:573-574`、`:599`、`:2389-2400` |
| Playwright `launch_persistent_context(PROFILE_DIR, channel=..., headless=HEADLESS, locale='zh-CN', viewport=1440×900, user_agent=UA, args=['--disable-blink-features=AutomationControlled', ...])` | `vendor/douyin-mcp/mcp_server.py:461-478` |
| **UA 是硬编码的 Chrome 串**（`Chrome/155.0.0.0`），且 `a_bogus` 签名要求 UA 与屏幕指纹一致 | `vendor/douyin-mcp/mcp_server.py:88-94` |
| **登录证据 = cookie（sessionid / sessionid_ss / sid_tt）+ 页面头像**，两样都报 | `vendor/douyin-mcp/mcp_server.py:15`（模块 docstring） |
| **「有界面 vs 无头」渲染不同**：实测 `headless=new` 找不到发送按钮、打 @ 不出人；`headed + 1440×900` 正常 | `vendor/douyin-mcp/mcp_server.py:325-330`、`:414-417` |
| **同一份 profile 只允许一个 Chrome**（2026-10-23 事故：4 个 MCP / 10 个 Chrome 抢同一 profile）→ 固定调试端口，端口通就连它 | `vendor/douyin-mcp/mcp_server.py:389-402` |
| **谷时窗口**：`WINDOWS = { noon: {12:00-14:00}, night: {00:30-08:30} }`；`perDay` 每天总量上限；「工作日 9:00–12:00、14:00–18:00 是高峰不跑」 | `lib/state.mjs:28-36` |
| 记忆：`memory/YYYY-MM.md` 按月记；人设 `persona.md` + `personaPrompt`；下一轮开头带上最近记忆 | `README.md`「界面」节后「记忆和人设」段 |
| 写动作闸门：`autoLike` / `autoComment` / `autoPublish` **默认全关**，越闸只能靠调用方传 `force: true` | `index.js:105-116` |
| 未确认回执返回 `unknown`，**保留额度且不自动重发** | `README.md` 0.2.1 修复版第 1 条 |

**值得借鉴**
1. **验证码 → 自动切「带界面」让本人手动过 → 过了自动切回无头**（`index.js:599`、`:2389-2400`）。这是**我们最可能直接受益的一条**：我们目前是「撞到验证码中间页就整体停」，他们是「撞到验证码就把浏览器窗口抬到前台让人处理，处理完自动恢复」。这在**不绕过风控**的前提下大幅改善了可用性。注意他们的实现是「**有头/无头切换**」，不是「识别并自动过验证码」——性质完全不同。
2. **同款「不确定就诚实报」**：`unknown` 回执保留额度、不自动重发（README 0.2.1）。
3. **谷时窗口 + 每日总量上限** 的口径（`lib/state.mjs:28-36`）：和我们已有的 `00:00–08:00 禁发` 方向一致，但他们把「高峰不跑」写成了显式配置。

**不借鉴及原因**
- 全套写操作 + `force: true` 逃生舱——越过 L1 只读红线，且 `force` 机制本身在我们的门禁模型里是反模式。
- **硬编码 UA + 屏幕指纹**（`vendor/douyin-mcp/mcp_server.py:88-94`）：这是为 `a_bogus` 签名服务的，服务于我们不走的路线。而且 `CHROME_UA` 是 Chrome 155 而仓库当前时间已到 2026-11，硬编码 UA 是**会过期的技术债**。
- `--disable-blink-features=AutomationControlled`（`:472`）：这一条接近反检测。我们的判断是：**不引入**（见 §5 结论）。
- `vendor/douyin-mcp/mcp_server.py` 里的 a_bogus 相关说明与 Web API 直连：**不借鉴**。

---

## 3. 对照我们现状的差距表

> 「我们的现状」列的路径按本报告基线 `feat/whale-isle-v2` @ `a1d9e5c` 标注；抖音个性化流的路径标注为 `feat-social-douyin-personalized` @ `2de7e86`（未合并）。

| 能力 | 我们的现状 | 他们怎么做 | 差距 | 建议 |
| --- | --- | --- | --- | --- |
| **浏览器驱动** | Electron `session.fromPartition(...)` + 隐藏 `BrowserWindow`；`apps/desktop-host/src/main/electron-browser-engine.ts:50,191-197,291-298`（`feat-social-douyin-personalized`） | **全部 4 个非 fork 仓库都是「真 Chrome/Edge + 真 profile + CDP」**：`browser-host.mjs:132-135`（`channel:'msedge'`, `headless:false`）、`lib/cdp.mjs:87-99`、`browser.mjs:307-308`、`mcp_server.py:461-478` | ⚠️ **最大差距**。我们是唯一用嵌入式 Chromium 驱动抖音的。Electron 默认 UA 含 `Electron/<version>` 字样（本项目 `electron ^45.4.1`，`apps/desktop-host/package.json:100`）——**据 Electron 默认行为推断，未在真机抓包核对 UA 字符串**；且隔离 partition 的浏览器指纹/登录上下文与真人日常浏览差异更大 | **借鉴（最高优先）**：下一轮重验改用真 Chrome/Edge + 持久 profile + CDP。详见 §4 |
| **登录态存储** | 隔离 partition + `cookies.json` 回写/导入；`electron-browser-engine.ts:339-381`（只落本机隔离 Profile，不进 Git） | ① 真浏览器持久 profile（Cookie 只活在 profile 里，`README.md:90` studio）；② 默认 profile 直接复用（kdcadmin `index.js:1562-1568`）；③ 明文 cookie 落盘（fish-soul `lib/douyin-http.js:6-10`） | 我们比①更干净（不导出明文），比③更安全。② 与我们的隔离策略冲突 | **不借鉴**②③；保持现状 |
| **UA / 反检测** | 全仓库 grep `setUserAgent` / `userAgent` **零命中**（唯一命中是 `apps/desktop-host/src/renderer/director/shell/titlebar.tsx:26` 读 `navigator.userAgent` 判 mac，与 UA 覆盖无关） | 同样**不做伪装**：grep `stealth` / `anti-detect` / `navigator.webdriver` / `webdriver` 在 7 个仓库 **零命中**。唯一 UA 相关是 fish-soul / kdcadmin 为 `a_bogus` 签名硬编码 UA，服务于它们各自不走的签名路线 | ✅ **无差距**。我们和他们的共同点正是「不伪装，只把架构做得更像真人浏览」 | **保持**。明确写进红线：不做 UA 覆盖 / stealth / 反检测（§6） |
| **验证码识别** | `detectDouyinBlock()`：`CAPTCHA_RE` 含 `验证码中间页\|人机验证\|安全验证\|请完成验证\|完成下方验证\|拖动滑块\|访问过于频繁\|操作过于频繁\|captcha\|turnstile\|recaptcha\|verify you are are human`；`social-douyin.ts:210-236`（`feat-social-douyin-personalized`） | LockyBee：`core.mjs:327-328` 只覆盖 `请完成下方验证/请完成验证/安全验证/拖动滑块` + 容器选择器，**无「验证码中间页」**；studio：`lib/risk.mjs:16` 正则含 `captcha\|验证码\|安全验证`；fish-soul：`lib/douyin-social.js:217-221` 含 `滑块验证\|安全验证\|请完成验证\|拖动滑块` + iframe 检测 | 我们**比他们都全**（已覆盖「验证码中间页」）。但他们都还有一样我们没有的：**「没读到」与「没有」的三态区分**（fish-soul `lib/douyin-social.js:730-733`） | **借鉴**三态区分：我们现在是二态，检测不到就当没有；应区分「确认无 / 确认有 / 未确认」 |
| **验证码处置** | 撞到即停：抛 `PERMISSION_DENIED(recoverable:false)` / `CAPTCHA_REQUIRED`，执行器中止；`social-douyin.ts:467-471` | ① LockyBee：停下 + **窗口留给本人**（`api-agent.mjs:323-327`、`diagnostics.mjs:107-110`）；② kdcadmin：**自动切带界面**让本人手动过，过完自动切回无头（`index.js:599`）；③ studio：风控码 → 冷却 + 只挡写（`lib/risk.mjs`） | 他们都比我们**多做了一步「给人一个可操作的恢复路径」**。我们目前是「停了，但用户不知道下一步做什么」 | **借鉴**：至少做到 LockyBee 那一档——停下时明确告诉 owner「请在保留的窗口里手动完成，完成后重跑」；**待议**：kdcadmin 的自动切有头/无头切换（我们的窗口本来就常驻可交互，可能不需要） |
| **风控码分级冷却** | 无 | studio：`RISK_CODES=[352,412,2154,3002]`、按次数指数升级 `30→60→120→360` 分钟、只挡写读不受影响、到期自愈；`lib/risk.mjs:15-18,50-60,68-78` | 我们没有命中码的语义化分级，只有「停」 | **借鉴（架构形态）**：我们当前只读，可以先只落「分级冷却 + 到期自愈」的**通用机制**（不针对任何写操作） |
| **每日预算口径** | 默认关 / 每日 ≤2 次且累计 ≤30 分钟 / 间隔 90–150 分钟 ±20% 抖动 / 收官或失败后冷却 ≥60 分钟 / 00:00–08:00 完全禁发 / 连续 2 次失败当日停发 / 单次 ≤20 条 / ≤10 分钟 / ≤8 次模型调用；`packages/shared-protocol/src/social.ts:202-212`、`:134-136` | LockyBee：`dailyMinutes`/`dailyRequests` 双额度（默认 10 分钟 / 30 次）、只记实际播放、Asia/Shanghai 时段；`video-limits.mjs:9,49,89-96`。studio：四道约束（通道日/小时/最小间隔/单人单楼）+ 总闸 + fail-closed；`lib/budget.mjs:38-60,18-21`。kdcadmin：谷时窗口 + `perDay`；`lib/state.mjs:28-36` | ✅ 我们**比他们严格得多**（我们有冷却/抖动/禁发时段/连续失败停发，他们基本只有日额度+时段） | **保持我们的口径**。唯一可借鉴：LockyBee「**只记实际播放**」（`video-limits.mjs:49`）——如果我们把「打开页面但没读」也算进 30 分钟，口径偏严 |
| **模型调用预算** | 单次 ≤8 次模型调用（`social.ts:204` 注释） | LockyBee：`maxRequests` 每日请求数上限 + `UsageLedger` 记账；`video-limits.mjs:134-136`、`usage-ledger.mjs:19-48` | ✅ 我们有（≤8 次/轮）。他们多了**跨日持久 + 按来源/用途/模型分组**的账本 | **借鉴**：我们的 `UsageLedger` 是否有「未报告用量标未知」这个口径——LockyBee 明确 `unknownRequests` 不当零（`usage-ledger.mjs:16,45`） |
| **兴趣推导依据** | `InterestSink.signalDelta()` = `(interestRelevance-0.5) × sentimentFactor`，单次 ±0.5 封顶，|delta|<0.05 视为噪声不沉淀；`packages/character-core/src/interest-sink.ts:29-41` | LockyBee：**行为证据**——`BEHAVIOR_THRESHOLDS`（`sustainedSeconds:8` / `completionRatio:0.6` / `quickSkipSeconds:3` / `progressRateTolerance:1.25`），且进度样本要过「重算/卡顿/回退/拖动」校验；`persona-memory.mjs:17,34-42,58-85` | ⚠️ 我们目前**完全依赖模型的 `interestRelevance` 数值**；他们要求「有行为证据才给倾向，没有就待观察」。我们没有「模型说喜欢但实际只停了 1 秒就划走」的防线 | **借鉴（重要）**：给兴趣沉淀加**行为证据层**——至少区分「实际停留/完播比例」与「模型自评」，前者优先。这与我们契约层的「程序不发明偏好」原则一致 |
| **兴趣去重/摘要/时间线** | `InterestSink` 写 episodic event 节点（`nodeType:'event'`，`importance:0.4`，`confidence:0.9`）+ 按话题更新 `PreferenceStore`；`interest-sink.ts:64-80` | LockyBee：按作品聚合 evidence、每条作品只计一次、`supersedes` 链 + 冲突标记；`memory-policy.mjs:75-101`、`persona-memory.mjs:86-94`。fish-soul：`extractWorkSummary()` 抽结构化摘要；`lib/douyin-browse.js:40-76` | 我们没有「同一作品只计一次」的显式去重，也没有 supersedes/冲突标记 | **借鉴**：①同作品去重键；②`supersedes` 概念（我们记忆图谱的 `derivedFromIds` 已有级联删除，但无「事实被纠正」的显式链） |
| **内容理解的来源定位** | `ContentUnderstanding` = `{ summary, topics, sentiment, interestRelevance }` + `item{platform,url,title,...}`；`packages/character-core/src/content-understanding.ts:57-63` | Envoy：`material_id` + `[mm:ss]` 级定位 + `partial` + gap 命名；`integrations/dsh/envoy-dsh/README.md` | ⚠️ 我们有 `url` 但**没有页内锚点/时间戳/内容哈希**，无法从记忆里回指到「哪一段」 | **借鉴**：在 `ContentUnderstanding` 契约里加 source locator（URL + 锚点区间 + 内容哈希），让记忆可回溯。这条是契约变更，须走「契约先行」工单 |
| **理解层配额与记账** | 逐条读取 → 配额内理解 → 记账（`content-understanding.ts` 走 `UnderstandingGatewayPort` 窄端口，模型不可用时抛错不静默退化） | LockyBee：`removeHistoricalImages()`——前几轮文字保留、**图片仅保留最近一次采样**，避免反复上传旧画面；`api-agent.mjs:104-110` | 我们没有「图片历史裁剪」，多模态场景下 Token 成本可能更高 | **借鉴**：多模态理解的历史帧裁剪策略 |
| **记忆可访问性视图** | `InterestMemoryPort` 窄端口 + `derivedFromIds` 级联删除 | LockyBee：`createAccessView()` —— scope 校验、私聊/群聊隔离、`supersedes`、冲突标记、访问预算（单次来源窗口 ≤5000 条、遍历 ≤128 节点/深度 ≤8）；`memory-policy.mjs:44-101` | 我们目前没有「一次来源窗口的访问视图」这一层 | **借鉴**：如果我们未来把记忆开放给多个会话/来源，需要一个等价的访问视图层 |
| **写操作边界** | **严格 L1 只读**：契约 `interactionMode: z.literal('readonly')`（`packages/shared-protocol/src/social.ts`）+ SocialRuntime 运行时拦截 + 能力矩阵「授权 + 已实测」双条件 | LockyBee：公开评论/自主分享/私信/转发；studio：发作品/回评/私信/@/删除；kdcadmin：点赞/评论/@/发布/私信/表情包；fish-soul：点赞/评论/私信 | ⚠️ **他们全都越过了我们的红线** | **不做**（§6）。仅作为「行业里别人做到哪」的记录 |
| **DSH 插件生态位** | 无。当前是 Electron 主进程 + `packages/shared-protocol` Zod 契约 + 本地 WebSocket JSON-RPC 总线（`18760`/`18765`） | 4 个插件仓库 + 1 个 Envoy 集成都走「npm 包 + `cordis.bundle.yml` + `engines.dsh` + 可选 `dsh.client`」 | 我们已有自己的契约层与总线 | **不接 DSH**（§4 结论） |

---

## 4. 专门一节：登录态与验证码（B 题）+ 我们下一轮重验的建议方案

### 4.1 事实对照（逐条核实）

**我们这边（`feat-social-douyin-personalized` @ `2de7e86`）**
- 浏览器：`apps/desktop-host/src/main/electron-browser-engine.ts` 用 `session.fromPartition(...)`（`:50`）+ 隐藏 `BrowserWindow`（`:293-298`）+ 可选的可见登录窗（`:191-197`），**不是真 Chrome/Edge**。文件头注释自述「不连接用户日常 Chrome Profile」（`:3`）。
- 登录态：隔离 partition + `cookies.json` 导入/回写（`:339-381`），只在本机隔离 Profile 目录，不进 Git。
- UA：全仓库 grep `setUserAgent` / `userAgent` **零命中**（唯一命中 `apps/desktop-host/src/renderer/director/shell/titlebar.tsx:26` 是读 `navigator.userAgent` 判 macOS，与覆盖 UA 无关）。Electron 默认 UA 含 `Electron/<version>` 字样（本项目 `electron ^45.4.1`，`apps/desktop-host/package.json:100`）——**据 Electron 默认行为推断，未在真机抓包核对 UA 字符串**。
- 真实结果：owner 2026-11-27 09:56:49 扫码登录成功（隔离 `e2e-profile`，只检查 Cookie 名称 `sessionid` / `sessionid_ss` / `sid_guard` / `passport_csrf_token`，未读取值）；09:59 只读 probe 读到推荐流 8 张卡片、`/follow` 2 张（< 门槛 3）；10:04 生产冒烟撞上「验证码中间页」（正文为空）→ 停止，`ok=false`、`runnable=false`、状态 `IMPLEMENTED_UNVERIFIED`。原始证据：`docs/v2/evidence/P3-04I-douyin-captcha-intermediate.json`（三阶段 `title: "验证码中间页"`、`cards: 0`）、`docs/v2/evidence/P3-04I-douyin-personalized-verification.md` §4。

**他们那边（逐条核实，文件:行号）**

| 仓库 | 驱动方式 | profile | 有头/无头 | 登录态存哪 |
| --- | --- | --- | --- | --- |
| LockyBee | Playwright `launchPersistentContext` | 专用 profile | **`headless: false`**（`browser-host.mjs:132-135`） | 只在专用 Edge profile 里，不导出（README「第一次使用」第 2 步：在专用 Edge 中手动登录或完成验证码） |
| studio | 自实现 CDP 客户端 | 真 Chrome/Edge + 独立 `--user-data-dir`（`lib/cdp.mjs:87-99`） | 有窗口（`--window-size=1440,900`） | 只活在浏览器 profile（`README.md:90`） |
| fish-soul | vendored 零依赖 CDP | 独立 `--user-data-dir`（`browser.mjs:307-308`） | 可切（`windowMode()` → `'background'` 时停到屏幕外） | ①浏览器 profile；②（http 模式）明文 cookie 落盘 `~/.dsh/fish-soul/douyin-cookie.json`（`lib/douyin-http.js:6-10`） |
| kdcadmin | Playwright `launch_persistent_context` | **直接复用用户日常 Chrome 默认 user-data-dir**（`index.js:1562-1568`） | 默认无头，**撞验证码自动切有头**（`index.js:599`） | profile；或 CDP 连本人已开的 Chrome（`mcp_server.py:354-360`） |

**结论一（无争议）**：**没有一个仓库用嵌入式 Chromium 驱动抖音**；全部是「真浏览器 + 真 profile + CDP」。**没有任何仓库做反检测/改 UA/stealth**——grep `stealth` / `anti-detect` / `navigator.webdriver` / `webdriver` 在 7 个仓库零命中。它们的路线是「**架构上更像真人浏览**」（真浏览器、持久 profile、有窗口、同一份 profile 只允许一个实例）而不是「**伪装成真人**」（改 UA、藏 webdriver）。

**结论二（无争议）**：验证码处置口径与我们**一致**——一律**停下、交给本人、绝不代过**：
- LockyBee：`api-agent.mjs:82-83`（模型 system prompt 硬约束「不绕过登录或验证码。遇登录或验证码应停下，告诉用户在保留的专用窗口完成」）；`api-agent.mjs:323-327`（`needs_user`，「窗口已保留，请手动完成后再发起任务」）；`diagnostics.mjs:107-110`（自检 → `CAPTCHA_REQUIRED`/`LOGIN_REQUIRED`，resolution 明写「大肥鱼不能代过验证码」）；`autonomous-watch.mjs:208,217`（撞到即 `needs_user` 停止本轮）。
- studio：风控码分级冷却 + 只挡写（`lib/risk.mjs`）。
- kdcadmin：`.need-captcha` 标记 → 切有头 → 本人手动 → 自动切回（`index.js:573-574,599,2389-2400`）。

**结论三（有价值的新发现）**：**他们的检测式里没有「验证码中间页」**。LockyBee 的 `core.mjs:327-328` / `watch-mode.mjs:18` 覆盖的是「请完成下方验证/请完成验证/安全验证/拖动滑块」+ `#captcha_container` / `[data-e2e="captcha-container"]`；studio 的 `lib/risk.mjs:16` 覆盖 `captcha|验证码|安全验证`；fish-soul 的 `lib/douyin-social.js:217-221` 覆盖 `滑块验证|安全验证|请完成验证|拖动滑块` + `rc-verifycenter` iframe。**grep 全 7 仓，「验证码中间页」只在两处出现，且都不是产品代码**：
- `Britneycode-dsh-fish-soul/test/douyin-browser.mjs:62`（注释）：「某些环境（安全软件 / 浏览器扩展）会把 www.douyin.com 换成字节的「验证码中间页」，盖掉本地 mock 页面还吃掉点击。」
- `regrevia-Envoy/docs/acceptance/envoy-read-failure-2026-10-25.md:117`：「于是模型改用主机自己的侧边栏浏览器打开页面（撞上验证码中间页），再把封面…」

也就是说：**我们撞到的是一个他们也没在产品代码里显式建模的形态**。我们的 `CAPTCHA_RE`（`social-douyin.ts:210-211`）反而是覆盖到了。这说明我们的**识别层不弱，弱的是「用什么浏览器去看」**。

### 4.2 判断：为什么会撞到「验证码中间页」

**判断（中等把握，非实测结论）**：我们用的是 Electron 隔离 partition 的嵌入式 Chromium，而 4 个对照组全部用**真 Chrome/Edge + 持久 profile**。差别不是「我们伪装得不好」（我们没伪装），而是**浏览上下文的可信度不同**：真实浏览器的 UA 串不含 `Electron/`、真实 profile 有长期积累的站点存储/设备指纹、同一份 profile 跨会话稳定、还有真实用户交互历史。抖音的风控判据里，这些是「是不是一个正常人在用这个浏览器」的主要输入。我们的隔离 partition 每次都是全新的、无历史的、UA 带 `Electron/` 的上下文——**从平台视角看确实更像自动化**。

**必须如实标注的不确定项**：以上是**基于代码形态的推断**，不是实测结论。我们**没有**抓包核对过抖音到底看了哪些信号，**没有**验证过「换成真 Chrome 后就不会撞验证码中间页」。我们唯一的事实是：2026-11-27 10:04 在 Electron 隔离 partition 上撞到了。

### 4.3 下一轮重验的建议方案

**建议方案 A（推荐）：换真浏览器 + 持久 profile，形态对齐对照组**

1. 在 macOS 上用本机已装的 **Google Chrome**（或 Edge），以**专用持久 profile 目录**（不是 Electron partition）启动，`--remote-debugging-port` 暴露到 127.0.0.1，通过 **CDP** 驱动（Playwright `connectOverCDP` 或 `chrome-remote-interface`）。
2. **owner 在这个真浏览器窗口里亲手扫码登录**（和 LockyBee / studio 的口径一致）。登录态留在专用 profile 里，我们**不导出 cookie**、不读 cookie 值（继续沿用「只检查 Cookie 名称」的现有口径）。
3. 重跑只读 probe（推荐流 / 关注流），**记录是否还出现「验证码中间页」**。这是本方案唯一要验证的命题。
4. 重跑生产冒烟；`ok=true` 且读到 ≥3 条才置 `verified`。

**风险与代价（必须如实列出）**
- **不是零成本换浏览器**：真浏览器方案引入一个常驻外部进程 + 一个调试端口，进程生命周期管理、端口占用、profile 锁（他们三个仓库都为此踩过坑：`lib/cdp.mjs:76-79`「绝不起第二个」、`mcp_server.py:389-402` 2026-10-23 事故、`index.js:1583-1597` 的 `needClose` 提示）都要我们自己再踩一遍。
- **Windows-first 的实现不能直接搬**：LockyBee `channel:'msedge'` + `os:["win32"]`、studio/kdcadmin 的 `tasklist`、注册表路径，在 macOS 上都要重写。**建议只借鉴架构形态，不抄任何实现。**
- **profile 隔离 vs 真实性的张力**：用**专用** profile（不是用户日常 profile）能保住我们的隔离承诺，但真实度低于「复用日常 profile」（kdcadmin 的做法）。**我们建议先用专用 profile 试**——它比 Electron partition 真实（真浏览器 + 持久存储 + 稳定 UA），又不碰 owner 的日常浏览会话。**是否要更激进地复用日常 profile，属于需要 owner 拍板的问题，本单不代拍。**
- **仍然可能撞验证码**：真浏览器不保证不撞。**我们的处置口径不变**：撞到就停（已有 `CAPTCHA_REQUIRED` 识别），并**考虑补上 LockyBee 那一档的恢复路径**——停下时明确告诉 owner「请在保留的窗口里手动完成，完成后重跑」（现在我们停了但没给可操作指引）。
- **本方案不改变任何红线**：不识别/不绕过/不自动过验证码；不点赞/不关注/不评论/不发私信；不逆向签名接口；不伪造请求；不改 UA / 不做 stealth。

**建议方案 B（次选，可并行）：把「保留窗口给本人处理」做成产品能力**
即使不换浏览器，也先把恢复路径做出来：撞到验证码时**不销毁浏览器上下文**，把可交互窗口呈现给 owner，并给出明确的下一步（完成后重跑）。这条与换浏览器解耦，且是 LockyBee / kdcadmin 都在做的。

**建议方案 C（不推荐）：走 fish-soul 的纯 HTTP 路线**
**明确不推荐、不给实施路径**。它要求自算 `x-secsdk-web-signature` 与 `a_bogus`、整组照抄网页端公共参数（`lib/douyin-http.js:42-97`），明确越过我们「不逆向签名接口或伪造请求」的红线。

**关于 fish-soul「CDP 取 cookie 落盘」这部分的专项判断**（按 coordinator 要求分层标注）

| 层次 | 判断 | 理由 |
| --- | --- | --- |
| 属于「绕过验证码」吗？ | **不属于** | 它跟验证码无关。它是**在已经登录成功之后**，把浏览器里已有的登录凭据搬到 HTTP 客户端可用的地方。验证码门槛在它这里根本没出现。 |
| 属于「伪造请求」吗？ | **属于，且是核心部分** | 它的 HTTP 请求必须带自己算的 `x-secsdk-web-signature`（`lib/douyin-http.js:79-83`）和 `a_bogus`（`:93-97`）、以及整组照抄的网页端公共参数（`:42-78`）。**这正是我们红线里「不逆向签名接口或伪造请求」所指的。** |
| 属于「改账号状态」吗？ | 不属于（纯读部分） | 读不改变账号状态。 |
| 净判断 | **不借鉴。** | 「取 cookie」这一步单独看技术上可行，但它**只服务于我们不走的签名路线**；且它把登录凭据从浏览器沙箱搬到磁盘明文文件，扩大了凭据暴露面，与我们「Cookie 只留本机隔离 Profile、不导出」的设计取向相反。**如果未来 owner 决定走纯 HTTP 路线，这条要重新评估，但那是另一个工单、另一份红线讨论。** |

---

## 5. 专门一节：DSH 是什么、要不要接（A 题）

### 5.1 DSH 是什么（实测自 5 个仓库）

DSH = **DeepSeek Harness**（`deepseek-ai/dsh`，见各仓库 `peerDependencies: {"@deepseek-ai/dsh": ...}` 与 README 的「兼容的 DSH 宿主」表述）。它不是我们 AGENTS.md 里那份「DeepSeek-Harness」开源壳，而是 `deepseek-ai` 的商业宿主产品。

**插件规范（5 个仓库一致的模式）**

| 要素 | 形式 | 出处 |
| --- | --- | --- |
| 分发单元 | npm 包 | 各仓 `package.json` |
| 挂载声明 | `cordis.bundle.yml`，形如 `- insert: [{ id: <命名空间名>, name: <包名>, config: {...} }]`；`id` 必须等于 `index.js` 里 `export const name` | `LockyBee/cordis.bundle.yml`；`studio/cordis.patch.yml`（注释块解释 patch 叠加顺序）；`kdcadmin/cordis.patch.yml`（注释块解释 `id` 必须等于 `export const name = 'douyin-life'`）；`fish-soul/cordis.patch.yml`；`envoy-dsh/cordis.patch.yml` |
| 宿主版本约束 | `package.json` `engines.dsh` 区间 | LockyBee `>=0.2.0-rc.2 <0.2.1-0 \|\| >=0.2.1-rc.2 <0.3.0-0`；Envoy `>=0.1.5` |
| 能力注入 | `export const inject = ['tools']` / `['webServer','tools','settings','llm','credentials','attachments']` / `['skills']` | `LockyBee/dsh-plugin.mjs:20`；`kdcadmin/index.js:49`；`envoy-dsh/index.js:35` |
| 工具声明 | 一份 `{name, description, parameters(JSON Schema), timeoutMs, output:{schema,render}, execute}` 目录 | `LockyBee/tool-definitions.mjs:4-88`、`dsh-plugin.mjs:106-146` |
| 设置页 UI | 可选 `dsh.client: { platform:'web', inject:['@deepseek-ai/dsh-client-ui-settings-general'] }` + 仓库自带 `client.js` | `LockyBee/package.json` `dsh.client`；`LockyBee/client.js` |
| 设置声明 | `export const Config = z.object({...})`，每个字段必须 `.extra('volatile', true)` | `kdcadmin/index.js:92-140`（含「schemastery 彻底拿不到时插件照常加载」的容错注释） |
| 宿主扩展点 | `ctx.get(service)` 取宿主服务；`ctx.skills` 注册 Skill；`agent/pre-step` 事件可拦截 | `LockyBee/dsh-plugin.mjs:39-41`；`envoy-dsh/index.js:34-35,94-140` |
| Skill 规范 | `{name, description, invocation:{modelInvocable,userInvocable}, provider, source, resourceBase, rank, locator}` | `envoy-dsh/index.js:53-75` |

**关键判断：DSH 插件规范本身没有强制「跨语言契约先行」那一层。** 工具参数是手写的 JSON Schema 片段（`tool-definitions.mjs`），且各仓库自己实现了一个手写校验器（`validateToolArguments()`，`tool-definitions.mjs:91-121`）。这正是我们的 AGENTS.md 第一层铁笼要消灭的东西——我们用 Zod 生成 TS / JSON Schema / Pydantic 跨语言单点事实源（`packages/shared-protocol`）。**如果接 DSH 插件规范，就等于把我们的契约层降级为「手写 JSON Schema + 手写校验器」的平行实现。**

### 5.2 要不要接 DSH？——**不接**

**理由（按重要性排序）**

1. **规范正交，接入等于为别人的宿主重写一层适配器**。DSH 插件是「Node 包 + cordis patch + `ctx.get()` 服务注入 + `ctx.skills` + `agent/pre-step`」，我们的是「Electron 主进程 + `packages/shared-protocol` Zod 契约 + 本地 WebSocket JSON-RPC 总线（18760 / 18765）」（`AGENTS.md` §1.4）。两者没有可复用的公共层，接 DSH 意味着我们在自己产品里塞进一个 DSH 运行时。
2. **我们已经有更好的单点事实源**，接 DSH 会引入第二套（手写 JSON Schema）事实源，直接违反 AGENTS.md §3.1 第一层铁笼。
3. **平台适配成本高**：4 个插件仓库都是 Windows-first（`package.json` `os:["win32"]`、注册表、`msedge.exe` 硬编码、`tasklist`、PowerShell）。我们的桌面宿主是 macOS + Electron（`apps/desktop-host/package.json` `electron ^45.4.1`）。把「真 Edge 浏览器宿主」搬到 macOS Electron 宿主里，是一个独立工单的工作量，不是本单能顺手带出来的。
4. **生态位本身的价值不成立**：我们做的是**桌宠**（本地运行时、OBS 图层、桌宠窗），DSH 生态是**对话宿主里的能力插件**。第三方为 DSH 写的插件，移植到鲸屿的收益 ≈ 0（它们依赖 `ctx.get('llm')` / `ctx.get('attachments')` / DSH 的 `cordis` 配置树，这些在我们的宿主里没有对应物）。**「能接第三方插件」这个生态位对我们不是资产。**
5. **如果真的想要开放生态，应该开放我们自己的契约**（`packages/shared-protocol` 生成的 JSON Schema + WebSocket 协议），而不是兼容 DSH。这一点可以作为未来独立工单讨论，**本单不启动**。

**结论**：**不值得。** DSH 的**设计思想**（能力注入、Skill 分级、宿主服务取用）我们已经在自己的架构里有对应物，不需要为它做兼容层。

---

## 6. 专门一节：红线 —— 我们明确不做的（owner 拍板，不是我们拍板）

> **本节的全部红线来自 owner 的拍板**（详见 `docs/v2/evidence/P3-04I-douyin-personalized-verification.md` §5「红线执行情况（逐条对照 owner 原文）」与 §2「开工决策声明」）。本报告只做**行业现状记录**与**建议不跟进**，不新增、不放宽、不解释 owner 的决定。

| # | 红线 | 我们当前实现 | 行业里别人做到哪（只作记录） |
| --- | --- | --- | --- |
| R1 | **严格只读**：不点赞、不关注、不评论、不发私信、不改账号状态 | 契约 `interactionMode: z.literal('readonly')` + SocialRuntime 运行时拦截 + 能力矩阵「授权 + 已实测」双条件 | LockyBee：公开评论（`autonomous-comments.mjs`）、自主分享（`autonomous-share.mjs`）、私信（`chat-service.mjs`）、转发（`video-forward.mjs`）；studio：发作品/回评/私信/@/分享/删除；kdcadmin：点赞/评论/@真人/发布/私信/表情包；fish-soul：点赞（`lib/douyin-browse.js:125-131`）/评论/私信 |
| R2 | **不绕过验证码/风控/登录墙**；触发就停、如实报、不硬刷 | `detectDouyinBlock()` → `PERMISSION_DENIED(recoverable:false)` / `CAPTCHA_REQUIRED` → 立即中止 | **他们与我们口径一致**：LockyBee `api-agent.mjs:82-83,323-327`、`diagnostics.mjs:107-110`；studio `lib/risk.mjs`；kdcadmin `index.js:599`。**没有一个人代过验证码。** |
| R3 | **不逆向签名接口、不伪造请求** | 我们只做页面只读 DOM 抽取 | **fish-soul 明确越过**：`lib/douyin-http.js:42-97` 自算 `x-secsdk-web-signature` + `a_bogus` + 照抄公共参数；`lib/vendor/douyin-bogus.js` 是完整 SM3+RC4 实现（出处 `zhinjs/douyin-im`，MIT）。**不借鉴，不给实施路径。** |
| R4 | **不改 UA / 不做 stealth / 不做反检测** | 全仓库零 UA 覆盖 | **他们也不做伪装**（7 仓 grep `stealth`/`anti-detect`/`webdriver` 零命中）。唯一的 UA 硬编码（kdcadmin `mcp_server.py:88-94`）服务于它自己的签名路线。**保持现状。** |
| R5 | **只用 owner 自己的账号会话；不新建账号；凭据不进仓库/聊天** | owner 亲手扫码；只检查 Cookie 名称；Cookie 只落本机隔离 Profile | kdcadmin 直接复用**用户日常 Chrome 默认 profile**（`index.js:1562-1568`）——比我们的隔离策略更激进，**我们不做**；studio 明写「不存密码、不存 cookie 到库里」（`README.md:90`）与我们一致 |
| R6 | **默认关、owner 打开才跑；遵守平台条款与限速** | 默认 `enabled=false`；每日 ≤2 次 / ≤30 分钟；00:00–08:00 禁发；连续 2 次失败当日停发 | 他们的写操作默认也关（kdcadmin `autoLike/autoComment/autoPublish` 默认全关，`index.js:105-116`；studio 自主执行默认全关，`README.md:15-16`）。**我们在读侧比他们更严，保留** |
| R7 | **不碰语音/工坊/桌宠状态代码** | 本单及前单均未触碰 voice / workshop / `pet:sleep-status` | 不适用 |

**不跟进清单（明确记录「别人做到哪、我们不做」）**：点赞、关注、评论（含回评/楼中楼）、发作品、私信、@真人、转发作品、发表情包、删除评论/作品、续火花、账号状态写入。**这些一律只作行业现状记录，不建议跟进。**

---

## 7. 许可证与可借鉴性：三层划分

> 核实方式：直接读各仓库 LICENSE 文件原文（`head -20`），并交叉核对 `package.json` / `README.md` 的许可声明。**GitHub API 报 `licenseInfo.spdxId = none` 是误判**——除 fish-soul 外，7 仓中 6 个都有真实的 LICENSE 文件。

### 7.1 逐仓许可核实结果

| # | 仓库 | LICENSE 文件 | 关键行 | package.json 声明 | README 声明 |
| --- | --- | --- | --- | --- | --- |
| 1 | `LockyBee/dsh-douyin-agent` | ✅ 有，`LICENSE` | `MIT License` / `Copyright (c) 2026 LockyBee and contributors` | `"license": "MIT"` | — |
| 2 | `dafeiyu1314520/dsh-douyin-agent` | ✅ 有，`LICENSE` | `MIT License` / `Copyright (c) 2026 LockyBee and contributors`（**fork 未改版权行**） | — | — |
| 3 | `AAAjzx111/dsh-douyin-agent` | ✅ 有，`LICENSE` | `MIT License` / `Copyright (c) 2026 LockyBee and contributors`（**再 fork，未改版权行**） | — | — |
| 4 | `regrevia/Envoy` → `integrations/dsh/envoy-dsh` | ✅ 有，`integrations/dsh/envoy-dsh/LICENSE`（另有 `NOTICE`） | `Apache License` / `Version 2.0, January 2004` / `http://www.apache.org/licenses/` | — | — |
| 5 | `Britneycode/dsh-fish-soul` | ❌ **仓库根目录无 LICENSE 文件** | — | `"license": "MIT"` | `README.md:170-172`「## 许可 / MIT」 |
| 6 | `dbbdbdhdbxb-design/dsh-douyin-studio` | ✅ 有，`LICENSE` | `MIT License` / `Copyright (c) 2026 辰辰辰chen` | `"license": "MIT"`（`package.json:38`） | — |
| 7 | `kdcadmin/dsh_douyin_tools` | ✅ 有，`LICENSE` | `MIT License` / `Copyright (c) 2026 TiAmoSS` | `"license": "MIT"`（`package.json:15`） | — |

**附带的第三方 vendored 代码（不在上表，但若引用需单独确认）**
- `Britneycode-dsh-fish-soul/lib/channels/vendor/douyin-bridge/`：vendored 自 `pcmxiao/dsh-douyin-bridge` v0.1.0 @ `6e4bb7f`，MIT，同目录有 `LICENSE`；出处写在 `lib/channels/vendor/douyin-bridge/README.md` 头部。
- `Britneycode-dsh-fish-soul/lib/vendor/douyin-bogus.js`：vendored 自 npm `douyin-im@1.1.0` 的 `lib/anti-bot/aBogus.js`（`zhinjs/douyin-im`），MIT；出处写在文件头注释第 1-3 行。**但它服务于我们不走的签名路线，即使许可证允许也不进我们仓库。**
- `regrevia/Envoy` **主仓**的 LICENSE 与 `integrations/dsh/envoy-dsh/` 的 Apache-2.0 是两件事；本报告**只核实了子目录这一层**，主仓需单独确认。

### 7.2 三层划分

**① 可以直接读来借鉴的（设计思路 / 架构 / 参数 / 经验 —— 不受版权保护）**

- 真浏览器 + 持久 profile + CDP 的**架构形态**（不抄实现）
- 验证码「停下 + 交给本人 + 窗口保留」的**处置口径**
- 风控码分级冷却的**机制形状**（码白名单 + 指数升级 + 只挡写 + 到期自愈）
- 兴趣只由**行为证据**推导的**阈值参数**（`sustainedSeconds:8` / `completionRatio:0.6` / `quickSkipSeconds:3` / `progressRateTolerance:1.25`）
- 「没读到」vs「没有」的**三态区分**
- 「同作品只计一次」的去重**规则**
- 用量账本把「未报告」显式标为**未知**的口径
- 「没抽帧就是 `frames: false`，绝不假装看过」的**诚实表达**
- Envoy 的 **source locator**（`material_id` + `[mm:ss]` + `partial` + gap 命名）与 **`challenge_required` + 人这一步**的状态建模
- 「fail-closed 的账本」原则
- 「同一份 profile 只允许一个浏览器实例」的实现约束

**② 需要保留版权头 / 注明来源才能引用的具体代码片段（若确有必要）**

> ⚠️ **本报告不建议在当前工单引用任何代码片段。** 下列文件是「若将来确需引用时的候选 + 其必须携带的声明」，全部需要先过 `tools/mock-harness/src/license-scanner.mjs` 的 Gate 2。

| 候选文件 | 许可证 | 必须携带 |
| --- | --- | --- |
| `LockyBee/browser-host.mjs`、`core.mjs`、`watch-mode.mjs`、`video-limits.mjs`、`persona-memory.mjs`、`usage-ledger.mjs`、`memory-policy.mjs`、`tool-definitions.mjs`、`dsh-plugin.mjs` | MIT | `Copyright (c) 2026 LockyBee and contributors` 版权头 + 出处注明；登记进 `docs/THIRD_PARTY_NOTICES.md` |
| `dafeiyu1314520/*`、`AAAjzx111/*` | MIT（**版权行仍是 LockyBee**，引用应以上游 LockyBee 为准） | 同上；**不要**引用这两个 fork（0★ / 无独有价值） |
| `dbbdbdhdbxb-design/lib/risk.mjs`、`lib/budget.mjs`、`lib/killswitch.mjs`、`lib/login.mjs`、`lib/watch.mjs`、`lib/cdp.mjs` | MIT | `Copyright (c) 2026 辰辰辰chen` + 出处；登记 THIRD_PARTY_NOTICES |
| `kdcadmin/lib/state.mjs`、`vendor/douyin-mcp/mcp_server.py` | MIT | `Copyright (c) 2026 TiAmoSS` + 出处；登记 THIRD_PARTY_NOTICES |
| `regrevia/Envoy/integrations/dsh/envoy-dsh/index.js`、`cordis.patch.yml`、`skill/*` | **Apache-2.0** | **必须保留 `LICENSE` 全文 + `NOTICE`**，并在文件头标注修改（Apache-2.0 §4(b)） |
| `Britneycode/dsh-fish-soul/lib/douyin-browse.js`（`extractWorkSummary`）、`lib/douyin-social.js`（验证码三态）、`docs/douyin-identity-validation.md` | ⚠️ **仓库无 LICENSE 文件**，仅 `package.json` + README 标 MIT | **引用前必须再确认**（向作者核实 / 等上游补 LICENSE 文件）。**在确认之前，一律按「不可引用」处理** |
| `Britneycode/dsh-fish-soul/lib/channels/vendor/douyin-bridge/*` | MIT（vendored 自 `pcmxiao/dsh-douyin-bridge`） | `Copyright (c) 2026 dsh-douyin-bridge contributors` + **上游 `pcmxiao/dsh-douyin-bridge` 出处必须一并注明** |

**③ 不能进我们仓库、不能进产品、不能抄**

- **`Britneycode/dsh-fish-soul` 仓库根级代码**（在补上 LICENSE 文件 / 得到作者确认前）：按「无许可证 = 保留所有权利」处理，**不得进包、不得抄**。Gate 2 的 license-scanner 对未知许可源码是拦截的。
- **`Britneycode/dsh-fish-soul/lib/vendor/douyin-bogus.js`**：MIT 允许，但**服务于我们明确不走的签名路线**（红线 R3）→ **不进仓库、不进产品、不抄**。
- **`Britneycode/dsh-fish-soul/lib/douyin-http.js` 的签名部分**（`secsdkSignature` / `aBogusSignature` / `douyinBaseParams`，`:42-97`）：**红线 R3**，永不引入。
- **`Britneycode/dsh-fish-soul/lib/douyin-http.js` 的 cookie 落盘部分**（`:6-10`）：虽非签名本身，但**只服务于纯 HTTP 路线**，且与我们的凭据隔离取向冲突 → **不借鉴**（§4.3 专项判断）。
- **`dbbdbdhdbxb-design/lib/api.mjs` 的 web API 直连与自造固定签名参数**（`lib/api.mjs:6,24`「实测能过风控的一套固定参数」）：**不借鉴**（红线 R3 相邻形态：伪造请求参数以规避风控）。
- **所有点赞/评论/发布/私信/@/删除的写操作实现**：不是许可问题，是**红线 R1** → 不抄、不引。
- **任何 UA 伪装 / stealth / 反检测实现**：**红线 R4** → 不抄、不引。
- **`regrevia/Envoy` 主仓（`integrations/dsh/envoy-dsh/` 之外的部分）的 LICENSE 未在本单核实** → 在单独确认前，主仓代码不进我们仓库。

---

## 8. 引用清单（结论 → 仓库文件路径）

**LockyBee/dsh-douyin-agent**（MIT, `Copyright (c) 2026 LockyBee and contributors`）
`LICENSE`（许可原文）· `package.json`（`engines.dsh`、`os:["win32"]`、`dependencies`、`dsh.client`、`exports`）· `README.md:3`（定位）· `cordis.bundle.yml`（bundle patch）· `browser-host.mjs:132-135`（真 Edge + 持久 profile + `headless:false`）· `browser-host.mjs:18-26`（`classifyBrowserLaunchError`）· `browser-launcher.mjs:37-64,99-116,142-173`（准备页归属/暂停/验证码排除）· `core.mjs:327-328`（验证码/登录检测式）· `core.mjs:950`（受保护页判定）· `watch-mode.mjs:18`（同式检测）· `api-agent.mjs:82-83`（模型侧硬约束）· `api-agent.mjs:323-327`（`needs_user`）· `api-agent.mjs:104-110`（`removeHistoricalImages`）· `api-agent.mjs:185-227`（`WATCH_SYSTEM_PROMPT` / 决策生成）· `diagnostics.mjs:107-110`（`CAPTCHA_REQUIRED`/`LOGIN_REQUIRED`）· `autonomous-watch.mjs:208,217`（撞到即 `needs_user`）· `video-limits.mjs:9,36-47,49,89-96,134-136`（预算/时段/只记实际播放）· `scheduled-watch.mjs:10-15,32-47`（调度槽/回执账本）· `persona-memory.mjs:17,19-27,34-42,58-85,86-94`（行为阈值/证据校验/兴趣聚合）· `usage-ledger.mjs:16,19-48`（用量账本/未知用量）· `memory-policy.mjs:44-101`（访问视图）· `tool-definitions.mjs:4-88,91-121`（工具目录/校验器）· `dsh-plugin.mjs:20,39-41,106-146`（inject/ctx 服务/工具定义）· `watch-options.mjs:6-23`（观看选项）· `task-limits.mjs:6-21`（任务预算）· `native-watch-decision.mjs:6-59`（原生决策）

**dafeiyu1314520/dsh-douyin-agent**（MIT，版权行同 LockyBee）
`LICENSE` · `package.json`（`name: dsh-douyin-agent`, `version: 1.4.7`）· git log `8116834`

**AAAjzx111/dsh-douyin-agent**（MIT，版权行同 LockyBee）
`LICENSE` · `package.json`（`name: dsh-douyin-agent-plus`, `version: 1.4.9`）· git log `0c6a9a9`

**regrevia/Envoy → integrations/dsh/envoy-dsh**（Apache-2.0）
`integrations/dsh/envoy-dsh/LICENSE`、`NOTICE`（许可原文）· `README.md`（`engines.dsh >= 0.1.5`、Login wall 行、material_id / `[mm:ss]` / `partial` 行、Requirements 节）· `index.js:1-27,34-35,53-75,94-140`（`inject`、`ctx.skills`、candidate 结构、`agent/pre-step` 路由、幂等 marker）· `cordis.patch.yml`（bundle patch + launcher 说明）· `launch.cjs` · `integrations/skills/envoy/SKILL.md` · `docs/acceptance/envoy-read-failure-2026-10-25.md:117`（「验证码中间页」出现处）

**Britneycode/dsh-fish-soul**（⚠️ 无 LICENSE 文件，仅 package.json + README 标 MIT）
`package.json`（`"license":"MIT"`、`name`、`dsh.client.inject:["slots"]`）· `README.md:170-172`（许可声明）· `cordis.patch.yml` · `lib/douyin-browse.js:1-14,40-76,125-131,178`（两条路 / `extractWorkSummary` / `CLICK_LIKE_JS` / `perDay`）· `lib/douyin-http.js:1-27,35-37,42-78,79-83,93-97`（纯 HTTP 签名路线）· `lib/vendor/douyin-bogus.js:1-13`（出处与说明）· `lib/douyin-social.js:217-221,730-733,1172`（验证码检测 / 三态区分）· `lib/browsers.js:17-30`（浏览器探测）· `lib/channels/vendor/douyin-bridge/browser.mjs:175-190,294-310`（`browserProcesses` / `--user-data-dir`）· `lib/channels/vendor/douyin-bridge/README.md`（vendored 出处）· `lib/channels/vendor/douyin-bridge/LICENSE` · `docs/douyin-identity-validation.md`（会话 ID 证据链 / 三道闸门 / 安全数据边界）· `test/douyin-browser.mjs:62`（「验证码中间页」出现处）

**dbbdbdhdbxb-design/dsh-douyin-studio**（MIT, `Copyright (c) 2026 辰辰辰chen`）
`LICENSE` · `package.json:38` · `README.md:10,15-19,27-28,41-44,90,92-95,97-109`（定位 / 风险自述 / API vs DOM / frames 诚实口径 / 凭据边界 / 额度 / 停损）· `cordis.patch.yml` · `lib/cdp.mjs:1-13,22,25-35,76-99,112-120`（CDP 教训 / 端口 / profile / 启动参数）· `lib/risk.mjs:1-18,20,22-30,32-48,50-60,62-66,68-78`（风控冷却全貌）· `lib/budget.mjs:1-21,33-60`（四道约束 + fail-closed）· `lib/login.mjs:1-14,38-44,69-99`（扫码出码）· `lib/watch.mjs:1-15,23,46-53,55-80`（抽帧证据面）· `lib/killswitch.mjs` · `lib/api.mjs:6,24`（web API 与固定签名参数）

**kdcadmin/dsh_douyin_tools**（MIT, `Copyright (c) 2026 TiAmoSS`）
`LICENSE` · `package.json:15` · `index.js:48-49`（name/inject）· `index.js:92-140`（Config + volatile 约束）· `index.js:105-116`（写闸门默认全关）· `index.js:573-612`（`.need-captcha` / `.login-browser` / MCP 重启键 / `DOUYIN_HEADLESS`）· `index.js:1562-1568,1583-1597`（默认 profile 复用 / `needClose`）· `index.js:2391-2401`（验证码状态变化日志）· `index.js:2848-2930`（扫码/短信/滑块登录工具）· `lib/state.mjs:1-80`（家目录 / 谷时窗口 / `WINDOWS`）· `vendor/douyin-mcp/mcp_server.py:1-33,88-94,275-310,354-360,389-402,414-417,461-489`（设计要点 / UA / profile / CDP 复用 / 单实例约束 / headed vs headless / `launch_persistent_context`）· `README.md`（记忆与人设、家目录表、工具表、0.2.1 修复版）

**我们这边（`feat/whale-isle-v2` @ `a1d9e5c`；抖音个性化流为 `feat-social-douyin-personalized` @ `2de7e86`）**
`packages/shared-protocol/src/social.ts:134-136,202-212,237-238`（契约预算与 owner 口径注释）· `packages/character-core/src/social-runtime.ts:144-157,296,334,345-346,355-358,393-394,400,417`（预算收官 / 连续失败 / 冷却 / 禁发时段）· `packages/character-core/src/interest-sink.ts:29-41,51-80`（兴趣沉淀与噪声门槛）· `packages/character-core/src/content-understanding.ts:22-23,57-63,66-70`（页文字上限 / 模型输出形状 / JSON 抽取）· `apps/desktop-host/src/main/electron-browser-engine.ts:3,50,172-197,291-298,339-381`（partition / 登录窗 / 隐藏窗 / cookie 回写）· `apps/desktop-host/package.json:100`（`electron ^45.4.1`）· `docs/v2/evidence/P3-04I-douyin-personalized-verification.md`（§2 决策声明 / §4 真实读数与阻塞 / §5 红线执行）· `docs/v2/evidence/P3-04I-douyin-captcha-intermediate.json`（验证码中间页原始证据）· `docs/v2/evidence/P3-04-social-life-verification.md`（P3-04 A–F 交付清单与 `IMPLEMENTED_UNVERIFIED` 口径）· `tools/mock-harness/src/license-scanner.mjs:1-44`（Gate 2 扫描规则）· `AGENTS.md`（五层铁笼 / 单点事实源 / 运行时安全锁）

---

## 9. 自检与诚实声明

- **本单未改任何产品代码**：只新增本文件（`docs/v2/evidence/P3-04J-dsh-ecosystem-review.md`）+ 可选的 CHANGELOG / docs 索引一行。
- **未发起任何抖音真实请求、未登录任何账号、未碰 owner 的浏览器会话**；未在被克隆仓库中执行 `npm install` / 任何脚本 / 二进制。全部为只读文件分析。
- **未在真机抓包核对 UA 字符串**：报告中关于「Electron 默认 UA 含 `Electron/<version>`」的表述**据 Electron 默认行为推断**，已在正文明确标注。
- **「为什么真浏览器能避开验证码中间页」是推断，不是实测结论**：§4.2 已标注中等把握与不确定项；唯一实测事实是我们撞到过。
- **对 `Britneycode/dsh-fish-soul` 的许可状态如实记录**：仓库根目录无 LICENSE 文件，仅 `package.json` 与 `README.md` 标 MIT，已归入「引用前需再确认」档。
- **对 `regrevia/Envoy` 只核实了 `integrations/dsh/envoy-dsh/` 这一层的 Apache-2.0**，主仓 LICENSE 单独确认。
- 门禁结果见 PR 描述与交付回执（`pnpm verify:gate`）。
