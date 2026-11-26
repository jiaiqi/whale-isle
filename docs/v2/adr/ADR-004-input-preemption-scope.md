# ADR-004：用户键鼠抢占的作用域 —— 桌面租约与游戏租约分离

- **状态**：Accepted（2026-11-26）
- **关联**：`REQ-AUTO-01`、`REQ-SEC-02`、`V2-P3-03`、`T-M6-73`（`docs/decisions/M8-stardew.md`）、ADR-002、Blueprint 08 §2 / 11 §5 / 17
- **审查依据**：[reviews/P3-03-security-review.md](../reviews/P3-03-security-review.md)

## 背景

两条已生效的需求在字面上冲突：

| 来源 | 原文口径 |
| --- | --- |
| `REQ-AUTO-01`、Blueprint 08 §2、11 §5 | 用户键鼠动作**瞬间夺回**控制权 |
| `T-M6-73`（2026-11-25 用户决策） | 星露谷里**动键鼠不打断 AI**；宿主侧不新增键鼠检测，删除「键鼠一动即停」口径 |

如果 `V2-P3-03` 照字面实现全局键鼠监听，并把它接进统一急停，就会把 T-M6-73 的行为改回去。

## 决策

把控制权拆成两种租约，各管各的，**互不传染**：

1. **`ComputerUseLease`（设备级 · 桌面键鼠 / 前台窗口）**
   - 管 Computer Runtime 合成的鼠标、键盘、窗口切换和截屏操作。
   - 用户**物理输入**会撤销这个租约（`notifyHumanInput` → `preempted_by_human`）。验收口径是 **≤ 1 s**，不写「瞬间」。
   - 检测优先用 Electron `powerMonitor.getSystemIdleTime()` 轮询，不引入原生全局 hook。必须排除执行器自己注入的合成事件，避免把自己的操作误判为用户输入。
2. **`GameCharacterControlLease`（游戏角色级 · MCP / BWF）**
   - 只认 `F7`、界面上的「我来操作 / 交还给 AI」开关，以及 P0 急停（`F8` / `⇧Esc`）。
   - **用户在游戏窗口里的普通键鼠输入不影响它**（保持 T-M6-73）。
3. **P0 急停**同时撤销两种租约，并停止混音和对外发布。

## 后果

- `REQ-AUTO-01` 的验收改为：「同设备两个 Agent 同时申请时，后申请者被拒；用户物理输入 ≤ 1 s 撤销 `ComputerUseLease`；`GameCharacterControlLease` 不受影响」。
- 新增回归用例：星露谷 AI 自主模式下注入一次用户输入事件，断言游戏租约不变；如果此时持有 `ComputerUseLease`，断言它被撤销。
- 控制权 HUD 分开显示两种租约（见 `DESIGN-SYSTEM.md` §4），不再用一个「控制权」标签同时表达两种状态。
- 租约只能约束鲸屿自己的 Agent。外部 Harness（Claude Code、Codex 等）自带的 computer use 不受它约束，HUD 和文档要如实写明。
- macOS 的辅助功能和屏幕录制权限在开发态和打包后的 `.app` 是两个独立身份。没有权限时如实显示 `permission_denied`。
