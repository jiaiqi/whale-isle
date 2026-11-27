# EXTERNAL-FUSION B · 外部参考复用研究（固定 SHA / 许可证 / 源码坐标 / 决策）

> 日期：2026-11-27 · 鲸屿基准：`dba66ec`（`origin/feat/whale-isle-v2`）
> 参考仓根目录：`/Users/jiaqi/Documents/vibe/reference-clones/`（**只读，未修改；`dsh-stardew-blind-whale-farmer` 的本地未提交补丁未被触碰**）
> 方法：**静态只读源码核验**。未运行任何参考仓脚本、未安装依赖、未启动浏览器、未登录平台、未执行其测试。
> 说明：本文的「可复用」只表示许可证与工程形态允许；是否真的复制代码仍受 `AGENTS.md` §2.2 与 `docs/THIRD_PARTY_NOTICES.md` 约束。鲸屿默认**重写为主**，因为我们是 TypeScript 单仓，整段搬运 Python/JS 的维护成本高于收益。

---

## 1. 固定版本与许可证核验

| # | 仓库 | 本轮 HEAD | 日期 | 顶层许可证（实读） | 代码 / 素材 / 传递依赖的边界 | 复用档位 |
|---|---|---|---|---|---|---|
| 1 | `AlexisVon/dsh-living` | `12f4f82` | 2026-11-27 | ✅ 根 `LICENSE` **MIT**（`Copyright (c) 2026 alexis`）+ 根 `NOTICE.md` + 子包 `LICENSES/qrcode-generator.MIT.txt` | 代码 MIT；未发现需要单独标注的非 MIT 素材；QRCode 子依赖单独 MIT | **可复用代码**（默认仍重写） |
| 2 | `Britneycode/dsh-fish-soul` | `ae8fe8b` | 2026-11-27 | ⛔ **根目录无 `LICENSE` 文件**；仅 `package.json:11` 写 `"license":"MIT"`、README 有 MIT 章节 | 根级代码按「无许可证 = 保留所有权利」从严；内含 vendored `douyin-bridge`（MIT，`pcmxiao` 出处）与 `douyin-bogus.js`（MIT，`zhinjs/douyin-im` 出处），但后者服务红线路线 | **仅重写思想，零源码复制** |
| 3 | `regrevia/Envoy` | `332638b` | 2026-11-26 | ✅ 全仓 **Apache-2.0** + 根 `NOTICE`；`packages/envoy-core` / `envoy-cli` / `integrations/dsh/envoy-dsh` 统一署名 `Envoy contributors` | 代码 Apache-2.0；Python 传递依赖未逐项审计（本轮只读主仓）；若复制任何片段必须保留 `LICENSE` + `NOTICE` 并标注修改（Apache-2.0 §4） | **进程级复用（外部 MCP），不 vendor 源码** |
| 4 | `alexbu512/milancat-bot` | `83aa77a` | 2026-11-15 | ✅ 根 `LICENSE` **MIT**（`Copyright (c) 2026 milancat bot contributors`） | 代码 MIT；无显著第三方素材 | **可复用代码**（默认重写思想） |
| 5 | `LockyBee/dsh-douyin-agent` | `9c49833` | 2026-11-12 | ✅ 根 `LICENSE` **MIT**（`Copyright (c) 2026 LockyBee and contributors`） | 代码 MIT；内含 Apache-2.0（`dsh-video-storyboard`）、BSD/Apache（`jpeg-js`）、MIT（`mimo/minimax/voice`）等第三方，若复制需逐文件确认 | **重写思想**；写操作全线拒绝 |
| 6 | `AAAjzx111/dsh-douyin-agent` | `0c6a9a9` | 2026-11-11 | ✅ 根 `LICENSE` **MIT**（版权行仍是 `LockyBee and contributors`，fork 未改） | 代码 MIT；`media/PROVENANCE.json:6-60` 记 vendored `mimo` / `voice` / `minimax` 及各自 LICENSE；整仓为个人定制分支 | **仅借鉴两个概念**；整仓拒绝 |
| 7 | `dbbdbdhdbxb-design/dsh-douyin-studio` | `43531b6` | 2026-11-16 | ✅ 根 `LICENSE` **MIT**（`Copyright (c) 2026 辰辰辰chen`） | 代码 MIT；无显著第三方素材 | **重写思想**；写操作全线拒绝 |
| 8 | `kdcadmin/dsh_douyin_tools` | `5c3a644` | 2026-11-11 | ✅ 根 `LICENSE` **MIT**（`Copyright (c) 2026 TiAmoSS`） | 代码 MIT；但**内含踩红线实现**（见 §2.7），不是许可证问题而是安全红线 | **仅挑非红线小技巧** |
| 9 | `pcmxiao/dsh-douyin-bridge` | `6e4bb7f` | 2026-10-27 | ✅ 根 `LICENSE` **MIT**（`Copyright (c) 2026 dsh-douyin-bridge contributors`）+ `NOTICE.md` | 代码 MIT；`NOTICE` 记参考 MIT `c1overzz/dsh-bili-scroll` | **重写思想**；**已知游标缺陷不得照搬** |

