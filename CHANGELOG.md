# Changelog

本项目的所有显著变更将记录在本文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased] - 2026-11-15（第二轮）

### Added

- **T-M1-01 ✅ 可插拔桌宠渲染引擎 pet-renderer**：契约先行——`PetAvatarManifest/PetAvatarClip` 进 shared-protocol（17→19 域，跨语言 Schema 重生成）；`IPetAvatarRenderer` 接口 + `WebmVideoRenderer`（双 video 交叉淡入零黑帧时序、脚底基准线 `computeFootlineLayout`、Q 弹 `squashAt` 阻尼振荡+体积守恒、`DEV_ONLY_NON_COMMERCIAL` 素材自动挂 [DEV-ASSET-ONLY] 水印徽标+署名）；`VideoFactory/RendererHost` 注入隔离 DOM（无头可测，真实 DOM 工厂归 T-M1-02 desktop-host）。
- **T-M0-04 ✅ AI 自测沙盒 mock-harness**：`stardew-mcp-simulator`（JSON-RPC 2.0 over WS，5 剧本确定性回放 + 动作互斥锁 + 0.1s 接管中止 + 回执出站契约校验）、`danmaku-storm-replay`（种子伪随机确定性生成、1000 条风暴 100% 过 NormalizedLiveEventSchema、雷区/点歌/Prompt 注入/连击/进房夹具）、`license-scanner.mjs`（台账+密钥+UNLICENSED+GPL-3.0 传染源，接管 Gate 2，自测 spec 对临时 fixture 实测报错）。
- **T-M0-03 ✅ 本地存储双引擎底座**：新增 `packages/local-store`——主进程 SQLite（`better-sqlite3` WAL：常客记仇/好感账本、Token 流水（1 粒米=1 Token 按槽位汇总）、点歌缓存索引、meta；`deleteViewer/wipeAllViewers/wipeAllData` 隐私一键擦除）+ 渲染进程 Dexie 配置库（`./dexie` 子路径隔离两端）；Gate 3 覆盖率 ≥90% 硬门槛生效（实测四维 100%）；新增 depcruise 规则 `local-store-runtime-only-storage`。
- **T-M0-02 ✅ 全局契约包与跨语言导出器**：`src/registry.ts` 契约注册表（17 域 + `CONTRACT_VERSION`）；`pnpm gen:contracts`（Zod → JSON Schema ×17 + workbench 合并视图 → Pydantic `protocol_models.py`，`$defs` 漂移即报错、`--use-annotated`/`--disable-timestamp` 确定性输出）；TS 契约单测 11 项 + Python 夹具回放 4 项（同一 fixture 双侧 probe）；Gate 3 接线（vitest + pytest）；Gate 1 增补 Python ruff + mypy --strict（生成物 assignment 豁免记录于 mypy.ini）。
- **T-M0-01 ✅ Monorepo 脚手架与架构边界锁**：`.dependency-cruiser.cjs` 六条机器边界规则（no-circular / shared-protocol 零依赖 / 运行时仅 zod / 渲染进程禁 SQLite / pet-renderer 禁跨层 / mock-harness 仅依赖契约）；`pnpm lint:deps` 接入 Gate 1；pre-commit 经 `core.hooksPath=.githooks` 强制 `verify:gate`。验证：临时探针（import `ws`）实测违规自动报错后恢复全绿。
- **9 份 `docs/REFERENCE-*.md` 复评档案**（基于 9 个真实仓库的第一轮复评：GitHub API 元数据 + LICENSE 原文 + README 全文 + 顶层结构，未逐行审计源码）：dsh-pet、dsh-stardew-blind-whale-farmer、dsh-douyin-agent（新增）、dsh-livestream（新增）、dsh-live-studio（新增）、dsh-live（新增，拉黑档案）、Dsh_douyin、dsh-video-storyboard、feiyu-os。
- 每份档案含：结论摘要 / 采用什么 / 不采用什么（为什么）/ 验证路径与回退 / 复评记录。

### Changed

