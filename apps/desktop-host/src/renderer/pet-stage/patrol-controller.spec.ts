/** 自主巡逻状态机（T-M6-64）：25–45s 触发窗口、moving 帧区间位移、边缘反转与前提拦截。 */
import { describe, expect, it } from 'vitest';
import {
  canPatrol,
  createPatrolState,
  PATROL_EDGE_MARGIN,
  PATROL_MAX_GAP_MS,
  PATROL_MAX_DURATION_MS,
  PATROL_MIN_GAP_MS,
  PATROL_MIN_DURATION_MS,
  stepPatrol,
  type PatrolStepInput,
} from './patrol-controller';

const bounds = (x: number) => ({ x, y: 100, width: 200, height: 140 });
const workArea = { x: 0, y: 0, width: 1000, height: 800 };

function input(overrides: Partial<PatrolStepInput> = {}): PatrolStepInput {
  return {
    bounds: bounds(100),
    workArea,
    facing: 'left',
    moving: [[0, 10, 2]],
    frameIndex: 3,
    direction: 1,
    enabled: true,
    locked: false,
    docked: false,
    dragging: false,
    asleep: false,
    busy: false,
    ...overrides,
  };
}

/** 固定随机序列，便于断言触发/时长。 */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

describe('createPatrolState / canPatrol', () => {
  it('首次尝试落在 25–45s；初始方向朝右', () => {
    const state = createPatrolState(1_000, () => 0);
    expect(state.status).toBe('idle');
    expect(state.nextAt).toBe(1_000 + PATROL_MIN_GAP_MS);
    expect(state.direction).toBe(1);
    const late = createPatrolState(0, () => 0.999);
    expect(late.nextAt).toBeGreaterThanOrEqual(PATROL_MAX_GAP_MS - 100);
    expect(late.nextAt).toBeLessThanOrEqual(PATROL_MAX_GAP_MS);
  });

  it('锁定/贴边/拖拽/睡眠/忙碌/关闭任一命中都不能巡逻', () => {
    const base = { enabled: true, locked: false, docked: false, dragging: false, asleep: false, busy: false };
    expect(canPatrol(base)).toBe(true);
    for (const key of ['enabled', 'locked', 'docked', 'dragging', 'asleep', 'busy'] as const) {
      expect(canPatrol({ ...base, [key]: key === 'enabled' ? false : true }), key).toBe(false);
    }
  });
});

describe('stepPatrol：触发与结束', () => {
  it('未到时间不动作；到点 rng 命中后开始 4–8s 散步', () => {
    const state = createPatrolState(0, () => 0);
    const early = stepPatrol(state, input(), state.nextAt - 1, () => 0);
    expect(early.started).toBe(false);
    expect(early.state).toEqual(state);

    const started = stepPatrol(state, input(), state.nextAt, sequence([0.1, 0.5]));
    expect(started.started).toBe(true);
    expect(started.walking).toBe(true);
    const duration = started.state.endsAt - state.nextAt;
    expect(duration).toBeGreaterThanOrEqual(PATROL_MIN_DURATION_MS);
    expect(duration).toBeLessThanOrEqual(PATROL_MAX_DURATION_MS);
  });

  it('低概率未命中：重新排 25–45s，不进入 walking', () => {
    const state = createPatrolState(0, () => 0);
    const result = stepPatrol(state, input(), state.nextAt, sequence([0.99, 0.5]));
    expect(result.started).toBe(false);
    expect(result.state.status).toBe('idle');
    expect(result.state.nextAt - state.nextAt).toBeGreaterThanOrEqual(PATROL_MIN_GAP_MS);
  });

  it('到时长自动结束 stopped=true 并回到 idle', () => {
    const state = { status: 'walking' as const, nextAt: 0, endsAt: 5_000, direction: 1 as const };
    const result = stepPatrol(state, input(), 5_000, () => 0);
    expect(result.stopped).toBe(true);
    expect(result.state.status).toBe('idle');
  });
});

describe('stepPatrol：帧区间驱动位移', () => {
  it('帧在 moving 区间内按 speed×direction 位移；区间外不移动', () => {
    const state = { status: 'walking' as const, nextAt: 0, endsAt: 10_000, direction: 1 as const };
    const moved = stepPatrol(state, input({ frameIndex: 5 }), 1_000);
    expect(moved.dx).toBe(2);
    expect(moved.walking).toBe(true);
    const idleFrame = stepPatrol(state, input({ frameIndex: 11 }), 1_000);
    expect(idleFrame.dx).toBe(0);
    expect(idleFrame.walking).toBe(true);
    const noMoving = stepPatrol(state, input({ moving: null }), 1_000);
    expect(noMoving.dx).toBe(0);
  });

  it('右边缘 ≤8px 自动反转并夹紧；左边缘同理', () => {
    const state = { status: 'walking' as const, nextAt: 0, endsAt: 10_000, direction: 1 as const };
    const right = stepPatrol(state, input({ bounds: bounds(795), frameIndex: 5 }), 1_000);
    expect(right.state.direction).toBe(-1);
    expect(right.dx).toBe(5); // 795 + 2 = 797，距 maxX(800) 3px → 反转到 800
    expect(right.flipX).toBe(false); // facing=left，反转后朝左 → 不镜像

    const left = stepPatrol({ ...state, direction: -1 }, input({ bounds: bounds(3), frameIndex: 5, facing: 'right', direction: -1 }), 1_000);
    expect(left.state.direction).toBe(1);
    expect(left.dx).toBe(-3);
  });

  it('flipX 由 facing 与行进方向计算；facing 未知不镜像', () => {
    const state = { status: 'walking' as const, nextAt: 0, endsAt: 10_000, direction: 1 as const };
    expect(stepPatrol(state, input({ facing: 'left' }), 1_000).flipX).toBe(true);
    expect(stepPatrol(state, input({ facing: 'right' }), 1_000).flipX).toBe(false);
    expect(stepPatrol(state, input({ facing: null }), 1_000).flipX).toBe(false);
  });

  it('巡逻中变忙碌/睡眠/贴边/拖拽/锁定时立即停下', () => {
    const state = { status: 'walking' as const, nextAt: 0, endsAt: 10_000, direction: 1 as const };
    for (const key of ['busy', 'asleep', 'docked', 'dragging', 'locked'] as const) {
      const result = stepPatrol(state, input({ [key]: true }), 1_000);
      expect(result.stopped, key).toBe(true);
      expect(result.state.status, key).toBe('idle');
    }
  });

  it('workArea 小于窗口时不出现负宽越界（夹紧到 left）', () => {
    const state = { status: 'walking' as const, nextAt: 0, endsAt: 10_000, direction: -1 as const };
    const result = stepPatrol(state, input({ bounds: bounds(10), workArea: { x: 0, y: 0, width: 50, height: 100 }, frameIndex: 5 }), 1_000);
    expect(result.dx).toBe(-10);
    expect(PATROL_EDGE_MARGIN).toBe(8);
  });
});
