/**
 * 声音工坊 2.0 统一吸底试听播放器（Global Sticky Audition Player）
 *
 * 设计约束：
 * - 全声音工坊 5 个分页共享唯一 `<audio>` 播放实例，切换任意音色/候选/裁剪/情绪试听时自动停止旧音频，彻底杜绝叠播。
 * - 纯前端试听不发 `coop:speaker`、不触发桌宠气泡与 OBS 直播字幕；支持播放/暂停/停止、真实进度定位、音量与 WAV 导出。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Download, Pause, Play, Square, Volume2, VolumeX } from 'lucide-react';
import { decodeBase64ToBytes, formatTimeSec } from './audio-dsp';

export interface AuditionTrack {
  /** 唯一轨道键，用于同步各卡片播放按钮高亮与进度 */
  id: string;
  title: string;
  sourceLabel: string;
  subtitle?: string;
  audioBase64?: string;
  audioBytes?: Uint8Array;
  downloadName?: string;
  durationHintSec?: number;
  /** 可选：进度更新回调（如克隆波形播放头、口型帧实时同步） */
  onTimeUpdateSec?: (sec: number) => void;
  onEnded?: () => void;
}

export interface AuditionPlayerContextValue {
  track: AuditionTrack | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  error: string | null;
  playTrack: (track: AuditionTrack) => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (sec: number) => void;
  setVolume: (vol: number) => void;
}

const AuditionPlayerContext = createContext<AuditionPlayerContextValue | null>(null);

export function useAuditionPlayer(): AuditionPlayerContextValue | null {
  return useContext(AuditionPlayerContext);
}

