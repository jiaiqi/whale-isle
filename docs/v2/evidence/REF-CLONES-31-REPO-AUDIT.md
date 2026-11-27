# Whale Isle（`ai-vtuber-workbench`）参考仓全景深度源码审计报告（31 仓静态实读）

> **审计基准**：本机工作区 `feat/whale-isle-v2`（`ref-clones-source-audit` @ `a1d9e5c`，干净未改） + 对照分支 `rabbitfish`（`feat-douyin-browser-cdp` @ `ecc82a1` + item #16 本地改造） + `<reference-clones>/` 全量 **31** 个仓库（9 个本次目标仓 + 22 个既有历史参考仓）。  
> **审计纪律**：100% 静态只读源码核验（未运行任何参考仓脚本、未安装依赖、未启动浏览器、未触碰本地 Chrome CDP 与星露谷进程、未改动既有仓或本地补丁）；所有文件路径、行号、SHA、代码规模与许可证结论均来自本轮直接读取或工具实测输出。
> **归档与立项衔接（2026-11-27 owner 拍板）**：
> - 本报告由 `item #18` 只读源码审计底稿脱敏归档入仓（仅将本机绝对路径替换为 `<reference-clones>/...` 与分支相对路径，完整保留全部 31 仓源码事实、行号、SHA、许可证三档矩阵与 P0–P2 清单）。
> - `P0-1`（抖音 CDP 四项补强）已交由独立工单 `item #20` 推进；`P0-2 / P0-3 / P0-4 / P1-1` 已纳入外部参考融合蓝图与七步切片（`item #21`，首切片为 `Envoy` 证据知识单元 + 星露谷攻略闭环）。
> - 同步确立研发惯例：**所有新功能开发前先检索 `reference-clones` 并写明复用 / 重写 / 拒绝结论**，严守 Gate 2 许可证与风控红线。

---

## 执行摘要与核心结论

1. **克隆与现场保护 100% 安全落地**：8 个新增目标 GitHub 仓库全部以 `--depth 1` 一次克隆成功，0 失败；既有同名仓 `dsh-douyin-agent` 确认为 `LockyBee/dsh-douyin-agent`（`v1.4.7`、`9c49833`），已执行安全 `--ff-only` 同步检查（无新提交）；重名仓库 `AAAjzx111/dsh-douyin-agent` 已隔离克隆至 `AAAjzx111-dsh-douyin-agent`；含本地未提交补丁的 `dsh-stardew-blind-whale-farmer`（`BlindWhaleFarmer/McpServer.cs` 与 `ModEntry.cs`，共 `+466/-21`）保持原样零触碰。
2. **填补此前 `P3-04J` 调研的四大盲区**：
   - **盲区一（`dsh-fish-soul` 非抖音灵魂内核）**：`P3-04J` 此前只看了该仓抖音部分；本次深挖其 85,379 行主体，发现其拥有极精细的**可证伪跨源人格成长闸门**（`lib/growth.js`）、**防情绪横跳与脆弱共情护栏**（`lib/mood-guard.js`）、**防记忆毒丸三大铁律 `#75/#76/#167`**（`lib/soul-memory.js`）以及 **DNS Rebinding Socket 直连校验**（`lib/safe-download.js`）与 **30ms `vm` 防 ReDoS**（`lib/worldinfo.js`）。但⛔ **其根目录缺失 `LICENSE` 文件**（仅 `package.json` 写 `"license": "MIT"`），按 Gate 2 从严口径列为「仅参考思想、严禁复制源码」。
   - **盲区二（`dsh-living` 同源数字生命核）**：`AlexisVon/dsh-living`（35,233 行，✅ **MIT**）是目前所有参考仓中与鲸屿 `LifeRuntime` + `MemorySystem` 愿景最同源的完整实现：提供 0 模型成本**正态网格自主唤醒**（`clock.mjs`）、**R1–R8 可解释想起通道 + 冷区降级提示**（`recall.mjs` / `memory.mjs`）、**S/A/B 笔记分层与 Prefix Cache 稳定分隔**（`notes.mjs` / `round.mjs`）及 **公域外发二阶段无工具小模型审查**（`audit.mjs` / `adjudicator.mjs`）。
   - **盲区三（`regrevia/Envoy` 主仓 14 万行 Python 基础设施）**：`P3-04J` 此前仅看了 10KB 的 `envoy-dsh` 薄壳，错过整个 Apache-2.0 主仓里的核心金矿——**无模型介入的证据绑定知识单元引擎与 Skill 编译器**（`knowledge_units.py` + `skill_compiler.py`）、**Fake-IP TUN 代理白名单**（`netpolicy.py`）与 **合规去遮罩脚本**（`browser.py`）。
   - **盲区四（`dsh-douyin-bridge` 与 item #16 毫米级对照）**：对比 `rabbitfish` 的 `cdp-browser-engine.ts` 与 `pcmxiao/dsh-douyin-bridge`、`dsh-douyin-studio` 源码，发现 item #16 遗漏了 **Chromium 防后台窗口节流三件套启动参数**、`Page.navigate` 后 **`location.href` 校验**、`?modal_id=` 直开作品详情页等实测硬坑解法。
3. **关键误区澄清**：
   - `alexbu512/milancat-bot` 实为「多员工 AI 公司组织架构 + 飞书群调度插件」，与鲸屿单主体数字生命正交，仅借鉴其出网外发命令分类审计与工具审计轨思路。
   - `AAAjzx111/dsh-douyin-agent`（`v1.4.9`）与 `LockyBee/dsh-douyin-agent`（`v1.4.7`）是从同源 `dafeiyu1314520/dsh-douyin-agent@1.4.7` 分叉演进的兄弟分支，而非简单“过时抄袭”：LockyBee 走强收据/隐私有向图/用量账本/全套测试的工程路线；AAAjzx111 则走“删安全测试、加 Canvas 拼图 `frame-composite.mjs` 与断点续采 `capture-session.mjs` 及自动回复写操作”的个人定制路线。

---

## 一、克隆现场验证与全量 31 仓全景清单

### 1.1 目标 9 仓克隆状态与本地保护核验

| # | GitHub 仓库 | 本地目录 | 处置方式 | HEAD SHA | 本地安全状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `Britneycode/dsh-fish-soul` | `dsh-fish-soul` | 新增 `--depth 1` | `ae8fe8b` | 干净，未运行 |
| 2 | `AlexisVon/dsh-living` | `dsh-living` | 新增 `--depth 1` | `12f4f82` | 干净，未运行 |
| 3 | `alexbu512/milancat-bot` | `milancat-bot` | 新增 `--depth 1` | `83aa77a` | 干净，未运行 |
| 4 | `regrevia/Envoy` | `Envoy` | 新增 `--depth 1` | `332638b` | 干净，未运行 |
| 5 | `dbbdbdhdbxb-design/dsh-douyin-studio` | `dsh-douyin-studio` | 新增 `--depth 1` | `43531b6` | 干净，未运行 |
| 6 | `kdcadmin/dsh_douyin_tools` | `dsh_douyin_tools` | 新增 `--depth 1` | `5c3a644` | 干净，未运行 |
| 7 | `LockyBee/dsh-douyin-agent` | `dsh-douyin-agent` | 既有同 remote 保留（仅只读 `fetch` 校验） | `9c49833` | 干净（`status=0`），已校验对齐远端 |
| 8 | `AAAjzx111/dsh-douyin-agent` | `AAAjzx111-dsh-douyin-agent` | 重名防碰撞克隆至独立目录 | `0c6a9a9` | 干净，未运行 |
| 9 | `pcmxiao/dsh-douyin-bridge` | `dsh-douyin-bridge` | 新增 `--depth 1` | `6e4bb7f` | 干净，未运行 |

- **既有脏仓零破坏校验**：`<reference-clones>/dsh-stardew-blind-whale-farmer` 保持 `M BlindWhaleFarmer/McpServer.cs`（`+315` 等改动）与 `M BlindWhaleFarmer/ModEntry.cs`（`+172` 等改动）共 `466 insertions(+), 21 deletions(-)` 原样完好。

### 1.2 全量 31 仓技术资产与许可证全景表

#### A. 本次目标 9 仓明细

