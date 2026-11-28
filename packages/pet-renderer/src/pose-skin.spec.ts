/** PoseSkinRenderer（T-M6-48）：姿势交叉淡入、Q 弹、动效映射、预置台词、错误分支。 */
import { describe, expect, it, vi } from 'vitest';
import { PetAvatarManifestSchema } from '@workbench/shared-protocol';
import { PoseSkinRenderer, type PoseImageHandle } from './pose-skin';
import type { RendererHost, VideoHandle } from './types';

const MANIFEST = PetAvatarManifestSchema.parse({
  petId: 'crosspet-deepseek',
  renderer: 'pose-skin',
  licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
  attribution: 'CrossPet',
  width: 640,
  height: 640,
  footlineRatio: 0.96,
  defaultAction: 'idle',
  actions: [
    { actionState: 'idle', clips: [{ clipId: 'idle', webmPath: 'whale-pet://a/idle.webp', spriteSheetPath: 'whale-pet://a/idle.webp' }] },
    { actionState: 'happy_maid', clips: [{ clipId: 'pat', webmPath: 'whale-pet://a/pat.webp', spriteSheetPath: 'whale-pet://a/pat.webp' }] },
    { actionState: 'rage_spray', clips: [{ clipId: 'puffed', webmPath: 'whale-pet://a/puffed.webp', spriteSheetPath: 'whale-pet://a/puffed.webp' }] },
  ],
});

function makeHost() {
  const calls: string[] = [];
  const host: RendererHost = {
    mountVideo: (handle: VideoHandle) => calls.push(`mount:${handle.src}`),
    showVideo: (handle: VideoHandle) => calls.push(`show:${handle.src}`),
    hideVideo: (handle: VideoHandle) => calls.push(`hide:${handle.src}`),
    detachVideo: (handle: VideoHandle) => calls.push(`detach:${handle.src}`),
    setDevBadge: (text: string | null) => calls.push(`badge:${text ?? ''}`),
    applyLayout: () => calls.push('layout'),
    applySquash: (pose) => calls.push(`squash:${pose.scaleX}`),
  };
  return { host, calls };
}

function makeFactory(failSrc?: string) {
  const created: string[] = [];
  const factory = (src: string): PoseImageHandle => {
    created.push(src);
    return {
      src,
      play: async () => { if (src === failSrc) throw new Error('boom'); },
      pause: () => undefined,
      detach: () => undefined,
    };
  };
  return { factory, created };
}

describe('PoseSkinRenderer', () => {
  it('装载 pose-skin：挂水印、布局，play 交叉淡入并 Q 弹', async () => {
    const { host, calls } = makeHost();
    const { factory } = makeFactory();
    const renderer = new PoseSkinRenderer({
      host,
      imageFactory: factory,
      lines: { idle: ['……', '咕噜咕噜'], pat: ['嘿嘿～'] },
      rng: () => 0,
    });
    await renderer.load(MANIFEST);
    expect(renderer.manifest?.petId).toBe('crosspet-deepseek');
    expect(renderer.devWatermark).toBe(true);
    expect(calls.some((call) => call.startsWith('badge:DEV-ASSET-ONLY'))).toBe(true);
    expect(renderer.poseOf('happy_maid')).toBe('pat');
    expect(renderer.effectOf('happy_maid')).toBe('heart');
    expect(renderer.effectOf('rage_spray')).toBe('steam');

    await renderer.play('idle');
    expect(renderer.currentAction()).toBe('idle');
    expect(calls).toContain('show:whale-pet://a/idle.webp');
    expect(calls).toContain('squash:1.045');
    expect(renderer.lineFor('happy_maid')).toBe('嘿嘿～');
    expect(renderer.lineFor('idle')).toBe('……');

    await renderer.play('happy_maid');
    expect(calls).toContain('hide:whale-pet://a/idle.webp');
    expect(calls).toContain('show:whale-pet://a/pat.webp');

    // 同动作不重切；force 才重播
    const before = calls.length;
    await renderer.play('happy_maid');
    expect(calls.length).toBe(before);
    await renderer.play('happy_maid', { force: true });
    expect(calls.length).toBeGreaterThan(before);
  });

  it('无台词时回退 idle，再无则 null；非 pose-skin manifest 拒绝；加载失败抛 CLIP_PLAY_FAILED', async () => {
    const { host } = makeHost();
    const { factory } = makeFactory('whale-pet://a/puffed.webp');
    const renderer = new PoseSkinRenderer({ host, imageFactory: factory });
    await renderer.load(MANIFEST);
    expect(renderer.lineFor('idle')).toBeNull();

    const webm = PetAvatarManifestSchema.parse({ ...MANIFEST, renderer: 'webm-alpha' });
    await expect(renderer.load(webm)).rejects.toMatchObject({ code: 'NO_MANIFEST' });

    await renderer.load(MANIFEST);
    await expect(renderer.play('rage_spray')).rejects.toMatchObject({ code: 'CLIP_PLAY_FAILED' });
    expect(renderer.currentAction()).toBeNull();
  });

  it('dispose 后状态清空', async () => {
    const { host, calls } = makeHost();
    const { factory } = makeFactory();
    const renderer = new PoseSkinRenderer({ host, imageFactory: factory });
    await renderer.load(MANIFEST);
    await renderer.play('idle');
    renderer.dispose();
    expect(renderer.currentAction()).toBeNull();
    expect(calls.some((call) => call.startsWith('detach:'))).toBe(true);
  });
});

