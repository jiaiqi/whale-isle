# ADR-001：Whale Isle V2 基础架构与演进分歧决策

- **状态**：Accepted（默认采纳并落地于 `feat/whale-isle-v2` 基础骨架，以下四项重大选择均保持可逆，待产品负责人最终确认）
- **日期**：2026-11-25

---

## 分歧 1：UI 目标视觉体系选择（Obsidian Tide vs Tidepaper）

- **背景**：仓库同时存在 `design/`（Obsidian v4）、`whale-isle-v2-obsidian.html`、`design/v2/`（Tide v5）、`design/v2-gemini/`（Obsidian Tide）和 `design/v3/`（Tidepaper）。
- **选项 A（默认采纳）**：采用 **Obsidian Tide（`design/v2-gemini/`）**。承接 V1 已落地的 Tailwind v4 曜石 token 与暗/浅双主题（加 `system` 跟随），采用「六世界 × 十页面」IA 与四签名组件（声呐环 / 回执芯片 / 许可徽章 / 控制权 HUD），兼容实时监控与手账感。
- **选项 B**：切换到 `design/v3/` Tidepaper 纸感手账风格。
- **影响**：选 A 可直接渐进重构现有 React/Tailwind 组件，无推倒重做成本；若改选 B，需重写全部颜色与排版 token（约 2–3 天额外工作量）。

## 分歧 2：演进路线策略（独立分支 Strangler 渐进重构 vs 全新仓库推倒重写）

- **背景**：V1 已有 54,558 行代码、1,400+ 单测、7/7 门禁及真机验证过的星露谷/模型网关/桌宠窗口，但存在主进程 God-file 与职责耦合问题。
- **选项 A（默认采纳）**：在独立 Git 分支 `feat/whale-isle-v2` 上采用 **Strangler Pattern**——新建 `@workbench/runtime-core` 作为 V2 内核接入 Electron 主进程，保留已验证包并通过兼容适配器渐进迁移。
- **选项 B**：新建空目录完全重写桌面端与业务包。
- **影响**：选 A 保证项目自始至终可编译、可运行、门禁不退化，且星露谷真机成果零流失；选 B 会丢失既有 1,400+ 测试与真机补丁，交付周期拉长数倍。

## 分歧 3：SQLite 存储引擎收敛（统一 `node:sqlite` vs 继续保留 `better-sqlite3`）

- **背景**：V1 中 `local-store/src/sqlite.ts` 使用 `better-sqlite3`（原生 C++ 模块，多次触发 Node 与 Electron ABI 冲突），而 `local-store/src/friendship.ts` 已改用 Electron 45 / Node 24 内置 `node:sqlite`。
- **选项 A（计划在 `V2-P0-03` 执行）**：全仓统一收敛到 **`node:sqlite` + JSONL 审计流**，移除 `better-sqlite3` 原生依赖。
- **选项 B**：保留 `better-sqlite3` 并维护跨平台 rebuild 脚本。
- **影响**：选 A 可彻底消除 macOS/Windows 打包 ABI 崩溃，减小安装包体积且零原生构建门槛。

## 分歧 4：第一阶段语音系统底座（`VoiceProvider` 抽象 + 现有链路先行 vs 强绑本地重型模型）

- **背景**：V1 `services/audio-ai-worker` 目前仍是 440Hz WAV stub；真实发声依赖 macOS 专有 `mcode-tools → say → afplay`，Windows 尚不可用。
- **选项 A（默认采纳）**：先在 `VoiceRuntime` 抽象统一 `VoiceProvider` 接口与嘴型/情绪契约，第一阶段优先保证跨平台云端/系统可用发声与语音租约闭环，本地 GPT-SoVITS / SVC 歌声转换作为可插拔 Provider 在 P2 接入。
- **选项 B**：P1 即强制随包捆绑本地 Python PyTorch + GPT-SoVITS + RVC 推理。
- **影响**：选 A 可避免安装包膨胀至数 GB 与跨平台硬件适配阻塞 P1 核心链路；P2 接入本地引擎时上层零改动。