| 目录名 | GitHub URL | HEAD & 提交日 | 代码规模（源文件/总行） | 主要语言/技术栈 | 真实 LICENSE / NOTICE 核查 | 本轮分类 & `P3-04J` 关系 |
| --- | --- | --- | --- | --- | --- | --- |
| `dsh-living` | `https://github.com/AlexisVon/dsh-living` | `12f4f82` (2026-11-27) | 150 files / 35,233 lines | ESM (`.mjs`), TypeScript (`1 .ts`), Cordis/DSH 插件体系 | ✅ 根 `LICENSE` **MIT** (`Copyright (c) 2026 alexis`) + 根 `NOTICE.md` + 子包 `LICENSES/qrcode-generator.MIT.txt` | **全新（P3-04J 未含）** · A 组核心 |
| `dsh-fish-soul` | `https://github.com/Britneycode/dsh-fish-soul` | `ae8fe8b` (2026-11-27) | 355 files / 85,379 lines | JS/ESM (`.mjs`/`.js`), HTTP/Browser 通道, DSH 插件 | ⛔ **根目录无 `LICENSE` 文件**（仅 `package.json:11` 声明 `"license":"MIT"`）；内含 MIT vendor (`douyin-bridge`, `douyin-bogus.js`) | 与 `P3-04J` 重合（补齐 85k 非抖音内核） · A 组 |
| `milancat-bot` | `https://github.com/alexbu512/milancat-bot` | `83aa77a` (2026-11-15) | 7 files / 9,410 lines | Node JS (`.js`), 飞书 Bot + 多员工目录调度 | ✅ 根 `LICENSE` **MIT** (`Copyright (c) 2026 milancat bot contributors`)，`package.json` 写 `@local/dsh-bot` | **全新（P3-04J 未含）** · A 组（正交） |
| `Envoy` | `https://github.com/regrevia/Envoy` | `332638b` (2026-11-26) | 371 files / 142,155 lines | Python 346 `.py` (MCP/FastMCP/Playwright), TS/TSX 18, JS 3 (`envoy-dsh`) | ✅ **全仓 Apache-2.0 + `NOTICE`**（根、`envoy-core`、`envoy-cli`、`envoy-dsh`、`skills/envoy` 统一署名 `Envoy contributors`） | `P3-04J` 仅看 `envoy-dsh`，**主仓全新** · B 组核心 |
| `dsh-douyin-bridge` | `https://github.com/pcmxiao/dsh-douyin-bridge` | `6e4bb7f` (2026-10-27) | 53 files / 12,402 lines | ESM (`.mjs`), 原生 Chrome CDP (`ws`) + Protobuf | ✅ 根 `LICENSE` **MIT** (`dsh-douyin-bridge contributors`) + `NOTICE.md`（参考 MIT `c1overzz/dsh-bili-scroll`） | **全新（P3-04J 未含）** · C 组核心 |
| `dsh-douyin-studio` | `https://github.com/dbbdbdhdbxb-design/dsh-douyin-studio` | `43531b6` (2026-11-16) | 188 files / 29,474 lines | ESM (`.mjs`), 原生 Chrome CDP + HTTP Server UI | ✅ 根 `LICENSE` **MIT** (`Copyright (c) 2026 辰辰辰chen`) | 与 `P3-04J` 重合（补齐源码行级机制） · C 组 |
| `dsh_douyin_tools` | `https://github.com/kdcadmin/dsh_douyin_tools` | `5c3a644` (2026-11-11) | 39 files / 14,374 lines | ESM (`21 .mjs`), Python (`16 .py`, FastMCP + Playwright), JS (`2 .js`) | ✅ 根 `LICENSE` **MIT** (`Copyright (c) 2026 TiAmoSS`), pkg `dsh-douyin-life` | 与 `P3-04J` 重合（补齐真实行数/红线细节） · C 组 |
| `dsh-douyin-agent` | `https://github.com/LockyBee/dsh-douyin-agent` | `9c49833` (2026-11-12) | 263 files / 40,473 lines | ESM (`245 .mjs`), Playwright MCP/CLI + Electron/桌面包 + Python Whisper | ✅ 根 `LICENSE` **MIT** (`LockyBee`)；含 Apache-2.0 (`dsh-video-storyboard`), BSD/Apache (`jpeg-js`), MIT (`mimo/minimax/voice`) | 既有旧仓 & `P3-04J` 基线 · C 组安全工程标杆 |
| `AAAjzx111-dsh-douyin-agent` | `https://github.com/AAAjzx111/dsh-douyin-agent` | `0c6a9a9` (2026-11-11) | 55 files / 13,591 lines | ESM (`47 .mjs`), Playwright + Python Whisper (`4 .py`), pkg `dsh-douyin-agent-plus@1.4.9` | ✅ 根 `LICENSE` 保留 **MIT** (`LockyBee and contributors`)，`package.json` 致谢 `dafeiyu1314520` | 与 `P3-04J` 重合（实证还原真实分叉差异） · C 组 |

#### B. 既有 22 个历史参考仓明细（均在 `<reference-clones>/`）

| 目录名 | GitHub URL | HEAD & 日期 | 代码规模（源文件/总行） | 技术栈 | 真实 LICENSE 核查 | 状态与本轮归类 |
| --- | --- | --- | --- | --- | --- | --- |
| `Dsh_douyin` | `newbeejmc/Dsh_douyin` | `7cda982` (2026-11-06) | 51 files / 47,054 lines | JS/Py | ⛔ **UNLICENSED (无 LICENSE) + vendor GPL-3.0** | 红线禁用，仅思想 |
| `dsh-live` | `fore-vip/dsh-live` | `627a12c` (2026-08-27) | 7 files / 2,983 lines | JS | ⛔ **UNLICENSED**（虚假模拟指标样本） | 红线禁用，反面教材 |
| `aboutme-pets` | `hunmer/aboutme-pets` | `df864c0` (2026-11-19) | 20 files / 5,476 lines | Py/JS + WebP/m4a | ⚠️ 根无 LICENSE；**素材 CC BY-NC-SA 4.0**；`Transparent-Video-Maker` MIT | 已随包直入（DEV_ONLY） |
| `crosspet` | `lokicorvus/crosspet` | `5069143` (2026-11-24) | 195 files / 38,041 lines | JS/CS/Py/Swift | ✅ 代码 **MIT**；`characters/` **CC BY-NC-SA 4.0**；字体 OFL 1.1 | 已随包全量合法导入（DEV_ONLY） |
| `dsh-pet` | `PC2005-cloud/dsh-pet` | `fb38ce6` (2026-11-17) | 727 files / 110,857 lines | TS/JS/Py/WebM | ✅ 代码 **MIT**；大肥鱼 114 WebM **CC BY-NC-SA 4.0** | 核心桌宠参考 & DEV_ONLY 资产源 |
| `dsh-desktop-petbox` | `HoppoChan0721/dsh-desktop-petbox` | `14980d3` (2026-11-14) | 65 files / 14,869 lines | JS/MJS/HTML | ✅ **MIT** | Live2D 参数单出口参照 |
| `agent-pet` | `xiangking/agent-pet` | `de49036` (2026-06-18) | 15 files / 4,466 lines | Rust (Tauri)/JS | ✅ **MIT** | CLI 事件监视状态机参照 |
| `deepseek-harness` | `deepseek-ai/deepseek-harness` | `4b399c39a6` (2026-11-22) | 8,670 files / 1,812,834 lines | TS/TSX | ✅ **MIT** + 子包 BSD-3/Apache-2.0 | Harness/插件事件溯源基座 |
| `t3code` | `pingdotgg/t3code` | `1425613b` (2026-11-21) | 7,610 files / 2,459,378 lines（不含 `.repos/`） | TS/TSX/Swift/H | ✅ **MIT** + 子包 Apache-2.0 | ACP/多端控制平面参照 |
| `magpie` | `yetone/magpie` | `203dd65` (2026-11-26) | 9,366 files / 1,972,394 lines | Go/CJS/JS | ✅ **MIT** + `third_party` | 网关四协议互译/额度/UI 参照 |
| `FeiyuOS` | `hedykan/FeiyuOS` | `b95c1a3` (2026-11-14) | 293 files / 86,973 lines | C++/Lua/Py | ✅ 代码 **MIT**；`assets/boot|mascot` 非 MIT | 权限审批状态机与资源 URI 参照 |
| `deepseek-superagent-feiyu-os` | `YeStarOne/deepseek-superagent-feiyu-os` | `a8891b1` (2026-11-26) | 2 files / 249 lines + 文档 | Py/Docs | ✅ 代码 **MIT** / 文档 CC-BY-4.0 | `AGENTS.md` 门禁方法论源 |
| `feiyuos-memory-graph` | `YeStarOne/feiyuos-memory-graph` | `2c580f3` (2026-11-08) | 25 files / 5,913 lines | JS/HTML | ✅ **MIT** | `memory-graph` 原型源 |
| `feiyuos-pc-body` | `YeStarOne/feiyuos-pc-body` | `ed02187` (2026-11-10) | 6 files / 4,610 lines | Py/JS | ✅ **MIT** | 安全模板与双投递参考 |
| `feiyuos-stardew-ai-farmer` | `YeStarOne/feiyuos-stardew-ai-farmer` | `e58e70c` (2026-11-23) | 56 files / 15,032 lines | MJS/Py/C# | ✅ **MIT** | 星露谷背包救援/地标守护参考 |
| `dsh-stardew-blind-whale-farmer` | `Darianliu23/dsh-stardew-blind-whale-farmer` | `e2c53d3` (2026-11-21) | 61 files / 27,469 lines (**dirty:2**) | C#/MJS/JS | ✅ **MIT** | 星露谷 MCP 核心模组源 |
| `junimo-mcp` | `mlkgrnt/Junimo-MCP` | `717218b` (2026-11-05) | 20 files / 7,823 lines | OCaml/Py | ✅ **MIT** | 星露谷第二参考（测试与回执纪律） |
| `dsh-live-studio` | `XiaoZheBrother/dsh-live-studio` | `8483163` (2026-11-15) | 37 files / 2,855 lines | Py/MJS/JS | ✅ **MIT** + `NOTICE.md` | Live2D 三工具/回环渲染安全参照 |
| `dsh-livestream` | `luckui/dsh-livestream` | `6c2f405` (2026-10-28) | 97 files / 17,667 lines | TS/TSX | ✅ 代码 **MIT**；`dafeiyu/` **CC BY-NC-SA 4.0** | 直播三级注意力与下播总结源 |
| `dsh-video-storyboard` | `SAOS-3624/dsh-video-storyboard` | `fa4477c` (2026-11-25) | 138 files / 31,802 lines | JS/MJS/Py | ✅ **Apache-2.0** + `NOTICE` | 切片预算与拼图（需保留 NOTICE） |
| `dsh-fish` | `ssamurias/dsh-fish` | `c5aea79` (2026-11-25) | 420 files / 145,778 lines | MJS/JS/TS | ✅ **MIT** | `live-stream-hub/guard.ts` 参考源 |
| `dsh-plugin-yushe` | `yuna78/dsh-plugin-yushe` | `d0e6108` (2026-11-20) | 121 files / 22,012 lines | JS/MJS | ✅ **MIT** + `plugin/NOTICE` | `plugin-kit` `defineTool`/三层思想源 |