**素材红线**：本轮九仓未引入任何新音频/图片/模型/字体；鲸屿既有的 `dsh-pet` WebM、`aboutme-pets`、`crosspet` 立绘、`dsh-livestream/dafeiyu` 仍保持 `DEV_ONLY_NON_COMMERCIAL`（见 `docs/THIRD_PARTY_NOTICES.md`）。Apache-2.0 的 `Envoy` 与 `dsh-video-storyboard` 若未来复制代码，必须归档 `NOTICE` 到 `docs/licenses/`。

---

## 2. 逐仓研究

### 2.1 `AlexisVon/dsh-living`（MIT，35,233 行）—— 与 `LifeRuntime` + `MemoryGraph` 最同源

**实际阅读范围**（本轮实读）：`packages/core/lib/{runtime,clock,recall,memory,memory-extract,notes,round,persona,audit,adjudicator,gems,budget,layers}.mjs`、`docs/ARCHITECTURE.md`。未逐行读全仓 150 文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| 单回合锁 + 唤醒 | `runtime.mjs:274-311` | `pendingWake` 布尔、`scheduleWake()` 只安排一次后续 tick、`tick()` 消费掉 `pendingWake` 再重排；运行中的回合撞上自动采样点直接作废，不积压 |
| 零成本正态网格 | `clock.mjs:9-36,138-165` | 五档 σ、hot/cold/normal 时域、60% 正态 + 40% 洗牌；无模型调用 |
| R1–R8 召回通道 | `recall.mjs:2-3,21-28,81-140` | 每个结果带 `why`；无通道命中不浮现；R8 舌尖只吐模糊轮廓 |
| 元记忆与冷区 | `memory.mjs:17-39,243` | `META_HINTS` 过滤自我内省；冷区「低保真，不得作为行动依据」 |
| 分层笔记 | `notes.mjs:5-8,97-128` | S 持久 ≤50（每条 ≤40 字，core ≤8 全文）、A 今日 ≤10、B 昨日 ≤10 |
| 信任边界 | `round.mjs:14,55` | 逐条标 `主人` vs `外部·仅数据`；静态头部保 Prefix Cache |
| 外发二段审查 | `audit.mjs:7,60,90`；`adjudicator.mjs:1-54` | 规则 R01–R05 + 一次性无工具小模型；失败按待审而非放行 |

**潜在缺陷 / 不适用**

