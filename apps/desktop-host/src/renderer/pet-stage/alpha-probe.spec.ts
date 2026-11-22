import { describe, expect, it } from 'vitest';
import {
  ALPHA_THRESHOLD,
  createAlphaProbe,
  decidePassthrough,
  type PassthroughState,
} from './alpha-probe';

/** [SIMULATION] T-M1-02：alpha 穿透状态机纯逻辑（阈值 64 / 翻转去重 / force 钩子） */

describe('decidePassthrough（alpha 阈值 64）', () => {
  it('边界语义：alpha>64 交互，<=64 穿透（软边光晕 21~63 直接穿透不拦桌面操作）', () => {
    expect(decidePassthrough(255)).toBe('interactive');
    expect(decidePassthrough(200)).toBe('interactive'); // 实心身体照常可拖拽
    expect(decidePassthrough(65)).toBe('interactive');
    expect(decidePassthrough(64)).toBe('passthrough');
    expect(decidePassthrough(63)).toBe('passthrough'); // 半透明软边 → 穿透
    expect(decidePassthrough(0)).toBe('passthrough');
    expect(ALPHA_THRESHOLD).toBe(64);
  });
});

describe('createAlphaProbe', () => {
  it('仅状态翻转时 apply（50ms 轮询不打爆 IPC）', async () => {
    const applied: PassthroughState[] = [];
    let alpha = 0;
    const probe = createAlphaProbe({
      sample: () => alpha,
      apply: (state) => applied.push(state),
    });
    await probe.tickOnce();
    expect(applied).toEqual(['passthrough']);
    // 采样值不变 → 不重复 apply
    await probe.tickOnce();
    await probe.tickOnce();
    expect(applied).toHaveLength(1);
    alpha = 255;
    await probe.tickOnce();
    expect(applied).toEqual(['passthrough', 'interactive']);
    expect(probe.state()).toBe('interactive');
    probe.stop();
  });

  it('force 钩子直接驱动（E2E 通道）', async () => {
    const applied: PassthroughState[] = [];
    const probe = createAlphaProbe({
      sample: () => 255,
      apply: (state) => applied.push(state),
    });
    await probe.start(); // 首次 tick：interactive
    await probe.force(0);
    expect(applied).toEqual(['interactive', 'passthrough']);
    probe.stop();
  });

  it('start 幂等，stop 后可重启', async () => {
    const probe = createAlphaProbe({ sample: () => 0, apply: () => undefined, intervalMs: 5 });
    probe.start();
    const timer1 = probe.start();
    expect(timer1).toBeUndefined(); // 幂等（不重复起定时器）
    probe.stop();
    probe.stop(); // 双重 stop 安全
    await probe.tickOnce();
    expect(probe.state()).toBe('passthrough');
  });
});
