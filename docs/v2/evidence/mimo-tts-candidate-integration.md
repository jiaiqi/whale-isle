# 小米 MiMo TTS 候选接入（tts / VoiceClone / VoiceDesign）+ OpenRouter Gemini TTS 第四家候选（`[TYPE-ONLY]` + `[SIMULATION]`）

> 日期：2026-11-27 · owner 决策「MiMo 接入作为候选 provider，不要设成默认」「OpenRouter Gemini 3.8 Flash TTS 接为第四家商用候选」
> 证据等级：**链路 `[SIMULATION]` + 真实 API `[REAL-DEVICE]`（2026-11-27 01:29–01:47 已实连，见 §2.4–§2.6）**
> 关联：[TTS-local-engine-benchmark-verification.md](./TTS-local-engine-benchmark-verification.md) §10、[VOICE-PERSONA-xiaojing.md](../VOICE-PERSONA-xiaojing.md)

---

## 0. 结论

- **owner 决定（2026-11-27）：语音主线定为小米 MiMo。** 默认档先切到 `mimo-tts`（内置音色），声线定稿后改到
  **`mimo-tts-voiceclone`**（默认声线 07 的参考音频锁声线）；MiniMax 因账号额度耗尽停用（provider 类与 BYOK 卡保留，可自行填凭据恢复）。`CANDIDATE_TTS_PROVIDERS` 本来就不含 `minimax-tts`（候选只有 openrouter-tts + MiMo 三态），无需改动。
- **声线定稿（2026-11-27）**：四条声线进声线库、07 为默认；参考音频随包分发（`assets/voice/`），主进程默认用它做 clone 源；回归见 §2.14。
- **适配器与路由已落地**：`MimoTtsProvider` 三个模型各注册一个实例——`mimo-v2.5-tts`（kind `mimo-tts`，内置 9 音色 + 唱歌前缀）、`mimo-v2.5-tts-voiceclone`、`mimo-v2.5-tts-voicedesign`；另有 `OpenRouterTtsProvider`（kind `openrouter-tts`，`google/gemini-3.8-flash-tts`）作为第四家候选。
- **候选身份是硬约束**：四家候选都**不进自动兜底链**（`COMMERCIAL_TTS_PROVIDERS` 仍只有 MiniMax / OpenAI）；只有用户显式选中才会走。2026-11-27 owner 决定把**默认档显式设为 `mimo-tts`**（内置音色固定声线），这不是自动兜底，MiniMax / OpenAI 仍留作备用档。
- **真实 API 已实连**（2026-11-27 01:29–01:47）：`mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`openrouter-tts` 全部成功合成；`api-key` 与 `Bearer` 两种认证头**都已实测通**（见 §2.4–§2.6）。Key 从 Electron 加密凭据库进程内取得，不落盘、不进日志。
- 单测 182 例全绿；假服务端真 HTTP 跑通 bench 全链路（6 个 provider key）；说话人嵌入余弦工具在真实音频上验证可用。
- **纠正一处旧谎报**：上一版 `probe()` 写 `supportsStreaming: true`，但适配器是非流式的。已改为 `false`，detail 里明写「非流式」。
- **音色漂移与 VoiceClone 锁定一致性已实测**（§2.8 / §2.9）：VoiceDesign 不能当固定声线，VoiceClone 用自产参考音频能把漂移压住；**情绪稳定性、唱歌听感、OpenRouter 计费实扣仍未实测**（见 §3），不得拿成功合成去宣称这些能力。

---

## 1. 接入形态

| 项 | MiMo | OpenRouter |
| --- | --- | --- |
| Base URL | `https://api.xiaomimimo.com/v1` | `https://openrouter.ai/api/v1` |
| 端点 | `${base}/chat/completions`（**不是** `/audio/speech`） | `${base}/audio/speech` |
| 模型 | `mimo-v2.5-tts` / `mimo-v2.5-tts-voiceclone` / `mimo-v2.5-tts-voicedesign` | `google/gemini-3.8-flash-tts` |
| 凭据 providerId | `mimo-tts`（三种模式共用） | `openrouter` |
| 环境变量（兜底） | `WHALE_MIMO_API_KEY` | `WHALE_OPENROUTER_API_KEY` |
| 响应取值 | `choices[0].message.audio.data`（base64 wav） | **原始音频字节**（`arrayBuffer`） |
| 认证头 | `authorization: Bearer` 或 `api-key`（**两种都未实测**，见 §1.3） | `authorization: Bearer` |
| 计费 | 限时免费（无商用条款） | $0.50/M 输入 token · $9/M 输出 token（一句多少钱要实测，不估算） |

