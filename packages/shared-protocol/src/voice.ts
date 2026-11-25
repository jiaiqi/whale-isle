/**
 * Whale Isle V2 — VoiceProvider / 口型同步 / 多轨 AudioMixer 共享契约（V2-P1-02）
 * - 零外部依赖（仅 zod），避免循环导入 index.ts
 * - 区分真实角色 TTS / 本地 Worker / 系统降级 / 未适配，禁止将系统 TTS 冒充角色音色
 */
import { z } from 'zod';

export const VoiceProviderKindSchema = z.enum([
  'openai-compatible-tts',
  'minimax-tts',
  'local-audio-worker',
  'mcode-cli',
  'macos-say',
  'windows-sapi',
  'unsupported',
]);
export type VoiceProviderKind = z.infer<typeof VoiceProviderKindSchema>;

export const VoiceBackendQualitySchema = z.enum([
  'character_tts',
  'local_worker',
  'system_fallback',
  'unsupported',
]);
export type VoiceBackendQuality = z.infer<typeof VoiceBackendQualitySchema>;

export const VoiceProviderStatusSchema = z.object({
  kind: VoiceProviderKindSchema,
  quality: VoiceBackendQualitySchema,
  available: z.boolean(),
  degraded: z.boolean().default(false),
  platform: z.string().min(1),
  detail: z.string().min(1),
  supportsStreaming: z.boolean().default(false),
  supportsEmotion: z.boolean().default(false),
});
export type VoiceProviderStatus = z.output<typeof VoiceProviderStatusSchema>;

export const LipSyncVisemeSchema = z.enum(['closed', 'wide', 'round', 'open', 'teeth']);
export type LipSyncViseme = z.infer<typeof LipSyncVisemeSchema>;

export const LipSyncFrameSchema = z.object({
  timestampMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  viseme: LipSyncVisemeSchema,
  amplitude: z.number().min(0).max(1),
  rmsDb: z.number().min(-120).max(0),
});
export type LipSyncFrame = z.infer<typeof LipSyncFrameSchema>;

export const VoiceStyleModeSchema = z.enum(['normal', 'inner', 'p0', 'singing']);
export type VoiceStyleMode = z.infer<typeof VoiceStyleModeSchema>;

export const VoiceSynthesisRequestSchema = z.object({
  requestId: z.string().min(1),
  characterId: z.string().min(1),
  voiceRef: z.string().min(1),
  text: z.string().min(1).max(4000),
  emotion: z.string().min(1).default('neutral'),
  styleMode: VoiceStyleModeSchema.default('normal'),
  speed: z.number().min(0.5).max(2.0).default(1.0),
  pitchShiftSemitones: z.number().min(-12).max(12).default(0),
  volume: z.number().min(0).max(1).default(1.0),
  outputDeviceId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
});
export type VoiceSynthesisRequest = z.output<typeof VoiceSynthesisRequestSchema>;
export type VoiceSynthesisRequestInput = z.input<typeof VoiceSynthesisRequestSchema>;

export const VoiceSynthesisOutputSchema = z.object({
  requestId: z.string().min(1),
  providerKind: VoiceProviderKindSchema,
  quality: VoiceBackendQualitySchema,
  degraded: z.boolean().default(false),
  degradedFrom: VoiceProviderKindSchema.optional(),
  format: z.enum(['wav', 'mp3', 'ogg', 'pcm', 'system-direct']),
  sampleRate: z.number().int().positive().default(24_000),
  durationMs: z.number().nonnegative(),
  audioBase64: z.string().optional(),
  lipFrames: z.array(LipSyncFrameSchema).default([]),
  cached: z.boolean().default(false),
  latencyMs: z.number().nonnegative().default(0),
});
export type VoiceSynthesisOutput = z.output<typeof VoiceSynthesisOutputSchema>;

export const AudioTrackKindSchema = z.enum(['speech', 'bgm', 'sfx', 'singing']);
export type AudioTrackKind = z.infer<typeof AudioTrackKindSchema>;

export const AudioTrackStateSchema = z.object({
  trackId: z.string().min(1),
  kind: AudioTrackKindSchema,
  label: z.string().min(1),
  playing: z.boolean(),
  gain: z.number().min(0).max(2).default(1),
  effectiveGain: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  ducked: z.boolean().default(false),
  outputDeviceId: z.string().min(1).default('default'),
  startedAt: z.number().int().nonnegative().optional(),
});
export type AudioTrackState = z.output<typeof AudioTrackStateSchema>;

export const SpeechFloorHolderSchema = z.object({
  leaseId: z.string().min(1),
  agentId: z.string().min(1),
  characterId: z.string().min(1),
  speakerName: z.string().min(1),
  voiceRef: z.string().min(1),
});
export type SpeechFloorHolder = z.infer<typeof SpeechFloorHolderSchema>;

export const AudioMixerSnapshotSchema = z.object({
  speechFloorHolder: SpeechFloorHolderSchema.nullable(),
  speechQueueLength: z.number().int().nonnegative(),
  duckingActive: z.boolean(),
  duckingGainMultiplier: z.number().min(0).max(1),
  tracks: z.array(AudioTrackStateSchema),
  outputRoutes: z.record(AudioTrackKindSchema, z.string()),
});
export type AudioMixerSnapshot = z.output<typeof AudioMixerSnapshotSchema>;