describe('PoseSkinRenderer 附加路径', () => {
  it('playClip 已映射 → 转 play(force)；未映射 → 直放姿势图；squashPoseAt 有阻尼曲线', async () => {
    const { host, calls } = makeHost();
    const { factory } = makeFactory();
    const renderer = new PoseSkinRenderer({ host, imageFactory: factory, effects: { idle: 'note' } });
    await renderer.load(MANIFEST);
    await renderer.playClip({ clipId: 'pat', webmPath: 'whale-pet://a/pat.webp', loop: true, playbackRate: 1, fps: 1, weight: 1 });
    expect(renderer.currentAction()).toBe('happy_maid');
    await renderer.playClip({ clipId: 'unknown-pose', webmPath: 'whale-pet://a/extra.webp', loop: true, playbackRate: 1, fps: 1, weight: 1 });
    expect(calls).toContain('show:whale-pet://a/extra.webp');
    await renderer.playClip({ clipId: 'pat2', webmPath: 'whale-pet://a/pat2.webp', spriteSheetPath: 'whale-pet://a/pat2.webp', loop: true, playbackRate: 1, fps: 1, weight: 1 });
    expect(calls).toContain('hide:whale-pet://a/pat.webp');
    expect(renderer.squashPoseAt(0, 2).scaleY).toBeLessThan(1);
    // 自定义 effects 覆盖默认映射
    expect(renderer.effectOf('idle')).toBe('note');
  });

  it('商业授权素材不挂水印；未装载即播放拒绝；未知动作拒绝；空台词池回退 idle', async () => {
    const { host, calls } = makeHost();
    const { factory } = makeFactory();
    const renderer = new PoseSkinRenderer({ host, imageFactory: factory, lines: { idle: [], pat: ['嘿'] } });
    await expect(renderer.play('idle')).rejects.toMatchObject({ code: 'NO_MANIFEST' });
    await renderer.load(PetAvatarManifestSchema.parse({ ...MANIFEST, licenseScope: 'COMMERCIAL_READY' }));
    expect(renderer.devWatermark).toBe(false);
    expect(calls).toContain('badge:');
    expect(renderer.lineFor('happy_maid')).toBe('嘿');
    expect(renderer.lineFor('idle')).toBeNull();
    await expect(renderer.play('walk')).rejects.toMatchObject({ code: 'ACTION_NOT_IN_MANIFEST' });
  });
});

describe('PoseSkinRenderer 幂等清理', () => {
  it('playPose 按姿态名直放（含 ambient）；缺姿态抛 ACTION_NOT_IN_MANIFEST', async () => {
    const { host, calls } = makeHost();
    const { factory } = makeFactory();
    const renderer = new PoseSkinRenderer({ host, imageFactory: factory });
    await renderer.load(PetAvatarManifestSchema.parse({
      ...MANIFEST,
      ambientPool: [{ clipId: 'compact', webmPath: 'whale-pet://a/compact.webp', spriteSheetPath: 'whale-pet://a/compact.webp', sprite: { frameWidth: 640, frameHeight: 640, columns: 1, frameCount: 1, sampleFps: 1 }, category: '小动作', weight: 10 }],
    }));
    expect(renderer.availablePoses()).toEqual(expect.arrayContaining(['idle', 'pat', 'puffed', 'compact']));
    await renderer.playPose('compact');
    expect(calls).toContain('show:whale-pet://a/compact.webp');
    await expect(renderer.playPose('missing')).rejects.toMatchObject({ code: 'ACTION_NOT_IN_MANIFEST' });
  });

  it('dispose 两次安全且保留 manifest；未映射动作 effect 返回 null、台词回退 idle', async () => {
    const { host } = makeHost();
    const { factory } = makeFactory();
    const renderer = new PoseSkinRenderer({ host, imageFactory: factory, lines: { idle: ['在的'], walk: ['出门啦'] } });
    await renderer.load(MANIFEST);
    // walk 不在 manifest（契约禁止空 clips，所以只能缺整个动作）
    expect(renderer.poseOf('walk')).toBeNull();
    expect(renderer.effectOf('walk')).toBeNull();
    expect(renderer.lineFor('walk')).toBe('在的');
    renderer.dispose();
    renderer.dispose();
    expect(renderer.manifest).not.toBeNull();
  });

  it('连续切换姿态会在淡出后 detach 旧图，且 dispose 会取消在途加载避免叠层', async () => {
    vi.useFakeTimers();
    try {
      const { host, calls } = makeHost();
      const { factory } = makeFactory();
      const renderer = new PoseSkinRenderer({ host, imageFactory: factory });
      await renderer.load(MANIFEST);
      await renderer.play('idle');
      await renderer.play('happy_maid');
      expect(calls).toContain('hide:whale-pet://a/idle.webp');
      vi.advanceTimersByTime(260);
      expect(calls).toContain('detach:whale-pet://a/idle.webp');

      let resolveSlow!: () => void;
      const slowDetached: string[] = [];
      const slowHost = makeHost();
      const slowRenderer = new PoseSkinRenderer({
        host: slowHost.host,
        imageFactory: (src) => ({
          src,
          play: () => new Promise<void>((resolve) => { resolveSlow = resolve; }),
          pause: () => undefined,
          detach: () => { slowDetached.push(src); },
        }),
      });
      await slowRenderer.load(MANIFEST);
      const pending = slowRenderer.play('idle');
      slowRenderer.dispose();
      resolveSlow();
      await pending;
      expect(slowDetached).toEqual(['whale-pet://a/idle.webp']);
      expect(slowHost.calls).not.toContain('mount:whale-pet://a/idle.webp');
    } finally {
      vi.useRealTimers();
    }
  });
});
