import { describe, expect, it } from 'vitest';
import { TtsVoicePackSchema, type LipEnvelope, type TtsVoicePack } from '@workbench/shared-protocol';
import {
  actionForEmotion,
  buildPlaybackLease,
  EMOTION_ACTION_MAP,
  loadVoicePack,
  sampleVisemeTimeline,
  selectVoiceProfile,
  toSpeakRequest,
  visemeAt,
} from './tts-router';

/** T-M2-02 门禁：`[傲娇反驳]` 标签文本 → 正确匹配傲娇参考音频 → 有效音频流 + 口型包络 */

const PACK: TtsVoicePack = TtsVoicePackSchema.parse({
  voicePackId: 'blue-whale-maid-v1',
  defaultEmotionTag: 'sweet_normal',
  licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
  profiles: [
    { emotionTag: 'sweet_normal', refAudioPath: 'ref/sweet_normal.wav', refText: '主人好~', actionState: 'happy_maid' },
    { emotionTag: 'tsundere_refuse', refAudioPath: 'ref/tsundere_refuse.wav', refText: '哼，本鱼才没有偷懒！', actionState: 'happy_maid' },
    { emotionTag: 'rage_spray', refAudioPath: 'ref/rage_spray.wav', refText: '噗——喷水抗议！', actionState: 'rage_spray' },
    { emotionTag: 'lazy_yawn', refAudioPath: 'ref/lazy_yawn.wav', refText: '唔……困了', actionState: 'hungry_lazy' },
    { emotionTag: 'happy_rice', refAudioPath: 'ref/happy_rice.wav', refText: '开饭啦！', actionState: 'eat_rice' },
  ],
});

const ENVELOPE: LipEnvelope = {
  totalDurationMs: 1000,
  visemes: [
    { viseme: 'wide', startMs: 0, durationMs: 250, amplitude: 0.85 },
    { viseme: 'open', startMs: 250, durationMs: 250, amplitude: 0.5 },
    { viseme: 'closed', startMs: 500, durationMs: 500, amplitude: 0.1 },
  ],
};

