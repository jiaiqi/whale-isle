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
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, KeyRound, Lock, Radio, Sliders, Sparkles, Timer, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  MIMO_TIMBRE_PRESETS,
  MIMO_TTS_CANDIDATE_NOTICE,
  OFFLINE_TIER_COST_TEXT,
  type CommercialTtsProvider,
  type VoiceEngineTier,
  type VoiceProviderStatus,
} from '@workbench/shared-protocol';
import { CANDIDATE_TTS_PROVIDERS, COMMERCIAL_TTS_PROVIDERS, MIMO_TTS_BUILTIN_VOICES, resolveCommercialTtsProvider } from '@workbench/voice-runtime/browser';
import type { CharacterSummary } from './bridge';
import { VoiceDesignLab } from './voice-design-lab';
import { VoicePanel } from './voice-panel';
import { VoiceStudioPanel } from './voice-studio-panel';

/** 语音中心的凭据卡片：providerId 必须与主进程 `kernel.secrets.resolve(...)` 查的 id 完全一致 */
const VOICE_CREDENTIALS = [
  { id: 'mimo-tts', label: '小米 MiMo（主力）', unlocks: '内置音色 / VoiceClone / VoiceDesign（三种模式共用一个 Key）' },
  { id: 'minimax', label: 'MiniMax T2A（已停用）', unlocks: '额度耗尽，已停用，可自行填入凭据恢复（provider 代码保留）' },
  { id: 'openai-tts', label: 'OpenAI 兼容 TTS', unlocks: '备用稳定档 openai-compatible-tts' },
  { id: 'openrouter', label: 'OpenRouter', unlocks: '候选 openrouter-tts（Gemini 3.8 Flash TTS，按 token 计费）' },
] as const;