---

## 二、本仓当前基线与已拍板边界（对照标尺）

根据本轮实读 `AGENTS.md`、`docs/v2/ARCHITECTURE.md`、`docs/v2/PRODUCT-REQUIREMENTS.md`、`docs/v2/CURRENT.md`、`docs/v2/TRACEABILITY.md`、`docs/v2/EVALUATION.md` 及源码，鲸屿当前进度与已拍板边界如下：

1. **已建立的 V2 底座（P0–P2 核心已通，P3 在推进）**：
   - `packages/shared-protocol`（Zod v4 单点契约 → TS/JSON Schema/Pydantic）、`packages/runtime-core`（微内核、`ComputerUseLease` + macOS `CGEvent` 真机注入）、`packages/local-store`（统一 `node:sqlite` + 友谊小本子）。
   - `packages/character-core`（12 域 `CharacterCore`、`LifeRuntime`、`SocialRuntime`、`SocialBrowseExecutor`、`ContentUnderstandingPipeline`、`InterestSink`）+ `packages/memory-graph`（五类记忆 JSONL 图谱、2-gram+2 跳、30 天半衰期、级联真删除）。
   - `packages/game-bridge-mcp` + `tools/guide-forager`（AI-First 无硬编码规则树 `PausedBrainPlanner`、从 0 自动建档与联机房主 `[REAL-DEVICE]` 验证通过）。
   - `packages/pet-renderer` + `packages/voice-runtime`（VP9-Alpha 114 WebM + CrossPet/aboutme 随包导入；说话确定走「MiMo 开发期主线 + 长期商业授权 TTS」，放弃本地自托管说话；唱歌维持 ADR-005 SVC 优先）。
   - `rabbitfish` 分支 item #16（`apps/desktop-host/src/main/cdp-browser-engine.ts` + `douyin-page-reader.ts` + `packages/character-core/src/social-douyin.ts`）：真 Chrome + 专用持久 profile (`persisted` 隔离目录) + CDP WebSocket 只读 L1 已落地，已具备 `SingletonLock` 悬空修复与脱敏 Cookie（仅读名称、不传 value），不绕验证码、不做 stealth、不伪造 UA、不调私参签名。
2. **本轮核实出的当前真实短板（正好决定要吸收什么）**：
   - **LifeRuntime 主动性过弱**：`packages/character-core/src/life-runtime.ts:210-235` 目前只靠 `evaluateSchedule()` 做静态时间槽推荐，缺少零成本随机采样自主唤醒、外部事件与作息冲突优先级队列，也缺少**外发公域内容的独立无工具审查闸门**。
   - **MemorySystem & Profile 成长缺少防污染硬度**：`packages/character-core/src/profile-stores.ts:108-142` 的 `evolveTrait()` 单次调用即直接改写特征值；`memory-graph/src/store.ts` 已做好半衰期、2 跳与消毒，但仍缺少**元记忆自污染抑制**（避免把“我记得我说过……”误存新事实）、**多通道记忆想起可解释因（`why_recalled`）**、**冷区低保真降级隔离**与**易过期能力声明免锁**。
   - **攻略知识库缺乏证据编译能力**：`packages/game-bridge-mcp/src/guide-library.ts` 仅做 Markdown 解析与游戏版本/Mod 降权，没有像 `Envoy` 那样把外部图文证据切分成带 `evidence_id + source_revision` 的知识单元并编译成受控 `SKILL.md`。
   - **item #16 抖音 CDP 真 Chrome 实战防坑不足**：`cdp-browser-engine.ts:778-788` 启动参数未禁止 Chromium 后台窗口渲染/定时器节流，`Page.navigate` 后缺少 URL 防 `about:blank` 强校，页面解析未覆盖 `data-e2e` 降级选择器矩阵与 `?modal_id=` 直达细节。

---

## 三、A 组深度源码解剖：数字生命、灵魂、生活循环与 Agent 框架

### 3.1 `AlexisVon/dsh-living` (`12f4f82`, ✅ MIT, 35,233 lines) — 同源数字生命最优参照

`dsh-living` 在 `docs/ARCHITECTURE.md:13-35` 明言是以干净 MIT 独立重写的数字生命单核心框架，把「活着、记忆、人格、插件、公域审查」全部做在 `packages/core/` 内，与鲸屿 `CharacterCore` + `LifeRuntime` + `MemorySystem` 高度同构。

| 核心机制 | 精确源码坐标 | 真实实现细节（非文档描述） | 相对鲸屿当前实现的优劣与可借鉴点 |
| --- | --- | --- | --- |
| **正态网格零成本自主唤醒** | `packages/core/lib/clock.mjs:10-36, 140-406` | 每小时划分为 10/20/30/40/60 分钟网格，每格取 30s/60s 采样点；依据 `hot`（高活跃）/ `cold`（低活跃）/ `normal` 时域给 5 档高斯标准差 `σ`，以 **60% 正态概率 + 40% 洗牌兜底**抽中下次唤醒时间，0 模型开销。`tick()` (`:172-302`) 严格遵守 `ring` 外部事件 > 固定日程 > 夜睡禁扰 > 自动网格优先级；当前正在跑的一轮若撞上自动采样点直接作废不积压 (`missedAuto`)，绝不雪崩补发。 | **显著优于** `life-runtime.ts:210-235` 的静态时槽推荐！可直接改造入 `LifeRuntime`，让小鲸无需额外模型轮询就能自然“偶尔冒出来说句话/刷两眼”，且在 `running` 态不堆积补跑。 |
| **L2–L5 分层与 R1–R8 想起通道** | `packages/core/lib/layers.mjs:10-63` & `recall.mjs:10-233` | 划分 L2（情节）/ L3（语义）/ L4（程序性经验）/ L5（自传永久）。`decayedStrength` 随被回忆次数对数衰减 (`log` 减速)。`recall.mjs` 并行跑 **8 条想起通道**：`R1` 线索扩散、`R2` 情绪余弦同频、`R3` 近因/首因、`R4` 显著度插队、`R5` 人物场景绑定、`R6` 时间链前后溯、`R7` 自发闪回、`R8` 舌尖效应（`partialHits` 只吐模糊轮廓）。硬规矩：**`why.length === 0`（无通道命中）不允许浮现任何记忆**。 | 鲸屿 `memory-graph/store.ts` 已做情绪同频和 30 天半衰期，但缺少 **`R8` 舌尖模糊命中** 与 **`why_recalled` 显式归因**；`R4/R6/R7` 可直接补强 `memory-graph` 检索结果标注，杜绝“莫名其妙编回忆”。 |
| **元记忆防毒 & 冷区降级 & 受控关系** | `packages/core/lib/memory.mjs:17-47, 139-278` & `memory-extract.mjs:13-177` | `META_HINTS` 过滤「我在想/我记得」类自我内省碎片防止元记忆自污染；冷区记录强制压缩到 **≤20 字低保真线索**并注入约束标签「仅作曾发生过此事的弱线索，**不得作为当前行动依据**」；图谱只做 `G1` 一跳扩散；关系抽取强制夹紧 `tsStart/tsEnd` 与 **13 个受控关系词表**。 | 对照 `memory-extract` 的 13 词表和冷区“不得作行动依据”标签，直接治好早期印象老化后被大模型当当前真事实用的幻觉。 |
| **S/A/B 动态笔记本与 Prefix Cache 稳定分隔** | `packages/core/lib/notes.mjs:3-142` & `round.mjs:13-57` & `persona.mjs:75-120` | 动态笔记拆三区：**S 区持久 ≤50 条（每条 ≤40 字），仅 `core ≤8` 条注入全文、其余只注关键词索引**；A 区今日（≤10 条）、B 区昨日（≤10 条，第 2 次夜睡过期）。`round.mjs` 拼装时将「静态规范 + 人格 `charter` + `self` + S 笔记」放头部保 KV Prefix Cache，时间/环境/对话逐行贴 `[主人]` vs `[外部·仅数据]` 信任边界。`persona.mjs` 区分人类只读 `charter` 与每晚 diff 重写的 `self` 与追加 `journal`。此外 `round.mjs` 原生自带上下文超限前触发 `rest`（`HANDOFF_PROMPT`）无损接续而**不误触发夜睡整日结算**。 | **极其重要**：鲸屿 `CharacterCore` 已有身份与记忆，但缺少清晰的 **Prefix Cache 头尾分层**、**`[主人]` vs `[外部·仅数据]` 逐条行信任标记** 以及 **上下文交接不触发“夜睡结算”的隔离开关**，可直接引入 `persona-brain`。 |
| **WorldGem 插件与公域无工具二段审查** | `packages/core/lib/gems.mjs:8-159`, `runtime.mjs:165-225`, `audit.mjs:7-206`, `adjudicator.mjs:7-54` | `WorldGem` 通过 `worldgem.json` 声明 `ring`（唤醒主角）/`silent`（静默事件）策略、`trusted` 独立提权、etiquette 与 `failure_hints` 进 prelude；`gemHealth` 触发 **1 分钟 → 5 分钟 → 30 分钟** 阶梯熔断。外发去 `public`/`group` 之前，必经 `audit.mjs`（规则 R01–R05：反泄露隐私/越权承诺/外部指令服从等）并送入 **一次性无工具小模型 `adjudicator`** 做 **Fail-Closed 二段审查**。 | 鲸屿 `SocialRuntime`（将来做 L2/L3 与直播发话）目前**缺少独立无工具外发审查员 `adjudicator`**；这个“主脑写稿 → 无工具旁路审查员 Fail-Closed 拦截”模式几乎零侵入且极适合直接落进 `@workbench/persona-brain` 或 `SocialRuntime`。 |

