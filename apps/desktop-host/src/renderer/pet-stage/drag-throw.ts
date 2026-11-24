/**
 * 拖拽甩抛物理（T-M1-02，dsh-pet 概念）。
 *
 * 拖拽期：窗口跟随鼠标（主进程 setPosition，DIP 坐标，多屏异构 DPI 由 Electron 原生处理）。
 * 甩出期：重力 + 屏幕边界反弹（restitution）+ 水平摩擦，落定后返回冲击速度（驱动 Q 弹）。
 * 甩抛边界为释放时所在屏幕的可达 workArea（主进程扣除窗口尺寸后经 preload 注入）。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Velocity2 {
  vx: number;
  vy: number;
}

export interface DragSample {
  t: number;
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 由拖拽采样估计释放速度（px/s）：取窗口内的首尾样本，dt 无效时返回零向量 */
export function velocityFromSamples(samples: DragSample[], windowMs = 120): Velocity2 {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  if (!last) return { vx: 0, vy: 0 };
  let first: DragSample | undefined;
  for (const sample of samples) {
    if (last.t - sample.t <= windowMs) {
      first = sample;
      break;
    }
  }
  const effective = first ?? samples[0];
  if (!effective || effective === last) return { vx: 0, vy: 0 };
  const dt = (last.t - effective.t) / 1000;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - effective.x) / dt, vy: (last.y - effective.y) / dt };
}

export interface ThrowOptions {
  start: Vec2;
  velocity: Velocity2;
  bounds: Bounds;
  /** 重力加速度 px/s² */
  gravity?: number;
  /** 反弹恢复系数 */
  restitution?: number;
  /** 水平摩擦（每秒保留比例） */
  friction?: number;
  /** 低于该合速度(px/s)且已触底 → 落定 */
  stopSpeed?: number;
  maxDurationMs?: number;
}

export interface ThrowSim {
  step(dtMs: number): Vec2;
  position(): Vec2;
  /** 首次触底的冲击速度（|vy|，供 Q 弹 squashAt 的 impact） */
  landingImpact(): number | null;
  done(): boolean;
}

const DEFAULTS = { gravity: 1800, restitution: 0.55, friction: 0.35, stopSpeed: 40, maxDurationMs: 6000 };

/**
 * 无重力轻惯性（T-M6-19 glide 模式）：沿释放速度短距滑行，摩擦衰减后停在落点附近，
 * 绝不往屏幕底部掉。边界须为「窗口左上角可达区域」（main 的 windowBounds）。
 */
export function createGlide(options: ThrowOptions): ThrowSim {
  const cfg = { ...DEFAULTS, ...options, gravity: 0, restitution: 0, maxDurationMs: 450 };
  let x = options.start.x;
  let y = options.start.y;
  let vx = options.velocity.vx;
  let vy = options.velocity.vy;
  let elapsedMs = 0;
  const clampX = (n: number) => Math.min(Math.max(n, options.bounds.minX), options.bounds.maxX);
  const clampY = (n: number) => Math.min(Math.max(n, options.bounds.minY), options.bounds.maxY);
  return {
    step(dtMs: number): Vec2 {
      if (this.done()) return { x, y };
      const dt = Math.max(dtMs, 0) / 1000;
      elapsedMs += dtMs;
      vx *= Math.pow(cfg.friction, dt);
      vy *= Math.pow(cfg.friction, dt);
      x = clampX(x + vx * dt);
      y = clampY(y + vy * dt);
      return { x, y };
    },
    position() {
      return { x, y };
    },
    landingImpact() {
      return null; // 无重力不触底，Q 弹用释放速度另算
    },
    done() {
      return Math.hypot(vx, vy) < cfg.stopSpeed || elapsedMs >= cfg.maxDurationMs;
    },
  };
}

export function createThrow(options: ThrowOptions): ThrowSim {
  const cfg = { ...DEFAULTS, ...options };
  const clampX = (x: number) => Math.min(Math.max(x, options.bounds.minX), options.bounds.maxX);
  const clampY = (y: number) => Math.min(Math.max(y, options.bounds.minY), options.bounds.maxY);

  let x = options.start.x;
  let y = options.start.y;
  let vx = options.velocity.vx;
  let vy = options.velocity.vy;
  let landed = false;
  let impact: number | null = null;
  let elapsedMs = 0;

  return {
    step(dtMs: number): Vec2 {
      if (this.done()) return { x, y };
      const dt = Math.max(dtMs, 0) / 1000;
      elapsedMs += dtMs;
      vy += cfg.gravity * dt;
      vx *= Math.pow(cfg.friction, dt);
      x += vx * dt;
      y += vy * dt;

      // 左右墙反弹
      if (x < options.bounds.minX) {
        x = options.bounds.minX;
        vx = Math.abs(vx) * cfg.restitution;
      } else if (x > options.bounds.maxX) {
        x = options.bounds.maxX;
        vx = -Math.abs(vx) * cfg.restitution;
      }
      // 触底/触顶反弹
      if (y >= options.bounds.maxY) {
        if (!landed) {
          landed = true;
          impact = Math.abs(vy);
        }
        y = options.bounds.maxY;
        if (vy > 0) vy = -vy * cfg.restitution;
      } else if (y < options.bounds.minY) {
        y = options.bounds.minY;
        if (vy < 0) vy = Math.abs(vy) * cfg.restitution;
      }
      return { x: clampX(x), y: clampY(y) };
    },
    position(): Vec2 {
      return { x, y };
    },
    landingImpact(): number | null {
      return impact;
    },
    done(): boolean {
      const speed = Math.hypot(vx, vy);
      const atRest = landed && y >= options.bounds.maxY - 0.5 && speed < cfg.stopSpeed;
      return atRest || elapsedMs >= cfg.maxDurationMs;
    },
  };
}

export interface SlingshotOptions {
  start: Vec2;
  bounds: Bounds;
  /** 弹射方向：-1 左 / 1 右 */
  direction: -1 | 1;
  amplitudePx?: number;
  /** 阻尼时间常数（ms），越短回弹越快 */
  dampingMs?: number;
  /** 一次完整摆动周期（ms） */
  periodMs?: number;
  maxDurationMs?: number;
}

/**
 * 双击弹弓：在 drag-throw 同一窗口坐标模型上做带阻尼的弹簧位移。
 * t=0 在原位，半个周期到达最大位移，之后衰减回原点；绝不产生永久位移。
 */
export function createSlingshot(options: SlingshotOptions): ThrowSim {
  const amplitude = Math.max(8, options.amplitudePx ?? 90);
  const dampingMs = Math.max(80, options.dampingMs ?? 260);
  const periodMs = Math.max(160, options.periodMs ?? 520);
  const maxDurationMs = Math.max(periodMs, options.maxDurationMs ?? 1_600);
  let t = 0;
  let x = options.start.x;
  let y = options.start.y;
  return {
    step(dtMs: number): Vec2 {
      if (this.done()) return { x: options.start.x, y: options.start.y };
      t = Math.min(maxDurationMs, t + Math.max(0, dtMs));
      const envelope = Math.exp(-t / dampingMs);
      const offset = options.direction * amplitude * envelope * Math.sin((Math.PI * 2 * t) / periodMs);
      x = Math.min(Math.max(options.start.x + offset, options.bounds.minX), options.bounds.maxX);
      y = options.start.y;
      if (this.done()) { x = options.start.x; y = options.start.y; }
      return { x, y };
    },
    position() { return { x, y }; },
    landingImpact() { return null; },
    done() { return t >= maxDurationMs || (t > periodMs && amplitude * Math.exp(-t / dampingMs) < 0.5); },
  };
}
