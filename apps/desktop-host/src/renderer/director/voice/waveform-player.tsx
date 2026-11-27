/**
 * 声音工坊 2.0 通用可视化音频组件（Tidepaper v3.1 语义令牌原生）：
 * 1. WaveformPlayer：真实 PCM 波形播放器（支持懒加载 WAV、点击拖拽定位、下载）
 * 2. WaveformTrimmer：交互式裁剪波形器（展示 5–12s 黄金克隆区间 + 选区试听）
 * 3. ConsistencyGauge：CAM++ 说话人余弦一致性质检仪表条（0.70 / 0.80 / 0.85 三档硬标尺）
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Pause, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { VoiceConsistencyResult } from '@workbench/shared-protocol';
import { decodeBase64ToBytes, extractWavPeaks, formatTimeSec } from './audio-dsp';
import { useAuditionPlayer } from './audition-player';

export function WaveformPlayer(props: {
  /** 已知的 base64 音频（有则立刻绘制真实波形并可播） */
  audioBase64?: string | null;
  /** 懒加载回调（点播放或按需加载时拉取 WAV base64） */
  onRequestAudio?: () => Promise<string>;
  /** 外部已知时长（毫秒），用于尚未加载音频时的诚实展示 */
  durationMs?: number | null;
  downloadName?: string;
  compact?: boolean;
  label?: string;
  sourceLabel?: string;
  /** 可选轨道 ID，用于跨组件同步全局吸底播放器状态 */
  trackId?: string;
  /** 加载就绪后是否自动拉取波形（仅主卡/已展开项开，避免列表一次读几十个文件） */
  eagerLoad?: boolean;
}): React.JSX.Element {
  const {
    audioBase64: propBase64,
    onRequestAudio,
    durationMs,
    downloadName,
    compact = false,
    label,
    sourceLabel = '参考音频',
    trackId: propTrackId,
    eagerLoad = false,
  } = props;
  const fallbackId = useId();
  const trackId = propTrackId ?? fallbackId;
  const globalPlayer = useAuditionPlayer();

  const [loadedBase64, setLoadedBase64] = useState<string | null>(propBase64 ?? null);
  const [loading, setLoading] = useState(false);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localCurrentTime, setLocalCurrentTime] = useState(0);
  const [localDuration, setLocalDuration] = useState((durationMs ?? 0) / 1000);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const effectiveBase64 = propBase64 ?? loadedBase64;
  const isGlobalActive = globalPlayer !== null && globalPlayer.track?.id === trackId;
  const playing = globalPlayer !== null ? (isGlobalActive && globalPlayer.playing) : localPlaying;
  const currentTime = isGlobalActive ? globalPlayer.currentTime : localCurrentTime;
  const duration = isGlobalActive && globalPlayer.duration > 0 ? globalPlayer.duration : localDuration;

  useEffect(() => {
    if (propBase64 !== undefined && propBase64 !== null) {
      setLoadedBase64(propBase64);
    }
  }, [propBase64]);

  useEffect(() => {
    if (!eagerLoad || effectiveBase64 !== null || onRequestAudio === undefined) return;
    let cancelled = false;
    setLoading(true);
    void onRequestAudio()
      .then((b64) => { if (!cancelled) setLoadedBase64(b64); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eagerLoad, effectiveBase64, onRequestAudio]);

  const peaks = useMemo(() => {
    if (effectiveBase64 === null || effectiveBase64 === '') return [];
    try {
      return extractWavPeaks(decodeBase64ToBytes(effectiveBase64), compact ? 36 : 56);
    } catch {
      return [];
    }
  }, [effectiveBase64, compact]);

  useEffect(() => {
    if (effectiveBase64 === null || effectiveBase64 === '') {
      setAudioUrl(null);
      return undefined;
    }
    try {
      const bytes = decodeBase64ToBytes(effectiveBase64);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setAudioUrl(url);
      return () => {
        URL.revokeObjectURL(url);
        if (objectUrlRef.current === url) objectUrlRef.current = null;
      };
    } catch {
      setAudioUrl(null);
      return undefined;
    }
  }, [effectiveBase64]);

  const togglePlay = async (): Promise<void> => {
    setError(null);
    let b64 = effectiveBase64;
    if (b64 === null && onRequestAudio !== undefined) {
      setLoading(true);
      try {
        b64 = await onRequestAudio();
        setLoadedBase64(b64);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setLoading(false);
      }
    }
    if (globalPlayer !== null) {
      if (b64 === null || b64 === '') return;
      globalPlayer.playTrack({
        id: trackId,
        title: label ?? downloadName ?? '音频试听',
        sourceLabel,
        audioBase64: b64,
        ...(downloadName === undefined ? {} : { downloadName }),
        ...(duration > 0 ? { durationHintSec: duration } : {}),
      });
      return;
    }
    if (localPlaying) {
      audioRef.current?.pause();
      setLocalPlaying(false);
      return;
    }
    const el = audioRef.current;
    if (el === null) return;
    void el.play().then(() => setLocalPlaying(true)).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const seekTo = (sec: number): void => {
    if (isGlobalActive) {
      globalPlayer.seek(sec);
      return;
    }
    const el = audioRef.current;
    if (el === null || duration <= 0) return;
    el.currentTime = sec;
    setLocalCurrentTime(sec);
  };

  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const barCount = compact ? 36 : 56;
  const hasRealWave = peaks.length > 0;

  return (
    <div className={`vs-wave-player${compact ? ' compact' : ''}`}>
      {globalPlayer === null && audioUrl !== null && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onLoadedMetadata={(e) => {
            if (Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) {
              setLocalDuration(e.currentTarget.duration);
            }
          }}
          onTimeUpdate={(e) => setLocalCurrentTime(e.currentTarget.currentTime)}
          onEnded={() => { setLocalPlaying(false); setLocalCurrentTime(0); }}
          onPause={() => setLocalPlaying(false)}
        />
      )}
      <button
        type="button"
        className={`vs-play-btn${playing ? ' on' : ''}`}
        disabled={loading || (effectiveBase64 === null && onRequestAudio === undefined)}
        onClick={() => void togglePlay()}
        aria-label={playing ? `暂停${label ?? '音频'}` : `播放${label ?? '音频'}`}
      >
        {loading ? <Loader2 size={compact ? 12 : 14} className="animate-spin" /> : playing ? <Pause size={compact ? 12 : 14} /> : <Play size={compact ? 12 : 14} />}
      </button>

      <div
        className="vs-wave-bars"
        role="slider"
        tabIndex={0}
        aria-label={label ?? '音频波形进度'}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration * 1000)}
        aria-valuenow={Math.round(currentTime * 1000)}
        onClick={(e) => {
          if (duration <= 0) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          seekTo(ratio * duration);
        }}
        onKeyDown={(e) => {
          if (duration <= 0) return;
          if (e.key === 'ArrowRight') {
            seekTo(Math.min(duration, currentTime + 1));
          } else if (e.key === 'ArrowLeft') {
            seekTo(Math.max(0, currentTime - 1));
          }
        }}
        title={hasRealWave ? '真实 PCM 波形（点击定位播放）' : '点击播放按钮加载真实波形'}
      >
        {hasRealWave
          ? peaks.map((amp, i) => {
              const lit = (i + 0.5) / peaks.length <= progress;
              return (
                <span
                  key={i}
                  className={`vs-bar${lit ? ' lit' : ''}`}
                  style={{ height: `${Math.round(amp * 100)}%` }}
                />
              );
            })
          : Array.from({ length: barCount }, (_, i) => (
              <span key={i} className="vs-bar placeholder" style={{ height: '24%' }} />
            ))}
      </div>

      <span className="vs-wave-time mono">
        {playing || currentTime > 0
          ? `${formatTimeSec(currentTime)} / ${formatTimeSec(duration)}`
          : duration > 0
            ? formatTimeSec(duration)
            : '—'}
      </span>

      {downloadName !== undefined && audioUrl !== null && (
        <a
          href={audioUrl}
          download={downloadName}
          className="vs-icon-btn"
          title="导出 WAV 参考音频"
          aria-label="导出 WAV 参考音频"
        >
          <Download size={12} />
        </a>
      )}
      {error !== null && <span className="text-[10px]" style={{ color: 'var(--red)' }}>{error}</span>}
    </div>
  );
}

