/**
 * 口型同步与分句工具（V2-P1-02）：
 * - splitSpeechSentences：长文本按标点/长度分句切片，供流式预取降低首句延迟
 * - extractWavLipSyncFrames：从真实 RIFF/PCM16 WAV 波形计算 RMS 能量与过零率，映射为 Viseme 序列
 * - synthesizeTextLipSyncFrames：为压缩流/系统降级语音提供确定性音节包络（结尾强制 closed）
 * - LipSyncTimelinePlayer：按帧驱动口型回调，stop() 时强制归零闭嘴
 */
import { LipSyncFrameSchema, type LipSyncFrame, type LipSyncViseme } from '@workbench/shared-protocol';

/** 按标点切分并限制单段字数，确保不产生空片段 */
export function splitSpeechSentences(text: string, maxChunkChars = 75): string[] {
  const cleaned = text.trim();
  if (cleaned === '') return [];
  const cap = Math.max(10, Math.round(maxChunkChars));
  const rawParts = cleaned.split(/(?<=[。！？!?；;\n])/u).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of rawParts) {
    if (part.length <= cap) {
      out.push(part);
      continue;
    }
    const subParts = part.split(/(?<=[，,、])/u).map((s) => s.trim()).filter(Boolean);
    let current = '';
    for (const sub of subParts) {
      if (current.length > 0 && current.length + sub.length > cap) {
        out.push(current);
        current = '';
      }
      if (sub.length <= cap) {
        current = current === '' ? sub : `${current}${sub}`;
      } else {
        if (current !== '') {
          out.push(current);
          current = '';
        }
        for (let i = 0; i < sub.length; i += cap) {
          out.push(sub.slice(i, i + cap));
        }
      }
    }
    if (current !== '') out.push(current);
  }
  return out;
}

function classifyViseme(amplitude: number, zcr: number): LipSyncViseme {
  if (amplitude < 0.06) return 'closed';
  if (zcr > 0.24) return 'teeth';
  if (amplitude > 0.58) return 'open';
  if (zcr > 0.12) return 'wide';
  return 'round';
}

function amplitudeToDb(amplitude: number): number {
  if (amplitude <= 0.0001) return -80;
  return Number(Math.max(-80, Math.min(0, 20 * Math.log10(amplitude))).toFixed(2));
}

/**
 * 解析 RIFF/WAVE PCM16 音频并提取每帧 RMS 音量包络与口型。
 * 非法或非 PCM16 数据返回空数组而不抛异常。
 */
export function extractWavLipSyncFrames(wavBytes: Uint8Array, frameMs = 50): LipSyncFrame[] {
  if (wavBytes.byteLength < 44) return [];
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return [];

  let channels = 1;
  let sampleRate = 24_000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= wavBytes.byteLength) {
    const chunkId = tag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16 && bodyStart + 16 <= wavBytes.byteLength) {
      const audioFormat = view.getUint16(bodyStart, true);
      if (audioFormat !== 1) return []; // 仅支持 PCM16
      channels = Math.max(1, view.getUint16(bodyStart + 2, true));
      sampleRate = Math.max(8000, view.getUint32(bodyStart + 4, true));
      bitsPerSample = view.getUint16(bodyStart + 14, true);
      if (bitsPerSample !== 16) return [];
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataSize = Math.min(chunkSize, wavBytes.byteLength - bodyStart);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize < 2) return [];

  const bytesPerSampleFrame = channels * 2;
  const totalSamples = Math.floor(dataSize / bytesPerSampleFrame);
  const stepMs = Math.max(20, Math.round(frameMs));
  const samplesPerFrame = Math.max(1, Math.floor((sampleRate * stepMs) / 1000));
  const frames: LipSyncFrame[] = [];

  for (let start = 0; start < totalSamples; start += samplesPerFrame) {
    const end = Math.min(totalSamples, start + samplesPerFrame);
    const count = end - start;
    if (count <= 0) continue;
    let sumSq = 0;
    let zeroCrossings = 0;
    let prevSample = 0;
    for (let i = start; i < end; i++) {
      const sample = view.getInt16(dataOffset + i * bytesPerSampleFrame, true) / 32768;
      sumSq += sample * sample;
      if (i > start && ((sample >= 0 && prevSample < 0) || (sample < 0 && prevSample >= 0))) {
        zeroCrossings++;
      }
      prevSample = sample;
    }
    const rms = Math.sqrt(sumSq / count);
    const amplitude = Number(Math.min(1, rms * 1.8).toFixed(4));
    const zcr = count > 1 ? zeroCrossings / (count - 1) : 0;
    const timestampMs = Math.round((start / sampleRate) * 1000);
    const durationMs = Math.max(20, Math.round((count / sampleRate) * 1000));
    frames.push(LipSyncFrameSchema.parse({
      timestampMs,
      durationMs,
      viseme: classifyViseme(amplitude, zcr),
      amplitude,
      rmsDb: amplitudeToDb(amplitude),
    }));
  }

  return frames;
}

