/**
 * Q 弹挤压形变（Squash & Stretch）纯数学模块（T-M1-01）。
 * 来源概念：dsh-pet 落地/甩抛时的 Q 弹挤压手感；此处为阻尼振荡模型，
 * 体积近似守恒（scaleX·scaleY ≈ 1），t→∞ 收敛到 (1,1)。
 */

export interface SquashPose {
  scaleX: number;
  scaleY: number;
}

export interface SquashOptions {
  /** 初始压扁幅度（0~0.8）：0.3 = 落地瞬间压到 70% 高 */
  amplitude?: number;
  /** 阻尼时间常数（ms）：越大弹得越久 */
  dampingMs?: number;
  /** 角频率（rad/s）：越大弹得越快 */
  omega?: number;
}

const DEFAULTS: Required<SquashOptions> = { amplitude: 0.28, dampingMs: 160, omega: 22 };

/**
 * t 时刻的形变姿态。
 * - t=0：最大压扁（scaleY = 1 - amplitude）
 * - 阻尼余弦振荡回弹
 * - scaleX = 1 / scaleY（体积守恒）
 */
export function squashAt(tMs: number, impact = 1, options: SquashOptions = {}): SquashPose {
  const { amplitude, dampingMs, omega } = { ...DEFAULTS, ...options };
  const clamped = Math.min(Math.max(impact, 0), 3);
  if (clamped === 0) return { scaleX: 1, scaleY: 1 };
  const t = Math.max(tMs, 0) / 1000;
  const decay = Math.exp(-t / (dampingMs / 1000));
  const scaleY = 1 - amplitude * clamped * decay * Math.cos(omega * t);
  return { scaleX: 1 / scaleY, scaleY };
}