> **小结（`dsh-living` 短板）**：全仓专注生命核与记忆，**完全没有**桌宠 GUI/WebM 渲染、星露谷等游戏 MCP 执行体、音频/唱歌舞台以及真实浏览器 CDP 执行体（只留通用 Gem 契约）。

---

### 3.2 `Britneycode/dsh-fish-soul` (`ae8fe8b`, ⛔ 根无 `LICENSE` 文件，85,379 lines) — “冰与火”分裂的灵魂巨仓

`P3-04J` 此前只看了该仓抖音脚本部分，将其标记为踩红线；本轮深挖其全仓 355 个文件后发现该仓其实分裂为两个截然不同的世界：**非抖音灵魂引擎极其扎实（全仓 ~70%），而抖音渠道则踩了伪造签名红线**。

#### A. 高价值可借鉴设计思路（⚠️ 因根缺 LICENSE，只能重写思想，绝不复制代码）
1. **可证伪、跨时间跨通道缓慢成长闸门（`lib/growth.js:12-128`）**：
   - 任何新倾向/习惯观察先落 `candidate`，必须满足硬阈值——**「多通道累计 ≥3 次且跨 ≥2 天」或「单通道累计 ≥5 次且跨 ≥3 天」**才允许晋升 `active` 并带每轮最多注入 5 条上限。
   - 同时内置 `BAD_PATTERNS` 正则拦截“我是 AI/人工智能/助手/服务态度”人格崩塌特征，`45 天`无新证据自动过期淘汰，且支持 `contradicts` 反证直接把既有 `active` 特征打回消退。
   - **对比鲸屿**：`packages/character-core/src/profile-stores.ts:108-142` 的 `evolveTrait()` 目前只做单次 delta 更新和上下界夹紧，极易被单次偶发对话“带偏”。引入 `candidate → 跨天多次确认 → active → 45d 衰减 / 反证退场` 四段闸门可根本解决人格被单句洗脑问题。
2. **防情绪横跳与脆弱人群共情护栏（`lib/mood-guard.js:26-69`, `lib/soul-memory.js:118-203`）**：
   - `mood-guard.js` 限制**每天情绪标签切换上限 4 次**，同标签加强仅叠“余温”不耗切换次数；同时注入 `MOOD_STATE_GUARD` 硬约束——当识别到对方处于委屈、难过或情绪脆弱表达时，**禁止因主角当前挂着“烦躁/闷”情绪就冷淡或敷衍**。
   - `soul-memory.js` 的 `markMoodSaid()` 确保**每个新产生的长期心情只主动流露/提一次**，防止每轮车轱辘“我今天好烦”；`lockedFields` 显式保护人类手改的昵称/关系/印象字段不被后台自动总结覆盖。
3. **防记忆毒丸三大铁律（`lib/soul-memory.js:613-665, 712-733`）**：
   - **`#75` 禁把虚构日程当真事**：主动聊天时模型编的“待会去买奶茶/等下去看书”或当下想法绝不写入长期 `self` 记忆（否则第二天真以为自己去过）。
   - **`#76` 易过期工具能力声明隔离与免锁定**：类似“我没有识图功能/我不会打语音/某功能还没接”属于版本化临时限制，严禁写入永久人物印象，且豁免 `reinforce` 升 3 星锁定（否则哪怕后期接入了多模态，模型还在背“我瞎的”旧记忆）。
   - **`#167` 绝对日期+星期直给 & 宁漏不混**：所有时间线摘要必须带完整 `YYYY-MM-DD 周几`（防止大模型自己推算日期错乱）；多人同时提及第三者时，若无现场归属把握**宁可漏记，绝不把不在场第三者经历安到当前对话人头上**。
4. **安全基建两件硬核防御（`lib/safe-download.js:9-171`, `lib/worldinfo.js:65-93`, `lib/time-awareness.js:25-70`）**：
   - `safe-download.js`：解析远端 URL 后**校验所有解析出的 IPv4 非私网段 + 用 Socket 直连已校验 IP 并在 TLS 上保留原始 `servername` (SNI)**（彻底防 DNS Rebinding SSRF），并在跨站重定向时自动剥离 `Authorization`/`Cookie`。
   - `worldinfo.js`：匹配用户/外部导入世界书正则时使用 `vm.runInContext(..., { timeout: 30 })` 限时 30ms 执行，触发超时记录 `badRegex` 熔断（对比：鲸屿 `packages/persona-brain/src/persona-engine.ts:68-74` 当前使用 `new RegExp` / 词表做雷区反射，若将来加载外部创作或社区世界书正则存在 ReDoS 隐患）。
   - `time-awareness.js`：`idleDuration` 严格从“对方最后开口”算起（不因角色自己发了一条广播就归零），且放入每次对话末尾瞬态区，防止弄脏前缀 KV Cache。

#### B. 必须严厉禁止的抖音部分（确认红线）
- `lib/channels/douyin-http.js` 引入 `lib/vendor/douyin-bogus.js`（MIT 自 `zhinjs/douyin-im`）在本地生成平台反爬签名参数（`X-Bogus` / `a_bogus`）直发 HTTP 请求，同时另行内嵌了 `lib/channels/vendor/douyin-bridge` 用于浏览器通道。**伪造签名逆向参数直接违背鲸屿 R3/R4 绝对红线，全套抖音 HTTP 模块禁用**。
- 许可警示：`package.json` 写 MIT 但仓库根目录缺少独立 `LICENSE` 法律文本；按照 Gate 2 从严原则，整个仓库**不移植一行业务源码**，只提炼上述 4 项架构级防毒丸/安全思想由鲸屿原创 TypeScript 实现。

---

### 3.3 `alexbu512/milancat-bot` (`83aa77a`, ✅ MIT, 9,410 lines) — 多员工组织看板插件（与鲸屿正交）

经实读 `index.js:1-225`、`lib/engine.js:1-400`、`lib/activity.js:1-202`、`lib/memory.js:1-240`、`lib/skill.js:1-58` 全部核心文件证实：
- **真实定位**：一个名为 `@local/dsh-bot` 的 DSH 插件，模拟“AI 创业公司老板带多个部门员工（文件夹即员工，含飞书群路由与共享团队工作区 `团队/`）”，并非单核伴随数字生命。
- **可拆解的小颗粒工程技巧**：
  1. `lib/engine.js:185-392`：**路径写越界检查（`insideDir`）+ 出网命令启发式分类闸门（`egressSend`）**——本地 `127.0.0.1` CDP/只读 HTTP GET 自动放行；命中 `curl -X POST`、`ssh`、`scp`、`git push`、`python requests.post` 等外发写动作时拦截并要求一次性审批白名单。这一区分思路可细化鲸屿 `AgentHarness`（`V2-P2-02` `SkillRegistry`/CLI 执行）的 P2–P4 命令审批边界。
  2. `lib/activity.js:15-202`：按天分片追加 JSONL 工具调用轨（`YYYY-MM-DD.jsonl`），内置 `describeArgs()` 提取关键参数摘要避免整包 payload 撑爆日志。
  3. `lib/memory.js:20-240`：极简 120 条 JSON 记忆卡 + 中文 2-gram 滑窗检索（鲸屿 `memory-graph` 已有更完善的 2-gram + 2 跳图扩展 + 30d 半衰期，无需反用此简版）。

---

## 四、B 组深度源码解剖：`regrevia/Envoy` 主仓（✅ 全仓 Apache-2.0 + `NOTICE`）

`P3-04J` 此前只看了 `integrations/dsh/envoy-dsh`（10KB，3 个小文件），误把 Envoy 仅当作“只读通用网页抓取小胶水”。本轮深挖其 **142,155 行（346 个 Python 文件）主体仓库**后，发现它是一个结构严谨、自带**证据溯源 → 知识提纯 → Skill 编译**闭环的开源信息工程底座（全仓根/子包统一 Apache-2.0 + `NOTICE`）。

### 4.1 主仓可高价值吸收的四大核心模块

1. **证据契约与分段精读 MCP 工具集（`envoy-core/src/envoy_core/schemas/read_v1.py` & `envoy-cli/src/envoy_cli/mcp.py`）**：
   - 对长图文、PDF、视频、本地路径输出统一 `SourceDocument` + `material_id` + 精确多模态定位符（`VideoTimestampRange [mm:ss]`、`PdfLocator`、`ImageRegionLocator`），对于未完整读取的内容诚实标记 `partial` + `gaps` 列表而非硬拼假全文。
