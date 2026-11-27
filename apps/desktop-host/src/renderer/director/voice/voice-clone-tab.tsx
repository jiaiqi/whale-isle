/**
 * Tab 3：「音色克隆台」（Instant Voice Cloning Studio）
 *
 * 三路获取干声 + 真实 PCM 裁剪质检 + MiMo Base64 ≤ 10MB 硬校验 + 权属合规门禁：
 * 1. 获取参考干声（三选一）：
 *    - 上传本地音频（WAV/MP3/M4A/OGG/WebM）
 *    - 麦克风现场录制（实时 VU 电平 + 3 套朗读提词卡）
 *    - ★ 从 AI 设计音色选取（直接选取本机 AI 音色设计生成的候选或已定格 AI 音色，送入波形裁剪与归一化再克隆！）
 * 2. 波形裁剪与确定性声学质检：保留原始素材可随时重置/试听原声，输出 24kHz 单声道 WAV，实时校核 MiMo Base64 ≤ 10MB 上限
 * 3. 声音权属门禁 + 明确告知云端边界（本地导入/裁剪不上传；仅裁剪后副本在克隆合成时发往小米云端）
 * 4. 入库自动锁定到当前角色并支持立即 4 情绪试戴与 CAM++ 体检
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity, CheckCircle2, FileAudio, Loader2, Mic, Pause, Play, RotateCcw,
  ShieldAlert, ShieldCheck, Sparkles, Square, Upload, Waves,
} from 'lucide-react';
import {
  estimateDataUriBase64Bytes,
  MIMO_MAX_REFERENCE_BASE64_BYTES,
  VOICE_CLONE_READING_SCRIPTS,
  type VoiceCloneConsentKind,
  type VoiceTimbreVersion,
  type VoiceWorkshopCandidate,
  type VoiceWorkshopState,
} from '@workbench/shared-protocol';
import {
  bytesToBase64,
  computePcmQuality,
  decodeAudioBlob,
  decodeBase64ToBytes,
  encodePcm16MonoWav,
  formatBytes,
  formatTimeSec,
  trimAndEncodeMonoWav,
} from './audio-dsp';
import { useAuditionPlayer } from './audition-player';
import { WaveformTrimmer } from './waveform-player';

export type PendingCloneAiSource =
  | { kind: 'candidate'; candidate: VoiceWorkshopCandidate }
  | { kind: 'version'; version: VoiceTimbreVersion };

interface LoadedClip {
  name: string;
  sourceMode: 'upload' | 'mic' | 'ai-design';
  sourceCandidateId?: string;
  sourceVersionId?: string;
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  peaks: number[];
}

const CONSENT_KINDS: Array<{ id: VoiceCloneConsentKind; title: string; desc: string; defaultSource: string }> = [
  {
    id: 'self_recorded',
    title: '本人亲录 / 自产素材',
    desc: '由我本人录制或本人合法原创的干净人声片段',
    defaultSource: '本人亲录干声样本',
  },
  {
    id: 'authorized_third_party',
    title: '已获声音权人书面授权',
    desc: '已取得原声者明确书面同意用于桌宠/语音克隆，须填写授权来源',
    defaultSource: '',
  },
  {
    id: 'ai_synthetic',
    title: '合规 AI 合成 / AI 音色设计派生',
    desc: '由 AI 音色设计或合规合成工具生成的非真人声线（自动标记 DEV_ONLY_NON_COMMERCIAL）',
    defaultSource: '源自本机 AI 音色设计生成的参考音频',
  },
];

export function VoiceCloneTab(props: {
  characterId: string;
  characterName: string;
  workshop: VoiceWorkshopState | null;
  pendingAiSource: PendingCloneAiSource | null;
  onClearPendingAiSource: () => void;
  onUpdateWorkshop: (next: VoiceWorkshopState) => void;
  onSwitchToLibrary: () => void;
  onSwitchToDesign: () => void;
}): React.JSX.Element {
  const {
    characterId,
    characterName,
    workshop,
    pendingAiSource,
    onClearPendingAiSource,
    onUpdateWorkshop,
    onSwitchToLibrary,
    onSwitchToDesign,
  } = props;

  const player = useAuditionPlayer();
  const [inputMode, setInputMode] = useState<'upload' | 'mic' | 'ai-design'>('upload');
  const [dragging, setDragging] = useState(false);
  const [clip, setClip] = useState<LoadedClip | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [normalize, setNormalize] = useState(true);
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);
  const [loadingAiId, setLoadingAiId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 麦克风录制状态
  const [scriptId, setScriptId] = useState<string>(VOICE_CLONE_READING_SCRIPTS[0].id);
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  // 权属声明与入库配置
  const [voiceName, setVoiceName] = useState('');
  const [voiceNote, setVoiceNote] = useState('');
  const [consentKind, setConsentKind] = useState<VoiceCloneConsentKind>('self_recorded');
  const [consentSource, setConsentSource] = useState<string>(CONSENT_KINDS[0]!.defaultSource);
  const [consentChecked, setConsentChecked] = useState(false);
  const [activateImmediately, setActivateImmediately] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createdVersion, setCreatedVersion] = useState<VoiceTimbreVersion | null>(null);
  const [postBusy, setPostBusy] = useState<string | null>(null);
  const [postAuditions, setPostAuditions] = useState<Array<{ key: string; label: string; text: string; audioBase64: string; durationMs: number | null }>>([]);

  const stopMicResources = useCallback((): void => {
    if (meterRafRef.current !== null) cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = null;
    if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
    recordTimerRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    void meterCtxRef.current?.close().catch(() => undefined);
    meterCtxRef.current = null;
    setMicLevel(0);
  }, []);

  useEffect(() => () => {
    stopMicResources();
  }, [stopMicResources]);

  const loadBlobAsClip = useCallback(async (
    blob: Blob,
    name: string,
    sourceMode: 'upload' | 'mic' | 'ai-design',
    meta?: {
      sourceCandidateId?: string;
      sourceVersionId?: string;
      suggestedLabel?: string;
      suggestedNote?: string;
      consentPreset?: { kind: VoiceCloneConsentKind; source: string };
    },
  ): Promise<void> => {
    try {
      const decoded = await decodeAudioBlob(blob);
      const suggestedEnd = Math.min(decoded.durationSec, decoded.durationSec > 15 ? 10 : decoded.durationSec);
      setClip({
        name,
        sourceMode,
        ...(meta?.sourceCandidateId === undefined ? {} : { sourceCandidateId: meta.sourceCandidateId }),
        ...(meta?.sourceVersionId === undefined ? {} : { sourceVersionId: meta.sourceVersionId }),
        ...decoded,
      });
      setTrimStart(0);
      setTrimEnd(Math.max(0.5, Number(suggestedEnd.toFixed(1))));
      setCreatedVersion(null);
      setPostAuditions([]);
      if (meta?.suggestedLabel !== undefined) {
        setVoiceName(meta.suggestedLabel.slice(0, 40));
      } else if (voiceName.trim() === '') {
        const base = name.replace(/\.[^.]+$/, '').slice(0, 24);
        setVoiceName(sourceMode === 'mic' ? '我的亲录声线' : `${base} · 克隆`);
      }
      if (meta?.suggestedNote !== undefined) {
        setVoiceNote(meta.suggestedNote.slice(0, 300));
      }
      if (meta?.consentPreset !== undefined) {
        setConsentKind(meta.consentPreset.kind);
        setConsentSource(meta.consentPreset.source);
        setConsentChecked(false); // 仍需用户显式勾选确认合规门禁
      }
      toast.success(`已载入参考干声「${name}」（${decoded.durationSec.toFixed(1)}s · ${decoded.sampleRate} Hz）`);
    } catch (err) {
      toast.error(`音频解码失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [voiceName]);

  const loadFromAiSource = useCallback(async (source: PendingCloneAiSource): Promise<void> => {
    const id = source.kind === 'candidate' ? source.candidate.id : source.version.id;
    setLoadingAiId(id);
    try {
      const audio = await window.directorBridge.v2VoiceWorkshopReadAudio({
        kind: source.kind === 'candidate' ? 'candidate' : 'version',
        id,
      });
      const bytes = decodeBase64ToBytes(audio.audioBase64);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy], { type: 'audio/wav' });
      const title = source.kind === 'candidate'
        ? `AI 设计候选 ${source.candidate.id.slice(0, 6)}`
        : source.version.label;
      const desc = source.kind === 'candidate' ? source.candidate.description : source.version.description;
      await loadBlobAsClip(blob, `${title}.wav`, 'ai-design', {
        ...(source.kind === 'candidate' ? { sourceCandidateId: source.candidate.id } : { sourceVersionId: source.version.id }),
        suggestedLabel: `${title} · 克隆`,
        suggestedNote: desc,
        consentPreset: {
          kind: 'ai_synthetic',
          source: `源自 AI 音色设计（${title}）`,
        },
      });
    } catch (err) {
      toast.error(`载入 AI 设计音色失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAiId(null);
    }
  }, [loadBlobAsClip]);

  const previewAiSource = async (source: PendingCloneAiSource): Promise<void> => {
    const id = source.kind === 'candidate' ? source.candidate.id : source.version.id;
    setLoadingAiId(`play-${id}`);
    try {
      const audio = await window.directorBridge.v2VoiceWorkshopReadAudio({
        kind: source.kind === 'candidate' ? 'candidate' : 'version',
        id,
      });
      const title = source.kind === 'candidate' ? `AI 候选 ${source.candidate.id.slice(0, 6)}` : source.version.label;
      if (player !== null) {
        player.playTrack({
          id: `clone-ai-preview-${source.kind}-${id}`,
          title,
          sourceLabel: 'AI 设计素材',
          subtitle: source.kind === 'candidate' ? source.candidate.description : source.version.description,
          audioBase64: audio.audioBase64,
          ...(audio.durationMs !== null ? { durationHintSec: audio.durationMs / 1000 } : {}),
        });
      }
    } catch (err) {
      toast.error(`试听失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAiId(null);
    }
  };

  // 从「音色设计」或「声线库」跳转带入 AI 音色
  useEffect(() => {
    if (pendingAiSource === null) return;
    setInputMode('ai-design');
    void loadFromAiSource(pendingAiSource).finally(() => onClearPendingAiSource());
  }, [pendingAiSource, loadFromAiSource, onClearPendingAiSource]);

  const handleFiles = (files: FileList | null): void => {
    const file = files?.[0];
    if (file === undefined) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.error('单个源音频文件不能超过 50 MB，请先裁剪或压缩后再导入');
      return;
    }
    void loadBlobAsClip(file, file.name, 'upload');
  };

  const startRecording = async (): Promise<void> => {
    setMicError(null);
    if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
      setMicError('当前环境不支持浏览器麦克风采集，请改用「上传本地音频」或「从 AI 设计音色选取」');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx !== undefined) {
        const ctx = new AudioCtx();
        meterCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = (): void => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
          const rms = Math.sqrt(sum / buf.length);
          setMicLevel(Math.min(1, rms * 4.5));
          meterRafRef.current = requestAnimationFrame(tick);
        };
        meterRafRef.current = requestAnimationFrame(tick);
      }

      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stopMicResources();
        setRecording(false);
        void loadBlobAsClip(blob, `麦克风录制-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.webm`, 'mic');
      };

      recorder.start();
      setRecording(true);
      setRecordSec(0);
      const started = Date.now();
      recordTimerRef.current = window.setInterval(() => {
        setRecordSec((Date.now() - started) / 1000);
      }, 100);
    } catch (err) {
      stopMicResources();
      setMicError(`无法访问麦克风：${err instanceof Error ? err.message : String(err)}（请在系统设置授予麦克风权限，或改用本地音频上传）`);
    }
  };

  const stopRecording = (): void => {
    const rec = mediaRecorderRef.current;
    if (rec !== null && rec.state !== 'inactive') rec.stop();
    else {
      stopMicResources();
      setRecording(false);
    }
  };

  // 基于当前裁剪选区实时计算声学质检与 MiMo Base64 体积校核
  const processed = useMemo(() => {
    if (clip === null) return null;
    const encoded = trimAndEncodeMonoWav(clip.samples, clip.sampleRate, trimStart, trimEnd, {
      targetSampleRate: 24_000,
      normalizeToDb: normalize ? -3 : null,
    });
    const quality = computePcmQuality(encoded.processedSamples, encoded.sampleRate, 1, 16);
    const encodedBase64Bytes = estimateDataUriBase64Bytes(encoded.wavBytes.byteLength, 'audio/wav');
    const fitsMimoLimit = encodedBase64Bytes <= MIMO_MAX_REFERENCE_BASE64_BYTES;
    return { ...encoded, quality, encodedBase64Bytes, fitsMimoLimit };
  }, [clip, trimStart, trimEnd, normalize]);

  const trimTrackId = clip !== null ? `clone-trim-${clip.name}-${trimStart.toFixed(1)}-${trimEnd.toFixed(1)}` : 'clone-trim';
  const rawTrackId = clip !== null ? `clone-raw-${clip.name}` : 'clone-raw';
  const playingTrim = player?.playing === true && player.track?.id === trimTrackId;
  const playingRaw = player?.playing === true && player.track?.id === rawTrackId;

  const togglePlayTrim = (): void => {
    if (processed === null || clip === null || player === null) return;
    player.playTrack({
      id: trimTrackId,
      title: `${clip.name}（裁剪选区）`,
      sourceLabel: '克隆裁剪预览',
      subtitle: `${trimStart.toFixed(1)}s – ${trimEnd.toFixed(1)}s · 仅本地播放，未上传云端`,
      audioBytes: processed.wavBytes,
      durationHintSec: trimEnd - trimStart,
      onTimeUpdateSec: (sec) => setPlayheadSec(trimStart + sec),
      onEnded: () => setPlayheadSec(null),
    });
  };

  const togglePlayRaw = (): void => {
    if (clip === null || player === null) return;
    const rawWav = encodePcm16MonoWav(clip.samples, clip.sampleRate);
    player.playTrack({
      id: rawTrackId,
      title: `${clip.name}（完整原声）`,
      sourceLabel: '原始素材',
      subtitle: '未裁剪原声 · 仅留本地，不会整段发往云端',
      audioBytes: rawWav,
      durationHintSec: clip.durationSec,
      onTimeUpdateSec: (sec) => setPlayheadSec(sec),
      onEnded: () => setPlayheadSec(null),
    });
  };

  const canSubmit =
    processed !== null &&
    processed.fitsMimoLimit &&
    voiceName.trim().length > 0 &&
    consentChecked &&
    consentSource.trim().length > 0 &&
    !saving;

  const submitClone = async (): Promise<void> => {
    if (!canSubmit || processed === null || clip === null) return;
    setSaving(true);
    try {
      const wavBase64 = bytesToBase64(processed.wavBytes);
      // 保留未裁剪原始副本（若 ≤ 6MB，则直接写入本地 .raw.wav 便于后续撤回重裁）
      let rawWavBase64: string | undefined;
      if (clip.sourceMode !== 'ai-design' && (trimStart > 0.05 || trimEnd < clip.durationSec - 0.05)) {
        const rawWav = encodePcm16MonoWav(clip.samples, clip.sampleRate);
        if (rawWav.byteLength <= 6 * 1024 * 1024) {
          rawWavBase64 = bytesToBase64(rawWav);
        }
      }
      const sourceTag = clip.sourceMode === 'ai-design'
        ? 'AI 设计派生'
        : clip.sourceMode === 'mic' ? '麦克风亲录' : '音频上传';

      const { version, state } = await window.directorBridge.v2VoiceWorkshopCloneCreate({
        wavBase64,
        ...(rawWavBase64 === undefined ? {} : { rawWavBase64 }),
        ...(clip.sourceCandidateId === undefined ? {} : { sourceCandidateId: clip.sourceCandidateId }),
        ...(clip.sourceVersionId === undefined ? {} : { sourceVersionId: clip.sourceVersionId }),
        label: voiceName.trim(),
        description: voiceNote.trim() || `本地克隆声线（${consentSource.trim()}）`,
        consent: {
          kind: consentKind,
          source: consentSource.trim(),
          attested: true,
          attestedAt: new Date().toISOString(),
        },
        activate: activateImmediately,
        ...(activateImmediately ? { characterId } : {}),
        tags: [sourceTag, 'VoiceClone'],
      });
      onUpdateWorkshop(state);
      if (activateImmediately) {
        await window.directorBridge.prefsSet({ voiceCommercialProvider: 'mimo-tts-voiceclone' });
      }
      setCreatedVersion(version);
      toast.success(`已入库克隆声线「${version.label}」（${formatBytes(version.referenceBytes)}）${activateImmediately ? `，并锁定到「${characterName}」` : ''}`);
    } catch (err) {
      toast.error(`入库失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const auditionCreated = async (): Promise<void> => {
    if (createdVersion === null) return;
    setPostBusy('audition');
    try {
      const rows = await window.directorBridge.v2VoiceWorkshopVersionAudition({ versionId: createdVersion.id, intensity: 'B' });
      setPostAuditions(rows);
      if (rows[0] !== undefined && player !== null) {
        player.playTrack({
          id: `clone-post-${createdVersion.id}-${rows[0].key}`,
          title: `${createdVersion.label} · ${rows[0].label}`,
          sourceLabel: '克隆试戴',
          subtitle: rows[0].text,
          audioBase64: rows[0].audioBase64,
        });
      }
      toast.success(`克隆声线 4 情绪试戴已生成（消耗 ${rows.length} 次合成）`);
    } catch (err) {
      toast.error(`试戴失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPostBusy(null);
    }
  };

  const checkCreatedConsistency = async (): Promise<void> => {
    if (createdVersion === null) return;
    setPostBusy('check');
    try {
      const { result, state } = await window.directorBridge.v2VoiceWorkshopConsistency(createdVersion.id);
      onUpdateWorkshop(state);
      if (result.verdict === 'unavailable') toast.error(`体检未完成：${result.detail}`);
      else toast.success(`体检完成：均值 ${result.mean?.toFixed(4)} · 最低 ${result.min?.toFixed(4)}`);
    } catch (err) {
      toast.error(`体检失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPostBusy(null);
    }
  };

  const activeScript = VOICE_CLONE_READING_SCRIPTS.find((s) => s.id === scriptId) ?? VOICE_CLONE_READING_SCRIPTS[0];
  const aiCandidates = workshop?.candidates ?? [];
  const aiVersions = (workshop?.versions ?? []).filter(
    (v) => (v.source === 'ai-design' || v.source === 'factory') && v.consent?.revokedAt === undefined,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1.15fr_0.95fr]" data-voice-clone-studio>
      {/* 左栏：Step 1 获取参考干声（上传 / 麦录 / 从 AI 设计选） + Step 2 波形裁剪与声学质检 */}
      <div className="space-y-4">
        <section className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="wb-display text-lg">① 获取参考干声（5–12 秒最佳）</h2>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                支持本地上传、麦克风亲录，或直接从「AI 音色设计」生成的声音里挑选并裁剪精修。
              </p>
            </div>
            <div className="seg" role="tablist" aria-label="音频获取方式">
              <button type="button" className={inputMode === 'upload' ? 'on' : ''} data-clone-mode="upload" onClick={() => setInputMode('upload')}>
                <Upload size={12} />上传音频
              </button>
              <button type="button" className={inputMode === 'mic' ? 'on' : ''} data-clone-mode="mic" onClick={() => setInputMode('mic')}>
                <Mic size={12} />麦克风录制
              </button>
              <button type="button" className={inputMode === 'ai-design' ? 'on' : ''} data-clone-mode="ai-design" onClick={() => setInputMode('ai-design')}>
                <Sparkles size={12} />从 AI 设计选 ({aiCandidates.length + aiVersions.length})
              </button>
            </div>
          </div>

          {inputMode === 'upload' && (
            <div
              data-clone-dropzone
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                handleFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`vs-dropzone${dragging ? ' dragging' : ''}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".wav,.mp3,.m4a,.ogg,.webm,audio/*"
                data-voice-clone-upload-input
                className="hidden"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <FileAudio size={26} style={{ color: 'var(--accent)' }} />
              <div className="text-xs font-semibold" style={{ color: 'var(--text-1)' }}>
                拖拽音频到此处，或点击选择本地文件
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                支持 WAV / MP3 / M4A / OGG / WebM · 本地转为 24 kHz 单声道 16-bit WAV（导入不会上传云端）
              </div>
            </div>
          )}

          {inputMode === 'mic' && (
            <div className="inset p-4" data-clone-mic-panel>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-2)' }}>朗读提词卡（读一段自然中文即可）</span>
                <div className="flex flex-wrap gap-1">
                  {VOICE_CLONE_READING_SCRIPTS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setScriptId(s.id)}
                      className={`pill ${scriptId === s.id ? 'pill-blue' : ''}`}
                      style={{ fontSize: 10, padding: '1.5px 8px' }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <blockquote className="wb-serif-quote rounded-xl p-3.5 text-[14px] leading-relaxed" style={{ background: 'var(--surface-solid)', border: '1px solid var(--stroke)' }}>
                “{activeScript.text}”
              </blockquote>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {!recording ? (
                  <button type="button" data-clone-mic-start onClick={() => void startRecording()} className="btn-pill accent">
                    <Mic size={13} />开始录制干声
                  </button>
                ) : (
                  <button type="button" data-clone-mic-stop onClick={stopRecording} className="btn-pill red">
                    <Square size={12} />停止并载入波形
                  </button>
                )}

                <div className="flex min-w-[160px] flex-1 items-center gap-2">
                  <span className="mono text-xs font-semibold" style={{ color: recording ? 'var(--red)' : 'var(--text-3)', minWidth: 44 }}>
                    {formatTimeSec(recordSec)}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface)' }}>
                    <div
                      className="h-full transition-all duration-75"
                      style={{
                        width: `${Math.round(micLevel * 100)}%`,
                        background: micLevel > 0.85 ? 'var(--red)' : 'var(--green)',
                      }}
                    />
                  </div>
                  <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>建议 6–12s</span>
                </div>
              </div>

              {micError !== null && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--red)' }}>{micError}</p>
              )}
            </div>
          )}

          {inputMode === 'ai-design' && (
            <div className="inset space-y-3 p-3.5" data-clone-ai-picker>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11.5px] font-semibold" style={{ color: 'var(--text-1)' }}>
                  从 AI 音色设计生成的声音中挑选参考干声
                </span>
                <button type="button" className="btn-pill ghost" style={{ padding: '2px 10px', fontSize: 10.5 }} onClick={onSwitchToDesign}>
                  <Sparkles size={10} />去设计更多候选
                </button>
              </div>

              {aiCandidates.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[10.5px] font-semibold" style={{ color: 'var(--text-3)' }}>
                    最近 AI 音色设计候选（{aiCandidates.length} 条）
                  </div>
                  <div className="vs-ai-picker-list">
                    {aiCandidates.map((cand, idx) => {
                      const picked = clip?.sourceCandidateId === cand.id;
                      return (
                        <div
                          key={cand.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs"
                          style={{
                            border: `1px solid ${picked ? 'var(--accent-line)' : 'var(--stroke)'}`,
                            background: picked ? 'var(--accent-soft)' : 'var(--surface-solid)',
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold" style={{ color: 'var(--text-1)' }}>AI 候选 #{idx + 1}</span>
                              <span className="pill pill-violet" style={{ fontSize: 9.5, padding: '0.5px 6px' }}>VoiceDesign</span>
                              <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>
                                {formatBytes(cand.bytes)}{cand.durationMs ? ` · ${(cand.durationMs / 1000).toFixed(1)}s` : ''}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-2)' }}>{cand.description}</p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              className="btn-pill ghost"
                              style={{ padding: '3px 9px', fontSize: 10.5 }}
                              disabled={loadingAiId !== null}
                              onClick={() => void previewAiSource({ kind: 'candidate', candidate: cand })}
                            >
                              {loadingAiId === `play-${cand.id}` ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}试听
                            </button>
                            <button
                              type="button"
                              data-clone-pick-ai={`candidate:${cand.id}`}
                              className={`btn-pill ${picked ? 'accent' : 'primary'}`}
                              style={{ padding: '3px 10px', fontSize: 10.5 }}
                              disabled={loadingAiId !== null}
                              onClick={() => void loadFromAiSource({ kind: 'candidate', candidate: cand })}
                            >
                              {loadingAiId === cand.id ? <Loader2 size={10} className="animate-spin" /> : null}
                              {picked ? '已载入裁剪器' : '选为克隆素材'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <div className="mb-1.5 text-[10.5px] font-semibold" style={{ color: 'var(--text-3)' }}>
                  已定格的 AI 设计 / 出厂 AI 声线（{aiVersions.length} 条）
                </div>
                <div className="vs-ai-picker-list">
                  {aiVersions.map((ver) => {
                    const picked = clip?.sourceVersionId === ver.id;
                    return (
                      <div
                        key={ver.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs"
                        style={{
                          border: `1px solid ${picked ? 'var(--accent-line)' : 'var(--stroke)'}`,
                          background: picked ? 'var(--accent-soft)' : 'var(--surface-solid)',
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold" style={{ color: 'var(--text-1)' }}>{ver.label}</span>
                            <span className={`pill ${ver.source === 'factory' ? 'pill-blue' : 'pill-violet'}`} style={{ fontSize: 9.5, padding: '0.5px 6px' }}>
                              {ver.source === 'factory' ? '出厂 AI 基线' : 'AI 设计定格'}
                            </span>
                            <span className="mono text-[10px]" style={{ color: 'var(--text-3)' }}>
                              {formatBytes(ver.referenceBytes)}{ver.durationMs ? ` · ${(ver.durationMs / 1000).toFixed(1)}s` : ''}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-2)' }}>{ver.description}</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="btn-pill ghost"
                            style={{ padding: '3px 9px', fontSize: 10.5 }}
                            disabled={loadingAiId !== null}
                            onClick={() => void previewAiSource({ kind: 'version', version: ver })}
                          >
                            {loadingAiId === `play-${ver.id}` ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}试听
                          </button>
                          <button
                            type="button"
                            data-clone-pick-ai={`version:${ver.id}`}
                            className={`btn-pill ${picked ? 'accent' : 'primary'}`}
                            style={{ padding: '3px 10px', fontSize: 10.5 }}
                            disabled={loadingAiId !== null}
                            onClick={() => void loadFromAiSource({ kind: 'version', version: ver })}
                          >
                            {loadingAiId === ver.id ? <Loader2 size={10} className="animate-spin" /> : null}
                            {picked ? '已载入裁剪器' : '选为克隆素材'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Step 2: 真实波形裁剪与确定性声学质检 */}
        <section className="card p-5" data-clone-qa-panel>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="wb-display text-lg">② 波形裁剪、响度归一与声学质检</h2>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                原始素材保留在本地可随时重置；仅裁剪后的副本会在克隆合成时发往云端。
              </p>
            </div>
            {clip !== null && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" className="btn-pill ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={togglePlayTrim}>
                  {playingTrim ? <Pause size={11} /> : <Play size={11} />}
                  {playingTrim ? '暂停选区' : `试听选区 (${(trimEnd - trimStart).toFixed(1)}s)`}
                </button>
                <button type="button" className="btn-pill ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={togglePlayRaw}>
                  {playingRaw ? <Pause size={11} /> : <Play size={11} />}
                  {playingRaw ? '暂停原声' : '听原声'}
                </button>
                <button
                  type="button"
                  className="btn-pill ghost"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={() => { setTrimStart(0); setTrimEnd(Number(clip.durationSec.toFixed(1))); }}
                  title="撤回裁剪，恢复选中完整原声"
                >
                  <RotateCcw size={11} />重置裁剪
                </button>
              </div>
            )}
          </div>

          {clip === null || processed === null ? (
            <div className="inset flex flex-col items-center justify-center gap-1.5 py-10 text-center">
              <Waves size={22} style={{ color: 'var(--text-3)', opacity: 0.5 }} />
              <p className="text-xs" style={{ color: 'var(--text-2)' }}>上传、录制或从「AI 设计音色」选入音频后，这里将展示真实 PCM 波形与声学质检</p>
            </div>
          ) : (
            <div className="space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold" style={{ color: 'var(--text-1)' }}>
                  当前素材：{clip.name}
                  {clip.sourceMode === 'ai-design' && <span className="pill pill-violet ml-2" style={{ fontSize: 9.5 }}>源自 AI 音色设计</span>}
                </span>
                <span
                  className={`pill ${processed.fitsMimoLimit ? 'pill-green' : 'pill-red'}`}
                  style={{ fontSize: 10 }}
                  data-clone-base64-check
                >
                  MiMo Base64：{(processed.encodedBase64Bytes / 1_000_000).toFixed(2)} / 10.00 MB {processed.fitsMimoLimit ? '✓ 合规' : '✗ 超限'}
                </span>
              </div>

              <WaveformTrimmer
                peaks={clip.peaks}
                durationSec={clip.durationSec}
                startSec={trimStart}
                endSec={trimEnd}
                playheadSec={playheadSec}
                onChangeRange={(s, e) => { setTrimStart(s); setTrimEnd(e); }}
              />

              <label className="flex items-center justify-between rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
                <span>
                  <b>自动峰值归一化至 -3 dBFS</b>
                  <span className="ml-2 text-[11px]" style={{ color: 'var(--text-3)' }}>统一干声响度并防止削波（推荐开启）</span>
                </span>
                <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
              </label>

              {/* 4 项真实 PCM 声学指标卡 */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-clone-qa-metrics>
                <div className="inset p-2.5">
                  <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>选区时长</div>
                  <div className="mono mt-0.5 text-sm font-semibold">{(processed.quality.durationMs / 1000).toFixed(1)}s</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>推荐 5–12s</div>
                </div>
                <div className="inset p-2.5">
                  <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>导出规格</div>
                  <div className="mono mt-0.5 text-sm font-semibold">24 kHz</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>16-bit 单声道 · {formatBytes(processed.wavBytes.byteLength)}</div>
                </div>
                <div className="inset p-2.5">
                  <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>响度 / 峰值</div>
                  <div className="mono mt-0.5 text-sm font-semibold">{processed.quality.rmsDb} / {processed.quality.peakDb} dB</div>
                  <div className="text-[10px]" style={{ color: processed.quality.clipping ? 'var(--red)' : 'var(--green)' }}>
                    {processed.quality.clipping ? '检测到削波' : '无削波'}
                  </div>
                </div>
                <div className="inset p-2.5">
                  <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>估算信噪比</div>
                  <div className="mono mt-0.5 text-sm font-semibold">
                    {processed.quality.estimatedSnrDb === null ? '样本过短' : `${processed.quality.estimatedSnrDb} dB`}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>≥14 dB 较干净</div>
                </div>
              </div>

              <div
                className="rounded-xl px-3 py-2.5 text-[11px]"
                style={{
                  background: processed.quality.grade === 'good' ? 'var(--green-dim)' : processed.quality.grade === 'fair' ? 'var(--amber-dim)' : 'var(--red-dim)',
                  border: `1px solid ${processed.quality.grade === 'good' ? 'var(--green-line)' : processed.quality.grade === 'fair' ? 'var(--amber-line)' : 'var(--red-line)'}`,
                  color: processed.quality.grade === 'good' ? 'var(--green)' : processed.quality.grade === 'fair' ? 'var(--amber)' : 'var(--red)',
                }}
              >
                <div className="mb-1 font-semibold">
                  声学质检评级：{processed.quality.grade === 'good' ? '优质（推荐入库）' : processed.quality.grade === 'fair' ? '可用（有优化空间）' : '存在告警（建议先调整）'}
                </div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {processed.quality.hints.map((hint, idx) => <li key={idx}>{hint}</li>)}
                </ul>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* 右栏：Step 3 权属合规门禁与入库 + Step 4 克隆后验证 */}
      <div className="space-y-4">
        <section className="card flex flex-col gap-3.5 p-5" data-clone-consent-panel>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="wb-display text-lg">③ 权属声明与命名入库</h2>
              <p className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                严禁未经授权克隆他人声音（《民法典》1023 条红线）；入库后随时可一键撤销授权并清理本地副本。
              </p>
            </div>
            <span className="pill pill-amber" style={{ fontSize: 10 }}><ShieldAlert size={10} />必选门禁</span>
          </div>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold" style={{ color: 'var(--text-2)' }}>声线名称 <span style={{ color: 'var(--red)' }}>*</span></span>
            <input
              type="text"
              data-clone-label-input
              value={voiceName}
              maxLength={40}
              onChange={(e) => setVoiceName(e.target.value)}
              placeholder="例如：小鲸 · AI 精修克隆 v1"
              className="rounded-lg px-3 py-2 text-xs outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold" style={{ color: 'var(--text-2)' }}>音色备注（可选，写入角色 VoiceIdentity）</span>
            <textarea
              rows={2}
              value={voiceNote}
              maxLength={300}
              onChange={(e) => setVoiceNote(e.target.value)}
              placeholder="记录音色特点、适用角色或 AI 设计来源，便于日后检索与换引擎重做"
              className="rounded-lg px-3 py-2 text-xs outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
            />
          </label>

          <div>
            <div className="mb-1.5 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>声源权属类型 <span style={{ color: 'var(--red)' }}>*</span></div>
            <div className="grid gap-2">
              {CONSENT_KINDS.map((item) => {
                const on = consentKind === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-clone-consent-kind={item.id}
                    onClick={() => {
                      setConsentKind(item.id);
                      if (item.defaultSource !== '' || consentSource === CONSENT_KINDS[0]!.defaultSource || consentSource === CONSENT_KINDS[2]!.defaultSource) {
                        setConsentSource(item.defaultSource);
                      }
                    }}
                    className="rounded-xl p-2.5 text-left transition"
                    style={{
                      border: `1px solid ${on ? 'var(--accent-line)' : 'var(--stroke)'}`,
                      background: on ? 'var(--accent-soft)' : 'var(--inset)',
                    }}
                  >
                    <div className="text-xs font-semibold" style={{ color: on ? 'var(--accent)' : 'var(--text-1)' }}>{item.title}</div>
                    <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-3)' }}>{item.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-semibold" style={{ color: 'var(--text-2)' }}>授权 / 来源台账说明 <span style={{ color: 'var(--red)' }}>*</span></span>
            <input
              type="text"
              data-clone-consent-source
              value={consentSource}
              maxLength={200}
              onChange={(e) => setConsentSource(e.target.value)}
              placeholder={consentKind === 'authorized_third_party' ? '必填：声音权人姓名/渠道/授权范围（桌面/直播/商用）' : '填写简明来源说明'}
              className="rounded-lg px-3 py-2 text-xs outline-none"
              style={{ border: '1px solid var(--stroke)', background: 'var(--inset)', color: 'var(--text-1)' }}
            />
          </label>

          <label className="flex items-start gap-2 rounded-xl p-3 text-[11.5px] leading-relaxed" style={{ background: 'var(--inset)', border: '1px solid var(--stroke)' }}>
            <input
              type="checkbox"
              data-clone-consent-check
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
              className="mt-0.5"
            />
            <span style={{ color: 'var(--text-1)' }}>
              我确认拥有该声源的合法使用/复刻权限（非未授权他人或艺人声音），并了解：本地导入与裁剪不联网，仅在执行 VoiceClone 合成时会将<strong>裁剪后的参考副本</strong>发往小米 MiMo 云端。
            </span>
          </label>

          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-2)' }}>
            <input
              type="checkbox"
              checked={activateImmediately}
              onChange={(e) => setActivateImmediately(e.target.checked)}
            />
            入库后立即锁定绑定到角色「<b>{characterName}</b>」（切至 MiMo VoiceClone）
          </label>

          <button
            type="button"
            data-clone-submit
            disabled={!canSubmit}
            onClick={() => void submitClone()}
            className="btn-pill primary w-full py-2.5 disabled:opacity-40"
          >
            <ShieldCheck size={14} />
            {saving ? '裁剪转码并写入本地版本库…' : '裁剪转码并定格为克隆声线'}
          </button>
        </section>

        {/* 入库成功后的立刻验证卡 */}
        {createdVersion !== null && (
          <section className="card p-5" style={{ borderColor: 'var(--green-line)' }} data-clone-created>
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--green)' }}>
              <CheckCircle2 size={16} />已入库克隆声线：{createdVersion.label}
            </div>
            <p className="mt-1 text-[11.5px]" style={{ color: 'var(--text-2)' }}>
              已落盘本地版本库并记录 SHA-256 指纹（<span className="mono">{createdVersion.referenceSha256?.slice(0, 12)}</span>）。建议立刻跑一次 4 情绪试戴与一致性质检：
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={postBusy !== null} onClick={() => void auditionCreated()} className="btn-pill primary">
                <Play size={12} />{postBusy === 'audition' ? '合成 4 情绪中…' : '4 情绪试戴（4 次）'}
              </button>
              <button type="button" disabled={postBusy !== null} onClick={() => void checkCreatedConsistency()} className="btn-pill ghost">
                <Activity size={12} />{postBusy === 'check' ? '体检中…' : '一致性体检（10 次）'}
              </button>
              <button type="button" onClick={onSwitchToLibrary} className="btn-pill ghost">
                在声线库中查看
              </button>
            </div>
            {postAuditions.length > 0 && (
              <div className="mt-3 grid gap-1.5 border-t pt-2.5" style={{ borderColor: 'var(--stroke)' }}>
                {postAuditions.map((row) => (
                  <div key={row.key} className="flex items-center gap-2 text-[11px]">
                    <span className="pill" style={{ fontSize: 10, padding: '1px 7px' }}>{row.label}</span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }}>{row.text}</span>
                    <button
                      type="button"
                      className="btn-pill ghost"
                      style={{ padding: '2px 9px', fontSize: 10.5 }}
                      onClick={() => player?.playTrack({
                        id: `clone-post-${createdVersion.id}-${row.key}`,
                        title: `${createdVersion.label} · ${row.label}`,
                        sourceLabel: '克隆试戴',
                        subtitle: row.text,
                        audioBase64: row.audioBase64,
                      })}
                    >
                      播放
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
