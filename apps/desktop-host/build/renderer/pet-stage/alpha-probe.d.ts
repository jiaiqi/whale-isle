/**
 * 像素级鼠标穿透状态机（T-M1-02，SPEC §3.1）。
 *
 * 策略：渲染进程每 intervalMs 采样鼠标所在像素的 alpha——
 *   alpha > 20  → interactive（允许拖拽/抚摸/右键）
 *   alpha <= 20 → passthrough（setIgnoreMouseEvents(true, {forward:true})，点击穿透到星露谷/桌面）
 * 仅在状态翻转时调用 apply（避免 50ms 轮询打爆 IPC）。
 * 纯逻辑无 DOM/Electron 依赖——采样与执行由注入完成。
 */
export declare const ALPHA_THRESHOLD = 20;
export type PassthroughState = 'passthrough' | 'interactive';
export declare function decidePassthrough(alpha: number): PassthroughState;
export interface AlphaProbeOptions {
    /** 采样当前鼠标处 alpha（真实实现：离屏 1x1 Canvas drawImage + getImageData） */
    sample: () => Promise<number> | number;
    /** 状态落地（真实实现：IPC → 主进程 win.setIgnoreMouseEvents） */
    apply: (state: PassthroughState) => void;
    intervalMs?: number;
}
export interface AlphaProbe {
    /** 启动轮询（内部即刻 tick 一次） */
    start(): void;
    stop(): void;
    /** 手动驱动一次采样（单测/E2E 确定性用） */
    tickOnce(): Promise<void>;
    /** E2E/测试钩子：强制注入 alpha（PET_STAGE_E2E=1 时由 preload 暴露） */
    force(alpha: number): Promise<void>;
    state(): PassthroughState | null;
}
export declare function createAlphaProbe(options: AlphaProbeOptions): AlphaProbe;
//# sourceMappingURL=alpha-probe.d.ts.map