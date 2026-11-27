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

### 2.15 三候选（02 / 08 / 12）全套锁定回归 + 「设计版 vs 克隆版」差异（2026-11-27，已实测）

**背景**：owner 听了 07 的**锁定版（clone）**判定「音色不对味」，于是把 02 / 08 / 12 各做一套一模一样的流程，
并额外测「clone 输出 vs 该候选的 VoiceDesign 原样本」的余弦——用来区分两种可能：
① clone 把音色改坏了；② 设计版本来就是这味、owner 只是在 07 之外挑。
**默认声线没动**（仍是 07 的参考资产），07 那套**没有重跑**（沿用 §2.14）。

**做法**：每候选①用各自描述 +「自然地说，不要播音腔」合成一条同句参考音频（与 07 同句，便于横比）→
② clone 同一句 ×10 → ③ 五档情绪 ×3。每候选 26 次真实调用，产物 `artifacts/tts-ab/mimo-voiceclone-<id>/`。

**结果一：clone 锁定一致性（10 条两两 45 对）**

| 候选 | 均值 | 中位 | 最小 | 最大 | 标准差 |
| --- | --- | --- | --- | --- | --- |
| 07（既有） | 0.8373 | 0.8369 | 0.7723 | 0.8881 | **0.0245** |
| 02 御姐冷·年轻 | 0.8275 | 0.8360 | **0.7189** | 0.8987 | 0.0414 |
| 08 黏糊·半睡 | 0.8705 | 0.8816 | 0.7552 | 0.9309 | 0.0395 |
| 12 憨憨·偏低发呆 | **0.8912** | 0.8937 | **0.8340** | 0.9379 | 0.0285 |

稳定性排序：**12 > 08 > 07 > 02**（12 最低 0.8340 高于其余三者的最小值，锁得最死）。

**结果二：关键测量——「clone 输出 vs 该候选的 VoiceDesign 原样本」余弦（同一句，10 条对基准）**

| 候选 | 均值 | 最小 | 最大 | 标准差 | 与自身 clone 内部一致性对比 |
| --- | --- | --- | --- | --- | --- |
| 07 | 0.8409 | 0.7960 | 0.8864 | 0.0264 | 0.8409 vs 0.8373 → **基本持平** |
| 02 | **0.7925** | **0.7472** | 0.8326 | 0.0277 | 0.7925 vs 0.8275 → **低了 0.035** |
| 08 | 0.8811 | 0.7884 | 0.9049 | 0.0328 | 0.8811 vs 0.8705 → 略高 |
| 12 | **0.8987** | **0.8711** | 0.9249 | 0.0191 | 0.8987 vs 0.8912 → 略高 |

**结论（回答那一问）**：**clone 没有把音色改坏**。四条候选里「设计版 vs 克隆版」的余弦都落在 **0.79–0.90**，
与它们各自的 clone 内部一致性（0.83–0.89）**同一量级**，没有出现「clone 明显偏离设计版」的断层。
所以 owner 否掉 07 的锁定版，**更可能是「07 这条设计味本来就对不上桌宠形象」，而不是 clone 改坏了声音**——
换句话说，下一步是「在 02 / 08 / 12 里挑一条」，不是「修 clone」。
唯一例外是 **02 偏低 0.035**（0.7925 vs 0.8275），说明 clone 对 02 的改动比其他三条略明显，值得在听 02 时留意。

**结果三：五档情绪 ×3 的客观量（时长 s / RMS dBFS / F0 中位 Hz，均值±σ）**

| 档位 | 07 | 02 | 08 | 12 |
| --- | --- | --- | --- | --- |
| daily | 5.49(0.40) / −19.43(0.23) / 292.4(15.9) | 4.43(0.38) / −18.70(0.51) / 228.2(1.3) | 5.17(0.42) / −21.07(0.62) / 262.9(4.9) | 6.51(1.84) / −24.38(1.64) / 94.1(7.6) |
| bright | 5.28(0.26) / −18.71(0.30) / 286.2(12.5) | 4.16(0.23) / −16.97(1.03) / 224.3(3.0) | 4.80(0.35) / −20.40(1.13) / 275.6(14.7) | 6.29(1.21) / −24.15(0.83) / 95.4(0.7) |
| tsundere | 5.23(0.27) / −18.35(0.43) / 297.1(16.2) | 4.43(0.20) / −18.63(0.60) / 232.7(10.1) | 5.12(0.35) / −21.35(0.92) / 274.5(14.2) | 4.96(0.79) / −24.86(1.56) / 90.8(1.3) |
| sleepy | 5.12(0.45) / −20.03(1.00) / 284.3(8.9) | 4.32(0.13) / −17.61(0.51) / 238.4(3.0) | 4.80(0.13) / −20.62(0.61) / 261.0(6.2) | 5.76(0.35) / −21.77(0.78) / 88.9(3.5) |
| surprised | 5.39(0.72) / −19.98(0.32) / 291.9(11.2) | 4.32(0.13) / −17.10(1.35) / 232.1(12.0) | 5.28(0.45) / −20.42(0.31) / 263.0(7.4) | 5.76(0.35) / −25.04(0.79) / 89.6(2.8) |

