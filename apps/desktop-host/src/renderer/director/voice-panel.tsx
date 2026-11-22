/**
 * 音色库页（D11 音色选择器）：候选音色 × 五档情感试听。
 * 选中音色写 voice.config.voiceId → 全场景（聊天/回执/内心戏）立即换声。
 */
import { useEffect, useState } from 'react';
import { AudioLines, Check, Play, Star } from 'lucide-react';

interface VoiceOption {
  id: string;
  label: string;
  desc: string;
}
interface ModeOption {
  id: string;
  label: string;
  emotion: string;
  pitch: number;
  speed: number;
  volume: number;
}

const MODE_SAMPLE: Record<string, string> = {
  daily: '哼，本鱼才没有偷懒呢！主人快夸夸我嘛～',
  bright: '主人主人！快看快看！本鱼今天钓到了一条超级大的鱼哦！厉不厉害呀？',
  tsundere: '谁、谁是鱼啊！本鱼是鲸！喷水抗议！最讨厌主人了，哼！',
  sleepy: '唔……其实有一点点想主人夸我……才怪……',
  surprised: '诶诶诶！主人居然给本鱼准备了礼物？！真的吗真的吗！',
};

export function VoicePanel({ bare = false }: { bare?: boolean } = {}): React.JSX.Element {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [modes, setModes] = useState<ModeOption[]>([]);
  const [currentVoiceId, setCurrentVoiceId] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void window.directorBridge.voiceCatalog().then((catalog) => {
      setVoices(catalog.voices);
      setModes(catalog.modes);
      setCurrentVoiceId(catalog.currentVoiceId);
    });
  }, []);

  const audition = async (voiceId: string, mode: string): Promise<void> => {
    setBusy(`${voiceId}:${mode}`);
    setNotice(null);
    const res = await window.directorBridge.voiceAudition(voiceId, mode, MODE_SAMPLE[mode]);
    setBusy(null);
    if (!res.ok) setNotice(`错误：试听失败：${res.error ?? '未知错误'}`);
  };

  const pickVoice = async (voiceId: string): Promise<void> => {
    setCurrentVoiceId(voiceId);
    await window.directorBridge.voiceConfigSet({ voiceId });
    setNotice(`✅ 已切换音色：${voices.find((v) => v.id === voiceId)?.label ?? voiceId}（聊天/游戏播报/内心戏立即生效）`);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      {!bare && (<header className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">音色库</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            选择小鲸的声音 · 点击任一档位试听 · 每档情感参数独立（音高/语速/响度）
          </p>
        </div>
        <span className="pill pill-violet">{voices.length} 个候选音色</span>
      </header>)}

      {notice && (
        <div className="card mb-4 px-4 py-2.5 text-xs" style={{ color: notice.startsWith('✅') ? 'var(--green)' : 'var(--red)' }}>
          {notice}
        </div>
      )}

      <div className="grid gap-4">
        {voices.map((voice) => {
          const selected = voice.id === currentVoiceId;
          return (
            <section
              key={voice.id}
              data-voice-card={voice.id}
              data-selected={selected ? 'true' : 'false'}
              className={`card card-hover p-4 ${selected ? '' : ''}`}
              style={selected ? { borderColor: 'var(--blue-line)', boxShadow: 'var(--glow-blue), inset 0 1px 0 var(--hi)' } : undefined}
            >
              <div className="flex items-center gap-3">
                <div
                  className="grid h-9 w-9 place-items-center rounded-xl"
                  style={{
                    background: selected ? 'var(--blue-dim)' : 'var(--inset)',
                    border: `1px solid ${selected ? 'var(--blue-line)' : 'var(--stroke)'}`,
                    color: selected ? 'var(--blue)' : 'var(--text-2)',
                  }}
                >
                  <AudioLines size={16} strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{voice.label}</span>
                    <span className="mono" style={{ color: 'var(--text-3)' }}>{voice.id}</span>
                    {selected && <span className="pill pill-blue">当前使用</span>}
                  </div>
                  <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-2)' }}>{voice.desc}</p>
                </div>
                <button
                  data-voice-pick={voice.id}
                  onClick={() => void pickVoice(voice.id)}
                  disabled={selected}
                  className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition"
                  style={
                    selected
                      ? { background: 'var(--green-dim)', border: '1px solid var(--green-line)', color: 'var(--green)' }
                      : { background: 'var(--blue)', border: 'none', color: '#fff' }
                  }
                >
                  {selected ? <Check size={13} /> : <Star size={13} />}
                  {selected ? '已选中' : '使用此音色'}
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {modes.map((mode) => {
                  const key = `${voice.id}:${mode.id}`;
                  const active = busy === key;
                  return (
                    <button
                      key={mode.id}
                      data-audition={`${voice.id}:${mode.id}`}
                      onClick={() => void audition(voice.id, mode.id)}
                      disabled={busy !== null}
                      className="inset flex items-center gap-1.5 px-3 py-1.5 text-xs transition disabled:opacity-40"
                      style={{ color: 'var(--text-2)' }}
                    >
                      {active ? <span className="pulse-dot" /> : <Play size={11} strokeWidth={2} />}
                      {mode.label}
                      <span className="mono" style={{ color: 'var(--text-3)' }}>
                        {mode.pitch >= 0 ? `+${mode.pitch}` : mode.pitch} / ×{mode.speed}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-6 text-[11px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
        参数说明 · 音高（半音）决定萝莉感强弱；语速 × 决定元气/慵懒；响度影响情绪张力。
        「慵懒气声」档以低音高＋低响度逼近气声效果；「傲娇炸毛」档以高音高＋高语速模拟情绪爆发。
      </p>
    </div>
  );
}
