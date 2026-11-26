/**
 * 音色设计台（VoiceDesign Lab）——对齐小米 MiMo 官方「音色设计」页的交互：
 * 左边写音色描述 + 播报文本，右边听结果，中间只改一个变量做对拍。
 *
 * 只做真实支持的事：
 * - 走 `mimo-v2.5-tts-voicedesign`，音色描述是必填的自然语言段落（模板见 docs/v2/VOICE-PERSONA-xiaojing.md）；
 * - 情绪只能选五档之一（不控制 / daily / bright / tsundere / sleepy / surprised），
 *   主进程按同一份 `MIMO_EMOTION_STYLE_HINTS` / `MIMO_EMOTION_STYLE_TAGS` 注入，跟真机实测的口径一致；
 * - 没有「AI 一键生成描述」：那需要一个模型网关调用，当前没接，就不放一个点了没反应的按钮。
 */
import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Mic2, Pause, Play, Sparkles, Wand2 } from 'lucide-react';

/** 原创示例描述（不复制任何第三方文案）；第一个就是小鲸的定稿人设 */
const DESCRIPTION_PRESETS: Array<{ id: string; label: string; text: string }> = [
  {
    id: 'xiaojing',
    label: '小鲸·软萌女仆',
    text: '一位十六七岁的少女声线，中文普通话，带一点点南方口音的软糯尾音；音色清亮偏甜，中高频有细微气声，不用播音腔；语速中等偏慢，句尾习惯轻轻上扬；性格是黏人又爱逞强的女仆，对主人说话时温柔讨好，被调侃时会立刻拔高音量反驳，但撑不过两秒就泄气。',
  },
  {
    id: 'genki',
    label: '元气少女',
    text: '十八岁左右的少女声线，普通话标准，音色明亮结实，中气足；语速偏快，句尾干脆利落，笑起来有明显的上扬；性格开朗外向，像刚运动完还在兴奋地说话。',
  },
  {
    id: 'ojousama',
    label: '傲娇大小姐',
    text: '十七八岁的少女声线，普通话略带一点矜持的咬字，音色偏冷偏亮；语速中等，重音落在句首，尾音收得干净；性格高傲挑剔，说话时习惯性带着一点不耐烦，但不会真的凶。',
  },
  {
    id: 'nightradio',
    label: '深夜电台',
    text: '二十出头的女性声线，普通话标准，音色偏低偏暖，气声明显；语速慢，停顿多，句尾往下收；性格温和克制，像深夜电台里不想吵醒任何人的主持人。',
  },
];

const EMOTION_OPTIONS: Array<{ id: string; label: string }> = [
  { id: '', label: '不控制' },
  { id: 'daily', label: '软萌小仆' },
  { id: 'bright', label: '俏皮上扬' },
  { id: 'tsundere', label: '傲娇炸毛' },
  { id: 'sleepy', label: '慵懒气声' },
  { id: 'surprised', label: '惊喜元气' },
];

const DEFAULT_TEXT = '主人，饭已经盛好了，先吃一口再忙吧。';

interface PreviewResult {
  providerKind: string;
  format: string;
  durationMs: number;
  audioBase64?: string;
  degraded: boolean;
}

