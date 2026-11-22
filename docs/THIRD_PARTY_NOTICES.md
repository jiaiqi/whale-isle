# THIRD_PARTY_NOTICES — 第三方开源代码与素材许可证台账

> **纪律**：任何第三方代码/素材进入本仓库前，必须先在此登记；Gate 2（`pnpm verify:gate`）会校验本文件存在且持续维护。
> 台账状态标记：`✅ 已登记` / `⚠️ 待核实` / `⛔ 禁止引入`。
> **核实口径（2026-11-15）**：许可证结论来自 GitHub API `license` 字段 + LICENSE 文件原文通读；"采用什么"实现细节详见各 `docs/REFERENCE-*.md`。

## 1. 运行时依赖（Node / TS）

| 组件 | 版本 | 许可证 | 使用方式 | 用途 | 状态 |
| --- | --- | --- | --- | --- | --- |
| zod | ^3.25 | MIT | 依赖 | `packages/shared-protocol` 契约校验 | ✅ 已登记 |
| zod-to-json-schema | ^3.25 | MIT | devDependencies（shared-protocol） | Zod → JSON Schema 导出 | ✅ 已登记 |
| typescript | ^5.9 | Apache-2.0 | devDependencies | 全仓类型编译 | ✅ 已登记 |
| @types/node | ^22 | MIT | devDependencies | Node 类型 | ✅ 已登记 |
| vitest | ^5 | MIT | devDependencies | Gate 3 单测运行器 | ✅ 已登记 |
| tsx | ^4 | MIT | devDependencies | 契约生成器运行时 | ✅ 已登记 |
| dependency-cruiser | ^16 | MIT | devDependencies | Gate 1 架构边界检查 | ✅ 已登记 |
| pydantic（uv 临时环境） | 2.x | MIT | Python 侧契约模型基类 | protocol_models.py 依赖 | ✅ 已登记 |
| datamodel-code-generator（uv） | latest | MIT | 生成工具 | JSON Schema → Pydantic | ✅ 已登记 |
| mypy / ruff / pytest（uv） | latest | MIT/MIT-类/PSF-类 | 生成工具链 | Python 类型/规范/测试 | ✅ 已登记 |
| react / react-dom | 19.3 | MIT | 依赖 | 渲染层 | ✅ 已登记 |
| lucide-react | 1.77 | ISC | 依赖 | 全站 SVG 图标（零 emoji） | ✅ 已登记 |
| tailwindcss / @tailwindcss/cli | 4.3 | MIT | devDependencies | v4 utility 编译 | ✅ 已登记 |
| electron | 38.8 | MIT | devDependencies | 桌面宿主 | ✅ 已登记 |
| esbuild | 0.25 | MIT | devDependencies | main/preload/renderer 打包 | ✅ 已登记 |
| playwright-core | 1.65 | Apache-2.0 | devDependencies | Electron E2E | ✅ 已登记 |
| ws | 8.23 | MIT | 依赖 | WebUI HTTP/WS 回环网关 | ✅ 已登记 |
| better-sqlite3 | 12.x | MIT | 依赖（local-store） | 常客账本/Token 流水/点歌缓存 | ✅ 已登记 |
| fastapi / uvicorn | 0.115 / 0.34 | MIT / BSD-3-Clause | 依赖（audio-ai-worker） | 本地音频 Sidecar | ✅ 已登记 |
| cmdk | 1.1.1 | MIT | 依赖（desktop-host UI） | ⌘K 命令面板（含 Radix Dialog 传递依赖，MIT） | ✅ 已登记 |
| sonner | 2.0.8 | MIT | 依赖（desktop-host UI） | Toast 通知 | ✅ 已登记 |
| react-markdown + remark-gfm | 10.1 / 4.0 | MIT | 依赖（desktop-host UI） | 聊天 Markdown/GFM 渲染 | ✅ 已登记 |
| react-force-graph-2d | 1.29.2 | MIT | 依赖（desktop-host UI） | 记忆图谱力导向渲染（force-graph/d3-force 传递依赖，MIT） | ✅ 已登记 |

> 后续引入的每一个新依赖（Electron、React、Dexie、better-sqlite3、dependency-cruiser、FastAPI、Demucs、RVC 等）**必须在本表追加一行**。

## 2. 移植/参考的开源项目代码（2026-11-15 真实核实）

