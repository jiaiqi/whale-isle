/**
 * 「语音中心」面板（T-M6-46，对齐 design/voice-studio.html）。
 *
 * 顶部 9 角色声线绑定条（每角色独立覆盖 → userData/voice-bindings.json），
 * 下方 5×5 试听与高阶情感/RVC 精调全部随所选 characterId 动态切换；
 * 右侧三张状态卡如实展示：真实语音后端（mcode/say/未适配）、动作原声 ducking、全局抢麦锁 live 状态。
 *
 * item 10 增补：语音引擎档位（默认商业 API / 可选离线档）与本地 Audio Worker 的实测探针。
 * 离线档的体感代价直接引用 shared-protocol 的 `OFFLINE_TIER_COST_TEXT`，不许在这里另写数字。
 */
import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Lock, Radio, Sliders, Timer, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  MIMO_TTS_CANDIDATE_NOTICE,
  OFFLINE_TIER_COST_TEXT,
  type CommercialTtsProvider,
  type VoiceEngineTier,
  type VoiceProviderStatus,
} from '@workbench/shared-protocol';
import { CANDIDATE_TTS_PROVIDERS, COMMERCIAL_TTS_PROVIDERS, resolveCommercialTtsProvider } from '@workbench/voice-runtime';
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
  const [tier, setTier] = useState<VoiceEngineTier>('commercial_default');
  const [providers, setProviders] = useState<VoiceProviderStatus[]>([]);
  const [commercial, setCommercial] = useState<CommercialTtsProvider>('minimax-tts');
  const [previewing, setPreviewing] = useState(false);

  const reloadBindings = useCallback((): void => {
    void window.directorBridge.voiceCharacterBindings().then(setBindings).catch(() => setBindings([]));
  }, []);

  useEffect(() => { reloadBindings(); }, [reloadBindings]);

  useEffect(() => {
    void window.directorBridge.voiceBackend().then(setBackend).catch(() => setBackend(null));
    void window.directorBridge.prefsGet().then((prefs) => {
      setSfx({ enabled: prefs.sfxEnabled ?? true, volume: prefs.sfxVolume ?? 0.7 });
      setTier(prefs.voiceEngineTier ?? 'commercial_default');
      setCommercial(prefs.voiceCommercialProvider ?? 'minimax-tts');
    }).catch(() => undefined);
    void window.directorBridge.v2VoiceProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  const localWorker = providers.find((p) => p.kind === 'local-audio-worker') ?? null;
  const availableKinds = providers.filter((p) => p.available).map((p) => p.kind);
  const commercialChoice = resolveCommercialTtsProvider({ preference: commercial, available: availableKinds });

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

  const offline = tier === 'offline_preferred';
  const toggleTier = (): void => {
    const next: VoiceEngineTier = offline ? 'commercial_default' : 'offline_preferred';
    setTier(next);
    void window.directorBridge.prefsSet({ voiceEngineTier: next });
    toast(next === 'offline_preferred' ? `已切到离线档：${OFFLINE_TIER_COST_TEXT}` : '已切回默认档：商业 API 优先，本地引擎保留为可选离线档');
  };
  const workerTone = localWorker === null || !localWorker.available ? 'pill-red' : localWorker.degraded ? 'pill-amber' : 'pill-green';
  const workerLabel = localWorker === null ? '未探测' : !localWorker.available ? '未启动' : localWorker.degraded ? '占位/降级' : '真实后端';
  const workerDetail = localWorker === null
    ? '未探测到本地 Audio Worker（未启动，或不在本机）'
    : localWorker.detail;
  const emotionLabel = localWorker === null || !localWorker.available
    ? '未知'
    : localWorker.supportsEmotion ? '支持（探针实测）' : '不支持（探针实测）';

  const providerLabel = (kind: CommercialTtsProvider): string =>
    kind === 'minimax-tts'
      ? 'MiniMax T2A'
      : kind === 'openai-compatible-tts'
        ? 'OpenAI 兼容 TTS'
        : kind === 'mimo-tts-voiceclone'
          ? 'MiMo VoiceClone'
          : 'MiMo VoiceDesign';

  const pickCommercial = (next: CommercialTtsProvider): void => {
    setCommercial(next);
    void window.directorBridge.prefsSet({ voiceCommercialProvider: next });
  };

  const previewVoice = async (): Promise<void> => {
    setPreviewing(true);
    try {
      const res = await window.directorBridge.v2VoiceSynthesizePreview({
        text: '[嘴甜常态] 主人，这是默认档商业 TTS 的试听。',
        preferredProvider: commercialChoice.provider,
      });
      if (res.audioBase64 !== undefined) {
        const mime = res.format === 'mp3' ? 'audio/mpeg' : res.format === 'ogg' ? 'audio/ogg' : 'audio/wav';
        void new Audio(`data:${mime};base64,${res.audioBase64}`).play().catch(() => undefined);
      }
      toast.success(`试听已生成 · ${res.providerKind}${res.degraded && res.degradedFrom !== undefined ? `（首选 ${res.degradedFrom} 不可用，已降级）` : ''}`);
    } catch (err) {
      toast.error(`试听失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewing(false);
    }
  };

  /**
   * 供应商选择按钮。候选（MiMo）与稳定两家共用同一个按钮形态，但多一个「限免」角标与候选提示，
   * 避免任何人把它误读成「可以默认依赖」。
   */
  const renderProviderPick = (kind: CommercialTtsProvider): React.JSX.Element => {
    const on = commercial === kind;
    const status = providers.find((p) => p.kind === kind);
    const ready = status?.available === true;
    const candidate = (CANDIDATE_TTS_PROVIDERS as readonly CommercialTtsProvider[]).includes(kind);
    return (
      <button
        key={kind}
        type="button"
        data-voice-commercial-pick={kind}
        data-voice-commercial-candidate={candidate ? 'true' : 'false'}
        aria-pressed={on}
        onClick={() => pickCommercial(kind)}
        title={candidate ? `${status?.detail ?? '尚未探测'} · ${MIMO_TTS_CANDIDATE_NOTICE}` : (status?.detail ?? '尚未探测')}
        className="rounded-full px-2.5 py-0.5 font-semibold transition"
        style={{
          border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}`,
          background: on ? 'var(--blue-dim)' : 'var(--inset)',
          color: on ? 'var(--blue)' : 'var(--text-2)',
        }}
      >
        {providerLabel(kind)}
        <span style={{ color: ready ? 'var(--green)' : 'var(--red, #c0392b)', fontWeight: 500 }}>
          {' '}· {status === undefined ? '未探测' : ready ? '可用' : '未配置'}
        </span>
        {candidate && <span style={{ color: 'var(--amber)', fontWeight: 500 }}> · 限免</span>}
      </button>
    );
  };

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

      <div className="mb-4 rounded-2xl p-3.5" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }} data-voice-engine-tier={tier}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <Timer size={12} style={{ color: 'var(--amber)' }} />
            语音引擎档位（item 10 本机实测）
            <span className={`pill ${offline ? 'pill-amber' : 'pill-blue'}`} style={{ fontSize: 10 }} data-voice-engine-tier-label>
              {offline ? '离线档（本地引擎）' : '默认档（商业 API）'}
            </span>
          </span>
          <button
            type="button"
            className={`sw${offline ? ' on' : ''}`}
            aria-pressed={offline}
            data-voice-offline-toggle
            aria-label="切换到离线档（本地引擎）"
            onClick={toggleTier}
          />
        </div>
        <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-2)' }} data-voice-engine-tier-hint>
          {offline
            ? `离线档由你主动选择：不联网、不走商业 API。代价是本机实测 ${OFFLINE_TIER_COST_TEXT}；随时可以关掉切回默认档。`
            : `默认档走商业 API。本地引擎即使装好也不会自动优先——本机实测它 ${OFFLINE_TIER_COST_TEXT}，只能在需要离线时用上面的开关主动切过去。`}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--text-2)' }} data-voice-local-worker={localWorker === null ? 'unknown' : localWorker.available ? (localWorker.degraded ? 'degraded' : 'real') : 'offline'}>
          <span className="flex items-center gap-1.5">
            <span className={`pill ${workerTone}`} style={{ fontSize: 10 }}>{workerLabel}</span>
            本地 Audio Worker
          </span>
          <span>情绪 TTS：{emotionLabel}</span>
          <span className="truncate" title={workerDetail} style={{ color: 'var(--text-3)' }}>{workerDetail}</span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t pt-2.5 text-[11px]" style={{ borderColor: 'var(--stroke)', color: 'var(--text-2)' }} data-voice-commercial-provider={commercial}>
          <span className="font-semibold" style={{ color: 'var(--text-3)' }}>默认档用哪一家：</span>
          {COMMERCIAL_TTS_PROVIDERS.map(renderProviderPick)}
          <span className="font-semibold" style={{ color: 'var(--text-3)' }} data-voice-commercial-candidates>
            候选（可试听，不做默认）：
          </span>
          {CANDIDATE_TTS_PROVIDERS.map(renderProviderPick)}
          <button
            type="button"
            data-voice-commercial-preview
            disabled={previewing}
            onClick={() => void previewVoice()}
            className="rounded-full px-2.5 py-0.5 font-semibold"
            style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
          >
            {previewing ? '合成中…' : '试听一句'}
          </button>
          {!commercialChoice.honored && (
            <span data-voice-commercial-fallback style={{ color: 'var(--amber)' }}>{commercialChoice.reason}</span>
          )}
        </div>
        {(CANDIDATE_TTS_PROVIDERS as readonly CommercialTtsProvider[]).includes(commercial) && (
          <p className="mt-1 text-[10.5px]" style={{ color: 'var(--amber)' }} data-voice-commercial-candidate-notice>
            {MIMO_TTS_CANDIDATE_NOTICE}
          </p>
        )}
      </div>

      {tab === 'catalog'
        ? <VoicePanel bare characterName={characterName} boundVoiceId={boundVoiceId} onBind={bind} />
        : <VoiceStudioPanel bare characterId={characterId} characterName={characterName} />}
    </div>
  );
}