type CloneSampleInfo = { exists: boolean; bytes: number; durationMs: number | null };

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
  const [tab, setTab] = useState<'catalog' | 'design' | 'studio'>('catalog');
  const [bindings, setBindings] = useState<BindingView[]>([]);
  const [backend, setBackend] = useState<{ backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null>(null);
  const [sfx, setSfx] = useState({ enabled: true, volume: 0.7 });
  const [speaker, setSpeaker] = useState<{ name: string | null; state: 'speaking' | 'idle' }>({ name: null, state: 'idle' });
  const [tier, setTier] = useState<VoiceEngineTier>('commercial_default');
  const [providers, setProviders] = useState<VoiceProviderStatus[]>([]);
  const [commercial, setCommercial] = useState<CommercialTtsProvider>('mimo-tts');
  const [openRouterModel, setOpenRouterModel] = useState('google/gemini-3.8-flash-tts');
  const [mimoBuiltinVoice, setMimoBuiltinVoice] = useState<string>('mimo_default');
  const [previewingKey, setPreviewingKey] = useState<string | null>(null);
  const [cloneInfo, setCloneInfo] = useState<CloneSampleInfo | null>(null);
  const [reference, setReference] = useState<{
    exists: boolean; bytes: number; durationMs: number | null;
    timbreId: string; label: string; description: string; source: string;
  } | null>(null);
  const [cloneBusy, setCloneBusy] = useState(false);
  const cloneInputRef = useRef<HTMLInputElement | null>(null);
  /** 凭据掩码（只存掩码，明文只在输入框里停留到保存成功为止） */
  const [credentialMasks, setCredentialMasks] = useState<Record<string, string>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyNotices, setKeyNotices] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);

  const reloadBindings = useCallback((): void => {
    void window.directorBridge.voiceCharacterBindings().then(setBindings).catch(() => setBindings([]));
  }, []);

  useEffect(() => { reloadBindings(); }, [reloadBindings]);

  const reloadCredentials = useCallback(async (): Promise<void> => {
    const entries = await Promise.all(VOICE_CREDENTIALS.map(async (credential) => {
      const res = await window.directorBridge.providerKeyMask(credential.id);
      return [credential.id, res.ok ? (res.mask ?? '') : ''] as const;
    }));
    setCredentialMasks(Object.fromEntries(entries));
  }, []);

  useEffect(() => { void reloadCredentials(); }, [reloadCredentials]);

  useEffect(() => {
    void window.directorBridge.v2VoiceCloneSampleInfo().then(setCloneInfo).catch(() => setCloneInfo(null));
    void window.directorBridge.v2VoiceReferenceInfo().then(setReference).catch(() => setReference(null));
  }, []);

  useEffect(() => {
    void window.directorBridge.voiceBackend().then(setBackend).catch(() => setBackend(null));
    void window.directorBridge.prefsGet().then((prefs) => {
      setSfx({ enabled: prefs.sfxEnabled ?? true, volume: prefs.sfxVolume ?? 0.7 });
      setTier(prefs.voiceEngineTier ?? 'commercial_default');
      setCommercial(prefs.voiceCommercialProvider ?? 'mimo-tts');
      setOpenRouterModel(prefs.voiceOpenRouterModel ?? 'google/gemini-3.8-flash-tts');
      setMimoBuiltinVoice(prefs.voiceMimoBuiltinVoice ?? 'mimo_default');
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
        : kind === 'openrouter-tts'
          ? 'OpenRouter Gemini TTS'
          : kind === 'mimo-tts'
            ? 'MiMo 内置音色'
            : kind === 'mimo-tts-voiceclone'
              ? 'MiMo VoiceClone'
              : 'MiMo VoiceDesign';

  const pickCommercial = (next: CommercialTtsProvider): void => {
    setCommercial(next);
    void window.directorBridge.prefsSet({ voiceCommercialProvider: next });
  };

  /**
   * 保存并检测：走已有的 `providers:save-key`（safeStorage 加密的 provider-vault.json），
   * 明文只上行、不回显、不落渲染层；成功后立刻重探所有 provider，让 available / detail 反映新 Key。
   */
  const saveCredential = async (providerId: string): Promise<void> => {
    const draft = (keyDrafts[providerId] ?? '').trim();
    if (draft === '') {
      setKeyNotices((prev) => ({ ...prev, [providerId]: '请先粘贴访问凭据（Key）' }));
      return;
    }
    setKeyBusy(providerId);
    setKeyNotices((prev) => ({ ...prev, [providerId]: '保存中…' }));
    try {
      const saved = await window.directorBridge.saveProviderKey(providerId, draft);
      if (!saved.ok) {
        setKeyNotices((prev) => ({ ...prev, [providerId]: `保存失败：${saved.error ?? '未知错误'}` }));
        return;
      }
      setKeyDrafts((prev) => ({ ...prev, [providerId]: '' }));
      const [statuses] = await Promise.all([window.directorBridge.v2VoiceProviders(), reloadCredentials()]);
      setProviders(statuses);
      setKeyNotices((prev) => ({ ...prev, [providerId]: `已保存并重新探测（${saved.mask ?? '掩码不可读'}）` }));
    } catch (err) {
      setKeyNotices((prev) => ({ ...prev, [providerId]: `保存失败：${err instanceof Error ? err.message : String(err)}` }));
    } finally {
      setKeyBusy(null);
    }
  };

  /** Key 来源：凭据库（有掩码）> 环境变量（探针可用但库里没有）> 未配置 */
  const credentialSource = (providerId: string, available: boolean): '凭据库' | '环境变量' | '未配置' => {
    if ((credentialMasks[providerId] ?? '') !== '') return '凭据库';
    return available ? '环境变量' : '未配置';
  };
  const credentialAvailable = (providerId: string): boolean => {
    if (providerId === 'mimo-tts') {
      return providers.some((p) => p.kind.startsWith('mimo-tts') && p.available);
    }
    const kind = providerId === 'minimax'
      ? 'minimax-tts'
      : providerId === 'openai-tts'
        ? 'openai-compatible-tts'
        : 'openrouter-tts';
    return providers.some((p) => p.kind === kind && p.available);
  };

  /**
   * 统一试听入口：`key` 只用于按钮忙碌态；voiceRef 覆盖音色（内置音色逐个试听），
   * 不传就按角色当前声线走路由。合成失败的报错原样透出，不做静默降级伪装。
   */
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
      toast.success(`试听已生成 · ${res.providerKind}${res.degraded && res.degradedFrom !== undefined ? `（首选 ${res.degradedFrom} 不可用，已降级）` : ''}`);
    } catch (err) {
      toast.error(`试听失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewingKey(null);
    }
  };
  const previewVoice = (): Promise<void> =>
    playPreview('default', '[嘴甜常态] 主人，这是默认档商业 TTS 的试听。', commercialChoice.provider);

  /** 内置音色：选中即切默认档到 mimo-tts，并把内置音色 id 写进 prefs（主进程每次合成重读，无需重启） */
  const selectBuiltinVoice = (voice: string): void => {
    setMimoBuiltinVoice(voice);
    setCommercial('mimo-tts');
    void window.directorBridge.prefsSet({ voiceMimoBuiltinVoice: voice, voiceCommercialProvider: 'mimo-tts' });
  };

  const uploadCloneSample = async (file: File): Promise<void> => {
    setCloneBusy(true);
    try {
      const info = await window.directorBridge.v2VoiceCloneSampleSave(window.directorBridge.pathForFile(file));
      setCloneInfo(info);
      toast.success(`参考音频已保存（${(info.bytes / 1024).toFixed(0)} KB）`);
    } catch (err) {
      toast.error(`保存参考音频失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCloneBusy(false);
    }
  };

  /** 声线库试听：走 VoiceDesign 预览（描述现场合成），听到的是「这条描述长什么样」 */
  const playTimbrePreview = async (timbre: { id: string; label: string; description: string }): Promise<void> => {
    setPreviewingKey(`timbre-${timbre.id}`);
    try {
      const res = await window.directorBridge.v2VoiceDesignPreview({
        text: '主人，今天也辛苦啦，我给你倒杯热茶好不好呀。',
        voiceDescription: timbre.description,
      });
      if (res.audioBase64 !== undefined) {
        const mime = res.format === 'mp3' ? 'audio/mpeg' : res.format === 'ogg' ? 'audio/ogg' : 'audio/wav';
        void new Audio(`data:${mime};base64,${res.audioBase64}`).play().catch(() => undefined);
      }
      toast.success(`${timbre.label} 试听已生成 · ${res.providerKind}`);
    } catch (err) {
      toast.error(`${timbre.label} 试听失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewingKey(null);
    }
  };

  /**
   * 声线库「锁定」：用该描述现场合成一条参考音频（VoiceDesign），落成克隆参考，再把默认档切到 clone 档。
   * 合成失败如实报错，不写半成品参考。
   */
  const lockTimbre = async (timbre: { id: string; label: string; description: string }): Promise<void> => {
    setPreviewingKey(`lock-${timbre.id}`);
    try {
      const info = await window.directorBridge.v2VoiceReferenceGenerate({ description: timbre.description });
      setCloneInfo({ exists: info.exists, bytes: info.bytes, durationMs: info.durationMs });
      await window.directorBridge.v2VoiceIdentityUpdate({
        voiceDescription: timbre.description,
        preferredProviderId: 'mimo-tts-voiceclone',
      });
      await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voiceclone' });
      toast.success(`已锁定 ${timbre.label}：生成参考音频 ${(info.bytes / 1024).toFixed(0)} KB，默认档切到 VoiceClone`);
    } catch (err) {
      toast.error(`锁定 ${timbre.label} 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewingKey(null);
    }
  };

  /** 把声线库预设设为桌宠声线：写角色 VoiceIdentity（描述 + clone 档）+ 切默认档，主进程每次合成重读 */
  const bindReferenceVoice = async (): Promise<void> => {
    if (reference === null) return;
    try {
      await window.directorBridge.v2VoiceIdentityUpdate({
        voiceDescription: reference.description,
        preferredProviderId: 'mimo-tts-voiceclone',
      });
      await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voiceclone' });
      toast.success(`已设为桌宠声线：${reference.label}（走 VoiceClone，参考音频 ${cloneInfo?.exists === true ? '是你上传的那条' : '是随包基准'}）`);
    } catch (err) {
      toast.error(`设为声线失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const clearCloneSample = async (): Promise<void> => {
    try {
      const info = await window.directorBridge.v2VoiceCloneSampleClear();
      setCloneInfo(info);
      if (commercial === 'mimo-tts-voiceclone') pickCommercial('mimo-tts');
      toast.success('已清除参考音频，默认档回到 MiMo 内置音色');
    } catch (err) {
      toast.error(`清除失败：${err instanceof Error ? err.message : String(err)}`);
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
    /**
     * 「候选」与「限时免费」是两件事：候选 = 不进自动兜底链；限免只适用于 MiMo（官方标价限时免费）。
     * OpenRouter 是候选但按 token 计费（$0.50/M 入 · $9/M 出），挂「限免」属于错标。
     */
    const limitedFree = kind.startsWith('mimo-');
    return (
      <button
        key={kind}
        type="button"
        data-voice-commercial-pick={kind}
        data-voice-commercial-candidate={candidate ? 'true' : 'false'}
        aria-pressed={on}
        onClick={() => pickCommercial(kind)}
        title={limitedFree ? `${status?.detail ?? '尚未探测'} · ${MIMO_TTS_CANDIDATE_NOTICE}` : (status?.detail ?? '尚未探测')}
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
        {limitedFree && <span style={{ color: 'var(--amber)', fontWeight: 500 }}> · 限免</span>}
        {candidate && !limitedFree && <span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · 候选</span>}
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
          <button type="button" role="tab" data-voice-tab-btn="design" aria-selected={tab === 'design'} className={`seg-tab${tab === 'design' ? ' on' : ''}`} onClick={() => setTab('design')}>
            <Sparkles size={12} />音色设计
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

        <div className="mt-2.5 grid gap-2 border-t pt-2.5" style={{ borderColor: 'var(--stroke)' }} data-voice-commercial-provider={commercial}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <span className="font-semibold" style={{ color: 'var(--text-3)' }}>声线来源（小米 MiMo 为主：一个 Key、三个模型）</span>
            <span data-voice-commercial-current style={{ color: 'var(--text-3)' }}>
              当前默认档：{providerLabel(commercial)}
              {commercialChoice.honored ? '' : `（${commercialChoice.reason}）`}
            </span>
          </div>
          <section className="rounded-xl p-2.5" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-voice-timbre-library>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold">
              <span>声线库<span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · owner 定稿四条 · 默认 07 黏糊·调皮</span></span>
              <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>
                「锁定」会用这条描述现场生成一条参考音频，再走 VoiceClone 锁声线（每次一次 API 调用）
              </span>
            </div>
            <p className="mt-1 text-[10px]" style={{ color: 'var(--amber)' }} data-voice-timbre-notice>
              07 是当前默认声线，但 owner 听过锁定版后判定「音色不对味」；02 / 08 / 12 为待选候选。
              等 owner 听定一条再做一次性切换，现在不要当最终版。
            </p>
            <div className="mt-1.5 grid gap-1">
              {MIMO_TIMBRE_PRESETS.map((timbre) => (
                <div key={timbre.id} className="flex flex-wrap items-center gap-1.5" data-voice-timbre={timbre.id}>
                  <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-2)' }}>{timbre.label}</span>
                  {timbre.isDefault
                    ? <span className="pill pill-blue" style={{ fontSize: 10 }}>默认 · 待复核</span>
                    : <span className="pill" style={{ fontSize: 10 }}>候选</span>}
                  <span className="truncate text-[10px]" style={{ color: 'var(--text-3)' }} title={timbre.description}>{timbre.description}</span>
                  <button
                    type="button"
                    data-voice-timbre-preview={timbre.id}
                    disabled={previewingKey !== null}
                    onClick={() => void playTimbrePreview(timbre)}
                    className="rounded-full px-2 py-0.5 text-[10.5px]"
                    style={{ color: 'var(--text-3)' }}
                  >
                    {previewingKey === `timbre-${timbre.id}` ? '合成中…' : '试听'}
                  </button>
                  <button
                    type="button"
                    data-voice-timbre-lock={timbre.id}
                    disabled={previewingKey !== null}
                    onClick={() => void lockTimbre(timbre)}
                    className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                    style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                  >
                    {previewingKey === `lock-${timbre.id}` ? '生成中…' : '锁定为声线'}
                  </button>
                </div>
              ))}
            </div>
          </section>
          <div className="grid gap-2 md:grid-cols-3">
            <section className="rounded-xl p-2.5" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-voice-voice-source="builtin">
              <div className="flex items-center justify-between text-[11px] font-semibold">
                <span>内置音色<span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · 官方九选一</span></span>
                <span className="pill pill-green" style={{ fontSize: 10 }}>固定声线零漂移</span>
              </div>
              <p className="mt-1 text-[10px]" style={{ color: 'var(--text-3)' }}>选中即写入默认档并切到 mimo-tts，不用重启。</p>
              <div className="mt-1.5 flex flex-wrap gap-1" data-voice-mimo-builtin-grid>
                {MIMO_TTS_BUILTIN_VOICES.map((voice) => {
                  const on = mimoBuiltinVoice === voice && commercial === 'mimo-tts';
                  return (
                    <button
                      key={voice}
                      type="button"
                      data-voice-mimo-builtin={voice}
                      aria-pressed={on}
                      onClick={() => selectBuiltinVoice(voice)}
                      className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                      style={{
                        border: `1px solid ${on ? 'var(--blue-line)' : 'var(--stroke)'}`,
                        background: on ? 'var(--blue-dim)' : 'var(--surface)',
                        color: on ? 'var(--blue)' : 'var(--text-2)',
                      }}
                    >
                      {voice}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                data-voice-mimo-builtin-preview
                disabled={previewingKey !== null}
                onClick={() => void playPreview('builtin', '主人，我是' + mimoBuiltinVoice + '，今天也请多关照。', 'mimo-tts', mimoBuiltinVoice)}
                className="mt-1.5 w-full rounded-lg px-2 py-1 text-[10.5px] font-semibold"
                style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
              >
                {previewingKey === 'builtin' ? '合成中…' : `试听 ${mimoBuiltinVoice}`}
              </button>
            </section>

            <section className="rounded-xl p-2.5" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-voice-voice-source="clone">
              <div className="flex items-center justify-between text-[11px] font-semibold">
                <span>克隆声线<span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · 自己的参考音频</span></span>
                <span className="pill pill-amber" style={{ fontSize: 10 }}>需人工挑参考</span>
              </div>
              <p className="mt-1 text-[10px]" data-voice-clone-status style={{ color: cloneInfo?.exists === true ? 'var(--text-2)' : 'var(--text-3)' }}>
                {cloneInfo === null
                  ? '读取参考音频状态…'
                  : cloneInfo.exists
                    ? `当前用你上传的参考音频：${(cloneInfo.bytes / 1024).toFixed(0)} KB${cloneInfo.durationMs !== null ? ` · ${(cloneInfo.durationMs / 1000).toFixed(1)}s` : ''}`
                    : reference?.exists === true
                      ? `当前用随包基准（小鲸声线）：${(reference.bytes / 1024).toFixed(0)} KB${reference.durationMs !== null ? ` · ${(reference.durationMs / 1000).toFixed(1)}s` : ''}`
                      : '未上传参考音频（只收本地 .wav，RIFF 校验 + 20MB 上限）'}
              </p>
              {reference !== null && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1" data-voice-reference-preset>
                  <span className="text-[10px] font-semibold" style={{ color: 'var(--text-3)' }}>声线库预设</span>
                  <button
                    type="button"
                    data-voice-reference-bind={reference.timbreId}
                    disabled={reference.exists !== true}
                    onClick={() => void bindReferenceVoice()}
                    className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                    style={{
                      border: `1px solid ${commercial === 'mimo-tts-voiceclone' ? 'var(--blue-line)' : 'var(--stroke)'}`,
                      background: commercial === 'mimo-tts-voiceclone' ? 'var(--blue-dim)' : 'var(--surface)',
                      color: commercial === 'mimo-tts-voiceclone' ? 'var(--blue)' : 'var(--text-2)',
                    }}
                    title={reference.source}
                  >
                    {reference.label}
                  </button>
                  <button
                    type="button"
                    data-voice-reference-preview
                    disabled={previewingKey !== null || reference.exists !== true}
                    onClick={() => void playPreview('reference', '主人，这条就是小鲸以后的声线了，你听习惯了吗？', 'mimo-tts-voiceclone')}
                    className="rounded-full px-2 py-0.5 text-[10.5px]"
                    style={{ color: 'var(--text-3)' }}
                  >
                    {previewingKey === 'reference' ? '合成中…' : '试听'}
                  </button>
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1">
                <input
                  ref={cloneInputRef}
                  type="file"
                  accept=".wav,audio/wav"
                  data-voice-clone-upload-input
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file !== undefined) void uploadCloneSample(file);
                  }}
                />
                <button
                  type="button"
                  data-voice-clone-upload
                  disabled={cloneBusy}
                  onClick={() => cloneInputRef.current?.click()}
                  className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                >
                  {cloneBusy ? '保存中…' : cloneInfo?.exists === true ? '换一条 wav' : '选择 wav'}
                </button>
                <button
                  type="button"
                  data-voice-clone-preview
                  disabled={previewingKey !== null || cloneInfo?.exists !== true}
                  onClick={() => void playPreview('clone', '主人，这条声线是照着我的录音克隆的，你听得出差别吗？', 'mimo-tts-voiceclone')}
                  className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                >
                  {previewingKey === 'clone' ? '合成中…' : '试听'}
                </button>
                <button
                  type="button"
                  data-voice-clone-bind
                  disabled={cloneInfo?.exists !== true || commercial === 'mimo-tts-voiceclone'}
                  onClick={() => {
                    pickCommercial('mimo-tts-voiceclone');
                    toast.success('已把默认档切到 MiMo VoiceClone：之后每次合成都用这条参考音频');
                  }}
                  className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                >
                  设为声线
                </button>
                {cloneInfo?.exists === true && (
                  <button
                    type="button"
                    data-voice-clone-clear
                    onClick={() => void clearCloneSample()}
                    className="rounded-full px-2 py-0.5 text-[10.5px]"
                    style={{ color: 'var(--text-3)' }}
                  >
                    清除
                  </button>
                )}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                实测（自产参考音频 ×10）：余弦均值 0.8342、最低 0.7500。样本小、只听余弦、未做听感盲测；限免服务无商用条款。
                <br />
                随包基准 = 声线库默认声线 07 黏糊·调皮（自产文本 + MiMo 生成，仅开发/内部用）。
              </p>
            </section>

            <section className="rounded-xl p-2.5" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-voice-voice-source="design">
              <div className="flex items-center justify-between text-[11px] font-semibold">
                <span>设计声线<span style={{ color: 'var(--text-3)', fontWeight: 500 }}> · 探索新音色</span></span>
                <span className="pill pill-amber" style={{ fontSize: 10 }}>漂移已实测</span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                一段自然语言描述生成声线。同一描述连跑 10 次说话人余弦最低 0.4145，不能直接当固定声线；
                路径是「出候选 → 人工挑一条 → 用那条音频走克隆锁死」。
              </p>
              <button
                type="button"
                data-voice-design-open
                onClick={() => setTab('design')}
                className="mt-1.5 w-full rounded-lg px-2 py-1 text-[10.5px] font-semibold"
                style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
              >
                打开音色设计台
              </button>
            </section>
          </div>
          <details className="rounded-xl px-2.5 py-1.5" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }} data-voice-commercial-backup>
            <summary className="cursor-pointer text-[11px] font-semibold" style={{ color: 'var(--text-3)' }}>备用供应商（不参与默认档，未来本地模型也走这里）</summary>
            <div className="mt-1.5 grid gap-1.5 text-[11px]" style={{ color: 'var(--text-2)' }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold" style={{ color: 'var(--text-3)' }}>稳定两家：</span>
                {COMMERCIAL_TTS_PROVIDERS.map(renderProviderPick)}
                <button
                  type="button"
                  data-voice-commercial-preview
                  disabled={previewingKey !== null}
                  onClick={() => void previewVoice()}
                  className="rounded-full px-2.5 py-0.5 font-semibold"
                  style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                >
                  {previewingKey === 'default' ? '合成中…' : '试听一句'}
                </button>
                {!commercialChoice.honored && (
                  <span data-voice-commercial-fallback style={{ color: 'var(--amber)' }}>{commercialChoice.reason}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold" style={{ color: 'var(--text-3)' }}>OpenRouter（候选 · 按 token 计费）：</span>
                {renderProviderPick('openrouter-tts')}
                <label className="flex items-center gap-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                  模型
                  <input
                    type="text"
                    data-voice-openrouter-model
                    value={openRouterModel}
                    onChange={(event) => setOpenRouterModel(event.target.value)}
                    onBlur={() => {
                      const next = openRouterModel.trim();
                      if (next !== '') void window.directorBridge.prefsSet({ voiceOpenRouterModel: next });
                    }}
                    className="w-64 rounded-lg px-1.5 py-0.5 outline-none"
                    style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-2)' }}
                    title="OpenRouter 上的 TTS 模型 id，保存后立即生效（默认 google/gemini-3.8-flash-tts）"
                  />
                </label>
              </div>
            </div>
          </details>
        </div>
        {commercial.startsWith('mimo-') && (
          <p className="mt-1 text-[10.5px]" style={{ color: 'var(--amber)' }} data-voice-commercial-candidate-notice>
            {MIMO_TTS_CANDIDATE_NOTICE}
          </p>
        )}
      </div>

      <div className="mb-4 rounded-2xl p-3.5" style={{ border: '1px solid var(--stroke)', background: 'var(--surface)' }} data-voice-credentials>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold">
            <KeyRound size={12} style={{ color: 'var(--blue)' }} />
            语音供应商访问凭据
            <span className="pill pill-blue" style={{ fontSize: 10 }}>凭据库优先 · 环境变量兜底</span>
          </span>
          <span className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>
            明文只上行、不回显、不写日志；保存后立即重新探测
          </span>
        </div>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {VOICE_CREDENTIALS.map((credential) => {
            const mask = credentialMasks[credential.id] ?? '';
            const source = credentialSource(credential.id, credentialAvailable(credential.id));
            const busy = keyBusy === credential.id;
            const notice = keyNotices[credential.id];
            const tone = source === '未配置' ? 'pill-red' : source === '环境变量' ? 'pill-amber' : 'pill-green';
            return (
              <div
                key={credential.id}
                data-voice-credential={credential.id}
                data-voice-credential-source={source}
                className="rounded-xl px-2.5 py-2"
                style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }}
              >
                <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-semibold">
                  <span>{credential.label}</span>
                  <span className={`pill ${tone}`} style={{ fontSize: 10 }} data-voice-credential-mask={credential.id}>
                    {source}{mask === '' ? '' : ` · ${mask}`}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-3)' }}>{credential.unlocks}</p>
                <div className="mt-1.5 flex gap-1.5">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    data-voice-credential-input={credential.id}
                    value={keyDrafts[credential.id] ?? ''}
                    placeholder={source === '未配置' ? '粘贴访问凭据（Key）…' : '重填可覆盖现有 Key'}
                    onChange={(event) => setKeyDrafts((prev) => ({ ...prev, [credential.id]: event.target.value }))}
                    className="min-w-0 flex-1 rounded-lg px-2 py-1 text-[11px] outline-none"
                    style={{ border: '1px solid var(--stroke)', background: 'var(--surface)', color: 'var(--text-2)' }}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    data-voice-credential-save={credential.id}
                    onClick={() => void saveCredential(credential.id)}
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold"
                    style={{ border: '1px solid var(--blue-line)', background: 'var(--blue-dim)', color: 'var(--blue)' }}
                  >
                    {busy ? '检测中…' : '保存并检测'}
                  </button>
                </div>
                {notice !== undefined && (
                  <p
                    className="mt-1 text-[10px]"
                    data-voice-credential-notice={credential.id}
                    style={{ color: notice.startsWith('保存失败') || notice.startsWith('请先') ? 'var(--red)' : 'var(--green)' }}
                  >
                    {notice}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {tab === 'catalog'
        ? <VoicePanel bare characterName={characterName} boundVoiceId={boundVoiceId} onBind={bind} />
        : tab === 'design'
          ? <VoiceDesignLab />
          : <VoiceStudioPanel bare characterId={characterId} characterName={characterName} />}
    </div>
  );
}