2. **⭐ 零 LLM 依赖的证据绑定知识单元引擎与 Skill 编译器（`knowledge_units.py` 979 行 + `skill_compiler.py` 265 行）**：
   - 知识单元严格按 **`candidate → verified → promoted → archived`** 四态流转，每一条均强绑定 `material_id + evidence_id + locator + 64位 source_revision`；一旦底层原文内容或定位修改，`edit` 即自动回退状态为 `candidate` 并保留版本快照，彻底杜绝“攻略过期了却还顶着已验证标签”。
   - `skill_compiler.py` 根据知识单元之间的 `depends_on` / `composed_of` 有向无环图，将通过校验的知识单元自动编排打包成确定性、可审计的 `SKILL.md` 包。
   - **对鲸屿的直接价值**：鲸屿的 `tools/guide-forager/src/forage.ts` 已把星露谷 Wiki 拉成本地 Markdown，`packages/game-bridge-mcp/src/guide-library.ts` 能识别游戏版本/Mod 兼容降权，但仍缺乏 **“原文证据块锚点 → 知识单元置信度 → 自动退回重验 → 编译 Skill 包”** 这层骨架！按 Apache-2.0（保留 `NOTICE`）改造或重写这套状态机进 `guide-library.ts`，能让 `REQ-GAME-03`（攻略学习闭环）提升一个维度。
3. **Fake-IP TUN 代理环境 SSRF 误杀修复（`envoy-cli/src/envoy_cli/netpolicy.py:103-138`）**：
   - 国内开发者电脑常开 Clash/Surge TUN Fake-IP 模式（`198.18.0.0/15`）。传统 SSRF 防护遇到 `198.18.x.x` 会当作保留内网 IP 直接拦死！Envoy 清晰区分「用户字面量输入的 IP 绝不允许落在私网/保留段」与「真实域名经系统 DNS 解析出的 IP 命中 `198.18.0.0/15`（或 `ENVOY_FAKE_IP_RANGES`）允许放行」。
   - **直接修复鲸屿风险**：`guide-forager`、未来联网浏览器或工具拉取模块如开私网校验，引入此判别规则可免去所有开代理用户的莫名连接失败。
4. **合规 L1 去遮罩与异步扫码状态交接（`browser.py:48-293` & `auth_session.py:136-300`）**：
   - `browser.py` 内置三段非常克制的 DOM 清理脚本：`_DISMISS_LOGIN_OVERLAY_SCRIPT`（关闭未登录时的非阻断引导弹窗）、`_GENERIC_OVERLAY_SCRIPT`（关闭 cookie/同意浮层并解除被锁死的 `body { overflow: hidden }`）、`_EXPAND_SCRIPT`（同源自动点击“展开全文”）。均不绕任何验证码或登录墙！
   - `auth_session.py` 将长耗时扫码登录拆进后台进程，仅通过写 `session.json` + QR 图片路径做非阻塞交接，防止卡死 MCP 主通信超时。

### 4.2 `integrations/dsh/envoy-dsh` 再核验（`index.js` & `launch.cjs`）
- 与 `P3-04J` 结论一致，确认为 3 个小文件组成的 DSH Cordis 薄桥接层，不耦合其插件接口。
- **新提取出的实操小细节（`launch.cjs:56-160`）**：GUI/Electron 进程启动子 CLI 时（尤其 macOS `.app` 双击打开）常丢失 shell PATH，导致找不到 `uv` / `envoy` / `codex`。`launch.cjs` 显式探测 `~/.local/bin`、`~/.cargo/bin`、`/opt/homebrew/bin`、`%LocalAppData%\Programs`，并在 Windows 下对 `.cmd` / `.bat` 后缀自动转 `cmd.exe /c` 拉起。此细节可直接加固鲸屿 `packages/agent-harness`（`REQ-EXT-01`）与 `services/audio-ai-worker` 的 CLI 拉起鲁棒性。

---

## 五、C 组抖音 5 仓横向源码深挖与 item #16 对标

### 5.1 横向对比总矩阵

| 仓库 | 连接与执行机制 | 写操作与风控红线核实 | 工程成熟度 | 可复用核心价值 |
| --- | --- | --- | --- | --- |
| **`dsh-douyin-bridge`**<br>(`pcmxiao`, MIT, 12.4k 行) | 原生启动或直连真 Chrome CDP (`ws`)；不注入 `AutomationControlled`；不传假 UA | 含主动浏览/评论/私信/发图工具；未做反检测伪装、不绕验证码（遇障碍停止/报状态） | **高实战度**：带血泪史 `PITFALLS.md`，纯 Node ESM 轻依赖 | **★★★★★ 与 item #16 最贴合**：后台降频启动参数、`location.href` 校验、`?modal_id=`、DOM `@`/昵称分离、`data-e2e` 选择器表 |
| **`dsh-douyin-studio`**<br>(`dbbdbdhdbxb-design`, MIT, 29.5k 行) | 原生 CDP (`node` 原生 `WebSocket`) + 本地 HTTP UI；独立 CDP 会话类 `CdpSession` | 含全套发评/私信/创作者发布；未伪装指纹，自带**文件级物理停损闸 `KILL` + 指数风控冷却** | **中上工程度**：接口工整、带 4 道前筛与发布实战注释 | **★★★★**：`KILL` 总闸、指数风控冷却、4 道低成本前筛、创作者中心 `^https://creator...` 前锚定与 `\u200b` 坑 |
| **`dsh_douyin_tools`**<br>(`kdcadmin`, MIT, 14.4k 行) | Python Playwright (`channel="chrome"`) + 持久化或独立 CDP 端口 (`9333`) | ⛔ **踩红线**：带 `--disable-blink-features=AutomationControlled` + 硬编码假 Chrome 155 UA + 默认复扫本机常用 Chrome profile + 页面内 `fetch('/aweme/v1/web/comment/list/')` | **中等脚本聚合体**：单文件 4,769 行巨型 `mcp_server.py` + 4,714 行 `index.js` | **★★☆ 仅挑小技巧**：`.need-captcha` 切有头人手过滑块、`occ:` 虚拟列表序号防漂移、`statistics.comment_count` 区分 |
| **`LockyBee/dsh-douyin-agent`**<br>(`LockyBee`, MIT, v1.4.7, 40.5k 行) | Playwright MCP/CLI 复用专用 Edge 持久化 profile | 带写操作（评论/分享/点赞），未绕验证码；但整体安全审计边界极严密 | **★★★★★ 工程标杆**：带 Electron 桌面壳、全套单测与验证文档 | **★★★★ 工程治理模板**：点击前 SHA-256 `receipt-baseline`、隐私有向图 `memory-policy`、多字段归一化 `usage-ledger`、文件锁 |
| **`AAAjzx111/dsh-douyin-agent`**<br>(`AAAjzx111`, MIT, v1.4.9, 13.6k 行) | 同源自 `dafeiyu1314520@1.4.7`，专攻私信+续火花+看视频定制 | 加回了更激进的**自动评论回复 `autonomous-replies.mjs`、开机自启私信/续火花**；砍掉上游全部单元测试与隐私/收据审计 | **个人定制精简分支**：硬编码 `D:\Deep\diary\肥鱼日记.md` | **★☆ 仅2个功能可参考**：Canvas 浏览器内拼图 `frame-composite.mjs` 与分段断点录制 `capture-session.mjs`，整仓舍弃 |

### 5.2 逐仓源码核心事实解剖

#### ① `pcmxiao/dsh-douyin-bridge` (`6e4bb7f`, ✅ MIT) — 对 item #16 帮助最大的实战宝库
- **独立主仓 vs `dsh-fish-soul` 嵌入版关系**：`diff -rq` 证实 `dsh-fish-soul/lib/channels/vendor/douyin-bridge` 是从 `dsh-douyin-bridge` 早期切出并改写（`browser.mjs`, `douyin-api.mjs`, `media.mjs`, `pb.mjs` 均已分叉，且 `dsh-fish-soul` 删掉了 `bridge.mjs`/`comment.mjs`/`douyin.mjs`/`stickers.mjs` 拆成 `douyin-dm`/`douyin-comment`/`douyin-detail`）。原生干净独立版就在 `pcmxiao/dsh-douyin-bridge`。
- **实测级关键代码坐标**：
  1. `lib/browser.mjs:11-35`：启动参数彻底干净，**不带 `AutomationControlled` 隐藏**，但**必带三件防后台冻结开关**：`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-background-timer-throttling`；并加 `Runtime.evaluate` / `Page.navigate` 后强制读回校验 `location.href` 不停留在 `about:blank`。
  2. `lib/selectors.mjs:42-165` + `PITFALLS.md`：维护实测过的多级 `data-e2e` 选择器回退表，包含私信入口 (`im-entry`)、私信弹窗 (`im-dialog`)、会话项 (`conversation-item`)、消息正文 (`msg-item-content`)、搜索框 (`searchbar-input`)、侧栏导航 (`douyin-navigation`)，并将 `PITFALLS.md` 直接沉淀为踩坑经验文档。
  3. `lib/comment.mjs:27-35`：总结出打开单条视频详情的三路降级策略，确认 **`https://www.douyin.com/?modal_id=<id>`** 最稳（比直跳 `/video/<id>` 更少被强行重定向到 `/jingxuan` 精选信息流）。
  4. `lib/douyin.mjs:49-231`：不用脆弱的哈希 CSS 类名提取评论/消息发送人，而是遍历 DOM 叶节点并用 **`fontSize` + `y` 坐标底部定位** 区分 `@提及` 与作者昵称，适配新版 DOM 改版能力极强。
  5. `lib/state.mjs:1-237`：基于文件原子操作 + 水位去重，短小干净。