### 1.1 三种 MiMo 模型的请求体差异

| | `mimo-v2.5-tts` | `mimo-v2.5-tts-voiceclone` | `mimo-v2.5-tts-voicedesign` |
| --- | --- | --- | --- |
| `messages[0]`（user） | 可选：自然语言风格指令（没有就不发这条） | 可选风格指令；没有时为空串 | **必填**：自然语言音色描述（+`；风格：…`） |
| `messages[1]`（assistant） | 正文（可带 `(Tag)` 前缀 / `(唱歌)` 前缀） | 正文 | 正文（开 `optimize_text_preview` 时可省略） |
| `audio` | `{ format:'wav', voice:'内置音色 id' }` | `{ format:'wav', voice:'data:audio/wav;base64,…' }` | `{ format:'wav' }` |
| 内置音色 | ✅ 9 个 | ❌ | ❌ |
| 唱歌前缀 | ✅ | ❌ | ❌ |
| 流式 | 官方称支持（`pcm16`） | ❌ | ❌ |

内置 9 音色（`MIMO_TTS_BUILTIN_VOICES`）：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。
`request.voiceRef` 命中列表就用它，否则回落 `defaultVoice`（环境变量 `WHALE_MIMO_VOICE`，默认 `mimo_default`）。

### 1.2 风格控制的正确口径（推翻上一版）

上一版把风格控制写成 VoiceDesign 专属，是错的。官方口径：

- **user 消息里的自然语言风格指令对所有模型都有效**，且不会被念出来。只有 voicedesign 是必填（那里它就是音色描述本身）。
- **助手前缀风格标签**：`(Lazy)要说的文本`，半角 `()`、全角 `（）`、`[]` 三种写法官方都接受；仓库统一半角。
- **正文内联音频标签**：`(sighs deeply)` / `(cough)` / `(pauses for a moment)` 可以出现在正文任意位置，一句最多一个。
- **唱歌**：只有 `mimo-v2.5-tts`，正文前缀 `(唱歌)` / `(sing)` / `(singing)`，由 `styleMode: 'singing'` 自动加。

五档情绪的指令与标签见 `docs/v2/VOICE-PERSONA-xiaojing.md` §3，代码常量是 `MIMO_EMOTION_STYLE_HINTS` / `MIMO_EMOTION_STYLE_TAGS`。

即便如此，`probe()` 仍报 `supportsEmotion: false`——**官方说有 ≠ 我们实测过**。等真跑出稳定性数据再改。

### 1.3 认证头（两种都已实测通）

官方 curl 示例用 `--header "api-key: $MIMO_API_KEY"`，而 OpenAI 兼容习惯是 `authorization: Bearer`。**2026-11-27 真机实测：两种都返回 200 且有音频**（各测过一次，没做一致性对拍）：

- `MimoTtsOptions.authScheme` 支持 `'api-key'`（**默认**，官方文档写法）与 `'bearer'`；
- `probe().detail` 写出当前用的是哪种，标注「已实测通」。

### 1.4 `optimize_text_preview` 与流式

- `optimize_text_preview: true` 仅对 voicedesign 生效：省略 assistant 消息，只按音色描述做预览。其它模式传了也忽略，不伪造字段。
- 流式官方要求 `format: "pcm16"`（24 kHz / 16-bit LE / 单声道），非流式用 `wav`。**适配器只做非流式 wav**，`supportsStreaming` 固定 `false`；`MIMO_TTS_STREAMING_FORMAT` 只是留给实现时的常量，不代表已支持。

### 1.5 OpenRouter Gemini 3.8 Flash TTS

- 走 `CloudOpenAiTtsProvider` 的**字节路径**（`/audio/speech` → `arrayBuffer`），不套 MiMo 的 JSON 解析。
- 请求体只有 `{model, input, voice, response_format:'wav'}`；**不传** `speed` / `instructions`——该模型的 `supported_parameters` 是空数组，官方没写风格/情绪怎么控制。
- `voice` 是 provider-specific（Google 预置音色名，默认 `Zephyr`）；`response_format` 默认是 `pcm`，我们显式传 `wav`。
- 能力口径：`supportsEmotion: false`、`supportsStreaming: false`，detail 写「情绪控制方式未验证」。
- bench 枚举 `--provider openrouter`，产物落 `artifacts/tts-ab/openrouter-gemini/`。

---

## 2. 已实测（可复现）

### 2.1 单测（`packages/voice-runtime/src/voice-runtime.spec.ts`）