- **docs/REFERENCES.md**：全部按真实仓库重写——许可证结论核实为：dsh-pet（代码 MIT / 大肥鱼形象与素材 CC BY-NC-SA 4.0）、BlindWhaleFarmer（**MIT**，原"待核实"解除）、dsh-douyin-agent（MIT）、dsh-video-storyboard（Apache-2.0）、dsh-livestream（代码 MIT / 素材 CC BY-NC-SA）、dsh-live-studio（MIT）、feiyu-os（代码 MIT / 文档 CC-BY-4.0）、Dsh_douyin（None + 内嵌 GPL-3.0 vendor）、dsh-live（None + 自述模拟指标）。
- **docs/THIRD_PARTY_NOTICES.md**：§2 按真实许可证重写；新增 `cortico-world-douyin-live`（GPL-3.0，⛔ 禁止 vendor 引入）条目；dyhub / CC Switch / Magpie / awesome-codex-pet 未提供仓库，保持"仅思想参考"。
- **AGENTS.md §2.2 许可证洁癖**：补充 GPL-3.0 传染红线、CC BY-NC-SA 4.0 素材精确化、Apache-2.0 NOTICE 要求。

### Security

- Gate 2 黑名单依据更新：`Dsh_douyin` / `dsh-live` 均确认 license=None；新增 GPL-3.0 传染禁令。

## [0.1.0] - 2026-11-15

### Added（项目奠基）

- **Monorepo 骨架**：pnpm workspace（`packages/*`、`apps/*`、`services/*`、`tools/*`）+ 严格 TS 基线（`strict` + `noUncheckedIndexedAccess`）；`mods/` 为 C# 不纳入 pnpm。
- **docs/SPEC.md**：《AI 桌宠与虚拟主播工作台》产品需求与技术架构总纲——4 项冻结决策（WS+JSON-RPC 2.0 总线 `18760` / Dexie+SQLite 双引擎 / OBS Browser Source `18765` 优先 / `uv` Python 3.11 硬件自适应）、六大模块详设、M0~M4 里程碑验收表。
- **AGENTS.md**：AI 自治开发最高宪章——五层铁笼（契约先行 / 仿真沙盒 / 四道门禁 / 防失忆工单流 / 运行时安全锁）、原子工单工作流、许可证硬性红线、主题复评速查表。
- **docs/ROADMAP.md**：M0~M4 共 20 张原子工单冻结清单，当前激活 `T-M0-01`；注明人工预置范围（T-M0-01 / T-M0-02 剩余工作）。
- **docs/VERIFY.md**：验收矩阵，强制分栏「Mock/沙盒已通过」与「待人类真机验收」。
- **docs/REFERENCES.md**：13 个开源参考项目清单、复评纪律与硬性红线（UNLICENSED 项目拉黑）。
- **docs/REFERENCE-*.md**：5 篇复评档案占位（dsh-pet / BlindWhaleFarmer / dsh-douyin / dsh-video-storyboard / feiyu-os）。
- **docs/THIRD_PARTY_NOTICES.md**：第三方许可证台账（含 dsh-pet 素材 `DEV_ONLY_NON_COMMERCIAL` 标记）。
- **packages/shared-protocol**：全局 Zod 契约初稿（桌宠渲染与语音锁 / 大肥鱼人格与赛博饭碗 / 模型网关与干饭套餐 / 星露谷 MCP 真实回执 / 直播事件总线五域）。
- **tools/scripts/verify-gate.mjs**：`pnpm verify:gate` 门禁编排器——Gate 1（tsc）与 Gate 2（许可证台账 + 密钥/禁源扫描）已接线，Gate 3/4 待 T-M0-03 / T-M0-04 接入。
- **Git 仓库初始化**（main 分支）。

### Security

- Gate 2 内置扫描：硬编码密钥特征（`sk-` / `ghp_` / `AKIA` / 明文 apiKey 赋值）与 UNLICENSED 项目源码痕迹（`fore-vip/dsh-live`、`newbeejmc/Dsh_douyin`）。
