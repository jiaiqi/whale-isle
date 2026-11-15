# Changelog

本项目的所有显著变更将记录在本文件。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
