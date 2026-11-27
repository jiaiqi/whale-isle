# THIRD_PARTY_NOTICES — 第三方开源代码与素材许可证台账

> **纪律**：任何第三方代码/素材进入本仓库前，必须先在此登记；Gate 2（`pnpm verify:gate`）会校验本文件存在且持续维护。
> 台账状态标记：`✅ 已登记` / `⚠️ 待核实` / `⛔ 禁止引入`。
> **核实口径（2026-11-15）**：许可证结论来自 GitHub API `license` 字段 + LICENSE 文件原文通读；"采用什么"实现细节详见各 `docs/REFERENCE-*.md`。

## 1. 运行时依赖（Node / TS）

| 组件 | 版本 | 许可证 | 使用方式 | 用途 | 状态 |
| --- | --- | --- | --- | --- | --- |
| zod | ^3.25 | MIT | 依赖 | `packages/shared-protocol` 契约校验 | ✅ 已登记 |
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
| better-sqlite3 | 12.x | MIT | 已退役（V2-P0-03 迁移至 Node 内置 `node:sqlite`） | 原常客账本/Token 流水/点歌缓存，现由零原生依赖内置 SQLite 承接 | ✅ 已退役 |
| fastapi / uvicorn | 0.115 / 0.34 | MIT / BSD-3-Clause | 依赖（audio-ai-worker） | 本地音频 Sidecar | ✅ 已登记 |
| cmdk | 1.1.1 | MIT | 依赖（desktop-host UI） | ⌘K 命令面板（含 Radix Dialog 传递依赖，MIT） | ✅ 已登记 |
| sonner | 2.0.8 | MIT | 依赖（desktop-host UI） | Toast 通知 | ✅ 已登记 |
| react-markdown + remark-gfm | 10.1 / 4.0 | MIT | 依赖（desktop-host UI） | 聊天 Markdown/GFM 渲染 | ✅ 已登记 |
| react-force-graph-2d | 1.29.2 | MIT | 依赖（desktop-host UI） | 记忆图谱力导向渲染（force-graph/d3-force 传递依赖，MIT） | ✅ 已登记 |

> 后续引入的每一个新依赖（Electron、React、Dexie、better-sqlite3、dependency-cruiser、FastAPI、Demucs、RVC 等）**必须在本表追加一行**。

## 2. 移植/参考的开源项目代码（2026-11-15 真实核实）

