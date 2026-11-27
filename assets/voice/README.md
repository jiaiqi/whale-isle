# 随包声线资产（voice assets）

## `xiaojing-07-tiancui-yuanqi.wav`（定稿声线）

| 项 | 说明 |
| --- | --- |
| 用途 | 声线库**唯一**声线 **07 甜脆·元气** 的**克隆参考音频**。角色默认档是 `mimo-tts-voiceclone`，主进程每次合成都把这条参考音频作为 clone 源（见 `apps/desktop-host/src/main/v2-kernel-host.ts` 的 `resolveMimoReference`） |
| 生成方式 | 自产文本 + **小米 MiMo `mimo-v2.5-tts-voicedesign`** 现场合成（音色描述见 `packages/shared-protocol/src/voice.ts` 的 `MIMO_TIMBRE_PRESETS`） |
| 音色描述 | 「八九岁小女孩，声音甜而脆，元气满满，语速快，句尾翘起来，像随时要跳起来」（owner 2026-11-27 定稿） |
| 台词 | 「主人，今天也辛苦啦，我给你倒杯热茶好不好呀。」（自产，自然语气，不夸张） |
| 规格 | 24 kHz / 16-bit / 单声道 / 5.12 s / 240 KB / F0 中位 406.78 Hz |
| 来源 | 全自产：描述、台词、模型调用都在本仓库内完成；**未使用任何第三方录音、画作或他人声线** |
| 许可 | **DEV_ONLY_NON_COMMERCIAL**：上游 MiMo TTS 官方标价「限时免费」且页面无任何商用条款，因此这条音频只能用于开发与内部验证；**商用前必须换用有明确商用授权的 TTS，并重做这条参考音频** |
| 复现 | `WHALE_MIMO_VOICE_DESCRIPTION="八九岁小女孩，声音甜而脆，元气满满，语速快，句尾翘起来，像随时要跳起来" npx tsx tools/scripts/bench-tts-ab.mts --provider mimo-voicedesign --consistency 1 --emotion none --from-vault --out artifacts/tts-ab/voice-07-tiancui` |

锁定回归（同一句 ×10，两两 45 对）：余弦均值 **0.9059** / 最小 **0.8814** / σ 0.0148；
克隆输出 vs 本条参考：均值 0.9086 / 最小 0.8824。数据见
`docs/v2/evidence/mimo-tts-candidate-integration.md` §2.17。

## 已撤出随包的旧资产（2026-11-27）

owner 定稿「八九岁小女孩」音色方向后，以下四条参考音频**不再随包分发**，归档在本机
`artifacts/voice-archive-2026-11-27/`（`artifacts/` 不入库，删掉就只能按各自描述重新生成）：

| 文件 | 对应声线 |
| --- | --- |
| `xiaojing-07-nianhu-piqi.wav` | 07 黏糊·调皮（成人向旧默认，owner 判「不对味」） |
| `xiaojing-02-yujie-leng.wav` | 02 御姐冷·年轻 |
| `xiaojing-08-nianhu-banshui.wav` | 08 黏糊·半睡 |
| `xiaojing-12-hanhan-difa.wav` | 12 憨憨·偏低发呆 |

这四条只作为「方法证据」保留（§2.15 / §2.16 的实验产物），许可同上 `DEV_ONLY_NON_COMMERCIAL`。

## 换声线时怎么做

1. 语音中心「声线来源 → 声线库」里看当前声线（定稿后只有「07 甜脆·元气」一条）；
2. 点「试听」先听描述长什么样（走 VoiceDesign 预览，**会漂移**，只作参考）；
3. 点「锁定为声线」：用这条描述现场合成一条参考音频落成克隆参考，主进程默认档切到 `mimo-tts-voiceclone`，此后每次合成都锁在这条参考上；
4. 「锁定」是**一次性**动作（每次一次 API 调用），不是每次说话都重生成。

## 边界

- VoiceDesign 的同一段描述连跑 10 次，说话人余弦最小 0.4145（漂移是实的），
  所以**描述不能直接当声线**，必须走「描述 → 参考音频 → VoiceClone」这一跳；
  数据见 `docs/v2/evidence/mimo-tts-candidate-integration.md`。
- 五种情绪的「按档参考音频 + 按档克隆」已实测**不做产品**：直接切情绪参考等于换人（参考集自相似 0.5158），
  保人的两段式又把情绪效果压回对照水平（§2.16.2）。产品继续用风格指令 + 标签。
- 用户自己在 UI 上传的参考音频优先于这条随包基准（存 `userData/voice-clone-sample.wav`，
  RIFF/WAVE 校验 + 20MB 上限），上传的音频同样必须是自产或已获授权的录音。