- 全仓**没有**桌宠 GUI、游戏 MCP、音频/唱歌、真实浏览器 CDP；它只有通用 Gem 契约，不能替代鲸屿任何领域运行时。
- 与 DSH/Cordis 插件体系耦合（`ctx.agents` / `ctx.agentDefaultModel`）；鲸屿不接 DSH（`P3-04J` §5 结论）。
- 正态网格的参数（σ/时域）是作者调过的经验值；直接照搬可能不符合小鲸作息，必须可配置并配虚拟时钟测试。
- 未运行其测试，无法确认 35k 行在当前 Node 版本的真实行为。

**鲸屿映射**：`LifeRuntime`（调度/事件/预算）、`MemoryGraph`（召回/冷区）、`persona-brain`（信任边界/笔记分层）、`social-runtime`（外发审查）。

**决策**：**重写思想，可复用小型纯函数/常量**。不引入 Cordis、不新建 Living Runtime、不复制大段 `runtime.mjs`。许可证允许复制，但 TS 单仓维护成本不划算。

**已验证范围**：静态源码 + 行号；**未验证**：真实运行、测试通过率、参数在鲸屿语境下的效果。

---

### 2.2 `Britneycode/dsh-fish-soul`（根无 LICENSE，85,379 行）—— 只能重写思想

**实际阅读范围**：`lib/{growth,mood-guard,outbox,soul-memory,safe-download,worldinfo,time-awareness}.js`、`lib/channels/douyin-http.js`、`lib/vendor/douyin-bogus.js`、`package.json`、README 许可节。未读全仓 355 文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| 可证伪成长闸门 | `growth.js:7-19,36-45,88-101` | 双通道 ≥3 次且跨 ≥2 天，或单通道 ≥5 次且跨 ≥3 天；45 天无新证据过期；`contradicts` 反证退场；active 最多 5 条注入 |
| 防情绪横跳 | `mood-guard.js:11-26,69` | 每日最多 4 次标签切换；同标签叠加算「余温」不耗次数；脆弱共情硬约束 |
| 记忆防毒三铁律 | `soul-memory.js:593-626,712-733` | `#75` 自产日程/想象不当既成事实；`#76` 装置能力短板不进长期记忆、不因反复想起升星；`#167` 绝对日期 + 宁漏不混 |
| 外部副作用三态 | `outbox.js:51-56,84-85,193-243` | `retry` = 肯定没发出可重发；`unknown` = 可能已发出不重发；重启把 `sending` 全部迁 `unknown` 并告警 |
| SSRF / ReDoS 防御 | `safe-download.js:44-61`；`worldinfo.js:65-86` | 解析 IP 全量校验 + Socket 直连 + SNI；外部世界书正则进 `vm` 限时 30ms，超时熔断 |
| 必须拒绝的抖音 HTTP | `lib/douyin-http.js`（`secsdkSignature` / `aBogusSignature` / `douyinBaseParams`）、`lib/vendor/douyin-bogus.js` | 自算 `X-Bogus`/`a_bogus` 直发 HTTP，触碰鲸屿红线 R3 |

**潜在缺陷 / 不适用**

- **无根 LICENSE**：按 Gate 2 从严，整仓不得复制一行源码、不得 vendor。
- 抖音 HTTP 路线是红线；`douyin-bogus.js` 即使 MIT 也不进仓库。
- `outbox.js` 的 `retry/unknown` 命名与鲸屿 `COMPLETED/FAILED/UNCERTAIN` 不同，迁移时必须映射而非照抄。
- 未运行其测试；85k 行包含大量与鲸屿无关的渠道代码。

**鲸屿映射**：`profile-stores.evolveTrait`（成长闸门）、`persona-brain`（情绪护栏）、`memory-graph`（防毒/冷区）、`runtime-core`（Outbox 三态）。

**决策**：**仅重写思想，零源码复制**。用鲸屿 TS 类型系统原创实现，并把 §17 场景测试写进验收。

**已验证范围**：静态源码 + 行号；**未验证**：运行行为、阈值在鲸屿的统计有效性。

---

