# 小米 MiMo TTS 候选接入：VoiceClone / VoiceDesign（`[TYPE-ONLY]` + `[SIMULATION]`）

> 日期：2026-11-27 · owner 决策「接入作为候选 provider，不要设成默认」
> 证据等级：**契约与链路 `[SIMULATION]`（假服务端真 HTTP）/ 真实 API 语音 **未实连**（缺 Key，`[TYPE-ONLY]` 之外不下任何结论）**
> 关联：[TTS-local-engine-benchmark-verification.md](./TTS-local-engine-benchmark-verification.md) §10（商业两家接入与对拍阻塞项）

---

## 0. 结论

- **适配器与路由已落地**：`MimoTtsProvider` 支持 VoiceClone 与 VoiceDesign 两种模式，各自注册一个实例，kind 分别为 `mimo-tts-voiceclone` / `mimo-tts-voicedesign`。
- **候选身份是硬约束**：它**不进自动兜底链**（`COMMERCIAL_TTS_PROVIDERS` 仍只有 MiniMax / OpenAI），默认档仍是 `minimax-tts`；只有用户显式选了它才会走。
- **真实 API 一次都没调过**——本机凭据库与环境变量都没有 MiMo Key。因此**首包、整句耗时、成功率、音色漂移、情绪稳定性，全部未实测**。
- 已实测的只有：单测（8 例新增）、假服务端真 HTTP 跑通 bench 全链路（4 家适配器）、说话人嵌入余弦工具在真实音频上验证可用。

---

