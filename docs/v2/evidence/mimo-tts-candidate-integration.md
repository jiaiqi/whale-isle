# 小米 MiMo TTS 候选接入（tts / VoiceClone / VoiceDesign）+ OpenRouter Gemini TTS 第四家候选（`[TYPE-ONLY]` + `[SIMULATION]`）

> 日期：2026-11-27 · owner 决策「MiMo 接入作为候选 provider，不要设成默认」「OpenRouter Gemini 3.8 Flash TTS 接为第四家商用候选」
> 证据等级：**契约与链路 `[SIMULATION]`（假服务端真 HTTP）/ 真实 API 语音一律未实连（缺 Key）**
> 关联：[TTS-local-engine-benchmark-verification.md](./TTS-local-engine-benchmark-verification.md) §10、[VOICE-PERSONA-xiaojing.md](../VOICE-PERSONA-xiaojing.md)

---

## 0. 结论

- **适配器与路由已落地**：`MimoTtsProvider` 三个模型各注册一个实例——`mimo-v2.5-tts`（kind `mimo-tts`，内置 9 音色 + 唱歌前缀）、`mimo-v2.5-tts-voiceclone`、`mimo-v2.5-tts-voicedesign`；另有 `OpenRouterTtsProvider`（kind `openrouter-tts`，`google/gemini-3.8-flash-tts`）作为第四家候选。
- **候选身份是硬约束**：四家候选都**不进自动兜底链**（`COMMERCIAL_TTS_PROVIDERS` 仍只有 MiniMax / OpenAI），默认档仍是 `minimax-tts`；只有用户显式选中才会走。
- **真实 API 一次都没调过**——本机凭据库与环境变量都没有 MiMo / OpenRouter Key。因此首包、整句耗时、成功率、音色漂移、情绪稳定性、计费实扣，**全部未实测**。
- 已实测的只有：单测（voice-runtime 178 例全绿，其中 MiMo/OpenRouter 部分 25 例）、假服务端真 HTTP 跑通 bench 全链路（6 个 provider key）、说话人嵌入余弦工具在真实音频上验证可用。
- **纠正一处旧谎报**：上一版 `probe()` 写 `supportsStreaming: true`，但适配器是非流式的。已改为 `false`，detail 里明写「非流式」。

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

### 1.3 认证头（未实测，做成可配置）

官方 curl 示例用 `--header "api-key: $MIMO_API_KEY"`，而 OpenAI 兼容习惯是 `authorization: Bearer`。两种都未实测，所以：

- `MimoTtsOptions.authScheme` 支持 `'bearer'`（默认，沿用旧实现）与 `'api-key'`；
- `probe().detail` 会写出当前用的是哪种，并标「未实测」；
- 实测时**两种都试**，把通的那种回填到本文 §2.4，并把默认值改掉（一行）。

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

### 2.4 认证头实测记录（待填）

| 方案 | 结果 | 日期 | 备注 |
| --- | --- | --- | --- |
| `authorization: Bearer` | **未实测** | — | 默认值 |
| `api-key` | **未实测** | — | 官方 curl 写法 |

---

## 3. 未实测（逐项写清，不许拿估算值填）

| 项 | 状态 | 缺什么 |
| --- | --- | --- |
| MiMo / OpenRouter 真实 API 连通性与成功率 | **未实测** | 凭据库 `mimo-tts` / `openrouter` 条目（语音中心凭据卡片可填） |
| 首包 / 整句耗时 / RTF | **未实测** | 同上。MiMo 与 OpenRouter 当前都是**非流式**，首包 == 整句 |
| VoiceDesign 音色漂移（同描述 10 次） | **未实测** | Key + `WHALE_MIMO_VOICE_DESCRIPTION`，跑 `--consistency 10` 后算余弦 |
| VoiceClone 克隆一致性 | **未实测** | Key + 一段自制或已授权的参考音频 |
| 五情绪指令 / 前缀标签 / 内联标签是否稳定 | **未实测** | Key |
| 唱歌前缀听感 | **未实测** | Key |
| OpenRouter 情绪控制方式 | **未实测（官方无说法）** | Key；只能单开实验组，不进能力声明 |
| OpenRouter 一句实际花费 | **未实测** | Key；按 token 计费，必须实测不估算 |
| 与 MiniMax / OpenAI 的同表对拍 | **未实测** | 各家 Key 都不在当前可连实例里 |

---

## 4. 与稳定两家的对拍表（客观项，空白格就是没测）

| 供应商 | 一句话整句耗时 | 首包 | 成功率 | 音色一致性 | 一句花费 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| MiniMax T2A v2 | **未实测** | 未实测 | 未实测 | 不适用（指定 voice_id） | 未实测 | 库里有 `minimax`，当前实例读不到 |
| OpenAI 兼容 TTS | **未实测** | 未实测 | 未实测 | 不适用（指定 voice） | 未实测 | 缺 `openai-tts` 凭据 |
| OpenRouter Gemini TTS | **未实测** | 未实测 | 未实测 | 不适用（预置音色） | 未实测（按 token） | 第四家候选 |
| MiMo 内置音色 | **未实测** | 未实测 | 未实测 | 未实测 | 限时免费 | 9 内置音色 |
| MiMo VoiceDesign | **未实测** | 未实测 | 未实测 | 未实测 | 限时免费 | 需音色描述 |
| MiMo VoiceClone | **未实测** | 未实测 | 未实测 | 未实测 | 限时免费 | 需合法参考音频 |

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
- `[REAL-DEVICE]`（仅工具方法）：说话人嵌入余弦在 ZipVoice 真实产物上的分布。
- **未实连**：MiMo / OpenRouter 真实 API 的任何一项（延迟、成功率、音色漂移、情绪、花费）。缺 Key 是唯一原因，不是没测。
