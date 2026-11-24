/**
 * 「语音中心」面板（T-M6-46，对齐 design/voice-studio.html）。
 *
 * 顶部 9 角色声线绑定条（每角色独立覆盖 → userData/voice-bindings.json），
 * 下方 5×5 试听与高阶情感/RVC 精调全部随所选 characterId 动态切换；
 * 右侧三张状态卡如实展示：真实语音后端（mcode/say/未适配）、动作原声 ducking、全局抢麦锁 live 状态。
 */
import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Lock, Radio, Sliders, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import type { CharacterSummary } from './bridge';
import { VoicePanel } from './voice-panel';
import { VoiceStudioPanel } from './voice-studio-panel';

interface BindingView {
  characterId: string;
  displayName: string;
  voiceId: string;
  defaultVoiceId: string;
  overridden: boolean;
}

export function VoiceCenterPanel(props: {
  characters: CharacterSummary[];
  characterId: string;
  onSelectCharacter: (id: string) => void;
}): React.JSX.Element {
  const { characters, characterId, onSelectCharacter } = props;
  const [tab, setTab] = useState<'catalog' | 'studio'>('catalog');
  const [bindings, setBindings] = useState<BindingView[]>([]);
  const [backend, setBackend] = useState<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null>(null);
  const [sfx, setSfx] = useState({ enabled: true, volume: 0.7 });
  const [speaker, setSpeaker] = useState<{ name: string | null; state: 'speaking' | 'idle' }>({ name: null, state: 'idle' });

  const reloadBindings = useCallback((): void => {
    void window.directorBridge.voiceCharacterBindings().then(setBindings).catch(() => setBindings([]));
  }, []);

  useEffect(() => { reloadBindings(); }, [reloadBindings]);

  useEffect(() => {
    void window.directorBridge.voiceBackend().then(setBackend).catch(() => setBackend(null));
    void window.directorBridge.prefsGet().then((prefs) => {
      setSfx({ enabled: prefs.sfxEnabled ?? true, volume: prefs.sfxVolume ?? 0.7 });
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.directorBridge.onCoopSpeaker((event) => {
      setSpeaker({ name: event.state === 'speaking' ? event.speakerName : null, state: event.state });
    });
  }, []);

  const active = bindings.find((binding) => binding.characterId === characterId);
  const fallback = characters.find((character) => character.id === characterId);
  const characterName = active?.displayName ?? fallback?.displayName ?? '小鲸';
  const boundVoiceId = active?.voiceId ?? fallback?.voiceId ?? '';

  const bind = async (voiceId: string): Promise<{ ok: boolean; error?: string }> => {
    const result = await window.directorBridge.voiceCharacterBind(characterId, voiceId);
    if (result.ok) reloadBindings();
    return result;
  };

  const backendLabel = backend === null ? '探测中…' : backend.backend === 'mcode' ? 'mcode 角色链' : backend.backend === 'say' ? 'macOS say 兜底' : '未适配';
  const backendTone = backend?.backend === 'mcode' ? 'pill-green' : backend?.backend === 'say' ? 'pill-amber' : 'pill-red';

  return (
    <div data-voice-center data-voice-tab={tab}>
      <header className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">语音中心</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            9 角色独立声线 · 多宠串行抢麦 · 动作原声 ducking · 五档情感与 RVC 精调
          </p>
        </div>
        <div className="seg-tabs" role="tablist" aria-label="语音中心页签">
          <button type="button" role="tab" data-voice-tab-btn="catalog" aria-selected={tab === 'catalog'} className={`seg-tab${tab === 'catalog' ? ' on' : ''}`} onClick={() => setTab('catalog')}>
            <AudioLines size={12} />角色声线与音色
          </button>
          <button type="button" role="tab" data-voice-tab-btn="studio" aria-selected={tab === 'studio'} className={`seg-tab${tab === 'studio' ? ' on' : ''}`} onClick={() => setTab('studio')}>
            <Sliders size={12} />高阶精调与 RVC
          </button>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl px-4 py-2.5" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }} data-voice-bind-bar>
        <span className="text-[11px] font-semibold" style={{ color: 'var(--text-3)' }}>正在配置角色声线：</span>
        {(bindings.length > 0 ? bindings : characters.map((character) => ({
          characterId: character.id,
          displayName: character.displayName,
          voiceId: character.voiceId,
          defaultVoiceId: character.voiceId,
          overridden: false,
        }))).filter((binding) => !binding.characterId.startsWith('crosspet-')).map((binding) => {
          const on = binding.characterId === characterId;
          return (
            <button
              key={binding.characterId}
              type="button"
              data-voice-char={binding.characterId}
              data-selected={on ? 'true' : 'false'}
              onClick={() => onSelectCharacter(binding.characterId)}
              className="rounded-full px-3 py-1 text-[11.5px] font-semibold transition"
              style={{
                border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}`,
                background: on ? 'var(--blue-dim)' : 'var(--inset)',
                color: on ? 'var(--blue)' : 'var(--text-2)',
              }}
              title={`${binding.displayName} · ${binding.voiceId}${binding.overridden ? '（已改绑）' : '（角色包默认）'}`}
            >
              {binding.displayName}<span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · {binding.voiceId}</span>
            </button>
          );
        })}
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <div className="card p-3.5" data-voice-backend={backend?.backend ?? 'unknown'}>
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="flex items-center gap-1.5"><Radio size={12} style={{ color: 'var(--green)' }} />当前语音后端（如实探测）</span>
            <span className={`pill ${backendTone}`} style={{ fontSize: 10 }}>{backendLabel}</span>
          </div>
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>{backend?.detail ?? '正在探测 mcode-tools / say 链路…'}</p>
        </div>
        <div className="card p-3.5">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="flex items-center gap-1.5"><Volume2 size={12} style={{ color: 'var(--violet)' }} />动作原声音效（.m4a ducking）</span>
            <button
              className={`sw${sfx.enabled ? ' on' : ''}`}
              aria-pressed={sfx.enabled}
              data-sfx-ducking
              onClick={() => {
                const next = { ...sfx, enabled: !sfx.enabled };
                setSfx(next);
                void window.directorBridge.prefsSet({ sfxEnabled: next.enabled });
                toast(next.enabled ? '已开启动作原声（TTS 说话时自动压低至 15%）' : '已关闭动作原声');
              }}
            />
          </div>
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>
            任一桌宠 TTS 说话时，动作原声自动压低至 15%，播完恢复；当前音量 {Math.round(sfx.volume * 100)}%。
          </p>
        </div>
        <div className="card p-3.5" data-voice-lock={speaker.state}>
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="flex items-center gap-1.5"><Lock size={12} style={{ color: 'var(--blue)' }} />多宠全局抢麦锁</span>
            <span className="pill pill-blue" style={{ fontSize: 10 }}>active ≤ 1 串行</span>
          </div>
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-2)' }} data-voice-speaker>
            {speaker.state === 'speaking' && speaker.name !== null ? `正在发言：${speaker.name}` : '空闲：没有桌宠持有语音租约'}
          </p>
        </div>
      </div>

      {tab === 'catalog'
        ? <VoicePanel bare characterName={characterName} boundVoiceId={boundVoiceId} onBind={bind} />
        : <VoiceStudioPanel bare characterId={characterId} characterName={characterName} />}
    </div>
  );
}
