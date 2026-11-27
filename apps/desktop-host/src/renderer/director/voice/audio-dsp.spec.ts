import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  computePcmQuality,
  decodeBase64ToBytes,
  encodePcm16MonoWav,
  extractWavPeaks,
  parseWavSamples,
  trimAndEncodeMonoWav,
} from './audio-dsp';

function makeSineSamples(durationSec: number, sampleRate: number, amp = 0.4, freq = 320): Float32Array {
  const len = Math.round(durationSec * sampleRate);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

describe('voice/audio-dsp（浏览器端真实 PCM 波形、裁剪与声学质检）', () => {
  it('WAV 编码 → Base64 → 解码往返保持采样率与时长一致', () => {
    const samples = makeSineSamples(2.0, 24_000, 0.35);
    const wav = encodePcm16MonoWav(samples, 24_000);
    const b64 = bytesToBase64(wav);
    const back = decodeBase64ToBytes(b64);
    const parsed = parseWavSamples(back);
    expect(parsed).not.toBeNull();
    expect(parsed!.sampleRate).toBe(24_000);
    expect(parsed!.channels).toBe(1);
    expect(parsed!.bitDepth).toBe(16);
    expect(parsed!.samples.length).toBe(48_000);
  });

  it('extractWavPeaks 从真实 WAV 提取非空峰值条，非法字节返回空数组（绝不捏造）', () => {
    const wav = encodePcm16MonoWav(makeSineSamples(1.5, 24_000, 0.5), 24_000);
    const peaks = extractWavPeaks(wav, 32);
    expect(peaks).toHaveLength(32);
    expect(peaks.every((p) => p >= 0.08 && p <= 1)).toBe(true);
    expect(extractWavPeaks(new Uint8Array([1, 2, 3, 4]), 32)).toEqual([]);
  });

  it('trimAndEncodeMonoWav 正确裁剪时间段、重采样 48kHz→24kHz 并归一化峰值至 -3 dBFS', () => {
    const raw = makeSineSamples(10.0, 48_000, 0.12);
    const { wavBytes, processedSamples, sampleRate } = trimAndEncodeMonoWav(raw, 48_000, 2.0, 8.0, {
      targetSampleRate: 24_000,
      normalizeToDb: -3,
    });
    expect(sampleRate).toBe(24_000);
    expect(processedSamples.length).toBe(6 * 24_000);
    const parsed = parseWavSamples(wavBytes);
    expect(parsed?.sampleRate).toBe(24_000);
    const quality = computePcmQuality(processedSamples, sampleRate);
    expect(quality.durationMs).toBe(6000);
    expect(quality.peakDb).toBeGreaterThanOrEqual(-3.3);
    expect(quality.peakDb).toBeLessThanOrEqual(-2.7);
    expect(quality.clipping).toBe(false);
  });

  it('computePcmQuality 诚实检出过短与削波失真，绝不报优', () => {
    const shortClipping = makeSineSamples(1.2, 24_000, 0.99);
    const qa = computePcmQuality(shortClipping, 24_000);
    expect(qa.grade).toBe('warn');
    expect(qa.clipping).toBe(true);
    expect(qa.hints.some((h) => h.includes('不足 3 秒'))).toBe(true);
    expect(qa.hints.some((h) => h.includes('削波'))).toBe(true);
  });
});
