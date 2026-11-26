# 随包声线资产（voice assets）

## `xiaojing-07-nianhu-piqi.wav`

| 项 | 说明 |
| --- | --- |
| 用途 | 声线库默认声线 **07 黏糊·调皮** 的**克隆参考音频**。角色默认档是 `mimo-tts-voiceclone`，主进程每次合成都把这条参考音频作为 clone 源（见 `apps/desktop-host/src/main/v2-kernel-host.ts` 的 `resolveMimoReference`） |
| 生成方式 | 自产文本 + **小米 MiMo `mimo-v2.5-tts-voicedesign`** 现场合成（音色描述见 `packages/shared-protocol/src/voice.ts` 的 `MIMO_TIMBRE_PRESETS`） |
| 台词 | 「主人，今天也辛苦啦，我给你倒杯热茶好不好呀。」（自产，角色语气，不夸张） |
| 规格 | 24 kHz / 16-bit / 单声道 / 5.6s / 263 KB |
| 来源 | 全自产：描述、台词、模型调用都在本仓库内完成；**未使用任何第三方录音、画作或他人声线** |
| 许可 | **DEV_ONLY_NON_COMMERCIAL**：上游 MiMo TTS 官方标价「限时免费」且页面无任何商用条款，因此这条音频只能用于开发与内部验证；商用前必须换用有明确商用授权的 TTS（并重做这条参考音频） |
| 复现 | `WHALE_MIMO_VOICE_DESCRIPTION="软糯黏糊但带笑意的女声，撒娇里藏着坏主意，尾音轻轻上翘；自然地说，不要播音腔" npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign --consistency 1 --emotion none --from-vault --out artifacts/tts-ab/mimo-reference` |

## 候选参考资产（02 / 08 / 12）

| 文件 | 对应声线 | 状态 |
| --- | --- | --- |
| `xiaojing-02-yujie-leng.wav` | 02 御姐冷·年轻 | 候选，**默认档未引用** |
| `xiaojing-08-nianhu-banshui.wav` | 08 黏糊·半睡 | 候选，**默认档未引用** |
| `xiaojing-12-hanhan-difa.wav` | 12 憨憨·偏低发呆 | 候选，**默认档未引用** |

三条与 07 同法生成（同句、中性自然语气），2026-11-27 用来做「设计版 vs 克隆版」对照与三候选锁定回归，
数据见 `docs/v2/evidence/mimo-tts-candidate-integration.md` §2.15。许可同上（自产文本 + MiMo 生成，`DEV_ONLY_NON_COMMERCIAL`）。
owner 听定之前，默认档仍指向 07 那条。

## 换声线时怎么做

1. 语音中心「声线来源 → 声线库」里挑一条（02 / 07 / 08 / 12）；
2. 点「试听」先听描述长什么样（走 VoiceDesign 预览，**会漂移**，只作参考）；
3. 点「锁定为声线」：用这条描述现场合成一条参考音频落成克隆参考，主进程默认档切到 `mimo-tts-voiceclone`，此后每次合成都锁在这条参考上；
4. 「锁定」是**一次性**动作（每次一次 API 调用），不是每次说话都重生成。

## 边界

- VoiceDesign 的同一段描述连跑 10 次，说话人余弦最小 0.4145（漂移是实的），
  所以**描述不能直接当声线**，必须走「描述 → 参考音频 → VoiceClone」这一跳；
  数据见 `docs/v2/evidence/mimo-tts-candidate-integration.md`。
- 用户自己在 UI 上传的参考音频优先于这条随包基准（存 `userData/voice-clone-sample.wav`，
  RIFF/WAVE 校验 + 20MB 上限），上传的音频同样必须是自产或已获授权的录音。
