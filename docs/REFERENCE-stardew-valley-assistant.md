# REFERENCE — stardew-valley-assistant（ayndpa/stardew-valley-assistant）复评档案

> 仓库：https://github.com/ayndpa/stardew-valley-assistant ｜ 许可证：**MIT**（`reference-clones/stardew-valley-assistant/LICENSE` L1–3，`Copyright (c) 2026 Ji Fuyao`）｜ 主语言：React 19 + TypeScript + Rust（Tauri v2）+ C# Runtime
> 分析方式：只读本地克隆 `reference-clones/stardew-valley-assistant/` 全仓代码与目录（仅作数据审阅，未执行任何构建或脚本）。分析日期：2026-11-28

---

## 1. 结论摘要

该项目是**跨平台玩家辅助工具箱 + P2P 虚拟局域网联机平台**（**不包含任何 AI 玩游戏、自动规划或寻路控制逻辑**；经全仓检索 `openai` 仅用于第三方 Mod 翻译弹窗）。其核心价值在于进程内主线程帧队列、`SharedFarmHost` 农舍共享联机思路、P2P 代理假 IP 过滤以及像素 UI / 季节 Todo 清单设计。

## 2. 采用什么（纯思想借鉴，未复制源码）

- **主线程帧队列与帧差事件合成**（`runtime-src/Assistant.Runtime/{FrameLoop.cs, GameEvents.cs, Cheats.cs}`）：Harmony postfix `Game1._update` 每帧有上限消费队列动作，避免管道线程直改 `Game1` 的竞态风险。
- **跨平台本地通信对称抽象**（`pipe_server.rs` + `PipeClient.cs`）：同一命名约定分别映射到 Windows Named Pipe 与 macOS/Linux Unix Socket。
- **多人共享主机代理思路**（`SharedFarmHost.cs` L31–45, L139–155）：联机房主切换时不破坏原农舍房屋与家具归属。
- **P2P VLAN 防代理回环路由过滤**（`crates/p2p-vlan/src/lib.rs` L50–54）：组网显式剔除 `169.254.x.x` 与 `198.18.0.0/15`（fake IP）段。
- **季节/日常 Todo 清单与像素控件质感**（`desktop-app/src/pages/Todo.tsx` L35–59、`shared/stardew-ui`）：参考其面向玩家的清晰每日/季待办分类展示方式，反哺中控台「当日 Todo List + 完成时间 + 计划变更日志」面板。

## 3. 不采用什么（为什么）

- **无 AI 自主控制能力**：纯手动/作弊菜单，不满足 Whale Isle AI 全自动游玩主目标。
- **Windows 远程线程注入 (`injector/src/lib.rs`)**：`VirtualAllocEx + CreateRemoteThread` 在消费端易触发杀毒误报；我们坚持标准 SMAPI Mod 路径（含 `WhaleIsleAvatar` 与 BWF）。
- **前端 `localStorage` 明文存储敏感配置 / Todo**（`ModTranslateModal.tsx`、`Todo.tsx`）：我们所有关键配置与长期记忆/流水统一走主进程加密/SQLite 持久源。

## 4. 复评记录

| 日期 | 结论变化 | 原因 |
| --- | --- | --- |
| 2026-11-28 | 首次建档；确认为 MIT；明确其无 AI 游玩功能，仅吸收主线程帧队、`fake_ip` 过滤、`SharedFarmHost` 与 Todo UI 展示启发 | 只读审计本地克隆 `reference-clones/stardew-valley-assistant` |