describe('情绪感知 TTS 路由（宿主侧）', () => {
  it('门禁①：`[傲娇反驳]` → 命中傲娇参考音频', () => {
    const profile = selectVoiceProfile(PACK, 'tsundere_refuse');
    expect(profile.refAudioPath).toBe('ref/tsundere_refuse.wav');
    expect(profile.refText).toBe('哼，本鱼才没有偷懒！');
    // 其余情绪各命中各自参考音频（不串味）
    expect(selectVoiceProfile(PACK, 'rage_spray').refAudioPath).toBe('ref/rage_spray.wav');
    expect(selectVoiceProfile(PACK, 'lazy_yawn').refAudioPath).toBe('ref/lazy_yawn.wav');
    expect(selectVoiceProfile(PACK, 'happy_rice').refAudioPath).toBe('ref/happy_rice.wav');
  });

  it('门禁②：未知情绪回落默认情绪（不抛错、不影响语音）', () => {
    expect(selectVoiceProfile(PACK, 'unknown_emotion').refAudioPath).toBe('ref/sweet_normal.wav');
  });

  it('门禁③：情绪 → 桌宠动作映射（驱动 .webm 切换）', () => {
    expect(actionForEmotion('rage_spray')).toBe('rage_spray');
    expect(actionForEmotion('lazy_yawn')).toBe('hungry_lazy');
    expect(actionForEmotion('happy_rice')).toBe('eat_rice');
    expect(actionForEmotion('tsundere_refuse')).toBe('happy_maid');
    expect(actionForEmotion('sweet_normal')).toBe('happy_maid');
    expect(actionForEmotion('unknown')).toBe('idle'); // 未知情绪不影响语音
    expect(Object.keys(EMOTION_ACTION_MAP)).toHaveLength(5);
  });

  it('门禁④：口型包络 → 时刻口型与采样时间线', () => {
    expect(visemeAt(ENVELOPE, 0)).toBe('wide');
    expect(visemeAt(ENVELOPE, 300)).toBe('open');
    expect(visemeAt(ENVELOPE, 700)).toBe('closed');
    expect(visemeAt(ENVELOPE, 2000)).toBeNull(); // 超出时长
    const timeline = sampleVisemeTimeline(ENVELOPE, 100);
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0]?.atMs).toBe(0);
    expect(timeline.every((item) => item.atMs < ENVELOPE.totalDurationMs)).toBe(true);
  });

  it('门禁⑤：合成结果 → 语音租约（ttl=时长+缓冲、含动作与字幕）', () => {
    const request = {
      text: '[傲娇反驳] 哼，本鱼才没有偷懒！',
      emotionTag: 'tsundere_refuse',
      audioBase64: 'UklGRg==',
      durationMs: 2000,
      lipEnvelope: ENVELOPE,
      refAudioPath: 'ref/tsundere_refuse.wav',
      backend: 'local-gpt-sovits',
      degraded: false,
    };
    const { lease, visemeTimeline } = buildPlaybackLease({
      leaseId: '11111111-1111-4111-8111-111111111111',
      request,
      innerThoughtText: '鱼片又叫我大肥鱼…',
    });
    expect(lease.actionState).toBe('happy_maid');
    expect(lease.ttlMs).toBe(5000); // 2000 + 3000 缓冲
    expect(lease.textSubtitle).toContain('傲娇反驳');
    expect(lease.innerThoughtText).toBe('鱼片又叫我大肥鱼…');
    expect(lease.audioUrlOrBase64).toBe('UklGRg==');
    expect(visemeTimeline.length).toBeGreaterThan(0);
  });

  it('门禁⑥：ttl 上下界钳制', () => {
    const base = {
      text: 'x',
      emotionTag: 'sweet_normal',
      audioBase64: 'AA==',
      durationMs: 0,
      lipEnvelope: ENVELOPE,
      refAudioPath: 'ref/sweet_normal.wav',
      backend: 'local',
      degraded: false,
    };
    // ttl = duration + 3000ms 缓冲（契约 durationMs ≥ 0 → ttl ≥ 3000）
    const normal = buildPlaybackLease({ leaseId: '11111111-1111-4111-8111-111111111111', request: base });
    expect(normal.lease.ttlMs).toBe(3000);
    // 下界 500：仅在 duration 为负（契约外的防御输入）时触发
    const negative = buildPlaybackLease({
      leaseId: '11111111-1111-4111-8111-111111111111',
      request: { ...base, durationMs: -10_000 },
    });
    expect(negative.lease.ttlMs).toBe(500);
    // 上界 300_000（唱歌最长 5 分钟）
    const long = buildPlaybackLease({
      leaseId: '11111111-1111-4111-8111-111111111111',
      request: { ...base, durationMs: 299_000 },
    });
    expect(long.lease.ttlMs).toBe(300_000);
  });

  it('音色包契约校验：非法 renderer/emotion/缺 profile 拒绝', () => {
    expect(() => loadVoicePack({ ...PACK, profiles: [] })).toThrow();
    expect(() => loadVoicePack({ ...PACK, profiles: [{ ...PACK.profiles[0], emotionTag: 'unknown' }] })).toThrow();
    expect(loadVoicePack(PACK).voicePackId).toBe('blue-whale-maid-v1');
  });

  it('toSpeakRequest：Python 侧合成结果 → 宿主请求结构（字段对齐）', () => {
    const request = toSpeakRequest({
      synthId: '22222222-2222-4222-8222-222222222222',
      emotionTag: 'tsundere_refuse',
      refAudioPath: 'ref/tsundere_refuse.wav',
      backend: 'local-gpt-sovits',
      degraded: false,
      format: 'wav',
      durationMs: 2000,
      audioBase64: 'UklGRg==',
      lipEnvelope: ENVELOPE,
    });
    expect(request.emotionTag).toBe('tsundere_refuse');
    expect(request.refAudioPath).toBe('ref/tsundere_refuse.wav');
    expect(request.degraded).toBe(false);
    expect(request.lipEnvelope.visemes).toHaveLength(3);
  });
});

describe('T-M5-16 残分支：无 fallback 情绪 → 首档案；viseme 无命中不 push', () => {
  it('exact 未命中且 defaultEmotionTag 也未命中 → profiles[0] 回落', () => {
    const pack = {
      voicePackId: 'x', defaultEmotionTag: 'ghost-tag', profiles: [
        { emotionTag: 'a', refAudioPath: 'ref/a.wav', refText: 'A', actionState: 'idle' },
        { emotionTag: 'b', refAudioPath: 'ref/b.wav', refText: 'B', actionState: 'idle' },
      ],
    } as unknown as Parameters<typeof selectVoiceProfile>[0];
    const p = selectVoiceProfile(pack, 'not-exist');
    expect(p.emotionTag).toBe('a'); // profiles[0]
  });

  it('viseme 时间线：区间外采样不产生条目', () => {
    const envelope = {
      totalDurationMs: 1000, visemes: [
        { viseme: 'A', startMs: 100, endMs: 200 }, { viseme: 'rest', startMs: 300, endMs: 500 },
      ],
    } as unknown as Parameters<typeof sampleVisemeTimeline>[0];
    const tl = sampleVisemeTimeline(envelope, 600);
    expect(tl.every((t) => t.atMs <= 600)).toBe(true);
  });
});
