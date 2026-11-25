# 鲸屿 Whale Isle — 本地优先 AI 桌宠与多游戏虚拟主播工作台

> 一座住在桌面上的鲸屿。以傲娇蓝鲸女仆「**小鲸（大肥鱼）**」为起点（支持多角色切换与多桌宠联机）：桌面透明桌宠 × 多游戏自主共玩（《星露谷物语》/《泰拉瑞亚》/《饥荒：联机版》）× 声音工坊 × 记忆图谱 × ACP Coding Agents × 直播中控，**本地数据优先、密钥不出本机**。
> 支持 macOS（Apple Silicon / `mps`）与 Windows（x64 / `cuda`）。
> GitHub 仓库：`whale-isle`（https://github.com/jiaiqi/whale-isle）。

## 许可证

- **源代码**：[MIT](./LICENSE) © 2026 jiaiqi —— 可自由使用、修改、分发，包括商用，保留版权声明即可。
- **第三方素材不在此列**：`assets/`、`packages/pet-renderer/assets/` 与各 `pet-packs` 目录下的角色形象、立绘、精灵图与动画（含「小鲸 / 大肥鱼」）为 **CC BY-NC-SA 4.0**，**禁止商用**；改编与再分发须署名并以相同方式共享。商用前必须整包替换为自制素材。
- 逐项来源、署名与条款见 [docs/THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md)。

## 当前能力边界（2026-11-23 审计后如实口径）

| 能力 | 状态 |
| --- | --- |
| 星露谷 BWF 单机自驾 | **可用（有真机证据）**；长期稳定性仍在打磨 |
| 泰拉瑞亚 / 饥荒 DST | **代码与仿真完成，真实游戏闭环未验收**（VERIFY 右栏待人类） |
| 桌宠渲染 / 拖拽 / 多屏 / 多角色 | macOS 已验收；Windows 与异构 DPI 待真机 |
| 模型供应商与主脑 | 可用（用户自配 Key）；纯决策服务商走 System One 探针 |
| 语音 | 桌面主路径为 macOS `mcode-tools → say → afplay`；Python 声音工坊含 stub；Windows 语音待适配 |
| 插件系统 | 外部 dsh 插件可从 `userData/plugins` 发现/启停/调用工具（见 [docs/PLUGINS.md](./docs/PLUGINS.md)）；插件页面开关仍控制内置入口 |
| 直播 / 点歌 / OBS | 注意力调度已接生产链路（本地回放 `[SIMULATION]`）；**OBS `/obs` 只读透明挂件已接通**（STAGE_PROTOCOL=1）；真实 dyhub 弹幕接入与点歌执行链未闭环 |
| 独立安装包 | macOS arm64 DMG 可运行（未签名）；自包含 Python worker 与跨平台语音未完成 |

> 「断网可用」仅指本地数据与不依赖网络的规则功能；LLM、在线语音与真实游戏联机需要对应外部组件或服务。详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) §6 风险清单 R1~R11 与 [docs/VERIFY.md](./docs/VERIFY.md)。

## 文档导航（AI 开发代理与人类宿主必读）

| 文档 | 作用 |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | **AI 自治开发最高宪章**：五层铁笼、原子工单流、四道门禁、许可证红线、§5 V2 增补规范 |
| [docs/README.md](./docs/README.md) | **全仓文档分层导航**：区分 V2 现行真源、共享合规档案与 V1 历史留档 |
| [docs/v2/README.md](./docs/v2/README.md) | **Whale Isle V2 唯一真源总索引**：产品、需求、架构、ADR、`ROADMAP.md`、`CURRENT.md` 与 `evidence/` |
| [docs/v2/DESIGN-SYSTEM.md](./docs/v2/DESIGN-SYSTEM.md) | **UI/UX 设计规范**：**潮汐纸 Tidepaper 主基线** + Obsidian Tide 等多可选主题架构 |
| [docs/THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md) | 第三方许可证与素材来源台账（Gate 2 强校验） |
| [docs/REFERENCES.md](./docs/REFERENCES.md) | 开源参考项目代码级复评清单与规则 |
| [design/index.html](./design/index.html) | **UI/UX 设计中心**：[Tidepaper 主原型 25 页](./design/tidepaper/index.html) + 3 套可选主题（`design/README.md`） |

## 仓库结构

```text
packages/   shared-protocol（按域拆分跨语言契约）· runtime-core（V2 微内核）· character-core（12 域与 LifeRuntime）
            voice-runtime（VoiceProvider/口型/多轨混音）· pet-renderer · model-gateway · persona-brain
            game-bridge-mcp（多游戏 GameAdapter + AI-First 规划）· memory-graph · live-stream-hub
            plugin-kit（Worker 隔离 + Skills）· local-store（node:sqlite + Dexie）· agent-harness（ACP/MCP）· stardew-mods
apps/       desktop-host（Electron 主进程 + 中控台 Shell + pet-stage 透明桌宠 + 内嵌 WebUI :18780）
services/   audio-ai-worker（Python/uv：情绪 TTS + 声音工坊 + RVC）· dst-bridge-sidecar（DST 桥接 :18100）
mods/       stardew-mcp-mod（星露谷 SMAPI）· terraria-bridge（泰拉瑞亚 tML :18090）· dst-bridge（DST Lua）
tools/      evolution-lite（隔离研发平面）· mock-harness（三游戏仿真器 + 弹幕风暴 + 许可证扫描）· guide-forager · scripts
docs/       docs/v2/（V2 现行真源 + ADR-000~003 + 蓝图/证据）· 合规/参考档案 · V1 历史文档
design/     tidepaper/（主 UI/UX 参考 25 页）· theme-obsidian-tide/ · theme-tide-deep/ · theme-obsidian-v4/ · archive/
```

## 快速开始

```bash
pnpm install
pnpm typecheck                                  # Gate 1：类型编译与架构边界校验
pnpm verify:gate                                # 4 道门禁 / 7 项检查（124 个测试文件 / 1482 个用例，分支覆盖 90.49%；2026-11-25 实测）
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
