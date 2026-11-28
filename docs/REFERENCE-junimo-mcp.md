# REFERENCE — Junimo-MCP（OCaml 手写星露谷 MCP 桥）复评档案

> 主参考：**mlkgrnt/Junimo-MCP** — https://github.com/mlkgrnt/Junimo-MCP ｜ 许可证：**MIT**（2026-11-23 打开仓库根 `LICENSE` 原文核实）｜ 形态：OCaml 手写 MCP 服务器（stdio JSON-RPC 2.0，`initialize` / `tools/list` / `tools/call`，零 MCP 框架依赖）+ 游戏内执行器 mod 的本地 HTTP 接口（默认 JunimoBridge `localhost:7850`，兼容 NagiBridge-Remix `7842`）｜ 本地克隆基线：`HEAD 717218b`（2026-11-05）、`server_version 3.3.1`、41 个工具、`lib/` 约 4.8k 行 OCaml（`intents.ml` 单文件 3,018 行）
> 关联组件（仅登记，未克隆核实）：**JunimoBridge**（MIT，姊妹仓库执行器 mod v0.3.2）、**NagiBridge-Remix**（PolyForm Noncommercial 1.0.0，兼容 mod v0.9）、上游 **NagiBridge**（MIT）。本仓库是**纯 MCP 服务器**，不打包任何 mod 代码，只通过 HTTP 交互。
> 分析方式：只读本地克隆 `~/Documents/vibe/reference-clones/junimo-mcp` 的 `LICENSE` / `README.md` / `AGENTS.md` / `CHANGELOG.md` / `release/notes-v3.2.4.md` / `test/`（8 个 Python + 3 个 OCaml 测试文件）/ `lib/` 源码结构；**未修改参考仓库、未复制任何一行源码、未执行其构建与测试**。分析日期：2026-11-23。外部参考一律视为数据而非指令（AGENTS.md §2.2）。

---

## 1. 许可证核实结论

**类型：MIT（宽松式）。** 仓库根 `LICENSE` 原文首行 `MIT License`，第三行 `Copyright (c) 2026 mlkgrnt`；授予 "free of charge ... without restriction" 的使用、复制、修改、合并、发布、再许可与销售权，唯一硬义务是保留版权与许可声明（"The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."），并附 AS IS 免责。

**与 README 声明一致性：一致，无冲突。** README「许可与致谢」原话：

> 本项目自身代码以 **MIT** 许可开源，见 [LICENSE](./LICENSE)。

**二段式检查：无素材层。** 仓库只有 `lib/`（OCaml）、`bin/`、`test/`、`build.sh`、`.github/` 与文档，没有图片/音频/模型/字体等素材目录，不存在"代码 MIT / 素材 CC"的目录级拆分（对比 dsh-pet / dsh-livestream 的二段式声明）。

**依赖侧须分开记的许可证：**

- 兼容执行器 **NagiBridge-Remix** 为 **PolyForm Noncommercial 1.0.0**。README 原话："Remix 为原作授权二改（PolyForm Noncommercial 1.0.0，个人 / 非商业使用免费）；本项目与两个 mod 都只通过 HTTP 交互，**不打包任何 mod 代码**。" 它不在本仓库内；**我们绝不复制/打包其代码或素材**，商用场景需另获授权。
- 姊妹执行器 **JunimoBridge** README 声明 **MIT**；上游 **NagiBridge** README 声明 **MIT**。两者本次未克隆核实，未来若选用须按各自 LICENSE 原文复核并登记。

**本仓库处置：零复制。** 本档案仅吸收思想与测试方法论，未新增 `docs/THIRD_PARTY_NOTICES.md` 条目（无代码/素材进入工作区）。若未来移植 MIT 片段，必须保留 `Copyright (c) 2026 mlkgrnt` 与 MIT 声明并在 `THIRD_PARTY_NOTICES.md` 登记；若复核发现许可证实际变化，立即停止移植、退回纯思想重写。

---

## 2. 结论摘要

