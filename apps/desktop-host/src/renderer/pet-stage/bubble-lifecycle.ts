/**
 * 对话气泡生命周期纯状态机（T-M6-44）。
 *
 * 生命周期只由语音租约事件驱动：
 *   show → waiting → speaking → (completed=hidden | failed/timeout=muted + 文字保留)
 * speaking 中绝不因普通 idle 定时器收起；60s TTL 是合成卡死的兜底。
 */
export type BubblePhase = 'hidden' | 'waiting' | 'speaking' | 'muted';
export type SpeechResultKind = 'completed' | 'failed' | 'timeout' | 'interrupted';

export interface BubbleLifecycleState {
  phase: BubblePhase;
  text: string;
  startedAt: number;
  muted: boolean;
}

export interface BubbleEffect {
  state: BubbleLifecycleState;
  show: boolean;
  hide: boolean;
  muted: boolean;
}

export const BUBBLE_TTL_MS = 60_000;

export function createBubbleLifecycle(): BubbleLifecycleState {
  return { phase: 'hidden', text: '', startedAt: 0, muted: false };
}

export function showBubble(state: BubbleLifecycleState, text: string, now: number, voiceEnabled = true): BubbleEffect {
  const next: BubbleLifecycleState = voiceEnabled
    ? { phase: 'waiting', text, startedAt: now, muted: false }
    : { phase: 'muted', text, startedAt: now, muted: true };
  return { state: next, show: text !== '', hide: text === '', muted: next.muted };
}

/** TTS 开始：进入 speaking；speaking 中任何普通超时/计时器都不应主动收泡。 */
export function speechStarted(state: BubbleLifecycleState): BubbleEffect {
  if (state.phase === 'hidden') return { state, show: false, hide: true, muted: false };
  const next = { ...state, phase: 'speaking' as const };
  return { state: next, show: true, hide: false, muted: false };
}

/** 语音租约回执：completed 立即收；失败/超时保留文字并标静音。 */
export function speechResult(state: BubbleLifecycleState, result: SpeechResultKind): BubbleEffect {
  if (state.phase === 'hidden') return { state, show: false, hide: true, muted: false };
  if (result === 'completed') {
    return { state: createBubbleLifecycle(), show: false, hide: true, muted: false };
  }
  const next: BubbleLifecycleState = { ...state, phase: 'muted', muted: true };
  return { state: next, show: true, hide: false, muted: true };
}

/** 全局 speaker 回到 idle：仅退出等待/播报，静音失败态继续保留文字到 TTL。 */
export function speakerIdle(state: BubbleLifecycleState): BubbleEffect {
  if (state.phase === 'waiting' || state.phase === 'speaking') {
    return { state: createBubbleLifecycle(), show: false, hide: true, muted: false };
  }
  return { state, show: state.phase !== 'hidden', hide: state.phase === 'hidden', muted: state.muted };
}

/** 60s 兜底；muted 文字也在此后收泡，避免永久占用舞台。 */
export function bubbleTick(state: BubbleLifecycleState, now: number, ttlMs = BUBBLE_TTL_MS): BubbleEffect {
  if (state.phase !== 'hidden' && now - state.startedAt >= ttlMs) {
    return { state: createBubbleLifecycle(), show: false, hide: true, muted: false };
  }
  return { state, show: state.phase !== 'hidden', hide: false, muted: state.muted };
}
