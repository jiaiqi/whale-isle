# ADR-006：抖音受限自动评论与每日行为记录

- **状态**：Accepted（2026-11-27，用户明确授权功能范围；真实平台验收仍独立进行）
- **关联**：`V2-P3-04K`、`REQ-SOC-01`、`REQ-SOCIAL-04/06/08`、`V2-P4-02`

## 用户决策原文

> 账号继续用我现在的号，这个号不是我日常用的可以随便用，范围：别人视频也要评论，。自治级别：不需要审核，一开始就「有限自动发送」，但是发了什么都要能在当前软件中有记录，能让我查看 ai 每天都做了什么

## 决策声明

采用既有隔离 Profile 与模型网关，新增独立的受限顶层评论执行器：默认关闭、模型自主决定是否评论、SQLite 发送前预留与事后回执、生活页按日查看原文；借鉴 dsh-douyin-agent 的收据纪律、dsh-douyin-studio 的预算总闸及 dsh_douyin_tools 的默认关闭/unknown 不重发思想，全部自行实现。不采用签名逆向、UA/stealth、验证码绕过、参考项目源码复制；不引入点赞、关注、私信、发布或楼中楼回复。验证使用契约编译、确定性测试、本地 Electron 沙盒与全量门禁；默认每日 10 次尝试、滚动小时 3 次、间隔 180 秒、同视频 30 天冷却、00–08 禁发，任一故障/风控/结果不确定立即关闭评论，回退只读且保留账本。

## 范围与例外

1. 本次用户明确选择跳过逐条人工审核，并指定当前 `douyin-owner` 账号（非其日常号），属于对原 L1-only、先 L2 再 L3 及角色独立账号路线的局部调整；不解锁其它平台或写操作。
2. `BrowseSession.interactionMode=readonly` 保留。一次浏览正常收官后才进入独立评论阶段，最多评估 3 个已读候选、至多尝试发送 1 条；内容必须由模型决定，不能模板化机械刷屏。
3. 评论能力独立验证：默认 `lastVerifiedAt=0`；显式“单条发送并核验”入口允许首次探测，仅真实新增评论回读确认后登记该能力，证据 7 天有效。只读冒烟不得冒充写能力通过。
4. 平台条款与访问边界不因账号授权而放宽。页面结构未知、风控、登录墙、模型不可用或账本故障均停止，禁止换 UA/IP 或反复尝试；本批不发起真实平台请求。
5. `pending` 在点击前持久化，`sent` 仅由可靠回读产生。点击后无法确认则 `uncertain`，重启将遗留 pending 转 uncertain；所有发送尝试（含失败/不确定）占额度与视频冷却，不自动重发。
6. UI 提供总开关、明确的未验证/暂停原因、逐日分页记录（时间、目标、全文、模型、结果、原因）。日志只在本机 `workbench.db`，不包含凭据，模型不能篡改账本或执行 Shell。

## 回退与退役条件

关闭评论开关即停止后续发送，正在生成/等待输入的任务通过世代校验取消；已点击的评论保留最终或不确定回执。功能可独立撤回，账本不删除；未来若扩展其它平台，应将评论装配提取成专门宿主模块，继续沿用 shared-protocol 契约和 SQLite 单点账本，不复制状态或放宽门禁。

## 落地与验证状态（2026-11-27）

- 已实现：契约、独立 `DouyinCommentExecutor`、SQLite 发送前预留与逐日审计、真实 DOM 发送与稳定回读、宿主 3 路 IPC、生活页面板与按日期记录。
- 已验证：46 例单测、真实 Electron 本地仿真 E2E 1/1、真实构建主应用 UI/IPC 实测（默认关闭、开关不伪造实测时间、种入仿真记录可查）、`pnpm verify:gate` 8/8。
- 未验证：真实已登录抖音评论 DOM、真实平台发送与回读、真实模型「浏览 → 评论」长循环。P3-04I 生产冒烟仍阻塞于「验证码中间页」，本批未重试、未绕过；能力矩阵 `douyin/comment_reply` 的 `lastVerifiedAt` 保持 0，自动评论不会执行。
- 证据：[P3-04K-douyin-bounded-comments-verification.md](../evidence/P3-04K-douyin-bounded-comments-verification.md)。

## 补记：评论端口下沉到 CDP 驱动（2026-11-27，PR #10）

**背景**：P3-04K 首次落地时，评论端口只实现在 `ElectronBrowserEngine`。而 `V2-P3-04K` 的 CDP 驱动上线后，macOS 默认 `driver` 已是 `cdp-real`——只实现 Electron 侧等于**生产环境评论功能不可用**（`DouyinCommentExecutor` 会因缺少 `readComments/postComment` 直接判 `page_error`）。

**决定**：

1. 评论是**两个驱动共用的端口**，不是某一个驱动的私有能力。接口为 `@workbench/character-core` 的 `DouyinCommentPort`，`DouyinWebSession.readComments/postComment` 即该端口。
2. 时序与判定只写一份：`apps/desktop-host/src/main/douyin-comment-port.ts` 的 `createDouyinCommentPort(ops)`；Electron 与 CDP 各自只注入 `navigate` / `evaluate` / `sleep` / `now` 四个原语。DOM 脚本抽到 `douyin-page-reader.ts` 共用。
3. 护栏与回执语义完全不变：只允许 `https://www.douyin.com/video/<数字>`；输入框/发送按钮必须是评论专属 `data-e2e` 控件，页面结构未知即失败、绝不退回全页面通用按钮；只有「新增稳定数字 ID + 全文回读 + 重载仍在」判 `sent`，否则 `uncertain` 且不重发；验证码/登录墙立即停手。
4. CDP 侧的导航与等待沿用既有只读读取路径：`CdpPageDriver.navigate` 的 `location.href` 回读、静默失败重试与 20s 兜底超时对评论路径同样生效。

**红线边界（仍是一次例外，不是通用写能力）**：

- `cdp-browser-engine.ts` 的 R1 由「严格只读」改为「只读 + **受限评论**」；逐条保留：不点赞、不关注、不发私信、不发布、不逆向签名接口、不改 UA、不做 stealth、不绕过验证码。
- 评论仍是唯一被授权的写能力，且**默认关闭**；`lastVerifiedAt` 保持 0，宿主不会自动发送。
- 审计口径不变：SQLite `social_comment_actions` 发送前预留、逐日可查、失败/跳过/不确定同样记录；模型不能篡改账本或执行 Shell。
- 本次仍**未向抖音发起任何真实评论**（不登录、不扫码、不碰验证码）；新增证据仅为仿真 CDP 端点与单测，真实发送仍待 `[REAL-DEVICE]` owner 验收。