## 1. 接入形态

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.xiaomimimo.com/v1`（OpenAI 兼容协议，但**不是** `/audio/speech`） |
| 端点 | `${base}/chat/completions` |
| 模型 | `mimo-v2.5-tts-voiceclone` / `mimo-v2.5-tts-voicedesign` |
| 凭据 providerId | `mimo-tts`（凭据库）；环境变量 `WHALE_MIMO_API_KEY`（仅供 bench / 本地调试） |
| VoiceDesign 音色描述 | 环境变量 `WHALE_MIMO_VOICE_DESCRIPTION` |
| VoiceClone 参考音频 | 环境变量 `WHALE_MIMO_VOICE_SAMPLE`（wav 路径，主进程读文件转 data URL） |
| 响应取值 | `choices[0].message.audio.data`（base64 wav） |

**为什么不能直接复用 `CloudOpenAiTtsProvider`**：请求体结构完全不同（下表）。套用现有实现会发出一个官方不认的 body。

| | VoiceClone | VoiceDesign |
| --- | --- | --- |
| `messages[0]`（user） | **空串** | 自然语言音色描述（年龄/性别/口音/音色/语速/性格） |
| `messages[1]`（assistant） | 要说的正文 | 要说的正文 |
| `audio` | `{ format:'wav', voice:'data:audio/wav;base64,…' }` | `{ format:'wav' }` |
| 需要参考音频 | ✅ | ❌ |

**情绪处理**：官方称支持自然语言风格指令与内联音频标签，但我们没有实测证据。所以：

- VoiceDesign 允许通过 `emotionStyleHints` 把产品五情绪追加进**音色描述**（`…；风格：开心雀跃，语气上扬`），未知情绪**不注入**；
- VoiceClone 的 user 必须是空串，**无法注入情绪**，这里不造假；
- `probe()` 一律报 `supportsEmotion: false`，detail 写明「情绪表达未实测，不宣称支持」——这是 item 10 那条教训的直接延续：能力没实测就不许写 true。

---

## 2. 已实测（可复现）

### 2.1 单测（8 例新增，`packages/voice-runtime/src/voice-runtime.spec.ts`）

| 断言 | 覆盖点 |
| --- | --- |
| 候选不在稳定两家、也不进兜底链 | `COMMERCIAL_TTS_PROVIDERS` 仍为两家；`CANDIDATE_TTS_PROVIDERS` 为 MiMo 两个 |
| 选了候选但它不可用 | 回落到稳定两家并 `honored:false`，不悄悄留在候选上 |
| VoiceDesign 请求体 | user=描述（含已知情绪的风格提示）、assistant=正文、`audio.format=wav`；未知情绪不注入 |
| VoiceDesign 缺描述 | 探针不可用 + 合成抛 `CONFIG_INVALID`，不发空请求 |
| VoiceClone 请求体 | user 为空串、assistant=正文、`audio.voice` 是 `data:audio/wav;base64,…` |
| VoiceClone 缺参考音频 / 缺 Key | 分别报 `CONFIG_INVALID` / `SECRET_UNAVAILABLE` |
| 探针不宣称情绪 | `supportsEmotion === false`，detail 含「限时免费」「未实测」 |
| 失败路径 | HTTP 500 / `error.message` / 空音频全部抛错，绝不返回假音频 |
| 路由 | 未指定 preferred 时按注册顺序走稳定家；指定候选才走候选 |

结果：`packages/voice-runtime/src/voice-runtime.spec.ts` **30 例全绿**。

### 2.2 bench 链路（假服务端，真 HTTP）

`tools/scripts/bench-tts-ab.mts` 自带 `--fake`：起一个本地 HTTP 服务，按各家的端点返回固定正弦 wav。
用它把 **MiniMax / OpenAI / MiMo VoiceDesign / MiMo VoiceClone 四个适配器**全部跑通，产物落 `artifacts/tts-ab/<provider>/`：

```
[minimax]           完成：2/2 成功 → artifacts/tts-ab/minimax
[openai]            完成：2/2 成功 → artifacts/tts-ab/openai
[mimo-voicedesign]  完成：2/2 成功 → artifacts/tts-ab/mimo-voicedesign
[mimo-voiceclone]   完成：2/2 成功 → artifacts/tts-ab/mimo-voiceclone
```

产物 `manifest.json` 每条都带 `"simulated": true`，**只证明链路通，不能当实测数据引用**。
顺带修正一个诚实性问题：产物扩展名按真实格式走（MiniMax 返回 mp3 就写 `.mp3`），不把 mp3 改名成 `.wav`。

### 2.3 音色一致性工具（在真实音频上验证过方法本身）

`tools/scripts/speaker-cosine.py`：3D-Speaker CAM++（中文 16k）说话人嵌入 + 两两余弦。用 ZipVoice 那 15 条**同一参考音色**的真实产物验证方法可用：

```
样本 15 条，两两组合 105 对
余弦 均值 0.8563 · 中位 0.8589 · 最小 0.7545 · 最大 0.9104 · 标准差 0.0270
```

即「同一说话人」的分布大致在 0.75–0.91。**这只是方法验证**：MiMo 的 VoiceDesign 漂移量仍然未测（无 Key）。
判读口径已写进脚本头注释：嵌入只反映音色相似度，不反映情感与听感；绝对阈值只是参考，要跟跨描述/跨供应商的分布对比才有意义。

---

## 3. 未实测（逐项写清，不许拿估算值填）

| 项 | 状态 | 缺什么 |
| --- | --- | --- |
| 真实 API 连通性与成功率 | **未实测** | `mimo-tts` 这个 providerId 的 API Key（凭据库或 `WHALE_MIMO_API_KEY`） |
| 首包 / 整句耗时 / RTF | **未实测** | 同上。另注意：当前适配器是**非流式**调用，首包 == 整句；真实首包要另写流式路径 |
| VoiceDesign 音色漂移（同一描述连续 10 次） | **未实测** | Key + `WHALE_MIMO_VOICE_DESCRIPTION`；跑 `--consistency 10` 后用 `speaker-cosine.py` 算 |
| VoiceClone 克隆一致性 | **未实测** | Key + 一段**合法可用**的参考音频（现有 `design_sweet_normal.wav` 已证实是合成 stub，不能拿来当真人参考） |
| 情绪表达能否稳定落到产品五情绪 | **未实测** | Key。VoiceDesign 走「音色描述追加风格」，VoiceClone 目前**没有**注入通道 |
| 与 MiniMax / OpenAI 的同表对拍 | **未实测** | 三家 Key 都不在当前可连实例里（见 §4 表） |

---

## 4. 与稳定两家的对拍表（客观项，空白格就是没测）

| 供应商 | 一句话整句耗时 | 首包 | 成功率 | 音色一致性（同描述 10 次余弦） | 备注 |
| --- | --- | --- | --- | --- | --- |
| MiniMax T2A v2 | **未实测** | 未实测 | 未实测 | 不适用（指定 voice_id） | 库里有 `minimax` 条目，但当前实例是 mock-keychain 读不到 |
| OpenAI 兼容 TTS | **未实测** | 未实测 | 未实测 | 不适用（指定 voice） | 缺 `openai-tts` 凭据 |
| MiMo VoiceDesign | **未实测** | 未实测 | 未实测 | 未实测 | 本文件新增，缺 `mimo-tts` 凭据 |
| MiMo VoiceClone | **未实测** | 未实测 | 未实测 | 未实测 | 同上；另需合法参考音频 |

听感结论不下，留给 owner 自己听。

---

## 5. 「限时免费」风险（单列，必读）

事实（2026-11-27 官方模型页）：

- 标价 **「限时免费」**（TTS 系列），**页面没有任何商用条款**；只有用户协议与隐私政策链接。
- 同站顶部横幅：**MiMo-V2.5-Pro / V2.5 文本系列已于 2026-10-21 下线**，引导迁移到 V2.6。TTS 是否同命运，页面**未明说**。
- 限流：100 RPM / 10M TPM / 8K 上下文。

因此设了三条硬约束：

1. **不得作为默认档**：`PetDesktopPrefsSchema.voiceCommercialProvider` 默认仍是 `minimax-tts`，MiMo 只能被显式选中。
2. **不得进自动兜底链**：`COMMERCIAL_TTS_PROVIDERS` 里没有它，`resolveCommercialTtsProvider()` 永远不会把它当回落目标。
3. **UI 必须带风险提示**：候选按钮挂「限免」角标，选中后显示 `MIMO_TTS_CANDIDATE_NOTICE`（契约层常量，UI 与文档共用同一份原文）。

### 如果它明天收费 / 下线，怎么切回

| 情形 | 动作 | 是否需要改代码 |
| --- | --- | --- |
| 开始收费 | 用户把默认档选回 MiniMax / OpenAI（一次点击，prefs 落盘） | ❌ 不需要 |
| 直接下线 / 401 | 探针 `available:false`，`resolveCommercialTtsProvider` 回落到稳定两家并 `honored:false` 说明原因 | ❌ 不需要 |
| 模型 ID 改名 | 改 `MIMO_TTS_MODELS` 两个常量 | ✅ 一行 |
| 凭据要撤 | 删凭据库 `mimo-tts` 条目 / 去掉 `WHALE_MIMO_API_KEY` | ❌ 不需要 |

也就是说：**它的存在不会把产品绑死**。这是允许接候选的前提，也是它跟稳定两家在架构上的唯一区别。

---

## 6. 复跑方式

```bash
# 1) 不花钱验证链路（假服务端，产物标 simulated）
npx tsx tools/scripts/bench-tts-ab.mts --fake --provider all --limit 2

# 2) 真跑（Key 只从环境读，不进仓库；没有就跳过并打印缺哪个变量）
WHALE_MIMO_API_KEY=… WHALE_MIMO_VOICE_DESCRIPTION='年轻女性，普通话，音色偏甜，语速中等，性格活泼' \
  npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign

# 3) 音色漂移：同一描述连跑 10 次，再算嵌入余弦
WHALE_MIMO_API_KEY=… WHALE_MIMO_VOICE_DESCRIPTION='…' \
  npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign --consistency 10
uv run --with sherpa-onnx --with numpy python -I tools/scripts/speaker-cosine.py \
  artifacts/tts-ab/mimo-voicedesign/consistency-*.wav
```

---

## 7. 证据等级声明

- `[SIMULATION]`：单测 + 假服务端 bench 链路 + 路由/兜底行为。
- `[REAL-DEVICE]`（仅工具方法）：说话人嵌入余弦在 ZipVoice 真实产物上的分布。
- **未实连**：MiMo 真实 API 的任何一项（延迟、成功率、音色漂移、情绪）。缺 Key 是唯一原因，不是没测。