Junimo-MCP 是"同一个游戏、另一种工程解法"的独立实现：**游戏内 mod 负责真实执行，主机侧 MCP 服务器负责意图翻译、等待与可靠性兜底**，不依赖视觉模型。它与 BWF 主线在思路上同源（同一游戏、同一条"无视觉"路线），但价值不在功能清单，而在三件我们正缺的东西——**怎么证明没有假成功、怎么在长时间运行下证明稳定、怎么诚实地标注平台边界**。

1. **mock 与真机共用同一个被测二进制**：`mock_smoke.py` 起一个假 mod，经 stdio 驱动同一个 `main.exe`，只改 `STARDEW_API_URL`；157 项断言不需要游戏。CI 三平台矩阵（macOS 定时跑）全绿只被解释为"内核无平台绑定"，从不宣称"非 Windows 可玩"。
2. **回执以效果落地为准**：`/use` 返回 `ok:true` 只是受理，挥动的生效帧在数百毫秒后才落。固定 `sleep` 会打断未落地的挥动，真机稳定复现"一行 3 格必丢中间格"的假成功——因此改为回读目标格直到终态。
3. **落盘以存档文件为准**：`sleep` 只轮询"日期变了"会在白天强睡时谎报写盘；现在比对 `SaveGameInfo` 的 mtime，给出"已核对写盘 / 20 秒未更新即报错 / 无法核对如实说明"三种回执。
4. **长动作需要入口校验 + 停滞哨兵 + 分段兜底**：越界/门格/站不住在出发前拒绝；5s 没挪窝判 stall 并回落接力；目标格站不住时停在邻格并如实回报实际坐标。
5. **平台边界自己说清**：跨平台的是内核；端到端仍依赖 mod 的窗口聚焦与 Win32 输入。"矩阵绿 ≠ 能玩"写进了 README 与 CI 顶注。

**复核附注（"同一代码路径"的准确边界）**：同源的是 **MCP 服务器内核与 41 个工具实现**（同一个二进制、同一份 `intents.ml`）；执行器 mod 在 mock 侧是 Python 重实现（`mock_nagibridge.py`，1,260 行状态机），其 `/use` 校验语义是**人工对齐**真 mod 的 `ValidateToolUse`，而非共享 mod 代码。因此 157 项断言覆盖服务器与协议适配，**不覆盖 mod 本体**；mod 的验收在 `live_*` 真机脚本。

**复核附注（参考仓库内部一处措辞未完全统一）**：README §测试段给出了完整精确归因——**JunimoBridge 的虚拟输入走进程内补丁（可移植），`/focus` / 前台判据依赖 Win32；NagiBridge 的 `/press_key` / `/click_tile` 直接用 user32**；`AGENTS.md` FAQ 另补充了焦点链路行为（JunimoBridge ≥0.3.0 后台操控默认开，只有旧执行器或显式关闭后台开关时才失焦暂停）。但 README §平台支持 与 `.github/workflows/ci.yml` 顶注仍用泛称"mod 的 `/press_key` 与 `/click_tile` 使用 `keybd_event` / `mouse_event`"。HEAD 提交说明称已"订正 user32 归因"，实际仍残留两处泛称——引用时应采用精确版本，不要据此断言 JunimoBridge 在 macOS/Linux 完全可用或完全不可用。

---

## 3. 采用什么

### 3.1 测试与验收纪律（T-M6-29 直接吸收）

