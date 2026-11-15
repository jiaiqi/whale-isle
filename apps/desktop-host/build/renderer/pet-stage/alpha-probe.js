/**
 * 像素级鼠标穿透状态机（T-M1-02，SPEC §3.1）。
 *
 * 策略：渲染进程每 intervalMs 采样鼠标所在像素的 alpha——
 *   alpha > 20  → interactive（允许拖拽/抚摸/右键）
 *   alpha <= 20 → passthrough（setIgnoreMouseEvents(true, {forward:true})，点击穿透到星露谷/桌面）
 * 仅在状态翻转时调用 apply（避免 50ms 轮询打爆 IPC）。
 * 纯逻辑无 DOM/Electron 依赖——采样与执行由注入完成。
 */
export const ALPHA_THRESHOLD = 20;
export function decidePassthrough(alpha) {
    return alpha > ALPHA_THRESHOLD ? 'interactive' : 'passthrough';
}
export function createAlphaProbe(options) {
    const intervalMs = options.intervalMs ?? 50;
    let last = null;
    let forcedAlpha = null;
    let timer = null;
    async function tickOnce() {
        const alpha = forcedAlpha ?? (await options.sample());
        const next = decidePassthrough(alpha);
        if (next !== last) {
            last = next;
            options.apply(next);
        }
    }
    return {
        start() {
            if (timer !== null)
                return;
            void tickOnce();
            timer = setInterval(() => {
                void tickOnce();
            }, intervalMs);
        },
        stop() {
            if (timer !== null)
                clearInterval(timer);
            timer = null;
        },
        tickOnce,
        async force(alpha) {
            forcedAlpha = alpha;
            await tickOnce();
        },
        state() {
            return last;
        },
    };
}
//# sourceMappingURL=alpha-probe.js.map