# VERIFY — 验收标准矩阵

> **铁律**：严禁将静态代码阅读、单元测试或仿真沙盒测试（`[SIMULATION]` / `[E2E-HOST]`）冒充为真机实测（`[REAL-DEVICE]`）。
> 每行证据必须附**真实终端输出摘要**（命令 + 关键断言行），禁止"应该能过"式描述。
> 填写流程：AI 完成工单 → 跑 `pnpm verify:gate` → 在「Mock/沙盒验证已通过项」补一行证据 → 真机相关项**永远**留在右栏等人类宿主亲手验收。

## 状态总览（按里程碑）

| 里程碑 | Mock/沙盒验证已通过项（`[SIMULATION]` / 单测 / 编译） | 待人类宿主真机验收项（`[REAL-DEVICE]`） | 最近更新 |
| --- | --- | --- | --- |
| M0 地基与铁笼 | （未开始） | 无需真机：宿主查看 `pnpm verify:gate` 全绿即可放行 | — |
| M1 大肥鱼复活 | （M1-01~05 全部过沙盒+真实 Electron E2E） | **OS 级真实点击穿透与鼠标拖拽手感**（E2E 只能验证状态机与坐标夹紧，无法模拟 OS 级点击落点）；气泡长文本观感与水印章贴位置；在 Mac 桌面拖拽"大肥鱼"；输入框打一句"大肥鱼"，确认瞬间喷水破防并弹出 `<think>` 内心戏气泡（需 webm 资产就位后联测） | 2026-11-15 |
| M2 本地语音与点歌 | （T-M2-01 语音锁、T-M2-02 情绪 TTS 已过单测/契约夹具） | 听 Mac M 系列芯片本地生成的傲娇语音延迟；点一首歌听她用自己的声音唱出来 | 2026-11-15 |
| M3 星露谷共玩 | （未开始） | 打开《星露谷》看她翻垃圾桶/种菜；晃一下鼠标，确认她立刻停手变场边啦啦队 | — |
| M4 直播与切片 | （未开始） | 在 OBS 添加 `http://localhost:18765` 浏览器源，挂测试直播间看她边玩星露谷边回弹幕、记仇和唱歌 | — |

## 证据记录格式（每条一行）

```
| <工单号> | <验证方式：[SIMULATION]/[E2E-HOST]/[REAL-DEVICE]> | <命令与关键断言摘要> | <日期> |
```

## Mock/沙盒验证已通过项

