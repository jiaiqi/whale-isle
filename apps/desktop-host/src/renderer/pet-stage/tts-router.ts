/**
 * 情绪感知 TTS 路由（宿主侧，T-M2-02，SPEC §3.4）。
 *
 * 职责分工：
 *   Python 侧（tts_engine）—— 情绪 → 参考音频匹配 + 推理 + 口型包络生成；
 *   宿主侧（本模块）—— 情绪 → 桌宠动作映射 + 参考音频选择 + 语音租约组装 + 播放编排。
 *
 * 门禁（ROADMAP T-M2-02）：传入 `[傲娇反驳]` 标签文本 → 正确匹配傲娇参考音频
 * → 返回有效音频流与口型包络。
 */
import {
  TtsVoicePackSchema,
  type EmotionVoiceProfile,
  type LipEnvelope,
  type PetActionState,
  type TtsSynthesisResult,
  type TtsVoicePack,
} from '@workbench/shared-protocol';

/** 情绪 → 桌宠动作映射（SPEC §3.4：同时驱动桌宠切换对应 .webm 动作） */
export const EMOTION_ACTION_MAP: Record<string, PetActionState> = {
  sweet_normal: 'happy_maid',
  tsundere_refuse: 'happy_maid',
  rage_spray: 'rage_spray',
  lazy_yawn: 'hungry_lazy',
  happy_rice: 'eat_rice',
};

/** 参考音频选择：按 emotionTag 取 profile；未登记则回落默认情绪（契约层拒绝非法值） */
export function selectVoiceProfile(
  pack: TtsVoicePack,
  emotionTag: string,
): EmotionVoiceProfile {
  const exact = pack.profiles.find((profile) => profile.emotionTag === emotionTag);
  const fallback = pack.profiles.find((profile) => profile.emotionTag === pack.defaultEmotionTag);
  const profile = exact ?? fallback ?? pack.profiles[0];
  if (!profile) throw new Error(`音色包 ${pack.voicePackId} 无任何情绪档案`);
  return profile;
}

/** 情绪 → 动作（未登记情绪回落到 idle，不影响语音播放） */
export function actionForEmotion(emotionTag: string): PetActionState {
  return EMOTION_ACTION_MAP[emotionTag] ?? 'idle';
}

/** 校验并规范化音色包（运行期只消费 Schema 校验过的配置） */
export function loadVoicePack(raw: unknown): TtsVoicePack {
  return TtsVoicePackSchema.parse(raw);
}

export interface SpeakRequest {
  /** 带情绪前缀的文本（如 "[傲娇反驳] 哼，本鱼才没有偷懒！"） */
  text: string;
  emotionTag: string;
  audioBase64: string;
  durationMs: number;
  lipEnvelope: LipEnvelope;
  refAudioPath: string;
  backend: string;
  degraded: boolean;
}

/** 口型包络 → 某时刻的口型（口型驱动：取当前时间命中的 viseme） */
export function visemeAt(envelope: LipEnvelope, positionMs: number): string | null {
  for (const item of envelope.visemes) {
    if (positionMs >= item.startMs && positionMs < item.startMs + item.durationMs) {
      return item.viseme;
    }
  }
  return null;
}

/** 口型驱动采样序列（供渲染层按 rAF 推进；步长可配） */
export function sampleVisemeTimeline(
  envelope: LipEnvelope,
  stepMs = 60,
): Array<{ atMs: number; viseme: string }> {
  const timeline: Array<{ atMs: number; viseme: string }> = [];
  for (let at = 0; at < envelope.totalDurationMs; at += stepMs) {
    const viseme = visemeAt(envelope, at);
    if (viseme) timeline.push({ atMs: at, viseme });
  }
  return timeline;
}

/**
 * 合成结果 → 语音租约组装（对齐 AudioPlaybackLease 契约）。
 * ttlMs 默认 = 音频时长 + 缓冲（合成慢/播不完时强制释放，见 T-M2-01 语音锁）。
 */
export function buildPlaybackLease(input: {
  leaseId: string;
  request: SpeakRequest;
  priority?: 'P0_INTERRUPT' | 'P1_CADENCE' | 'P2_IDLE';
  sourceModule?: 'persona-talk' | 'svc-singing' | 'reflex-interrupt' | 'system-alert';
  innerThoughtText?: string;
}): {
  lease: {
    leaseId: string;
    sourceModule: 'persona-talk' | 'svc-singing' | 'reflex-interrupt' | 'system-alert';
    priority: 'P0_INTERRUPT' | 'P1_CADENCE' | 'P2_IDLE';
    ttlMs: number;
    emotionTag: string;
    textSubtitle: string;
    innerThoughtText?: string;
    audioUrlOrBase64: string;
    actionState: PetActionState;
  };
  visemeTimeline: Array<{ atMs: number; viseme: string }>;
} {
  const priority = input.priority ?? 'P1_CADENCE';
  const sourceModule = input.sourceModule ?? 'persona-talk';
  const ttlMs = Math.max(500, Math.min(300_000, input.request.durationMs + 3_000));
  return {
    lease: {
      leaseId: input.leaseId,
      sourceModule,
      priority,
      ttlMs,
      emotionTag: input.request.emotionTag,
      textSubtitle: input.request.text,
      innerThoughtText: input.innerThoughtText,
      audioUrlOrBase64: input.request.audioBase64,
      actionState: actionForEmotion(input.request.emotionTag),
    },
    visemeTimeline: sampleVisemeTimeline(input.request.lipEnvelope),
  };
}

/** 合成结果（Python 侧）→ 宿主请求结构（字段名对齐 TtsSynthesisResultSchema） */
export function toSpeakRequest(result: TtsSynthesisResult): SpeakRequest {
  return {
    text: '',
    emotionTag: result.emotionTag,
    audioBase64: result.audioBase64,
    durationMs: result.durationMs,
    lipEnvelope: result.lipEnvelope,
    refAudioPath: result.refAudioPath,
    backend: result.backend,
    degraded: result.degraded,
  };
}