### 2.3 `regrevia/Envoy`（Apache-2.0，142,155 行 Python）—— 证据化知识主集成方向

**实际阅读范围**：`packages/envoy-cli/src/envoy_cli/{mcp,knowledge_units,skill_compiler,evidence_pack,knowledge_pack,reader,local_video,knowledge_eval,netpolicy}.py`、`packages/envoy-core/src/envoy_core/schemas/read_v1.py`、`integrations/dsh/envoy-dsh/{index.js,launch.cjs,README.md,skill/envoy.md}`。未读全仓 346 个 Python 文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| 知识单元四态 | `knowledge_units.py:1-7,40-43,261-278,379-394` | `candidate/verified/promoted/archived`；每条强绑 `material_id + evidence_id + locator + source_revision`；编辑后回退 `candidate` 并保留旧版本 |
| 确定性证据包 | `evidence_pack.py:1-9,84-113`（757 行） | 同一材料 + 同一参数 → 同一 digest；证据包是派生数据，材料记录才是权威 |
| Skill 编译 | `skill_compiler.py:22-30,58-107`（265 行） | 依 `depends_on/composed_of` DAG 把已验证单元编译成 `SKILL.md` |
| 多模态定位 | `read_v1.py:57,335,383,424,502` | `VideoLocator` / `PdfLocator` / `ImageRegionLocator` / `WebLocator`；`extraction: complete|partial|failed|unknown` |
| 本地视频/ASR | `local_video.py:31-168` | 文件 SHA-256、帧/字幕/ASR 真存在才记录；ASR 未安装时给明确安装指引 |
| Fake-IP TUN 白名单 | `netpolicy.py:103-138` | 字面量私网 IP 仍拒绝；域名解析命中 `198.18.0.0/15`（可配 `ENVOY_FAKE_IP_RANGES`）放行 |
| MCP 工具面 | `packages/envoy-cli/src/envoy_cli/mcp.py`；`integrations/dsh/envoy-dsh/index.js:34-35,53-75` | MCP 能力独立于宿主；Skill 只是使用说明；链接路由每回合一次 |

**潜在缺陷 / 不适用**

- **整仓 Python 基础设施不能复制进鲸屿**：会引入第二套材料/证据内核与 Python 依赖树。
- `integrations/dsh/envoy-dsh` 是 DSH 薄桥接，鲸屿不接 DSH；只借「MCP 独立进程 + Skill 说明 + 链接路由一次」的形状。
- Python 传递依赖的许可证**未逐项审计**；以进程方式调用可规避 vendoring，但分发时仍需在 NOTICE 中声明 Envoy 版本与 Apache-2.0。
- MCP 的启动依赖 `uv`/PATH；`launch.cjs:56-160` 的 PATH 探测是 DSH 场景，鲸屿需在自己的宿主里重做。
- 未真实调用其 MCP；「证据包能生成」是静态阅读结论，不是鲸屿验收。

**鲸屿映射**：`shared-protocol/src/knowledge.ts`（契约扩展）、`game-bridge-mcp/guide-library.ts`（知识库/兼容检查）、新 MCP Adapter（独立进程）、Tidepaper 知识页。

**决策**：**进程级复用（外部 MCP），不 vendor 源码**。若未来复制任何片段，按 Apache-2.0 保留 `LICENSE` + `NOTICE` 并标注修改。

**已验证范围**：静态源码 + 行号 + 许可证；**未验证**：真实 MCP 调用、证据包内容、ASR/视频读取、传递依赖许可。

---

### 2.4 `alexbu512/milancat-bot`（MIT，9,410 行）—— 与单角色正交，只借工程技巧