| 断言 | 覆盖点 |
| --- | --- |
| 候选集合 | `COMMERCIAL_TTS_PROVIDERS` 仍两家；`CANDIDATE_TTS_PROVIDERS = [openrouter-tts, mimo-tts, mimo-tts-voiceclone, mimo-tts-voicedesign]` |
| 选了候选但它不可用 | 回落到稳定两家并 `honored:false` |
| `mimo-v2.5-tts` 请求体 | `audio.voice` 用内置音色；未知 voiceRef 回落 `mimo_default`；未知情绪不注入 user |
| 唱歌前缀 | 仅 tts + `styleMode:'singing'` 时正文带 `(唱歌)`，voicedesign 不加 |
| 前缀风格标签 | `(Tsundere)正文` |
| `optimize_text_preview` | voicedesign 省略 assistant 并传字段；tts 模式不传该字段 |
| 认证头可配置 | 默认发 `authorization: Bearer`；`api-key` 方案发 `api-key` 且不发 authorization |
| 不谎报流式 | 三种 MiMo 模式 `supportsStreaming === false`，detail 含「非流式」 |
| 内置音色表 | 恰好官方 9 个 |
| VoiceDesign / VoiceClone | 请求体、缺配置、缺 Key 的可读错误 |
| 失败路径 | HTTP 500 / 错误字段 / 空音频全部抛错 |
| OpenRouter | URL/请求体四字段/Bearer/原始字节解析；不传 speed/instructions；探针不宣称情绪与流式；缺 Key / 空音频 / 500 抛错 |

结果：voice-runtime **178 例全绿**（`vitest run`）。

### 2.2 bench 链路（假服务端，真 HTTP）

`tools/scripts/bench-tts-ab.mts --fake` 起本地 HTTP 服务按各家端点回固定正弦 wav，6 个 provider key 全跑通：

```
[minimax]           完成：2/2 成功 → artifacts/tts-ab/minimax
[openai]            完成：2/2 成功 → artifacts/tts-ab/openai
[openrouter-gemini] 完成：2/2 成功 → artifacts/tts-ab/openrouter-gemini
[mimo-tts]          （同上）
[mimo-voicedesign]  （同上）
[mimo-voiceclone]   （同上）
```

产物 `manifest.json` 每条带 `"simulated": true`，**只证明链路通**，不能当实测数据引用。

### 2.3 音色一致性工具（方法验证）

`tools/scripts/speaker-cosine.py` 在 ZipVoice 15 条真实产物上：两两 105 对，余弦均值 0.8563 · 中位 0.8589 · 最小 0.7545 · 最大 0.9104。
仅证明方法可用；MiMo / OpenRouter 的漂移量未测。

### 2.4 认证头实测记录

| 方案 | 结果 | 日期 | 备注 |
| --- | --- | --- | --- |
| `api-key` | ✅ 200 + wav 音频（6/6 + 7/7） | 2026-11-27 01:29–01:31 | 官方文档写法，现为默认 |
| `authorization: Bearer` | ✅ 200 + wav 音频（一句话，1920ms） | 2026-11-27 01:45 | 通过本仓库适配器实测 |

### 2.5 真实 API 实测（编排方探针，`[REAL-DEVICE]`，原始产物 `artifacts/tts-ab/mimo-real/`）

做法：Electron 进程内用 `safeStorage` 解开本机凭据库 `mimo-tts` 条目，直连 `api.xiaomimimo.com`；Key 不出进程、不落盘、不进日志。**注意**：`artifacts/tts-ab/mimo-real/` 是真机数据，而 `artifacts/tts-ab/mimo-voicedesign/` 曾被 `--fake` 的模拟产物覆盖过，2026-11-27 已被真机 bench 重跑覆盖为真机数据（manifest `simulated:false`）。

`mimo-v2.5-tts` + 内置音色 `冰糖`，6/6 成功：

| 档位 | 墙钟 | 音频时长 |
| --- | --- | --- |
| daily | 1215ms | 3.84s |
| bright | 1207ms | 3.52s |
| tsundere | 1629ms | 4.64s |
| sleepy | 1697ms | 4.16s |
| surprised | 1918ms | 4.00s |
| 内联标签 | 2657ms | 7.04s |

同一句话 × 六种控制（文案完全相同，唯一变量是风格指令 + 前缀标签）：

