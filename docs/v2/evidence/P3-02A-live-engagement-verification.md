# V2-P3-02A：直播互动编排第一切片（规则卡 + 点赞进度 + 投喂榜）

状态：`IMPLEMENTED_UNVERIFIED`（2026-11-27 owner 授权的独立支线；不改变 P4-01 主线状态）。

采用现有 `LiveRuntimeV2` 的 eventId 去重护栏入口、四重版权点歌门禁、`pet:prefs` 设置持久化与 `/obs` 回环输出；参考 `dsh-livestream` 的显式 follow/gift 触发与 `dsh-live-studio` 的交易去重、合并感谢优先级思想，全部重写，不复制上游任何源码。拒绝概率触发、随机指标、新平台驱动和 SVC 依赖，规则卡只陈述确定条件；新增 `FOLLOW` 事件类型与 `likeCount`/`giftCount` 增量字段并保持旧事件兼容，`ENTER_ROOM` 不再作为关注触发源。

预算为最多 8 个业务源码文件，配置默认关闭，榜单只代表当前场次事件份数/标价而非平台到账；以确定性单测、隔离 profile Electron 与真实鉴权 `/obs` 渲染、完整 `verify:gate` 验证，真实开播单列待验。回退方式为关闭总开关或独立 revert 本工单，后续实现不得形成第二份长期榜单/进度状态；本切片不宣称真实平台验证通过。

## 能力域对照

| 能力域 | 参考 | 结论 |
| --- | --- | --- |
| 显式事件 → 表演 | `dsh-livestream` `src/stage/triggers.ts` | 吸收关注/进房分离与配置化触发思想，重写为 Zod 配置 + 确定性冷却 |
| 同人合并 / 交易去重 | `dsh-live-studio` `backend/live_ledger.py` | 吸收 tid 去重思想，本次复用已有 eventId 去重，不新增平台交易字段 |
| OBS 只读呈现 | 现有 WebUI `/obs` | 复用鉴权与本机回环服务，规则/进度/榜单全部来自 `LiveRuntime` 单一事实源 |

## 配置项与默认值（`PetDesktopPrefs.liveEngagement`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关，默认关闭；关闭时不产生任何动作与 OBS 挂件 |
| `showRules` / `showLikeGoal` / `showLeaderboard` | `true` | 三个子组件的单独显示开关 |
| `likeGoal` | `15000` | 本周期点赞目标（1..1e9） |
| `resetAfterMs` | `0` | `0` = 每场重置；非 0（≥60s）按开播起固定周期重置点赞，榜单仍按场 |
| `globalCooldownMs` | `5000` | 全局动作最小间隔（1..300s） |
| `leaderboardMetric` | `count` | `count` 按礼物份数，`value` 按事件合计标价 |
| `topN` | `5` | 1..10 |
| `rules` | 3 条内置 | 关注欢迎、任意礼物感谢、点赞达标感谢，均为 `bubble` 动作、`cooldownMs=120000`；最多 12 条、id 不可重复 |

单位与增量语义：`giftDiamondValue` 为**事件合计标价**，不再乘份数；`likeCount` / `giftCount` 为正增量，缺省时兼容 `mergedCount`；榜单与进度只保存在内存，重新开播重置，进程重启不恢复场次。

中控台入口：中控台「生活」页 → 直播互动编排卡片（`data-engagement-enabled` 总开关、`data-engagement-goal` 点赞目标、`data-engagement-metric` 榜单口径、逐条规则开关/冷却/动作），保存走既有 `pet:prefs-set`。OBS 侧沿用「OBS 透明挂件 → 复制 OBS 源地址」打开 `/obs`。

## Mock / 沙盒证据

`[SIMULATION]`

- `packages/live-stream-hub/src/engagement.spec.ts`：新增 12 例，覆盖默认关闭、旧 prefs 补齐、重复 id/非法增量、真实 `FOLLOW` 匹配（`ENTER_ROOM`/弹幕不匹配）、全局与同人冷却、eventId 去重、gift 份数合计且不乘币值、`LIKE` 缺省 `mergedCount`、9 币阈值边界、禁用规则、点赞恰好/跨越阈值仅触发一次、关闭再开不能绕过、新场 reset、被全局节流目标后续点赞补发、周期重置保榜保冷却、按 count/value 排序、1/1/3 并列、TopN、同 uid 改名、确定文案、快照不可变、10001 用户容量与 seen/cooldown 界限、无效会话与 Guard 丢弃、点歌未知/未授权拒绝、订阅者异常不打断收流、合并感谢按榜单优先次序。
- 专项命令：`pnpm exec vitest run apps/desktop-host/src/webui/webui-server.spec.ts packages/live-stream-hub/src --coverage.enabled=false` → 4 文件 **90 tests passed**。
- 首次专项运行 60 过 1 败：新增测试的曲库 fixture 缺 `voiceConsentSource`，被 Zod 拒绝；补齐 fixture 后通过（真实契约拦截，非放宽断言）。