**实际阅读范围**：`index.js`、`lib/{engine,activity,memory,skill}.js`。全仓只有 7 个文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| 真实子 Agent 生命周期 | `lib/engine.js:1455`（`runAgent`，复用成员会话，失效重建）、`:1220`（`readChildTurn`）、`:1612`（`runHandoff`）、`:2042`（`dispatchTask`） | 部门/成员与真实运行的子 Agent 关联 |
| 审批与取消 | `lib/engine.js:329`（`askApproval`）、`:489`（`resolveApproval`）、`:1131`（`cancelTask`） | 一次性/范围审批；父任务取消传播 |
| 越界与出网闸 | `lib/engine.js:189`（`insideDir`）、`:216`（`egressSend`） | 路径越界检查；本地只读自动放行，`curl -X POST`/`ssh`/`git push` 等外发命令拦截并要求审批 |
| 工具审计轨 | `lib/activity.js:15-202` | 按天 JSONL，`describeArgs()` 摘要避免整包 payload |

**潜在缺陷 / 不适用**

- 定位是「AI 老板 + 多员工文件夹 + 飞书群调度」，与鲸屿单主体数字生命**正交**；其 `memory.js`（120 条 JSON + 2-gram）显著弱于鲸屿 `MemoryGraph`。
- Prompt 指定工作目录 ≠ 文件系统隔离；鲸屿必须由宿主强制权限，不能只靠提示词。
- 未运行其测试；`engine.js` 4,582 行，耦合飞书/DSH，不能整段搬。

**鲸屿映射**：`agent-harness`（任务编排层、Worker 会话复用、审批、取消）、`runtime-core`（路径/出网命令分类）。

**决策**：**重写思想**。不引入组织模型、不复制 `engine.js`。

**已验证范围**：静态源码 + 六个函数行号；**未验证**：真实子 Agent 行为、审批边界。

---

### 2.5 `LockyBee/dsh-douyin-agent`（MIT，40,473 行）—— 观察版本与稳定身份

**实际阅读范围**：`autonomous-watch.mjs`、`contact-authorization.mjs`、`receipt-baseline.mjs`、`persona-memory.mjs`、`usage-ledger.mjs`、`memory-policy.mjs`、`browser-host.mjs`、`core.mjs`、`diagnostics.mjs`。未读 263 文件全部。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| 执行前再核验 | `autonomous-watch.mjs:197-203,454` | `execute(name,args,{expectedVideoId,expectedImageKey,expectedLiveRoomId,...})`；页面变了就 `watch.decision-discarded` / `observed-video-changed` |
| 稳定会话身份 | `contact-authorization.mjs:2-53` | `conv:<sha256>` + `identityVersion:2` + `identityBinding`；禁止仅凭昵称/头像替换 |
| 点击前 SHA-256 基线 | `receipt-baseline.mjs:5,32-46` | `operationId + videoId + knownIds + textSha256 + 整包 digest`；回读核对同一基线 |
| 行为证据阈值 | `persona-memory.mjs:17,34-42,77-79` | `sustainedSeconds:8`、`completionRatio:0.6`、`quickSkipSeconds:3`、`progressRateTolerance:1.25`；进度样本要过重算/卡顿/回退/拖动校验 |
| 用量账本诚实 | `usage-ledger.mjs:15-16,45` | `unknownRequests` 不当零；未报告用量标未知 |
| 真浏览器 | `browser-host.mjs:132-135` | `channel:'msedge'`、`headless:false`、持久 profile；Windows-only |

**潜在缺陷 / 不适用**

- **写操作全线**（点赞/评论/分享/私信/续火花）越过鲸屿 L1 红线；只借「读侧」机制。
- Windows 专用（`msedge` 硬编码、注册表、`tasklist`），macOS 不能直接搬。
- `receipt-baseline` 是为写操作设计的；鲸屿当前 L1 只需「观察版本」，不引入写基线。
- 未运行其测试；其验证文档是作者自述，不是鲸屿证据。

**鲸屿映射**：`social-executor`（观察版本）、`social-douyin`（稳定目标身份）、`interest-sink`（行为证据）、`runtime-core`（Outbox 目标身份）。