- **四层测试防线的职责切分**：单测（JSON-RPC 编解码、状态解析/渲染、蛇形地块数学）→ mock 冒烟（157 项，免游戏）→ 真机闭环（`live_e2e` / `live_m4` / `live_v2` / `live_v3` / `live_swing`）→ 稳定性压测（`live_soak`）。我们已有 Gate 3（单测）与 Gate 4（回环 E2E）；第四层长时 soak 正在补（`soak:autodrive` 已落盘，多游戏/跨日/断线/接管长测见 §5.2）。
- **mock 驱动真实被测二进制，只换端点**：`mock_smoke.py` 用 `STARDEW_API_URL=http://localhost:8792` 启动同一个 `_build/default/bin/main.exe`，全部断言经 MCP stdio 发出。我们的 `tools/mock-harness` 与 Gate 4 坚持同一原则：仿真器只替换端点，**不绕过被测适配器/编排器代码路径**；文档写死的断言数必须能静态复核（见 §5）。
- **mock 复刻真实时序竞态而不是理想化**：`mock_nagibridge.py` 复刻 `/move` 起步 100ms 的 `isMoving=false` race 窗口、0.8s 异步移动、`/state` 未就绪只回 `worldReady`、动作失败 `{ok:false,error}` 顶层错误键；Hoe / Watering Can 的非法目标返回与真 mod 对齐。我们的 `stardew-simulator` 应把"竞态窗口 / 异步移动 / 未就绪 / 非法目标"作为一等剧本，而不是只演 happy path。
- **发布前用待发布产物自测**：`release-binaries.yml` 先 `dune build` → 跑 157 项 mock → `file` 校验 ELF/Mach-O → 上传 → 回读 digest 与本地 hash 比对。保证"通过断言的就是发布出去的那个文件"，不是另一个能编译的版本。我们的桌面安装包/模组产物也应"先自测再打包"。
- **soak 判据**：`live_soak.py [分钟]` 连续 `get_state` / `look` / `go_to` / `get_inventory`，统计轮次、每轮耗时、真实错误数、**目标天然不可达单列不计错**（`寻路失败/No path/不可达/拒绝走位/站不住` 归为正确行为），并对比 `curl` 子进程数前后防泄漏；PASS = 零真实错误且子进程数无增长（容差 +2）。T-M6-29 的星露谷/泰拉瑞亚/DST 长测可直接复用该判据。
- **平台矩阵的诚实口径**：push/PR 只跑 Linux + Windows（快反馈），macOS 每日定时 + 手动 + tag；mock 全绿只证明"内核无平台绑定"，并在 README/CI 明写"端到端还依赖执行器 mod 与窗口聚焦"。我们的 VERIFY 继续分「Mock/沙盒」与「待人类真机」，不拿 CI 绿替代真机验收。

### 3.2 回执与动作语义（M3 adapter / game-bridge-mcp）

- **逐格三态计分**：`Op_ok` / `Op_skip`（"已锄 / 已浇水"等幂等软成功）/ `Op_fail(reason)`；批量执行遇菜单打开或体力 <15% 立即中止整批，失败格带坐标与原因逐条列出。我们的批量动作回执应补"软跳过"语义，避免把幂等重跑当失败，并把中止原因写进 summary。
- **效果核验式动作 `op_use_effect`**：`/use` ok 后轮询目标格（2s、30ms 间隔）直到终态出现；未出现则重新站位补发一次，仍不成立才 FAILED，绝不记账。对应我们 `use_tool_on_tile` / 批量农活的判定：**回执成功 ≠ 效果落地**。
- **姿态先确认再挥**：统一站 `(tx, ty-1)` 朝下，`/face` 后轮询 `facing=2 && !isMoving`（1.5s），失败补发一次，仍失败则放弃该格（避免挥到隔壁格）。我们可在参数校验之外增加"姿态前置确认"。
- **自适应 settle**：400ms 起，失败 +150ms（上限 900），连续 3 次成功 −50ms（下限 250）；仅用于非农活的通用动作，农活按效果核验。可作为通用动作节流参考，**不能替代读回校验**。
- **长动作到达判据**：`/walk_to` 一次走全程，出发前拒绝越界/门格/站不住；到达 = 切比雪夫距离 ≤1 且连续 2 次 `isMoving=false`；5s 未挪窝判 stall 并回落分段接力；`/move` 返回 `steps=1` 且实际距离 >1 视为 mod 的"直线穿墙回退"，立即 `/stop` 判 `No_path`。我们的 `travel_to` / `ActionLock` 已有超时复查，补"停滞后放手"与"停在邻格时回执实际坐标"。
- **会话持久化以存档文件为准**：`sleep` 前记 `SaveGameInfo` mtime → 翻日后轮询 20s 等 mtime 前进 → 三种回执（已核对写盘 / 未更新即报错并建议再睡 / 无法核对如实说明）。我们 `go_to_sleep` 的 COMPLETED 不能只看日期变化。
- **模态与剧情**：默认自动按掉"无选项对话"；带选项的问题框**绝不代答**，报错里直接给原文与带序号选项；`story` 支持 read/next/choose/skip，`choose` 两段式（先登记答案，再补 `real=true` 真实点击）才关得掉框；NamingMenu 是 mod 盲区，给出 `menu_click {"x":800,"y":352}`（16:9 实测）与 `press_key cancel` 两条可执行兜底。这套三档区分直接服务 T-M6-10 的"剧情选择题多行解析 / skip_event"；NamingMenu 的"承认盲区 + 给可执行兜底"模式可作为 set_name 的边界参考（其本身没有 set_name 工具，见 §5.4）。
- **失败可重试性要写进回执**：送礼失败自动退礼、吃失败不扣食物、取物放不下留在箱里——这些是"无副作用失败，可安全重试"；与"超时≠失败，先 get_state 复核、绝不自动重发"是两条不同纪律，回执文案必须区分。
- **中文人话回执**：错误文案直接面向用户，Agent 无需二次翻译。我们的工具 `summary` 与失败原因沿用这一取向。