#### ② `dbbdbdhdbxb-design/dsh-douyin-studio` (`43531b6`, ✅ MIT) — 风控停损与零成本过滤标杆
- **核心架构**：纯原生 Node 24 全局 `WebSocket` 实现 CDP 客户端 `lib/cdp.mjs` & `lib/publish-cdp.mjs`（记录过 `ws` 包在不同插件目录解析报错和 WHATWG `onmessage` 混用等坑）。
- **最值得吸收的四处源码细节**：
  1. **物理级应急停损文件闸（`lib/killswitch.mjs:1-92`）**：在插件家目录检测物理文件 `KILL` 存在与否；只阻断一切写动作（发评/私信/发布），**所有只读动作（`status`/`inbox`/`feed`）永远放行——"出事时更需要看现场"**。人也可直接在文件管理器建文件 0 秒止血。
  2. **指数风控冷却（`lib/risk.mjs:15-78`）**：识别平台码 `352, 412, 2154, 3002` 与正则 `RISK_RE` 后记录 `risk.json`，按 **30 → 60 → 120 → 封顶 360 分钟**指数加倍静默写操作，同样放行只读接口且 `GET /risk` 严格无写副作用。
  3. **低成本 4 道前置过滤器（`lib/feed.mjs:9-117`）**：在把视频交给任何昂贵 VLM/LLM 之前，用 DOM/本地数据依次筛掉「时长越界」「`is_ad` 广告标记」「allow/block 关键词」「`feed-seen` 已看过列表」，显著节省 Token。
  4. **`lib/watch.mjs:9-151` & `lib/publish-steps.mjs:96-111`**：仅在调用显式传入 `frames: true` 时抽取分镜图，没直链/抽不到帧绝不假装看过；发布页（供远期 L2 草稿）揭示了创作者中心 tab 匹配必须用 `^https:\/\/creator\.douyin\.com\/` 前锚定（否则客服弹窗 URL 也会 `includes` 误中）以及空编辑器自带 `\u200b`（需 `Ctrl+A` 清空）和末尾 `#话题` 后必须补空格生成标签胶囊的真实细节。

#### ③ `kdcadmin/dsh_douyin_tools` (`5c3a644`, ✅ MIT) — 红线混杂的实用脚本集合
- **必须拒绝的踩线实现**：
  - `vendor/douyin-mcp/mcp_server.py:324, 471` 注入 `--disable-blink-features=AutomationControlled` 且硬编码过时桌面 UA `Chrome/155.0.0.0`（`:87-90`）；
  - `index.js:1562-1597` 的 `chromeUserDataDir()` 诱导接管用户**默认个人日常 Chrome Profile**，违背鲸屿 `Per-Character Browser Profile` 隔离原则；
  - `mcp_server.py:1391-1452` 通过浏览器页内 `fetch('/aweme/v1/web/comment/list/...')` 直接拉未公开内部 JSON 接口，属于典型非公开 API 依赖。
- **可剥离借鉴的三点工程经验**：
  1. **人机交接切换有头过码（`mcp_server.py:805-837` & `index.js:573-601`）**：检测到页面出现真实可见（`width>120, height>120, display!=='none'`，排除了抖音常驻隐藏 verify iframe）验证码 iframe 后写 `.need-captcha` 标志，自动通知重启为带界面窗口让人类手动滑完，过完自动删标（思路对齐鲸屿 `REQ-SEC-02` `awaiting_human`，其**排除隐藏占位 iframe 的尺寸/透明度校验代码**值得 `douyin-page-reader.ts` 参考）。
  2. **虚拟列表序号漂移去重（`index.js:2471-2479`）**：评论/私信虚拟滚动时页面 `data-index`（`idx:0`）总指代最新一行，用它当主键会导致回复新消息后再次失灵；改用 **`occ:${direction}:${normTextKey}:${occurrenceCount}`** 统计本次窗口内第 N 次同向出现来构造稳定临时指纹。
  3. **一级评论数真值口径（`mcp_server.py:1324-1339`）**：实测确认列表 `total` 与图标 `feed-comment-icon` 含楼中楼，只有详情里的 `statistics.comment_count` 才是真实一级评论数，避免少抓楼中楼时误判页面加载失败。

#### ④ `LockyBee/dsh-douyin-agent` (`9c49833`, v1.4.7) vs ⑤ `AAAjzx111/dsh-douyin-agent` (`0c6a9a9`, v1.4.9 `dsh-douyin-agent-plus`)
- **真实谱系对比**：两仓都在 MIT 下承接自 `dafeiyu1314520/dsh-douyin-agent@1.4.7`，但演化方向完全背道而驰：
  - **LockyBee（`263 文件`）加了极重的可信工程防线（鲸屿重点继续参照）**：
    - `receipt-baseline.mjs:15-100`：在点击发送/评论前必须落盘 `fsync` 锁定 `operationId + videoId + knownIds + textSha256 + 整包 SHA-256 digest`，后续回读核对严格使用同一基线，杜绝“回读不到就盲重发”。
    - `memory-policy.mjs:14-100`：严密的有向 DAG `sourceMemoryRefs` 隐私传染传递检查（私聊衍生内容无论转几跳自动锁定 `internal-reference`，绝不流向群聊或跨会话）。
    - `contact-authorization.mjs:7-54`：用 `conv:<sha256>` + `identityVersion: 2` + `identityBinding` 锁定授权会话，显式禁止仅凭昵称或头像变更后做自动替换匹配。
    - `usage-ledger.mjs:8-49`：多字段兼容归一化 `prompt/completion/cachedTokens`，对未返回用量的接口诚实计入 `unknownRequests`（“不能据此当作零消耗”）。
    - `scheduled-watch.mjs:9-49` & `task-limits.mjs` & `video-limits.mjs`：全程 `wx` 排他锁文件 + 错误脱敏（剥离 `Bearer`、`sk-*` 与 URL query）。
  - **AAAjzx111（`55 文件`）是个人定制极简分支（不建议整仓引入）**：
    - 删去了上述全部 `tests/`、`verification/`、`desktop/`、`receipt-baseline.mjs`、`memory-policy.mjs`、`usage-ledger.mjs`、`contact-authorization.mjs`。
    - 为解决个人自用卡顿，在 `CHANGELOG.md:14-46` 增加了「直跳 `/user/self` 点击关注弹层」「`Browser.setWindowBounds` 防窗口屏幕外误点」「6 分钟暂停自愈」「私信/续火花开机自启」以及自研的 **`capture-session.mjs`**（被私信插队 `hold()` 时只切段不丢帧，最终合并多段进同一个 `videoId` manifest）和 **`frame-composite.mjs`**（在浏览器 Canvas 中把多帧拼成带 `labelHeight` 与右侧点赞栏裁剪 `cropRightPx` 的单张拼图，内带 1.2s 去重）。
    - **硬伤**：`diary-writer.mjs:7-8` 直接硬编码 `D:\Deep\diary\肥鱼日记.md`，且 `autonomous-replies.mjs`、`reply-service.mjs` 主打自动公开评论与私信主动搭讪，风险与架构都不合鲸屿当前阶段。

### 5.3 ⭐ 相对 `P3-04J` 与 `rabbitfish` item #16（`cdp-browser-engine.ts`）的直接改进点

核查过 `rabbitfish` 分支（`feat-douyin-browser-cdp`）的 `apps/desktop-host/src/main/cdp-browser-engine.ts`（第 778-788 行启动参数等），item #16 做得非常合规克制（已做独立持久化目录、`SingletonLock` 悬空链接修复、无 `AutomationControlled`、无假 UA、仅传 Cookie 名），但对比 `dsh-douyin-bridge` 与 `dsh-douyin-studio` 源码，发现 **4 项无需新增风险即可立即落地补强的实战改进**：

| 序号 | item #16 当前缺口 (`rabbitfish`) | 对应参考仓精确依据 | 推荐落地改法（L1 只读完全合规） |
| --- | --- | --- | --- |
| **1** | 启动 Chrome 缺少防后台渲染与定时器冻结参数（`cdp-browser-engine.ts:778-788` 只有 `--no-first-run` 等基础参数） | `dsh-douyin-bridge/lib/browser.mjs:11-35` | 追加三件套：`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-background-timer-throttling`。否则用户切去别的应用或最小化 Chrome 时，Chromium 冻结渲染导致 25s 视频等待必超时。 |
| **2** | `Page.navigate` 后缺少强校验防停留空页；开单视频沿用 `/video/<id>` 易被弹回精选页 | `dsh-douyin-bridge/lib/browser.mjs` & `lib/comment.mjs:27-35` | 导航后立即 `Runtime.evaluate('location.href')` 校验确已离开 `about:blank`；读单条视频优先 `?modal_id=<awemeId>` 路径作为降级/主路补充，减少被强制跳回 `/jingxuan` 的空抓。 |
| **3** | `douyin-page-reader.ts` 选择器与验证码识别尚较基础 | `dsh-douyin-bridge/lib/selectors.mjs:42-165`, `lib/douyin.mjs:49-231` & `dsh_douyin_tools/.../mcp_server.py:818-826` | 吸收 `data-e2e` 稳定选择器回退清单与「可见性 + `rect > 120×120` 过滤常驻隐藏 verify iframe」的真验证码检测，防止常驻隐形元素误报 `CAPTCHA` 中断浏览；引入叶节点字体/坐标分离解析 `@`/作者。 |
| **4** | L1 候选送模型理解前缺少纯规则前筛与低成本物理总闸参考 | `dsh-douyin-studio/lib/feed.mjs:9-117` & `lib/killswitch.mjs` & `lib/risk.mjs` | 在 `SocialBrowseExecutor` / `douyin` 候选源加四道低成本前筛（`is_ad` / 时长 / 关键词 / 已读去重）；未来 L2/L3 加状态文件级应急总闸（只读永远放行、写操作指数退避冷却）。 |

