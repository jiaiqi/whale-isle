/**
 * 「声音与表演」中控台外壳（声音工坊 2.0 · Tidepaper v3.1 + 生产真闭环 + 统一吸底试听条）
 *
 * 架构特性：
 * - 统一 PageHead + 单行实时状态条 + 紧凑 9 角色快切条（展示每角色是否独立锁定声线）
 * - 5 个专注工作台页签：声线库 / 音色设计 / 音色克隆（含从 AI 设计直选）/ 表演与精调 / 引擎与凭据
 * - 全站单实例 StickyAuditionBar 互斥试听播放器（杜绝多音频叠播、不触发桌宠气泡与 OBS 直播）
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
  type VoiceCloudFallbackPolicy,
  type VoiceEngineTier,
  type VoiceProviderStatus,
  type VoiceTimbreVersion,
  type VoiceWorkshopCandidate,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';
import { resolveCommercialTtsProvider } from '@workbench/voice-runtime/browser';
import type { CharacterSummary } from './bridge';
import { PageHead } from './shell/page-head';
import { LicenseBadge } from './v2/signature-widgets';
import { AuditionPlayerProvider, StickyAuditionBar, useAuditionPlayer } from './voice/audition-player';
import { VOICE_CREDENTIALS, VoiceEngineTab } from './voice/voice-engine-tab';
import { VoiceLibraryTab } from './voice/voice-library-tab';
import { VoiceDesignTab } from './voice/voice-design-tab';
import { VoiceCloneTab, type PendingCloneAiSource } from './voice/voice-clone-tab';
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
  return (
    <AuditionPlayerProvider>
      <VoiceCenterInner {...props} />
    </AuditionPlayerProvider>
  );
}

function VoiceCenterInner(props: {
  characters: CharacterSummary[];
  characterId: string;
  onSelectCharacter: (id: string) => void;
  onOpenSongConsole?: () => void;
}): React.JSX.Element {
  const { characters, characterId, onSelectCharacter, onOpenSongConsole } = props;
  const player = useAuditionPlayer();

  const [tab, setTab] = useState<VoiceTab>('voices');
  const [workshop, setWorkshop] = useState<VoiceWorkshopState | null>(null);
  const [bindings, setBindings] = useState<BindingView[]>([]);
  const [backend, setBackend] = useState<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null>(null);
  const [sfx, setSfx] = useState({ enabled: true, volume: 0.7 });
  const [speaker, setSpeaker] = useState<{ name: string | null; state: 'speaking' | 'idle' }>({ name: null, state: 'idle' });
  const [tier, setTier] = useState<VoiceEngineTier>('commercial_default');
  const [fallbackPolicy, setFallbackPolicy] = useState<VoiceCloudFallbackPolicy>('subtitle_only');
  const [providers, setProviders] = useState<VoiceProviderStatus[]>([]);
  const [mixer, setMixer] = useState<AudioMixerSnapshot | null>(null);
  const [cacheStats, setCacheStats] = useState<{ entries: number; maxEntries: number; estimatedBytes: number; maxBytes: number } | null>(null);
  const [testingConnect, setTestingConnect] = useState(false);
  const [connectResult, setConnectResult] = useState<{ ok: boolean; providerKind: string; latencyMs: number; detail: string } | null>(null);
  const [commercial, setCommercial] = useState<CommercialTtsProvider>('mimo-tts-voiceclone');
  const [openRouterModel, setOpenRouterModel] = useState('google/gemini-3.8-flash-tts');
  const [mimoBuiltinVoice, setMimoBuiltinVoice] = useState<string>('mimo_default');
  const [previewingKey, setPreviewingKey] = useState<string | null>(null);
  const [credentialMasks, setCredentialMasks] = useState<Record<string, string>>({});
  const [pendingCloneSource, setPendingCloneSource] = useState<PendingCloneAiSource | null>(null);

  const reloadWorkshop = useCallback((): void => {
    void window.directorBridge.v2VoiceWorkshopState().then(setWorkshop).catch(() => setWorkshop(null));
  }, []);

  const reloadBindings = useCallback((): void => {
    void window.directorBridge.voiceCharacterBindings().then(setBindings).catch(() => setBindings([]));
  }, []);

  const reloadCacheStats = useCallback((): void => {
    void window.directorBridge.v2VoiceCacheStats().then(setCacheStats).catch(() => setCacheStats(null));
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
    reloadCacheStats();
    void reloadCredentials();
    void refreshProviders();
    void window.directorBridge.voiceBackend().then(setBackend).catch(() => setBackend(null));
    void window.directorBridge.v2VoiceMixerState().then(setMixer).catch(() => setMixer(null));
    void window.directorBridge.prefsGet().then((prefs) => {
      setSfx({ enabled: prefs.sfxEnabled ?? true, volume: prefs.sfxVolume ?? 0.7 });
      setTier(prefs.voiceEngineTier ?? 'commercial_default');
      setFallbackPolicy(prefs.voiceCloudFallbackPolicy ?? 'subtitle_only');
      setCommercial(prefs.voiceCommercialProvider ?? 'mimo-tts-voiceclone');
      setOpenRouterModel(prefs.voiceOpenRouterModel ?? 'google/gemini-3.8-flash-tts');
      setMimoBuiltinVoice(prefs.voiceMimoBuiltinVoice ?? 'mimo_default');
    }).catch(() => undefined);
  }, [reloadWorkshop, reloadBindings, reloadCacheStats, reloadCredentials, refreshProviders]);

  useEffect(() => {
    window.directorBridge.onCoopSpeaker((event) => {
      setSpeaker({ name: event.state === 'speaking' ? event.speakerName : null, state: event.state });
    });
  }, []);

  const activeBinding = bindings.find((b) => b.characterId === characterId);
  const fallbackChar = characters.find((c) => c.id === characterId);
  const characterName = activeBinding?.displayName ?? fallbackChar?.displayName ?? '小鲸';
  const boundVoiceId = activeBinding?.voiceId ?? fallbackChar?.voiceId ?? '';
  const charBoundVersionId = workshop?.characterBindings?.[characterId] ?? workshop?.currentVersionId ?? 'factory';
  const currentVersion = workshop?.versions.find((v) => v.id === charBoundVersionId) ?? workshop?.versions[0] ?? null;
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

  const changeFallbackPolicy = (next: VoiceCloudFallbackPolicy): void => {
    setFallbackPolicy(next);
    void window.directorBridge.prefsSet({ voiceCloudFallbackPolicy: next });
    toast(next === 'subtitle_only' ? '已设为：失败保留字幕、绝不静默换声（推荐）' : '已允许失败时显式回退本机 mcode/say');
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
      if (res.audioBase64 !== undefined && player !== null) {
        player.playTrack({
          id: `route-preview-${key}-${Date.now()}`,
          title: voiceRef !== undefined ? `内置音色 · ${voiceRef}` : `路由试听 · ${res.providerKind}`,
          sourceLabel: res.cached ? '路由试听 · 缓存' : '路由试听',
          subtitle: text,
          audioBase64: res.audioBase64,
          durationHintSec: res.durationMs / 1000,
        });
      }
      reloadCacheStats();
      toast.success(`试听已生成 · ${res.providerKind}${res.degraded && res.degradedFrom !== undefined ? `（已从 ${res.degradedFrom} 降级）` : ''}`);
    } catch (err) {
      toast.error(`试听失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewingKey(null);
    }
  };

  const runRealConnectTest = async (): Promise<void> => {
    setTestingConnect(true);
    try {
      const res = await window.directorBridge.v2VoiceRouterTest({
        preferredProvider: tier === 'offline_preferred' ? 'local-audio-worker' : commercialChoice.provider,
      });
      setConnectResult({
        ok: res.ok,
        providerKind: res.providerKind,
        latencyMs: res.latencyMs,
        detail: res.ok
          ? `真实合成成功（${res.durationMs ? `${(res.durationMs / 1000).toFixed(1)}s` : '已收到音频'}${res.cached ? ' · 命中缓存' : ''}）`
          : (res.error ?? '未知错误'),
      });
      if (res.ok && res.audioBase64 !== undefined && player !== null) {
        player.playTrack({
          id: `connect-test-${Date.now()}`,
          title: `连通测试 · ${res.providerKind}`,
          sourceLabel: '真实连通测试',
          subtitle: `耗时 ${res.latencyMs}ms`,
          audioBase64: res.audioBase64,
        });
      }
      reloadCacheStats();
    } catch (err) {
      setConnectResult({
        ok: false,
        providerKind: commercial,
        latencyMs: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingConnect(false);
    }
  };

  const clearCache = async (): Promise<void> => {
    const res = await window.directorBridge.v2VoiceCacheClear();
    setCacheStats(res.stats);
    toast.success(`已清空 ${res.cleared} 条合成缓存`);
  };

  const speakOnPet = async (text: string, scene: 'normal' | 'inner' | 'p0' = 'normal'): Promise<void> => {
    try {
      const res = await window.directorBridge.voiceSpeak(text, scene);
      if (res.ok) toast.success('已发送至桌面桌宠播报（走 V2 生产语音闭环）');
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

  const sendCandidateToClone = (candidate: VoiceWorkshopCandidate): void => {
    setPendingCloneSource({ kind: 'candidate', candidate });
    setTab('clone');
  };

  const sendVersionToClone = (version: VoiceTimbreVersion): void => {
    setPendingCloneSource({ kind: 'version', version });
    setTab('clone');
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
    <div className="mx-auto max-w-[1380px] pb-3" data-voice-center data-voice-tab={tab}>
      <PageHead
        eyebrow="Voice Identity · Design & Cloning Studio"
        eyebrowIcon={AudioLines}
        title="声音与表演"
        description="从 AI 音色设计、真人/AI 干声裁剪克隆到五情绪演绎与生产闭环——多角色版本锁定、统一互斥试听与完整合规台账。"
        meta={
          <>
            <span className="pill pill-blue">
              {characterName}：{currentVersion?.label ?? '读取中…'}
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
            <button type="button" role="tab" data-voice-tab-btn="voices" aria-selected={tab === 'voices'} className={`seg-tab${tab === 'voices' ? ' on' : ''}`} onClick={() => { setTab('voices'); reloadWorkshop(); }}>
              <AudioLines size={12} />声线库
            </button>
            <button type="button" role="tab" data-voice-tab-btn="workshop" aria-selected={tab === 'workshop'} className={`seg-tab${tab === 'workshop' ? ' on' : ''}`} onClick={() => { setTab('workshop'); reloadWorkshop(); }}>
              <Sparkles size={12} />音色设计
            </button>
            <button type="button" role="tab" data-voice-tab-btn="clone" aria-selected={tab === 'clone'} className={`seg-tab${tab === 'clone' ? ' on' : ''}`} onClick={() => { setTab('clone'); reloadWorkshop(); }}>
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

      {/* 紧凑角色切换条（不硬编码数量，展示每个角色是否独立锁定声线） */}
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
          const lockedId = workshop?.characterBindings?.[binding.characterId];
          const lockedLabel = lockedId !== undefined ? workshop?.versions.find((v) => v.id === lockedId)?.label : undefined;
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
              title={`${binding.displayName} · ${lockedLabel !== undefined ? `已锁定：${lockedLabel}` : binding.voiceId}`}
            >
              {binding.displayName}
              {lockedLabel !== undefined && <span className="ml-1 opacity-75">· 锁</span>}
            </button>
          );
        })}
      </div>

      {tab === 'voices' && (
        <VoiceLibraryTab
          characterId={characterId}
          characterName={characterName}
          characters={characters}
          workshop={workshop}
          commercial={commercial}
          mimoBuiltinVoice={mimoBuiltinVoice}
          previewingKey={previewingKey}
          onRefreshWorkshop={reloadWorkshop}
          onUpdateWorkshop={(next) => { setWorkshop(next); reloadCacheStats(); }}
          onSelectBuiltin={selectBuiltinVoice}
          onPreviewBuiltin={(voice) => playPreview('builtin', `主人，我是${voice}，今天也请多关照。`, 'mimo-tts', voice)}
          onSwitchToTab={(next) => setTab(next)}
          onSendVersionToClone={sendVersionToClone}
          onSpeakOnPet={(text) => speakOnPet(text, 'normal')}
        />
      )}

      {tab === 'workshop' && (
        <VoiceDesignTab
          characterName={characterName}
          workshop={workshop}
          onRefreshWorkshop={reloadWorkshop}
          onUpdateWorkshop={(next) => { setWorkshop(next); reloadCacheStats(); }}
          onSendCandidateToClone={sendCandidateToClone}
        />
      )}

      {tab === 'clone' && (
        <VoiceCloneTab
          characterId={characterId}
          characterName={characterName}
          workshop={workshop}
          pendingAiSource={pendingCloneSource}
          onClearPendingAiSource={() => setPendingCloneSource(null)}
          onUpdateWorkshop={(next) => { setWorkshop(next); reloadCacheStats(); }}
          onSwitchToLibrary={() => setTab('voices')}
          onSwitchToDesign={() => setTab('workshop')}
        />
      )}

      {tab === 'studio' && (
        <VoicePerformanceTab
          characterId={characterId}
          characterName={characterName}
          activeVersionLabel={currentVersion?.label ?? '出厂默认'}
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
          fallbackPolicy={fallbackPolicy}
          onChangeFallbackPolicy={changeFallbackPolicy}
          cacheStats={cacheStats}
          onClearCache={clearCache}
          onRunRealConnectTest={runRealConnectTest}
          testingConnect={testingConnect}
          connectResult={connectResult}
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

      {/* 底部统一吸底试听播放器（单通道互斥、与正式发声租约隔离） */}
      <StickyAuditionBar />
    </div>
  );
}