| 变量 | 时长 | F0 中位 | 墙钟 |
| --- | --- | --- | --- |
| baseline（不控制） | 3.52s | 244.9 Hz | 1611ms |
| daily `(Sweet)` | 3.84s | 242.4 Hz | 1623ms |
| bright `(Playful)` | 4.32s | 222.2 Hz | 1721ms |
| tsundere `(Tsundere)` | 4.00s | 242.4 Hz | **8055ms** |
| sleepy `(Sleepy)` | 4.96s | 216.2 Hz | 3436ms |
| surprised `(Excited)` | 3.84s | 255.3 Hz | 1615ms |

两个**客观迹象**：同一句话时长 3.52 → 4.96s（+41%）；F0 中位 216.2–255.3 Hz，慵懒最低、惊喜最高，方向对得上。**这是迹象，不是听感结论**；听感留给 owner。**延迟方差是实数**：tsundere 那次 8055ms，是其它次的 5 倍——报告里必须带方差，不能只写中位数。

VoiceDesign：用 `docs/v2/VOICE-PERSONA-xiaojing.md` 的音色描述，1972ms / 5.6s 音频，一次成功。

### 2.6 真实 API 实测（本仓库适配器走 `bench-tts-ab.mts --from-vault`，`[REAL-DEVICE]`）

`tools/scripts/vault-key.cjs`（Electron 子进程解密）→ `bench --from-vault`，Key 只经管道进父进程内存：

| provider | 成功率 | 墙钟（非流式，首包==整句） | 产物 |
| --- | --- | --- | --- |
| `mimo-tts`（内置音色） | 5/5 | 1048–1733ms | `artifacts/tts-ab/mimo-tts/`（`simulated:false`） |
| `mimo-voicedesign` | 5/5 | 1361–2799ms | `artifacts/tts-ab/mimo-voicedesign/`（覆盖旧 fake 数据） |
| `openrouter-gemini` | 3/3 | 2437–4487ms | `artifacts/tts-ab/openrouter-gemini/` |

### 2.7 bench 自身的两个 bug（已修，MiniMax 参数层实测）

`--provider minimax --from-vault` 最初 **25/25 报 `voice id not exist`**：bench 给所有 provider 统一传 `voiceRef: 'bench_voice'`，
MiniMax 把它直接当 `voice_id` 打进请求，账号里没这个音色。修法（只在 bench 改，不去 provider 里猜默认值）：

- `--voice <id>` 可覆盖；各 provider 默认值：MiniMax → `qiaopi_mengmei`（账号里已注册的定制音色，owner 确认）；
  OpenAI → `alloy`；`mimo-tts` → `mimo_default`；voicedesign / voiceclone 不使用 voiceRef。
- 修完第二层错误浮出：`invalid params: voice_setting emotion`——`MiniMaxTtsProvider` 把 app 自己的情绪键
  （`sweet_normal` 等）直接传进 `voice_setting.emotion`，MiniMax 只认闭合枚举（happy/sad/angry/…）。
  修法：新增 `MINIMAX_EMOTION_MAP`（app 五档 → MiniMax 枚举），未知情绪**直接不传这个字段**。
- **`group_id` 坑已确认不存在**：服务端能返回业务错误码（`voice id not exist` / `invalid params` / 用量上限），
  说明 Bearer 鉴权已覆盖 group，本链路不需要 `group_id`。
- 参数层修好后第三层错误：**Token Plan 用量已用尽**（`已达到 Token Plan 用量上限`），MiniMax 当前账号不可用。
  这是账单问题不是代码问题；MiniMax 的对拍继续记为未实测。
- 顺带纠正两处旧谎报：`MiniMaxTtsProvider` 与 `CloudOpenAiTtsProvider` 的 `supportsStreaming` 此前硬编码 `true`，
  适配器是非流式的，已改为 `false`（与 MiMo 同一口径）。

### 2.8 VoiceDesign 音色漂移（已实测，结论：**不能当固定声线**）

`--provider mimo-voicedesign --consistency 10 --from-vault`，10/10 成功（wall 1630–2445ms）。
说话人嵌入余弦（CAM++，两两 45 对），产物 `artifacts/tts-ab/mimo-voicedesign-consistency/`：

| | 均值 | 中位 | 最小 | 最大 | 标准差 |
| --- | --- | --- | --- | --- | --- |
| MiMo VoiceDesign（同一描述 ×10） | 0.7124 | 0.7368 | **0.4145** | 0.8407 | 0.0862 |
| ZipVoice 同音色基线（15 条） | 0.8563 | 0.8589 | 0.7545 | — | 0.027 |

