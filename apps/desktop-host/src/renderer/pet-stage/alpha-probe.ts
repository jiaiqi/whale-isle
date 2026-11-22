/**
 * 像素级鼠标穿透状态机（T-M1-02，SPEC §3.1）。
 *
 * 策略：渲染进程每 intervalMs 采样鼠标所在像素的 alpha——
 *   alpha > 64  → interactive（允许拖拽/抚摸/右键）
 *   alpha <= 64 → passthrough（setIgnoreMouseEvents(true, {forward:true})，点击穿透到星露谷/桌面）
 * 仅在状态翻转时调用 apply（避免 50ms 轮询打爆 IPC）。
 * 纯逻辑无 DOM/Electron 依赖——采样与执行由注入完成。
 *
 * 阈值 20→64（2026-11-22 用户真机反馈「透明区太宽影响桌面操作」）：webm 软边/光晕常带
 * alpha 21~63 的半透明像素，旧阈值把它们全当可点击；抬高后只有接近实心的身体拦截鼠标，
 * 半透明发光边缘直接穿透。实体身体像素 alpha 通常 >200，拖拽不受影响。
 */

export const ALPHA_THRESHOLD = 64;

export type PassthroughState = 'passthrough' | 'interactive';

export function decidePassthrough(alpha: number): PassthroughState {
  return alpha > ALPHA_THRESHOLD ? 'interactive' : 'passthrough';
}

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

export function createAlphaProbe(options: AlphaProbeOptions): AlphaProbe {
  const intervalMs = options.intervalMs ?? 50;
  let last: PassthroughState | null = null;
  let forcedAlpha: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tickOnce(): Promise<void> {
    const alpha = forcedAlpha ?? (await options.sample());
    const next = decidePassthrough(alpha);
    if (next !== last) {
      last = next;
      options.apply(next);
    }
  }

  return {
    start() {
      if (timer !== null) return;
      void tickOnce();
      timer = setInterval(() => {
        void tickOnce();
      }, intervalMs);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tickOnce,
    async force(alpha: number) {
      forcedAlpha = alpha;
      await tickOnce();
    },
    state() {
      return last;
    },
  };
}