**决策**：**重写思想**。不复制任何写操作/Windows 实现。

**已验证范围**：静态源码 + 行号；**未验证**：真实平台行为、其测试。

---

### 2.6 `AAAjzx111/dsh-douyin-agent`（MIT，13,591 行）—— 只借能力探针与拼图概念

**实际阅读范围**：`native-watch-decision.mjs`、`media/{mimo_bridge.py,index.mjs,key-store.mjs,PROVENANCE.json}`、`CHANGELOG.md`、`frame-composite.mjs`、`capture-session.mjs`。未读全仓 55 文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| 模型能力探针 | `native-watch-decision.mjs:3,17-34` | 检查 `inputModalities` 是否含 `image`、附件服务能否 `saveImages`、附件引用是否完整；不能接收真实画面就**明确停止**，不静默退化 |
| 浏览器内拼图 | `frame-composite.mjs` | Canvas 多帧拼一张，带去重与右侧裁剪（概念可借，代码不搬） |
| 断点续采 | `capture-session.mjs` | 被插队时切段不丢帧，最终合并到同一 `videoId` manifest（概念可借） |
| vendored 驱动溯源 | `media/PROVENANCE.json:6-60` | `mimo` / `voice` / `minimax` 各自 LICENSE 与版本 |

**潜在缺陷 / 不适用**