**结论：VoiceDesign 同一段描述的漂移是实的**。最小 0.4145 已经是「听着不是同一个人」的量级（参照同音色基线 0.75+），
不能拿来做角色的固定声线。**推荐路径：VoiceDesign 出候选 → 人工挑一条 → VoiceClone 拿自产音频锁死**。
「音色设计台」的「设为桌宠声线」按钮因此只做候选写入，界面里明确提示漂移与锁声线路径。
VoiceClone 的锁定稳定性见 §2.9（已实测）。

### 2.9 VoiceClone 锁定一致性（已实测，2026-11-27）

`--provider mimo-voiceclone --consistency 10 --from-vault`，参考音频是 VoiceDesign 漂移组里**人工挑出的自产 `consistency-1.wav`**，
10/10 成功。说话人嵌入余弦（CAM++，两两 45 对），产物 `artifacts/tts-ab/mimo-voiceclone-consistency/`：

| | 均值 | 最小 | 最大 | 标准差 |
| --- | --- | --- | --- | --- |
| MiMo VoiceClone（同一自产参考 ×10） | **0.8342** | **0.7500** | 0.8990 | 0.0430 |
| 对照：VoiceDesign 同描述 ×10（§2.8） | 0.7124 | 0.4145 | 0.8407 | 0.0862 |
| 对照：ZipVoice 同音色基线 | 0.8563 | 0.7545 | — | 0.027 |

**结论：VoiceClone 能把漂移压住**——最低 0.7500 已与同音色基线（最低 0.7545）同量级，标准差从 0.0862 降到 0.0430。
所以「VoiceDesign 出候选 → 人工挑一条 → VoiceClone 锁死」这条管线是**实测成立**的，音色设计台的提示与这句一致。

**这份数据不能用来宣称什么**（原样写清，避免被读大）：

- 它验证的是**对自产参考音频的一致性**，不是「和某个真人/目标音色像不像」——后者需要目标音色的合法参考音频才能测。
- 参考音频只有一条、生成 10 次，**样本小**；只看余弦，**没做主观听感盲测**。
- VoiceClone 仍然走 MiMo **限免服务，无商用条款**——技术上通 ≠ 能上线（§5）。

### 2.10 供应商可用性快照（2026-11-27，本机凭据库 + 探针）

| 供应商 | 状态 | 依据 |
| --- | --- | --- |
| 小米 MiMo（tts / voiceclone / voicedesign） | **限免可用** | §2.5–§2.9 真实合成全部成功 |
| MiniMax T2A | **额度耗尽**（账单层拒绝） | §2.7：`已达到 Token Plan 用量上限`，参数层已修 |
| OpenAI 兼容 TTS | **无凭据** | 凭据库与环境变量都没有 `openai-tts` |
| OpenRouter Gemini TTS | **可用，但情绪控制未测** | §2.6 三次真实合成成功；`supported_parameters` 为空，情绪方式无官方说法 |

### 2.11 OpenRouter 计费口径（文档核对，未实扣）

2026-11-27 查官方页面（不需要额度）：

- OpenRouter 的 TTS 集合页明说**计费单位按模型而异，三种并存**：百万字符（多数 TTS 模型）/ 百万 token（如 Gemini TTS）/ 生成音频秒数；
  并提醒「比价前先统一单位」。<https://openrouter.ai/collections/text-to-speech-models/>
- `google/gemini-3.8-flash-tts` 模型页只列 token 价：**输入 $0.50 / M tokens，输出 $9 / M tokens**，Google AI Studio 与 Vertex 同价；
  页面没有单独的音频输入/输出价，也没写死 TTS 走哪种计费单位。<https://openrouter.ai/google/gemini-3.8-flash-tts>
- OpenRouter 本身不加每请求加价，费用按上游 token 用量从余额扣；平台费在充值时收（Standard 5.5%），并建议请求带 `usage: {include: true}` 取回用量。<https://openrouter.ai/pricing>
- 因此**一句话的花费取决于文本 token + 生成音频 token**，不能按字符或秒估；要写进产品对比必须拿真实账单实扣（当前未测，§3 保持未实测）。
- 这也解释了为什么它不能挂「限免」角标：候选 ≠ 免费（代码里 `limitedFree` 只对 `mimo-*` 生效）。

### 2.12 同一情绪指令的稳定性（daily ×10，已实测）

`--provider mimo-tts --consistency 10 --emotion daily --from-vault`，同一句
「主人，今天也辛苦啦，我给你倒杯热茶好不好呀。」连跑 10 次，全部走 daily 档
（user 侧「温柔甜软，带笑意，语速适中」+ assistant 前缀 `(Sweet)`），10/10 成功，wall 1202–3825ms。
产物 `artifacts/tts-ab/mimo-tts-daily-consistency/`（含 `stability.json`），读数用新脚本
`tools/scripts/voice-stability.py`（40ms 帧 / 10ms hop 自相关 F0，只统计浊音帧）：