---

## 六、D 组既有 22 个旧参考仓全景回顾与未挖尽价值

按能力域将 `<reference-clones>/` 既有的 22 个老仓与本仓代码及 `docs/THIRD_PARTY_NOTICES.md`、`docs/REFERENCES.md` 交叉对齐：

1. **桌宠表现与素材簇（5 仓）**：
   - `dsh-pet`（MIT 代码 / CC BY-NC-SA 4.0 素材）：**已吸收**双 `<video>` 零黑帧交错渲染、Q 弹碰撞 (`squash.ts`)、多屏区并集 (`display-region.ts`)、余额分档动画 (`emotion-map.ts`) 及 114 个 WebM (`blue-whale-maid/`, `DEV_ONLY`)；**未挖尽**：绿幕转 WebM 标准化质检资产脚本与更细粒度的「睡觉安静模式 ↔ 语音锁 TTL ↔ 鼠标穿透局部透明区」联动边界。
   - `aboutme-pets`（素材 CC BY-NC-SA 4.0）：**已吸收**随包 9 角色 1040 动作解析 (`aboutme-pets.ts`, `spritesheet-renderer.ts`)；**未挖尽**：`Transparent-Video-Maker/`（MIT）可直接用于鲸屿 `Creative Studio` (`V2-P2-07` 后续) 自产 WebM 透明化工具。
   - `crosspet`（代码 MIT / 立绘 CC BY-NC-SA 4.0 / 字体 OFL 1.1）：**已吸收** 30 角色全部合法导入、SVG 姿势特效 (`pose-effects.ts`)、手写字体、`friendship.ts` 10 颗心小本子规则；**未挖尽**：`BIG_JOB_TOOLS` 大活语义分类用于自主工作状态展示。
   - `dsh-desktop-petbox`（MIT）：**尚未充分吸收**！其 854 行 `engine.js` **单出口参数汇聚模式** + `interact.js` **Alpha 剪影防穿透分区** + `mood.js` 纯函数值得在 `V2-P3-07C / V2-P3-08C` 做 VRM 3D / Live2D 真画布渲染时直接参考，避免状态写入四处散落。
   - `agent-pet`（MIT, Rust/Tauri）：**参考即可**（1410 行 `codex_monitor` JSONL 原始事件 → 语义 → 9 态状态机，可用于监控外部 CLI Harness 子任务时驱动桌宠看屏幕动画）。
2. **游戏桥接簇（4 仓，含本地补丁现状）**：
   - `dsh-stardew-blind-whale-farmer`（MIT，**本机含 2 处未提交本地补丁 `+466/-21`**）：**已核心吸收**至 `mods/bwf-patches` 与 `mods/stardew-mcp-mod`；**提醒**：本地 `McpServer.cs` 与 `ModEntry.cs` 仍有尚未整理合入补丁栈的在改现场，绝对不可在未备份前清理参考目录。
   - `junimo-mcp`（MIT, OCaml）：**已参照思想**写入 `docs/REFERENCE-junimo-mcp.md`；**未挖尽**：`mock_smoke`（同一待测目标仅凭 `STARDEW_API_URL` 切换驱动 mock 与真机、零假设断言）与 **`SaveGameInfo` 文件 `mtime` 校验真睡觉存档**可补强 `V2-P3-07` 与 `soak-real`。
   - `feiyuos-stardew-ai-farmer`（MIT）：**已吸收**背包整理救援灵感 (`planner.ts:94`)；**未挖尽**：63 个标准星露谷坐标地标表与 173 动作粒度映射仍可为 AI 空间感知作参考字典。
   - 注：M7/P5 冻结区的泰拉瑞亚与 DST 仅在 `docs/REFERENCE-terrariablind.md` 与 `docs/REFERENCE-dst-ai-companion.md` 收敛过架构，目前单角色阶段保持冻结不解冻。
3. **数字生命、记忆与底座控制面簇（7 仓）**：
   - `feiyuos-memory-graph`（MIT）：**已吸收** JSONL 图谱、半衰期、墓碑压实至 `packages/memory-graph`。
   - `deepseek-superagent-feiyu-os`（代码 MIT / 文档 CC-BY-4.0）& `FeiyuOS`（代码 MIT / 吉祥物非 MIT）：**已吸收** `observe→auto`、`pnpm verify:gate` 四门禁方法论与 `PolicyBroker` URI 权限分级灵感；`FeiyuOS` 的 `out#N` 大输出落盘句柄策略可用于未来高吞吐 MCP 返回截断。
   - `feiyuos-pc-body`（MIT）：看门狗自愈与灾难黑名单机制已被 `runtime-core` `ComputerUseLease` 吸收替代。
   - `deepseek-harness`（MIT, 181 万行）& `t3code`（MIT, 246 万行）& `magpie`（MIT, 197 万行）：**已吸收核心方向**——`plugin-kit` 吸收了 `deepseek-harness` 的 `defineTool` 与事件溯源架构、`agent-harness` 吸收了 `t3code` 的 `ACP v1`、**`model-gateway` 对照 `magpie` 还可在 `REQ-MOD-01` 进一步对齐其四协议工具调用流式互译与隐私脱敏回填**；`t3code` 的移动端远程审核审批架构（`V2-P4` 远程控制原型）极具中长期参考价值。
4. **直播、视频分镜、文本护栏与插件体系簇（6 仓）**：
   - `dsh-livestream`（代码 MIT / `dafeiyu/` CC BY-NC-SA 4.0）& `dsh-live-studio`（MIT）& `dsh-fish`（MIT）& `dsh-plugin-yushe`（MIT）：**已吸收**三级注意力调度、`uid` 合并、`[情绪标记]`、UTF-16 代理对切分 (`guard.ts`) 与 `defineTool` 三层设计。**未挖尽**：`dsh-livestream` 的虚拟模拟观众彩排器可用于完善鲸屿真实测试开播前的直播间压测脚本。
   - `dsh-video-storyboard`（✅ Apache-2.0 + `NOTICE`）：**已建协议映射**；**未挖尽**：HSV 五阶段物理切点检测 + 拉普拉斯最锐帧抽取（胜过固定等时间隔抽帧，用于 `LiveRuntime` 直播切片与长视频理解降本），注意**复用代码片段时必须落盘保留其 `NOTICE` 与 Apache-2.0 全文**。
   - `Dsh_douyin`（⛔ 无 LICENSE + GPL-3.0 `cortico-world-douyin-live`）& `dsh-live`（⛔ `UNLICENSED` + 假指标）：继续彻底隔离在禁止名单。

---

## 七、Gate 2 许可证与合规审计矩阵（全 31 仓三档刚性划分）

| 合规档位 | 适用仓库 | Gate 2 执行细则 |
| --- | --- | --- |
| **第一档：可参考思路 + 允许按许可复用代码**（须登记 `THIRD_PARTY_NOTICES.md` 并保留版权头 / Apache `NOTICE`） | **MIT（代码部分）**：`dsh-living`、`dsh-douyin-bridge`、`dsh-douyin-studio`、`LockyBee/dsh-douyin-agent`、`dsh_douyin_tools`（仅限非红线工具层）、`AAAjzx111-dsh-douyin-agent`、`milancat-bot`、`dsh-pet`(代码)、`crosspet`(代码+OFL 字体)、`dsh-desktop-petbox`、`agent-pet`、`dsh-stardew-blind-whale-farmer`、`junimo-mcp`、`feiyuos-*`、`FeiyuOS`(代码)、`deepseek-harness`、`t3code`、`magpie`、`dsh-live-studio`、`dsh-livestream`(代码)、`dsh-fish`、`dsh-plugin-yushe`、`Transparent-Video-Maker`<br>**Apache-2.0（必须保 `LICENSE` + `NOTICE`）**：`regrevia/Envoy`（全仓）、`dsh-video-storyboard` | 严禁复制这些仓库中 **CC BY-NC-SA 4.0 非商用素材** 进入商用包体（`dsh-pet` WebM、`aboutme-pets` WebP/m4a、`crosspet` 立绘、`dsh-livestream` dafeiyu、`FeiyuOS` 吉祥物必须保持 `DEV_ONLY_NON_COMMERCIAL` 清源标识）。Apache-2.0 移植必须将 `NOTICE` 归档至 `docs/licenses/`。 |
| **第二档：仅可借鉴架构思路、严禁复制源码**（无根 LICENSE / GPL 风险 / 混合不清晰） | **`dsh-fish-soul`**（⛔ 根目录缺失 `LICENSE` 法律文本，仅 `package.json` 写 MIT）<br>**`Dsh_douyin`**（⛔ 无 LICENSE + 内含 GPL-3.0 `cortico-world-douyin-live`）<br>**`dsh-live`**（⛔ `UNLICENSED` + 虚假模拟指标）<br>*(及 `docs/THIRD_PARTY_NOTICES.md` 已列的 TShock / TSAPI / HEROsMod / dst-admin-go / Journey-Together)* | **Gate 2 零容忍**：不可抄写、不可 `vendor` 引入哪怕一个函数；任何吸取的思想（如 `dsh-fish-soul` 的成长多天验证与防毒丸规则）必须完全基于鲸屿 TS 类型系统重新设计编写。 |
| **第三档：触碰平台风控/反爬红线绝对禁用**（即使仓本身标 MIT 也不得入库） | 1. **`dsh-fish-soul/lib/channels/douyin-http.js` & `douyin-bogus.js`**（生成逆向 `X-Bogus`/`a_bogus` 直调 HTTP）<br>2. **`dsh_douyin_tools` 的 `AutomationControlled` 注入、硬编码 Chrome 155 UA、接管用户日常默认 Profile、直调 `/aweme/v1/web/comment/` XHR**<br>3. **`dsh-douyin-studio` / `AAAjzx111` / `LockyBee` 的主动点赞、自动回复评论、自动发私信、自动续火花、自动发文发布动作**（对当前阶段 L1 只读禁用，L2/L3 亦不得无人授权自动发送） | 鲸屿浏览器基线死守：真 Chrome + 独立持久化隔离 Profile + 只读公开可见页/DOM + 无 stealth + 无指纹伪造 + 无逆向签名 + 遇验证码立刻暂停交还人类（`awaiting_human`）。 |

