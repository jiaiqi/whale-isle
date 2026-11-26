/**
 * 气泡生命周期纯状态机（T-M6-44 + 多类型自动隐藏扩展）。
 *
 * 对话语音轨仍严格由语音租约事件驱动：
 *   show → waiting → speaking → (completed=hidden | failed/timeout=muted + 文字保留)
 * speaking 中绝不因普通 idle 定时器收起；60s TTL 是合成卡死的兜底。
 *
 * 多类型调度槽位为各语义气泡提供差异化默认显示时长（6s~16s）。
 */
import type { BubbleKind } from './widgets/bubble-types';

export type BubblePhase = 'hidden' | 'waiting' | 'speaking' | 'muted';
export type SpeechResultKind = 'completed' | 'failed' | 'timeout' | 'interrupted' | 'cancelled';

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

export const BUBBLE_KIND_TTL_MS: Record<BubbleKind, number> = {
  thought: 12_000,
  dialog: 10_000,
  status: 16_000,
  notice: 8_000,
  reaction: 6_000,
  hint: 9_000,
};

export interface BubbleSlotEntry {
  kind: BubbleKind;
  text: string;
  shownAt: number;
  /** null 表示由语音租约托管（不走普通自动隐藏超时） */
  expiresAt: number | null;
}

export type BubbleScheduleState = Partial<Record<BubbleKind, BubbleSlotEntry>>;

export function ttlForBubbleKind(kind: BubbleKind, overrideMs?: number): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.min(BUBBLE_TTL_MS, Math.max(1_500, Math.round(overrideMs)));
  }
  return BUBBLE_KIND_TTL_MS[kind];
}

export function createBubbleSchedule(): BubbleScheduleState {
  return {};
}

export function scheduleBubbleSlot(
  state: BubbleScheduleState,
  kind: BubbleKind,
  text: string,
  now: number,
  opts?: { ttlMs?: number; voiceManaged?: boolean },
): BubbleScheduleState {
  const next: BubbleScheduleState = { ...state };
  if (text.trim() === '') {
    delete next[kind];
    return next;
  }
  const expiresAt = opts?.voiceManaged === true ? null : now + ttlForBubbleKind(kind, opts?.ttlMs);
  next[kind] = { kind, text, shownAt: now, expiresAt };
  return next;
}

export function cancelBubbleSlot(state: BubbleScheduleState, kind: BubbleKind): BubbleScheduleState {
  if (state[kind] === undefined) return state;
  const next: BubbleScheduleState = { ...state };
  delete next[kind];
  return next;
}

export function tickBubbleSchedule(
  state: BubbleScheduleState,
  now: number,
): { state: BubbleScheduleState; expired: BubbleKind[] } {
  const expired: BubbleKind[] = [];
  const next: BubbleScheduleState = {};
  for (const entry of Object.values(state)) {
    if (entry === undefined) continue;
    if (entry.expiresAt !== null && now >= entry.expiresAt) {
      expired.push(entry.kind);
    } else {
      next[entry.kind] = entry;
    }
  }
  return { state: expired.length === 0 ? state : next, expired };
}

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

/** 语音租约回执：completed/cancelled 立即收（主动取消不留残泡）；失败/超时保留文字并标静音。 */
export function speechResult(state: BubbleLifecycleState, result: SpeechResultKind): BubbleEffect {
  if (state.phase === 'hidden') return { state, show: false, hide: true, muted: false };
  if (result === 'completed' || result === 'cancelled') {
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
