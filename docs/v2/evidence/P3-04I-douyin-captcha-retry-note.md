# P3-04I 验证码复核证据更正说明

- 关联工单：`V2-P3-04I`（抖音个性化流「推荐 / 关注」只读接入）
- 原始证据：[P3-04I-douyin-captcha-retry.json](./P3-04I-douyin-captcha-retry.json)（自 PR #8 原样收进，**字段一个都没改**；SHA-256 `a9717e2b15e5e055eb0966e829ef8d7f91f84ec31c8d30faefdf0f96e201ca58`）
- 口径：`[REAL-DEVICE]` 失败复核（未登录 + 验证码），不是通过证据

## 1. 这次运行走的是旧的 Electron 隔离 partition 链路

- 本次复核来自 PR #8 所在分支；当时该分支还没有 `cdp-browser-engine.ts`（`git ls-tree pr8 apps/desktop-host/src/main` 里只有 `electron-browser-engine.ts`，没有 `cdp-browser-engine.*`），走的是 **Electron 隔离 partition** 旧链路。
- 因此**不与 PR #9（`V2-P3-04K`）的 CDP 结论矛盾**：11:29:00 / 11:36:32 CST 两轮 `driver=cdp-real`、`loggedIn=true`、`itemsRead=3`、`ok=true` 才是现行走廊（见 [P3-04K-douyin-real-browser-verification.md](./P3-04K-douyin-real-browser-verification.md)）。
- 两条时间线**分开记**：11:40 CST 是旧链路的失败复核；11:29 / 11:36 CST 是 CDP 链路的通过复验。不得用后者覆盖前者，也不得用前者否定后者。

## 2. 时间以原始 JSON 为准：11:40 CST（不是 10:20 CST）

| 字段 | 原始值 | 北京时间（CST, UTC+8） |
| --- | --- | --- |
| `at` | `2026-11-27T03:40:11.855Z` | **2026-11-27 11:40:11 CST** |
| `verifiedAt` | `1795750833765`（epoch ms） | **2026-11-27 11:40:33 CST** |

- PR #8 草稿曾把这次复核标成 **10:20 CST**（该分支 `docs/v2/evidence/P3-04I-douyin-personalized-verification.md` §4.3.1 与 `docs/VERIFY.md` 的复核行），与原始 JSON 不符，**10:20 CST 是误记**。
- 最新主干此前没有合入这段草稿（主干不存在 `10:20` 文案），本 PR 在主干对应文档里直接按 **11:40 CST** 记录，并在本节留下更正来源：**以原始 JSON 的 `at` / `verifiedAt` 为准**。

## 3. `usedFeed=recommended` 与 `loggedIn=false` 不是真实读数

原始 JSON 里的这三个字段（`usedFeed` / `loggedIn` / `fallbackReason`）是 `selection` 未赋值时的**默认回填**，不是本轮真实抓取结果：

1. `runDouyinSmoke` 先调 `source.selectFeed(...)`，把 `this.selection` 置空（`packages/character-core/src/social-douyin.ts:371`）。
2. `listCandidates` 读到未登录后，把请求流 `recommended` 回落为 `public`，并记 `reason='not_logged_in'`（`:389-392`），随后打开页面。
3. `this.assertNoCaptcha(page)` 在 `:395` **先抛出** `PERMISSION_DENIED / CAPTCHA_REQUIRED`，因此 `this.selection = { requested, used, loggedIn, fallbackReason, ... }` 的赋值（`:414`）**根本没有执行**。
4. `runDouyinSmoke` 再读 `source.lastSelection`（此时为 `null`），用 `selection?.used ?? requestedFeed` 回填 `usedFeed`（`:599`），用 `selection?.loggedIn ?? false` 回填 `loggedIn`（`:600`），用 `selection?.fallbackReason ?? ''` 回填 `fallbackReason`（`:601`）。

所以 JSON 中的 `usedFeed=recommended` 只是把**请求流**原样回填，`loggedIn=false` 只是 schema 默认值，`fallbackReason=''` 也不是本轮真实回落原因；同理 `feedUrl` 走的是 `source.feedUrl`（`:361`）的未抓取兜底，不能证明推荐页被打开过。

**真实行为**是：未登录 → 回落公开精选（`fallbackReason=not_logged_in`），随后在该链路上撞到「验证码中间页」。

## 4. 结论

这份文件记录的是「**未登录状态下撞到验证码中间页、未能读到推荐流**」：`candidates=0`、`itemsRead=0`、`ok=false`、`executorReady=false`、`runnable=false`，且 `waitedForScan=false`（没有重新扫码）。它**不能**当作「读到了推荐流」的证据，也不能用来证明「已登录」；推荐流在现行走廊的验证结论，以 `V2-P3-04K` 的 11:29 / 11:36 CST 两轮 CDP 证据为准。
