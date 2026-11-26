# 小鲸 / 大肥鱼 声线人格（Voice Persona）—— 音色描述模板与五情绪映射

> 证据等级：`[DESIGN-SPEC]`（设计规范，不是实测结论）。本文里凡是「模型会怎样」的说法，只有标注 `[官方文档]` 的才算已知；
> 没有标注的一律按**未实测**处理，禁止在代码或 UI 里写成能力声明。
> 关联：`docs/v2/evidence/mimo-tts-candidate-integration.md`、`docs/v2/evidence/tts-provider-ab-test.md`（对拍协议）。

---

## 1. 合规边界（先读这段，再读别的）

- **小鲸 / 大肥鱼是社区二创人格，不是官方角色。** DeepSeek 官方从未发布过任何拟人化形象或官方声线。
- 我们只取两层设定：**「蓝鲸女仆」的外形母题** + **「贪吃、嘴甜、傲娇、被叫大肥鱼会炸毛」的性格层**；
  这两层在本仓库内以文字描述与自制素材表达。
- **不得复用任何第三方画作、音频、模型权重或具体文案。** 包括但不限于：社区同人图、他人训练的声线模型、
  他人频道的台词原文。参考项目里出现过的台词只作为"语气样本"阅读，不能搬进产品文案或语料。
- 形象侧：VRM 原创素材规格见 `docs/v2/P3-01-MATERIALS-NEEDED.md`；本文件只管**声音**。
- 音色描述、风格标签、示例台词全部为本仓库原创，随代码一起受仓库许可证约束。

---

## 2. VoiceDesign 音色描述模板（一段自然语言，直接填进 `WHALE_MIMO_VOICE_DESCRIPTION`）

> 用法：整段作为 MiMo VoiceDesign 的 `user` 消息。年龄、性别、口音、音色、语速、性格六要素缺一不可，
> 顺序无所谓，但**不要写成关键词列表**——官方口径是自然语言描述。

```text
一位十六七岁的少女声线，中文普通话，带一点点南方口音的软糯尾音；音色清亮偏甜，
中高频有细微气声，不用播音腔；语速中等偏慢，句尾习惯轻轻上扬；性格是黏人又爱逞强的女仆，
对主人说话时温柔讨好，被调侃时会立刻拔高音量反驳，但撑不过两秒就泄气。
```

English fallback（同样的六要素，给只吃英文描述的实测对比用；未实测，勿当默认）：

```text
A teenage girl's voice, Mandarin Chinese with a faint southern accent and soft sentence endings;
bright, sweet timbre with a touch of breathiness, never news-anchor polished; medium-slow pace,
slight upward lilt at phrase ends; clingy but proud maid — sweet to her master, quick to raise her
voice when teased, then deflates within two seconds.
```

填写时注意：

- 描述里**不要**写"大肥鱼"三个字。雷区词只属于对话内容，不属于音色。
- 描述是长期资产，改它等于换声线；改完必须重跑 `tools/scripts/bench-tts-ab.mts` 的听感对拍并更新证据文档。
- VoiceClone 模式不需要这段描述，它要的是参考音频（`WHALE_MIMO_VOICE_SAMPLE`）；参考音频同样必须是**自制或已获授权**的录音。

---

## 3. 五情绪映射（与语音中心五档一一对应）

音高偏移取自语音中心既有的 `MCODE_MODES`（`apps/desktop-host/src/main/voice-host.ts`），
风格指令与标签取自语音包常量 `MIMO_EMOTION_STYLE_HINTS` / `MIMO_EMOTION_STYLE_TAGS`
（`packages/voice-runtime/src/providers.ts`）。**改一处必须同步另一处**。

| 档位 id | 中文名 | 音高偏移 | 自然语言风格指令（user 侧） | 助手前缀标签 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| `daily` | 软萌小仆 | +0 半音 | 温柔甜软，带笑意，语速适中 | `(Sweet)` | 日常应答、打招呼、递东西 |
| `bright` | 俏皮上扬 | +4 半音 | 俏皮上扬，语气活泼，句尾轻轻挑起 | `(Playful)` | 撒娇、玩梗、被夸之后 |
| `tsundere` | 傲娇炸毛 | +12 半音 | 傲娇嘴硬，稍不服气，音量略大 | `(Tsundere)` | 被叫"大肥鱼"、被摸头、被拆穿 |
| `sleepy` | 慵懒气声 | −4 半音 | 慵懒困倦，气声偏多，语速偏慢 | `(Sleepy)` | 内心戏、深夜、刚被叫醒 |
| `surprised` | 惊喜元气 | +6 半音 | 惊喜元气，语气上扬，节奏轻快 | `(Excited)` | 收到礼物、开饭、意外收获 |