**诚实结论（四条候选一致）**：每条候选的**档间跨度都与档内波动同量级甚至更小**——
07 时长档间 0.37s vs 档内 σ 0.26–0.72s；02 时长 0.27s vs σ 0.13–0.38s；08 F0 14.6Hz vs σ 4.9–14.7Hz；
12 时长 1.55s vs σ 0.35–1.84s。即**客观量上五档情绪在 clone 声线上一律没拉开**，是否成立只能靠听感判断。
另有一条可复用的观察：**12 的基频只有 ~89–95Hz**（明显低于 07 的 ~284–297Hz、08 的 ~261–276Hz、02 的 ~224–238Hz），
说明「偏低的中性软声」在 MiMo 上被落实成了一条**接近男声/中性低频**的声线，听感差异应当非常显著。

**未实测 / 未做**：主观听感盲测；「更长、更有情绪层次的参考音频」（两三句拼接、涵盖娇/懒两种状态）再克隆一次的效果——
按编排要求**这一轮先不做**，等数字看完再决定。**后续（2026-11-27 定稿）**：owner 把音色方向改为八九岁小女孩，
02 / 08 / 12 与旧 07 的参考资产已从随包资源撤出、归档到 `artifacts/voice-archive-2026-11-27/`，
本节数字只作为方法证据保留，见 §2.17。

### 2.16 情绪方法验证：按档参考音频 + 按档克隆（2026-11-27，判据**先注册后跑**）

#### 2.16.0 前置更正：上一轮「五档情绪没拉开」的结论作废

上一轮（§2.14 / §2.15）跑的「五档情绪 ×3」**语气指令一条都没发出去**。原因是
`tools/scripts/bench-tts-ab.mts` 自己抄了一份情绪表（`EMOTION_HINTS`），键只有
`sweet_normal / tsundere_refuse / rage_spray / lazy_yawn / happy_rice`（声音工坊那套），
**没有** `daily / bright / tsundere / sleepy / surprised`（语音中心那套）。
`MimoTtsProvider.styleInstruction()` 查不到键就返回空串，于是请求体变成：

```json
[{"role":"user","content":""},{"role":"assistant","content":"主人，今天也辛苦啦…"}]
```

—— 没有风格指令，也没有 `(Sweet)` 前缀。五档实际发的是**同一条请求**，所以「档间跨度 ≈ 档内波动」
是必然的，它证明不了 MiMo 拉不开情绪。已修：bench 改为直接转引契约层
`MIMO_EMOTION_STYLE_HINTS` / `MIMO_EMOTION_STYLE_TAGS`（主进程读的是同一份），不再抄。
**结论作废，本节重测。**

#### 2.16.1 预注册判据（跑之前写死，跑完不改）

设某候选的实验产出：5 档情绪 × 3 条克隆 = 15 条。

| 记号 | 定义 |
| --- | --- |
| 档内余弦 `W` | 同一情绪档内的两两说话人余弦，5 档 × C(3,2)=3 对 = 15 对 |
| 跨档余弦 `X` | 不同情绪档之间的两两说话人余弦，C(5,2)=10 组档对 × 3×3=9 对 = 90 对 |
| `μ_W` / `σ_W` | 档内余弦的均值 / 标准差 |
| `μ_X` | 跨档余弦的均值 |
| 档间极差 | 每档 F0 中位 / 时长 / RMS 的「五档均值里的最大 − 最小」 |

**通过线（任一档位维度）**：

- **M1 说话人余弦锁住**：`μ_X < μ_W − 2·σ_W`
- **M2 客观读数分档**：F0 中位 / 时长 / RMS 三者中**至少一项**的档间极差 `≥ 2 ×` 该指标档内标准差
- **M3 情感敏感距离**：说话人嵌入对情绪本就不敏感（它编码的是音色/说话人），因此另加一个
  韵律特征距离（MFCC-13 + F0 统计 + 时长 + RMS + 频谱质心，z-score 后欧氏距离）：
  跨档距离均值 `> 档内距离均值 + 2 × 档内距离标准差`

**方法成立 = M1 且（M2 或 M3）**。若只有 M2/M3 成立而 M1 不成立，写成
「情绪被锁住了，但说话人余弦这个指标测不出来」——方法仍算成立，但要写明余弦指标对情绪不敏感，
不能再拿它去论证情绪差异。

**归因对照（三组臂，各 15 条）**：

| 臂 | 参考音频 | 请求里的情绪指令 | 回答的问题 |
| --- | --- | --- | --- |
| **A** | 固定的中性参考（同一条给五档） | 有 | 修正后的「指令单独」够不够 |
| **B** | 按档情绪参考 | 有 | 产品路径（选情绪 → 换参考 → 说） |
| **C** | 按档情绪参考 | 无 | 情绪到底是不是**参考音频**带来的 |

- 若 B 成立而 A 不成立 → 关键是**参考音频**（新方法成立）。
- 若 A 也成立 → 关键是指令，参考音频不是必要条件（新方法不成立，写失败）。
- 若 C 成立 → 情绪可由参考音频单独携带（最强的「锁住」证据）。

**未做**：主观听感盲测；更长/多情绪层次的参考音频（等 owner 看数字再定）。