| 来源项目 | 许可证（核实结果） | 移植范围 | 本仓库落点 | 备注与约束 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `PC2005-cloud/dsh-pet` | **代码 MIT** | 渲染物理（Q 弹/甩抛/DPI 边界）；多显示器矩形并集/最近屏/窗口区域夹紧（`src/shared/displays.ts` 移植子集）；睡觉安静模式、余额分档动画、绿幕转 WebM 资产链 | `packages/pet-renderer`、`apps/desktop-host/src/main/display-region.ts`、`services/audio-ai-worker/asset_pipeline` | 移植代码保留 MIT 版权/许可声明；全文归档 `docs/licenses/dsh-pet-2026.txt`；二创公开渠道须附原作者仓库地址（README 约定） | ✅ 已登记（代码） |
| `hunmer/aboutme-pets` | **素材 CC BY-NC-SA 4.0**（上游 README「来源与许可」节声明；仅 `pets/dsh`、`pets/dsh1` 两包包内带 MIT 文本且明言「不覆盖素材限制、素材禁止商用」，其余 7 包无任何 LICENSE 文件，仓库根无 LICENSE——2026-11-24 逐包复核修正，原记「MIT」有误） | 9 套透明 WebP 精灵图（1,040 动作）+ 480 条 `.m4a` 动作原声；只解析公开 JSON 结构 | **随包直入**：`assets/pet-packs/aboutme-pets/`（`pnpm sync:pet-packs` 拉取）→ electron-builder `extraResources` → `Resources/pet-packs/`；userData 导入链仍保留 | 禁止商用；公开使用须署名 hunmer/aboutme-pets 与 crosspet 原作者（上善无形 / ZipZipPipe）；dsh/dsh1 包内 MIT 文本不改变底层形象权（溟月 / ZipZipPipe 非商用声明）；仓库代码（转换脚本/播放器）无许可→只借思想；`Transparent-Video-Maker/` 子目录 MIT 可移植 | ✅ 已登记（随包素材，DEV_ONLY；2026-11-24 许可口径修正） |
| `lokicorvus/crosspet` | **CC BY-NC-SA 4.0**（`characters/LICENSE.md` 明确：立绘/设定/生图提示词） | 8 基础 AI 角色 + 7 套换装皮肤 + 15 套 `egg-*` 串门彩蛋 + 53 类台词；8 套手写 `.woff2` 字体 | **随包直入**：`assets/pet-packs/crosspet/`（`characters/` + `app/web/fonts/notebook/`） | **禁止商用**；必须署名 CrossPet 与原作者（LICENSE.md 内名单）；manifest/角色包固定 `DEV_ONLY_NON_COMMERCIAL` | ✅ 已登记（随包素材，DEV_ONLY） |
| `hunmer/aboutme-pets` + `lokicorvus/crosspet`（运行时下载旧链） | **CC BY-NC-SA 4.0**（aboutme 素材见上行 2026-11-24 修正；crosspet 立绘同 CC BY-NC-SA） | 9 套透明 WebP 精灵图 + 可选 m4a 动作音轨；仅解析公开 JSON 结构，运行期下载至 `userData/pet-characters` | `packages/pet-renderer/src/aboutme-pets.ts`、`SpritesheetRenderer`、角色包商店 | 随包版优先；userData 版仅作自定义补充 | ✅ 已登记（运行时素材，DEV_ONLY） |
| `PC2005-cloud/dsh-pet` + `luckui/dsh-livestream`（大肥鱼形象/动画素材） | **CC BY-NC-SA 4.0**（形象原型声明：溟月 @上善无形；女仆鲸鱼娘设计 @ZipZipPipe） | "蓝色大肥鱼" webm 动作资产包 | `assets/pets/blue-whale-maid/` | **`licenseScope: DEV_ONLY_NON_COMMERCIAL`，禁止商用**；必须提供一键替换自制素材包管线 | ⚠️ 仅限本地开发测试 |
| `Darianliu23/dsh-stardew-blind-whale-farmer` | **MIT**（原"待核实"已解除） | Observer 状态树、A*/跨地图寻路、游戏原生执行、F7 接管、游玩预算、攻略分层；**本地补丁**：showHud 进 /settings 远程设置（`mods/bwf-patches/2026-11-22-showhud-settings.patch`，保留版权头，上游升级时需重放） | `mods/stardew-mcp-mod`、`packages/game-bridge-mcp`、`mods/bwf-patches/`（补丁与构建流程） | 传输改为本仓 WS+JSON-RPC 2.0；保留版权头；C# 改造（MIT 允许直接改造，非仅思想参考） | ✅ 已登记 |
| `LockyBee/dsh-douyin-agent` | **MIT** | 收据基线/验证记录/额度账本的纪律参照；分镜拼图思路 | `packages/live-stream-hub`、`docs/VERIFY.md` | 不引入其浏览器自动化源码 | ✅ 已登记 |
| `SAOS-3624/dsh-video-storyboard` | **Apache-2.0**（v0.5.0 起） | evidence.json 证据链格式、token 预算/dryRun 思想 | `packages/live-stream-hub`（切片器） | **必须保留 NOTICE 与署名**（Apache-2.0 §4） | ✅ 已登记 |
| `luckui/dsh-livestream` | **代码 MIT** | 注意力调度原型、情绪标记换表情、谢幕结算、模拟观众思想 | `packages/live-stream-hub` | 代码引用保留版权头；其 dafeiyu 素材同上 CC BY-NC-SA | ✅ 已登记（代码） |
| `XiaoZheBrother/dsh-live-studio` | **MIT** | Live2D 三工具设计、同观众合并、渲染安全基线（回环+同源+令牌） | `packages/pet-renderer`（Live2D 预留）、`packages/live-stream-hub` | 引用保留版权头；其复用的鲸语（jingyu-live2d-agent）MIT 组件如引入须带 NOTICE | ✅ 已登记 |
| `YeStarOne/deepseek-superagent-feiyu-os` | **代码 MIT / 文档 CC-BY-4.0** | observe→auto 纪律、唤醒分级、信箱消息、契约夹具+双侧探针思想 | `AGENTS.md` 体系、`packages/shared-protocol`（T-M0-02） | 不引入其运行时与常驻唤醒机制 | ✅ 已登记 |
| `newbeejmc/Dsh_douyin` | **None（无 LICENSE）** | — | — | **⛔ 严禁复制任何源码**；其 `vendor/douyin-danma`（cortico-world-douyin-live）为 **GPL-3.0**，引入即传染 | ⛔ 禁止引入 |
| `fore-vip/dsh-live` | **None（无 LICENSE）** | — | — | **⛔ 严禁复制任何源码**；README 自述"模拟引擎"码率/观看/时长为模拟值（虚假指标反面样本） | ⛔ 禁止引入 |
| `cortico-world-douyin-live` | **GPL-3.0-or-later** | — | — | **⛔ 禁止 vendor 引入**（传染性）；抖音弹幕直连主线为 dyhub，不可用则自研协议并立合规工单 | ⛔ 禁止引入 |
| `dyhub` / `CC Switch` / `Magpie` / `awesome-codex-pet` | ⚠️ 待核实（用户未提供仓库） | — | — | 补档前一律按"仅思想参考、禁止复制源码"处置 | ⚠️ 待核实 |
| `Reisenbug/TerraBlind`（+ `MutantPilot`、`musharna/tmodloader-mcp`） | ✅ **MIT**（LICENSE 原文核实） | **仅思想吸收，未复制源码**：模组内 HTTP 三段式回执、世界事实终止、生存反射、物理预测寻路、工具面语感 | `mods/terraria-bridge/`、`packages/game-bridge-mcp/src/terraria-adapter.ts`、`docs/REFERENCE-terrariablind.md` | 原创 C#/TS 实现；若后续直接复制 MIT 代码片段须保留版权头并改本行状态 | ✅ 已登记（思想参考） |
| `fruitstarzero/Don-t-Starve-Together-AI-Companion`（+ `qinming99/dst-admin`、`mathielo/dst-dedicated-server`） | ✅ **MIT**（LICENSE 原文核实） | **仅思想吸收，未复制源码**：QueryServer localhost tick、服务器侧权威 vanilla 动作、专用服 stdin 运维兜底 | `mods/dst-bridge/`、`services/dst-bridge-sidecar/`、`packages/game-bridge-mcp/src/dst-adapter.ts`、`docs/REFERENCE-dst-ai-companion.md` | 原创 Lua/Node/TS 实现；cluster_token 须人类配置不可绕过 | ✅ 已登记（思想参考） |
| `Pryaxis/TShock`、`Pryaxis/TSAPI`、`JavidPack/HEROsMod`、`newcovid/TerraNoneBridge`、`carrot-hu23/dst-admin-go` | ⛔ **GPL-3.0**（传染性） | — | — | **⛔ 禁止复制任何源码/整体引入**（M7 调研核实）；仅机制思想可参考 | ⛔ 禁止引入 |
| `Im-Chuyu/Journey-Together`、`Insight`、`Combined-Status`、`ActionQueue`、`DontStarveAI`、`xNarnia/TCR` | ⛔ **无 LICENSE / RecEx 受限**（核实） | — | — | 仅参考架构设计（如 Journey-Together 38 动作权限校验），**一行代码不能抄** | ⛔ 禁止引入 |
| **TTS / 歌声引擎评估清单**（Kokoro-82M-v1.1-zh、MeloTTS-zh、Chatterbox Multilingual、CosyVoice2、Spark-TTS、F5-TTS、IndexTTS2、Fish Speech、Piper zh_CN、RVC、DiffSinger、OpenUtau） | 逐项许可与实时结论见 [tts-alternative-engine-eval.md](./v2/evidence/tts-alternative-engine-eval.md) 与 [V2-P3-07-svc-svs-selection.md](./v2/evidence/V2-P3-07-svc-svs-selection.md) | **未引入任何代码或权重**（仅本机评估目录 `artifacts/`，不入库、不进包） | — | 说话自托管已由 owner 2026-11-27 放弃（速评本机全部不过）；RVC 代码 MIT 但官方底模「仅供研究使用」、OpenCpop/OpenVPI 声码器非商用 → 唱歌商用须自训 | ✅ 仅评估，未随包 |