/** 为无裸 PCM 波形的音频流或系统降级播报生成确定性音节口型包络 */
export function synthesizeTextLipSyncFrames(text: string, durationMs: number, frameMs = 60): LipSyncFrame[] {
  const cleaned = text.trim();
  const totalMs = Math.max(120, Math.round(durationMs));
  const stepMs = Math.max(30, Math.round(frameMs));
  if (cleaned === '') {
    return [LipSyncFrameSchema.parse({ timestampMs: 0, durationMs: totalMs, viseme: 'closed', amplitude: 0, rmsDb: -80 })];
  }

  const cycle: LipSyncViseme[] = ['open', 'wide', 'round', 'teeth'];
  const frames: LipSyncFrame[] = [];
  let cursor = 0;
  let idx = 0;
  while (cursor < totalMs) {
    const remaining = totalMs - cursor;
    const dur = Math.min(stepMs, remaining);
    const isEnd = cursor + dur >= totalMs;
    const ch = cleaned.charCodeAt(idx % cleaned.length);
    const isPause = /[，。！？、,.!?\s]/u.test(cleaned[idx % cleaned.length] ?? '');
    const viseme: LipSyncViseme = isEnd || isPause ? 'closed' : cycle[(ch + idx) % cycle.length]!;
    const amplitude = viseme === 'closed' ? 0 : Number((0.45 + ((ch % 5) * 0.1)).toFixed(4));
    frames.push(LipSyncFrameSchema.parse({
      timestampMs: cursor,
      durationMs: dur,
      viseme,
      amplitude,
      rmsDb: amplitudeToDb(amplitude),
    }));
    cursor += dur;
    idx++;
  }
  return frames;
}

export interface LipSyncTimelinePlayerOptions {
  frames: LipSyncFrame[];
  onFrame: (frame: LipSyncFrame) => void;
  onComplete?: () => void;
}

/** 驱动口型帧时间轴播放，并在 stop() 时立刻归位 closed */
export class LipSyncTimelinePlayer {
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private active = false;

  constructor(private readonly options: LipSyncTimelinePlayerOptions) {}

  start(): void {
    this.stop(false);
    this.active = true;
    const frames = this.options.frames;
    if (frames.length === 0) {
      this.emitClosed();
      this.active = false;
      this.options.onComplete?.();
      return;
    }
    let maxEnd = 0;
    for (const frame of frames) {
      maxEnd = Math.max(maxEnd, frame.timestampMs + frame.durationMs);
      const timer = setTimeout(() => {
        if (!this.active) return;
        this.options.onFrame(frame);
      }, frame.timestampMs);
      this.timers.push(timer);
    }
    const endTimer = setTimeout(() => {
      if (!this.active) return;
      this.active = false;
      this.emitClosed();
      this.options.onComplete?.();
    }, maxEnd);
    this.timers.push(endTimer);
  }

  stop(emitClosingFrame = true): void {
    this.active = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (emitClosingFrame) this.emitClosed();
  }

  private emitClosed(): void {
    this.options.onFrame({
      timestampMs: 0,
      durationMs: 0,
      viseme: 'closed',
      amplitude: 0,
      rmsDb: -80,
    });
  }
}