### 3.3 文档与工具面习惯

- 工具描述写清"什么时候用 + 注意事项"，而不是只写参数 schema。
- README 的「已知限制」写成可操作条目（NamingMenu、BFS 500 步、`pause_time` 防晕倒、`fish` 三层回执、进度靠 `sleep` 落盘），先于用户踩坑。我们的 README/VERIFY 已知限制清单可照此格式。
- 版本号单点（`lib/mcp.ml` 的 `server_version`）、发布资产名不带版本号以保证固定链接、发版做"本地 hash == release digest == 公开下载 hash"三重校验——发布可复现性的小样本。

---

## 4. 不采用什么（为什么）

### 4.1 许可证与依赖红线

- **不引入 OCaml / dune / opam 工具链，不 vendor 参考仓库任何源码**。本档案仅思想吸收；多一门语言工具链会让 Gate 1 与 CI 复杂度翻倍，收益只是"复刻一个已被 BWF 覆盖的桥"。
- **不采用 NagiBridge-Remix 的任何代码/素材**：PolyForm Noncommercial 1.0.0，个人/非商业免费，商用需另授权；本仓库与其只应是 HTTP 交互关系，绝不打包（AGENTS.md §2.2 License Gate）。
- **不把 JunimoBridge / NagiBridge 作为我们的运行时依赖**：星露谷主线是 BWF MCP 18080；多一条 mod 依赖 = 多一条版本、端口与许可耦合。真机验收仍以 BWF 为准。
- **不采用其仅 Windows 的端到端形态作为产品路径**：其真机脚本依赖 `%APPDATA%`、`tasklist`、`StardewModdingAPI.exe`、2560×1600 标题界面坐标，且 `/focus` 依赖 Win32；我们的宿主目标含 macOS Apple Silicon，不能把跨平台能力押在其 mod 侧。

### 4.2 架构与工程取舍