function formatSeconds(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function VoiceDesignLab(): React.JSX.Element {
  const [description, setDescription] = useState(DESCRIPTION_PRESETS[0]!.text);
  const [text, setText] = useState(DEFAULT_TEXT);
  const [emotion, setEmotion] = useState('');
  const [optimizePreview, setOptimizePreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [binding, setBinding] = useState(false);
  const [bound, setBound] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => {
    audioRef.current?.pause();
    if (audioUrl !== null) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const generate = async (): Promise<void> => {
    if (description.trim() === '') {
      setError('音色描述不能为空：VoiceDesign 靠这段自然语言决定声线');
      return;
    }
    if (text.trim() === '') {
      setError('播报文本不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await window.directorBridge.v2VoiceDesignPreview({
        text: text.trim(),
        voiceDescription: description.trim(),
        ...(emotion === '' ? {} : { emotion }),
        optimizeTextPreview: optimizePreview,
      });
      if (res.audioBase64 === undefined) {
        setError(`${res.providerKind} 没有返回音频（系统兜底后端只给口型帧）`);
        return;
      }
      const bytes = Uint8Array.from(atob(res.audioBase64), (ch) => ch.charCodeAt(0));
      const blob = new Blob([bytes], { type: res.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setResult(res);
      setPositionMs(0);
      setPlaying(false);
      setAudioUrl((prev) => {
        if (prev !== null) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 设为桌宠声线：把当前描述写进角色的 VoiceDesign 声线设定，并把默认档供应商切到 voicedesign。
   * 主进程的 voicedesign provider 每次合成时重读角色描述（见 v2-kernel-host 的 resolveVoiceDescription），
   * 所以点完就生效，不用重启。
   */
  const bindVoice = async (): Promise<void> => {
    setBinding(true);
    setBound(null);
    try {
      await window.directorBridge.v2VoiceIdentityUpdate({
        voiceDescription: description.trim(),
        preferredProviderId: 'mimo-tts-voicedesign',
      });
      await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voicedesign' });
      setBound('已设为桌宠声线：角色 VoiceDesign 描述已写入，默认档已切到 MiMo VoiceDesign');
      setError(null);
    } catch (err) {
      setError(`设为声线失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBinding(false);
    }
  };

  const togglePlay = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    void audio.play().then(() => setPlaying(true)).catch((err: unknown) => {
      setError(`播放失败：${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const durationMs = result?.durationMs ?? 0;

  return (
    <div className="grid gap-3 md:grid-cols-2" data-voice-design-lab>
      <section className="card p-3.5">
        <label className="flex items-center justify-between text-xs font-semibold">
          <span>音色描述 <span style={{ color: 'var(--red)' }}>*</span></span>
          <span className="flex items-center gap-1 text-[10.5px] font-normal" style={{ color: 'var(--text-3)' }}>
            <Sparkles size={11} /> 自然语言，越具体越稳
          </span>
        </label>
        <textarea
          data-voice-design-description
          value={description}
          maxLength={1024}
          onChange={(event) => setDescription(event.target.value)}
          rows={5}
          className="mt-1.5 w-full resize-y rounded-xl px-2.5 py-2 text-[11.5px] leading-relaxed outline-none"
          style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
          placeholder="年龄 / 性别 / 口音 / 音色 / 语速 / 性格，一段话写清"
        />
        <div className="mt-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span>示例</span>
          <span data-voice-design-description-count>{description.length}/1024</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {DESCRIPTION_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-voice-design-preset={preset.id}
              onClick={() => setDescription(preset.text)}
              className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
              style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <label className="mt-3 flex items-center justify-between text-xs font-semibold">
          <span>播报文本 <span style={{ color: 'var(--red)' }}>*</span></span>
          <span className="text-[10.5px] font-normal" style={{ color: 'var(--text-3)' }} data-voice-design-text-count>
            {text.length}/1024
          </span>
        </label>
        <textarea
          data-voice-design-text
          value={text}
          maxLength={1024}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          className="mt-1.5 w-full resize-y rounded-xl px-2.5 py-2 text-[11.5px] leading-relaxed outline-none"
          style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
          placeholder="要念出来的内容；正文里可插入 (sighs deeply) 这类内联标签"
        />

        <div className="mt-3">
          <p className="text-[11px] font-semibold" style={{ color: 'var(--text-3)' }}>情绪控制（可选，只改这一个变量）</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {EMOTION_OPTIONS.map((option) => {
              const on = emotion === option.id;
              return (
                <button
                  key={option.id === '' ? 'none' : option.id}
                  type="button"
                  data-voice-design-emotion={option.id === '' ? 'none' : option.id}
                  aria-pressed={on}
                  onClick={() => setEmotion(option.id)}
                  className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={{
                    border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}`,
                    background: on ? 'var(--blue-dim)' : 'var(--surface)',
                    color: on ? 'var(--blue)' : 'var(--text-2)',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <label className="mt-2 flex items-center gap-1.5 text-[10.5px]" style={{ color: 'var(--text-2)' }}>
          <input
            type="checkbox"
            data-voice-design-optimize-preview
            checked={optimizePreview}
            onChange={(event) => setOptimizePreview(event.target.checked)}
          />
          只预览音色（optimize_text_preview：省略播报文本，只听声线）
        </label>
      </section>

      <section className="card p-3.5" data-voice-design-result={result === null ? 'empty' : 'ready'}>
        <div className="flex items-center justify-between text-xs font-semibold">
          <span>合成结果</span>
          {result !== null && (
            <span className="pill pill-blue" style={{ fontSize: 10 }}>{result.providerKind}</span>
          )}
        </div>

        {audioUrl === null
          ? (
            <div className="flex h-44 flex-col items-center justify-center gap-2 text-[11px]" style={{ color: 'var(--text-3)' }}>
              <Wand2 size={22} style={{ opacity: 0.45 }} />
              还没有合成结果：左边填好描述与文本，点下面的「生成语音」
            </div>
          )
          : (
            <div className="mt-3">
              <audio
                ref={audioRef}
                src={audioUrl}
                onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
                onEnded={() => { setPlaying(false); setPositionMs(0); }}
                onLoadedMetadata={() => undefined}
              />
              <input
                type="range"
                data-voice-design-seek
                min={0}
                max={Math.max(1, durationMs)}
                value={Math.min(positionMs, durationMs)}
                onChange={(event) => {
                  const audio = audioRef.current;
                  if (audio === null) return;
                  audio.currentTime = Number(event.target.value) / 1000;
                  setPositionMs(Number(event.target.value));
                }}
                className="w-full"
              />
              <div className="flex justify-between text-[10px]" style={{ color: 'var(--text-3)' }}>
                <span>{formatSeconds(positionMs)}</span>
                <span>{formatSeconds(durationMs)}</span>
              </div>
              <div className="mt-2 flex items-center justify-center gap-4">
                <button
                  type="button"
                  data-voice-design-play
                  onClick={togglePlay}
                  className="flex h-10 w-10 items-center justify-center rounded-full"
                  style={{ border: '1px solid var(--blue-line)', background: 'var(--blue-dim)', color: 'var(--blue)' }}
                  aria-label={playing ? '暂停' : '播放'}
                >
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <a
                  data-voice-design-download
                  href={audioUrl}
                  download={`voice-design-${emotion === '' ? 'baseline' : emotion}.wav`}
                  className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                  aria-label="下载音频"
                >
                  <Download size={13} />
                </a>
              </div>
            </div>
          )}

        {error !== null && (
          <p className="mt-2 text-[11px]" data-voice-design-error style={{ color: 'var(--red)' }}>{error}</p>
        )}

        <button
          type="button"
          data-voice-design-bind
          disabled={binding || description.trim() === ''}
          onClick={() => void bindVoice()}
          className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold"
          style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
          title="把当前音色描述写入桌宠角色的声线设定，并把默认档切到 MiMo VoiceDesign"
        >
          {binding ? <Loader2 size={13} className="animate-spin" /> : <Mic2 size={13} />}
          {binding ? '写入中…' : '设为桌宠声线'}
        </button>
        {bound !== null && (
          <p className="mb-2 text-[10.5px]" data-voice-design-bound style={{ color: 'var(--green)' }}>{bound}</p>
        )}
        <button
          type="button"
          data-voice-design-generate
          disabled={busy}
          onClick={() => void generate()}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold"
          style={{ border: '1px solid var(--blue-line)', background: 'var(--blue-dim)', color: 'var(--blue)' }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
          {busy ? '合成中…' : '生成语音'}
        </button>
        <p className="mt-1.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
          走 `mimo-v2.5-tts-voicedesign`，Key 从凭据库取（providerId `mimo-tts`）；未配置会如实报错，不会用假音频顶替。
          <br />
          实测提醒：同一描述连跑 10 次的说话人余弦最小 0.4145——漂移是实的，不能当固定声线。
          路径：这里出候选 → 人工挑一条 → 用自产音频走 VoiceClone 锁死（漂移实验见证据文档 §2.8）。
        </p>
      </section>
    </div>
  );
}
