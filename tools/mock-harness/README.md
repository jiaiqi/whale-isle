# tools/mock-harness — AI 自测沙盒

> 状态：**M0 已落地**（对应工单 `T-M0-04`，2026-11-15）｜ [AGENTS.md §3.2 五层铁笼·第二层](../../AGENTS.md)

AI 编程代理无法自己打开《星露谷》客户端、也无法去抖音开真实直播间——没有沙盒，AI 写完代码只能交给人类手动测。本目录提供三个**确定性仿真器**，让 AI 全程自闭环调试：

| 工具 | 作用与确定性校验逻辑 | 标识 |
| --- | --- | --- |
| `stardew-mcp-simulator` | 模拟星露谷 SMAPI Mod 的 WebSocket 服务端；内置 5 个标准剧本：① 正常种地浇水 ② 寻路卡石头返回 `uncertain` ③ 体力耗尽晕倒 ④ 玩家突然动鼠标接管 ⑤ 矿洞丝血 | `[SIMULATION]` |
| `danmaku-storm-replay` | 录制/合成标准抖音弹幕流：每秒 20 条刷屏、连击送礼、骂"大肥鱼"触发雷区、点歌指令、Prompt 注入攻击弹幕；用于压测注意力队列与防封护栏 | `[SIMULATION]` |
| `headless-stage-inspector` | Playwright for Electron 连接 `desktop-host`：截图校验透明窗渲染 WebM、透明区/非透明区 `ignoreMouseEvents` 切换、语音锁 TTL 释放 | `[E2E-HOST]` |

## 铁律

- 沙盒测试一律标记 `[SIMULATION]` / `[E2E-HOST]`，**严禁冒充真机实测**（`[REAL-DEVICE]`）写入 `docs/VERIFY.md`。
- Gate 4 目标：自动拉起 Electron Headless + Python Worker + 仿真沙盒，全链路断言（弹幕骂大肥鱼 → 0.1s 喷水反驳 → 语音锁获取释放 → 记仇账本落盘 SQLite）≤ 15 秒。
