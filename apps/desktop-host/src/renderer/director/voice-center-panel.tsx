/**
 * 「声音与表演」中控台外壳（声音工坊 2.0 · Tidepaper v3.1 重设计）
 *
 * 架构原则（docs/design/voice-studio-redesign.md）：
 * - 统一 PageHead + 紧凑单行状态在场条 + 9 角色快切条，彻底消除两屏堆叠的配置墙
 * - 5 个职责纯粹的专注工作台页签：
 *   1. `voices`（默认）：声线库与版本档案（出厂 / AI 设计定格 / 克隆声线 / MiMo 9 内置）
 *   2. `workshop`：AI 音色设计台（配方拨盘 + 批量候选 + 真实波形 + A/B 对比 + 4 情绪试戴 + 命名定格）
 *   3. `clone`：音色克隆台（多格式拖拽上传 / 麦克风录制 + 波形裁剪 + 真实声学质检 + 声音权属门禁）
 *   4. `studio`：表演与精调（5 情绪实时试听 + 真实口型 Viseme 轨道 + 桌宠发声 + 9 角色绑定 + RVC）
 *   5. `engine`：引擎 · 路由与凭据（引擎档位 + 供应商路由 + AudioMixer 多轨/OBS 路由 + 加密钥匙串）
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AudioLines, KeyRound, Lock, Mic, Radio, Sliders, Sparkles, Volume2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  OFFLINE_TIER_COST_TEXT,
  type AudioMixerSnapshot,
  type AudioTrackKind,
  type CommercialTtsProvider,
  type VoiceEngineTier,
  type VoiceProviderStatus,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';
import { resolveCommercialTtsProvider } from '@workbench/voice-runtime/browser';
import type { CharacterSummary } from './bridge';
import { PageHead } from './shell/page-head';
import { LicenseBadge } from './v2/signature-widgets';
import { VOICE_CREDENTIALS, VoiceEngineTab } from './voice/voice-engine-tab';
import { VoiceLibraryTab } from './voice/voice-library-tab';
import { VoiceDesignTab } from './voice/voice-design-tab';
import { VoiceCloneTab } from './voice/voice-clone-tab';
import { VoicePerformanceTab } from './voice/voice-performance-tab';

type VoiceTab = 'voices' | 'workshop' | 'clone' | 'studio' | 'engine';

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
  onOpenSongConsole?: () => void;
}): React.JSX.Element {
  const { characters, characterId, onSelectCharacter, onOpenSongConsole } = props;
  const [tab, setTab] = useState<VoiceTab>('voices');
  const [workshop, setWorkshop] = useState<VoiceWorkshopState | null>(null);
  const [bindings, setBindings] = useState<BindingView[]>([]);
  const [backend, setBackend] = useState<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null>(null);
  const [sfx, setSfx] = useState({ enabled: true, volume: 0.7 });
  const [speaker, setSpeaker] = useState<{ name: string | null; state: 'speaking' | 'idle' }>({ name: null, state: 'idle' });
  const [tier, setTier] = useState<VoiceEngineTier>('commercial_default');
  const [providers, setProviders] = useState<VoiceProviderStatus[]>([]);
  const [mixer, setMixer] = useState<AudioMixerSnapshot | null>(null);
  const [commercial, setCommercial] = useState<CommercialTtsProvider>('mimo-tts-voiceclone');
  const [openRouterModel, setOpenRouterModel] = useState('google/gemini-3.8-flash-tts');
  const [mimoBuiltinVoice, setMimoBuiltinVoice] = useState<string>('mimo_default');
  const [previewingKey, setPreviewingKey] = useState<string | null>(null);
  const [credentialMasks, setCredentialMasks] = useState<Record<string, string>>({});

  const reloadWorkshop = useCallback((): void => {
    void window.directorBridge.v2VoiceWorkshopState().then(setWorkshop).catch(() => setWorkshop(null));
  }, []);

  const reloadBindings = useCallback((): void => {
    void window.directorBridge.voiceCharacterBindings().then(setBindings).catch(() => setBindings([]));
  }, []);

  const reloadCredentials = useCallback(async (): Promise<void> => {
    const entries = await Promise.all(VOICE_CREDENTIALS.map(async (credential) => {
      const res = await window.directorBridge.providerKeyMask(credential.id);
      return [credential.id, res.ok ? (res.mask ?? '') : ''] as const;
    }));
    setCredentialMasks(Object.fromEntries(entries));
  }, []);

  const refreshProviders = useCallback(async (): Promise<void> => {
    const list = await window.directorBridge.v2VoiceProviders().catch(() => []);
    setProviders(list);
  }, []);

  useEffect(() => {
    reloadWorkshop();
    reloadBindings();
    void reloadCredentials();
    void refreshProviders();
    void window.directorBridge.voiceBackend().then(setBackend).catch(() => setBackend(null));
    void window.directorBridge.v2VoiceMixerState().then(setMixer).catch(() => setMixer(null));
    void window.directorBridge.prefsGet().then((prefs) => {
      setSfx({ enabled: prefs.sfxEnabled ?? true, volume: prefs.sfxVolume ?? 0.7 });
      setTier(prefs.voiceEngineTier ?? 'commercial_default');
      setCommercial(prefs.voiceCommercialProvider ?? 'mimo-tts-voiceclone');
      setOpenRouterModel(prefs.voiceOpenRouterModel ?? 'google/gemini-3.8-flash-tts');
      setMimoBuiltinVoice(prefs.voiceMimoBuiltinVoice ?? 'mimo_default');
    }).catch(() => undefined);
  }, [reloadWorkshop, reloadBindings, reloadCredentials, refreshProviders]);

  useEffect(() => {
    window.directorBridge.onCoopSpeaker((event) => {
      setSpeaker({ name: event.state === 'speaking' ? event.speakerName : null, state: event.state });
    });
  }, []);

  const activeBinding = bindings.find((b) => b.characterId === characterId);
  const fallbackChar = characters.find((c) => c.id === characterId);
  const characterName = activeBinding?.displayName ?? fallbackChar?.displayName ?? '小鲸';
  const boundVoiceId = activeBinding?.voiceId ?? fallbackChar?.voiceId ?? '';
  const currentVersion = workshop?.versions.find((v) => v.id === workshop.currentVersionId) ?? null;
  const availableKinds = providers.filter((p) => p.available).map((p) => p.kind);
  const commercialChoice = resolveCommercialTtsProvider({ preference: commercial, available: availableKinds });

  const bindCharacterVoice = async (voiceId: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await window.directorBridge.voiceCharacterBind(characterId, voiceId);
    if (res.ok) reloadBindings();
    return res;
  };

  const toggleTier = (): void => {
    const next: VoiceEngineTier = tier === 'offline_preferred' ? 'commercial_default' : 'offline_preferred';
    setTier(next);
    void window.directorBridge.prefsSet({ voiceEngineTier: next });
    toast(next === 'offline_preferred' ? `已切到离线档：${OFFLINE_TIER_COST_TEXT}` : '已切回默认档：商业 API 优先');
  };

  const pickCommercial = (next: CommercialTtsProvider): void => {
    setCommercial(next);
    void window.directorBridge.prefsSet({ voiceCommercialProvider: next });
  };

  const selectBuiltinVoice = (voice: string): void => {
    setMimoBuiltinVoice(voice);
    setCommercial('mimo-tts');
    void window.directorBridge.prefsSet({ voiceMimoBuiltinVoice: voice, voiceCommercialProvider: 'mimo-tts' });
    toast.success(`已切到 MiMo 官方内置音色：${voice}`);
  };

  const playPreview = async (key: string, text: string, preferredProvider?: CommercialTtsProvider, voiceRef?: string): Promise<void> => {
    setPreviewingKey(key);
    try {
      const res = await window.directorBridge.v2VoiceSynthesizePreview({
        text,
        ...(preferredProvider === undefined ? {} : { preferredProvider }),
        ...(voiceRef === undefined ? {} : { voiceRef }),
      });
      if (res.audioBase64 !== undefined) {
        const mime = res.format === 'mp3' ? 'audio/mpeg' : res.format === 'ogg' ? 'audio/ogg' : 'audio/wav';
        void new Audio(`data:${mime};base64,${res.audioBase64}`).play().catch(() => undefined);
      }
      toast.success(`试听已生成 · ${res.providerKind}${res.degraded && res.degradedFrom !== undefined ? `（已从 ${res.degradedFrom} 降级）` : ''}`);
    } catch (err) {
      toast.error(`试听失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewingKey(null);
    }
  };

  const speakOnPet = async (text: string, scene: 'normal' | 'inner' | 'p0' = 'normal'): Promise<void> => {
    try {
      const res = await window.directorBridge.voiceSpeak(text, scene);
      if (res.ok) toast.success('已发送至桌面桌宠播报');
      else toast.error(`桌宠播报失败：${res.error ?? '语音开关关闭或引擎未就绪'}`);
    } catch (err) {
      toast.error(`桌宠播报失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const updateSfx = (next: { enabled: boolean; volume: number }): void => {
    setSfx(next);
    void window.directorBridge.prefsSet({ sfxEnabled: next.enabled, sfxVolume: next.volume });
  };

  const updateOutputRoute = async (kind: AudioTrackKind, deviceId: string): Promise<void> => {
    try {
      const snap = await window.directorBridge.v2VoiceOutputRoute({ kind, deviceId });
      setMixer(snap);
      toast.success(`已更新 ${kind} 轨输出设备为 ${deviceId}`);
    } catch (err) {
      toast.error(`路由更新失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveCredential = async (providerId: string, draft: string): Promise<{ ok: boolean; notice: string }> => {
    try {
      const saved = await window.directorBridge.saveProviderKey(providerId, draft);
      if (!saved.ok) return { ok: false, notice: `保存失败：${saved.error ?? '未知错误'}` };
      await Promise.all([refreshProviders(), reloadCredentials()]);
      return { ok: true, notice: `已保存并重新探测（${saved.mask ?? '掩码已加密'}）` };
    } catch (err) {
      return { ok: false, notice: `保存失败：${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const backendLabel = backend === null ? '探测中…' : backend.backend === 'mcode' ? 'mcode 链' : backend.backend === 'say' ? 'macOS say 兜底' : '待适配';
  const backendTone = backend?.backend === 'mcode' ? 'pill-green' : backend?.backend === 'say' ? 'pill-amber' : 'pill-red';

  const characterList = (bindings.length > 0 ? bindings : characters.map((c) => ({
    characterId: c.id,
    displayName: c.displayName,
    voiceId: c.voiceId,
    defaultVoiceId: c.voiceId,
    overridden: false,
  }))).filter((b) => !b.characterId.startsWith('crosspet-'));

  return (
    <div className="mx-auto max-w-[1380px] pb-8" data-voice-center data-voice-tab={tab}>
      <PageHead
        eyebrow="Voice Identity · Design & Cloning Studio"
        eyebrowIcon={AudioLines}
        title="声音与表演"
        description="从 AI 音色设计、真人干声克隆到五情绪试戴与一致性质检——所有角色共享统一声线版本库、多轨混音与合规台账。"
        meta={
          <>
            <span className="pill pill-blue">
              当前声线：{currentVersion?.label ?? '读取中…'}
            </span>
            <span
              className={`pill ${backendTone}`}
              data-voice-backend={backend?.backend ?? 'unknown'}
              title={backend?.detail ?? '宿主语音链探测'}
            >
              <Radio size={10} />{backendLabel}
            </span>
            <button
              type="button"
              className={`pill ${commercialChoice.honored ? 'pill-green' : 'pill-amber'}`}
              onClick={() => setTab('engine')}
              title="点击配置 TTS 供应商与 API Key"
            >
              引擎：{commercial}{commercialChoice.honored ? '' : '（未配置凭据）'}
            </button>
            <span className={`pill ${speaker.state === 'speaking' ? 'pill-green' : ''}`} data-voice-lock-chip={speaker.state}>
              <Lock size={10} />{speaker.state === 'speaking' && speaker.name !== null ? `发言中：${speaker.name}` : '语音锁空闲'}
            </span>
            <LicenseBadge scope={currentVersion?.licenseScope ?? 'DEV_ONLY_NON_COMMERCIAL'} compact />
            <span className="pill mono" style={{ fontSize: 10 }}>
              会话合成 {workshop?.sessionCalls ?? 0} 次
            </span>
          </>
        }
        actions={
          <div className="seg-tabs" role="tablist" aria-label="声音工坊页签">
            <button type="button" role="tab" data-voice-tab-btn="voices" aria-selected={tab === 'voices'} className={`seg-tab${tab === 'voices' ? ' on' : ''}`} onClick={() => setTab('voices')}>
              <AudioLines size={12} />声线库
            </button>
            <button type="button" role="tab" data-voice-tab-btn="workshop" aria-selected={tab === 'workshop'} className={`seg-tab${tab === 'workshop' ? ' on' : ''}`} onClick={() => setTab('workshop')}>
              <Sparkles size={12} />音色设计
            </button>
            <button type="button" role="tab" data-voice-tab-btn="clone" aria-selected={tab === 'clone'} className={`seg-tab${tab === 'clone' ? ' on' : ''}`} onClick={() => setTab('clone')}>
              <Mic size={12} />音色克隆
            </button>
            <button type="button" role="tab" data-voice-tab-btn="studio" aria-selected={tab === 'studio'} className={`seg-tab${tab === 'studio' ? ' on' : ''}`} onClick={() => setTab('studio')}>
              <Sliders size={12} />表演与精调
            </button>
            <button type="button" role="tab" data-voice-tab-btn="engine" aria-selected={tab === 'engine'} className={`seg-tab${tab === 'engine' ? ' on' : ''}`} onClick={() => setTab('engine')}>
              <KeyRound size={12} />引擎与凭据
            </button>
          </div>
        }
      />

      {/* 紧凑 9 角色切换条（单行药丸，不挤占创作视口） */}
      <div
        className="mb-4 flex flex-wrap items-center gap-1.5 rounded-2xl px-3.5 py-2"
        style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }}
        data-voice-bind-bar
      >
        <span className="mr-1 flex items-center gap-1 text-[11px] font-semibold" style={{ color: 'var(--text-3)' }}>
          <Volume2 size={11} />配置角色：
        </span>
        {characterList.map((binding) => {
          const on = binding.characterId === characterId;
          return (
            <button
              key={binding.characterId}
              type="button"
              data-voice-char={binding.characterId}
              data-selected={on ? 'true' : 'false'}
              onClick={() => onSelectCharacter(binding.characterId)}
              className="rounded-full px-2.5 py-0.5 text-[11px] font-medium transition"
              style={{
                border: `1px solid ${on ? 'var(--accent-line)' : 'var(--stroke)'}`,
                background: on ? 'var(--accent-soft)' : 'var(--inset)',
                color: on ? 'var(--accent)' : 'var(--text-2)',
              }}
              title={`${binding.displayName} · ${binding.voiceId}${binding.overridden ? '（已改绑）' : '（角色包默认）'}`}
            >
              {binding.displayName}
            </button>
          );
        })}
      </div>

      {tab === 'voices' && (
        <VoiceLibraryTab
          characterName={characterName}
          workshop={workshop}
          commercial={commercial}
          mimoBuiltinVoice={mimoBuiltinVoice}
          previewingKey={previewingKey}
          onRefreshWorkshop={reloadWorkshop}
          onUpdateWorkshop={setWorkshop}
          onSelectBuiltin={selectBuiltinVoice}
          onPreviewBuiltin={(voice) => playPreview('builtin', `主人，我是${voice}，今天也请多关照。`, 'mimo-tts', voice)}
          onSwitchToTab={(next) => setTab(next)}
          onSpeakOnPet={(text) => speakOnPet(text, 'normal')}
        />
      )}

      {tab === 'workshop' && (
        <VoiceDesignTab
          workshop={workshop}
          onRefreshWorkshop={reloadWorkshop}
          onUpdateWorkshop={setWorkshop}
        />
      )}

      {tab === 'clone' && (
        <VoiceCloneTab
          onUpdateWorkshop={setWorkshop}
          onSwitchToLibrary={() => setTab('voices')}
        />
      )}

      {tab === 'studio' && (
        <VoicePerformanceTab
          characterId={characterId}
          characterName={characterName}
          boundVoiceId={boundVoiceId}
          commercial={commercial}
          onBindCharacterVoice={bindCharacterVoice}
          onSpeakOnPet={speakOnPet}
          {...(onOpenSongConsole === undefined ? {} : { onOpenSongConsole })}
        />
      )}

      {tab === 'engine' && (
        <VoiceEngineTab
          tier={tier}
          onToggleTier={toggleTier}
          commercial={commercial}
          onPickCommercial={pickCommercial}
          openRouterModel={openRouterModel}
          onOpenRouterModelChange={setOpenRouterModel}
          onOpenRouterModelCommit={() => {
            const next = openRouterModel.trim();
            if (next !== '') void window.directorBridge.prefsSet({ voiceOpenRouterModel: next });
          }}
          providers={providers}
          onRefreshProviders={refreshProviders}
          backend={backend}
          sfx={sfx}
          onUpdateSfx={updateSfx}
          speaker={speaker}
          mixer={mixer}
          onUpdateOutputRoute={updateOutputRoute}
          previewingKey={previewingKey}
          onPreviewRoute={() => playPreview('default', '主人，这是当前默认商业 TTS 路由的试听。', commercialChoice.provider)}
          credentialMasks={credentialMasks}
          onSaveCredential={saveCredential}
        />
      )}
    </div>
  );
}
