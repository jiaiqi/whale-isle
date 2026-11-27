# P3-04K · 抖音受限自动顶层评论：实现与验证证据

> 日期：2026-11-27 · 分支：`feat-social-douyin-comments`（基线 `feat/whale-isle-v2` @ `7fcb3e3`）· 工单：`V2-P3-04K`
> 状态：**`IMPLEMENTED_UNVERIFIED`**。代码、单测、真实 Electron 本地仿真 E2E 与主应用中控台 UI/IPC 已验证；**未向抖音发起任何真实评论请求**，真实登录态下的评论 DOM 与平台发送仍待 `[REAL-DEVICE]` 验收。
> 决策记录：[ADR-006](../adr/ADR-006-douyin-bounded-comments.md)（owner 明确授权局部变更 L1 只读红线）

---

## 1. 一句话结论

在保留 L1 浏览会话 `interactionMode=readonly` 的前提下，新增**独立的受限评论阶段**：浏览正常结束后，由模型决定是否对**他人公开视频**发一条顶层评论，经确定性护栏与 SQLite 发送前预留后真实点击发送，并以「评论区新增稳定 ID + 全文回读」为唯一成功回执；所有尝试（含失败、跳过、不确定）按自然日写入本机 SQLite，可在中控台「生活」页按日期查看。默认关闭，真实发送能力未验证时自动评论不会执行。

---

## 2. owner 授权原文与边界

> 「账号继续用我现在的号，这个号不是我日常用的可以随便用，范围：别人视频也要评论，。自治级别：不需要审核，一开始就「有限自动发送」，但是发了什么都要能在当前软件中有记录，能让我查看 ai 每天都做了什么」

据此本轮**只**放开「顶层评论」一种写操作，且：

- 继续使用隔离 Profile 中 owner 自己的账号会话；**不新建账号、不写入任何凭据到仓库或聊天**。
- **不绕过验证码 / 风控 / 登录墙**；命中即停止并如实记录 `captcha` / `login_required`，不硬刷、不自动重试。
- 默认关闭，owner 在软件里打开后才可能执行。
- **不提供**点赞、关注、私信、发布视频、楼中楼回复入口。
- 全部发送原文、目标、状态、原因与生成模型保存在本机 SQLite，可按日期翻页查看。

---

## 3. 实现范围（8 个业务源码文件）

| 文件 | 作用 |
| --- | --- |
| `packages/shared-protocol/src/social.ts` | 新增评论设置、动作、日快照、查询/历史/核验/模型输出等 Zod 契约 |
| `packages/character-core/src/social-douyin.ts` | `DouyinCommentExecutor`、文本护栏、静默时段/日额/间隔判定；L1 浏览源码保持只读 |
| `apps/desktop-host/src/main/social-comment-ledger.ts` | 主进程 SQLite 审计 + `BEGIN IMMEDIATE` 原子额度预留；启动时把残留 `pending` 转 `uncertain` |
| `apps/desktop-host/src/main/electron-browser-engine.ts` | 评论区读取与真实 DOM 发送、稳定回读；验证码/登录墙即停 |
| `apps/desktop-host/src/main/v2-kernel-host.ts` | 独立评论执行器接线、模型网关调用、世代撤销、3 路 IPC、能力矩阵约束 |
| `apps/desktop-host/src/preload/index.ts` | 暴露设置/历史/核验 IPC |
| `apps/desktop-host/src/renderer/director/bridge.ts` | 渲染层类型与方法 |
| `apps/desktop-host/src/renderer/director/views/life-console-view.tsx` | 生活页「抖音 · 有限自动评论」面板与逐日记录 |

**默认预算**：每自然日 10 次尝试、滚动 1 小时 3 次、最小间隔 180 秒、同视频 30 天冷却、本地 00–08 禁发、评论 8–80 字；失败、跳过与不确定同样占用尝试额度（仅 `attemptedAt > 0` 计入），不确定结果不自动重发。

---

## 4. 验证结果

### 4.1 契约与执行器单测（`[SIMULATION]`）

```bash
pnpm exec tsc -b packages/shared-protocol packages/character-core
pnpm exec vitest run packages/character-core/src/social-douyin.spec.ts apps/desktop-host/src/main/social-comment-ledger.spec.ts --coverage.enabled=false
```