#### 2.16.2 结果（候选 12，六臂各 15 条；产物 `artifacts/tts-ab/emotion-matrix-12-hanhan-difa/`）

**参考集自相似（五条参考音频两两余弦，10 对）**——这一行决定了后面所有解读：

| 参考集 | 怎么来的 | 均值 | 最小 |
| --- | --- | --- | --- |
| `refs` | 五条**各自那一档情绪**指令生成 | **0.5158** | 0.3933 |
| `refs-neutral` | 五条都不带情绪指令 | 0.7665 | 0.7179 |
| `refs-daily` | 五条**都用同一档（daily）**指令 | 0.8116 | 0.7174 |
| `refs-2stage`（事后补，F 臂用） | 用中性参考 + 情绪指令克隆出五条 | 0.8150 | 0.7140 |

即：**「按情绪各生成一条参考」等于生成了五个人**（0.5158）。这是 §2.8 漂移结论的直接后果，
不是情绪带来的。

**六臂判决（判据照 §2.16.1，不事后改线）**

| 臂 | 参考 | 指令 | `μ_W` | `μ_X` | M1 线 | M1 | M2（F0 极差 vs 2×σ） | M3（韵律距离） | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A 指令单独 | 固定中性 | 有 | 0.8643 | 0.8402 | 0.8063 | **FAIL** | 17.23 vs 14.13 PASS | 8.52 vs 11.65 **FAIL** | 不成立 |
| B 产品路径 | 按档情绪 | 有 | 0.8046 | 0.4529 | 0.6726 | PASS | 134.68 vs 25.60 PASS | 8.89 vs 8.25 PASS | 成立 |
| C 纯参考 | 按档情绪 | 无 | 0.8773 | 0.4987 | 0.8207 | PASS | 130.11 vs 11.31 PASS | 9.01 vs 6.61 PASS | 成立 |
| D 漂移对照 | 五条中性参考 | 无 | 0.8903 | 0.7523 | 0.8385 | PASS | 14.44 vs 6.03 PASS | 8.76 vs 10.21 **FAIL** | ⚠ 按判据也「成立」 |
| E 严格匹配对照 | 五条同一情绪参考 | 无 | 0.8871 | 0.7500 | 0.8337 | PASS | 12.79 vs 12.00 PASS（擦线） | 8.75 vs 10.12 **FAIL** | ⚠ 按判据也「成立」 |
| F 两段式参考（事后） | 同人 + 情绪 | 无 | 0.8831 | 0.7768 | 0.8125 | PASS | 26.75 vs 12.04 PASS | 8.79 vs 9.99 **FAIL** | ⚠ 按判据也「成立」 |

**判据本身不成立（必须先说这条）**：D / E 是**对照臂**——D 的五条参考是同一条描述各跑一遍（纯漂移），
E 的五条参考连情绪都相同（只差采样噪声）。它们按预注册判据也会被判「方法成立」，
说明 **M1（说话人余弦）+ M2（F0 极差）这一组合无法区分「情绪」和「VoiceDesign 参考漂移」**。
E 的 M2 更是擦线通过（12.79 vs 12.00，差 0.79Hz）。**预注册判据在下一轮必须收紧**（见本节末「判据修正」）。

**决定性证据不在判据里，在效果量与对齐率上**：

| 指标 | C（真情绪参考） | E（同一情绪参考，严格对照） | 差 |
| --- | --- | --- | --- |
| F0 中位档间极差 | **130.11 Hz** | 12.79 Hz | **10.2×** |
| 档内 F0 池化 σ | 5.66 Hz | 6.00 Hz | — |
| 克隆对齐到自己那档参考（韵律 top1） | **14/15** | 10/15 | — |
| 克隆对齐到自己那档参考（F0 top1） | **14/15** | 4/15 | — |
| 克隆离自己那档情绪参考更近（韵律，>中性参考） | **15/15** | 9/15 | — |
| 身份保持（对自己的参考 vs 对别人的参考） | 0.8912 vs 0.5041，gap **0.3871** | 0.9042 vs 0.7704，gap 0.1338 | — |

**结论一：情绪确实能由参考音频携带，而且很强。** C 臂五档 F0 中位极差 130Hz、15 条全部更贴近自己那档参考，
这是「情绪被锁进参考音频」的直接证据；同样的请求在 E 臂（参考只差采样噪声）下极差只有 12.8Hz。
**结论二：但代价是角色被换掉。** 五条情绪参考彼此只有 0.5158 余弦（§2.16 开头的表），
C 臂克隆对「自己那档参考」0.8912、对「别人那档参考」0.5041——**按情绪切参考 = 按情绪切人**。
**结论三：两段式（F）保人不保情绪。** 先用中性参考 + 情绪指令克隆出「同一个人带情绪」的参考集
（自相似 0.8150，与 `refs-daily` 同量级），再用它克隆：身份 gap 0.1222（与对照 E 的 0.1338 同级，角色没被换），
但 F0 档间极差只剩 26.75Hz，M3 未过，15 条里只有 9 条更贴近自己的情绪参考。
**产品化结论：这条方法不接产品。** 有效的那条（C/B）会把角色音色一起换掉，
保人的那条（F）效果量掉回对照水平；产品继续用「风格指令 + 前缀标签」，
并在 §2.17 如实量它拉开多少。

