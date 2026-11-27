/**
 * 浏览器端纯音频 DSP 工具（零 Node 依赖，供渲染层音色设计 / 音色克隆使用）：
 * - 从真实 WAV PCM 字节提取可视化波形包络（绝不生成随机假波形）
 * - 支持上传多格式音频（WAV/MP3/M4A/OGG/WebM）与麦克风录音解码
 * - 确定性裁剪、重采样至 24kHz 单声道 16-bit PCM WAV、可选 -3 dBFS 响度归一化
 * - 客户端实时声学质检（与主进程 analyzeWavBuffer 同口径）
 */
import type { VoiceAudioQuality } from '@workbench/shared-protocol';

export function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    let part = '';
    for (let j = 0; j < slice.length; j++) {
      part += String.fromCharCode(slice[j]!);
    }
    binary += part;
  }
  return btoa(binary);
}

/** 从 Float32 单声道采样生成归一化峰值条（0.08..1.0，用于波形绘制） */
export function extractPeaksFromSamples(samples: Float32Array, barCount = 56): number[] {
  if (samples.length === 0 || barCount <= 0) return [];
  const step = Math.max(1, Math.floor(samples.length / barCount));
  const raw: number[] = [];
  let globalMax = 0;
  for (let i = 0; i < barCount; i++) {
    const start = i * step;
    if (start >= samples.length) break;
    const end = Math.min(samples.length, start + step);
    let peak = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(samples[j]!);
      if (a > peak) peak = a;
    }
    raw.push(peak);
    if (peak > globalMax) globalMax = peak;
  }
  const denom = globalMax > 1e-4 ? globalMax : 1;
  return raw.map((v) => Math.max(0.08, Math.min(1, v / denom)));
}

/** 直接解析标准 RIFF/WAVE 字节为单声道 Float32Array + 采样率；非标准 WAV 返回 null */
export function parseWavSamples(bytes: Uint8Array): { samples: Float32Array; sampleRate: number; channels: number; bitDepth: number } | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string =>
    String.fromCharCode(bytes[off] ?? 0, bytes[off + 1] ?? 0, bytes[off + 2] ?? 0, bytes[off + 3] ?? 0);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) break;
    if (id === 'fmt ' && size >= 16) {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (
    dataOffset < 0 ||
    dataLength <= 0 ||
    channels <= 0 ||
    sampleRate <= 0 ||
    (audioFormat !== 1 && audioFormat !== 3) ||
    ![8, 16, 24, 32].includes(bitDepth)
  ) {
    return null;
  }

  const bytesPerSample = bitDepth / 8;
  const frameSize = bytesPerSample * channels;
  const totalFrames = Math.floor(dataLength / frameSize);
  if (totalFrames <= 0) return null;

  const samples = new Float32Array(totalFrames);
  for (let frame = 0; frame < totalFrames; frame++) {
    let mono = 0;
    const base = dataOffset + frame * frameSize;
    for (let ch = 0; ch < channels; ch++) {
      const pos = base + ch * bytesPerSample;
      let val = 0;
      if (audioFormat === 3 && bitDepth === 32) {
        val = view.getFloat32(pos, true);
      } else if (bitDepth === 16) {
        val = view.getInt16(pos, true) / 32768;
      } else if (bitDepth === 8) {
        val = ((bytes[pos] ?? 128) - 128) / 128;
      } else if (bitDepth === 24) {
        const b0 = bytes[pos] ?? 0;
        const b1 = bytes[pos + 1] ?? 0;
        const b2 = bytes[pos + 2] ?? 0;
        const raw = b0 | (b1 << 8) | (b2 << 16);
        const signed = (raw & 0x800000) !== 0 ? raw | ~0xffffff : raw;
        val = signed / 8388608;
      } else if (bitDepth === 32) {
        val = view.getInt32(pos, true) / 2147483648;
      }
      mono += val;
    }
    samples[frame] = mono / channels;
  }

  return { samples, sampleRate, channels, bitDepth };
}

/** 从真实 WAV 字节提取波形峰值条；解析失败返回空数组（绝不捏造随机条） */
export function extractWavPeaks(bytes: Uint8Array, barCount = 56): number[] {
  const parsed = parseWavSamples(bytes);
  if (parsed === null) return [];
  return extractPeaksFromSamples(parsed.samples, barCount);
}

