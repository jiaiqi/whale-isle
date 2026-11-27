/**
 * Tab 4：「表演与精调」（Expressive Speech Performance + Live Viseme Stage + Multi-Char + RVC）
 *
 * 把 Tidepaper voice.html 原型愿景与真实后端链路打通：
 * 1. 实时表演试听台：5 情绪矩阵 + 内联音频标签芯片 + 真实 `lipFrames` 口型 Viseme 轨道同步点亮
 *    + 「在此试听」与「让桌宠在桌面说出」双通道 + 跳转「点歌台」（严格区分说话 TTS 与唱歌 SVS/SVC）
 * 2. 多角色 5×5 绑定试听（折叠/切换）
 * 3. 本地 Audio Worker 情感参数与 RVC 唱歌实验室（保留 `[data-voice-studio-character]` 契约）
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowRight, AudioLines, Loader2, MicVocal, Music4, Pause, Play, Sliders, Sparkles, Volume2,
} from 'lucide-react';
import {
  VOICE_INLINE_SOUND_TAGS,
  type CommercialTtsProvider,
  type LipSyncFrame,
  type LipSyncViseme,
} from '@workbench/shared-protocol';
import { VoicePanel } from '../voice-panel';
import { VoiceStudioPanel } from '../voice-studio-panel';
import { WaveformPlayer } from './waveform-player';

const EMOTION_CARDS = [
  { id: 'daily', label: '软萌小仆', sub: '撒娇 B 级 · 甜润拖尾', sample: '主人，饭已经盛好了，先吃一口再忙吧～' },
  { id: 'bright', label: '俏皮上扬', sub: '调皮 B 级 · 起伏明显', sample: '主人主人！快看我今天钓到了一条超级大的鱼，厉害吧！' },
  { id: 'tsundere', label: '傲娇炸毛', sub: '傲娇 B 级 · 咬字重', sample: '哼，才、才不是特意在等你呢！别自作多情！' },
  { id: 'sleepy', label: '慵懒气声', sub: '深夜低语 · 气声偏慢', sample: '唔……好困呀……再陪我发五分钟呆好不好……' },
  { id: 'surprised', label: '惊喜元气', sub: '收到礼物 · 节奏轻快', sample: '诶诶诶！这是专门准备给我的吗？！太开心啦！' },
] as const;

const VISEME_LABEL: Record<LipSyncViseme, { label: string; desc: string }> = {
  closed: { label: 'closed', desc: '闭唇' },
  wide: { label: 'wide', desc: '展唇 i/e' },
  round: { label: 'round', desc: '圆唇 o/u' },
  open: { label: 'open', desc: '张口 a' },
  teeth: { label: 'teeth', desc: '咬齿 f/s' },
};

export function VoicePerformanceTab(props: {
  characterId: string;
  characterName: string;
  boundVoiceId: string;
  commercial: CommercialTtsProvider;
  onBindCharacterVoice: (voiceId: string) => Promise<{ ok: boolean; error?: string }>;
  onSpeakOnPet: (text: string, scene?: 'normal' | 'inner' | 'p0') => Promise<void>;
  onOpenSongConsole?: () => void;
}): React.JSX.Element {
  const {
    characterId,
    characterName,
    boundVoiceId,
    commercial,
    onBindCharacterVoice,
    onSpeakOnPet,
    onOpenSongConsole,
  } = props;

  const [emotion, setEmotion] = useState<string>('daily');
  const [text, setText] = useState<string>(EMOTION_CARDS[0].sample);
  const [busy, setBusy] = useState(false);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number>(0);
  const [providerKind, setProviderKind] = useState<string | null>(null);
  const [lipFrames, setLipFrames] = useState<LipSyncFrame[]>([]);
  const [activeViseme, setActiveViseme] = useState<LipSyncViseme>('closed');
  const [playingLip, setPlayingLip] = useState(false);
  const [subPanel, setSubPanel] = useState<'rvc' | 'legacy-catalog'>('rvc');
  const lipAudioRef = useRef<HTMLAudioElement | null>(null);
  const lipRafRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (lipRafRef.current !== null) cancelAnimationFrame(lipRafRef.current);
    lipAudioRef.current?.pause();
  }, []);

  const insertTag = (tag: string): void => {
    const existingCount = (text.match(/\([a-z\s]+\)/gi) ?? []).length;
    if (existingCount >= 1) {
      toast('提示：规则建议每句最多 1 个内联标签，连续堆叠会挤掉正常语调');
    }
    setText((prev) => `${prev}${prev.endsWith(' ') || prev === '' ? '' : ' '}${tag} `);
  };

  const playWithLipSync = (b64: string, frames: LipSyncFrame[]): void => {
    lipAudioRef.current?.pause();
    if (lipRafRef.current !== null) cancelAnimationFrame(lipRafRef.current);
    const audio = new Audio(`data:audio/wav;base64,${b64}`);
    lipAudioRef.current = audio;
    const step = (): void => {
      const ms = audio.currentTime * 1000;
      const frame = frames.find((f) => ms >= f.timestampMs && ms < f.timestampMs + f.durationMs);
      setActiveViseme(frame?.viseme ?? 'closed');
      if (!audio.paused && !audio.ended) {
        lipRafRef.current = requestAnimationFrame(step);
      }
    };
    audio.onended = () => { setPlayingLip(false); setActiveViseme('closed'); };
    audio.onpause = () => { setPlayingLip(false); };
    void audio.play().then(() => {
      setPlayingLip(true);
      lipRafRef.current = requestAnimationFrame(step);
    }).catch(() => setPlayingLip(false));
  };

  const synthesizeAndPreview = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === '') {
      toast.error('请先输入要试听的台词');
      return;
    }
    setBusy(true);
    try {
      const res = await window.directorBridge.v2VoiceSynthesizePreview({
        text: trimmed,
        emotion,
        preferredProvider: commercial,
      });
      setProviderKind(res.providerKind);
      setDurationMs(res.durationMs);
      setLipFrames(res.lipFrames);
      if (res.audioBase64 !== undefined) {
        setAudioBase64(res.audioBase64);
        playWithLipSync(res.audioBase64, res.lipFrames);
        toast.success(`合成完成 · ${res.providerKind}（${res.lipFrames.length} 帧真实口型包络）`);
      } else {
        setAudioBase64(null);
        toast(`${res.providerKind} 未返回音频，已生成 ${res.lipFrames.length} 帧口型包络`);
      }
    } catch (err) {
      toast.error(`合成失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-voice-performance-tab>
      {/* ① 实时情绪表演试听台 + 口型 Viseme 联动 */}
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.85fr]">
        <section className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="wb-display flex items-center gap-2 text-lg">
                <MicVocal size={16} style={{ color: 'var(--accent)' }} />五情绪表演试听台
              </h2>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                同一固定声线 + 风格指令与前缀标签驱动情绪；不切换情绪参考音频，确保绝不换人。
              </p>
            </div>
            {providerKind !== null && <span className="pill pill-blue mono" style={{ fontSize: 10 }}>{providerKind}</span>}
          </div>

          {/* 5 情绪选择矩阵 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-voice-emotion-matrix>
            {EMOTION_CARDS.map((card) => {
              const on = emotion === card.id;
              return (
                <button
                  key={card.id}
                  type="button"
                  data-voice-emotion-pick={card.id}
                  onClick={() => { setEmotion(card.id); setText(card.sample); }}
                  className="rounded-xl p-2.5 text-left transition"
                  style={{
                    border: `1px solid ${on ? 'var(--accent-line)' : 'var(--stroke)'}`,
                    background: on ? 'var(--accent-soft)' : 'var(--inset)',
                  }}
                >
                  <div className="text-xs font-semibold" style={{ color: on ? 'var(--accent)' : 'var(--text-1)' }}>{card.label}</div>
                  <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-3)' }}>{card.sub}</div>
                </button>
              );
            })}
          </div>

          {/* 台词编辑器 + 内联音频标签快捷键 */}
          <div className="mt-3.5">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="font-semibold" style={{ color: 'var(--text-2)' }}>测试台词（支持内联音频标签）</span>
              <div className="flex flex-wrap items-center gap-1">
                <span style={{ color: 'var(--text-3)' }}>插入标签：</span>
                {VOICE_INLINE_SOUND_TAGS.map((item) => (
                  <button
                    key={item.tag}
                    type="button"
                    title={item.hint}
                    onClick={() => insertTag(item.tag)}
                    className="rounded-md px-2 py-0.5 font-mono text-[10px] transition"
                    style={{ border: '1px solid var(--stroke)', background: 'var(--surface-solid)', color: 'var(--text-2)' }}
                  >
                    + {item.label} <span style={{ color: 'var(--text-3)' }}>{item.tag}</span>
                  </button>
                ))}
              </div>
            </div>
            <textarea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-xl px-3 py-2 text-xs leading-relaxed outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void synthesizeAndPreview()}
              className="btn-pill primary"
              data-voice-perf-preview
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {busy ? '合成中…' : '合成并试听（含口型预览）'}
            </button>
            <button
              type="button"
              disabled={text.trim() === ''}
              onClick={() => void onSpeakOnPet(text.trim(), emotion === 'sleepy' ? 'inner' : emotion === 'tsundere' ? 'p0' : 'normal')}
              className="btn-pill ghost"
            >
              <Volume2 size={13} />让桌面桌宠说出
            </button>
            {audioBase64 !== null && (
              <button
                type="button"
                className="btn-pill ghost"
                onClick={() => {
                  if (playingLip) lipAudioRef.current?.pause();
                  else playWithLipSync(audioBase64, lipFrames);
                }}
              >
                {playingLip ? <Pause size={12} /> : <Play size={12} />}
                {playingLip ? '暂停口型同步' : '重播口型同步'}
              </button>
            )}
          </div>

          {audioBase64 !== null && (
            <div className="mt-3">
              <WaveformPlayer audioBase64={audioBase64} durationMs={durationMs} downloadName={`performance-${emotion}.wav`} compact />
            </div>
          )}
        </section>

        {/* 右侧：实时 Viseme 口型包络监视器 + 唱歌/说话解耦说明 */}
        <div className="space-y-4">
          <section className="card p-5" data-voice-viseme-monitor>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <Sparkles size={14} style={{ color: 'var(--accent)' }} />口型同步 Viseme 实时包络
              </h3>
              <span className="pill mono" style={{ fontSize: 10 }}>
                {lipFrames.length > 0 ? `${lipFrames.length} 帧真实包络` : '待合成'}
              </span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {(['closed', 'wide', 'round', 'open', 'teeth'] as const).map((v) => {
                const lit = activeViseme === v;
                return (
                  <div
                    key={v}
                    className={`vs-viseme-cell${lit ? ' lit' : ''}`}
                    data-viseme-cell={v}
                  >
                    <div className="mono text-[11px] font-semibold">{VISEME_LABEL[v].label}</div>
                    <div className="mt-0.5 text-[10px] opacity-80">{VISEME_LABEL[v].desc}</div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
              口型包络由 WAV 真实幅度包络提取（<span className="mono">extractWavLipSyncFrames</span>），与桌宠舞台、Live2D / VRM BlendShape 共用同一播放时间基准。
            </p>
          </section>

          <section className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Music4 size={14} style={{ color: 'var(--violet)' }} />说话（TTS）与唱歌（SVS / SVC）严格分离
                </h3>
                <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
                  遵循 ADR-005：日常对话与情绪表演走本页 TTS / VoiceClone 声线；专业翻唱与直播点歌由独立 Sing Engine（RVC / DiffSinger）与四重版权门禁处理。
                </p>
              </div>
              {onOpenSongConsole !== undefined && (
                <button type="button" onClick={onOpenSongConsole} className="btn-pill ghost shrink-0">
                  前往点歌台 <ArrowRight size={12} />
                </button>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* ② 底部切换：RVC / 本地精调（含 data-voice-studio-character） vs 多角色 5×5 绑定 */}
      <section className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-3" style={{ borderColor: 'var(--stroke)' }}>
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Sliders size={14} style={{ color: 'var(--blue)' }} />高级参数精调与角色音色矩阵
            </h3>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-3)' }}>
              当前配置角色：<b style={{ color: 'var(--text-1)' }}>{characterName}</b>（<span className="mono">{characterId}</span>）
            </p>
          </div>
          <div className="seg">
            <button type="button" className={subPanel === 'rvc' ? 'on' : ''} onClick={() => setSubPanel('rvc')}>
              <Sliders size={11} />本地精调与 RVC 实验室
            </button>
            <button type="button" className={subPanel === 'legacy-catalog' ? 'on' : ''} onClick={() => setSubPanel('legacy-catalog')}>
              <AudioLines size={11} />9 角色 5×5 绑定矩阵
            </button>
          </div>
        </div>

        {subPanel === 'rvc' ? (
          <VoiceStudioPanel bare characterId={characterId} characterName={characterName} />
        ) : (
          <VoicePanel bare characterName={characterName} boundVoiceId={boundVoiceId} onBind={onBindCharacterVoice} />
        )}
      </section>
    </div>
  );
}