**判据修正（下一轮用，不回溯改本轮）**：M2 的 F0 项改为「档间极差 ≥ 3× 档内池化 σ **且** ≥ 3× 严格匹配对照臂
的档间极差」；M1 增加「参考集自相似 ≥ 0.75」作为前置门槛（否则测的只是「换人」）。

**未做**：主观听感盲测；02 / 08 的同口径复跑（owner 已把 02/08/12 冻结为方法证据，按编排要求只做 12 的完整六臂）；
更长/多情绪层次的参考音频。

### 2.17 声线定稿：07 甜脆·元气（2026-11-27，已实测）

**owner 决定**：音色方向改为「小萝莉，可爱、调皮、傲娇，8 岁左右」，原话
「八九岁小女孩，声音甜而脆，元气满满，语速快，句尾翘起来，像随时要跳起来」。
此前四条成人向描述（07 黏糊·调皮 / 02 / 08 / 12）**全部作废**，只作为方法证据留在 §2.14 / §2.15；
默认声线、声线库、随包参考资产统一换成这一条。

**① 参考音频**

| 项 | 值 |
| --- | --- |
| 路径 | `assets/voice/xiaojing-07-tiancui-yuanqi.wav`（245,804 B） |
| 生成 | 自产台词「主人，今天也辛苦啦，我给你倒杯热茶好不好呀。」+ VoiceDesign，不带情绪指令（1820 ms） |
| 客观读数 | 5.12 s · RMS −24.51 dBFS · F0 中位 **406.78 Hz**（此前成人向 07 是 ~284–297Hz 的合成输出，本条更高更脆） |
| 撤包 | 02 / 08 / 12 与旧 07 的参考音频**已从随包资源撤出**，归档到本机 `artifacts/voice-archive-2026-11-27/`（`artifacts/` 不入库） |
| 与旧 07 的关系 | 两条参考音频的说话人余弦 **0.4849** —— 基本是两个人，owner 判「不对味」在数值上也成立 |

**② clone 锁定（同一句 ×10，两两 45 对）——与成人基线并列**

| 参考 | 均值 | 中位 | 最小 | 最大 | σ |
| --- | --- | --- | --- | --- | --- |
| **07 甜脆·元气（新）** | **0.9059** | 0.9054 | **0.8814** | 0.9440 | **0.0148** |
| 07 黏糊·调皮（旧，成人基线） | 0.8373 | 0.8369 | 0.7723 | 0.8881 | 0.0245 |
| 12（四候选里最稳） | 0.8912 | 0.8937 | 0.8340 | 0.9379 | 0.0285 |
| 02 / 08 | 0.8275 / 0.8705 | — | 0.7189 / 0.7552 | — | 0.0414 / 0.0395 |

克隆输出 vs 参考音频逐条：均值 0.9086 / 最小 0.8824 / σ 0.0302（n=11，含参考自身）。10/10 成功，单次 1.6–4.6 s。

**诚实解读**：儿童音色的说法是「说话人嵌入不稳、一致性可能更差」，**本次实测相反**——
最小值 0.8814，比成人基线 0.7723 高 0.109，也比四候选最强的 12（0.8340）高。
所以这条不需要「拿成人门槛硬套」的免责，它是目前四条里锁得最死的一条。
两条口径限制照旧写清：① 克隆句与参考句**是同一句**（协议一贯如此，会抬高一致性）；
② 只测说话人余弦，不测听感，也不测「像不像八九岁」。

**③ 三种表演（同一句 ×3，各 3 条；9/9 + 对照 3/3 成功）**

- 句：「主人，你回来啦，(pauses for a moment) 今天有没有想我呀？」
- 手段：情绪方法**未通过**（§2.16.2），退回「契约层风格指令 + 助手前缀标签 + 一个内联标签」，三种表演直接映射产品五档：
  调皮 → `bright`「俏皮上扬，语气活泼，句尾轻轻挑起」+ `(Playful)`；傲娇 → `tsundere`「傲娇嘴硬，稍不服气，音量略大」+ `(Tsundere)`；
  撒娇 → `daily`「温柔甜软，带笑意，语速适中」+ `(Sweet)`；另跑一组**中性对照**（同句、同参考、无任何指令与标签）。
- 产物：`artifacts/tts-ab/perform-07-tiancui/<键>/<键>-<n>.wav`（`manifest.json` 含每次的指令、标签、正文与耗时）。
  工具：`tools/scripts/voice-performance.mts`。

| 表演 | 情绪档 | 时长 s | RMS dBFS | F0 中位 Hz |
| --- | --- | --- | --- | --- |
| 中性对照 | `none` | 4.37 (σ0.49) | −22.22 (σ2.06) | 353.3 (σ78.1) |
| 调皮 | `bright` | **5.17 (σ0.24)** | −23.97 (σ1.17) | 348.2 (σ45.3) |
| 傲娇 | `tsundere` | **4.16 (σ0.42)** | −23.53 (σ3.51) | 335.9 (σ55.6) |
| 撒娇 | `daily` | 4.37 (σ0.37) | −22.91 (σ1.49) | 335.3 (σ42.7) |

