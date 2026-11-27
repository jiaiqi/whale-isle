# V2-P3-04H 抖音 L1 只读真实平台验收证据

> 工单：`V2-P3-04G` 续（执行器骨架接首个真实平台）· owner 2026-11-27 拍板「自主社交首个真实平台 = 抖音」
> 分支：`feat-social-douyin`（基于 `feat/whale-isle-v2` `8d76f32`）
> 证据等级：**`[REAL-DEVICE]`（仅限「真实抖音公开精选页 + 只读字段」这一范围）**；单测为 `[SIMULATION]`。
> 本文件不覆盖直播弹幕、不覆盖个性化推荐/关注流、不覆盖点赞/评论/私信等任何写操作——这些**均未做、也未验证**。

## 1. 结论（先说实话）

- 抖音 L1 只读源已从骨架变成真跑：真实冒烟 **候选 5 条 → 读到 3 条 → 0 失败 → 26.3s**，证据落盘后 `executorReady` / `runnable` 才由 `false` 置为 `true`，能力矩阵 `douyin/read_public` 才登记。
- 随后用生产链路（`v2SocialPlan` → `v2SocialStart` → `SocialBrowseExecutor` → 同一抖音源）跑了一次真实会话：**`itemsViewed=3`、`status=completed`、27.6s**，证明不是只有冒烟脚本能读。
- **公开精选页匿名可读，本次不需要 owner 扫码**。登录窗已实现，但当前版本无论是否登录都只读精选公开页；推荐/关注等个性化流尚未接入，扫码只是为后续能力保留本机登录态，不会改变当前 feed。本次全程 `loggedIn=false`、登录窗未打开。
- 首轮冒烟曾经 **0/5 失败**：登录弹窗文案「验证码登录 / 获取验证码」被裸「验证码」正则误判成风控页。该失败记录保留在 §5；修正为只认真正的人机校验/风控文案后重跑通过。**没有绕过任何验证码/登录墙。**
- 未达 `DONE`：真实平台长时浸泡、真实验证码/风控出现后的 owner 处理流程、真实模型内容理解联调仍未验，状态记 `IMPLEMENTED_UNVERIFIED`。

## 2. 开工决策声明（采用 / 不采用 / 回退）

- **采用**：浏览器 UI 只读路径——独立 Electron `persist:whale-char_xiaojing-douyin-owner` Profile + 隐藏窗口读取「抖音精选」公开页与视频页公开字段（标题/作者/发布时间/话题），接入既有四段端口（候选来源 → 逐条读取 → 理解 → 记账），**不改接口契约**。低频率（逐条间隔 ≥2.5s、单会话 ≤20 条 / 10 分钟）。
- **不采用**：① 不采用 HTTP 签名伪造/逆向接口（易碎且触碰平台条款）；② 不采用浏览器自动化做直播弹幕（弹幕主线仍是 `dyhub`，本单不碰）；③ 不采用任何验证码识别/绕过服务；④ 不采用本地夹具冒充真实平台（`allowLocalFixture=false`，夹具源永远 `verified=false`）。
- **回退**：证据 7 天过期或冒烟失败 → 来源 `verified=false`、执行器 `runnable=false` → 调度器以 `executor_not_ready` 拦截，开关打开也不会发起；长驻进程在每次 tick / 快照 / 发起前复核证据，不只在启动时看一次。能力矩阵保留 `lastVerifiedAt` 历史读数、不自动删除 owner 声明，动手门禁以来源自述为准；删除 `v2-douyin-browse-evidence.json` 即可让抖音源回到未实测状态。

## 3. 真实读数（本机 macOS，2026-11-27）

### 3.1 冒烟（`v2:social-douyin-smoke`，limit=5，minItems=3）

| 字段 | 真实值 |
| --- | --- |
| 证据时间 | `2026-11-27 09:10:55 CST`（epoch `1795741855233`） |
| 候选来源 | `https://www.douyin.com/jingxuan`（`douyin-public-jingxuan`，`kind=platform`） |
| 候选数 | **5** |
| 读到条数 | **3**（达到门槛） |
| 读取失败 | **0** |
| 耗时 | **26 308 ms** |
| `ok` | **true** |
| 失败原因 | 空 |
| 登录态 | `loggedIn=false`，登录窗未打开 |

读到样本（公开字段，原样归档在 [P3-04H-douyin-smoke.json](./P3-04H-douyin-smoke.json)）：

| 作者 | 标题（截断） | 话题 | 正文字符 |
| --- | --- | --- | --- |
| 渡知局 | 一辈子不结婚会怎么样？ | 结婚 / 不结婚 / 养老 / 知识 / 科普 | 195 |
| 幺九零三 | 老头发现村子周围的一块土寸草不生，他在盖猪圈时挖开一间密室 | 抖音精选 / 原创剧情 / AI创作者浪潮计划 / 幺九零三 / 未来导演计划 | 296 |
| 40Hz - Bassline | 世人只知她玉女掌门之名，却不知她专辑销量断层碾压同期玉女歌手 | 孟庭苇 / 华语金曲 / 音乐 / 怀旧金曲 | 248 |

