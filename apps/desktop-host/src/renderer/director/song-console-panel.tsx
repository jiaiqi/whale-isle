/**
 * 中控台「点歌台」最小面板（V2-P3-01 · SPEC §3.4）
 *
 * 四块内容，全部走真实宿主 IPC（`v2:song-*`），不做任何前端模拟：
 * 1. 能力状态：Demucs / RVC / ffmpeg / RMVPE 四个原子能力的真实 ready 与缺口；
 * 2. 提交：一次点歌请求（四重授权门禁所需的 rights 字段必须由人填，缺授权就填不出来）；
 * 3. 取消：对进行中的 requestId 发 `v2:song-cancel`；
 * 4. 真实回执：宿主回写的管线状态 + 首切片播放回执（PLAYING → COMPLETED/FAILED/CANCELLED）。
 *
 * 诚实红线：缺真实后端（Demucs/RVC/声线权重）时管线会如实进入 `unavailable`，
 * 面板只显示缺口，**不显示任何"已唱"的假状态**。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Disc3, Loader2, Music4, RefreshCw, Square } from 'lucide-react';
import type {
  SongConsoleCapability,
  SongConsoleStatus,
  SongConsoleRequestInput,
  SongLicenseScope,
} from '@workbench/shared-protocol';
import type { SongPlaybackReceiptView } from './bridge';

/** 与其他面板一致的输入控件样式（设计令牌层没有全局 input 规则） */
const INPUT_CLASS = 'w-full rounded-lg px-3 py-2 text-[12.5px] outline-none';
const INPUT_STYLE = { background: 'var(--inset)', border: '1px solid var(--stroke)', color: 'var(--text-1)' } as const;

const LICENSE_OPTIONS: Array<{ value: SongLicenseScope; label: string }> = [
  { value: 'original_owned', label: '原创自有' },
  { value: 'licensed_commercial', label: '已获商用许可' },
  { value: 'licensed_livestream', label: '已获直播许可' },
  { value: 'dev_only_non_commercial', label: '仅开发非商用' },
  { value: 'unlicensed', label: '未授权' },
];

const CAPABILITY_LABEL: Record<SongConsoleCapability['name'], string> = {
  demucs: '人声分离 Demucs',
  rvc: '音色转换 RVC',
  ffmpeg: '音频处理 ffmpeg',
  rmvpe: '人声提取 RMVPE',
};

const STAGE_LABEL: Record<SongConsoleStatus['stage'], string> = {
  rights_check: '授权门禁',
  blacklist_check: '黑名单检查',
  cache_lookup: '缓存查询',
  cache_hit: '缓存命中',
  separating: '分离人声/伴奏',
  slicing: '人声切片',
  converting: 'RVC 转换',
  mixing: '混音',
  prebuffer_ready: '首切片就绪',
  streaming: '边唱边补齐',
  completing: '后台补齐',
  completed: '已完成',
  rejected: '已拒绝',
  unavailable: '能力缺失',
  cancelled: '已取消',
};

const STATE_TONE: Record<SongConsoleStatus['state'], string> = {
  idle: 'pill',
  preparing: 'pill-amber',
  streaming: 'pill-amber',
  completing: 'pill-amber',
  completed: 'pill-green',
  rejected: 'pill-red',
  unavailable: 'pill-red',
  cancelled: 'pill',
};

interface CapabilityView {
  ok: boolean;
  capabilities: SongConsoleCapability[];
  error?: string;
}

interface SnapshotView {
  status: SongConsoleStatus | null;
  lastPlayback: SongPlaybackReceiptView | null;
  playbackReceipts: SongPlaybackReceiptView[];
}

interface PlaybackHeadView {
  realPlayhead: boolean;
  active: boolean;
  positionMs: number | null;
}

