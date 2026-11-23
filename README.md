# 鲸屿 Whale Isle — 本地优先 AI 桌宠与多游戏虚拟主播工作台

> 一座住在桌面上的鲸屿。以傲娇蓝鲸女仆「**小鲸（大肥鱼）**」为起点（支持多角色切换与多桌宠联机）：桌面透明桌宠 × 多游戏自主共玩（《星露谷物语》/《泰拉瑞亚》/《饥荒：联机版》）× 声音工坊 × 记忆图谱 × ACP Coding Agents × 直播中控，**本地数据优先、密钥不出本机**。
> 支持 macOS（Apple Silicon / `mps`）与 Windows（x64 / `cuda`）。
> GitHub 仓库：`whale-isle`（https://github.com/jiaiqi/whale-isle）。

## 当前能力边界（2026-11-23 审计后如实口径）

| 能力 | 状态 |
| --- | --- |
| 星露谷 BWF 单机自驾 | **可用（有真机证据）**；长期稳定性仍在打磨 |
| 泰拉瑞亚 / 饥荒 DST | **代码与仿真完成，真实游戏闭环未验收**（VERIFY 右栏待人类） |
| 桌宠渲染 / 拖拽 / 多屏 / 多角色 | macOS 已验收；Windows 与异构 DPI 待真机 |
| 模型供应商与主脑 | 可用（用户自配 Key）；纯决策服务商走 System One 探针 |
| 语音 | 桌面主路径为 macOS `mcode-tools → say → afplay`；Python 声音工坊含 stub；Windows 语音待适配 |
| 插件系统 | `plugin-kit` 兼容层与单测完成；外部插件装载/热插拔未接入主进程 |
| 直播 / 点歌 / OBS | 注意力调度与面板 UI 已有；**OBS `/obs` 只读透明挂件已接通**（STAGE_PROTOCOL=1）；真实弹幕接入与点歌执行链未闭环 |
| 独立安装包 | macOS arm64 DMG 可运行（未签名）；自包含 Python worker 与跨平台语音未完成 |

> 「断网可用」仅指本地数据与不依赖网络的规则功能；LLM、在线语音与真实游戏联机需要对应外部组件或服务。详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) §6 风险清单 R1~R11 与 [docs/VERIFY.md](./docs/VERIFY.md)。

## 文档导航（AI 开发代理与人类宿主必读）

| 文档 | 作用 |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | **AI 自治开发最高宪章**：五层铁笼、原子工单流、五道门禁、许可证红线 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | **系统架构方案 v2**：C4 拓扑、ADR-1~ADR-10（多游戏/插件分层/WebUI+OBS 合并）与风险清单 |
| [docs/PRODUCT-DESIGN.md](./docs/PRODUCT-DESIGN.md) | 产品功能设计总纲（桌宠语音/气泡、声音工坊、记忆日记、多游戏与直播） |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | M0~M7 全阶段工单清单与当前实时状态 |
| [docs/VERIFY.md](./docs/VERIFY.md) | 验收矩阵（严格区分 `[SIMULATION]` / `[E2E-HOST]` 与 `[REAL-DEVICE]`） |
| [docs/REFERENCES.md](./docs/REFERENCES.md) | 开源参考项目代码级复评清单与规则 |
| [docs/THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md) | 第三方许可证与素材来源台账 |
| [design/index.html](./design/index.html) | v4「曜石」高保真交互原型总览（v3 备份位于 `design/v3-archive/`） |

## 仓库结构

```text
packages/   shared-protocol（50 域跨语言契约）· pet-renderer · model-gateway · persona-brain
            game-bridge-mcp（多游戏 GameAdapter + 救援大脑）· memory-graph · live-stream-hub
            plugin-kit（Cordis 兼容层）· local-store · agent-harness（ACP v1）· stardew-mods
apps/       desktop-host（Electron 主进程 + 中控台 Shell + pet-stage 透明桌宠 + 内嵌 WebUI :18780）
services/   audio-ai-worker（Python/uv：情绪 TTS + 声音工坊 + RVC）· dst-bridge-sidecar（DST 桥接 :18100）
mods/       stardew-mcp-mod（星露谷 SMAPI）· terraria-bridge（泰拉瑞亚 tML :18090）· dst-bridge（DST Lua）
tools/      mock-harness（三游戏仿真器 + 弹幕风暴 + 许可证扫描）· guide-forager（攻略采集）· scripts（门禁）
design/     v4「曜石」10 页可交互高保真原型
```

## 快速开始

```bash
pnpm install
pnpm typecheck                                  # Gate 1：类型编译与架构边界校验
pnpm verify:gate                                # 4 道门禁 / 7 项检查（744 tests，分支覆盖 90.12%）
pnpm --filter @workbench/desktop-host start     # 构建并启动桌面端（中控台 + 桌宠窗 + WebUI :18780）
pnpm soak:autodrive 1                           # [SIMULATION] 仿真器长时浸泡 1 分钟（错误率/内存趋势）
pnpm --filter @workbench/desktop-host package   # 打出独立安装包（macOS arm64 .dmg / Win x64 .exe）
```

> CI：`.github/workflows/ci.yml` —— ubuntu 跑类型/边界/单测/Python/luac/audit；macOS 跑完整 `verify:gate` + Electron E2E（`[E2E-HOST]`）。远程首跑已双绿（run 45123414392）。
> 注意 Gate 4 是**测试内组合的回环**，不等于 Electron/Python/真实发声/磁盘账本的端到端；准确口径见 [docs/VERIFY.md](./docs/VERIFY.md) 顶部「验证口径修订」。

> 本地无 Developer ID 签名的 macOS `.dmg` 拖入 `/Applications` 后，如遇系统隔离拦截请执行：`xattr -dr com.apple.quarantine "/Applications/鲸屿 Whale Isle.app"`。

## 版本管理约定

- 使用 Git 管理；每个工单 `pnpm verify:gate` 全绿后提交一次，提交信息注明工单号（如 `feat(T-M6-09): 模型与服务商 v5 重构`）。
- 运行期产物（`data/`、`cache/`、`recordings/`）、打包输出（`release/`）与密钥（`.env*`）一律不入库（见 `.gitignore`）。