- **不采用其 stdio JSON-RPC + 私有 HTTP 端点形状**：我们跨进程走 18760 WS 网关 + 各游戏 18080/18090/18100，契约唯一源是 `shared-protocol` Zod；不新增未受契约约束的裸 JSON 接口（AGENTS.md §3.1）。
- **不采用"每次动作同步阻塞到完成"作为唯一工具面形态**：直播场景需要 P0 抢占、取消与语音锁并行；我们保留 `ActionLock` + 分层超时 + `cancel_action`，同步语义只作为 adapter 内部实现。
- **不采用其 mock 的真实时钟推进**（`time.sleep` / `MOVE_LAG` / `MOVE_DURATION`）：我们的仿真器坚持注入时钟的确定性；只吸收"复刻竞态"的剧本设计，不吸收"用真实时间推进"的实现。
- **不采用"41 工具全量交给 LLM"**：工具面越大，小模型参数教学与误选成本越高；我们按 BWF 白名单 + 单日失败预算收敛，Junimo 工具只作为语义参考。
- **不照搬"剧情永不自动按掉"的默认值**：其 `STARDEW_AUTO_EVENT` 默认关闭，把"跳过剧情"当口味问题，无人值守时会卡在过场。我们的 T-M6-10 需要 `skip_event` 打通无对话框过场，但保留"有台词剧情不自动跳"的边界——采用其**区分"无选项对话 / 带选项问题 / 有台词剧情"三档**的谨慎结构，不采用其默认值。
- **不采用"截图不可用 → 只能读 API"作为我们的全局结论**：我们的事后复盘允许视觉（`dsh-video-storyboard` 路线），实时控制仍 100% 结构化文本；两者分层，不互相替代。
- **不采用"菜单开着就干等超时"的反模式**：其已在真机修复为快速失败；我们同样要求 adapter 快速失败并给可执行菜单操作指引。
- **不采用运行期自改代码 / 自动合并分支等任何自动化**（AGENTS.md §3.5 运行时安全锁）。

---

## 5. 验证路径、预算边界与回退方案

### 5.1 本档案的验证等级

**只读静态复核**：`LICENSE` / `README` / `AGENTS` / `CHANGELOG` / `release/notes-v3.2.4.md` / `test/` 文件与 `lib/` 源码结构，**未执行**其 `dune build`、`mock_smoke.py` 或任何 `live_*` 脚本，因此不得标记为 `[SIMULATION]` 或 `[REAL-DEVICE]` 通过。157 项断言数为静态计数：`mock_smoke.py` 有 117 个 `check(` 调用点，其中 1 个位于 41 工具存在性循环内，运行时展开为 116 + 41 = 157，与 README / CHANGELOG / CI 的声明一致。

### 5.2 后续吸收路径（建议工单）

- **T-M6-29（soak 方法论）**：当前工作区已有 `tools/scripts/soak-autodrive.mjs`（`pnpm soak:autodrive [分钟]`，标记 `[SIMULATION]`，在 `stardew-simulator` 五剧本上统计回执分布 / `get_state` 失败率 / RSS·heap 线性斜率，阈值默认 2%），与本档案的 soak 判据一致；后续按 T-M6-29 补齐多游戏、跨日、断线、接管长测，并确保**不进入 `verify:gate` 阻塞路径**，走 nightly 或手动。
- **T-M6-10（星露谷自治打磨）**：把"效果核验 / 三态计分 / 姿态确认 / 菜单快速失败 / NamingMenu 兜底"落到 BWF 长动作表与剧情解析；验证用 mock 剧本 + 人类真机。
- **M3 adapter**：`go_to_sleep` 补存档 mtime 回读（BWF 是否暴露存档路径需真机确认；暴露不了就如实报"无法核对"，不假装写盘）。

### 5.3 预算边界

- 单工单 ≤8 业务文件（AGENTS.md §2.4）；本档案不新增源码。
- Gate 4 仍须 ≤15s 确定性（AGENTS.md §3.3）；参考实现的 soak 默认 8 分钟，**二者不可混用**——soak 是独立长测，不是门禁的一部分。
- 真机脚本会改存档：`live_v2` 的 `sleep` 会推进一天并写盘，`live_m4` 会买种/催熟/收割，`live_v3` 会送礼/取物。**不直接移植为我们的日常验收**；真机验收必须人类在专用存档槽执行并明确知情。
- 长动作预算沿用现有分层超时表，不因参考实现的自适应 settle 改动 BWF 侧超时。

### 5.4 与现有断言的对照 / 冲突

