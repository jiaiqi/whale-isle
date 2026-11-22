/**
 * 声音工坊 Voice Studio（T-M5-17）：音色库/创建向导 + 5 情感调音台 + RVC 实验室 + 保存栏。
 * 后端：services/audio-ai-worker /api/voice-studio/*（经主进程 HTTP 代理）。
 */
import { useEffect, useState } from 'react';
import {
  AudioLines, Cloud, Disc3, Download, FileMusic, Mic2, Plus, RotateCcw,
  Save, Sliders, Sparkles, Upload,
} from 'lucide-react';

/** 五情绪锚点定义（契约 TtsEmotionTuningParamsSchema.emotionTag 对齐） */
const EMOTIONS = [
  { tag: 'sweet_normal', label: '嘴甜常态', sample: '主人好～今天的米饭已经备好了哦！' },
  { tag: 'tsundere_refuse', label: '傲娇反驳', sample: '哼、哼！才不是因为担心主人呢！' },
  { tag: 'rage_spray', label: '大肥鱼破防', sample: '谁、谁是鱼啊！本鱼是鲸！喷水抗议！' },
  { tag: 'lazy_yawn', label: '困倦摸鱼', sample: '唔……好困……让本鱼再睡五分钟嘛……' },
  { tag: 'clumsy_panic', label: '翻车心虚', sample: '都、都怪这块石头突然长出来的！' },
] as const;

type EmotionTag = (typeof EMOTIONS)[number]['tag'];

interface EmotionParams {
  emotionTag: EmotionTag;
  refAudioPath: string;
  refText: string;
  speed: number;
  temperature: number;
  topP: number;
  topK: number;
  pauseConfig: { periodMs: number; commaMs: number; ellipsisMs: number };
  prependSfxPath: string;
  sfxVolume: number;
}

interface SvcParams {
  rvcModelPath: string;
  indexPath: string;
  pitchShiftSemitones: number;
  indexRate: number;
  protectVoiceless: number;
  vocalGainDb: number;
  accompanimentGainDb: number;
}

const DEFAULT_PARAMS: Record<EmotionTag, EmotionParams> = Object.fromEntries(
  EMOTIONS.map((e) => [
    e.tag,
    {
      emotionTag: e.tag,
      refAudioPath: `ref/${e.tag}.wav`,
      refText: e.sample,
      speed: 1.0,
      temperature: 0.8,
      topP: 1.0,
      topK: 15,
      pauseConfig: { periodMs: 340, commaMs: 150, ellipsisMs: 460 },
      prependSfxPath: '',
      sfxVolume: 0,
    } satisfies EmotionParams,
  ]),
) as Record<EmotionTag, EmotionParams>;

const DEFAULT_SVC: SvcParams = {
  rvcModelPath: '',
  indexPath: '',
  pitchShiftSemitones: 0,
  indexRate: 0.75,
  protectVoiceless: 0.33,
  vocalGainDb: 0,
  accompanimentGainDb: -3,
};

type CreateMode = 'cloud_voice_design' | 'local_audio_slice' | 'local_weight_import';