| 工单 | 验证方式 | 证据摘要 | 日期 |
| --- | --- | --- | --- |
| T-M5-01 | `[E2E-HOST]`（入库素材 + 契约断言） | `pnpm test`：manifest-asset.spec 3 项——manifest 过契约、11 语义槽位全覆盖、素材路径全相对（D14 随包）、sleep 循环段、ambientPool ≥70 条 + 睡眠接力 weight=0 不可达、pickAmbient 加权确定性（rng 0/0.9999 边界 + 200 次随机不可达验证）；`gen:pet-manifest` 实跑：114 素材 → 11 槽位（37 clips）+ ambientPool 77 条；license-scanner 100 源文件 0 违规（台账已登记 CC BY-NC-SA） | 2026-11-21 |
| T-M5-02 | `[E2E-HOST]`（Electron + 真机 BWF MCP） | 真机链路：BWF MCP bind → load_save 泡泡湾（春16 06:00）→ Shell「启动自动驾驶」→ **游戏真实被驱动**：read_mail 7 封 COMPLETED → water_crops COMPLETED → travel_to Beach，游戏时间 06:00→06:50；`/fish 5` 指令 P0 插队 ✓；监控页 15 条真实回执；网络错误/不可解析状态走 watchdog 不盲跑（断言）。单测：game-bridge-mcp 20+ 用例（SSE/JSON 双解析、前缀括号平衡、超时≠失败、互斥、卡死哨兵时钟注入、RulePlanner 全日程分支、autodrive 全路径）覆盖率分支 90% 达标 | 2026-11-21 |
| T-M6-01-LLM | `[E2E-HOST]`（真机 DeepSeek 全链路） | planner:status llmReady ✓（vault safeStorage 解密→gateway 构造）；**chatSay 真回话**："小鲸，今天的防风草长势怎么样呀？"→"哼，主人终于想起来问农田的事啦！防风草长得可好了，都冒两片叶子了～不过别以为夸夸就行，记得给我加餐哦！"（傲娇人设）；雷区「大肥鱼」→ reflex:true 0-token 直出喷水抗议 ✓；planner:switch llm ✓ + guides:load 7 专题注入 ✓；**LLM 决策铁证**：背包满 → eat 海草「先把这个海草吃掉腾一格出来，不然连鱼都没地方放啦！」（LlmPlanner 原创造，RulePlanner 无此文案）——Beach 钓鱼推进至 11:00；单测 LlmPlanner 5 项（JSON 三形态提取/白名单越权拒绝重问/网关错误兜底/菜单绕过） | 2026-11-22 |
| T-M5-15 | `[E2E-HOST]`（wiki 实抓 + 游戏内闭环） | `pnpm forage:guides:export`：7 专题实抓（钓鱼/采矿/节日/结婚/沙漠/姜岛/农场类型，wiki HTTP 403 → curl 兜底）→ 归档 guide-forager/*.md（frontmatter 来源+sha1）→ 导出 Mod guide/；**重启游戏后 `get_guide {"topic":"钓鱼"}` 返回 guide-forager 归档的 Stardew Valley Wiki 最新攻略**（frontmatter 完整可见）✓；单测 9 项离线全路径（清洗/去重/薄页/错误/容错/混合页） | 2026-11-21 |
| D16-饭碗 | `[E2E-HOST]`（Electron 双窗联动） | 自动驾驶回执扣米 → 档位边沿广播 → 桌宠档位动作（RICE_LEVEL_ACTION_MAP）；E2E：`riceFeed(90000)` → balance 102420 → full 档 → happy_maid 池真实切换（优雅女仆舞）✓；hungry 档因初始 12.48% 已在线下、边沿触发策略避免每回执刷动作 | 2026-11-21 |
| T-M6-02 | `[E2E-HOST]`（真机 ACP + 模拟器单测） | 真机：gemini --acp 握手 ✓（protocolVersion 1 + authMethods）；dsh --profile acp 握手 ✓（deepseek-harness-acp）+ 真实会话创建 ✓（对话报 API key 失效——auth-required 如实透传 UI）；协议实测修正：dsh 需显式 jsonrpc 字段。单测：harness.spec 20+ 用例（模拟器驱动：握手/会话/流式 update/权限请求+YNA 回填/agent 退出 pending 清理/鉴权错误/未知通知容错/孤儿响应/防御分支全激活）。Shell Harness 页签 E2E：dsh 启动→事件流 initialized→session-started→auth-required ✓ | 2026-11-21 |
| T-M5-16 | `[E2E-HOST]`（Electron 双窗联动） | Shell 动作库页：11 语义槽位卡 + 77 氛围池分类（吃/玩/时节/余额/小动作/睡眠接力）渲染 ✓；槽位预览：点 rage_spray「用鲸鱼尾巴拍打地面」→ 桌宠窗 src 切换 ✓；ambient 单条预览：「放风筝」→ 桌宠窗即播放风筝.webm（playClip 零黑帧链路，失败保留旧画面断言）✓；素材零闲置审计：114 clips 槽位∪池全覆盖 + 无重复挂载断言；emotion-map 三层映射全合法槽位 + classifyAutodriveReceipt 七类断言；ESM __dirname 修复后 IPC manifest ✓ | 2026-11-21 |
| T-dir-01 | `[E2E-HOST]`（Electron 真机 + CDP DOM/IPC 验收） | `pnpm --filter @workbench/desktop-host build` ✓ → Electron 38 启动双窗（pet-stage + 大肥鱼中控台）；playwright-core connectOverCDP DOM 验收：9 供应商卡 / 3 套餐胶囊 / 6 槽位下拉 / `window.directorBridge` 挂载 / E2E data-* 选择器兼容；IPC 实测：`saveProviderKey('deepseek-official', 假key)` → ok+掩码 `sk-t••••••••cdef`、`providerKeyMask` 回读一致、vault 文件内容仅 safeStorage 密文（明文 0 落盘）、未存 key 的 `discoverModels` 返回结构化错误不崩；`pnpm verify:gate` 4 过全绿。修复记录：better-sqlite3 ABI 冲突（Node 137 vs Electron 139）→ 凭据库改文件 KV；E2E 与开发实例 userData 互踩（IndexedDB LevelDB 锁 → 白屏）→ PET_STAGE_E2E 独立 userData，30s 超时 → 756ms | 2026-11-21 |
| T-M0-01 | `[SIMULATION]`（规则引擎） | `pnpm lint:deps`：`no dependency violations found (7 modules, 5 dependencies cruised)`；临时探针 `zz-tmp-violation.ts`（import `ws`）实测命中 `shared-protocol-runtime-only-zod` 报错且 exit≠0，删除探针后恢复全绿 | 2026-11-15 |
| T-M0-01 | 编译 | `pnpm verify:gate`：Gate 1（tsc -b + depcruise）PASS、Gate 2（台账+密钥扫描）PASS，Gate 3/4 按计划待 T-M0-03/04 接线 | 2026-11-15 |
| T-M0-02 | `[SIMULATION]`（契约单测） | TS 侧 `pnpm test`：11 passed（大肥鱼夹具 parse/默认值/非法值拒绝/语音锁 TTL 边界/回执枚举/干饭套餐槽位）；Python 侧 `pnpm py:test`：4 passed（同一夹具回放 + 默认值一致性）——夹具双侧 probe 通过 | 2026-11-15 |
| T-M2-02 | `[SIMULATION]`（Python 路由单测 + TS 宿主侧单测） | `pnpm py:test`：23 passed（门禁①`[傲娇反驳]`→命中 `ref/tsundere_refuse.wav`；门禁②返回有效音频流：非空且可解析 WAV（24kHz、帧数=时长）；门禁③口型包络：viseme 序列非空、起始 0、时间连续推进、与 totalDurationMs 一致，标点→closed 停顿；本地失败→云端降级（degraded=True 如实上报）；云端也失败→向上抛错不吞；契约形状对齐 TtsSynthesisResultSchema）；`pnpm test`：170 passed（TS 侧门禁①情绪→参考音频 ②未知情绪回落默认 ③情绪→桌宠动作映射（5 档 + 未知→idle）④口型包络→时刻口型/采样时间线 ⑤合成结果→语音租约（ttl=时长+3000、动作、字幕、内心戏）⑥ttl 上下界钳制）；覆盖率四维 92.0–99.5% 达标 | 2026-11-15 |
| T-M2-01 | `[SIMULATION]`（受控适配器 + pytest） | `pnpm test`：162 passed（audio-lease 6 项）——门禁：并发注入 5 条混合优先级请求 → 回执序列 {a1:INTERRUPTED_BY_P0, p0/a2/a3/a4:COMPLETED}、`activeCount` 全程 ≤1、`playing` 集合 ≤1（绝无双音轨）；TTL 30ms 到期 → TTL_EXPIRED 且队列继续；设备错误 → AUDIO_DEVICE_ERROR 队列继续；cancel 丢弃排队租约；P0 到达即抢占在飞（不排队）。Python 侧 `pnpm py:test`：12 passed（/health 硬件探测、/tts/synthesize 确定性 WAV stub 同参同输出、/ws/audio JSON-RPC ping/speak/空参/未知方法/坏 JSON 四类错误码）；`pnpm py:mypy --strict`：4 source files Success；覆盖率四维 92.1–99.5% 达标（本轮补 13 项边界用例：预算 0 被契约拒绝、无 durationMs 兜底、右墙反弹、os 探测兜底、400 体不可解析、无 choices 兜底、dispose 幂等等；并删除 3 处契约不可达死分支） | 2026-11-15 |
| T-M1-05 | `[E2E-HOST]`（Playwright Electron 双窗口） | `pnpm test`：144 passed（desktop-host 新增 5 项）——① 双轨气泡：E2E 几何断言两 rect 不相交 + 截图留证 `artifacts/pet-stage-bubbles.png`（人工复核：云朵半透明 `<think>` / 对话泡 / 🥣6% 饿瘪饭碗 / DEV-ASSET-ONLY 水印+署名均真实渲染）；② director：点击胶囊序列 🍚→🛡️ 每步 Dexie `activeDiningProfile` 键值断言、刷新后持久恢复、六槽位绑定随套餐联动；气泡观感（长文本溢出裁剪）记录为真机抽检项 | 2026-11-15 |
| T-M1-04 | `[SIMULATION]`（组件单测） | `pnpm test`：139 passed（persona-brain 新增 26 项）——门禁：`reflex("你这大肥鱼…")` 单次 <10ms 实测通过且 1000 次 <100ms，返回 `P0_INTERRUPT` + `rage_spray` + `consumedMainBrainTokens=false`（预设台词直出，主脑零调用）；雷区冷却窗口（8s 内跳过、冷却中可命中其他规则）；`<think>` 流式剥离跨块悬挂（"<thi"/"</thin"）与未闭合兜底；情绪五档前缀 → emotionTag 映射；饭碗 1粒米=1Token 扣费/15% 饥饿线→hungry_lazy/下饭菜 Buff 过期与 ×2 热情夹紧 [1,5]；装载期非法正则拦截（防 ReDoS）；覆盖率四维 90.6–98.6% 达标 | 2026-11-15 |
| T-M1-03 | `[SIMULATION]`（fake fetch 注入） | `pnpm test`：113 passed（model-gateway 新增 26 项）——门禁①：429→静默 failover 实测 <100ms（attempt=1 落 siliconflow）；门禁②：出站 body 捕获断言敏感路径/密钥/用户名 100% → {{MASKED}}（残留 0）；500/网络错误/非 Error 抛出/PROVIDER_MISSING/KEY_MISSING/PARSE_ERROR 全部静默切换并附尝试明细，400 即抛不浪费候选；粘性会话同节点（PROMPT_CACHE_STICKY）+ ROUND_ROBIN/LOWEST_LATENCY 候选序；usage 只记供应商实报（1200/900/80）；secretMaskingEnabled=false 原文直传；覆盖率四维 91.7–98.9% 达标 | 2026-11-15 |
| T-M1-02 | `[E2E-HOST]`（Playwright Electron） | `pnpm test`：78 passed（desktop-host 新增 11 项）——真实 Electron 38 启动：alwaysOnTop API 真值 + meta 双证（transparent/frameless/skipTaskbar）；alpha 状态机 force(255/21)→interactive、force(20/0)→passthrough（阈值 20 边界全覆盖，经 passthrough:get 主进程回读）；dragTo(999999,999999) 被合并 workArea 夹紧、dragTo(40,40) 精确落位；测试钩子由 PET_STAGE_E2E=1 门控；覆盖率四维 90.3–97.1% 达标 | 2026-11-15 |
| T-M1-01 | `[SIMULATION]`（组件单测） | `pnpm test`：67 passed（pet-renderer 新增 18 项）——零黑帧时序断言（show(new) 严格先于 hide(old)/detach(old)；新片加载失败旧画面保留不黑屏）、同动作短路/force 重切/切换互斥 SWITCH_IN_PROGRESS、DEV 素材自动挂 [DEV-ASSET-ONLY] 徽标+署名（COMMERCIAL 不挂）、脚底布局纯函数（0.5→620/1.0→440）、Q 弹（落地压扁/体积守恒/收敛/强度截断 3）、加权选片含权重全 0 退化；工厂优先级 bug（load > 构造器）由测试暴露并修复；覆盖率 ≥90% 门槛达标 | 2026-11-15 |
| T-M0-04 | `[SIMULATION]`（沙盒自检） | `pnpm test`：46 passed（6 文件；mock-harness 新增 19 项）——stardew-mcp-simulator 5 剧本全断言（含互斥锁 ACTION_IN_FLIGHT / UNCERTAIN×2→FAILED 防死循环 / 接管中止 <100ms 实测 / 回执出站经 StardewMcpActionReceiptSchema 校验）；danmaku-storm-replay 5 项（1000 条 100% 过 Schema、同 seed 确定性回放、雷区/点歌/Prompt 注入/连击夹具齐备）；license-scanner 5 项（临时 fixture 实测密钥/禁源/GPL 报错 exit≠0 + 真实仓库全绿）；5 剧本顺序执行实测 <3000ms；mock-harness 纳入全局覆盖率后四维 92.2–96.9%（≥90% 门槛达标） | 2026-11-15 |
| T-M0-03 | `[SIMULATION]`（存储单测） | `pnpm test`：27 passed（含 local-store 15 项：记仇标签去重读写/好感榜单/隐私一键擦除/Token 流水 1粒米=1Token 汇总/点歌缓存命中计数/文件库 WAL 重开持久化/脏数据容错；Dexie fake-indexeddb 3 项）；覆盖率四维 100%（门槛 ≥90%） | 2026-11-15 |
| T-M0-02 | 编译 | `pnpm gen:contracts`：17 份 JSON Schema + workbench 合并视图（17 $defs 去重冲突检测）→ `protocol_models.py`（0 个 Any 化残留）；`mypy --strict` Success（仅生成物 assignment 豁免，理由记录于 mypy.ini）；`ruff` All checks passed | 2026-11-15 |

## 待人类宿主真机验收项

| 里程碑 | 验收内容 | 状态 | 验收日期 |
| --- | --- | --- | --- |
| — | （暂无——各里程碑真机抽检项见上方状态总览） | ⏳ | — |
