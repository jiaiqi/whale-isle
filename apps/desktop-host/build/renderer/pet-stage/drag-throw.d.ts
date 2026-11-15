/**
 * 拖拽甩抛物理（T-M1-02，dsh-pet 概念）。
 *
 * 拖拽期：窗口跟随鼠标（主进程 setPosition，DIP 坐标，多屏异构 DPI 由 Electron 原生处理）。
 * 甩出期：重力 + 屏幕边界反弹（restitution）+ 水平摩擦，落定后返回冲击速度（驱动 Q 弹）。
 * 边界为多屏合并 workArea（主进程 screen.getAllDisplays 计算后经 preload 注入）。
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
export declare function velocityFromSamples(samples: DragSample[], windowMs?: number): Velocity2;
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
export declare function createThrow(options: ThrowOptions): ThrowSim;
//# sourceMappingURL=drag-throw.d.ts.map