## 3. 素材资产台账

| 素材 | 来源 | 许可证 | licenseScope | 状态 |
| --- | --- | --- | --- | --- |
| 蓝色大肥鱼 .webm 动作包 | dsh-pet 内置 | 非商用（形象 CC BY-NC-SA 4.0） | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 仅开发测试，商用前必须整包替换 |
| **114 个 VP9-alpha webm 已入库**（T-M5-01，55MB） | `packages/pet-renderer/assets/blue-whale-maid/`（源自 dsh-pet/dsh-pet/assets/webm） | CC BY-NC-SA 4.0 | `DEV_ONLY_NON_COMMERCIAL`（manifest.json licenseScope 强制） | ⚠️ 入库即随安装包分发——D14 自包含 vs 商用清洗冲突时以商用清洗优先（删包+换装管线） |
| dsh-livestream dafeiyu 动画片段 | `packages/dsh-livestream/assets/characters/dafeiyu/` | CC BY-NC-SA 4.0（目录级声明） | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 同上，未引入则不登记落点 |
| **供应商官方 logo 10 枚**（openrouter/deepseek/siliconflow/openai/anthropic/minimax/volcano-ark/opencode/ollama/typesafe-jev，2026-11-22 从各家官网 favicon 与 GitHub 官方组织头像收集；typesafe-jev 取 jevmodel.org 官方声明 favicon.png） | `apps/desktop-host/assets/brand/providers/`（~90KB） | **商标权属各公司**，非开源许可素材；仅作服务商身份识别的指称性使用（nominative use），不用于暗示背书 | `PROVIDER_IDENTIFICATION_ONLY` | ✅ 个人本地工具使用；GPT-SoVITS 未取官方标识（无商标级 logo，保留 lucide 图标） |
| **aboutme-pets 全量 9 包**（2026-11-24 随包直入，~1.9GB：1,050 webp + 480 m4a + 1,060 json） | `assets/pet-packs/aboutme-pets/`（`hunmer/aboutme-pets` @ main，由 `pnpm sync:pet-packs` 幂等拉取） | CC BY-NC-SA 4.0（上游 README 声明；仅 dsh/dsh1 包内带 MIT 文本且不覆盖素材限制——2026-11-24 复核修正，原记「MIT」有误） | `DEV_ONLY_NON_COMMERCIAL`（D5 本地自用） | ⚠️ 不进 Git（2GB 二进制），随安装包分发；包内随附 LICENSE 文件原样保留（仅 dsh/dsh1 两包有）；商用前按 §3 商用清洗线整包替换 |
| **crosspet 角色/皮肤/彩蛋 + 手写字体**（2026-11-24 随包直入，~87MB：946 文件） | `assets/pet-packs/crosspet/`（`lokicorvus/crosspet` @ main） | CC BY-NC-SA 4.0（`characters/LICENSE.md`） | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ **禁止商用**；保留 `characters/LICENSE.md` 并署名 CrossPet / ZipZipPipe / 上善无形等原作者 |
| **Stardew Valley Wiki 攻略缓存（guide-forager）**（12 篇 Markdown，~148KB） | `guide-forager/*.md`（`pnpm forage:guides` 实抓，frontmatter 含 `source` + `contentSha1`）→ `Resources/guide-forager/` | **CC BY-NC-SA 3.0**（随 Stardew Valley Wiki 声明；frontmatter 写明「本地自用缓存，公开分发前须清除或获授权」） | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 本地自用；公开分发前须清除或取得授权 |
| **GPT-SoVITS 参考音频 `genki_ref.wav`**（4.11s / 44.1kHz / 立体声，725,804 B） | `packages/pet-renderer/assets/voice-refs/genki_ref.wav` → 随 `packages/pet-renderer/assets` 进 asar | ⚠️ **来源未登记**（`docs/design/expressive-voice-plan.md` R4 已标风险） | `UNREGISTERED_DEV_ONLY` | ⚠️ 仅开发态参考；商用前必须撤出或补齐来源与授权 |
| **Tidepaper 小鲸中控台空状态插画**（2026-11-26：6 组 light/dark WebP + 定妆样张） | `apps/desktop-host/assets/illustrations/`；角色身份参考本仓 `packages/pet-renderer/assets/blue-whale-maid/` WebM；OpenAI image_gen（内置工具，模型 ID 未向调用方提供） | 小鲸角色衍生图按 CC BY-NC-SA 4.0；图像服务输出权利遵循 [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 署名 PC2005-cloud/dsh-pet、ZipZipPipe；仅本地开发与评审，禁止商业用途及公开直播；不使用 CrossPet 图像素材 |
| **小鲸声线参考音频 ×1**（`xiaojing-07-tiancui-yuanqi.wav`，24 kHz/16-bit/单声道；2026-11-27 定稿为八九岁小女孩声线） | `assets/voice/`（随包分发，打包后落 `resources/voice/`）；此前 02 / 08 / 12 与旧 07 的参考音频已从随包资源撤出，归档在本机 `artifacts/`（不入库） | 自产文本 + 小米 MiMo `mimo-v2.5-tts-voicedesign` 生成；上游 TTS 官方标价「限时免费」且页面无商用条款 | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 仅开发与内部验证；**商用前必须换成有明确商用授权的 TTS 并重做这条参考音频**；生成方式见 `assets/voice/README.md` |
| **上首软糖体.ttf**（气泡字体，3.9MB） | `assets/pet-packs/fonts/上首软糖体.ttf`（`PC2005-cloud/dsh-pet` 仓库内） | ⚠️ 字体本体许可证未在仓库单独声明（随 MIT 代码仓库分发） | `DEV_ONLY_NON_COMMERCIAL` | ⚠️ 仅本地自用；商用前必须替换为自制/明确授权字体 |
| **Long Cang（龙藏体，手写感）** | `apps/desktop-host/assets/fonts/long-cang.woff2`（源自 `google/fonts/ofl/longcang`） | ✅ **SIL Open Font License 1.1**（可商用、可随包分发；全文归档 `docs/licenses/long-cang-ofl-1.1.txt`） | `COMMERCIAL_ALLOWED` | ✅ 随包打包进 `dist/renderer/pet-stage/fonts/` |
| **ZCOOL KuaiLe（站酷快乐体，圆体）** | `apps/desktop-host/assets/fonts/zcool-kuaile.woff2`（源自 `google/fonts/ofl/zcoolkuaile`） | ✅ **SIL Open Font License 1.1**（可商用、可随包分发；全文归档 `docs/licenses/zcool-kuaile-ofl-1.1.txt`） | `COMMERCIAL_ALLOWED` | ✅ 随包打包进 `dist/renderer/pet-stage/fonts/` |
| **ZCOOL XiaoWei（站酷小薇体，正式体）** | `apps/desktop-host/assets/fonts/zcool-xiaowei.woff2`（源自 `google/fonts/ofl/zcoolxiaowei`） | ✅ **SIL Open Font License 1.1**（可商用、可随包分发；全文归档 `docs/licenses/zcool-xiaowei-ofl-1.1.txt`） | `COMMERCIAL_ALLOWED` | ✅ 随包打包进 `dist/renderer/pet-stage/fonts/` |

## 4. 许可证文本归档

- 第三方代码整段移植时，许可证全文与版权声明归档至 `docs/licenses/`（按 `<项目名>-<年份>.txt` 命名）；Apache-2.0 移植同时归档其 NOTICE。
