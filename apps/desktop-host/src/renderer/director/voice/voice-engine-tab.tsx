/**
 * Tab 5：「引擎 · 路由与凭据」（Engine Tier, Providers, AudioMixer Routing & Encrypted Vault）
 *
 * 把原首页上常驻堆叠的两屏底层配置收束到专注的运维页签：
 * 1. 引擎档位（商业 API 默认 vs 离线档，原样引用 OFFLINE_TIER_COST_TEXT）+ 本地 Audio Worker 真实探针
 * 2. 商业 TTS 路由选择（MiMo 三模型 / MiniMax / OpenAI 兼容 / OpenRouter，原样展示 MIMO_TTS_CANDIDATE_NOTICE）
 * 3. 多轨 AudioMixer、动作原声 Ducking 与桌面/OBS 独立输出设备路由
 * 4. 语音供应商加密钥匙串凭据（明文只上行、不落盘渲染层）
 */
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Database, KeyRound, Lock, Play, Radio, RefreshCw, ShieldCheck, SlidersHorizontal, Timer, Trash2, Volume2, Zap,
} from 'lucide-react';
import {
  MIMO_TTS_CANDIDATE_NOTICE,
  OFFLINE_TIER_COST_TEXT,
  type AudioMixerSnapshot,
  type AudioTrackKind,
  type CommercialTtsProvider,
  type VoiceCloudFallbackPolicy,
  type VoiceEngineTier,
  type VoiceProviderStatus,
} from '@workbench/shared-protocol';
import {
  CANDIDATE_TTS_PROVIDERS,
  COMMERCIAL_TTS_PROVIDERS,
  resolveCommercialTtsProvider,
} from '@workbench/voice-runtime/browser';
import { formatBytes } from './audio-dsp';

export const VOICE_CREDENTIALS = [
  { id: 'mimo-tts', label: '小米 MiMo（当前主线）', unlocks: '内置音色 / VoiceClone / VoiceDesign 三模型共用一个 Key' },
  { id: 'minimax', label: 'MiniMax T2A（备用 / 已停用）', unlocks: '额度耗尽已停用，填入有效 Key 即可恢复' },
  { id: 'openai-tts', label: 'OpenAI 兼容 TTS', unlocks: '备用稳定档 openai-compatible-tts（/audio/speech）' },
  { id: 'openrouter', label: 'OpenRouter（候选）', unlocks: '候选 openrouter-tts（如 Gemini Flash TTS，按 token 计费）' },
] as const;

const TRACK_LABELS: Record<AudioTrackKind, { label: string; hint: string }> = {
  speech: { label: '桌面语音轨 (Speech)', hint: '日常对话、内心戏与雷区反射输出设备' },
  singing: { label: '唱歌舞台轨 (Singing)', hint: '可独立路由至 BlackHole / OBS 虚拟声卡' },
  bgm: { label: '背景伴奏轨 (BGM)', hint: '说话时自动执行 Ducking 压低' },
  sfx: { label: '动作原声轨 (SFX)', hint: '桌宠动作 .m4a 音效，说话时压低至 15%' },
};

const ROUTE_PRESETS = ['default', 'system-speakers', 'blackhole-2ch-obs', 'virtual-cable-obs'] as const;