| 指标 | 均值 | 标准差 | 最小 | 最大 | CV |
| --- | --- | --- | --- | --- | --- |
| 时长 s | 3.808 | 0.2361 | 3.36 | 4.16 | 6.2% |
| RMS dBFS | −18.93 | 1.39 | −21.65 | −16.90 | 7.4% |
| F0 中位 Hz | 250.3 | 10.97 | 230.77 | 266.67 | 4.4% |

**怎么读**：同一档情绪下，音高是最稳的一维（F0 中位 230.8–266.7 Hz，跨度约 2.5 个半音）；
时长与响度有可感波动（±0.4s、±1.4dB），最极端两次相差 0.8s / 4.75dB。
这是「同一档情绪十次像不像同一次」的**客观读数**：像，但不是复制粘贴——情绪标签没有把声学参数钉死。
听感结论仍留给 owner；本次只测一档（daily）一句话，其它四档与长句未测。

### 2.14 声线定稿与锁定回归（2026-11-27，已实测）

**定稿**：owner 决赛圈两轮一致勾选四条（02 御姐冷·年轻 / **07 黏糊·调皮（默认）** / 08 黏糊·半睡 / 12 憨憨·偏低发呆），
描述原文见契约层 `MIMO_TIMBRE_PRESETS`，人设文档见 [VOICE-PERSONA-xiaojing.md](../VOICE-PERSONA-xiaojing.md)。

**参考音频**：用 07 的描述现场合成一条干净台词「主人，今天也辛苦啦，我给你倒杯热茶好不好呀。」
（`mimo-v2.5-tts-voicedesign`，风格提示只加「自然地说，不要播音腔」，不带情绪档）
→ `assets/voice/xiaojing-07-nianhu-piqi.wav`（24 kHz / 16-bit / 单声道 / 5.6s / 263 KB，自产文本 + MiMo 生成）。

**回归一：clone 锁定**（同一句 ×10，参考音频 = 上面那条随包基准，`--provider mimo-voiceclone --consistency 10`）：

| | 均值 | 最小 | 最大 | 标准差 |
| --- | --- | --- | --- | --- |
| **随包基准 07（本次）** | **0.8373** | **0.7723** | 0.8881 | **0.0245** |
| 对照：自产 `consistency-1.wav` 参考（§2.9） | 0.8342 | 0.7500 | 0.8990 | 0.0430 |
| 对照：VoiceDesign 同描述 ×10（§2.8） | 0.7124 | 0.4145 | 0.8407 | 0.0862 |

10/10 成功，wall 1442–3592ms。最小 0.7723 高于同音色基线（0.7545）量级，σ 0.0245 也更紧 → **锁定成立**。
产物 `artifacts/tts-ab/mimo-voiceclone-bundled/mimo-voiceclone/`（余弦用 `tools/scripts/speaker-cosine.py`）。
**边界照旧**：只证明「对这条参考音频的一致性」；参考音频只有一条、10 次生成、样本小；只听余弦，未做听感盲测；
MiMo 限免无商用条款。

**回归二：五档情绪 × 同一句 ×3（clone 声线）**：

| 档位 | 时长 s | RMS dBFS | F0 中位 Hz |
| --- | --- | --- | --- |
| daily 软萌小仆 | 5.49（σ 0.40） | −19.43（σ 0.23） | 292.4（σ 15.9） |
| bright 俏皮上扬 | 5.28（σ 0.26） | −18.71（σ 0.30） | 286.2（σ 12.5） |
| tsundere 傲娇炸毛 | 5.23（σ 0.27） | −18.35（σ 0.43） | 297.1（σ 16.2） |
| sleepy 慵懒气声 | 5.12（σ 0.45） | −20.03（σ 1.00） | 284.3（σ 8.9） |
| surprised 惊喜元气 | 5.39（σ 0.72） | −19.98（σ 0.32） | 291.9（σ 11.2） |

**结论（必须照抄这个口径）**：档间跨度（时长 0.37s、RMS 1.68dB、F0 12.8Hz）与每档自身波动
（时长 σ 0.26–0.72s、RMS σ 0.23–1.00dB、F0 σ 8.9–16.2Hz）**同量级甚至更小**，
即**客观量上五档情绪在 clone 声线上没拉开**；是否成立只能靠听感判断（留给 owner）。
这与 §2.5 内置音色上的单次迹象（时长 +41%、F0 216–255Hz）不矛盾：那是不同句子、不同声线的单次对比，不可直接横比。
产物 `artifacts/tts-ab/mimo-voiceclone-bundled/`（`stability-all.json` 含每条读数）。