/** 交互式真实波形裁剪器（克隆工作台专用） */
export function WaveformTrimmer(props: {
  peaks: number[];
  durationSec: number;
  startSec: number;
  endSec: number;
  playheadSec: number | null;
  onChangeRange: (nextStart: number, nextEnd: number) => void;
}): React.JSX.Element {
  const { peaks, durationSec, startSec, endSec, playheadSec, onChangeRange } = props;
  const safeDur = Math.max(0.1, durationSec);
  const startPct = Math.min(100, Math.max(0, (startSec / safeDur) * 100));
  const endPct = Math.min(100, Math.max(startPct, (endSec / safeDur) * 100));
  const headPct = playheadSec !== null ? Math.min(100, Math.max(0, (playheadSec / safeDur) * 100)) : null;

  return (
    <div className="vs-trimmer" data-clone-trimmer>
      <div className="vs-trimmer-canvas">
        <div
          className="vs-trimmer-shade"
          style={{ left: 0, width: `${startPct}%` }}
        />
        <div
          className="vs-trimmer-shade"
          style={{ left: `${endPct}%`, width: `${100 - endPct}%` }}
        />
        <div
          className="vs-trimmer-window"
          style={{ left: `${startPct}%`, width: `${Math.max(1, endPct - startPct)}%` }}
        />
        {headPct !== null && (
          <div className="vs-trimmer-playhead" style={{ left: `${headPct}%` }} />
        )}
        <div className="vs-trimmer-bars">
          {peaks.map((amp, i) => {
            const pct = ((i + 0.5) / Math.max(1, peaks.length)) * 100;
            const inside = pct >= startPct && pct <= endPct;
            return (
              <span
                key={i}
                className={`vs-bar${inside ? ' lit' : ''}`}
                style={{ height: `${Math.round(amp * 100)}%` }}
              />
            );
          })}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3 text-[11px]">
        <label className="flex flex-col gap-1" style={{ color: 'var(--text-2)' }}>
          <span className="flex items-center justify-between">
            <span>起点 In</span>
            <span className="mono" style={{ color: 'var(--text-1)' }}>{formatTimeSec(startSec)}</span>
          </span>
          <input
            type="range"
            className="wb-range"
            data-clone-trim-start
            min={0}
            max={Math.max(0, durationSec - 0.5)}
            step={0.1}
            value={startSec}
            onChange={(e) => {
              const v = Number(e.target.value);
              onChangeRange(Math.min(v, endSec - 0.5), endSec);
            }}
          />
        </label>
        <label className="flex flex-col gap-1" style={{ color: 'var(--text-2)' }}>
          <span className="flex items-center justify-between">
            <span>终点 Out</span>
            <span className="mono" style={{ color: 'var(--text-1)' }}>{formatTimeSec(endSec)}</span>
          </span>
          <input
            type="range"
            className="wb-range"
            data-clone-trim-end
            min={0.5}
            max={durationSec}
            step={0.1}
            value={endSec}
            onChange={(e) => {
              const v = Number(e.target.value);
              onChangeRange(startSec, Math.max(v, startSec + 0.5));
            }}
          />
        </label>
      </div>
    </div>
  );
}