结果：**2 个文件、46 例通过**。覆盖成功发送、默认关闭、能力未验证、日/时/间隔/同视频额度、静默时段、急停、验证码/登录/页面异常、模型跳过/不可用、护栏拒绝、回执失败、账本不可写、缺端口、模型等待中急停并发、发送前 pending 已落盘、落盘失败禁止点击，以及 SQLite 重启 `pending → uncertain`、双连接争最后额度的原子拒绝。

### 4.2 真实 Electron 本地仿真 E2E（`[E2E-HOST]` + `[SIMULATION]`）

```bash
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/douyin-comments.e2e.spec.ts
```

结果：**1 个文件、1 例通过，16.99s**。用 esbuild 打包**实际** `ElectronBrowserEngine` + `SocialCommentLedger`，以 Playwright 拉起真实 Electron；在独立 partition 内把所有 `https` 拦截为本地仿真页（仅 `www.douyin.com`，其余 403），视频页带真实 `textarea`、发送按钮与评论列表，点击按钮真实走本地协议并在重载后重建评论。断言：读取到输入框；`canSend=false` 时零发送；真实 DOM 点击后重载仍能读到同一数字 ID 与全文才 `ok`；原文写入真实临时磁盘 SQLite；切验证码 fixture 后读/发都停止且不再产生新发送。重载确认阶段实现为 **5 秒有界轮询**（每 300ms 重新抽取、判定条件不变），避免真实站点评论异步渲染被误判为 `uncertain`；改后复跑仍 **1/1 通过，16.77s**。

### 4.3 主应用中控台 UI/IPC（`[E2E-HOST]`，记录为种入的 `[SIMULATION]` 数据）

已固化为仓库内可复跑 E2E：`apps/desktop-host/e2e/douyin-comments-console.e2e.spec.ts`，并加入 macOS CI 的 Electron E2E 列表。

```bash
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/douyin-comments-console.e2e.spec.ts
```

结果：**1/1 通过，12.85s**。以测试专用 bootstrap 先把 `appData` 指向临时目录，再加载**真实构建产物** `apps/desktop-host/dist/main/index.js`（`PET_STAGE_E2E=1`，不修改 production 入口、不触碰真实 `e2e-profile`），用 Playwright 驱动真实 Electron 中控台：

- 默认状态：`enabled=false`、`verified=false`、`lastVerifiedAt=0`、`ledgerReady=true`，面板显示「开启有限自动评论」与「真实发送尚未验证，自动评论不会执行」。
- 点击开关后：`enabled=true`，但 `verified` 仍为 `false`、`lastVerifiedAt` 仍为 `0` —— **开关不会伪造实测时间**；再点一次可恢复关闭。
- 向临时工作库种入两条明确标注 `simulation-only` 的记录（`sent` / `skipped`）后，UI 显示「已确认发送」「已跳过」、原文全文、目标 URL、原因与生成模型；计数变为「今日已确认 1 条 · 跳过 1 条 · 剩余尝试 9 次」。
- 切换到前一天：0 条记录并显示空态。

此前手工驱动的四张截图（默认关闭、开启后、记录列表、前一日空态）属一次性初验，结论已由上述 E2E 固化为可回归断言。

### 4.4 自动化门禁

```bash
pnpm verify:gate
```

结果：**8 过 / 0 跳过 / 0 待接线，EXIT=0**。

- Gate 1 类型与边界：`tsc -b` 零错误 + dependency-cruiser 零违规；Python `ruff` + `mypy --strict` 通过。
- Gate 1 打包护栏：`desktop-host build` 的 main / preload / pet-stage / director 四入口全部打包通过。
- Gate 2：license-scanner 扫描 348 个源文件 0 违规；`pnpm audit` 0 high / 0 critical；`luac -p` 5 个 Lua 文件通过。
- Gate 3：vitest 全绿 + pytest 夹具回放全绿 + 7 个卡死回归剧本。
- Gate 4：回环契约 E2E 0.4s（< 15s）。

本轮门禁**一次通过，无失败留档**。

### 4.5 评论端口下沉到 CDP 驱动（`[SIMULATION]`，2026-11-27 补记）

macOS 默认驱动是 `cdp-real`，原先评论只实现在 `ElectronBrowserEngine` 会导致生产环境功能不可用。本轮把端口提取成两驱动共用：

