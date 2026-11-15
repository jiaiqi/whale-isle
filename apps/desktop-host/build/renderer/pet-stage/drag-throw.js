/**
 * 拖拽甩抛物理（T-M1-02，dsh-pet 概念）。
 *
 * 拖拽期：窗口跟随鼠标（主进程 setPosition，DIP 坐标，多屏异构 DPI 由 Electron 原生处理）。
 * 甩出期：重力 + 屏幕边界反弹（restitution）+ 水平摩擦，落定后返回冲击速度（驱动 Q 弹）。
 * 边界为多屏合并 workArea（主进程 screen.getAllDisplays 计算后经 preload 注入）。
 */
/** 由拖拽采样估计释放速度（px/s）：取窗口内的首尾样本，dt 无效时返回零向量 */
export function velocityFromSamples(samples, windowMs = 120) {
    if (samples.length < 2)
        return { vx: 0, vy: 0 };
    const last = samples[samples.length - 1];
    if (!last)
        return { vx: 0, vy: 0 };
    let first;
    for (const sample of samples) {
        if (last.t - sample.t <= windowMs) {
            first = sample;
            break;
        }
    }
    const effective = first ?? samples[0];
    if (!effective || effective === last)
        return { vx: 0, vy: 0 };
    const dt = (last.t - effective.t) / 1000;
    if (dt <= 0)
        return { vx: 0, vy: 0 };
    return { vx: (last.x - effective.x) / dt, vy: (last.y - effective.y) / dt };
}
const DEFAULTS = { gravity: 1800, restitution: 0.55, friction: 0.35, stopSpeed: 40, maxDurationMs: 6000 };
export function createThrow(options) {
    const cfg = { ...DEFAULTS, ...options };
    const clampX = (x) => Math.min(Math.max(x, options.bounds.minX), options.bounds.maxX);
    const clampY = (y) => Math.min(Math.max(y, options.bounds.minY), options.bounds.maxY);
    let x = options.start.x;
    let y = options.start.y;
    let vx = options.velocity.vx;
    let vy = options.velocity.vy;
    let landed = false;
    let impact = null;
    let elapsedMs = 0;
    return {
        step(dtMs) {
            if (this.done())
                return { x, y };
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
            }
            else if (x > options.bounds.maxX) {
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
                if (vy > 0)
                    vy = -vy * cfg.restitution;
            }
            else if (y < options.bounds.minY) {
                y = options.bounds.minY;
                if (vy < 0)
                    vy = Math.abs(vy) * cfg.restitution;
            }
            return { x: clampX(x), y: clampY(y) };
        },
        position() {
            return { x, y };
        },
        landingImpact() {
            return impact;
        },
        done() {
            const speed = Math.hypot(vx, vy);
            const atRest = landed && y >= options.bounds.maxY - 0.5 && speed < cfg.stopSpeed;
            return atRest || elapsedMs >= cfg.maxDurationMs;
        },
    };
}
//# sourceMappingURL=drag-throw.js.map