export function AuditionPlayerProvider(props: { children: React.ReactNode }): React.JSX.Element {
  const [track, setTrack] = useState<AuditionTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const trackRef = useRef<AuditionTrack | null>(null);

  const revokeCurrentUrl = (): void => {
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  useEffect(() => {
    const audio = new Audio();
    audio.volume = 0.85;
    audioRef.current = audio;

    const onLoadedMetadata = (): void => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const onTimeUpdate = (): void => {
      setCurrentTime(audio.currentTime);
      trackRef.current?.onTimeUpdateSec?.(audio.currentTime);
    };
    const onPlay = (): void => setPlaying(true);
    const onPause = (): void => setPlaying(false);
    const onEnded = (): void => {
      setPlaying(false);
      setCurrentTime(0);
      trackRef.current?.onEnded?.();
    };
    const onError = (): void => {
      setPlaying(false);
      setError('音频解码或播放失败');
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.pause();
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      revokeCurrentUrl();
    };
  }, []);

  const stop = useCallback((): void => {
    const audio = audioRef.current;
    if (audio !== null) {
      audio.pause();
      audio.currentTime = 0;
    }
    trackRef.current?.onEnded?.();
    setPlaying(false);
    setCurrentTime(0);
  }, []);

  const playTrack = useCallback((next: AuditionTrack): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    setError(null);

    // 同一轨道切换播放/暂停
    if (trackRef.current?.id === next.id && objectUrlRef.current !== null && !audio.ended) {
      trackRef.current = next;
      setTrack(next);
      if (!audio.paused) {
        audio.pause();
      } else {
        void audio.play().catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      }
      return;
    }

    // 切新轨道：立即停旧音、释放旧 Blob URL
    audio.pause();
    trackRef.current?.onEnded?.();
    revokeCurrentUrl();

    let rawBytes: Uint8Array;
    if (next.audioBytes !== undefined) {
      rawBytes = next.audioBytes;
    } else if (next.audioBase64 !== undefined && next.audioBase64 !== '') {
      rawBytes = decodeBase64ToBytes(next.audioBase64);
    } else {
      setError('缺少可播放音频数据');
      return;
    }

    const copy = new Uint8Array(rawBytes.byteLength);
    copy.set(rawBytes);
    const url = URL.createObjectURL(new Blob([copy], { type: 'audio/wav' }));
    objectUrlRef.current = url;
    trackRef.current = next;
    setTrack(next);
    setCurrentTime(0);
    setDuration(next.durationHintSec ?? 0);
    audio.src = url;
    void audio.play().catch((err: unknown) => {
      setPlaying(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const togglePlay = useCallback((): void => {
    const audio = audioRef.current;
    if (audio === null || trackRef.current === null || objectUrlRef.current === null) return;
    if (audio.paused) {
      void audio.play().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback((sec: number): void => {
    const audio = audioRef.current;
    if (audio === null || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const clamped = Math.max(0, Math.min(audio.duration, sec));
    audio.currentTime = clamped;
    setCurrentTime(clamped);
    trackRef.current?.onTimeUpdateSec?.(clamped);
  }, []);

  const setVolume = useCallback((vol: number): void => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    if (audioRef.current !== null) audioRef.current.volume = clamped;
  }, []);

  const value = useMemo<AuditionPlayerContextValue>(
    () => ({
      track,
      playing,
      currentTime,
      duration,
      volume,
      error,
      playTrack,
      togglePlay,
      stop,
      seek,
      setVolume,
    }),
    [track, playing, currentTime, duration, volume, error, playTrack, togglePlay, stop, seek, setVolume],
  );

  return (
    <AuditionPlayerContext.Provider value={value}>
      {props.children}
    </AuditionPlayerContext.Provider>
  );
}

/** 底部吸底统一试听播放器条（Tidepaper v3.1） */
export function StickyAuditionBar(): React.JSX.Element {
  const ctx = useAuditionPlayer();
  if (ctx === null) return <></>;
  const { track, playing, currentTime, duration, volume, error, togglePlay, stop, seek, setVolume } = ctx;
  const pct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const downloadAudio = (): void => {
    if (track === null) return;
    const bytes = track.audioBytes ?? (track.audioBase64 ? decodeBase64ToBytes(track.audioBase64) : null);
    if (bytes === null) return;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = track.downloadName ?? `${track.title}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="vs-sticky-player" data-voice-sticky-player role="region" aria-label="统一试听播放器">
      <button
        type="button"
        className={`vs-play-btn${playing ? ' on' : ''}`}
        disabled={track === null}
        onClick={togglePlay}
        aria-label={playing ? '暂停试听' : '播放试听'}
        data-sticky-play-btn
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>

      <button
        type="button"
        className="vs-icon-btn"
        disabled={track === null}
        onClick={stop}
        title="停止试听"
        aria-label="停止试听"
      >
        <Square size={11} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
          <div className="flex min-w-0 items-center gap-2">
            <AudioLines size={12} style={{ color: playing ? 'var(--accent)' : 'var(--text-3)', flexShrink: 0 }} />
            <span className="truncate font-semibold" style={{ color: 'var(--text-1)' }} data-sticky-title>
              {track !== null ? track.title : '统一试听播放器 · 就绪'}
            </span>
            {track !== null && (
              <span className="pill pill-blue" style={{ fontSize: 9.5, padding: '1px 7px' }}>
                {track.sourceLabel}
              </span>
            )}
            <span className="hidden text-[10.5px] sm:inline" style={{ color: 'var(--text-3)' }}>
              {error !== null ? error : (track?.subtitle ?? '单通道互斥 · 试听不触发桌宠气泡与直播流')}
            </span>
          </div>
          <span className="mono text-[10.5px]" style={{ color: 'var(--text-3)' }}>
            {track !== null && duration > 0 ? `${formatTimeSec(currentTime)} / ${formatTimeSec(duration)}` : '未选择音频'}
          </span>
        </div>

        <div
          className="vs-sticky-progress"
          role="slider"
          tabIndex={0}
          aria-label="试听播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 1000)}
          aria-valuenow={Math.round(currentTime * 1000)}
          onClick={(e) => {
            if (duration <= 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            seek(ratio * duration);
          }}
        >
          <div className="vs-sticky-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="hidden items-center gap-1.5 sm:flex">
        <button
          type="button"
          className="vs-icon-btn"
          onClick={() => setVolume(volume > 0 ? 0 : 0.85)}
          aria-label={volume === 0 ? '取消静音' : '静音'}
        >
          {volume === 0 ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          aria-label="试听音量"
          onChange={(e) => setVolume(Number(e.target.value))}
          className="wb-range w-20"
        />
      </div>

      {track !== null && (
        <button
          type="button"
          className="vs-icon-btn"
          onClick={downloadAudio}
          title="导出当前试听 WAV"
          aria-label="导出当前试听 WAV"
        >
          <Download size={12} />
        </button>
      )}
    </div>
  );
}