冒烟后快照（同一份，见 `P3-04H-douyin-tick.json` 的 `before`）：

```json
{"executorReady": true,
 "executor": {"wired": true, "runnable": true,
   "sources": [{"sourceId":"douyin-public-jingxuan","platform":"douyin","kind":"platform","verified":true}]},
 "capabilities": [{"platform":"douyin","capability":"read_public","channel":"browser_ui","allowed":true,
   "riskLevel":"P1","accountType":"owner","lastVerifiedAt":1795741855233}]}
```

### 3.2 真实会话（`v2SocialPlan` → `v2SocialStart`，走生产执行器）

```json
{"sessionId":"bs-65e7a249","platform":"douyin","interactionMode":"readonly",
 "objective":"真实 tick 验收：只读公开内容","maxItems":3,"maxDurationMs":120000,
 "status":"completed","stopReason":"budget_exhausted","itemsViewed":3,
 "startedAt":1795741962038,"endedAt":1795741989673}
```

- `startedAt` = `2026-11-27 09:12:42 CST`，`endedAt` = `09:13:09 CST`，耗时 **27.6s**。
- `stopReason=budget_exhausted` 是因为 `maxItems=3` 已用完（不是失败）。
- 这条链路与调度器自动发起走同一个 `runSocialSession()`；调度器本身仍**默认关闭**（`enabled=false`、`blockReason=autostart_off`），本次是 owner 口径下的手动验收，不修改默认值。

## 4. 红线执行情况（逐条对照 owner 原文）

| owner 红线 | 实际执行 |
| --- | --- |
| **只读**：不点赞、不关注、不评论、不发私信、不改账号状态 | 代码只暴露 `load` / `loginState` / `openLoginWindow`；`DouyinWebSession` 无任何写操作入口；`interactionMode=readonly` 由契约钉死；执行器不点击卡片，只读 DOM 文本。 |
| 不绕过验证码/风控/登录墙；触发就停、如实报、不硬刷 | 识别到验证码/风控文案 → `WhaleError(recoverable:false)` → 执行器 `runtime.abort('error')`，冒烟 `break`，同轮不换条；登录墙 → `PERMISSION_DENIED / LOGIN_REQUIRED` 停下等 owner 扫码。**本次未触发真实风控**（首轮是误判，已修正）。 |
| 只用 owner 自己的账号会话；不新建账号；凭据不进仓库/聊天 | 未登录、未注册、未输入任何凭据；Cookie 只落在本机 `userData` 下的隔离 Profile（`cookies.json` 已 gitignore，不进导出）。 |
| 不碰语音/工坊代码、不动 `pet:sleep-status` | 本单改动集中在社交源/宿主接线/生活页，未改 voice-runtime、voice-workshop、`pet:sleep-status`。 |
| 遵守平台条款与限速；默认关，owner 打开才跑 | 默认 `enabled=false`（本次快照仍是 `autostart_off`）；逐条 ≥2.5s；冒烟 limit 5、会话 maxItems 3；能力矩阵 `rateLimitNote` 写明「单会话 ≤20 条 / 10 分钟」。 |

## 5. 失败与修正记录（不隐藏）

1. **首轮冒烟 0/5（假风控）**：真实页面读到了，但 `CAPTCHA_RE` 含裸 `验证码`，命中登录弹窗的「验证码登录 / 获取验证码」→ 被误判为验证码页并立即停止（说明「触发就停」确实生效，但也说明判据太粗）。修正为只认 `人机验证 / 安全验证 / 访问过于频繁 / 拖动滑块 / 请输入验证码 / captcha / turnstile / recaptcha` 等真正校验文案；登录弹窗文案归 `LOGIN_RE`，只在「无候选/无正文 + 登录墙」时判定。重跑后 5 候选 / 3 读到 / 0 失败。
2. **作者字段曾显示「（未提供）」**：卡片能读到标题但视频页作者选择器不稳；补了 `[data-e2e="user-info"]` 首行回退，冒烟侧把「（未提供）」过滤为空，避免把占位符当真实作者。
3. **第一次真实会话的前置依赖**：`SocialBrowseExecutor.run` 不会自动用注册来源当 reader，宿主已显式传 `reader: douyinSource`；否则会「只记候选、不读正文」。单测已覆盖该接线。
4. **本单未触发真实验证码**，因此「真实风控页面长什么样、owner 扫码后如何恢复」仍只有代码路径与假页面单测，没有真机样本。

## 6. 自动化测试（`[SIMULATION]`）