- 整仓是个人定制分支：删除了上游全部 `tests/`、`verification/`、`desktop/`、隐私图 DAG、SHA-256 收据锁；硬编码 `D:\Deep\diary\`；主推无人确认自动评论/私信。
- 版本号 1.4.9 高于上游 LockyBee 1.4.7，但社区验证最少；引用应锁定上游。
- `media/mimo_bridge.py` 固定版本驱动，与鲸屿 MiMo 语音主线不兼容；**不替换**现有 `voice-runtime`。

**鲸屿映射**：`model-gateway`（能力探针）、`content-understanding`（帧/附件完整性）、`live-stream-hub`（未来的拼图降本）。

**决策**：**仅借鉴两个概念**（能力探针、帧拼图）；整仓拒绝。

**已验证范围**：静态源码 + 行号；**未验证**：探针在真实供应商上的行为。

---

### 2.7 `dbbdbdhdbxb-design/dsh-douyin-studio`（MIT，29,474 行）—— 预算/停损/前筛

**实际阅读范围**：`lib/{autopilot,budget,queue,scheduler,ledger,jobs,policy,risk,guard,killswitch,fsx,events,runlog,feed,watch}.mjs`、README。未读全部 188 文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| fail-closed 预算 | `budget.mjs:18-21,132-158` | 账本坏了 = 一律拒绝；「宁可今天不回，也不要风控账号」 |
| 持久化队列 + 死信 | `queue.mjs:7-8,22,70-101` | 失败落盘，试满 5 次标 `dead`，不再自动重试 |
| 物理停损总闸 | `killswitch.mjs:2-29` | `KILL` 文件存在 = 所有写操作拒绝；**只读永远放行** |
| 风控分级冷却 | `risk.mjs:15-18,50` | 码 `[352,412,2154,3002]` + 正则双通道；30→60→120→360 分钟；只挡写 |
| 四道零成本前筛 | `feed.mjs:86-110` | 批量去重 → 已读 → 广告 → 时长/关键词/点赞；搜索无时长不误杀 |
| 抽帧诚实 | `watch.mjs` | 未显式 `frames:true` 不抽；没抽到就 `frames:false`，绝不假装看过 |

**潜在缺陷 / 不适用**

- 全套写操作（发作品/评论/私信/@/分享/删除）越过 L1 红线。
- **普通重试不能当外部副作用协议**：`queue.mjs` 的 5 次重试不区分「确定未发/可能已发」；鲸屿必须用 Outbox 三态。
- 直接走 web API + 固定参数（`lib/api.mjs`）属于接口直连思路，不在 L1 范围。
- 未运行其测试。

**鲸屿映射**：`runtime-core`（预算账本/队列/KILL/风险冷却）、`social-executor`（前筛）、`content-understanding`（抽帧诚实）。

**决策**：**重写思想**。写操作与 web API 直连拒绝。

**已验证范围**：静态源码 + 行号；**未验证**：真实风控行为、账本恢复。

---

### 2.8 `kdcadmin/dsh_douyin_tools`（MIT，14,374 行）—— 红线混杂，只挑小技巧

**实际阅读范围**：`lib/{actions,action-proxy,mcp,state,process}.mjs`、`video-understanding-lab/{evidence,asr,capture,replay}.py`、`vendor/douyin-mcp/mcp_server.py`、`index.js`。未读全部 39 文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| 临时本地能力代理 | `lib/action-proxy.mjs:5-28` | 随机 token、工具白名单、请求体大小、超时、宿主维护权限 |
| 进程内队列 + 跨进程动作锁 | `lib/actions.mjs:6-52` | 可重入锁；**区分普通 `ok` 与 `verified`** |
| 证据引用校验 | `video-understanding-lab/evidence.py:7-35` | 校验模型引用的关键帧/转写片段是否真实存在、时间范围合法、覆盖情况 |
| 真实验证码可见性过滤 | `vendor/douyin-mcp/mcp_server.py:818-826` | `width/height > 120` 且可见，排除常驻隐藏 verify iframe |
| 虚拟列表去重 | `index.js:2471-2479` | `occ:${direction}:${normTextKey}:${occurrenceCount}` |

**必须拒绝的实现**

- `--disable-blink-features=AutomationControlled`（`mcp_server.py:472`）、硬编码 Chrome 155 UA（`:88-94`）→ 反检测红线。
- 默认复用用户日常 Chrome Profile（`index.js:1562-1568`）→ 违反 Per-Character 隔离。
- 页内 `fetch('/aweme/v1/web/comment/list/...')`（`mcp_server.py:1391-1452`）→ 未公开接口。

**潜在缺陷 / 不适用**

- 单文件 4,769 行 `mcp_server.py` + 4,714 行 `index.js`，维护性差；不能整段搬。
- 未运行其测试。

**鲸屿映射**：`plugin-kit`/`runtime-core`（临时能力代理、动作锁、verified 语义）、`content-understanding`（证据校验）、`social-executor`（验证码可见性过滤）。

**决策**：**仅挑非红线小技巧**。反检测/默认 Profile/未公开接口拒绝。

**已验证范围**：静态源码 + 行号；**未验证**：真实平台与 ASR。

---

### 2.9 `pcmxiao/dsh-douyin-bridge`（MIT，12,402 行）—— 浏览器实战 + 已知游标缺陷

**实际阅读范围**：`lib/{bridge,session-history,state,browser,douyin,media}.mjs`、`lib/selectors.mjs`、`lib/comment.mjs`、`PITFALLS.md`、`NOTICE.md`。未读全部 53 文件。

**关键实现（带坐标）**

| 机制 | 坐标 | 事实 |
|---|---|---|
| Chromium 防后台冻结三件套 | `lib/browser.mjs:29-31` | `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding` / `--disable-background-timer-throttling` |
| 导航后强校验 | `lib/browser.mjs:490-521` | `Page.navigate` 可能静默停在 `about:blank`；必须读 `location.href` 校验并重试 |
| 单视频直达 | `lib/comment.mjs:6-31,73-75` | `https://www.douyin.com/?modal_id=<id>` 最稳，减少被弹回精选 |
| 稳定选择器表 | `lib/selectors.mjs`、`lib/comment.mjs:57-63` | 多级 `data-e2e` 回退 |
| 会话映射/历史基线/序号去重 | `lib/bridge.mjs` | 外部联系人映射到宿主会话；首次只建基线；自己消息不回灌 |
| **已知缺陷：先推游标再发送** | `lib/bridge.mjs:797-827` | `rec.lastRelayedSeq = ev.seq` 在 `sendDM` 之前（`:809`），发送失败不回滚；一批中后续成功会连带推进先前失败消息的游标 |