const VERDICT_META: Record<string, { label: string; pill: string; color: string }> = {
  stable: { label: '锁得稳', pill: 'pill-green', color: 'var(--green)' },
  drifty: { label: '偶尔飘', pill: 'pill-amber', color: 'var(--amber)' },
  swapped: { label: '会换人', pill: 'pill-red', color: 'var(--red)' },
  unavailable: { label: '体检不可用', pill: '', color: 'var(--text-3)' },
};

/** CAM++ 说话人余弦一致性质检标尺（标尺范围 0.40 → 1.00，真实数值可视化） */
export function ConsistencyGauge(props: {
  result: VoiceConsistencyResult | null;
  compact?: boolean;
}): React.JSX.Element {
  const { result, compact = false } = props;
  if (result === null) {
    return (
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-3)' }}>
        <ShieldAlert size={12} />
        <span>尚未做一致性体检（需同句 ×10 克隆后由 CAM++ 计算余弦）</span>
      </div>
    );
  }
  const meta = VERDICT_META[result.verdict] ?? VERDICT_META.unavailable!;
  const toPct = (v: number): number => Math.min(100, Math.max(0, ((v - 0.4) / 0.6) * 100));

  return (
    <div className="vs-consistency-gauge" data-workshop-verdict>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`pill ${meta.pill}`} style={{ fontSize: 10 }}>
          {result.verdict === 'stable' ? <ShieldCheck size={10} /> : <ShieldAlert size={10} />}
          {meta.label}
        </span>
        {result.mean !== null && (
          <span className="mono text-[11px]" style={{ color: 'var(--text-2)' }}>
            均值 <b>{result.mean.toFixed(4)}</b> · 最低 <b>{result.min?.toFixed(4)}</b> · σ {result.std?.toFixed(4)}
          </span>
        )}
      </div>

      {!compact && result.mean !== null && result.min !== null && (
        <div className="vs-gauge-track mt-2" title="横轴范围 0.40–1.00：0.70 换人线 / 0.80 稳态下界 / 0.85 稳态均值线">
          <div className="vs-gauge-zone bad" style={{ width: `${toPct(0.7)}%` }} />
          <div className="vs-gauge-zone fair" style={{ left: `${toPct(0.7)}%`, width: `${toPct(0.8) - toPct(0.7)}%` }} />
          <div className="vs-gauge-zone ok" style={{ left: `${toPct(0.8)}%`, width: `${100 - toPct(0.8)}%` }} />
          <span className="vs-gauge-pin min" style={{ left: `${toPct(result.min)}%` }} title={`最低 ${result.min.toFixed(4)}`} />
          <span className="vs-gauge-pin mean" style={{ left: `${toPct(result.mean)}%` }} title={`均值 ${result.mean.toFixed(4)}`} />
        </div>
      )}

      {!compact && (
        <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: meta.color }}>
          {result.detail}
        </p>
      )}
    </div>
  );
}