export function VoiceEngineTab(props: {
  tier: VoiceEngineTier;
  onToggleTier: () => void;
  fallbackPolicy: VoiceCloudFallbackPolicy;
  onChangeFallbackPolicy: (next: VoiceCloudFallbackPolicy) => void;
  cacheStats: { entries: number; maxEntries: number; estimatedBytes: number; maxBytes: number } | null;
  onClearCache: () => Promise<void>;
  onRunRealConnectTest: () => Promise<void>;
  testingConnect: boolean;
  connectResult: { ok: boolean; providerKind: string; latencyMs: number; detail: string } | null;
  commercial: CommercialTtsProvider;
  onPickCommercial: (next: CommercialTtsProvider) => void;
  openRouterModel: string;
  onOpenRouterModelChange: (val: string) => void;
  onOpenRouterModelCommit: () => void;
  providers: VoiceProviderStatus[];
  onRefreshProviders: () => Promise<void>;
  backend: { backend: 'mcode' | 'say' | 'unsupported'; detail: string } | null;
  sfx: { enabled: boolean; volume: number };
  onUpdateSfx: (next: { enabled: boolean; volume: number }) => void;
  speaker: { name: string | null; state: 'speaking' | 'idle' };
  mixer: AudioMixerSnapshot | null;
  onUpdateOutputRoute: (kind: AudioTrackKind, deviceId: string) => Promise<void>;
  previewingKey: string | null;
  onPreviewRoute: () => Promise<void>;
  credentialMasks: Record<string, string>;
  onSaveCredential: (providerId: string, draft: string) => Promise<{ ok: boolean; notice: string }>;
}): React.JSX.Element {
  const {
    tier,
    onToggleTier,
    fallbackPolicy,
    onChangeFallbackPolicy,
    cacheStats,
    onClearCache,
    onRunRealConnectTest,
    testingConnect,
    connectResult,
    commercial,
    onPickCommercial,
    openRouterModel,
    onOpenRouterModelChange,
    onOpenRouterModelCommit,
    providers,
    onRefreshProviders,
    backend,
    sfx,
    onUpdateSfx,
    speaker,
    mixer,
    onUpdateOutputRoute,
    previewingKey,
    onPreviewRoute,
    credentialMasks,
    onSaveCredential,
  } = props;

  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyNotices, setKeyNotices] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const offline = tier === 'offline_preferred';
  const localWorker = providers.find((p) => p.kind === 'local-audio-worker') ?? null;
  const availableKinds = providers.filter((p) => p.available).map((p) => p.kind);
  const commercialChoice = resolveCommercialTtsProvider({ preference: commercial, available: availableKinds });

  const workerTone = localWorker === null || !localWorker.available ? 'pill-red' : localWorker.degraded ? 'pill-amber' : 'pill-green';
  const workerLabel = localWorker === null ? '未探测' : !localWorker.available ? '未启动' : localWorker.degraded ? '占位/降级' : '真实后端';
  const emotionLabel = localWorker === null || !localWorker.available
    ? '未知'
    : localWorker.supportsEmotion ? '支持（探针实测）' : '不支持（探针实测）';

  const providerLabel = (kind: CommercialTtsProvider): string =>
    kind === 'minimax-tts' ? 'MiniMax T2A'
      : kind === 'openai-compatible-tts' ? 'OpenAI 兼容 TTS'
        : kind === 'openrouter-tts' ? 'OpenRouter TTS'
          : kind === 'mimo-tts' ? 'MiMo 内置音色'
            : kind === 'mimo-tts-voiceclone' ? 'MiMo VoiceClone'
              : 'MiMo VoiceDesign';

  const credentialAvailable = (providerId: string): boolean => {
    if (providerId === 'mimo-tts') return providers.some((p) => p.kind.startsWith('mimo-tts') && p.available);
    const kind = providerId === 'minimax' ? 'minimax-tts' : providerId === 'openai-tts' ? 'openai-compatible-tts' : 'openrouter-tts';
    return providers.some((p) => p.kind === kind && p.available);
  };

  const credentialSource = (providerId: string): '凭据库' | '环境变量' | '未配置' => {
    if ((credentialMasks[providerId] ?? '') !== '') return '凭据库';
    return credentialAvailable(providerId) ? '环境变量' : '未配置';
  };

  const handleSaveKey = async (providerId: string): Promise<void> => {
    const draft = (keyDrafts[providerId] ?? '').trim();
    if (draft === '') {
      setKeyNotices((prev) => ({ ...prev, [providerId]: '请先粘贴访问凭据（Key）' }));
      return;
    }
    setKeyBusy(providerId);
    setKeyNotices((prev) => ({ ...prev, [providerId]: '保存并探测中…' }));
    try {
      const res = await onSaveCredential(providerId, draft);
      if (res.ok) setKeyDrafts((prev) => ({ ...prev, [providerId]: '' }));
      setKeyNotices((prev) => ({ ...prev, [providerId]: res.notice }));
    } finally {
      setKeyBusy(null);
    }
  };

  const renderProviderButton = (kind: CommercialTtsProvider): React.JSX.Element => {
    const on = commercial === kind;
    const status = providers.find((p) => p.kind === kind);
    const ready = status?.available === true;
    const candidate = (CANDIDATE_TTS_PROVIDERS as readonly CommercialTtsProvider[]).includes(kind);
    const limitedFree = kind.startsWith('mimo-');
    return (
      <button
        key={kind}
        type="button"
        data-voice-commercial-pick={kind}
        data-voice-commercial-candidate={candidate ? 'true' : 'false'}
        aria-pressed={on}
        onClick={() => onPickCommercial(kind)}
        title={limitedFree ? `${status?.detail ?? '尚未探测'} · ${MIMO_TTS_CANDIDATE_NOTICE}` : (status?.detail ?? '尚未探测')}
        className="rounded-xl px-3 py-2 text-left text-xs transition"
        style={{
          border: `1px solid ${on ? 'var(--accent-line)' : 'var(--stroke)'}`,
          background: on ? 'var(--accent-soft)' : 'var(--inset)',
          color: on ? 'var(--accent)' : 'var(--text-1)',
        }}
      >
        <div className="flex items-center justify-between gap-2 font-semibold">
          <span>{providerLabel(kind)}</span>
          <span className={`pill ${ready ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 9.5, padding: '1px 6px' }}>
            {status === undefined ? '未探测' : ready ? '可用' : '未配置'}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-3)' }}>
          <span className="mono">{kind}</span>
          {limitedFree && <span style={{ color: 'var(--amber)' }}>· 限免候选</span>}
          {candidate && !limitedFree && <span>· 候选</span>}
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-4" data-voice-engine-tab>
      {/* ① 引擎档位 + 供应商路由 */}
      <section className="card p-5" data-voice-engine-tier={tier}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="wb-display flex items-center gap-2 text-lg">
              <Timer size={16} style={{ color: 'var(--amber)' }} />语音引擎档位与路由
            </h2>
            <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-2)' }} data-voice-engine-tier-hint>
              {offline
                ? `离线档由你主动选择：不联网、不走商业 API。本机实测代价：${OFFLINE_TIER_COST_TEXT}。`
                : `默认档走商业 API；本地引擎即使已安装也不会自动抢占（本机实测：${OFFLINE_TIER_COST_TEXT}），仅在主动开启离线档时启用。`}
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <span className={`pill ${offline ? 'pill-amber' : 'pill-blue'}`} style={{ fontSize: 10.5 }} data-voice-engine-tier-label>
              {offline ? '离线档（本地引擎）' : '默认档（商业 API）'}
            </span>
            <button
              type="button"
              className={`sw${offline ? ' on' : ''}`}
              aria-pressed={offline}
              data-voice-offline-toggle
              aria-label="切换到离线档（本地引擎）"
              onClick={onToggleTier}
            />
            <button
              type="button"
              className="btn-pill ghost"
              disabled={probing}
              onClick={() => {
                setProbing(true);
                void onRefreshProviders().finally(() => setProbing(false));
              }}
            >
              <RefreshCw size={12} className={probing ? 'animate-spin' : ''} />重新探测
            </button>
          </div>
        </div>

        {/* 本地 Audio Worker & 宿主语音链探测 */}
        <div className="mt-3 grid gap-2.5 md:grid-cols-2">
          <div className="inset p-3 text-[11.5px]" data-voice-local-worker={localWorker === null ? 'unknown' : localWorker.available ? (localWorker.degraded ? 'degraded' : 'real') : 'offline'}>
            <div className="flex items-center justify-between font-semibold">
              <span>本地 Audio Worker</span>
              <span className={`pill ${workerTone}`} style={{ fontSize: 10 }}>{workerLabel}</span>
            </div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
              情绪 TTS：{emotionLabel} · {localWorker?.detail ?? '未启动（http://127.0.0.1:18770）'}
            </p>
          </div>
          <div className="inset p-3 text-[11.5px]">
            <div className="flex items-center justify-between font-semibold">
              <span className="flex items-center gap-1.5"><Radio size={12} style={{ color: 'var(--green)' }} />宿主发声回退链</span>
              <span className="pill mono" style={{ fontSize: 10 }}>{backend?.backend ?? 'unknown'}</span>
            </div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-3)' }}>
              {backend?.detail ?? '正在探测本机发声链…'}
            </p>
          </div>
        </div>

        {/* 商业供应商网格 */}
        <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--stroke)' }} data-voice-commercial-provider={commercial}>
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold" style={{ color: 'var(--text-2)' }}>商业 TTS 供应商显式选择（当前：{providerLabel(commercial)}）</span>
            <div className="flex items-center gap-2">
              {!commercialChoice.honored && (
                <span className="text-[11px]" style={{ color: 'var(--amber)' }} data-voice-commercial-fallback>
                  {commercialChoice.reason}
                </span>
              )}
              <button
                type="button"
                data-voice-commercial-preview
                disabled={previewingKey !== null}
                onClick={() => void onPreviewRoute()}
                className="btn-pill ghost"
                style={{ padding: '4px 11px', fontSize: 11 }}
              >
                <Play size={11} />{previewingKey === 'default' ? '合成中…' : '试听当前路由'}
              </button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {renderProviderButton('mimo-tts-voiceclone')}
            {renderProviderButton('mimo-tts')}
            {renderProviderButton('mimo-tts-voicedesign')}
            {COMMERCIAL_TTS_PROVIDERS.map(renderProviderButton)}
            {renderProviderButton('openrouter-tts')}
          </div>

          {commercial === 'openrouter-tts' && (
            <label className="mt-2.5 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-2)' }}>
              <span>OpenRouter TTS 模型 ID：</span>
              <input
                type="text"
                data-voice-openrouter-model
                value={openRouterModel}
                onChange={(e) => onOpenRouterModelChange(e.target.value)}
                onBlur={onOpenRouterModelCommit}
                className="w-72 rounded-lg px-2.5 py-1 mono text-xs outline-none"
                style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
              />
            </label>
          )}

          {commercial.startsWith('mimo-') && (
            <p className="mt-2.5 text-[11px]" style={{ color: 'var(--amber)' }} data-voice-commercial-candidate-notice>
              {MIMO_TTS_CANDIDATE_NOTICE}
            </p>
          )}

          {/* 生产回退护栏 + 真实短句连通测试 + SHA-256 锚定缓存 */}
          <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-3" style={{ borderColor: 'var(--stroke)' }}>
            <div className="inset p-3 text-[11.5px]">
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
                <ShieldCheck size={12} style={{ color: 'var(--accent)' }} />云端失败回退策略
              </div>
              <select
                data-voice-fallback-policy
                value={fallbackPolicy}
                onChange={(e) => onChangeFallbackPolicy(e.target.value as VoiceCloudFallbackPolicy)}
                className="w-full rounded-lg px-2 py-1.5 text-[11px] outline-none"
                style={{ border: '1px solid var(--stroke)', background: 'var(--surface-solid)', color: 'var(--text-1)' }}
              >
                <option value="subtitle_only">保留气泡字幕，明确报错（推荐，不静默换声）</option>
                <option value="system_say">允许显式回落本机 mcode / macOS say</option>
              </select>
              <p className="mt-1.5 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                生产播报默认不偷偷把克隆声线换成系统机械音；选「保留字幕」时报错但不断对话。
              </p>
            </div>

            <div className="inset p-3 text-[11.5px]">
              <div className="mb-1.5 flex items-center justify-between font-semibold">
                <span className="flex items-center gap-1.5"><Zap size={12} style={{ color: 'var(--green)' }} />真实短句连通测试</span>
                <button
                  type="button"
                  data-voice-real-connect-test
                  disabled={testingConnect}
                  onClick={() => void onRunRealConnectTest()}
                  className="btn-pill ghost"
                  style={{ padding: '2px 9px', fontSize: 10.5 }}
                >
                  {testingConnect ? '测试中…' : '真实测试 (1 次)'}
                </button>
              </div>
              <p className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                列表探测只查凭据；此按钮实际合成 1 句短台词并回放（可能产生 1 次计费/额度消耗）。
              </p>
              {connectResult !== null && (
                <p
                  className="mt-1.5 text-[10.5px] font-medium"
                  style={{ color: connectResult.ok ? 'var(--green)' : 'var(--red)' }}
                  data-voice-connect-result
                >
                  {connectResult.ok ? '✓' : '✗'} {connectResult.providerKind} · {connectResult.latencyMs}ms · {connectResult.detail}
                </p>
              )}
            </div>

            <div className="inset p-3 text-[11.5px]">
              <div className="mb-1.5 flex items-center justify-between font-semibold">
                <span className="flex items-center gap-1.5"><Database size={12} style={{ color: 'var(--violet)' }} />TTS 合成缓存</span>
                <button
                  type="button"
                  data-voice-cache-clear
                  onClick={() => void onClearCache()}
                  className="btn-pill ghost"
                  style={{ padding: '2px 9px', fontSize: 10.5 }}
                >
                  <Trash2 size={10} />清空缓存
                </button>
              </div>
              <div className="mono text-[11px]" style={{ color: 'var(--text-1)' }}>
                {cacheStats === null ? '读取中…' : `${cacheStats.entries} / ${cacheStats.maxEntries} 条 · ${formatBytes(cacheStats.estimatedBytes)}`}
              </div>
              <p className="mt-1 text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                按角色版本与参考音频 SHA-256 锚定；切换声线或撤销授权时自动失效防串音。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ② 多轨 AudioMixer、动作原声 Ducking 与桌面/OBS 独立输出路由 */}
      <section className="card p-5" data-voice-mixer-panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="wb-display flex items-center gap-2 text-lg">
              <SlidersHorizontal size={16} style={{ color: 'var(--sea)' }} />多轨混音、Ducking 与输出路由
            </h2>
            <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
              直连主进程 AudioMixer 与多宠全局抢麦锁，支持桌面陪伴与 OBS 直播独立输出轨。
            </p>
          </div>
          <span className={`pill ${speaker.state === 'speaking' ? 'pill-green' : 'pill-blue'}`} style={{ fontSize: 10.5 }} data-voice-lock={speaker.state}>
            <Lock size={10} />
            <span data-voice-speaker>
              {speaker.state === 'speaking' && speaker.name !== null ? `正在发言：${speaker.name}` : '抢麦锁空闲（active ≤ 1 串行）'}
            </span>
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {/* 动作原声 Ducking */}
          <div className="inset p-3.5">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="flex items-center gap-1.5"><Volume2 size={13} style={{ color: 'var(--violet)' }} />动作原声音效（.m4a Ducking）</span>
              <button
                type="button"
                className={`sw${sfx.enabled ? ' on' : ''}`}
                aria-pressed={sfx.enabled}
                data-sfx-ducking
                onClick={() => {
                  const next = { ...sfx, enabled: !sfx.enabled };
                  onUpdateSfx(next);
                  toast(next.enabled ? '已开启动作原声（说话时自动压低至 15%）' : '已关闭动作原声');
                }}
              />
            </div>
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-3)' }}>
              任一桌宠发声时，动作原声与 BGM 自动压低，播完平滑恢复。
            </p>
            <label className="mt-2.5 flex items-center gap-3 text-[11px]">
              <span style={{ color: 'var(--text-2)' }}>原声音量</span>
              <input
                type="range"
                className="wb-range flex-1"
                min={0}
                max={1}
                step={0.05}
                value={sfx.volume}
                onChange={(e) => onUpdateSfx({ ...sfx, volume: Number(e.target.value) })}
              />
              <span className="mono w-10 text-right">{Math.round(sfx.volume * 100)}%</span>
            </label>
          </div>

          {/* 4 轨输出设备路由 */}
          <div className="inset p-3.5">
            <div className="mb-2 text-xs font-semibold">四轨输出路由（桌面 / OBS 分离）</div>
            <div className="grid gap-2">
              {(['speech', 'singing', 'bgm', 'sfx'] as const).map((kind) => {
                const currentDevice = mixer?.outputRoutes?.[kind] ?? 'default';
                return (
                  <div key={kind} className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="min-w-0">
                      <div className="font-medium" style={{ color: 'var(--text-1)' }}>{TRACK_LABELS[kind].label}</div>
                      <div className="truncate text-[10px]" style={{ color: 'var(--text-3)' }}>{TRACK_LABELS[kind].hint}</div>
                    </div>
                    <select
                      data-voice-route={kind}
                      value={currentDevice}
                      onChange={(e) => void onUpdateOutputRoute(kind, e.target.value)}
                      className="rounded-lg px-2 py-1 mono text-[11px] outline-none"
                      style={{ border: '1px solid var(--stroke)', background: 'var(--surface-solid)', color: 'var(--text-1)' }}
                    >
                      {!ROUTE_PRESETS.includes(currentDevice as (typeof ROUTE_PRESETS)[number]) && (
                        <option value={currentDevice}>{currentDevice}</option>
                      )}
                      <option value="default">系统默认</option>
                      <option value="system-speakers">本机扬声器</option>
                      <option value="blackhole-2ch-obs">BlackHole 2ch (OBS)</option>
                      <option value="virtual-cable-obs">VB-Cable (OBS)</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ③ 语音供应商访问凭据（加密钥匙串） */}
      <section className="card p-5" data-voice-credentials>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="wb-display flex items-center gap-2 text-lg">
              <KeyRound size={16} style={{ color: 'var(--accent)' }} />语音供应商访问凭据
            </h2>
            <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
              safeStorage 加密钥匙串优先、环境变量兜底；明文仅单向上行、绝不回显或写日志。
            </p>
          </div>
          <span className="pill pill-blue" style={{ fontSize: 10 }}>保存后立即重探全部供应商</span>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {VOICE_CREDENTIALS.map((credential) => {
            const mask = credentialMasks[credential.id] ?? '';
            const source = credentialSource(credential.id);
            const busy = keyBusy === credential.id;
            const notice = keyNotices[credential.id];
            const tone = source === '未配置' ? 'pill-red' : source === '环境变量' ? 'pill-amber' : 'pill-green';
            return (
              <div
                key={credential.id}
                data-voice-credential={credential.id}
                data-voice-credential-source={source}
                className="inset p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-xs font-semibold">
                  <span>{credential.label}</span>
                  <span className={`pill ${tone} mono`} style={{ fontSize: 10 }} data-voice-credential-mask={credential.id}>
                    {source}{mask === '' ? '' : ` · ${mask}`}
                  </span>
                </div>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-3)' }}>{credential.unlocks}</p>
                <div className="mt-2 flex gap-1.5">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    data-voice-credential-input={credential.id}
                    value={keyDrafts[credential.id] ?? ''}
                    placeholder={source === '未配置' ? '粘贴访问凭据（Key）…' : '重填可覆盖现有 Key'}
                    onChange={(e) => setKeyDrafts((prev) => ({ ...prev, [credential.id]: e.target.value }))}
                    className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-xs outline-none"
                    style={{ border: '1px solid var(--stroke)', background: 'var(--surface-solid)', color: 'var(--text-1)' }}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    data-voice-credential-save={credential.id}
                    onClick={() => void handleSaveKey(credential.id)}
                    className="btn-pill ghost shrink-0"
                    style={{ padding: '4px 12px', fontSize: 11 }}
                  >
                    {busy ? '检测中…' : '保存并检测'}
                  </button>
                </div>
                {notice !== undefined && (
                  <p
                    className="mt-1.5 text-[10.5px]"
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
      </section>
    </div>
  );
}
