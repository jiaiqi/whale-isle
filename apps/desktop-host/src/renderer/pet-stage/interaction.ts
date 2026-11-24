/** 桌宠交互/防打扰纯状态机（T-M6-43），不依赖 DOM，便于确定性单测。 */
export type DizzyLevel = 0 | 1 | 2 | 3 | 4;
/** 四档差异化动作：不耐烦→鼓脸→红温→背身赌气。 */
export const DIZZY_ACTIONS = { 0: 'idle', 1: 'thinking_tail_wag', 2: 'clumsy_panic', 3: 'rage_spray', 4: 'hungry_lazy' } as const;
export interface InteractionState {
  dizzy: number;
  level: DizzyLevel;
  asleep: boolean;
  lastShakeAt: number;
  lastDirection: number;
}
export function createInteractionState(): InteractionState { return { dizzy: 0, level: 0, asleep: false, lastShakeAt: 0, lastDirection: 0 }; }
export function levelOf(dizzy: number): DizzyLevel {
  if (dizzy >= 12) return 4;
  if (dizzy >= 8) return 3;
  if (dizzy >= 5) return 2;
  if (dizzy >= 2) return 1;
  return 0;
}
/** 快速左右甩：方向反转且间隔 <160ms 时累积；久未甩自然衰减。 */
export function recordShake(state: InteractionState, direction: number, now: number): DizzyLevel {
  if (direction === 0) return state.level;
  if (now - state.lastShakeAt > 900) state.dizzy = Math.max(0, state.dizzy - 1);
  if (state.lastDirection !== 0 && Math.sign(direction) !== Math.sign(state.lastDirection) && now - state.lastShakeAt < 160) {
    state.dizzy = Math.min(14, state.dizzy + 1);
  }
  state.lastDirection = direction;
  state.lastShakeAt = now;
  state.level = levelOf(state.dizzy);
  return state.level;
}
export function headPat(state: InteractionState): DizzyLevel {
  state.dizzy = 0;
  state.level = 0;
  state.lastDirection = 0;
  return 0;
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