**客观量结论（不许写成「拉开了」）**：**只有时长一项分开**——调皮 5.17s vs 傲娇 4.16s，差 1.01s
（池化 σ 约 0.34s，约 3σ）；F0 档间极差只有 12.9Hz（把中性对照算进去才 17.9Hz，对照不算一种「表演」），而档内 σ 是 42–78Hz；RMS 档间 1.06dB vs σ 1.2–3.5dB。
三种表演**在基频和响度上没有拉开**。是否「听起来是三种表演」只能由 owner 听。

**顺带的一条方法学警告**：同一句 × 同一档的三条，说话人余弦组内 0.7093、组间 0.7035——**分不开**；
而中性对照（同句、无情绪）对参考音频也只有 0.7357（最小 0.6277），明显低于同句协议的 0.9059。
说明「换句 + 内联标签」本身就会让 CAM++ 掉 0.17 左右，**儿童声线 + 短句 + 韵律变化下这条指标已经不可靠**，
不能用它判「换句后还是不是同一个人」；锁定一致性那条（同句）才是可比口径。

**④ 落地**

- `MIMO_TIMBRE_PRESETS` 只剩一条 `07-tiancui-yuanqi`；`MIMO_DEFAULT_TIMBRE_ID` 与 `MIMO_BUNDLED_REFERENCE_ASSET`
  同步切到新 id / 新文件名；默认 TTS 档本来就是 `mimo-tts-voiceclone`，不用改。
- 旧档案迁移：`voiceDescription` 命中两个历史默认值（「俏皮元气略带傲娇尾音的少女蓝鲸声线」、
  旧 07 的「软糯黏糊但带笑意的女声…」）时迁到新默认；用户自己改过的描述保留。
- 语音中心：声线库标题、提示与「默认」胶囊同步为定稿态（不再写「待复核」）。

**合规**：MiMo 限时免费、页面无商用条款 → 参考音频与全部产物仍是 `DEV_ONLY_NON_COMMERCIAL`；
**商用前必须换有明确商用授权的 TTS 并重做参考音频**，`docs/THIRD_PARTY_NOTICES.md` 与 `assets/voice/README.md` 已写死。

**未实测 / 待人类真机验收**：三种表演的主观听感（是否真的「调皮 / 傲娇 / 撒娇」、是否像八九岁）；
桌面端真实播放（本轮的播放链路没有改，只换了参考资产，需要 owner 起客户端听一次）。

### 2.13 OpenRouter 音色备选池（Gemini 3.8 Flash TTS）

- 官方文档列 **30 个预置音色**：Zephyr、Puck、Charon、Kore、Fenrir、Leda、Orus、Aoede、Callirrhoe、Autonoe、Enceladus、Iapetus、Umbriel、Algieba、Despina、Erinome、Algenib、Rasalgethi、Laomedeia、Achernar、Alnilam、Schedar、Gacrux、Pulcherrima、Achird、Zubenelgenubi、Vindemiatrix、Sadachbia、Sadaltager、Sulafat（另有扩展音色库，需 `client.voices.list()`）。
  文档还写明情绪/风格走 `style` 字段与内联 `<sigh>` 类标签——**这是 Gemini 原生 API 的形态，不是 OpenRouter `/audio/speech` 的形态**，后者只收 `{model,input,voice,response_format}`，所以在本仓库里情绪控制仍按「未验证」处理。来源：<https://aistudio.google.com/docs/speech-generation>
- **本仓库适配器默认 `Zephyr`**（此前 3/3 实测就是它）。2026-11-27 用凭据库 Key 试调 `voice:'Kore'`：HTTP 200 / 3625ms / 80204 bytes；试调 `voice:'NotAVoice'`：HTTP 400（`Request contains an invalid argument`，不回显合法清单）。
- **结论口径**：30 个名字来自 Google 官方文档，OpenRouter 侧只逐个实调过 `Zephyr`（历史 3/3）与 `Kore`（1 次）；其余 28 个**未逐个验证**，当备选池用时先单条试调。OpenRouter 端点元数据 `supports_voice_cloning:false`、`supported_parameters:[]`。

---

### 2.18 表演重做：强度阶梯 A/B/C（2026-11-27，判据**先注册后跑**）

**背景**：owner 听完 §2.17 的三种表演，判定「音色对，表演要重做，三档都要重做，主要是情绪太弱」，要求更外放、更夸张。
音色、默认声线、随包资产、UI **一律不动**，只产出候选。

#### 2.18.1 预注册判据（写在本节、跑之前，跑完不改）

同一句「主人，你回来啦，(pauses for a moment) 今天有没有想我呀？」，三档（调皮 / 傲娇 / 撒娇）× 三级（A / B / C）× 每格 2 条 = 18 条。

| 记号 | 定义 |
| --- | --- |
| `Δℓ(x)` | 级别 ℓ 下，三档该指标**均值**的极差（max − min），`x ∈ {时长, RMS, F0}` |
| `σℓ(x)` | 级别 ℓ 下，三档**档内池化**标准差（每档 n=2，取三档方差的均值再开方） |

