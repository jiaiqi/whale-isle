import { describe, expect, it } from 'vitest';
import { createThrow, velocityFromSamples, type DragSample } from './drag-throw';

/** [SIMULATION] T-M1-02：拖拽甩抛物理（测速 / 重力反弹 / 落定与冲击） */

const BOUNDS = { minX: 0, minY: 0, maxX: 800, maxY: 600 };

describe('velocityFromSamples', () => {
  it('线性运动测速（120ms 窗口内首尾差分）', () => {
    const samples: DragSample[] = [
      { t: 0, x: 0, y: 0 },
      { t: 50, x: 50, y: 0 },
      { t: 100, x: 100, y: 0 },
      { t: 150, x: 150, y: 0 },
    ];
    const { vx, vy } = velocityFromSamples(samples);
    expect(vx).toBeCloseTo(1000, 0); // 窗口内 t=50→150：dx=100px / dt=0.1s
    expect(vy).toBe(0);
  });

  it('静止拖拽释放速度为零；样本不足为零', () => {
    expect(velocityFromSamples([{ t: 0, x: 5, y: 5 }])).toEqual({ vx: 0, vy: 0 });
    expect(velocityFromSamples([])).toEqual({ vx: 0, vy: 0 });
    const still: DragSample[] = [
      { t: 0, x: 5, y: 5 },
      { t: 200, x: 5, y: 5 },
    ];
    const { vx, vy } = velocityFromSamples(still, 120);
    expect(vx).toBe(0);
    expect(vy).toBe(0);
  });
});

describe('createThrow（甩出物理）', () => {
  it('重力下坠 + 触底反弹（vy 反向衰减）', () => {
    const sim = createThrow({ start: { x: 100, y: 100 }, velocity: { vx: 0, vy: 0 }, bounds: BOUNDS, gravity: 1000 });
    let hitBottom = false;
    for (let i = 0; i < 200 && !hitBottom; i++) {
      const pos = sim.step(16);
      if (pos.y >= BOUNDS.maxY) hitBottom = true;
    }
    expect(hitBottom).toBe(true);
    const impact = sim.landingImpact();
    expect(impact).not.toBeNull();
    expect(impact as number).toBeGreaterThan(100);
    // 反弹后短暂上升
    const after = sim.step(16);
    expect(after.y).toBeLessThan(BOUNDS.maxY);
  });

  it('左右墙反弹并夹紧边界（撞墙后速度反向）', () => {
    const sim = createThrow({
      start: { x: 10, y: 300 },
      velocity: { vx: -2000, vy: 0 },
      bounds: BOUNDS,
      gravity: 0,
      friction: 1,
      stopSpeed: 0,
      restitution: 0.55,
    });
    // 第一步撞左墙：位置夹紧到 minX
    const first = sim.step(16); // dx = -32 → x = -22 → 夹紧 0
    expect(first.x).toBe(BOUNDS.minX);
    // 第二步向右反弹（vx = 2000×0.55 = 1100）
    const second = sim.step(16);
    expect(second.x).toBeGreaterThan(BOUNDS.minX);
    expect(sim.done()).toBe(false);
  });

  it('低速触底后落定（done）并停在下边界', () => {
    const sim = createThrow({
      start: { x: 400, y: BOUNDS.maxY - 2 },
      velocity: { vx: 10, vy: 5 },
      bounds: BOUNDS,
      gravity: 1000,
      stopSpeed: 30,
    });
    for (let i = 0; i < 400 && !sim.done(); i++) sim.step(16);
    expect(sim.done()).toBe(true);
    expect(sim.position().y).toBeCloseTo(BOUNDS.maxY, 0);
  });

  it('超时强制落定（maxDurationMs 防永动）', () => {
    const sim = createThrow({
      start: { x: 0, y: 0 },
      velocity: { vx: 500, vy: -1000 },
      bounds: BOUNDS,
      gravity: 0,
      restitution: 1,
      friction: 1,
      stopSpeed: 1,
      maxDurationMs: 300,
    });
    let steps = 0;
    while (!sim.done() && steps < 500) {
      sim.step(16);
      steps += 1;
    }
    expect(sim.done()).toBe(true);
  });

  it('右墙反弹（maxX 语义）', () => {
    const sim = createThrow({
      start: { x: BOUNDS.maxX - 5, y: 300 },
      velocity: { vx: 2000, vy: 0 },
      bounds: BOUNDS,
      gravity: 0,
      friction: 1,
      stopSpeed: 0,
      restitution: 0.5,
    });
    const first = sim.step(16); // dx=+32 → 越界 → 夹紧 maxX
    expect(first.x).toBe(BOUNDS.maxX);
    const second = sim.step(16); // 反弹向左
    expect(second.x).toBeLessThan(BOUNDS.maxX);
  });

  it('上抛撞顶边反弹（minY 语义）', () => {
    const sim = createThrow({
      start: { x: 400, y: BOUNDS.maxY - 10 },
      velocity: { vx: 0, vy: -3000 },
      bounds: BOUNDS,
      gravity: 0,
      friction: 1,
      stopSpeed: 0,
      restitution: 0.5,
    });
    let bouncedTop = false;
    for (let i = 0; i < 80; i++) {
      const pos = sim.step(16);
      if (pos.y <= BOUNDS.minY + 0.01) bouncedTop = true;
    }
    expect(bouncedTop).toBe(true); // 顶边被夹到 minY 后向下反弹
  });

  it('时间戳相同（dt<=0）测速为零', () => {
    const samples: DragSample[] = [
      { t: 100, x: 0, y: 0 },
      { t: 100, x: 500, y: 500 },
    ];
    expect(velocityFromSamples(samples)).toEqual({ vx: 0, vy: 0 });
  });

  it('边界夹紧：位置永不越界', () => {
    const sim = createThrow({ start: { x: -50, y: 700 }, velocity: { vx: 0, vy: 0 }, bounds: BOUNDS });
    const pos = sim.step(16);
    expect(pos.x).toBeGreaterThanOrEqual(BOUNDS.minX);
    expect(pos.y).toBeLessThanOrEqual(BOUNDS.maxY);
  });
});