**潜在缺陷 / 不适用**

- `relayPending` 的游标缺陷会导致消息丢失/跳过/重启后重放不一致；**不得照搬**，必须用持久化 Outbox + 独立确认游标重做。
- `session-history.mjs:34-63` 用扫描 zstd 魔数解多帧压缩日志；异常边界未验证，产品应优先成熟流式解码器。
- 含主动浏览/评论/私信/发图工具；鲸屿 L1 不用写路径。
- 未运行其测试。

**鲸屿映射**：`runtime-core/browser-runner`（三件套/导航校验）、`social-douyin`（选择器/`modal_id`）、未来的 Channel Adapter（会话映射 + 修游标）。

**决策**：**重写思想**。三件套与 `location.href` 校验可直接进 `V2-P4-01E`；游标缺陷必须反向修。

**已验证范围**：静态源码 + 行号 + 缺陷；**未验证**：真实平台上的重试行为。

---

## 3. 决策矩阵（按能力面）

| 能力面 | 首选参考 | 决策 | 理由 |
|---|---|---|---|
| 生命节奏/单回合 | `dsh-living` | 重写思想 | MIT 可复制，但 TS 单仓重写更稳；不建第二 Runtime |
| 记忆召回/防毒 | `dsh-living` + `dsh-fish-soul` | 重写思想 | fish-soul 无 LICENSE；living MIT 但耦合 DSH |
| 人格成长闸门 | `dsh-fish-soul` | 仅重写思想 | 无根 LICENSE |
| 证据化知识 | `Envoy` | 外部 MCP 进程复用 | Apache-2.0 + 证据体系最完整；不复制 Python |
| 任务编排 | `milancat-bot` | 重写思想 | MIT，但组织模型正交；只借会话复用/审批/取消 |
| 观察版本 | `LockyBee` + `dsh-douyin-bridge` | 重写思想 | 写操作红线；只借读侧 expected* 与浏览器校验 |
| 预算/停损/前筛 | `dsh-douyin-studio` | 重写思想 | 写操作红线；预算/队列/KILL 形状可借 |
| 能力代理/证据校验 | `dsh_douyin_tools` | 仅挑小技巧 | 反检测/默认 Profile/未公开接口拒绝 |
| Outbox 三态 | `dsh-fish-soul` | 重写思想 | 无 LICENSE；语义可直接用鲸屿回执映射 |
| 能力探针 | `AAAjzx111` | 仅借概念 | 个人分支，整仓拒绝 |
| 外部渠道桥接 | `dsh-douyin-bridge` | 重写思想 | 游标缺陷不得照搬；最后做 |

---

## 4. 本轮未验证 / 未做的事（诚实声明）

1. **未运行任何参考仓的测试或脚本**；所有「实现事实」都来自静态源码与文件行号，不代表运行时行为。
2. **未真实调用 Envoy MCP**；第一垂直切片的「真实证据包」必须由 E 文档定义的验收步骤在后续工单中完成。
3. **未逐项审计 Envoy Python 传递依赖**；以进程方式接入可规避 vendoring，但分发前仍需补 NOTICE 与依赖清单。
4. **未核实 fish-soul 作者是否愿意补 LICENSE**；在补之前按「保留所有权利」处理。
5. **未验证 LockyBee/studio/tools/bridge 在其目标平台（Windows）的真实行为**；鲸屿只借架构思想，不搬实现。
6. **未审计九仓之外的历史 22 仓**（`dsh-pet`、`crosspet`、`dsh-livestream` 等已在 `docs/REFERENCES.md` / `THIRD_PARTY_NOTICES.md` 有结论）；本单不重复展开。