### 2.13 OpenRouter 音色备选池（Gemini 3.8 Flash TTS）

- 官方文档列 **30 个预置音色**：Zephyr、Puck、Charon、Kore、Fenrir、Leda、Orus、Aoede、Callirrhoe、Autonoe、Enceladus、Iapetus、Umbriel、Algieba、Despina、Erinome、Algenib、Rasalgethi、Laomedeia、Achernar、Alnilam、Schedar、Gacrux、Pulcherrima、Achird、Zubenelgenubi、Vindemiatrix、Sadachbia、Sadaltager、Sulafat（另有扩展音色库，需 `client.voices.list()`）。
  文档还写明情绪/风格走 `style` 字段与内联 `<sigh>` 类标签——**这是 Gemini 原生 API 的形态，不是 OpenRouter `/audio/speech` 的形态**，后者只收 `{model,input,voice,response_format}`，所以在本仓库里情绪控制仍按「未验证」处理。来源：<https://aistudio.google.com/docs/speech-generation>
- **本仓库适配器默认 `Zephyr`**（此前 3/3 实测就是它）。2026-11-27 用凭据库 Key 试调 `voice:'Kore'`：HTTP 200 / 3625ms / 80204 bytes；试调 `voice:'NotAVoice'`：HTTP 400（`Request contains an invalid argument`，不回显合法清单）。
- **结论口径**：30 个名字来自 Google 官方文档，OpenRouter 侧只逐个实调过 `Zephyr`（历史 3/3）与 `Kore`（1 次）；其余 28 个**未逐个验证**，当备选池用时先单条试调。OpenRouter 端点元数据 `supports_voice_cloning:false`、`supported_parameters:[]`。

---

## 3. 未实测（逐项写清，不许拿估算值填）

| 项 | 状态 | 缺什么 |
| --- | --- | --- |
| VoiceDesign 音色漂移 | ✅ **已实测**（§2.8）：最小 0.4145，不能当固定声线 | 漂移路径已写死为「候选→人工挑→VoiceClone 锁死」 |
| VoiceClone 克隆一致性 | ✅ **已实测**（§2.9）：均值 0.8342 / 最小 0.7500，能锁住；但对自产参考、样本小、未听感盲测 | 与目标音色的相似度需合法参考音频另测 |
| 五情绪指令 / 前缀标签 / 内联标签的**稳定性** | ✅ **daily 档（内置音色）已实测**（§2.12，×10）；✅ **五档 ×3（clone 声线）已实测**（§2.14，档间客观量没拉开）；内置音色上的其余四档与长句**未实测** | 其余四档同法各跑 ≥10 次 |
| 唱歌前缀听感 | **未实测** | 跑 `--from-vault --provider mimo-tts`，styleMode=singing 单独实验 |
| OpenRouter 情绪控制方式 | **未实测（官方无说法）** | 只能单开实验组，不进能力声明 |
| OpenRouter 一句实际花费 | **未实测**（口径已核对，§2.11） | 按 token 计费，必须拿真实账单实扣 |
| OpenRouter 音色池 | 文档 30 个，**实调过 2 个**（Zephyr / Kore，§2.13） | 其余 28 个用时先单条试调 |
| 与 MiniMax / OpenAI 的同表对拍 | **未实测** | MiniMax/OpenAI 凭据不在当前可连实例里 |

---

## 4. 与稳定两家的对拍表（客观项，空白格就是没测）

| 供应商 | 一句话整句耗时 | 首包 | 成功率 | 音色一致性 | 一句花费 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| MiniMax T2A v2 | **未实测（Token Plan 用量已用尽）** | 未实测 | 0/5（账单层失败，参数层已修） | 不适用（指定 voice_id） | 未实测 | `bench_voice` 与 emotion 两处参数 bug 已修（§2.7） |
| OpenAI 兼容 TTS | **未实测** | 未实测 | 未实测 | 不适用（指定 voice） | 未实测 | 缺 `openai-tts` 凭据 |
| OpenRouter Gemini TTS | **2437–4487ms**（n=3） | =整句（非流式） | 3/3 | 不适用（预置音色） | 未实测（按 token） | 第四家候选 |
| MiMo 内置音色 | **1048–1733ms**（适配器 n=5；探针另有 tsundere 8055ms 的方差实例） | =整句（非流式） | 5/5（探针 6/6） | 未实测 | 限时免费 | 9 内置音色 |
| MiMo VoiceDesign | **1361–2799ms**（n=5）；探针单次 1972ms | =整句（非流式） | 5/5 + 10/10（漂移组） | **已实测：余弦最小 0.4145，不能当固定声线** | 限时免费 | 需音色描述 |
| MiMo VoiceClone | 未单独记录（同 bench 轮次） | =整句（非流式） | 10/10 | **已实测：均值 0.8342 / 最小 0.7500（对自产参考）** | 限时免费 | 需合法参考音频（§2.9） |