- **P1（基频分开）**：`Δℓ(F0) ≥ 2·σℓ(F0)`
- **P2（响度 + 语速同时分开）**：`Δℓ(时长) ≥ 2·σℓ(时长)` **且** `Δℓ(RMS) ≥ 2·σℓ(RMS)`
- **判定**：该级成立 = P1 **或** P2；三级里**至少一级成立** ⇒ 写「情绪在客观量上拉开了」；三级全不成立 ⇒ 写「客观量仍拉不开」。
- **并排对照**：与 §2.17 的上一版（单级、每档 3 条）比较 `Δ(时长) / Δ(RMS) / Δ(F0)`，说明阶梯有没有真的加强。
- **不做**：说话人余弦（儿童短句下 CAM++ 不可判表演差异，§2.17 已结论）；主观盲测（留给 owner）；**不许改判据或挑好结果重跑**。

**三级定义（每级只改「指令 + 标点/标签」，不改句子内容）**

| 级 | 意图 | user 侧风格指令 | 助手侧正文 |
| --- | --- | --- | --- |
| A | 提级对照：现有指令加「更外放」，正文与 §2.17 完全一致 | 契约层该档指令 + 「，更外放」 | `主人，你回来啦，(pauses for a moment) 今天有没有想我呀？` |
| B | 明显夸张：加大起伏、重音、拖长尾音、句尾情绪外露 | 该档重写的夸张指令（见 manifest） | 只用标点承载（！ ～ ——），**不带内联标签** |
| C | 副语言：在 B 之上加笑声/哼声/叹气/吸气/拖音标签 | 同 B，再加「可以笑出声、哼气、叹气、吸气」 | B 的标点 + 内联标签（每档两个，见 manifest） |

C 级用的标签里 `(sighs deeply)` 是已实测过的；`(giggles)` / `(laughs)` / `(hmph)` / `(inhales)` **未验证**——
若模型把英文词念出来，听感上立刻能听出，manifest 里逐条标注了「已验证 / 未验证」，owner 可直接否掉对应条。

#### 2.18.2 结果（18/18 成功；产物 `artifacts/tts-ab/perform2-07-tiancui/`，汇总 `summary.json`）

工具：`tools/scripts/voice-performance-ladder.mts`（产出）+ `tools/scripts/performance-ladder-summary.py`（读数与判据）。
路径规则 `artifacts/tts-ab/perform2-07-tiancui/<档>/<档>-<级>-<n>.wav`，`manifest.json` 逐条存了 `userText` / `assistantText` / `tagsUsed` / `verifiedTags` / `unverifiedTags`。

**A 级（提级对照：指令加「更外放」，正文与 §2.17 完全一致）**

| 档 | n | 时长 s | RMS dBFS | F0 中位 Hz |
| --- | --- | --- | --- | --- |
| 调皮 | 2 | 4.32 (σ0.16) | −22.93 (σ2.12) | 339.4 (σ8.4) |
| 傲娇 | 2 | 4.80 (σ0.16) | −23.14 (σ0.96) | 336.1 (σ11.8) |
| 撒娇 | 2 | 6.48 (σ1.36) | −23.49 (σ1.75) | 355.7 (σ31.4) |

Δ 时长 **2.16** vs 2σ 1.59 PASS · Δ RMS **0.56** vs 3.37 FAIL · Δ F0 **19.64** vs 39.90 FAIL → **P1 ✗ / P2 ✗ → 不成立**

**B 级（明显夸张：重写指令 + 只用标点承载强度，无内联标签；三档同文）**

| 档 | n | 时长 s | RMS dBFS | F0 中位 Hz |
| --- | --- | --- | --- | --- |
| 调皮 | 2 | 6.08 (σ0.32) | **−21.14** (σ0.15) | 348.1 (σ10.1) |
| 傲娇 | 2 | 5.36 (σ0.08) | −22.86 (σ0.16) | 347.8 (σ0.0) |
| 撒娇 | 2 | 6.72 (σ0.64) | **−25.59** (σ2.36) | 347.8 (σ0.0) |

Δ 时长 **1.36** vs 2σ 0.83 PASS · Δ RMS **4.45** vs 2.74 PASS · Δ F0 **0.29** vs 11.65 FAIL → **P1 ✗ / P2 ✓ → 成立**

**C 级（副语言：B 的标点 + 每档两个内联标签；标签清单见下表）**

| 档 | n | 时长 s | RMS dBFS | F0 中位 Hz | 用到的标签 |
| --- | --- | --- | --- | --- | --- |
| 调皮 | 2 | 8.96 (σ0.16) | −24.20 (σ1.38) | 312.6 (σ30.3) | `(giggles)`* `(laughs)`* |
| 傲娇 | 2 | 7.84 (σ0.80) | −26.94 (σ0.17) | 294.5 (σ1.8) | `(hmph)`* `(sighs deeply)` |
| 撒娇 | 2 | 9.04 (σ1.36) | −25.46 (σ5.59) | 345.5 (σ41.7) | `(sighs deeply)` `(inhales)`* |

\* = 此前没验证过的标签（`(sighs deeply)` 是已验证的三个之一）。