---

## 八、给鲸屿的可执行落地下一步清单（P0 / P1 / P2 排序）

### 8.1 高价值立即可借鉴（建议纳入近期迭代）

| 优先级 | 来源仓库与源码坐标 | 目标落地位置（鲸屿仓库 / 分支） | 解决的 `REQ-*` 与具体收益 |
| --- | --- | --- | --- |
| **P0-1** | `dsh-douyin-bridge` (`lib/browser.mjs:11-35`, `selectors.mjs:42-165`, `comment.mjs:27-35`, `douyin.mjs:49-231`) + `dsh_douyin_tools` (`mcp_server.py:818-826` 尺寸防误报) | `rabbitfish` -> `apps/desktop-host/src/main/cdp-browser-engine.ts`、`douyin-page-reader.ts` | **`REQ-SOC-01` / `REQ-AUTO-01`**：立刻合入 Chromium 防后台冻结三件套参数、`location.href` 防 `about:blank` 校验、`?modal_id=` 直达备用与可见尺寸过滤真验证码，大幅提升 item #16 在窗口被遮挡和长期运行下的成功率。 |
| **P0-2** | `dsh-living` (`clock.mjs:10-406`) | `packages/character-core/src/life-runtime.ts` | **`REQ-LIFE-01`**：将纯数学正态网格采样（hot/cold/normal 5 档 `σ` + running 作废不积压 + 事件优先级）引入 `LifeRuntime`，补齐零额外 Token 开销的主动生活节律调度。 |
| **P0-3** | `dsh-fish-soul` (`growth.js:12-128`, `mood-guard.js:26-69`, `soul-memory.js:118-203,613-665,712-733` — 纯思想重写) + `dsh-living` (`memory.mjs`, `notes.mjs`) | `packages/character-core/src/profile-stores.ts`、`packages/memory-graph/src/store.ts`、`packages/persona-brain/src/persona-engine.ts` | **`REQ-CHAR-02` / `REQ-MEM-01`**：① `evolveTrait` 改 `candidate → 跨天多源确认 → active → 45d 衰减 / 反证退场` 防单句洗脑；② 增加“禁止自产日程/过期工具短板入长期记忆”铁律（`#75/#76`）；③ 加每日情绪切换上限 4 次及脆弱共情保护 + 内部 `badRegex`/30ms 执行沙盒防 ReDoS。 |
| **P0-4** | `dsh-living` (`audit.mjs:7-206`, `adjudicator.mjs:7-54`, `round.mjs:13-57`) + `dsh-douyin-studio` (`lib/killswitch.mjs`, `lib/risk.mjs`) | `packages/character-core/src/social-runtime.ts`、`social-executor.ts`、`packages/persona-brain/` | **`REQ-SOC-01` / `REQ-SEC-02`**：① L1 前增设 4 道规则前筛减少 VLM 成本；② 对所有公域草稿/外发消息与 Prompt 注入面加「`[主人]` vs `[外部·仅数据]` 逐行标 + 独立无工具 `adjudicator` Fail-Closed 二段审查 + 文件级一键读通写断总闸 `KILL`」。 |
| **P1-1** | `regrevia/Envoy` (`knowledge_units.py`, `skill_compiler.py`, `netpolicy.py:103-138` — Apache-2.0 保留 NOTICE) | `packages/game-bridge-mcp/src/guide-library.ts`、`tools/guide-forager/src/forage.ts`、`packages/runtime-core` | **`REQ-GAME-03`**：将无模型证据切分 + `candidate/verified/promoted/archived` 修改自动降级机制引入游戏攻略闭环，顺便补入 `netpolicy` Fake-IP (`198.18.0.0/15`) TUN 梯子联网白名单。 |
| **P1-2** | `Envoy/integrations/dsh/envoy-dsh/launch.cjs:56-160` + `dsh-douyin-agent` (`receipt-baseline.mjs`, `memory-policy.mjs`, `usage-ledger.mjs`) | `packages/agent-harness/`、`packages/model-gateway/` | **`REQ-EXT-01` / `REQ-MOD-01` / `REQ-MEM-02`**：补齐 macOS GUI 缺省 CLI PATH 探测表与 Windows `.cmd` 适配；在跨平台社交写入（后续 L2/L3）和模型额度账本复用点击前基线 SHA-256 与“未报告计 `unknown` 绝不算零”准则。 |
| **P1-3** | `dsh-douyin-studio` (`lib/watch.mjs`, `lib/publish-steps.mjs:96-111`) + `AAAjzx111` (`frame-composite.mjs`) + `dsh-video-storyboard` (Apache-2.0) | `packages/character-core/src/content-understanding.ts`、`packages/live-stream-hub/` | **`REQ-SOC-01` / `REQ-LIVE-01`**：完善视频分镜自适应拼图（带时间标注标签 + 右侧界面UI像素裁剪 + 1.2s 去重）与自适应关键帧切点提取，只在真实拿到底帧流时触发多模态理解。 |

### 8.2 中长期可留作参考（P2 阶段 / 非当前急迫）

1. **`dsh-desktop-petbox` (`engine.js` 参数单出口 + `interact.js` Alpha 剪影)**：留待 `V2-P3-07C` / `V2-P3-08C`（真 VRM 3D 与 Live2D 舞台渲染）开工时直接吸收。
2. **`dsh-living` (`WorldGem` 插件生态契约 & `rest` 上下文交接)**：留待 `CharacterCore` 向长期 7×24 运行与第三方世界扩展演进时补入 `gems.mjs` 的 `silent`/`ring` 契约与 `gemHealth` 阶梯熔断机制。
3. **`t3code` 移动端审批控制面**：留待 `V2-P4` 远程手机端管理与社区交互审批设计阶段参照。
4. **`dsh-douyin-studio` (`lib/publish-cdp.mjs`) & `AAAjzx111` (`capture-session.mjs`)**：仅留待远期进入受控 L2（用户审核才发创作者草稿/切片分段录制）时重审 `^https://creator.douyin.com/` tab 锚定与分段 manifest 合并思想，当前 L1 严禁接入发布器。

### 8.3 明确舍弃及原因

| 舍弃对象 | 精确原因与分类 |
| --- | --- |
| **`dsh-fish-soul` 抖音 HTTP 模块** (`douyin-http.js` / `douyin-bogus.js`) 与全仓直接抄码 | ① 触碰反爬签名伪造红线；② 根目录无 `LICENSE` 文件触发 Gate 2 禁止复制红线（仅提取非抖音灵魂与安全设计思路重写）。 |
| **`dsh_douyin_tools` 浏览器注入与默认 Profile 接管链** (`AutomationControlled` / 假 UA / 读本机日常 Chrome / 直调 XHR) | 违反本仓 Per-Character 账号隔离原则及风控安全基线。 |
| **`AAAjzx111/dsh-douyin-agent` 整仓引入** | 删除了 LockyBee 全部 `tests/`、隐私图 DAG 与 SHA-256 收据防篡改锁，硬编码 Windows `D:\Deep\diary\` 路径，且主推无人确认自动评论与主动搭讪发消息；除 `frame-composite`/`capture-session` 概念外整仓舍弃。 |
| **`alexbu512/milancat-bot` 核心组织模型** | 定位是“AI 老板 + 多员工文件夹 + 飞书群调度”，与鲸屿单一深厚 `CharacterCore` 伴随主路线正交；且 `memory.js` 能力显著弱于鲸屿已有 `memory-graph`。 |
| **`integrations/dsh/envoy-dsh` 与全系参考仓里的 `dsh` Cordis 挂载胶水** | 本仓已确立以自研 `@workbench/runtime-core` + `WhaleMcpClient/Server` 为内核中心，按已有决策不耦合 `deepseek-harness` 私有 Cordis 插件协议。 |
| **`Dsh_douyin`、`dsh-live`、`cortico-world-douyin-live` 及一切无源/GPL 传染仓** | 维持 Gate 2 永久物理隔离封禁，严禁接触其源码。 |

---

## 九、只读与操作边界自检

- **工作区零写入**：本次仅将报告写入个人 Scratch 目录，未创建、编辑、暂存或提交 `ai-vtuber-workbench` 工作区（`ref-clones-source-audit` 及 `rabbitfish`）任何文件（本文件为后续 docs-only 归档 PR 脱敏入仓版本）。
- **既有克隆零破坏**：`<reference-clones>/` 中 22 个旧仓未执行任何破坏性 Git 命令；`dsh-stardew-blind-whale-farmer` 本地 2 处未提交补丁原封保留；重名仓已安全分离。
- **零运行态干扰**：全程未运行参考仓源码/脚本、未执行 `pip/npm install`、未唤醒或关闭任何浏览器/Chrome CDP/游戏进程。
