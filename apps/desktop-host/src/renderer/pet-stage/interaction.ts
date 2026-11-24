/** 桌宠交互/防打扰纯状态机（T-M6-43 / T-M6-64），不依赖 DOM，便于确定性单测。 */
export type DizzyLevel = 0 | 1 | 2 | 3 | 4;
/** 四档差异化动作：不耐烦→鼓脸→红温→背身赌气。 */
export const DIZZY_ACTIONS = { 0: 'idle', 1: 'thinking_tail_wag', 2: 'clumsy_panic', 3: 'rage_spray', 4: 'hungry_lazy' } as const;
export interface InteractionState {
  dizzy: number;
  level: DizzyLevel;
  asleep: boolean;
  lastShakeAt: number;
  lastDirection: number;
  /** 两段式哄好：0=未哄；1=第一次摸头已降档，等第二次彻底原谅（T-M6-64） */
  coaxStep: 0 | 1;
  /** 工作态被晃记仇 0–14：干活期间不发作，结束后秋后算账（T-M6-64） */
  workGrudge: number;
}
export function createInteractionState(): InteractionState {
  return { dizzy: 0, level: 0, asleep: false, lastShakeAt: 0, lastDirection: 0, coaxStep: 0, workGrudge: 0 };
}
export function levelOf(dizzy: number): DizzyLevel {
  if (dizzy >= 12) return 4;
  if (dizzy >= 8) return 3;
  if (dizzy >= 5) return 2;
  if (dizzy >= 2) return 1;
  return 0;
}

/** 晃动上下文：工作/等回答/多宠同忙时只记仇，不打断干活。 */
export type ShakeContext = 'idle' | 'work' | 'ask' | 'multi';
export type WorkShakeReaction = 'shakeWork' | 'shakeAsk' | 'shakeMulti';

/**
 * 快速左右甩：方向反转且间隔 <160ms 时累积；久未甩自然衰减。
 * - idle：返回当前眩晕档位（沿用旧行为）；
 * - work/ask/multi：累加 workGrudge（0–14），返回对应即时反应键，工作姿态不中断。
 */
export function recordShake(
  state: InteractionState,
  direction: number,
  now: number,
  context: ShakeContext = 'idle',
): DizzyLevel | WorkShakeReaction {
  if (direction === 0) return context === 'idle' ? state.level : reactionFor(context);
  if (now - state.lastShakeAt > 900) {
    state.dizzy = Math.max(0, state.dizzy - 1);
    state.workGrudge = Math.max(0, state.workGrudge - 1);
  }
  const reversed = state.lastDirection !== 0 && Math.sign(direction) !== Math.sign(state.lastDirection) && now - state.lastShakeAt < 160;
  state.lastDirection = direction;
  state.lastShakeAt = now;
  if (context !== 'idle') {
    if (reversed) state.workGrudge = Math.min(14, state.workGrudge + 1);
    return reactionFor(context);
  }
  if (reversed) state.dizzy = Math.min(14, state.dizzy + 1);
  state.level = levelOf(state.dizzy);
  return state.level;
}

function reactionFor(context: ShakeContext): WorkShakeReaction {
  if (context === 'ask') return 'shakeAsk';
  if (context === 'multi') return 'shakeMulti';
  return 'shakeWork';
}

export type WorkGrudgeResult = 'workRedhot' | 'workPuffed' | 'workAnnoyed' | null;

/**
 * 工作结束秋后算账：按记仇值返回对应台词键并同步生气档位；
 * 无论是否发作都清空 workGrudge（下一次重新累计）。
 */
export function settleWorkGrudge(state: InteractionState): WorkGrudgeResult {
  const grudge = state.workGrudge;
  state.workGrudge = 0;
  if (grudge >= 8) {
    state.dizzy = Math.max(state.dizzy, 12);
    state.level = levelOf(state.dizzy);
    return 'workRedhot';
  }
  if (grudge >= 5) {
    state.dizzy = Math.max(state.dizzy, 8);
    state.level = levelOf(state.dizzy);
    return 'workPuffed';
  }
  if (grudge >= 2) {
    state.dizzy = Math.max(state.dizzy, 5);
    state.level = levelOf(state.dizzy);
    return 'workAnnoyed';
  }
  return null;
}

export interface HeadPatResult {
  level: DizzyLevel;
  /** normal=没闹脾气；coaxed=第一次哄；forgiven=第二次彻底原谅 */
  stage: 'normal' | 'coaxed' | 'forgiven';
}

/**
 * 摸头两段式哄好（T-M6-64）：
 *   - level ≥ 3 且尚未哄 → 第一次降到 level 2，返回 coaxed；
 *   - 第二次（或本来就 level < 3）→ 清零，若之前生气返回 forgiven。
 */
export function headPat(state: InteractionState): HeadPatResult {
  if (state.level >= 3 && state.coaxStep === 0) {
    state.coaxStep = 1;
    state.dizzy = 5;
    state.level = 2;
    state.lastDirection = 0;
    return { level: 2, stage: 'coaxed' };
  }
  const wasAngry = state.level > 0 || state.dizzy > 0 || state.coaxStep === 1;
  state.dizzy = 0;
  state.level = 0;
  state.coaxStep = 0;
  state.lastDirection = 0;
  return { level: 0, stage: wasAngry ? 'forgiven' : 'normal' };
}
export function setAsleep(state: InteractionState, asleep: boolean): boolean {
  state.asleep = asleep;
  return state.asleep;
}
/** 睡眠期间阻断随机动作、内心戏、余额提醒与工作气泡；叫醒/唤醒交互例外。 */
export function shouldBlockWhileAsleep(state: InteractionState, kind: 'ambient' | 'thought' | 'rice' | 'work' | 'sleep-talk' | 'wake'): boolean {
  if (!state.asleep) return false;
  return kind !== 'wake' && kind !== 'sleep-talk';
}
export type DockEdge = 'left' | 'right' | null;
/** 松手位置贴近工作区左右边缘（<=16px）则贴边；返回应保留的可见宽度。 */
export function dockEdgeFor(windowBounds: { x: number; width: number }, workArea: { x: number; width: number }, threshold = 16): DockEdge {
  if (windowBounds.x - workArea.x <= threshold) return 'left';
  if (workArea.x + workArea.width - (windowBounds.x + windowBounds.width) <= threshold) return 'right';
  return null;
}
/** 贴边位置：只露 45% 窗口。 */
export function dockedPosition(edge: Exclude<DockEdge, null>, windowBounds: { y: number; width: number }, workArea: { x: number; width: number }): { x: number; y: number } {
  const visible = Math.round(windowBounds.width * 0.45);
  return { x: edge === 'left' ? workArea.x - windowBounds.width + visible : workArea.x + workArea.width - visible, y: windowBounds.y };
}
export function shouldEnterPowerSaver(lastActivityAt: number, now: number, enabled: boolean, idleMs = 30_000): boolean {
  return enabled && now - lastActivityAt >= idleMs;
}