Δ 时长 **1.20** vs 2σ 1.83 FAIL · Δ RMS **2.73** vs 6.65 FAIL · Δ F0 **50.96** vs 59.48 FAIL → **P1 ✗ / P2 ✗ → 不成立**

**判据结论**：三级里**B 级成立**（P2：时长与响度同时分开），按 §2.18.1 写死的规则 ⇒ **「情绪在客观量上拉开了」**。
必须同时写清两点限制：① 成立的是**时长 + 响度**这一路，**基频三档始终没分开**（B 级甚至三档同为 347.8–348.1Hz）；
② 每格只有 2 条，σ 本身不稳（A 的撒娇 F0 σ 31.4、C 的撒娇 σ 41.7 都很大），B 级能过 P2 有一部分是「这一格特别稳」的功劳。

**与上一版（§2.17，单级、每档 3 条）并排**

| 指标 | 上一版 Δ | A 级 Δ | B 级 Δ | C 级 Δ |
| --- | --- | --- | --- | --- |
| 时长 s | 1.01 | 2.16 | 1.36 | 1.20 |
| RMS dBFS | 1.06 | 0.56 | **4.45** | 2.73 |
| F0 中位 Hz | 12.8 | 19.6 | 0.3 | **51.0** |

**哪种手法贡献最大**：

- **夸张指令 + 标点（B）主要拉「响度 + 语速」**：RMS 档间差从上一版 1.06dB 涨到 **4.45dB（4.2×）**，时长差 1.01 → 1.36s。
- **内联标签（C）主要拉「时长 + 基频」**：三档时长比 B 再涨 **2.3–2.9s**（8.96/7.84/9.04 vs 6.08/5.36/6.72），F0 中位降 35–53Hz，档间差 51.0Hz（上一版的 4 倍）；但**档内方差同步暴涨**，判据反而不过。
- **三档的差别不在音高**：B 级三档 F0 几乎完全重合（348.1 / 347.8 / 347.8），能分开的只有「多响、多快、带不带副语言」。

**C 级标签是否真的生效（间接判断，不是听感结论）**：三档 C 都比同档 B 长约 **2.3–2.9s**，
且远超「把英文词念出来」的量级（两个词约 1s 上下）——更像是笑声/叹气/吸气真的被渲染了。
**但这只是间接推断**，owner 一听便知；`manifest.json` 的 `unverifiedTags` 字段已逐条标出哪些标签没验证过，
若某条把英文念了出来，直接否掉该条即可。

**每档推荐（按客观读数 + 意图，最终由 owner 听）**

| 档 | 首选 | 备选 | 理由 |
| --- | --- | --- | --- |
| 调皮 | `tiaopi-B-1`（6.08s / −21.1dB / 348Hz） | `tiaopi-C-1`（8.96s，带笑） | B 最响最利落；C 最长最外放，适合要「夸张」的场合 |
| 傲娇 | `aojiao-B-2`（5.36s / −22.9dB / 347.8Hz σ0） | `aojiao-C-1`（7.84s / F0 294.5Hz） | B 三档里最稳；C 的 `(hmph)` 把基频明显压低，最像「哼」 |
| 撒娇 | `chajiao-B-1`（6.72s / −25.6dB） | `chajiao-C-2`（9.04s，叹气+吸气） | B 甜而黏；C 最长最黏，但方差大，需要单独听 |

**未做**：主观听感（owner）、把任何一级接进产品（等 owner 选定后一次性做映射；`VOICE-PERSONA` / UI / 随包资产本轮都没动）、说话人余弦（按 §2.17 的结论，儿童短句下不用于判断表演差异）。

### 2.19 音色工坊（M1+M2）+ 表演 B 级接线（2026-11-27）

owner 拍板原话：「m2+m1吧，正在进行的音色不用你生成让我确认了，后面我自己在这个工具里面试，有问题再找你处理」。
本节记录**接线口径**与**工坊自己跑出来的数**；听感仍归 owner。

#### 2.19.1 B 级接线（客观量成立 → 进产品）

- `MIMO_EMOTION_STYLE_HINTS` 里 `daily` / `bright` / `tsundere` 三档改为 §2.18 的 B 级指令原文
  （撒娇 / 调皮 / 傲娇），`resolveMimoEmotionHint(emotion, intensity)` 默认返回 B。
- A / C 两档只作为**工坊里的试戴强度**暴露（`MIMO_PERFORMANCE_A_SUFFIX` / `MIMO_PERFORMANCE_C_SUFFIX`），
  不写进任何产品档位。`sleepy` / `surprised` 没有阶梯实验数据，**不编造模板**，保持原指令。
- **C 级的内联标签仍未经听感验证**：`(giggles)` / `(laughs)` / `(hmph)` / `(inhales)` 只是从「C 比 B 长 2.3–2.9s」
  间接推断大概率被渲染；文档里只标注为「备查 + 工坊实验」，不宣称已验证。
- **已写死的否定结论**：**音高区分情绪这条路在 MiMo 指令层上不成立**——B 级三档 F0 中位 348.1 / 347.8 / 347.8Hz，
  能拉开情绪的是响度（Δ 4.45dB）、语速（Δ 1.36s）与副语言，不是基频。