声音工坊的五情绪锚点是同一套情绪的别名，共用同一份指令与标签：
`sweet_normal → daily`、`tsundere_refuse → tsundere`、`rage_spray → tsundere`（音量更大）、
`lazy_yawn → sleepy`、`clumsy_panic → surprised`（心虚版，指令单独写为"心虚慌乱，语速偏快，带一点不确定"）。

### 3.1 每种控制手段怎么用

1. **user 侧自然语言风格指令**（推荐主用）：官方口径对**所有 MiMo 模型**有效，且不会被念出来。
   VoiceDesign 里它跟在音色描述后面（`…；风格：傲娇嘴硬…`），其它模式单独作为 `user` 消息。
   未知情绪**不注入**，宁可退回默认语气，也不编造一段风格。
2. **助手前缀标签**：把 `(Tsundere)` 放在要说的正文最前面。官方接受半角 `()`、全角 `（）`、`[]` 三种写法，
   本仓库统一半角，避免同一句里混排。标签必须和风格指令同向，别一边写"慵懒"一边打 `(Excited)`。
3. **正文内联音频标签**：可以出现在正文任意位置，例如
   `主人……(sighs deeply) 本鱼真的没有偷懒。(pauses for a moment) 只是刚好在思考人生。`
   常用：`(sighs deeply)`、`(cough)`、`(pauses for a moment)`。
   规则：**一句最多一个**，且只在情绪转折处用；连续堆叠会挤掉正常语调，听感变成"音效串烧"。
4. **唱歌**：只有 `mimo-v2.5-tts` 支持，用正文前缀 `(唱歌)` / `(sing)` / `(singing)` 触发，
   本仓库统一用 `(唱歌)`；由 `styleMode: 'singing'` 自动加，不要在台词里手写。
5. **`optimize_text_preview`**：仅 VoiceDesign，开了以后只按音色描述做预览、可以不传正文。
   用来"只听音色不听话术"的调音阶段，正式播报不要开。

---

## 4. 实测与未实测（2026-11-27 更新，证据见 [mimo-tts-candidate-integration.md](./evidence/mimo-tts-candidate-integration.md) §2.5）

已实测（单次迹象，可复现）：

- `api-key` 与 `Bearer` 两种认证头**都已实测通**（各自一次 200 + 音频）。
- 五种风格控制（baseline / daily / bright / tsundere / sleepy / surprised）在同一句话上**确实产生了可测的差异**：
  时长 3.52 → 4.96s（+41%），F0 中位 216.2–255.3 Hz（慵懒最低、惊喜最高）。这是**迹象不是听感结论**，
  听感留给 owner；稳定性（多次重复）未测。
- 正文内联标签（`(sighs deeply)` + `(pauses for a moment)`）一次成功，音频 7.04s。
- VoiceDesign 按第 2 节的音色描述一次成功（1972ms / 5.6s）。

已定稿的漂移结论（实测，证据 §2.8）：

- **VoiceDesign 同一描述连跑 10 次，说话人余弦最小 0.4145**——漂移是实的，不能当角色固定声线。
- 推荐路径：**VoiceDesign 出候选 → 人工挑一条 → 用自产音频走 VoiceClone 锁死**；
  参考音频必须是自产或已获授权的录音，不碰他人声音。

仍未实测（不许写成已支持）：

- 情绪稳定性（同指令连跑 ≥10 次的分布）、唱歌听感、VoiceClone 克隆一致性（在跑，用自产 `consistency-1.wav` 当参考音频）。
- MiMo 流式（`pcm16`）**未实现**，`supportsStreaming` 固定 `false`。
- OpenRouter Gemini 3.8 Flash TTS 的情绪控制方式官方没有说法，一律按"未验证"处理；要试就在 bench 单开实验组。
- 音高偏移是 mcode 链路的参数，**不能**直接套到 MiMo / OpenRouter 上：它们的 API 没有 pitch 字段。
  商业 TTS 下只能靠风格指令与标签间接影响音高。

---

## 5. 维护约定

- 改音色描述、改风格指令、改标签：三处同步——本文、`packages/voice-runtime/src/providers.ts` 的两个常量、
  `docs/v2/evidence/mimo-tts-candidate-integration.md` 的实测记录（如果有新实测）。
- 任何"听起来更好"的结论都必须附 bench 产物路径与日期；没有产物的听感结论不进文档。