function formatHead(positionMs: number | null): string {
  if (positionMs === null) return '—';
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(Math.floor((positionMs % 1000) / 100))}`;
}

interface FormState {
  title: string;
  artist: string;
  durationMs: string;
  sourceAudioPath: string;
  characterId: string;
  voiceProfileId: string;
  channel: 'private_desktop' | 'livestream_public' | 'commercial_distribution';
  songLicense: SongLicenseScope;
  accompanimentLicense: SongLicenseScope;
  lyricsLicense: SongLicenseScope;
  voiceModelAuthorized: boolean;
  voiceConsentSource: string;
  attribution: string;
  rvcModelPath: string;
  rvcIndexPath: string;
}

const INITIAL_FORM: FormState = {
  title: '',
  artist: 'Original',
  durationMs: '60000',
  sourceAudioPath: '',
  characterId: 'char_xiaojing',
  voiceProfileId: 'xiaojing',
  channel: 'private_desktop',
  songLicense: 'original_owned',
  accompanimentLicense: 'original_owned',
  lyricsLicense: 'original_owned',
  voiceModelAuthorized: false,
  voiceConsentSource: '',
  attribution: '',
  rvcModelPath: '',
  rvcIndexPath: '',
};

function newRequestId(): string {
  return `song_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function SongConsolePanel(): React.JSX.Element {
  const [capabilities, setCapabilities] = useState<CapabilityView | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [head, setHead] = useState<PlaybackHeadView | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = snapshot?.status ?? null;

  const loadCapabilities = useCallback((): void => {
    void window.directorBridge
      .v2SongCapabilities()
      .then((result) => setCapabilities(result))
      .catch((err: unknown) =>
        setCapabilities({ ok: false, capabilities: [], error: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  const loadSnapshot = useCallback((): void => {
    void window.directorBridge
      .v2SongSnapshot()
      .then((result) => setSnapshot(result))
      .catch(() => undefined);
    void window.directorBridge
      .v2SongPlaybackHead()
      .then((result) => setHead(result))
      .catch(() => setHead(null));
  }, []);

  useEffect(() => {
    loadCapabilities();
    loadSnapshot();
  }, [loadCapabilities, loadSnapshot]);

  // 进行中的管线才轮询；终态后停止轮询，避免无意义 IPC
  useEffect(() => {
    const preparing = status?.state === 'preparing' || status?.state === 'streaming' || status?.state === 'completing';
    // 播放头单独轮询：真实声音在播时即使管线已 completed 也要继续显示位置
    const playing = head?.active === true;
    if (!preparing && !playing) return undefined;
    const timer = window.setInterval(loadSnapshot, playing ? 250 : 1000);
    return () => window.clearInterval(timer);
  }, [status?.state, head?.active, loadSnapshot]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const title = form.title.trim();
    if (title === '') {
      toast.error('请填写曲名');
      return;
    }
    const durationMs = Number.parseInt(form.durationMs, 10);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      toast.error('曲长（毫秒）必须是正整数');
      return;
    }
    if (!form.voiceModelAuthorized && form.voiceConsentSource.trim() === '') {
      toast.error('声线授权：勾选「已授权」或填写授权来源说明');
      return;
    }
    setSubmitting(true);
    try {
      const requestId = newRequestId();
      const input: SongConsoleRequestInput = {
        requestId,
        characterId: form.characterId.trim(),
        voiceProfileId: form.voiceProfileId.trim(),
        channel: form.channel,
        sourceAudioPath: form.sourceAudioPath.trim(),
        song: {
          songId: `song_${requestId}`,
          title,
          artist: form.artist.trim() === '' ? 'Original' : form.artist.trim(),
          durationMs,
          rights: {
            songLicense: form.songLicense,
            accompanimentLicense: form.accompanimentLicense,
            lyricsLicense: form.lyricsLicense,
            voiceModelAuthorized: form.voiceModelAuthorized,
            voiceConsentSource: form.voiceConsentSource.trim(),
            attribution: form.attribution.trim(),
          },
        },
        rvcModelPath: form.rvcModelPath.trim(),
        rvcIndexPath: form.rvcIndexPath.trim(),
      };
      const result = await window.directorBridge.v2SongRequest(input);
      if (!result.ok) {
        toast.error(`点歌被拒：${result.error ?? '宿主未说明原因'}`);
      } else {
        toast.info(`已提交点歌：${title}`);
      }
      loadSnapshot();
    } catch (err) {
      toast.error(`点歌失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (status === null) return;
    setBusy(true);
    try {
      const result = await window.directorBridge.v2SongCancel(status.requestId);
      if (result.cancelled) toast.info('已请求取消');
      else toast.error(`取消未生效：${result.reason ?? '宿主未说明原因'}`);
      loadSnapshot();
    } finally {
      setBusy(false);
    }
  };

  const missing = useMemo(
    () => (capabilities?.capabilities ?? []).filter((cap) => !cap.ready),
    [capabilities],
  );

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-5" data-song-console>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">点歌台</h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
            授权门禁 → 黑名单 → 缓存池 → Demucs 分离 → 25s 切片 RVC → 混音 → 首切片开唱 → 后台补齐落盘
          </p>
        </div>
        <button
          type="button"
          className="wb-foot-btn"
          onClick={() => { loadCapabilities(); loadSnapshot(); }}
          title="刷新能力与状态"
        >
          <RefreshCw size={12} />刷新
        </button>
      </header>

      {/* 1. 能力状态 */}
      <section className="card mb-3 p-3.5" data-song-capabilities>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">原子能力状态</h2>
          <span className={`pill ${missing.length === 0 ? 'pill-green' : 'pill-red'}`}>
            {capabilities === null ? '探测中…' : missing.length === 0 ? '全部就绪' : `缺 ${missing.length} 项`}
          </span>
        </div>
        {capabilities !== null && capabilities.error !== undefined && (
          <p className="mb-2 text-xs" style={{ color: 'var(--red)' }}>能力探测失败：{capabilities.error}</p>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          {(capabilities?.capabilities ?? []).map((cap) => (
            <div key={cap.name} className="rounded-xl px-3 py-2" style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{CAPABILITY_LABEL[cap.name]}</span>
                <span className={`pill ${cap.ready ? 'pill-green' : 'pill-red'}`}>{cap.ready ? 'ready' : 'missing'}</span>
              </div>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-3)' }}>{cap.detail}</p>
              {!cap.ready && cap.hint !== '' && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--amber)' }}>补救：{cap.hint}</p>
              )}
            </div>
          ))}
          {capabilities !== null && capabilities.capabilities.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--text-3)' }}>宿主未返回任何能力位（后端缺失或探测失败）。</p>
          )}
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* 2. 提交 */}
        <section className="card p-3.5" data-song-form>
          <h2 className="mb-2 text-sm font-semibold">提交点歌</h2>
          <div className="grid gap-2">
            <label className="grid gap-1">
              <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>曲名 *</span>
              <input
                className={INPUT_CLASS} style={INPUT_STYLE}
                data-song-title
                value={form.title}
                placeholder="例如：示例曲"
                onChange={(e) => set('title', e.target.value)}
              />
            </label>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>歌手</span>
                <input className={INPUT_CLASS} style={INPUT_STYLE} value={form.artist} onChange={(e) => set('artist', e.target.value)} />
              </label>
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>曲长（毫秒）*</span>
                <input
                  className={INPUT_CLASS} style={INPUT_STYLE}
                  value={form.durationMs}
                  inputMode="numeric"
                  onChange={(e) => set('durationMs', e.target.value)}
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>本地源音频路径（原曲）</span>
              <input
                className={INPUT_CLASS} style={INPUT_STYLE}
                value={form.sourceAudioPath}
                placeholder="/Users/…/song.wav"
                onChange={(e) => set('sourceAudioPath', e.target.value)}
              />
            </label>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>角色 ID</span>
                <input className={INPUT_CLASS} style={INPUT_STYLE} value={form.characterId} onChange={(e) => set('characterId', e.target.value)} />
              </label>
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>声线档案 ID</span>
                <input className={INPUT_CLASS} style={INPUT_STYLE} value={form.voiceProfileId} onChange={(e) => set('voiceProfileId', e.target.value)} />
              </label>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>曲目许可</span>
                <select className={INPUT_CLASS} style={INPUT_STYLE} value={form.songLicense} onChange={(e) => set('songLicense', e.target.value as SongLicenseScope)}>
                  {LICENSE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>伴奏许可</span>
                <select
                  className={INPUT_CLASS} style={INPUT_STYLE}
                  value={form.accompanimentLicense}
                  onChange={(e) => set('accompanimentLicense', e.target.value as SongLicenseScope)}
                >
                  {LICENSE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>歌词许可</span>
                <select className={INPUT_CLASS} style={INPUT_STYLE} value={form.lyricsLicense} onChange={(e) => set('lyricsLicense', e.target.value as SongLicenseScope)}>
                  {LICENSE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>渠道</span>
                <select
                  className={INPUT_CLASS} style={INPUT_STYLE}
                  value={form.channel}
                  onChange={(e) => set('channel', e.target.value as FormState['channel'])}
                >
                  <option value="private_desktop">仅本机桌面</option>
                  <option value="livestream_public">公开直播</option>
                  <option value="commercial_distribution">商业发行</option>
                </select>
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>声线授权来源说明</span>
              <input
                className={INPUT_CLASS} style={INPUT_STYLE}
                data-song-consent
                value={form.voiceConsentSource}
                placeholder="例如：owner 书面授权 2026-11-26"
                onChange={(e) => set('voiceConsentSource', e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                data-song-voice-authorized
                checked={form.voiceModelAuthorized}
                onChange={(e) => set('voiceModelAuthorized', e.target.checked)}
              />
              声线模型已获权利人授权（公开直播渠道必须勾选）
            </label>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>RVC 模型路径</span>
                <input className={INPUT_CLASS} style={INPUT_STYLE} value={form.rvcModelPath} onChange={(e) => set('rvcModelPath', e.target.value)} />
              </label>
              <label className="grid gap-1">
                <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>RVC 索引路径</span>
                <input className={INPUT_CLASS} style={INPUT_STYLE} value={form.rvcIndexPath} onChange={(e) => set('rvcIndexPath', e.target.value)} />
              </label>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <button type="button" className="btn-pill primary" data-song-submit disabled={submitting} onClick={() => void submit()}>
                {submitting ? <Loader2 size={13} className="animate-spin" /> : <Music4 size={13} />}提交点歌
              </button>
              <button type="button" className="wb-foot-btn" data-song-cancel disabled={busy || status === null} onClick={() => void cancel()}>
                <Square size={12} />取消当前请求
              </button>
            </div>
          </div>
        </section>

        <div className="grid gap-3">
          {/* 4a. 管线状态 */}
          <section className="card p-3.5" data-song-status>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">管线状态</h2>
              {status !== null && <span className={`pill ${STATE_TONE[status.state]}`}>{status.state}</span>}
            </div>
            {status === null ? (
              <p className="text-xs" style={{ color: 'var(--text-3)' }}>还没有任何点歌请求。</p>
            ) : (
              <div className="grid gap-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>阶段</span>
                  <span>{STAGE_LABEL[status.stage]} · {status.stage}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>曲目</span>
                  <span>{status.songTitle}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>缓存键</span>
                  <span className="mono" style={{ fontSize: 10 }}>{status.cacheKey}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>缓存命中</span>
                  <span>{status.cacheHit ? '是' : '否'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: 'var(--text-3)' }}>切片进度</span>
                  <span>{status.completedSlices}/{status.totalSlices}</span>
                </div>
                {status.rejectionReason !== undefined && (
                  <p style={{ color: 'var(--red)' }}>拒绝原因：{status.rejectionReason}</p>
                )}
                {status.unavailableReason !== undefined && (
                  <p style={{ color: 'var(--red)' }}>能力缺口：{status.unavailableReason}</p>
                )}
                {status.missingCapabilities.length > 0 && (
                  <p style={{ color: 'var(--amber)' }}>缺失能力：{status.missingCapabilities.join('、')}</p>
                )}
                {status.prebufferPath !== undefined && (
                  <p className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>首切片：{status.prebufferPath}</p>
                )}
                {status.finalPath !== undefined && (
                  <p className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>成品：{status.finalPath}</p>
                )}
                <p className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>
                  requestId：{status.requestId} · 更新于 {new Date(status.updatedAt).toLocaleTimeString()}
                </p>
              </div>
            )}
          </section>

          {/* 4b. 播放回执 */}
          <section className="card p-3.5" data-song-receipts>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">播放回执</h2>
              <span className="pill">{snapshot?.playbackReceipts.length ?? 0} 条</span>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" data-song-playhead>
              <span
                className="pill"
                style={{ fontFamily: 'var(--font-mono)' }}
                data-song-playhead-position={head?.positionMs ?? ''}
              >
                播放头 {formatHead(head?.positionMs ?? null)}
              </span>
              {head === null ? (
                <span style={{ color: 'var(--text-3)' }}>播放头状态未知</span>
              ) : !head.realPlayhead ? (
                <span style={{ color: 'var(--amber)' }}>afplay 回退：无位置回报（非真实播放头）</span>
              ) : head.active ? (
                <span style={{ color: 'var(--green)' }}>真实播放头 · AVAudioPlayer.currentTime</span>
              ) : (
                <span style={{ color: 'var(--text-3)' }}>真实播放头就绪 · 待播放</span>
              )}
            </div>
            {(snapshot?.playbackReceipts ?? []).length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-3)' }}>还没有真实播放回执（首切片就绪并播放后才会写入）。</p>
            ) : (
              <ul className="grid gap-1.5">
                {(snapshot?.playbackReceipts ?? []).map((receipt) => (
                  <li
                    key={`${receipt.requestId}-${receipt.startedAt}`}
                    className="rounded-lg px-2.5 py-1.5 text-[11px]"
                    style={{ border: '1px solid var(--stroke)', background: 'var(--inset)' }}
                    data-song-receipt={receipt.status}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span style={{ color: 'var(--text-3)' }}>{new Date(receipt.startedAt).toLocaleTimeString()}</span>
                      <span className="mono">{receipt.status}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="mono" style={{ color: 'var(--text-3)' }}>{receipt.cacheKey}</span>
                      <span>{receipt.playedMs !== undefined ? `${receipt.playedMs}ms` : '—'}</span>
                    </div>
                    {receipt.reason !== undefined && <div style={{ color: 'var(--amber)' }}>{receipt.reason}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-3.5" data-song-note>
            <div className="flex items-start gap-2">
              <Disc3 size={14} style={{ marginTop: 2, color: 'var(--text-3)' }} />
              <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                本页只展示宿主真实回执：缺 Demucs / RVC / 声线权重时管线会如实进入「能力缺失」，
                不会出现占位音频，也不会把未播放的状态标成已唱。
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
