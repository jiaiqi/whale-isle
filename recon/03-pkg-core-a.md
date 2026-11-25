# 03 · 四个核心逻辑包事实底座

> 调查对象：`packages/shared-protocol`、`packages/model-gateway`、`packages/persona-brain`、`packages/live-stream-hub`
> 调查日期：2026-11-24 ｜ 方式：只读（通读 4 包全部 `src/*.ts`，检索全仓 import / 依赖 / 文档声明）
> 说明：任务指定路径 `.zwork/recon/` 被运行时保留、禁止写入，本报告改落在 `recon/03-pkg-core-a.md`。
> 调查期间执行过 `vitest run`（4 包子集，产物 `coverage/` 已被 .gitignore 忽略）与一段只读 `tsx -e` 脚本（比对已提交 schema 与源码，不写仓库）。
> 工作区既有的未提交改动 `mods/stardew-avatar-sync/publish/manifest.json` 与本次调查无关，未触碰。
> 证据等级：**[A]** 一手代码 ｜ **[B]** 仓库内文档（AGENTS / README / ROADMAP）｜ **[C]** 本次实测输出 ｜ **[D]** 推测。

---

## 0. 结论摘要

1. 四个包的**骨架与文档描述基本吻合**：shared-protocol 是 Zod 单点事实源（`src/index.ts` 内联 97 个 Schema），model-gateway 是「预设库 + 粘性路由 + 脱敏 + fetch 直连」的统一出口，persona-brain 是纯规则三层人格引擎，live-stream-hub 是「校验 → 护栏 → 去重 → 合并/衰减/分档 → 批次广播」的内部事件中枢。**置信：高**。
2. 三处**文档明显跑在代码前面**：① 「跨语言自动生成」只有 JSON Schema + Pydantic 有脚本，TS 类型是手写 `z.infer` 别名，且 **69 个已提交契约中 6 个落后于源码**（无门禁校验漂移）；② **抖音/dyhub 真实接入代码为零**，live-stream-hub 只吃归一化内部事件；③ **P0/P1/P2 抢占在 live-stream-hub 中完全不存在**（源码 0 命中），只有「同观众合并」是真的。**置信：确定**。
3. 「Token 饭碗/扣费」的真实运行链路不在 model-gateway，也**不是** persona-brain 的 `RiceBowl`（该类运行期无人引用），而是 `apps/desktop-host/src/main/token-meter.ts` 的 JSONL 流水；且计费只算 `input+output`，**缓存命中 token 照扣全额**。**置信：高**（引用链完整；「无引用」属穷举检索结论）。

---

## 1. 规模与依赖总览

### 1.1 文件数 / 行数（实测 `wc -l`）

| 包 | src 非 spec | src spec | 其他 | 合计（src） |
| --- | --- | --- | --- | --- |
| shared-protocol | 2 文件 / 1644 行（index.ts 1491、registry.ts 153） | 2 文件 / 492 行（index.spec 408、voice-studio-contracts.spec 84） | `schema/` 70 文件 / 13133 行；`fixtures/` 1 文件 / 56 行 | 2136 行 |
| model-gateway | 6 文件 / 881 行（gateway 328、presets 286、router 152、sanitizer 74、index 32、types 9） | 3 文件 / 1240 行（gateway.spec 689、presets.spec 450、sanitizer.spec 101） | README 17 行 | 2121 行 |
| persona-brain | 5 文件 / 426 行（persona-engine 112、think 141、reflex 80、rice-bowl 87、index 6） | 4 文件 / 376 行（persona-engine.spec 114、think.spec 96、rice-bowl.spec 84、reflex.spec 82） | README 16 行 | 802 行 |
| live-stream-hub | 4 文件 / 976 行（attention 461、guard 270、hub 238、index 7） | 1 文件 / 677 行（live-stream-hub.spec） | README 14 行 | 1653 行 |

> 观察：model-gateway 的 spec 行数（1240）**超过**非 spec 行数（881），live-stream-hub 达 69%（677/976），说明「测试即行为书面化」在这个仓库里是实际执行的。

### 1.2 package.json 依赖与真实 import 关系

| 包 | package.json dependencies | 被谁 import（全仓检索） |
| --- | --- | --- |
| shared-protocol | `zod ^4.6.7`（唯一） | model-gateway、persona-brain、live-stream-hub、game-bridge-mcp、local-store、pet-renderer、plugin-kit、desktop-host、tools/mock-harness |
| model-gateway | `@workbench/shared-protocol`、`zod` | `apps/desktop-host/src/main/{autodrive-host,provider-vault}.ts`；`src/renderer/director/main.tsx:1` 经 **`/presets` 子路径**只取预设清单；game-bridge-mcp **不 import**（`llm-planner.ts:71` 用注入的 chat 函数避免反向依赖） |
| persona-brain | `@workbench/shared-protocol`（无 zod 直接依赖） | `apps/desktop-host/src/main/{character-persona,autodrive-host}.ts`、`e2e/gate4-loopback.spec.ts`；pet-renderer / game-bridge-mcp **仅注释提及**，无 import |
| live-stream-hub | `@workbench/shared-protocol`（唯一） | `apps/desktop-host/src/main/live-host.ts:13`、`e2e/gate4-loopback.spec.ts:9` |

**关键结构事实**：model-gateway / persona-brain / live-stream-hub **三者互不依赖**，全部只向下依赖 shared-protocol；方向由 `.dependency-cruiser.cjs` 的 `no-circular`、`shared-protocol-no-business-deps`、`persona-brain-runtime-only-zod`、`model-gateway-runtime-only-zod` 机器锁定 [A]。该配置中**没有** live-stream-hub 的专属规则（仅被通用 no-circular 覆盖）——属覆盖缺口，非违规。

---

## 2. shared-protocol：契约层

### 2.1 Zod Schema 到底定义在哪

