# V2-P3-04 Digital Life L1 验收证据（自主浏览、多模态内容理解、兴趣形成与日常调度）

> 日期：2026-11-26 · 分支：`feat/whale-isle-v2` · 拆分：owner 批准 A–F 六个原子工单（依赖 A →（B ∥ C）→ D → E → F）
> 需求锚点：REQ-SOC-01（L1 只读学习与兴趣沉淀）、REQ-LIFE-01（日程/预算/注意力）

## 一、交付清单

| 子工单 | 交付 | 关键文件 |
| --- | --- | --- |
| P3-04A | 契约先行：social 域 + 多模态消息 parts | `packages/shared-protocol/src/social.ts`、`model.ts`、`social.spec.ts` |
| P3-04B | 网关多模态：OpenAI image_url / Anthropic image block 双协议映射、脱敏、视觉预检、入站校验 | `packages/model-gateway/src/gateway.ts` |
| P3-04C | SocialRuntime L1 只读浏览内核（状态机/能力门禁/预算收官/事件广播） | `packages/character-core/src/social-runtime.ts` |
| P3-04D | 内容理解管线 + 兴趣沉淀（窄端口注入反转，character-core 不直连 memory-graph） | `packages/character-core/src/content-understanding.ts`、`interest-sink.ts` |
| P3-04E | 日程接线与状态可见：social 预算守卫、宿主装配、9 路 `v2:social-*` IPC、中控台 L1 面板 | `apps/desktop-host/src/main/v2-kernel-host.ts`、`life-console-view.tsx` |
| P3-04F | `[SIMULATION]` social-site-sim 站点仿真器 + `[E2E-HOST]` 全链路 + pet-stage 思考泡投影 | `tools/mock-harness/src/social-site-sim.ts`、`apps/desktop-host/e2e/social-life.e2e.spec.ts` |

## 二、验证证据

- **`[SIMULATION]` 单测**：shared-protocol 契约 9 例（readonly 字面量拒绝 readwrite、预算上下限、兴趣幅度 ±0.5 封顶、parts 上限与 mime 枚举）；model-gateway 30 例（含 6 例多模态：双协议映射/脱敏/MODEL_NO_VISION 预检/入站校验），包分支覆盖 94.27%；character-core 40 例（SocialRuntime 状态机/能力门禁/热更新 + 理解管线 JSON 抽取容错/解析失败不编造 + 兴趣沉淀映射/噪声门槛/端口可选 + LifeRuntime social 预算守卫）。
- **`[SIMULATION]` 仿真器**：social-site-sim 3 例（夹具确定性 + 契约校验、prompt 注入内容页、HTTP 索引/文章/404 + data-simulation 标识）。
- **`[E2E-HOST]` 全链路**（`social-life.e2e.spec.ts` 1/1）：能力未授权拒绝 → 未实测拒绝 → 声明已实测 → 规划 → 启动 → 真实 runner 读取本地仿真站（不访问公网）→ 计数达 maxItems 自动 budget_exhausted 收官 → 无供应商 Key 时内容理解诚实报错「网关未就绪」（不编造）→ 快照如实反映 → pet-stage 思考泡投影「在读：…」。
- **回归**：v2-kernel e2e 1/1、ui.e2e 9/9、tray-popover e2e 本地连跑 4 次（启动竞态修复后）。
- **门禁**：每个子工单提交均过 `pnpm verify:gate` 7/7（pre-commit 钩子强制）。
- **CI**：A/B/C/D/E 与 flake 修复共 6 次推送全部转绿。

## 三、为什么整单不是 DONE（`IMPLEMENTED_UNVERIFIED`）

1. **真实供应商多模态联调**未做：理解链路在 E2E 中走「无 Key 诚实报错」路径，真实 Anthropic/OpenAI 兼容端点的 image block/image_url 上行与回执需真实 Key 实测。
2. **真实平台浏览**未做：L1 只读浏览真实站点（登录态/风控页/验证码样式）需逐平台人工实测后声明能力矩阵（`lastVerifiedAt` 只接受人工声明，程序不得自编）。
3. **scheduler tick 自动发起会话**的循环未接：当前会话由手动/事件驱动，LifeRuntime 日程槽自动触发浏览属后续增强。
4. **内容安全实测**：真实网页的提示词注入在模型侧的鲁棒性（仿真站注入页仅验证「按数据处理」的链路，未验证真实模型抗注入表现）。

## 四、诚实口径声明

- 演示与仿真数据均有标识：仿真站页面带 `data-simulation`；无 Key 时理解链路如实报错不编造。
- L1 硬边界三层防护：契约 `interactionMode: z.literal('readonly')` + SocialRuntime 互动能力运行时拦截 + 能力矩阵「授权+已实测」双条件。
- 凭据：理解链路复用 autodrive Gateway 与饭碗计量，凭据永不下行明文；网页与模型文本一律按不可信数据处理。