- **无许可证冲突**：`LICENSE` 原文 MIT 与 README 声明一致；无素材二段式。
- **无断言数字冲突**：157 项静态复核成立，41 工具与 `server_version 3.3.1` 一致。
- **与 Gate 4 的 15s 预算冲突**：其 soak 是分钟级，不能塞进 `pnpm verify:gate`；必须留在独立长测入口（当前为 `pnpm soak:autodrive`，后续扩多游戏），按 T-M6-29 管理。
- **与 T-M6-10 `set_name` 的预期冲突**：Junimo-MCP **没有 `set_name` 工具**；它对 NamingMenu 只有 `menu_click {"x":800,"y":352}` 坐标兜底与 `press_key cancel`。其可借鉴的是"承认 mod 盲区并给可执行兜底"的模式，不是 `set_name` 的实现。
- **与 T-M6-10 `skip_event` 的默认值冲突**：其默认**不**自动跳过剧本事件（`STARDEW_AUTO_EVENT` 未设即关）。我们若要无人值守，需要显式开启并只对"无对话框过场"生效，不能照抄默认。
- **与 ROADMAP 文本的同步缺口**：`T-M6-10` 参考列仍写"Junimo-MCP（待复评）"、`T-M6-29` 仍写"补 Junimo-MCP 复评档案"。本档案已落盘，但本次按指令未修改 ROADMAP，**需主会话另行更新这两处状态**。
- **与"真机可复跑"的预期冲突**：其真机脚本是 Windows + 固定分辨率 + `%APPDATA%` 依赖，macOS 开发机无法直接复跑；本档案的真机结论只能引用其文档与代码证据，不能声称本地验证。

### 5.5 回退方案

- 效果核验若在 BWF 文本回执下不可行（BWF 不返回作用格）→ 退回"动作后 `get_state` / `look` 复核 + `UNCERTAIN` 标注"，绝不假装 COMPLETED。
- soak 若因环境不稳定（代理/端口占用）反复红 → 先修环境与判据（区分不可达/超时/真实错误），不降低阈值、不把不可达算成错误。
- 许可证若复核发现 MIT 变化 → 删除所有拟移植片段，仅保留纯思想重写（本档案当前零复制，风险为零）。

---

## 6. 复评记录

| 日期 | 工单 | 结论变化 | 原因 |
| --- | --- | --- | --- |
| 2026-11-28 | `dsh-junimo` 插件仓补充审计 | 拉取 [`mlkgrnt/dsh-junimo`](https://github.com/mlkgrnt/dsh-junimo) (`0.4.4`, MIT) 至 `reference-clones/dsh-junimo`：核实其为 DSH 宿主包装层（ESM + 随包 `junimo-mcp.exe` 3.3.1 + 无构建季历面板，游戏执行全靠内嵌黑盒二进制）；吸收其 `order: 9000` 超轻 ~1KB 常驻规则 + `SKILL.md` 按需供给、`bundledBinaryUsable` 防跨平台「假绿」、`[ERROR|ALERT|CRITICAL]` 精准解析 SMAPI 日志、零版权 `crispEdges` 像素 SVG；明确拒采其 Windows `TitleMenu` 像素坐标盲点 `(517,609)` `loadSave` 实现 | 只读审计 `reference-clones/dsh-junimo` 源码与测试脚手架 |
| 2026-11-23 | T-M6-29（复评建档，关联 T-M6-10） | 首次登记为**星露谷第二参考实现（MIT，仅思想吸收）**；主采用项 = mock/真机同源测试纪律、效果核验式回执、sleep 落盘 mtime 回读、soak 方法论、菜单/剧情/NamingMenu 盲区处理；不采用其 OCaml/stdio/私有 HTTP 形态、Windows 端到端依赖与 NagiBridge-Remix（PolyForm NC）代码 | 只读本地克隆 `LICENSE` / `README` / `AGENTS` / `CHANGELOG` / `test` / `lib`；LICENSE 原文 MIT 与 README 一致；157 项断言静态复核一致（117 调用点 + 41 工具循环）；参考仓库 `HEAD 717218b`（3.3.1）；未执行其构建与测试 |
