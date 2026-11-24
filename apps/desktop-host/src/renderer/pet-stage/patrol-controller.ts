/**
 * 桌面自主巡逻状态机（T-M6-64，纯逻辑、零 DOM）。
 *
 * 规则：
 *   - 仅空闲/未锁定/未贴边/未拖拽/非睡眠/非忙碌且 `enabled` 时，每 25–45s 低概率开始一次 4–8s 散步；
 *   - 只有当前播放帧落在素材 `moving` 区间内才按 speed（像素/帧）水平推进；
 *   - 严格夹紧在当前显示器 workArea，距左右边缘 ≤8px 自动反转；
 *   - `flipX` 只用于精灵容器镜像，气泡文字绝不翻转。
 */

export interface PatrolBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PatrolMovingRange {
  0: number;
  1: number;
  2: number;
}

export interface PatrolStepInput {
  bounds: PatrolBounds;
  workArea: PatrolBounds;
  facing: 'left' | 'right' | null;
  moving: ReadonlyArray<readonly [number, number, number]> | null;
  frameIndex: number;
  direction: -1 | 1;
  enabled: boolean;
  locked: boolean;
  docked: boolean;
  dragging: boolean;
  asleep: boolean;
  busy: boolean;
}

export interface PatrolState {
  status: 'idle' | 'walking';
  /** 下一次尝试巡逻的时间（毫秒时间戳） */
  nextAt: number;
  /** 本次散步结束时间（idle 时无意义） */
  endsAt: number;
  direction: -1 | 1;
}

export interface PatrolStepResult {
  state: PatrolState;
  /** 本帧水平位移（像素）；0 = 不移动 */
  dx: number;
  /** 精灵是否需要水平镜像（facing 与行进方向不一致时） */
  flipX: boolean;
  walking: boolean;
  /** 本帧刚从 idle 进入 walking：调用方应切到一条带 moving 的散步动作 */
  started: boolean;
  /** 本帧刚结束散步：调用方应切回 idle */
  stopped: boolean;
}

/** 边缘反转阈值（px）。 */
export const PATROL_EDGE_MARGIN = 8;
/** 尝试间隔 25–45s；开始概率 35%；散步 4–8s。 */
export const PATROL_MIN_GAP_MS = 25_000;
export const PATROL_MAX_GAP_MS = 45_000;
export const PATROL_START_CHANCE = 0.35;
export const PATROL_MIN_DURATION_MS = 4_000;
export const PATROL_MAX_DURATION_MS = 8_000;

function gapMs(rng: () => number): number {
  return PATROL_MIN_GAP_MS + Math.floor(Math.max(0, Math.min(1, rng())) * (PATROL_MAX_GAP_MS - PATROL_MIN_GAP_MS));
}

function durationMs(rng: () => number): number {
  return PATROL_MIN_DURATION_MS + Math.floor(Math.max(0, Math.min(1, rng())) * (PATROL_MAX_DURATION_MS - PATROL_MIN_DURATION_MS));
}

export function createPatrolState(now: number, rng: () => number = Math.random): PatrolState {
  return { status: 'idle', nextAt: now + gapMs(rng), endsAt: 0, direction: 1 };
}

/** 当前是否满足巡逻前提（工作忙碌/睡眠/拖拽/贴边/锁定一律不打扰）。 */
export function canPatrol(input: Omit<PatrolStepInput, 'direction' | 'frameIndex' | 'moving' | 'facing' | 'bounds' | 'workArea'>): boolean {
  return input.enabled && !input.locked && !input.docked && !input.dragging && !input.asleep && !input.busy;
}

function movingSpeedAt(moving: PatrolStepInput['moving'], frameIndex: number): number | null {
  if (moving === null || moving.length === 0) return null;
  for (const range of moving) {
    const [start, end, speed] = range;
    if (frameIndex >= start && frameIndex <= end && Number.isFinite(speed) && speed > 0) return speed;
  }
  return null;
}

function clampX(x: number, bounds: PatrolBounds, workArea: PatrolBounds): number {
  const maxX = workArea.x + Math.max(0, workArea.width - bounds.width);
  return Math.min(Math.max(x, workArea.x), maxX);
}

/**
 * 单帧步进（纯函数）：不修改入参 state/input，返回新 state 与本帧位移。
 * `rng`/`now` 显式传入，便于确定性单测。
 */
export function stepPatrol(
  state: PatrolState,
  input: PatrolStepInput,
  now: number,
  rng: () => number = Math.random,
): PatrolStepResult {
  const eligible = canPatrol(input);
  if (state.status === 'idle') {
    if (!eligible || now < state.nextAt) {
      return { state, dx: 0, flipX: false, walking: false, started: false, stopped: false };
    }
    if (rng() < PATROL_START_CHANCE) {
      const next: PatrolState = {
        status: 'walking',
        nextAt: state.nextAt,
        endsAt: now + durationMs(rng),
        direction: input.direction,
      };
      return {
        state: next,
        dx: 0,
        flipX: input.facing !== null && input.facing !== (input.direction < 0 ? 'left' : 'right'),
        walking: true,
        started: true,
        stopped: false,
      };
    }
    return {
      state: { ...state, nextAt: now + gapMs(rng) },
      dx: 0,
      flipX: false,
      walking: false,
      started: false,
      stopped: false,
    };
  }

  // walking
  if (!eligible || now >= state.endsAt) {
    return {
      state: { status: 'idle', nextAt: now + gapMs(rng), endsAt: 0, direction: state.direction },
      dx: 0,
      flipX: false,
      walking: false,
      started: false,
      stopped: true,
    };
  }

  const speed = movingSpeedAt(input.moving, input.frameIndex);
  let direction = input.direction;
  let x = input.bounds.x;
  if (speed !== null) {
    x += speed * direction;
    const maxX = input.workArea.x + Math.max(0, input.workArea.width - input.bounds.width);
    if (direction < 0 && x - input.workArea.x <= PATROL_EDGE_MARGIN) {
      direction = 1;
      x = input.workArea.x;
    } else if (direction > 0 && maxX - x <= PATROL_EDGE_MARGIN) {
      direction = -1;
      x = maxX;
    }
    x = clampX(x, input.bounds, input.workArea);
  }
  const flipX = input.facing !== null && input.facing !== (direction < 0 ? 'left' : 'right');
  return {
    state: { ...state, direction },
    dx: speed === null ? 0 : Math.round(x - input.bounds.x),
    flipX,
    walking: true,
    started: false,
    stopped: false,
  };
}