- 新增 `packages/character-core/src/social-douyin.spec.ts` **18 例**，覆盖：
  - 卡片文本解析（时长/播放量/日期/@作者 不当标题）、话题抽取上限、公开字段文本拼装；
  - 候选映射与去重、登录墙（无候选 + 登录文案 → `LOGIN_REQUIRED`，动手前抛错）；
  - 验证码门槛（`PERMISSION_DENIED`、`recoverable:false`、只加载 1 个视频页就停）；
  - 逐条间隔 2500ms 只睡一次、未实测来源零 `load` 调用、`runnable=false`；
  - 配额耗尽、理解配额、中途打断、可恢复读取失败继续下一条；
  - 冒烟证据 ok / 失败 / 7 天 TTL、`runnable` 状态、契约字段对齐。
- `pnpm verify:gate` 结果见 §8（以实际终端输出为准，不在文档里预先写「通过」）。

## 7. 接线与可见性

- **宿主**（`v2-kernel-host.ts`）：创建独立抖音 Profile 与会话；来源初始 `verified=false`；冒烟成功且证据 ≤7 天才 `registerDouyinSource(true)` 并 seed 能力矩阵；`v2:social-snapshot` 增加 `douyin.{available,loggedIn,loginWindowOpen,sourceVerified,evidence}`；新增 `v2:social-douyin-smoke` / `v2:social-douyin-login`。
- **生活页**（`life-console-view.tsx`）：开关默认关；展示预算/夜间禁发文案；「真实冒烟（读 3 条）」「打开登录窗（扫码）」；显示证据时间/条数/耗时/失败原因与上一次 tick 结果；未实测时继续以 `platform_unverified` 拦截；登录态不是当前公开页的前置条件。
- **边界**：写操作没有 IPC、没有按钮、没有端口；页面文本始终按数据处理，不执行页面指令。

## 8. 门禁与构建

命令：`pnpm verify:gate`（8 道，含 Gate 1 的 `desktop-host build`）。真实输出摘要：

```text
✅ PASS  Gate 1 类型与边界
          tsc -b 零错误 + dependency-cruiser 零违规（strict + noUncheckedIndexedAccess）
✅ PASS  Gate 1 类型与边界(Python)
          ruff 全绿 + mypy --strict 通过
✅ PASS  Gate 1 打包护栏
          desktop-host build：main / preload / pet-stage / director 四入口打包通过
✅ PASS  Gate 2 许可证与密钥
          license-scanner: 扫描 335 个源文件，发现 0 处违规
✅ PASS  Gate 2 依赖漏洞
          pnpm audit --audit-level high：0 high / 0 critical
✅ PASS  Gate 2 DST Lua 语法
          luac -p：5 个 Lua 文件语法通过（编译期证据，不等于游戏内加载）
✅ PASS  Gate 3 确定性单测
          vitest 全绿 + pytest 夹具回放全绿
✅ PASS  Gate 4 回环契约 E2E
          [SIMULATION] 骂大肥鱼 → 0-token 喷水 → 语音锁释放 → 记仇账本落盘（0.6s < 15s）

✅ verify:gate 通过：8 过 / 0 跳过 / 0 待接线
```

补充单测：`social-douyin.spec.ts` + `social-executor.spec.ts` 合计 **30/30**（`vitest run --coverage.enabled=false`，2 文件 30 用例，184ms）。

## 9. 仍待人类 / 后续

- **owner 扫码时点**：本次公开精选页不需要。当前版本即使扫码也只读精选，个性化流尚未接入；生活页「打开登录窗（扫码）」只是把 owner 自己的登录态留在本机隔离 Profile，供后续个性化 feed 使用（需先扩展来源再验），AI 不代填密码、不读取/上报凭据。
- **真实风控演练**：等真实出现验证码/风控时，确认「立即停止 + 如实报错 + 不硬刷」的体感与恢复流程（owner 亲手处理后再重跑冒烟）。
- **真实模型理解**：本次只验证「读到公开内容」；`understandingPipeline` 的真实供应商调用仍取决于模型 Key/饭碗，未在本次冒烟中触发（真实会话中理解失败只记账、不影响已读事实）。
- **长时浸泡**：连续多日自动 tick、每日 ≤2 次 / ≤30 分钟、00–08 禁发、失败冷却等策略仍为单测 + 本轮手动验收，未做多日真机浸泡。
- **平台条款**：公开页结构与访问策略可能变化；结构变化时源会 `INTERNAL_ERROR` 如实失败，不会伪造候选。

## 10. 证据文件

- [P3-04H-douyin-smoke.json](./P3-04H-douyin-smoke.json)：真实冒烟原始证据（宿主 userData 同名文件副本）。
- [P3-04H-douyin-tick.json](./P3-04H-douyin-tick.json)：真实会话前后快照（能力矩阵 / executor / 会话回执）。