- **诚实口径**：owner **未逐条试听**这 18 条，B 级是按预注册判据接的线，将在工坊里自调。

#### 2.19.2 工坊四步（落点；实现 `apps/desktop-host/src/main/voice-workshop.ts` + `renderer/director/voice-workshop-panel.tsx`）

| 步 | UI 入口 | 做了什么 | 花几次合成 |
| --- | --- | --- | --- |
| ① 声线卡 / 版本时间线 | 语音中心 →「音色工坊」页签顶部 | 定格状态（出厂·已定格 / AI 设计）、来源、参考音频完整路径、最近体检结论、版本时间线（可回退）；出厂版本永远在第一位 | 0 |
| ② 一致性体检 | 声线卡里的「一致性体检」按钮 | 同一句 **×10 真实克隆** → `tools/scripts/speaker-cosine.py`（CAM++ 16k）→ 人话结论 + 均值/最小/σ；工具缺失返回 `unavailable` 并写原因，**不给假数字** | 10 |
| ③ 生成候选 | 「生成候选（描述 + 拨盘）」卡片 | 文字描述 + 四拨盘（年龄段 / 质感 / 语速 / 尾音）拼成 VoiceDesign 描述，一次 4–8 条；UI 明示**未定格的候选不能当固定声线** | N（4–8） |
| ④ 多句试戴 + 定格 | 每条候选两个按钮 | 试戴 = 4 句（中性 / 调皮 / 傲娇 / 撒娇）走 VoiceClone，强度可选 A/B/C（默认 B）；定格 = 存成 `versions/<id>.wav` + 复制为 `voice-clone-sample.wav` + 切默认档，并自动跑一次体检 | 4 + 10 |

持久化：`<userData>/voice-workshop/state.json`（`currentVersionId` + `versions`，出厂版本不可删）、
`candidates/index.json`、`versions/<id>.wav`、`consistency/<uuid>/sample-*.wav`。
**只写本地 userData，不进 git；回退到出厂 = 删掉本地克隆参考，主进程回落随包基准。**

#### 2.19.3 出厂 07 的一致性体检：三次真实读数（同句 ×10，同一随包参考）

| # | 路径 | 均值 | 最小 | σ | 判据结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | §2.17 bench 直跑（`artifacts/tts-ab/lock-07-tiancui/`） | 0.9059 | 0.8814 | 0.0148 | 锁得稳 |
| 2 | 工坊 `checkConsistency()` 第一次（真实 API） | 0.8632 | **0.7296** | 0.0451 | 偶尔飘 |
| 3 | 工坊 `checkConsistency()` 第二次（真实 API） | 0.8795 | 0.7876 | 0.0402 | 偶尔飘 |

- 第 1 行不是「更准」，只是**另一次的抽样**：把它自己的 10 条重算仍是 0.9059 / 0.8814，工具本身可复现；
  但拿同一参考重新生成 10 条，最小余弦就掉到 0.73–0.79。**批次间波动 > 判据余量**。
- 因此结论写成：**出厂 07 处在「锁得稳 / 偶尔飘」的边界上，单次 10 条不足以定论**。
  判据（mean ≥ 0.85 且 min ≥ 0.80 → 稳）**保持原样不改**——不因为一次跑数难看就调阈值；
  UI 在按钮旁如实写明「单次有抽样波动，拿不准就再跑一次」。
- 体检句与 §2.17 的锁定句**是同一句**（`主人，今天也辛苦啦，我给你倒杯热茶好不好呀。`），
  且都是中性（无情绪指令、无标签），口径可比。

#### 2.19.4 边界与未做

- **M3 不做**：无上传录音通道、无音色包导入导出、无一键换引擎重做；UI 不留半成品入口，但版本元数据格式（描述 / 定格指令 / 强度 / provider / 模式 / 参考路径 / 体检结论）已存全，后续可迁移。
- **情绪映射继续只走「指令 + 标签」**：按情绪参考音频已在 §2.16.2 判死（等于换人），工坊不放这个入口。
- **MiMo 限免**：工坊如实显示本次会话合成次数；配额耗尽由 provider 直接报错，**不静默降级**。
- **`pet:sleep-status` 竞态未修**（owner 未表态，只读记录）：`createDirectorWindow()` 早于 `ipcMain.handle('pet:sleep-status')` 注册，
  director 首启时 `App.tsx` 的 mount effect 先 invoke，被 `.catch(() => undefined)` 吞掉 → 日志噪声 + 首启睡眠状态可能读到旧值。
- 未做：E2E 里点「生成 / 体检」（会真花合成次数，只验收 UI 与状态 IPC）；B/C 级听感；打包态体检（没有 `tools/` 时按 `unavailable` 处理）。


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
| MiMo VoiceClone（随包 07 基准） | — | =整句（非流式） | 10/10 | **已实测：均值 0.8373 / 最小 0.7723**（§2.14） | 限时免费 | 设计与克隆同余弦量级 |
| MiMo VoiceClone（02 / 08 / 12 候选） | — | =整句（非流式） | 10/10 各 | **已实测：02 0.8275/0.7189 · 08 0.8705/0.7552 · 12 0.8912/0.8340**（§2.15） | 限时免费 | 默认档未动，等 owner 听选 |

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