/** 确定性客户端声学质检（与主进程 analyzeWavBuffer 同算法与阈值） */
export function computePcmQuality(samples: Float32Array, sampleRate: number, channels = 1, bitDepth = 16): VoiceAudioQuality {
  const totalFrames = samples.length;
  const durationMs = sampleRate > 0 ? Math.round((totalFrames / sampleRate) * 1000) : 0;
  const windowFrames = Math.max(1, Math.floor(sampleRate * 0.05));
  const windowRms: number[] = [];

  let sumSq = 0;
  let peak = 0;
  let winSumSq = 0;
  let winCount = 0;

  for (let i = 0; i < totalFrames; i++) {
    const s = samples[i]!;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    const sq = s * s;
    sumSq += sq;
    winSumSq += sq;
    winCount++;
    if (winCount >= windowFrames) {
      windowRms.push(Math.sqrt(winSumSq / winCount));
      winSumSq = 0;
      winCount = 0;
    }
  }

  const rms = totalFrames > 0 ? Math.sqrt(sumSq / totalFrames) : 0;
  const toDb = (val: number): number => (val <= 1e-5 ? -96 : Math.max(-96, Math.round(20 * Math.log10(val) * 10) / 10));
  const rmsDb = toDb(rms);
  const peakDb = toDb(peak);
  const clipping = peakDb >= -0.5;

  let estimatedSnrDb: number | null = null;
  if (windowRms.length >= 6) {
    const sorted = [...windowRms].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
    const speech = sorted[Math.floor(sorted.length * 0.85)] ?? 0;
    if (speech > 1e-4) {
      estimatedSnrDb = Math.round((toDb(speech) - Math.max(-80, toDb(floor))) * 10) / 10;
    }
  }

  const hints: string[] = [];
  let severity = 0;
  const raise = (level: 1 | 2, msg: string): void => {
    if (level > severity) severity = level;
    hints.push(msg);
  };

  if (durationMs < 3000) {
    raise(2, '时长不足 3 秒：零样本克隆特征偏少，建议提供 5–12 秒清晰干声');
  } else if (durationMs > 30000) {
    raise(2, '时长超过 30 秒：建议裁剪出最清晰稳定的 5–12 秒单人片段');
  } else if (durationMs < 5000 || durationMs > 15000) {
    raise(1, '时长可用，但 5–12 秒区间通常最稳（可在波形上裁剪微调）');
  }

  if (clipping) {
    raise(2, '峰值接近 0 dBFS（存在削波爆音风险），建议开启 -3 dBFS 归一化或调低麦距重录');
  } else if (rmsDb < -30) {
    raise(1, '整体响度偏低（<-30 dBFS），建议开启 -3 dBFS 归一化提升人声清晰度');
  }

  if (estimatedSnrDb !== null && estimatedSnrDb < 14) {
    raise(2, `估算信噪比偏低（约 ${estimatedSnrDb} dB），背景底噪可能被带入克隆声线`);
  }

  if (sampleRate < 16000) {
    raise(1, `采样率 ${sampleRate} Hz 偏低，导出时将重采样至 24 kHz`);
  }

  if (hints.length === 0) {
    hints.push('时长、响度与底噪均处于推荐克隆区间，可以直接定格入库');
  }

  return {
    durationMs,
    sampleRate,
    channels,
    bitDepth,
    rmsDb,
    peakDb,
    clipping,
    estimatedSnrDb,
    grade: severity === 2 ? 'warn' : severity === 1 ? 'fair' : 'good',
    hints,
  };
}

/** 线性重采样单声道 Float32Array 到目标采样率 */
export function resampleMono(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[Math.min(samples.length - 1, idx + 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 将单声道 Float32Array 编码为标准 16-bit PCM RIFF/WAVE 字节 */
export function encodePcm16MonoWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let pos = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(pos, clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), true);
    pos += 2;
  }
  return new Uint8Array(buffer);
}

/** 裁剪选区 + 可选峰值归一化（默认目标 -3 dBFS）+ 重采样至 24kHz 单声道 16-bit WAV */
export function trimAndEncodeMonoWav(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  options: { targetSampleRate?: number; normalizeToDb?: number | null } = {},
): { wavBytes: Uint8Array; processedSamples: Float32Array; sampleRate: number } {
  const startIdx = Math.max(0, Math.min(samples.length, Math.floor(startSec * sampleRate)));
  const endIdx = Math.max(startIdx + 1, Math.min(samples.length, Math.ceil(endSec * sampleRate)));
  const sliced = samples.slice(startIdx, endIdx);
  const targetRate = options.targetSampleRate ?? 24_000;
  const resampled = resampleMono(sliced, sampleRate, targetRate);

  const normalizeDb = options.normalizeToDb;
  if (normalizeDb !== null && normalizeDb !== undefined) {
    let peak = 0;
    for (let i = 0; i < resampled.length; i++) {
      const a = Math.abs(resampled[i]!);
      if (a > peak) peak = a;
    }
    if (peak > 1e-4) {
      const targetAmp = Math.pow(10, normalizeDb / 20);
      const gain = Math.min(8, targetAmp / peak);
      for (let i = 0; i < resampled.length; i++) {
        resampled[i] = Math.max(-0.99, Math.min(0.99, resampled[i]! * gain));
      }
    }
  }

  return {
    wavBytes: encodePcm16MonoWav(resampled, targetRate),
    processedSamples: resampled,
    sampleRate: targetRate,
  };
}

/** 用 Web Audio API 解码任意浏览器支持的音频文件（WAV / MP3 / M4A / OGG / WebM）为单声道 Float32 */
export async function decodeAudioBlob(blob: Blob): Promise<{
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  peaks: number[];
}> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  // 标准 PCM WAV 优先直解，避免无 AudioContext 环境或浏览器重采样误差
  const direct = parseWavSamples(bytes);
  if (direct !== null) {
    return {
      samples: direct.samples,
      sampleRate: direct.sampleRate,
      durationSec: direct.samples.length / direct.sampleRate,
      peaks: extractPeaksFromSamples(direct.samples, 88),
    };
  }
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioCtx === undefined) {
    throw new Error('当前环境不支持 Web Audio 解码，请上传标准 .wav 文件');
  }
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channels = decoded.numberOfChannels;
    const length = decoded.length;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        mono[i] = mono[i]! + data[i]! / channels;
      }
    }
    return {
      samples: mono,
      sampleRate: decoded.sampleRate,
      durationSec: decoded.duration,
      peaks: extractPeaksFromSamples(mono, 88),
    };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export function formatTimeSec(sec: number): string {
  const clamped = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const mins = Math.floor(clamped / 60);
  const rem = clamped - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem < 10 ? '0' : ''}${rem.toFixed(1)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