`[E2E-HOST]`

- `apps/desktop-host/e2e/live-engagement.e2e.spec.ts`（1/1，最终构建产物上 **9.89s** 通过）：临时 `mkdtemp` profile + mocked keychain，不触碰 owner userData；中控台开总开关/目标 10 并保存 → 直接读临时 prefs 文件核验 → 重启同 profile 恢复配置；`local_replay` 开播后同一 eventId 的 `LIKE` 发两次只累计 12；3 个礼物用户 3/3/1；恶意昵称 `<img src=x onerror=alert(1)>` 渲染为纯文本（DOM 无 `img`）；真实鉴权 `/obs` 页面显示三卡、`12 / 10`、`progress` 截断到 10、规则文案、`[SIMULATION]` 来源、目标达成、1/1/3 并列榜单；深浅截图；375×812 窄屏右边界不溢出；改榜单口径后 OBS 更新；关闭隐藏/再开启保留 12 点赞；停播隐藏；`pageerror` 为空。
- 截图（gitignored，可复现）：`artifacts/live-engagement/obs-dark.png`、`artifacts/live-engagement/obs-light-compact.png`。

## 失败与修复留档（未掩盖）

| 次数 | 现象 | 处理 |
| --- | --- | --- |
| E2E 第 1 次 | `#engagement` 等待超时：main 已注入 `liveStage`，但 `/api/state` 响应白名单未输出 | 响应增加 `liveStage`；原始日志 `P3-02A-e2e-first-failure.log` |
| E2E 第 2 次 | 停播隐藏断言在默认约 1s `expect.poll` 边界偶发失败 | overlay 相关 poll 显式 `timeout: 5000`；原始日志 `P3-02A-e2e-polling-failure.log` |
| `verify:gate` 第 1 次 | 7/8，Gate 3 失败 1 例：旧 WebUI 精确响应断言不接受新增 `liveStage: null` | 改为 `liveStage === undefined ? {} : { liveStage }` 可选展开，保留旧断言并新增真实 runtime 投影测试；原始日志 `P3-02A-gate-first-failure.log`（另存 `.verify-gate/failure-2026-11-27T12-16-36-340Z.log`） |
| `verify:gate` 第 2 次 | — | **8 过 / 0 跳过 / 0 待接线**：Gate 1 `tsc -b` + depcruise + ruff/mypy + 四入口 build；Gate 2 license-scanner 356 文件 0 违规 + audit 0 high/critical + luac 5 文件；Gate 3 vitest + pytest + 7 个卡死剧本；Gate 4 回环 0.4s |

> 原始 `.log` 按仓库 `.gitignore`（`*.log`）约定保留在本地，不随提交入库；关键断言摘录如下。

```text
# E2E 第 1 次（40.76s）
TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.
  - waiting for locator('#engagement:not([hidden])') to be visible

# E2E 第 2 次（7.95s）
AssertionError: expected false to be true // Object.is equality
  await expect.poll(() => overlay.locator('#engagement').isHidden())
Caused by: Error: Matcher did not succeed in time.

# verify:gate 第 1 次：Gate 3 全量 vitest 2198 passed / 1 failed / 3 skipped
 ❯ apps/desktop-host/src/webui/webui-server.spec.ts:143:35
     expect(await response.json()).toEqual({
       ok: true,
       events: [{ type: 'receipt', summary: '浇水完成' }],
```


## 合规边界

- 规则文案只描述确定触发条件，无概率诱导、抽奖式文案、未成年人诱导或刷量引导。
- 未接新平台 API、未触碰验证码/风控、未改抖音驱动。
- 气泡动作复用现有 `pet:bubble`，睡眠或 autodrive 忙碌时不投递，不抢语音锁、不改游戏动作；点歌动作只经现有四重授权排队，不宣称真唱。
- 未修改 `V2-P4-01` 单角色链路行为；公共契约改动为向后兼容的可选字段。

## 待人类真实验收

- `[REAL-DEVICE]` 真实平台关注、礼物（含连击合并）、点赞增量归一后，规则匹配与榜单数值符合平台侧显示。
- `[REAL-DEVICE]` OBS Studio 实际开播画面中三卡可读、角色气泡出现且不打断语音/游戏。
- 已知边界：默认 3 条规则 + Top5 在常见画面内；多规则/Top10/极短视口的纵向容纳未专项验证；UI 暂不支持增删自定义规则或改 trigger（契约已支持最多 12 条）；仅单次事件合计币值门槛，累计赠礼门槛留待后续切片。