| 文件 | 作用 |
| --- | --- |
| `apps/desktop-host/src/main/douyin-comment-port.ts` | 与驱动无关的评论时序与回执判定（`createDouyinCommentPort`）；Electron 与 CDP 共用 |
| `apps/desktop-host/src/main/douyin-page-reader.ts` | 新增评论区读取/填入/点击三个共享脚本，只认评论专属 `data-e2e` 控件 |
| `packages/character-core/src/social-douyin.ts` | `DouyinCommentPort` 契约 + `isDouyinVideoUrl` / `normalizeDouyinUrl` / `isStableDouyinCommentId` / `findNewDouyinComment` 纯判定 |
| `apps/desktop-host/src/main/cdp-browser-engine.ts` | `RealBrowserDouyinSession` 实现 `readComments` / `postComment`；R1 改为「只读 + 受限评论（ADR-006）」 |
| `apps/desktop-host/src/main/electron-browser-engine.ts` | 改为委托同一端口实现，删除重复内联脚本 |

验证：

- `douyin-comment-port.spec.ts` **18 例**：护栏拒绝分支（非视频页 / 输入框缺失 / 页面变化 / canSend=false / 验证码 / 编辑器与发送按钮缺失）与回执三态（sent / uncertain / failed）。
- `social-douyin.spec.ts` 新增共用判定 4 例；`cdp-browser-engine.spec.ts` 新增「cdp-real 驱动下的受限评论端口」4 例；`electron-browser-engine.spec.ts` 新增端口存在性 1 例。
- `apps/desktop-host/e2e/douyin-cdp-comment-port.e2e.spec.ts` **1/1**：用本机回环仿真 CDP 端点（node:http + ws，不启动真 Chrome）走通 `RealBrowserDouyinSession → CdpConnection → CdpPageDriver → 共用端口`，证明 `cdp-real` 下评论端口确实被注入、能走通 `sent` 回执与验证码停止。
- **仍未向抖音发起任何真实评论**；仿真 CDP 端点不是真机证据，真实发送保持 `[REAL-DEVICE]` 待验。

---

## 5. 诚实缺口（不得写成已跑通）

1. **未向抖音发起任何真实评论请求**；上面的「发送成功」全部来自本地仿真页，不是平台回执。
2. **未在真实已登录抖音页面核验写控件选择器**（`data-e2e="comment-input"` / `comment-publish` 等）。实现采取保守策略：只认评论专属 `data-e2e` 控件，未知结构直接失败，不退回全页面通用按钮；真实站点若结构不同，会安全失败而不是误点。
3. **真实登录态仍受阻**：P3-04I 生产冒烟仍停在抖音「验证码中间页」，本轮未重试、未绕过。真实发送能力因此保持 `lastVerifiedAt=0`，自动评论不会执行。
4. **模型决策链路**只做了类型与执行器单测，未在真实供应商上跑「浏览 → 评论」长循环。
5. 页面结构变化、验证码、登录墙与平台限速均由运行时护栏拦截；任何 `failed` / `uncertain` 都会自动暂停评论开关并要求人工核对。

## 6. 待人类真机验收项（`[REAL-DEVICE]`）

- 在真实已登录的隔离 Profile 中打开一条公开视频，确认读取评论区与输入框可用的真实 DOM。
- 通过「首次真实单条核验」显式发送一条，确认平台侧可见、回读 ID 与全文一致，且能力矩阵 `lastVerifiedAt` 仅在 `sent` 后更新。
- 开启自动评论跑一次「浏览正常结束 → 模型决定 → 最多一条」的完整链路，确认生活页当日记录可查、额度正确、失败即暂停。
- 命中验证码/风控时确认停止且不重发。

## 7. 复现命令

```bash
pnpm exec tsc -b packages/shared-protocol packages/character-core
pnpm exec vitest run packages/character-core/src/social-douyin.spec.ts apps/desktop-host/src/main/social-comment-ledger.spec.ts apps/desktop-host/src/main/douyin-comment-port.spec.ts apps/desktop-host/src/main/cdp-browser-engine.spec.ts --coverage.enabled=false
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/douyin-comments.e2e.spec.ts
pnpm exec vitest run --config vitest.e2e.config.mts apps/desktop-host/e2e/douyin-cdp-comment-port.e2e.spec.ts
pnpm verify:gate
```