听感结论不下，留给 owner 自己听。

---

## 5. 「限时免费」风险（MiMo 单列，必读）

事实（2026-11-27 官方模型页）：

- 标价 **「限时免费」**，**页面没有任何商用条款**；只有用户协议与隐私政策链接。
- 同站顶部横幅：**MiMo-V2.5-Pro / V2.5 文本系列已于 2026-10-21 下线**，TTS 是否同命运未明说。
- 限流：100 RPM / 10M TPM / 8K 上下文。

三条硬约束：

1. **不得作为默认档**：`voiceCommercialProvider` 默认仍是 `minimax-tts`。
2. **不得进自动兜底链**：`resolveCommercialTtsProvider()` 的回落目标只有稳定两家。
3. **UI 必须带风险提示**：候选按钮挂「限免」角标，选中后显示 `MIMO_TTS_CANDIDATE_NOTICE`。

OpenRouter 的风险是另一类：按 token 计费、单价已知但一句实际花费未知；它同样不进兜底链。

### 切回路径

| 情形 | 动作 | 是否需要改代码 |
| --- | --- | --- |
| MiMo 开始收费 | 默认档选回 MiniMax / OpenAI（一次点击） | ❌ |
| MiMo 下线 / 401 | 探针 `available:false`，回落稳定两家并说明原因 | ❌ |
| 模型 ID 改名 | 改 `MIMO_TTS_MODELS` / `OPENROUTER_GEMINI_TTS_MODEL` | ✅ 一行 |
| 凭据要撤 | 语音中心凭据卡片重填，或删凭据库条目 | ❌ |

---

## 6. 凭据怎么填（2026-11-27 owner 定：走 UI，不走环境变量）

语音中心新增四张凭据卡（`data-voice-credential`）：`minimax` / `openai-tts` / `openrouter` / `mimo-tts`（MiMo 三种模式共用一个 Key）。

- 保存走已有通道 `providers:save-key` → safeStorage 加密的 `provider-vault.json`；
- 明文只上行：输入框清空、UI 只显示 `••••后四位`、不写日志、不进渲染层持久化；
- 保存后立即重探所有 provider，卡片上的「可用 / 未配置」与 detail 同步刷新；
- 来源标注：有掩码 → **凭据库**；无掩码但探针可用 → **环境变量**；否则 **未配置**（主进程解析顺序就是凭据库优先、环境变量兜底）。

环境变量仍保留，供 bench 与无 UI 场景使用，但不是主路径。

---

## 7. 复跑方式

```bash
# 1) 不花钱验证链路（假服务端，产物标 simulated）
npx tsx tools/scripts/bench-tts-ab.mts --fake --provider all --limit 2

# 2) 真跑 MiMo（Key 从环境读，不进仓库）
WHALE_MIMO_API_KEY=… WHALE_MIMO_VOICE_DESCRIPTION='…' \
  npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign

# 3) 真跑 OpenRouter
OPENROUTER_API_KEY=… npx tsx tools/scripts/bench-tts-ab.mts --provider openrouter

# 4) 音色漂移：同描述连跑 10 次再算余弦
WHALE_MIMO_API_KEY=… WHALE_MIMO_VOICE_DESCRIPTION='…' \
  npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign --consistency 10
uv run --with sherpa-onnx --with numpy python -I tools/scripts/speaker-cosine.py \
  artifacts/tts-ab/mimo-voicedesign/consistency-*.wav
```

---

## 8. 证据等级声明

- `[SIMULATION]`：单测 + 假服务端 bench 链路 + 路由/兜底行为。
- `[REAL-DEVICE]`：2026-11-27 01:29–01:47 真实 API 合成（探针 + 本仓库适配器两条路径）、认证头两种方案、说话人嵌入余弦方法验证。
- **未实连**：音色漂移（≥10 次）、情绪稳定性、唱歌听感、OpenRouter 计费、MiniMax/OpenAI 对拍。