**结论：全部内联写在 `src/index.ts`（1491 行）**，`src/registry.ts` 不定义任何 Schema，只做「登记簿」。

- `packages/shared-protocol/src/index.ts:1` → `import { z } from 'zod';`
- **97 个 `export const *Schema`** 与 **90 个 `export type X = z.infer<...>`**（`grep -cE "^export const [A-Za-z]+Schema"` / `grep -c "^export type"`）。
- `index.ts` 还含 2 个**运行期函数**：`toolLabelZh`（:1334）、`statusLabelZh`（:1339）与两张中文词表 `WORKBENCH_TOOL_LABELS_ZH` / `WORKBENCH_STATUS_LABELS_ZH`。「零依赖核心层」并非纯 Schema 文件。

**`src/registry.ts`（153 行）的作用**：从 `./index` import 69 个 Schema（`registry.ts:3-72`），组成 `CONTRACT_SCHEMAS: Record<string, ZodType>`（`registry.ts:83-152`），导出 `CONTRACT_VERSION = '1.0.0'`（`registry.ts:81`）。它给生成器一份「哪些契约要跨语言」的白名单。`registry.ts:66-72` 注释原文：

> 「跨语言契约注册表（T-M0-02）。gen-contracts.ts 由此生成：packages/shared-protocol/schema/*.schema.json（供 C# SMAPI Mod 校验）、services/audio-ai-worker/protocol_models.py（Pydantic，供 Python 音频服务）。新增/修改契约必须：先改本文件登记 → 跑 `pnpm gen:contracts` → 跑 `pnpm py:check`。」

### 2.2 schema/*.json：数量、生成方式、生成目标

- **数量**：`packages/shared-protocol/schema/` 共 **70 个文件** = **69 个单契约** + **1 个合并视图** `workbench.schema.json`（6435 行）。`git ls-files` 显示 70 个全部**已提交入库**。
- **是生成产物，不是手写**：`tools/scripts/gen-contracts.ts:27` 直接 `import { CONTRACT_SCHEMAS, CONTRACT_VERSION } from '../../packages/shared-protocol/src/registry'`；对每个契约调 `schema.toJSONSchema({ target: 'draft-07', io: 'input', reused: 'inline', unrepresentable: 'throw' })`，再 `writeFileSync(join(SCHEMA_DIR, `${name}.schema.json`))`（`gen-contracts.ts:97`）。文件头带 `"contractVersion": "1.0.0"`（`schema/NormalizedLiveEvent.schema.json:4`）。
- **入口脚本在根 package.json，不在包内**：`package.json:15` → `"gen:contracts": "tsx tools/scripts/gen-contracts.ts"`；而 `packages/shared-protocol/package.json` 的 scripts **只有 `build: tsc -b`**。
- **三个生成目标的真实情况**：

| 目标 | 是否有生成器 | 证据 |
| --- | --- | --- |
| TS 类型 | **没有生成器**。类型是 `index.ts` 里逐个手写的 `z.infer<typeof XSchema>` 别名，`tsc -b` 只把它编译成 `dist/*.d.ts` | 90 处 `export type`；`gen-contracts.ts` 全文无 TS 输出 [A] |
| JSON Schema（draft-07） | 有 → `packages/shared-protocol/schema/*.json`，供 C# SMAPI Mod 校验 | `gen-contracts.ts:30,97` [A] |
| Pydantic | 有 → `uv run --with datamodel-code-generator datamodel-codegen --input workbench.schema.json --output services/audio-ai-worker/protocol_models.py`（`gen-contracts.ts:124-140`），产物 2415 行，首行横幅「AUTO-GENERATED…请勿手工编辑」 | `protocol_models.py:1-4` [A] |

- **登记覆盖不全**：`index.ts` 导出 97 个 Schema，`CONTRACT_SCHEMAS` 只登记 69 个 → **28 个不进 JSON Schema / Pydantic**：`ImageGen*`（5 个）、`TeamPlan*`/`TeamZoneLock`/`TeamHuddleState`/`TeamGoalMetric`、`WorkFollowCard`/`WorkFollowSession`/`WorkFollowOrigin`、`StardewSpriteGenRequest`/`StardewSpriteReprocessRequest`/`StardewSpriteTier`、`PetStudio*` 子 Schema、`PetSpriteMeta`、`PetCustomGlyph`/`PetLongThink`/`PetMilestone`/`PetNotebookConfig`、`StardewAvatarPreset`。它们仍受 Zod 运行期校验，但**没有跨语言产物**。

### 2.3 ⚠ 生成物已经漂移（实测）

用一段只读脚本按 `gen-contracts.ts` 的同一序列化口径重算 69 个契约，与已提交文件逐字节比对：

```
total=69 inSync=63 stale=6
stale: PetAvatarClip, PetAvatarManifest, PetDesktopPrefs, StardewAvatarSync, WorkFollowEvent, WorkFollowStatus
```

- 逐行 diff：`schema/PetAvatarClip.schema.json` 在 `weight` 之后即结束（第 81-88 行），**缺少源码里的 `facing`、`moving`、`category` 三个字段**（源码 `index.ts:668-690`）。
- Pydantic 同样滞后：`protocol_models.py` 的 `class PetAvatarClip` 只有 `clipId/webmPath/spriteSheetPath/spriteMetaPath/sprite/audioPath/loop/playbackRate/fps/weight`，无 facing/moving/category；`PetDesktopPrefs` 的 T-M6-63/65 字段（`bubbleFontScale`、`windowLayer`、`patrolEnabled`、`peakOutfitEnabled`、`randomEggEnabled`、`notebookFontId`）在该文件中 **grep 命中数均为 0**。
- 时间线：`git log --oneline -5 -- packages/shared-protocol/schema` 最后一次是 `009cdda`（T-M6-62）；`packages/shared-protocol/src/index.ts` 之后还有 `0d028c8`、`1e30fbc`、`502d907`、`464981e` 四次提交。
- **门禁不查漂移**：`tools/scripts/verify-gate.mjs` 对契约只做「`protocol_models.py` 是否存在 + ruff/mypy + pytest」（:113-126、:211），**没有任何一步重新生成并与已提交文件 diff**。

### 2.4 两个 spec 文件测什么

**`src/index.spec.ts`（408 行 / 22 用例）** —— 契约单测 +「夹具双侧 probe」的 TS 侧：
- `PetPersonaConfig`：夹具可解析且默认值落位（`ownerTitles=['鱼片','主人']`、`thinkTagName='think'`、`cooldownMs=8000`、`lowRiceWarningRatio=0.15`、`rvcIndexRate=0.75`、`licenseScope=DEV_ONLY_NON_COMMERCIAL`）；`ReflexRule` 缺 `presetResponses` 拒绝；非法 `priority`/`actionState` 拒绝。
- `AudioPlaybackLease`：`ttlMs` 上下界 500 / 300000；可选 `innerThoughtText`。
- `NormalizedLiveEvent`：默认 `mergedCount=1`、`grudgeTags=[]`、`intimacyScore=0`；缺 `eventId` / 非法 `platform` 拒绝。
- `StardewMcpActionReceipt`：`UNCERTAIN` 回执可带快照；非法 `toolName`/`status` 拒绝。
- 多游戏桥接：Terraria `UNCERTAIN` 携带快照、`gameId` 字面量互斥、缺 `tiles` 拒绝；DST `COMPLETED` 默认无快照、非法 `season` 拒绝、`TIMEOUT` 不是回执态；`GameBridgeActionRequest.args` 默认 `{}`；`GameBridgeHealth` 默认值；槽位含 `TERRARIA_GAME_PLANNER`/`DST_GAME_PLANNER`。
- `DiningProfilePreset`：非法槽位键拒绝；`PetAvatarManifest`：默认值与非法 `renderer`/越界 `footlineRatio`/空 `actions`。
- 契约注册表：`CONTRACT_VERSION` 语义化版本 + `CONTRACT_SCHEMAS` ≥19 且每项有 `safeParse`。
- 中文词表、`PetCustomCharacter` 默认值、`StardewAvatarSync` 版本/颜色校验。

**`src/voice-studio-contracts.spec.ts`（84 行 / 8 用例）** —— T-M5-17 声音工坊契约门禁，与 `pytest test_voice_studio.py` 双侧对齐：`PauseConfig` 默认 340/150/460 + 越界拒绝；`TtsEmotionTuningParams` 五情绪合法、`refText` 必填（空值拒绝，防内部 ASR 卡顿）、speed/topK/sfxVolume 范围、调参往返一致；`SvcSingingTuningParams` 默认 `indexRate 0.75 / protect 0.33`、升降调 ±12 整数；`VoiceDesignRequest` 三路径合法、权重导入强制 `licenseScope`。

### 2.5 `fixtures/blue-whale-maid.json` 是什么

56 行的 `PetPersonaConfig` 实例（id `blue-whale-maid`、雷区正则 `(大肥鱼|胖鱼|肥鲸|多少斤|水桶腰|卡门)`、`cooldownMs` 走默认 8000、饭碗预算 500000、`stardewWeights` 懒/认真两组权重、`voiceProfile`）。**它不只是测试夹具，还是运行期默认人设**：

```
apps/desktop-host/src/main/character-persona.ts:17-20
  const configPath = app.isPackaged
    ? join(process.resourcesPath, 'persona', 'blue-whale-maid.json')
    : join(here, '../../../../packages/shared-protocol/fixtures/blue-whale-maid.json');
  return PetPersonaConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
```

同一份文件被三处消费：`shared-protocol/src/index.spec.ts:2`（import）、`persona-brain/src/persona-engine.spec.ts:7`（`readFileSync`）、`services/audio-ai-worker/test_protocol_models.py:20`（pytest 夹具回放）。

### 2.6 对「只改 shared-protocol 的 Zod Schema，跨语言自动生成 TS / JSON Schema / Pydantic」的核实

| 子句 | 真实程度 | 依据 |
| --- | --- | --- |
| 「只改 shared-protocol 的 Zod Schema」 | **基本成立，有例外** | 四包内成立；但 `packages/plugin-kit/src/manifest.ts:34` 在 shared-protocol 之外用 `z.object` 定义 `PluginManifestSchema`（插件域自管，不跨语言）；persona-brain 的输出结构 `ReflexHit`/`ConsumeResult`/`ThinkStripResult` 是包内 interface |
| 「自动生成 TS」 | **不成立（无生成器）** | 90 个 `z.infer` 手写别名；`gen-contracts.ts` 无 TS 输出 |
| 「自动生成 JSON Schema」 | **成立（脚本在），但产物漂移** | `gen-contracts.ts:30,97`；6/69 stale（§2.3） |
| 「自动生成 Pydantic」 | **成立（脚本在），但产物漂移** | `gen-contracts.ts:124-140`；字段缺失见 §2.3 |

---

## 3. model-gateway：模型网关

### 3.1 五个文件各做什么

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `types.ts` | 9 | 仅两个类型：`ProviderKeyring`（providerId→真实 Key，仅内存）、`ProviderCatalog = ModelProviderConfig[]` |
| `gateway.ts` | 328 | `ModelGateway.chat()` 主循环：取槽位绑定 → 排序候选 → 出站脱敏 → 逐候选 fetch → 400 即抛 / 其余静默 failover → 解析回执 → 记 usage 与粘性 |
| `router.ts` | 152 | `StickyState`（lastGood / 轮询游标 / 时延记录）+ `orderedCandidates()` + `recordStickyGood()` |
| `presets.ts` | 286 | 12 个内置供应商预设；`resolveEndpoint`（Region/Plan 胶囊 + 协议变体收窄）、`resolveProtocol`、`buildChatUrl` |
| `sanitizer.ts` | 74 | `createSanitizer()`：路径 / 密钥 / 用户名 / 自定义规则 → `{{MASKED}}` |

### 3.2 支持哪些 provider（代码为准）

`presets.ts:37` 的 `BUILTIN_PROVIDER_PRESETS` 共 **12 个**（实测 `grep -cE "^    id: '"` = 12）：

| 类别 | provider id | 协议 | 端点 |
| --- | --- | --- | --- |
| 官方 | `deepseek-official` | openai | `api.deepseek.com/v1` |
| 聚合 | `siliconflow` | openai | `api.siliconflow.cn/v1` |
| 聚合 | `openrouter` | openai | `openrouter.ai/api/v1` |
| 聚合 | `opencode-go` | openai **+ anthropic 双变体** | `opencode.ai/inference/{go/openai,go/anthropic}/v1` |
| 聚合 | `opencode-zen` | openai **+ anthropic 双变体** | `opencode.ai/inference/{openai,anthropic}/v1` |
| 聚合 | `typesafe-jev` | openai（决策协议，全部 `toolCalling:false`） | `jevmodel.org/v1` |
| 官方 | `volcano-ark` | openai | `ark.cn-beijing.volces.com/api/v3` |
| 官方 | `openai` | openai | `api.openai.com/v1` |
| 官方 | `anthropic` | **anthropic** | `api.anthropic.com/v1` |
| 官方 | `minimax` | openai | `api.minimaxi.com/v1` |
| 本地 | `local-ollama` | openai | `127.0.0.1:11434/v1`（`presets.ts:216`） |
| 本地 | `local-gpt-sovits` | openai（`isFullUrl:true`） | `127.0.0.1:9880`（`presets.ts:229`） |

- **协议只有两种**：`ProviderProtocol = 'openai' | 'anthropic'`（`presets.ts:244`）。**没有 Gemini 原生协议**（Gemini 只能经 OpenRouter 的 `google/gemini-2.5-pro` 走 OpenAI 兼容）。
- **没有 MLX**：README 写「本地 Ollama/MLX/GPT-SoVITS」，代码只有 Ollama 与 GPT-SoVITS。
- **没有流式 API**：`gateway.ts` 全文无 `stream` 命中，`chat()` 返回完整 `ChatReceipt`（`gateway.ts:57-65`）。`reasoningContent` 取 OpenAI 兼容的 `choices[0].message.reasoning_content`；Anthropic 分支强制 `reasoningContent = null`、`cachedInputTokens = 0`（`gateway.ts:284-297`，注释「Anthropic 的 cache 计量字段暂不计入 Token 饭碗」）。

### 3.3 粘性路由是什么（实现位置）

- 状态键 **`sessionId::slot::groupId`**（`router.ts:31-33`），只对 `group/` 绑定生效；直接绑定返回单候选、`groupId=null`（`router.ts:139-143`）。
- `PROMPT_CACHE_STICKY`（`router.ts:110-116`）：命中过的节点置顶，其余按权重降序作 failover 池 → 同会话锁死同节点吃满 Prompt Cache。
- `ROUND_ROBIN`（`router.ts:117-120`）：组级游标轮转。
- `LOWEST_LATENCY`（`router.ts:121-135`）：按最小时延升序，无记录按权重降序。
- 成功写回 `recordStickyGood()`（`router.ts:145-151`，`gateway.ts:312`）；切套餐 `clearAll()`（`gateway.ts:158-161`）。

### 3.4 sanitizer 脱敏什么（实现位置）

`createSanitizer()`（`sanitizer.ts:39-73`），对所有出站消息逐条执行（`gateway.ts:190`）：

| 规则 | 行号 |
| --- | --- |
| POSIX 绝对路径 `/Users`、`/home/<user>/...` 整条掩码 | `sanitizer.ts:47` |
| Windows `C:\Users\<user>\...` 整条掩码 | `sanitizer.ts:49` |
| `homeDir` 字面量兜底 | `sanitizer.ts:52-54` |
| `sk-…`（≥16 位） | `sanitizer.ts:55` |
| `oc_sk_` / `or_sk_`（≥8 位） | `sanitizer.ts:57` |
| `ghp_`（≥20 位）、`AKIA`（16 位）、`Bearer <token>`、`api_key=...` 明文赋值 | `sanitizer.ts:58-64` |
| 本机用户名（独立词） | `sanitizer.ts:66-68` |
| 宿主扩展 `extraRules` | `sanitizer.ts:70-71` |

**注意**：README 写「剪贴板隐私」，代码**没有**内置剪贴板规则，只有 `extraRules` 钩子。`profile.secretMaskingEnabled=false` 或 `sanitizer:false` 时整体直通（`gateway.ts:151-154`）。

### 3.5 fetch 直连还是 SDK

**纯 `fetch`，无 SDK**。`packages/model-gateway/package.json` dependencies 只有 `@workbench/shared-protocol` 与 `zod`；`gateway.ts:194`：

```ts
const fetchImpl = this.options.fetchImpl ?? ((url, init) => fetch(url, init));
```

Anthropic 分支手工拼 `x-api-key` + `anthropic-version: 2023-06-01`，并注释「严禁附带 authorization」（`gateway.ts:224-243`）；OpenAI 分支用 `authorization: Bearer`（`gateway.ts:244`）。OpenCode Go 额外加 `x-opencode-session`（`sha1(sessionId:slot)` 前 32 位）与 `user-agent`（`gateway.ts:219-222`）。

### 3.6 「Token 饭碗 / 扣费」到底在哪

**三处，职责不同，运行期只用第三处**：

| 位置 | 做什么 | 运行期是否生效 |
| --- | --- | --- |
| `packages/model-gateway/src/gateway.ts:314-322` | **只上报**：`onUsage({slot, providerId, modelId, inputTokens, cachedInputTokens, outputTokens, latencyMs})`，不做加减 | 生效（被宿主订阅） |
| `packages/persona-brain/src/rice-bowl.ts:33-45` | `RiceBowl.consume(tokens)`：`this.config.consumedRiceGrainsToday += clamped`（:35），返回 `ratioRemaining/hungry/suggestedActionState` | **不生效**：全仓无运行期 import（apps 只 import `loadPersona`/`createReflexInterceptor`/`stripThink`/`ReflexHit`） |
| `apps/desktop-host/src/main/token-meter.ts:103-125` | **真实扣费**：`tokens = round(inputTokens + outputTokens)`，`state.consumed += tokens`，`rice-state.json` 原子写 + `token-ledger.jsonl` 追加 | 生效（`autodrive-host.ts:284-298` 注入 `onUsage`） |

⚠ **计费口径细节**：`token-meter.ts:105` 只加 `inputTokens + outputTokens`，`cachedInputTokens` **仅写流水、不参与扣减**。Prompt Cache 命中部分在「饭碗」里仍按全额计价——与「1 粒米 = 1 Token」字面一致，但与供应商实际计费不一致。属设计取舍还是遗漏，代码未说明 [D]。

### 3.7 有没有「随机虚假指标」逻辑

**没有**。四包非 spec 源码中 `Math.random` 只有 3 处，全是合法随机：`persona-engine.ts:91`（跑题概率默认 rng）、`reflex.ts:48`（反射台词加权抽取）、`reflex.ts:13`（注释）。全仓检索 `观看|码率|热度|人气|viewerCount|bitrate` 在四包源码中 **0 命中**。`gateway.ts` 的 usage 只取供应商实报字段（`prompt_tokens`/`completion_tokens`/`prompt_cache_hit_tokens` 或 `input_tokens`/`output_tokens`），缺失补 0 而非编造（`gateway.ts:284-297`）。

---

## 4. persona-brain：人格引擎

### 4.1 四个文件各做什么

| 文件 | 行数 | 职责与关键实现 |
| --- | --- | --- |
| `persona-engine.ts` | 112 | 门面 `loadPersona(config)`：`PetPersonaConfigSchema.parse`（:63）→ 逐条 `new RegExp(triggerRegex,'u')` 装载期编译防 ReDoS（:68-75）→ `new RiceBowl(persona.riceBowl)`（:77）→ 返回 `{config, rice, reflex, stripThink, createThinkStream, maybeDerail, parseEmotionPrefix, buildSystemPrompt}` |
| `reflex.ts` | 80 | `createReflexInterceptor()`：规则按声明顺序试（:59），命中且未冷却即返回（:65-71），`pickWeighted` 抽预设台词（:36-43），返回 `consumedMainBrainTokens: false`（:74） |
| `think.ts` | 141 | `stripThink`（:14）整段剥离；`createThinkStreamParser`（:63）流式剥离，`hangingSuffixLength` 处理 `<thi`/`</thin` 跨块悬挂；`EMOTION_PREFIX_MAP`（:121）五档情绪前缀 → emotionTag；`parseEmotionPrefix`（:134） |
| `rice-bowl.ts` | 87 | `RiceBowl.consume`（:33）扣费；`applySideDish`（:53）下饭菜 Buff（倍率夹紧 [1,5]、`expiresAt`）；`workEthicMultiplier`（:70）取最大；`hasDeepReasoning`（:79） |

**雷区拦截的精确实现**：`reflex.ts:57-78`。正则装载期编译一次（`reflex.ts:52`），运行期只 `matcher.test(text)`；冷却判定 `timestamp - lastHitAt < rule.cooldownMs` 则 `continue` 试下一条规则（`reflex.ts:65-66`），所以「大肥鱼冷却中」仍可被「盖饭」规则命中。

**`<think>` 拆分的精确实现**：整段 `think.ts:14-41`（未闭合 → 余下全算内心戏，:31-35）；流式 `think.ts:63-119`，`hangingSuffixLength`（:48-55）保证 `'<thi'` 不吐出。

### 4.2 输入输出数据结构来自哪里

- **输入**：全部来自 shared-protocol。`persona-engine.ts:6`（`PetPersonaConfigSchema` + `PetPersonaConfig`）、`reflex.ts:7`、`rice-bowl.ts:5`（`PetPersonaConfig`、`PetActionState`）。
- **输出**：`ReflexHit`（`reflex.ts:9-20`）、`ConsumeResult`（`rice-bowl.ts:19-25`）、`ThinkStripResult`/`ThinkStreamFeed`/`EmotionPrefixResult`（`think.ts:10-13/42-47/127-130`）**都是包内 interface，不在 shared-protocol 契约里**。即「跨进程/跨语言」这条线在 persona-brain 的**输出侧是断开的**——这些结构只以 TS 类型在本包与宿主间流动，无 Zod 校验，无 JSON Schema/Pydantic 产物。

### 4.3 spec 覆盖了哪些分支

| spec | 用例数 | 覆盖的分支 |
| --- | --- | --- |
| `reflex.spec.ts` | 4 | 命中返回 P0 + rage_spray + `consumedMainBrainTokens=false`；冷却窗口内不重复触发（默认 8000ms）、冷却中可命中另一规则、窗口后恢复；未命中返回 null；装载期非法正则抛错 |
| `think.spec.ts` | 11 | `stripThink` 5 例（基础/多段混排/未闭合/自定义标签/纯内心戏）；流式 4 例（`<thi` 跨块、一次喂完、未闭合 `result()`、`</thin` 悬挂）；情绪前缀 2 例（五档映射、无/未知前缀） |
| `rice-bowl.spec.ts` | 6 | 扣费累计与 15% 饥饿线 → `hungry_lazy`；负数夹紧为 0、超预算归零；Buff ×2 与到期失效、深度推理解锁；预算 0 被契约拒绝；倍率取最大且夹紧 [1,5] |
| `persona-engine.spec.ts` | 10 | 夹具装载；`INVALID_PERSONA`/`INVALID_REFLEX_REGEX`；**<10ms 门禁 + 1000 次 <100ms**；系统提示四占位符；`<think>` + 跑题概率 0/1/0.34/disabled/空 prompts；流式入口；雷区与饭碗互不干扰、低于 15% → `hungry_lazy`；`ownerTitles` 为空回落「主人」；默认 rng 不抛；情绪前缀 |

**实测分支覆盖率**（本次 `vitest run` + v8）：

```
persona-engine.ts  83.33% branch（未覆盖 65-72,97）
reflex.ts         100%    branch
rice-bowl.ts       80.00% branch（未覆盖 79）
think.ts           96.15% branch（未覆盖 137）
persona-brain/src  92.42% branch（聚合）
```

即「persona-brain 分支覆盖率 ≥90%」只在**聚合口径**成立，单文件 `rice-bowl.ts`(80%) 与 `persona-engine.ts`(83.33%) 低于 90%。

---

## 5. live-stream-hub：弹幕中枢

### 5.1 三个文件各做什么

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `hub.ts` | 238 | 入站唯一收口：`ingest(raw)` → `NormalizedLiveEventSchema.safeParse` → `Guard.filter` → LRU 去重（容量 4000）→ `ENTER_ROOM`/`LIKE` 进 150ms 批次、其余直接 `scheduler.ingest` → `flush()` 取 topN 并广播。`subscribe`/`snapshot`/`dispose` |
| `attention.ts` | 461 | 三级注意力调度：分档看「说话人数」而非条数；分数 `e^(-age/τ)`（:129）；同观众弹幕合并 15s（:200-211）、礼物连击 3s（:213-227）、进场聚拢 2.5s（:228-247）；`pick()` 按衰减分排序取 topN（:257-281）；队列硬上限 512、超龄 300s 清理、超限淘汰最老（:403-425） |
| `guard.ts` | 270 | 输入护栏：block 丢弃 / mask 掩码 `***` / warn 标记（:161-233）；同 uid 60s 内 20 条频控（:178、:245）；UTF-16 码元安全截断 200（:113-121）；清洗孤立代理对；**把清洗结果同时写回 `rawText` 与 `sanitizedText`**（:209-225） |

### 5.2 输入事件类型从哪来

`NormalizedLiveEvent` 定义在 **`packages/shared-protocol/src/index.ts:545-559`**：

```ts
export const NormalizedLiveEventSchema = z.object({
  eventId: z.string().uuid(),
  platform: z.enum(['douyin', 'bilibili', 'local-host-input']),
  eventType: z.enum(['DANMAKU', 'GIFT', 'LIKE', 'ENTER_ROOM', 'SONG_REQUEST', 'VOTE_CHOICE']),
  ...
  assignedPriority: z.enum(['P0_INTERRUPT', 'P1_CADENCE', 'P2_IDLE']),
  timestamp: z.number(),
});
```

三个文件都是 `import type` 引用它（`hub.ts:12`、`attention.ts:12`、`guard.ts:12`），本包**不定义任何事件类型**。`LiveProgramStateSchema`（`index.ts:538`）也在契约里，但 live-stream-hub 源码**完全没用到**节目状态机（`GAMING_MAIN/SINGING_CONCERT/...` 在包内 0 命中）——README 里写的「节目状态机防呆切换」不在本包。

### 5.3 ⚠ 是否存在真实的抖音弹幕接入代码

**不存在。只有归一化后的内部事件。** 逐条证据：

1. **包内唯一提到 dyhub 的是注释**：`hub.ts:9`「校验必须发生在最外层：C# Mod / dyhub / 彩排沙盒都可能送来脏结构」。
2. **宿主侧明确声明未接线**：`apps/desktop-host/src/main/live-host.ts:8` 原文「**明确未接线：真实 dyhub/抖音弹幕流**、SQLite 常客账本落盘、点歌执行链、OBS 图层渲染。」
3. **依赖为零**：全仓 `package.json` 与 `pnpm-lock.yaml` 中 `dyhub|douyin` **0 命中**；`packages/live-stream-hub/package.json` 只有 `@workbench/shared-protocol`。
4. **`platform: 'douyin'` 只是数据字段**，出现在三处且都是构造样例：`live-host.ts:40`（回放样本）、`tools/mock-harness/src/danmaku-storm.ts:138`（[SIMULATION] 风暴）、`index.spec.ts:44`（单测）。
5. **全仓 WebSocket 与直播无关**：`ws` 只用于 `apps/desktop-host/src/main/webui-server.ts`（本机 Web UI，18766）与 `tools/mock-harness`（星露谷模拟器）。没有监听弹幕的 WebSocketServer，没有连接直播间的代码。
6. **入站入口只有 IPC 与回放**：`ipcMain.handle('live:ingest')`（`live-host.ts:93`）、`'live:replay'`（:94-104）、`'live:snapshot'`（:105）、`'live:history'`（:106）。ROADMAP 侧 `T-M4-01`（接入 dyhub）仍是 **PENDING**（`docs/ROADMAP.md:48`），与代码一致。

### 5.4 P0/P1/P2 抢占与同观众合并的实现位置

- **同观众弹幕合并：已实现**。`attention.ts:200-211` 找同 uid、同 `DANMAKU`、15s 内的队内条目 → `mergeDanmaku()`（`attention.ts:345-370`）用「 / 」拼接、最多 5 段、超出只累计 `mergedCount`，同时维护 `rawParts`/`sanitizedParts` 两条文本轨。
- **P0/P1/P2 抢占：未实现**。`grep -rnE "P0|P1|P2|assignedPriority|preempt" packages/live-stream-hub/src --include='*.ts' | grep -v spec` → **0 命中**。`assignedPriority` 只存在于契约，宿主仅用于**展示**（`live-host.ts:78` `priority: String(event.assignedPriority)`）与「只给 P0 回一句话」的语音短评（`live-host.ts:87-90`）。
- 实际调度机制是**另一套**：按 60s 内「说话人数」分 `quiet(<8) / normal(8-29) / busy(≥30)`（`attention.ts:294-298`），每档名额 4/2/1，按 `e^(-age/τ)` 衰减分排序取 topN。**与文档描述的「P0 即时抢占 / P1 节拍器 / P2 空闲填补」不是同一机制**——档位由人数决定，不由事件优先级决定。

### 5.5 实测覆盖率

```
attention.ts  90.75% branch
guard.ts      97.43% branch
hub.ts        88.88% branch（未覆盖 104,121,203,216）
live-stream-hub/src 92.70% branch（聚合）
```

---

## 6. 文档 vs 代码不一致清单（逐条核对）

| # | 文档声明（出处） | 代码事实 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | AGENTS §1.2/§3.1「跨语言自动生成 **TS** / JSON Schema / Pydantic」 | TS 类型无生成器，是 90 处手写 `z.infer` 别名；只有 JSON Schema 与 Pydantic 有脚本 | `index.ts` 90 处 `export type`；`gen-contracts.ts` 无 TS 输出 | **部分不实** |
| 2 | 同上「自动生成 JSON Schema / Pydantic」 | 脚本存在，但 **6/69 契约产物已漂移**，门禁不查漂移 | §2.3；`verify-gate.mjs:113-126` | **机制成立、执行失守** |
| 3 | AGENTS §1.2「所有跨进程/跨语言的数据结构**必须且只能**在 shared-protocol 中用 Zod 定义」 | 四包内成立；但 `plugin-kit/src/manifest.ts:34` 另有 `PluginManifestSchema`；persona-brain 的 `ReflexHit`/`ConsumeResult` 等输出结构不在契约里 | 见左 | **有例外** |
| 4 | AGENTS §1.3「Token 消耗流水……统一使用主进程 **SQLite**（better-sqlite3）」 | Token 流水用 **JSONL + rice-state.json**，注释明说因 ABI 不兼容放弃 SQLite | `token-meter.ts:2-9`、`:110-123` | **不实（直接冲突）** |
| 5 | AGENTS §1.4「主进程运行 **WebSocket + JSON-RPC 2.0 中心网关（18760）**，统管 pet-stage/director-ui/obs-overlay(18765)/audio-ai-worker/stardew-mcp-mod」 | 全仓 **18760 仅出现在两处注释**，且都写「设计稿搁置」；18765 只在一条 UI 描述文案里 | `shared-protocol/src/index.ts:302`、`game-bridge-mcp/src/adapter.ts:123`、`renderer/director/plugins-panel.tsx:31` | **未实现** |
| 6 | AGENTS §2.3/§3.3 Gate 3「persona-brain/model-gateway/live-stream-hub …… **分支覆盖率 ≥ 90%**」 | 阈值是 `vitest.config.mts` 的**全仓聚合**阈值（lines/functions/branches/statements 各 90），不是按包；实测单文件 `hub.ts 88.88%`、`sanitizer.ts 82.35%`、`rice-bowl.ts 80%`、`persona-engine.ts 83.33%` | `vitest.config.mts` thresholds；本次 coverage 输出 | **口径不一致** |
| 7 | AGENTS §3.3「live-stream-hub（**P0/P1/P2 抢占**、同观众弹幕合并）」 | 只有合并；P0/P1/P2 抢占 0 命中，实际是 quiet/normal/busy 分档 | §5.4 | **不实** |
| 8 | AGENTS §4「吸收 Magpie **单屏 6 角色绑定**」 | `WorkbenchRoleSlotSchema` 有 **8 个槽位**（新增 TERRARIA/DST 两个规划器） | `index.ts:225-236` | **过时（6→8）** |
| 9 | AGENTS §2.2「抖音弹幕直连主线为 **dyhub**」/§4「保持 dyhub 为抖音弹幕主线」 | 无 dyhub 代码、无依赖、宿主声明未接线 | §5.3 | **未实现（文档自认 PENDING）** |
| 10 | 三个包 README 首行「状态：**未开工**」（T-M1-03 / T-M1-04 / T-M4-01） | 代码已实现并接入 desktop-host；ROADMAP 记 T-M1-03/T-M1-04 DONE（2026-11-15）、T-M6-37 DONE（2026-11-23） | `packages/*/README.md:3`；`ROADMAP.md:17-18,127` | **README 严重过时** |
| 11 | model-gateway README「本地 Ollama/**MLX**/GPT-SoVITS」「剪贴板隐私」 | 无 MLX 预设；无内置剪贴板规则（仅 `extraRules` 钩子） | `presets.ts:37-240`；`sanitizer.ts:69-71` | **不实** |
| 12 | live-stream-hub README「**高光/翻车切片**：45s 环形缓存」 | 包内 0 命中（`环形|45|ring|highlight|切片`） | §5.1 | **不实（不在本包）** |
| 13 | live-stream-hub README「**节目状态机** GAMING_MAIN ↔ SINGING_CONCERT …」 | 契约有 `LiveProgramStateSchema`，包内 0 引用 | `index.ts:538`；包内 grep | **不实（不在本包）** |
| 14 | persona-brain README「星露谷效用权重：摸鱼态 ↔ 认真态切换」 | `stardewWeights` 只在契约与夹具里；persona-brain 无任何消费代码 | `index.ts:130-137`；`fixtures/blue-whale-maid.json` | **不实（无实现）** |
| 15 | ROADMAP `T-M1-03`「CC Switch 两步式预设库（**9 家**）」 | 现为 **12 个**预设（后增 opencode-zen / typesafe-jev 等） | `presets.ts:37-240` | **过时（9→12）** |

---

## 7. 意外发现

1. **「测试夹具」同时是运行期默认人设**。`fixtures/blue-whale-maid.json` 被 `character-persona.ts:16-20` 在开发态直接读取作为默认人格，打包后换成 `Resources/persona/blue-whale-maid.json`。改夹具 = 改默认人设。
2. **`RiceBowl` 是死代码（运行期）**。persona-brain 的饭碗扣费类只有自己的 spec 在用；真实扣费在 desktop-host 的 `token-meter.ts`。两套「1 粒米 = 1 Token」实现并存，阈值也不同（`RiceBowl` 用 `lowRiceWarningRatio=0.15` → `hungry_lazy`；`token-meter` 用 `riceLevelOf` 的 5%/15%/80%/90% 五档）。
3. **缓存命中不省钱**。`token-meter.ts:105` 计费不含 `cachedInputTokens` 折扣。
4. **Anthropic 的 cache 用量被显式丢弃**。`gateway.ts:292` 注释「Anthropic 的 cache 计量字段暂不计入 Token 饭碗」，`cachedInputTokens` 硬编码 0。
5. **`rawText` 被护栏改写**。`guard.ts:209-225` 把清洗后文本同时写回 `rawText` 与 `sanitizedText`，下游即使误读 `rawText` 也拿不到脏字——但「原文」在总线内不可恢复（注释称只留总线日志侧）。
6. **`registry.ts` 与 `index.ts` 的 28 个缺口**会让「新增契约」看起来登记了、实际没跨语言（如 `ImageGen*`、`WorkFollow*`）。
7. **`persona-engine.spec.ts` 的 <10ms 门禁是真测时延**（`performance.now()` 断言 `toBeLessThan(10)`，另加 1000 次 <100ms），慢 CI 上有 flaky 风险 [D]。
8. **`assignedPriority` 完全不影响调度**，只影响展示与「P0 才语音短评」。若后续按文档做 P0 抢占，需在 `attention.ts` 新增优先级维度，而不是改契约。

---

## 8. 待证项（未定位，勿当结论）

| 线索 | 现状 | 建议查法 |
| --- | --- | --- |
| C# SMAPI Mod 是否真的在运行期加载 `schema/*.schema.json` 做校验 | 只在注释里声称「供 C# SMAPI Mod 校验」，未查 `mods/`（不在调查区域） | 检索 `mods/**` 中对 `.schema.json` / `Newtonsoft.Json.Schema` / `NJsonSchema` 的引用 |
| `protocol_models.py` 的完整漂移面 | 已用字段缺失证明至少 `PetAvatarClip`、`PetDesktopPrefs` 滞后；未做全量 regen diff | 干净环境 `uv run --with datamodel-code-generator datamodel-codegen --input workbench.schema.json --output /tmp/x.py` 后 diff |
| Pydantic/JSON Schema 漂移是否影响真机 | 未验证 | 用漂移字段（`facing`/`moving`/`bubbleFontScale`）构造 payload，跑 Python 侧解析看是否 `extra='forbid'` 报错 |
| `verify:gate` 全量是否仍绿 | 本次只跑 4 包子集（177 tests 全过） | 跑 `pnpm verify:gate`（含 Gate 4 Electron 回环，耗时较长） |
| persona-brain 输出结构是否需要进契约 | 设计判断，非事实 | 与维护者确认 `ReflexHit`/`ConsumeResult` 是否跨进程（若跨，应登记 registry） |

---

## 9. 建议的下一步（按性价比排序）

1. **补「生成物漂移」门禁**：在 `verify-gate.mjs` 加「`pnpm gen:contracts` 后 `git diff --exit-code packages/shared-protocol/schema services/audio-ai-worker/protocol_models.py`」。这是当前唯一能让 §2.3 的 6 个漂移契约自动暴露的手段。
2. **把 `fixtures/` 与运行期默认人设解耦**：`character-persona.ts` 改从 `assets/persona/` 或包内 `defaults/` 读，夹具只留测试用。
3. **统一饭碗实现**：要么让 `token-meter` 复用 `RiceBowl`，要么删除 `RiceBowl` 并在 README 标明真实位置。当前两套阈值会让「饥饿」判定在 UI 与引擎间不一致。
4. **补 live-stream-hub 的 P0/P1/P2 或改文档**：要做抢占就在 `attention.ts` 的 `pick()` 前加优先级分层；不做就把 AGENTS §3.3 与 README 的「P0/P1/P2 抢占」「45s 切片」「节目状态机」移入未实现清单。
5. **修三个 README 的「未开工」与 model-gateway 的 MLX/剪贴板描述**——它们是新人理解架构的第一入口，现在错误率最高。

---

## 附：本次实测命令与输出（可复现）

```bash
# 1) 4 包单测 + 覆盖率（阈值置 0 仅为取数）
node_modules/.bin/vitest run packages/shared-protocol/src packages/model-gateway/src \
  packages/persona-brain/src packages/live-stream-hub/src --coverage \
  --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 \
  --coverage.thresholds.branches=0 --coverage.thresholds.statements=0
# → Test Files 10 passed (10) ｜ Tests 177 passed (177) ｜ Duration 642ms
# → All files 98.56% Stmts / 94.08% Branch / 100% Funcs / 99.46% Lines

# 2) 生成物漂移（只读；按 gen-contracts.ts 同一口径重算后逐字节比对）
node_modules/.bin/tsx -e '...import CONTRACT_SCHEMAS; toJSONSchema; diff...'
# → total=69 inSync=63 stale=6
# → stale: PetAvatarClip, PetAvatarManifest, PetDesktopPrefs, StardewAvatarSync, WorkFollowEvent, WorkFollowStatus

# 3) 依赖与接入面
grep -rliE "dyhub|douyin" --include=package.json --include=pnpm-lock.yaml .   # → 空
grep -rnE "P0|P1|P2|assignedPriority|preempt" packages/live-stream-hub/src --include='*.ts' | grep -v spec  # → 空
```