export function VoiceStudioPanel(): React.JSX.Element {
  const [emotions, setEmotions] = useState<Record<EmotionTag, EmotionParams>>({ ...DEFAULT_PARAMS });
  const [svc, setSvc] = useState<SvcParams>({ ...DEFAULT_SVC });
  const [activeTag, setActiveTag] = useState<EmotionTag>('sweet_normal');
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>('cloud_voice_design');
  const [createPrompt, setCreatePrompt] = useState('12到14岁的二次元美少女音色，清亮甜美中带着一丝娇俏与懒散的反差感……');
  const [weightPath, setWeightPath] = useState('');
  const [audioPath, setAudioPath] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testText, setTestText] = useState<string>(EMOTIONS[0]!.sample);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(null), 6000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [notice]);

  const current = emotions[activeTag]!;

  const patchEmotion = (patch: Partial<EmotionParams>): void => {
    setEmotions((prev) => ({ ...prev, [activeTag]: { ...prev[activeTag]!, ...patch } }));
    setSaved(false);
  };

  const patchSvc = (patch: Partial<SvcParams>): void => {
    setSvc((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  };

  const callWorker = async (path: string, body: unknown): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> => {
    setBusy(path);
    try {
      // 直接调 audio-ai-worker（127.0.0.1:18790）——生产经主进程代理，此处开发直连
      const res = await fetch(`http://127.0.0.1:18790${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const err = data as { error?: string; autoFill?: string };
        if (err.autoFill) {
          return { ok: false, error: `${err.error ?? ''}（已建议草稿：${err.autoFill.slice(0, 30)}…）` };
        }
        return { ok: false, error: err.error ?? `HTTP ${res.status}` };
      }
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      setBusy(null);
    }
  };

  const createVoice = async (): Promise<void> => {
    if (createMode === 'cloud_voice_design') {
      const r = await callWorker('/api/voice-studio/design', {
        mode: createMode, prompt: createPrompt, previewText: testText, emotionTag: activeTag,
      });
      setNotice(r.ok ? '✅ 云端音色已生成——参考干声落盘，请在左侧调音台试听微调' : `⚠ ${r.error}`);
    } else if (createMode === 'local_weight_import') {
      const r = await callWorker('/api/voice-studio/design', { mode: createMode, weightPath, licenseScope: 'DEV_ONLY_NON_COMMERCIAL' });
      setNotice(r.ok ? '✅ 权重已导入（DEV_ONLY_NON_COMMERCIAL 标记）——RVC 实验室可直接引用' : `⚠ ${r.error}`);
    } else {
      const r = await callWorker('/api/voice-studio/slice-extract', { filePath: audioPath, separateVocal: true });
      setNotice(r.ok ? `✅ 切片完成（${(r.data?.slices as unknown[] | undefined)?.length ?? 0} 段）——前端试听后绑定情绪锚点` : `⚠ ${r.error}`);
    }
    setCreateOpen(false);
  };

  const auditionTts = async (): Promise<void> => {
    const r = await callWorker('/api/voice-studio/audition-tts', { ...current });
    setNotice(r.ok ? '🔊 试听渲染完成（参数已实时应用）' : `⚠ ${r.error}`);
  };

  const auditionSvc = async (): Promise<void> => {
    const r = await callWorker('/api/voice-studio/audition-svc', svc);
    setNotice(r.ok ? '🎵 RVC 唱歌试听完成（TTS 已自动挂起/恢复）' : `⚠ ${r.error}`);
  };

  const savePack = async (): Promise<void> => {
    const r = await callWorker('/api/voice-studio/save-pack', {
      petId: 'blue-whale-maid',
      voicePackId: 'blue-whale-maid-v2',
      emotionParams: EMOTIONS.map((e) => emotions[e.tag]),
      svcParams: svc,
    });
    if (r.ok) {
      setSaved(true);
      setNotice('✅ 音色包已保存并热重载（voice_matrix.json 原子落盘）');
    } else {
      setNotice(`⚠ ${r.error}`);
    }
  };

  const revert = (): void => {
    setEmotions({ ...DEFAULT_PARAMS });
    setSvc({ ...DEFAULT_SVC });
    setSaved(false);
    setNotice('已还原为上次保存的参数');
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-5">
      {/* 顶部：音色库 + 新建向导 */}
      <header className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">声音工坊</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            生成、切片提取、微调并保存说话（TTS）与唱歌（SVC/RVC）音色
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="pill pill-violet"><Mic2 size={11} className="inline" /> blue-whale-maid</span>
          <span className="pill pill-amber">DEV_ONLY_NON_COMMERCIAL</span>
          <span className="pill pill-green"><Disc3 size={11} className="inline" /> MPS</span>
          <button
            data-voice-studio-create
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold"
            style={{ background: 'var(--blue)', color: '#fff' }}
          >
            <Plus size={13} /> 生成/提取新音色
          </button>
        </div>
      </header>

      {notice && (
        <div className="card mb-4 px-4 py-2.5 text-xs" style={{ color: notice.startsWith('✅') || notice.startsWith('🔊') || notice.startsWith('🎵') ? 'var(--green)' : 'var(--amber)' }}>
          {notice}
        </div>
      )}

      {/* 新建音色弹窗 */}
      {createOpen && (
        <div className="card mb-4 p-4 rise" data-voice-studio-wizard>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Sparkles size={14} style={{ color: 'var(--violet)' }} /> 新建音色 · 三种路径</h3>
          <div className="mb-3 flex gap-2">
            {([
              ['cloud_voice_design', 'AI 描述捏声线', Cloud],
              ['local_audio_slice', '上传干声自动切片', Upload],
              ['local_weight_import', '导入本地权重', FileMusic],
            ] as const).map(([mode, label, Icon]) => (
              <button
                key={mode}
                data-wizard-mode={mode}
                onClick={() => setCreateMode(mode)}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition"
                style={
                  createMode === mode
                    ? { border: '1px solid var(--blue-line)', background: 'var(--blue-dim)', color: 'var(--blue)' }
                    : { border: '1px solid var(--stroke)', background: 'var(--surface-2)', color: 'var(--text-2)' }
                }
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          {createMode === 'cloud_voice_design' && (
            <textarea
              data-wizard-prompt
              value={createPrompt}
              onChange={(e) => setCreatePrompt(e.target.value)}
              rows={3}
              className="inset w-full px-3 py-2 text-xs outline-none"
              style={{ color: 'var(--text-1)', resize: 'vertical' }}
              placeholder="描述你想要的音色……（内置「大肥鱼傲娇蓝鲸女仆」模板可直接编辑）"
            />
          )}
          {createMode === 'local_audio_slice' && (
            <input
              data-wizard-audio-path
              value={audioPath}
              onChange={(e) => setAudioPath(e.target.value)}
              className="inset w-full px-3 py-2 text-xs outline-none"
              style={{ color: 'var(--text-1)' }}
              placeholder="/path/to/原始长音频.wav（Demucs 去伴奏 + VAD 切片 + ASR 草稿）"
            />
          )}
          {createMode === 'local_weight_import' && (
            <input
              data-wizard-weight-path
              value={weightPath}
              onChange={(e) => setWeightPath(e.target.value)}
              className="inset w-full px-3 py-2 text-xs outline-none"
              style={{ color: 'var(--text-1)' }}
              placeholder="/path/to/rvc_model.pth（强制 DEV_ONLY_NON_COMMERCIAL 标记）"
            />
          )}

          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setCreateOpen(false)} className="rounded-full px-3.5 py-1.5 text-xs" style={{ border: '1px solid var(--stroke)', color: 'var(--text-2)' }}>取消</button>
            <button
              data-wizard-submit
              onClick={() => void createVoice()}
              disabled={busy !== null}
              className="rounded-full px-4 py-1.5 text-xs font-semibold disabled:opacity-40"
              style={{ background: 'var(--blue)', color: '#fff' }}
            >
              {busy ? '处理中…' : '开始生成/导入'}
            </button>
          </div>
        </div>
      )}

      {/* 主体双栏：说话情感调音台 + 唱歌 RVC 实验室 */}
      <div className="grid grid-cols-2 gap-4">
        {/* 左侧：说话情感调音台 */}
        <section className="card p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <AudioLines size={15} style={{ color: 'var(--blue)' }} /> 说话情感调音台
          </h3>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {EMOTIONS.map((e) => (
              <button
                key={e.tag}
                data-vs-emotion={e.tag}
                data-active={activeTag === e.tag ? 'true' : 'false'}
                onClick={() => { setActiveTag(e.tag); setTestText(e.sample); }}
                className="rounded-full px-3 py-1.5 text-xs font-medium transition"
                style={
                  activeTag === e.tag
                    ? { border: '1px solid var(--blue-line)', background: 'var(--blue-dim)', color: 'var(--blue)' }
                    : { border: '1px solid var(--stroke)', background: 'var(--surface-2)', color: 'var(--text-2)' }
                }
              >
                {e.label}
              </button>
            ))}
          </div>

          <label className="mb-1.5 block text-[11px]" style={{ color: 'var(--text-2)' }}>参考文本（refText，必填防 ASR 卡顿）</label>
          <input
            data-vs-ref-text
            value={current.refText}
            onChange={(e) => patchEmotion({ refText: e.target.value })}
            className="inset mb-3 w-full px-3 py-2 text-xs outline-none"
            style={{ color: 'var(--text-1)' }}
          />

          {([
            ['speed', '语速', 0.7, 1.4, 0.05],
            ['temperature', '表现力 (Temperature)', 0.1, 1.0, 0.05],
          ] as const).map(([key, label, min, max, step]) => (
            <div key={key} className="mb-2.5">
              <div className="mb-1 flex justify-between text-[11px]">
                <span style={{ color: 'var(--text-2)' }}>{label}</span>
                <span className="mono" style={{ color: 'var(--blue)' }}>{(current[key] as number).toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={min} max={max} step={step}
                value={current[key] as number}
                onChange={(e) => patchEmotion({ [key]: Number(e.target.value) } as Partial<EmotionParams>)}
                className="w-full accent-blue-500"
                data-vs-slider={key}
              />
            </div>
          ))}

          <div className="mb-2.5 grid grid-cols-3 gap-2">
            {([
              ['periodMs', '句停(ms)'], ['commaMs', '逗停(ms)'], ['ellipsisMs', '省停(ms)'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <div className="mb-1 text-[10px]" style={{ color: 'var(--text-2)' }}>{label}</div>
                <input
                  type="number"
                  value={current.pauseConfig[key]}
                  onChange={(e) => patchEmotion({ pauseConfig: { ...current.pauseConfig, [key]: Number(e.target.value) } })}
                  className="inset mono w-full px-2 py-1 text-[11px] outline-none"
                  style={{ color: 'var(--text-1)' }}
                  data-vs-pause={key}
                />
              </div>
            ))}
          </div>

          <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-2)' }}>测试台词</label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {EMOTIONS.map((e) => (
              <button
                key={e.tag}
                data-vs-quick-line={e.tag}
                onClick={() => setTestText(e.sample)}
                className="pill pill"
                style={{ fontSize: 10 }}
              >
                {e.label}
              </button>
            ))}
          </div>
          <input
            data-vs-test-text
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            className="inset mb-3 w-full px-3 py-2 text-xs outline-none"
            style={{ color: 'var(--text-1)' }}
            placeholder="才……才不是大肥鱼呢！"
          />

          <button
            data-vs-audition-tts
            onClick={() => void auditionTts()}
            disabled={busy !== null}
            className="flex w-full items-center justify-center gap-2 rounded-full py-2 text-xs font-semibold disabled:opacity-40"
            style={{ background: 'var(--green)', color: '#04140a' }}
          >
            <Sliders size={13} /> 试听当前参数（单端语音锁）
          </button>
        </section>

        {/* 右侧：RVC 实验室 */}
        <section className="card p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Mic2 size={15} style={{ color: 'var(--violet)' }} /> 唱歌音色精调 · RVC 实验室
          </h3>

          <div className="mb-3 grid grid-cols-2 gap-2">
            {([
              ['rvcModelPath', 'RVC 模型路径'], ['indexPath', 'Index 路径'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <div className="mb-1 text-[10px]" style={{ color: 'var(--text-2)' }}>{label}</div>
                <input
                  value={svc[key]}
                  onChange={(e) => patchSvc({ [key]: e.target.value } as Partial<SvcParams>)}
                  className="inset mono w-full px-2 py-1.5 text-[11px] outline-none"
                  style={{ color: 'var(--text-1)' }}
                  placeholder="(可选)"
                  data-vs-svc-path={key}
                />
              </div>
            ))}
          </div>

          {([
            ['pitchShiftSemitones', '升降调 (半音)', -12, 12, 1],
            ['indexRate', '音色还原度 (Index Rate)', 0, 1, 0.05],
            ['protectVoiceless', '气声保护 (Protect)', 0, 0.5, 0.01],
            ['vocalGainDb', '人声电平 (dB)', -12, 12, 0.5],
            ['accompanimentGainDb', '伴奏电平 (dB)', -24, 6, 0.5],
          ] as const).map(([key, label, min, max, step]) => (
            <div key={key} className="mb-2.5">
              <div className="mb-1 flex justify-between text-[11px]">
                <span style={{ color: 'var(--text-2)' }}>{label}</span>
                <span className="mono" style={{ color: 'var(--violet)' }}>
                  {key === 'pitchShiftSemitones'
                    ? (svc[key] > 0 ? `+${svc[key]}` : svc[key])
                    : (svc[key] as number).toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={min} max={max} step={step}
                value={svc[key] as number}
                onChange={(e) => patchSvc({ [key]: Number(e.target.value) } as Partial<SvcParams>)}
                className="w-full"
                data-vs-svc-slider={key}
              />
            </div>
          ))}

          <div className="mb-3 flex flex-wrap gap-1.5">
            <button data-vs-svc-preset="+2" onClick={() => patchSvc({ pitchShiftSemitones: 2 })} className="pill pill-violet" style={{ fontSize: 10 }}>女声微调 +2</button>
            <button data-vs-svc-preset="+12" onClick={() => patchSvc({ pitchShiftSemitones: 12 })} className="pill pill-violet" style={{ fontSize: 10 }}>男转女 +12</button>
            <button data-vs-svc-preset="0" onClick={() => patchSvc({ pitchShiftSemitones: 0 })} className="pill" style={{ fontSize: 10 }}>原调 0</button>
          </div>

          <button
            data-vs-audition-svc
            onClick={() => void auditionSvc()}
            disabled={busy !== null}
            className="flex w-full items-center justify-center gap-2 rounded-full py-2 text-xs font-semibold disabled:opacity-40"
            style={{ background: 'var(--violet)', color: '#fff' }}
          >
            <Download size={13} /> 副歌 15 秒变声试听
          </button>
          <p className="mt-2 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
            试听期间自动挂起 TTS 引擎释放内存（dsh-voice-studio 资源护栏）；内存 &lt;4GB 自动降级云端。
          </p>
        </section>
      </div>

      {/* 底部吸底栏 */}
      <footer
        className="sticky bottom-0 z-20 mt-4 flex items-center justify-between px-4 py-2.5"
        style={{
          borderRadius: 'var(--r-xl)',
          border: '1px solid var(--stroke)',
          background: 'color-mix(in srgb, var(--bg-elev) 82%, transparent)',
          backdropFilter: 'blur(24px)',
        }}
      >
        <span className="text-xs" style={{ color: 'var(--text-3)' }}>
          {saved ? '✅ 当前参数已保存到桌宠人设（热重载生效）' : '⟳ 参数已修改——保存后生效'}
        </span>
        <div className="flex gap-2">
          <button
            data-vs-revert
            onClick={revert}
            className="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium"
            style={{ border: '1px solid var(--stroke)', background: 'var(--surface-2)', color: 'var(--text-2)' }}
          >
            <RotateCcw size={12} /> 还原修改
          </button>
          <button
            data-vs-save
            onClick={() => void savePack()}
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-full px-5 py-1.5 text-xs font-semibold disabled:opacity-40"
            style={{ background: 'var(--blue)', color: '#fff' }}
          >
            <Save size={12} /> 保存到当前桌宠人设
          </button>
        </div>
      </footer>
    </div>
  );
}