| 来源项目 | 许可证（核实结果） | 移植范围 | 本仓库落点 | 备注与约束 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `PC2005-cloud/dsh-pet` | **代码 MIT** | 渲染物理（Q 弹/甩抛/DPI 边界）、睡觉安静模式、余额分档动画、绿幕转 WebM 资产链 | `packages/pet-renderer`、`services/audio-ai-worker/asset_pipeline` | 移植须保留 MIT 版权头；二创公开渠道须附原作者仓库地址（README 约定） | ✅ 已登记（代码） |
| `PC2005-cloud/dsh-pet` + `luckui/dsh-livestream`（大肥鱼形象/动画素材） | **CC BY-NC-SA 4.0**（形象原型声明：溟月 @上善无形；女仆鲸鱼娘设计 @ZipZipPipe） | "蓝色大肥鱼" webm 动作资产包 | `assets/pets/blue-whale-maid/` | **`licenseScope: DEV_ONLY_NON_COMMERCIAL`，禁止商用**；必须提供一键替换自制素材包管线 | ⚠️ 仅限本地开发测试 |
| `Darianliu23/dsh-stardew-blind-whale-farmer` | **MIT**（原"待核实"已解除） | Observer 状态树、A*/跨地图寻路、游戏原生执行、F7 接管、游玩预算、攻略分层 | `mods/stardew-mcp-mod`、`packages/game-bridge-mcp` | 传输改为本仓 WS+JSON-RPC 2.0；保留版权头；C# 改造（MIT 允许直接改造，非仅思想参考） | ✅ 已登记 |
| `LockyBee/dsh-douyin-agent` | **MIT** | 收据基线/验证记录/额度账本的纪律参照；分镜拼图思路 | `packages/live-stream-hub`、`docs/VERIFY.md` | 不引入其浏览器自动化源码 | ✅ 已登记 |
| `SAOS-3624/dsh-video-storyboard` | **Apache-2.0**（v0.5.0 起） | evidence.json 证据链格式、token 预算/dryRun 思想 | `packages/live-stream-hub`（切片器） | **必须保留 NOTICE 与署名**（Apache-2.0 §4） | ✅ 已登记 |
| `luckui/dsh-livestream` | **代码 MIT** | 注意力调度原型、情绪标记换表情、谢幕结算、模拟观众思想 | `packages/live-stream-hub` | 代码引用保留版权头；其 dafeiyu 素材同上 CC BY-NC-SA | ✅ 已登记（代码） |
| `XiaoZheBrother/dsh-live-studio` | **MIT** | Live2D 三工具设计、同观众合并、渲染安全基线（回环+同源+令牌） | `packages/pet-renderer`（Live2D 预留）、`packages/live-stream-hub` | 引用保留版权头；其复用的鲸语（jingyu-live2d-agent）MIT 组件如引入须带 NOTICE | ✅ 已登记 |
| `YeStarOne/deepseek-superagent-feiyu-os` | **代码 MIT / 文档 CC-BY-4.0** | observe→auto 纪律、唤醒分级、信箱消息、契约夹具+双侧探针思想 | `AGENTS.md` 体系、`packages/shared-protocol`（T-M0-02） | 不引入其运行时与常驻唤醒机制 | ✅ 已登记 |
| `newbeejmc/Dsh_douyin` | **None（无 LICENSE）** | — | — | **⛔ 严禁复制任何源码**；其 `vendor/douyin-danma`（cortico-world-douyin-live）为 **GPL-3.0**，引入即传染 | ⛔ 禁止引入 |
| `fore-vip/dsh-live` | **None（无 LICENSE）** | — | — | **⛔ 严禁复制任何源码**；README 自述"模拟引擎"码率/观看/时长为模拟值（虚假指标反面样本） | ⛔ 禁止引入 |
| `cortico-world-douyin-live` | **GPL-3.0-or-later** | — | — | **⛔ 禁止 vendor 引入**（传染性）；抖音弹幕直连主线为 dyhub，不可用则自研协议并立合规工单 | ⛔ 禁止引入 |
| `dyhub` / `CC Switch` / `Magpie` / `awesome-codex-pet` | ⚠️ 待核实（用户未提供仓库） | — | — | 补档前一律按"仅思想参考、禁止复制源码"处置 | ⚠️ 待核实 |

## 3. 素材资产台账

| 素材 | 来源 | 许可证 | licenseScope | 状态 |
| --- | --- | --- | --- | --- |
| 蓝色大肥鱼 .webm 动作包 | dsh-pet 内置 | 非商用（形象 CC BY-NC-SA 4.0） | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 仅开发测试，商用前必须整包替换 |
| **114 个 VP9-alpha webm 已入库**（T-M5-01，55MB） | `packages/pet-renderer/assets/blue-whale-maid/`（源自 dsh-pet/dsh-pet/assets/webm） | CC BY-NC-SA 4.0 | `DEV_ONLY_NON_COMMERCIAL`（manifest.json licenseScope 强制） | ⚠️ 入库即随安装包分发——D14 自包含 vs 商用清洗冲突时以商用清洗优先（删包+换装管线） |
| dsh-livestream dafeiyu 动画片段 | `packages/dsh-livestream/assets/characters/dafeiyu/` | CC BY-NC-SA 4.0（目录级声明） | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 同上，未引入则不登记落点 |

## 4. 许可证文本归档

- 第三方代码整段移植时，许可证全文与版权声明归档至 `docs/licenses/`（按 `<项目名>-<年份>.txt` 命名）；Apache-2.0 移植同时归档其 NOTICE。
