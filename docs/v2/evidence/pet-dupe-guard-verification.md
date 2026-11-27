# 副宠同角色重影治理 + 启动自动出现副宠排查（2026-11-27）

> 口径：本文全部为代码阅读 + `[SIMULATION]` 单元测试证据，**不是真机/真桌面验收**。
> 运行中的客户端（工作区 `lancetfish`，SHA `e114b5f`，PID 88987）**需重启后才会加载本修复**。

## 1. owner 反馈

启动后桌面同时出现两只：

1. 主桌宠「小鲸（蓝鲸女仆）」（`agentId === 'default'`）
2. 副宠「小鲸（蓝鲸女仆）· 桌面伙伴」（`agentId !== 'default'`）

右键菜单两套是设计（`pet-context-menu.ts` 按 `isDefault` 分支，单测已钉死），不改。

## 2. 根因（任务 B）

**不是**「启动恢复上次多宠布局」：`pet-window-manager.ts` 不读历史窗口自动重开，
启动路径只有 `index.ts:1424` 的 `open('default', prefs.characterId)` 一只。

真实链路（四个条件叠加）：

1. `work-follow.json = {"mode":"multi"}`，且 `logWatchEnabled` 默认 `true`。
   `ingest()` 在**新会话的首个事件**就调用 `summon(characterForWorkFollow(event))`
   （`work-follow-host.ts`），而启动后 owner 自己正在跑的 Claude Code / Codex 会话
   持续产生 hook / log-watch 事件 → 无需任何桌宠操作，几秒内就会召唤 `crosspet-*`。
2. 运行中的 `lancetfish` 工作区 `assets/pet-packs` **只有 README + SYNC-MANIFEST**，
   crosspet 素材未同步（`pnpm sync:pet-packs` 未在该 worktree 跑）。
   `crosspet-claude` 因此**不在角色注册表**。
3. 修复前 `summonPet()` 不校验角色是否存在，直接 `manager.open(agentId, 'crosspet-claude')`。
4. `pet:character-manifest` 对未知 id 回退到 `selected()`（即当前主宠），
   `pet:context-menu` 同样回退到 `selected()` → 这只未知角色窗口被渲染成
   **第二只「小鲸（蓝鲸女仆）」**，右键标题显示「小鲸（蓝鲸女仆）· 桌面伙伴」。

证据：`~/Library/Application Support/Whale Isle/pet-window-prefs.json` 中
**从未存在** `characterId = blue-whale-maid` 的非 `default` 窗口；历史副宠全是
`crosspet-* / aboutme-* / egg-*`。所以屏幕上的第二只「小鲸」只能是未知 id 的回退渲染。

**结论**：多 AI 同屏（`multi`）本身是设计；但「未安装角色被静默渲染成主宠」是 bug。
修复后：

- 素材未同步时：`summonPet` 拒绝（`角色不存在：crosspet-claude`），work-follow 记 `console.warn`，桌面不再出现假主宠。
- 素材同步后：正常显示各自 CrossPet 角色（Claude / DeepSeek…）。
- 不想要多只：中控台 → 桌宠工作室 → 工作跟随 → 点「单宠换装」（`work-follow:mode=single`），或关闭对应 CLI 的 hook / log-watch。

## 3. 入口收口（任务 A）

统一判定放在 `pet-control-host.ts`：

- `pajamaVariantOf()` / `characterFamilyOf()`：基础角色与 `*-pajamas` 睡衣变体**双向归一**为同一角色家族。
- `findCharacterHolder()`：找出除 `exceptAgentId` 外已占用该角色家族的窗口。
- `assertCharacterAvailable()`：角色不存在 → 可读错误；已被别的窗口占用 → `该角色已在场（<agentId>）`。

收口的入口：

| 入口 | 位置 | 语义 |
| --- | --- | --- |
| `pet:window-open` | `index.ts:829` | 未知角色/已被占用 → `{ok:false,error}` |
| `pet:window-prefs-set`（仅换角色时） | `index.ts:841` | 已被占用 → `{ok:false,error}`；纯 scale/locked 原样放行 |
| `pet:summon` / `summonPet` | `pet-control-host.ts:132` | 角色不存在 → 拒；同角色（含睡衣）已在场 → 聚焦并返回原 agentId，不新开窗 |
| work-follow `summon` | `index.ts:711` | 走 `summonPet`，失败记日志 |
| work-follow `switchCharacter` | `index.ts:718` | 走主宠 `switchDefaultCharacter`（twin 对调） |
| 串门彩蛋 `summonEgg` / `eggTheater.openEgg` | `pet-control-host.ts` / `index.ts:583` | 同角色不并存 |
| 协作大厅 `coop:start` 开窗 | `coop-host.ts:476` | 同角色不并存，拒绝启动第二个同角色端点 |

**语义选择**：主宠切换仍走既有 twin 对调（用户期望一定成功）；**副宠**要占用
别人已持有的角色时**返回可读错误**，不做隐式对调——协作大厅里静默把别的 AI 换成
另一个角色会更令人意外，且可能级联；可读错误可预测、非破坏。

## 4. 验证（`[SIMULATION]`）

```
pnpm typecheck                         # tsc -b 零错误
npx vitest run apps/desktop-host/src/main/pet-control-host.spec.ts   # 13/13
npx vitest run work-follow-host / coop-host / pet-context-menu / pet-window-manager spec  # 46/46
pnpm verify:gate                       # 见 PR / CHANGELOG
```

新增单测覆盖：

- 副宠想换主宠占用的角色 → 统一校验返回 `该角色已在场（default）`；
- `summonPet` 同角色 → 返回现有 agentId，不新开窗；
- 基础角色 ↔ 睡衣变体双向占用都命中（不会「白天基础、夜里睡衣」绕过）；
- work-follow 代理自定义角色连续召唤只保留一只；
- 召唤未知角色 → 拒绝，零开窗。

## 5. 参考仓能力域对照（复用 / 重写 / 拒绝）

| 参考仓 | 同类能力 | 结论 |
| --- | --- | --- |
| `dsh-desktop-petbox/stage/main.js` | 单实例锁 + `peers = new Map()`（port → peer，按身份 upsert，不重复登记） | **吸收思想**：以稳定身份键（本仓为 `characterId` 家族）维护「在场表」，重复请求 upsert/聚焦而非新建。 |
| `dsh-pet` | 单桌宠，无多实体并存问题 | **不适用**，无可复用实现。 |
| `t3code/apps/desktop/src/electron/ElectronWindow.ts` | 通用 Electron 窗口服务，按 window id 管理，不承诺「一实体一窗」 | **拒绝直接照搬**：它解决的是窗口生命周期，不是业务唯一性；本仓唯一性属于角色域，放在 `pet-control-host` 更合适。 |

实现为自研纯函数（无外部代码复制），符合许可证洁癖。

## 6. 未覆盖 / 待真机

- 本修复只保证**新开窗/换角色**不再产生同角色重影；**已经开着的**重复窗口需重启客户端消失（不做热迁移）。
- `[REAL-DEVICE]` 验收：重启 `lancetfish` 客户端 → 确认启动后桌面只有一只主宠；同步 crosspet 素材后再确认多 AI 各自角色互不重影。
