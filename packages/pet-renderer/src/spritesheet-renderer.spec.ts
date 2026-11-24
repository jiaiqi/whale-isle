import { describe, expect, it, vi } from 'vitest';
import { PetAvatarManifestSchema, type PetAvatarManifest } from '@workbench/shared-protocol';
import { SpritesheetRenderer, spriteFrameIndex, spriteFrameRect, type SpriteAudioController } from './spritesheet-renderer';
import type { RendererHost, VideoHandle } from './types';

const manifest: PetAvatarManifest = PetAvatarManifestSchema.parse({
  petId: 'sprite-test', renderer: 'sprite-sheet', licenseScope: 'DEV_ONLY_NON_COMMERCIAL', attribution: 'test',
  width: 640, height: 360, defaultAction: 'idle',
  actions: [{ actionState: 'idle', clips: [{ clipId: 'idle', webmPath: 'file:///idle.webp', spriteSheetPath: 'file:///idle.webp', sprite: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, sampleFps: 12 }, audioPath: 'file:///idle.m4a' }] }],
  ambientPool: [{ clipId: 'amb', webmPath: 'file:///amb.webp', sprite: { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 4, sampleFps: 12 } }],
});

function fakes() {
  const events: string[] = [];
  const host: RendererHost = {
    mountVideo: (h) => events.push(`mount:${h.src}`),
    showVideo: (h) => events.push(`show:${h.src}`),
    hideVideo: (h) => events.push(`hide:${h.src}`),
    detachVideo: (h) => events.push(`detach:${h.src}`),
    setDevBadge: () => undefined,
    applyLayout: () => undefined,
    applySquash: () => undefined,
  };
  const volumes: number[] = [];
  const audio: SpriteAudioController = { play: vi.fn(async () => undefined), stop: vi.fn(), setVolume: (v) => volumes.push(v) };
  const surfaces = new Map<string, VideoHandle>();
  return { events, host, audio, volumes, surfaces };
}

describe('SpritesheetRenderer', () => {
  it('帧裁切/帧索引边界正确', () => {
    const meta = { frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, sampleFps: 12 };
    expect(spriteFrameRect(meta, 9)).toEqual({ sx: 640, sy: 360, sw: 640, sh: 360 });
    expect(spriteFrameRect(meta, 999)).toEqual({ sx: 640 * 6, sy: 360, sw: 640, sh: 360 });
    expect(spriteFrameIndex(meta, 500, true)).toBe(6);
    expect(spriteFrameIndex(meta, 9_999, false)).toBe(14);
  });

  it('双画面零黑帧切换：新画面 show 后才撤旧画面，并播放原声', async () => {
    const f = fakes();
    const surfaceFactory = (src: string): VideoHandle => ({
      src,
      play: vi.fn(async () => { f.events.push(`ready:${src}`); }),
      pause: vi.fn(), detach: vi.fn(),
    });
    const renderer = new SpritesheetRenderer({ host: f.host, surfaceFactory, audio: f.audio, sfxVolume: 0.7 });
    await renderer.load(manifest);
    await renderer.play('idle');
    expect(f.events).toEqual(['mount:file:///idle.webp', 'ready:file:///idle.webp', 'show:file:///idle.webp']);
    expect(f.audio.play).toHaveBeenCalledWith('file:///idle.m4a', { loop: false, volume: 0.7 });
    await renderer.playClip({ ...manifest.ambientPool[0]!, loop: false, playbackRate: 1, fps: 12 });
    expect(f.events.indexOf('show:file:///amb.webp')).toBeLessThan(f.events.indexOf('detach:file:///idle.webp'));
  });

  it('speaker 发言时原声 duck 到 15%，关闭音效后静音；发言结束恢复', async () => {
    const f = fakes();
    const renderer = new SpritesheetRenderer({
      host: f.host,
      surfaceFactory: (src) => ({ src, play: async () => undefined, pause: () => undefined, detach: () => undefined }),
      audio: f.audio,
      sfxVolume: 0.8,
    });
    await renderer.load(manifest);
    renderer.setSpeakerActive(true);
    expect(f.volumes.at(-1)).toBeCloseTo(0.12);
    renderer.setSpeakerActive(false);
    expect(f.volumes.at(-1)).toBe(0.8);
    renderer.setSfxEnabled(false);
    expect(f.volumes.at(-1)).toBe(0);
    expect(f.audio.stop).toHaveBeenCalled();
  });

  it('同动作短路/force/缺动作/无工厂/并发切换与 dispose', async () => {
    const f = fakes();
    const renderer = new SpritesheetRenderer({ host: f.host });
    await renderer.load(manifest);
    await expect(renderer.play('idle', { force: true })).rejects.toThrow(/surfaceFactory/);
    const r2 = new SpritesheetRenderer({ host: f.host, surfaceFactory: (src) => ({ src, play: async () => undefined, pause: () => undefined, detach: () => undefined }) });
    await r2.load(manifest);
    await r2.play('idle');
    const count = f.events.length;
    await r2.play('idle');
    expect(f.events.length).toBe(count);
    await r2.play('idle', { force: true });
    expect(f.events.length).toBeGreaterThan(count);
    await expect(r2.play('walk')).rejects.toThrow(/未登记/);
    r2.dispose();
    expect(r2.manifest).toBeNull();
  });

  it('meta JSON 注入加载与缺元数据明确报错', async () => {
    const f = fakes();
    const noEmbedded = { ...manifest, actions: manifest.actions.map((entry) => ({ ...entry, clips: entry.clips.map(({ sprite: _sprite, ...clip }) => ({ ...clip, spriteMetaPath: 'file:///idle.json' })) })) } as PetAvatarManifest;
    const renderer = new SpritesheetRenderer({
      host: f.host,
      surfaceFactory: (src) => ({ src, play: async () => undefined, pause: () => undefined, detach: () => undefined }),
      spriteMetaLoader: async () => ({ frameWidth: 640, frameHeight: 360, columns: 8, frameCount: 15, sampleFps: 12 }),
    });
    await renderer.load(noEmbedded);
    await expect(renderer.play('idle')).resolves.toBeUndefined();
    const missing = new SpritesheetRenderer({ host: f.host, surfaceFactory: (src) => ({ src, play: async () => undefined, pause: () => undefined, detach: () => undefined }) });
    await missing.load(PetAvatarManifestSchema.parse({ ...manifest, actions: [{ actionState: 'idle', clips: [{ clipId: 'x', webmPath: 'file:///x.webp' }] }], ambientPool: [] }));
    await expect(missing.play('idle')).rejects.toThrow(/缺少帧元数据/);
  });
});

describe('SpritesheetRenderer 边界', () => {
  it('meta loader 抛错不阻断 load；无音轨停止旧音；关闭音效不播放', async () => {
    const f = fakes();
    const noAudio = {
      ...manifest,
      actions: manifest.actions.map((entry) => ({ ...entry, clips: entry.clips.map(({ audioPath: _a, ...clip }) => ({ ...clip, spriteMetaPath: 'file:///bad.json' })) })),
    } as PetAvatarManifest;
    const renderer = new SpritesheetRenderer({
      host: f.host,
      audio: f.audio,
      sfxEnabled: false,
      surfaceFactory: (src) => ({ src, play: async () => undefined, pause: () => undefined, detach: () => undefined }),
      spriteMetaLoader: async () => { throw new Error('bad meta'); },
    });
    await renderer.load(noAudio);
    expect(renderer.manifest?.renderer).toBe('sprite-sheet');
    renderer.setSfxVolume(0.4);
    expect(f.volumes.at(-1)).toBe(0);
    expect(f.audio.play).not.toHaveBeenCalled();
  });

  it('dispose 停止活动画面与音频；切换失败保留旧画面', async () => {
    const f = fakes();
    let fail = false;
    const renderer = new SpritesheetRenderer({
      host: f.host,
      audio: f.audio,
      surfaceFactory: (src) => ({ src, play: async () => { if (fail) throw new Error('decode'); }, pause: () => undefined, detach: () => undefined }),
    });
    await renderer.load(manifest);
    await renderer.play('idle');
    fail = true;
    await expect(renderer.play('idle', { force: true })).rejects.toThrow(/精灵图播放失败/);
    fail = false;
    renderer.dispose();
    expect(f.audio.stop).toHaveBeenCalled();
    expect(renderer.currentAction()).toBeNull();
  });
});

describe('SpritesheetRenderer 并发与无工厂分支', () => {
  it('未加载/并发切换/playClip 让位/非 Error 异常/dispose 空实例', async () => {
    const f = fakes();
    const renderer = new SpritesheetRenderer({ host: f.host });
    await expect(renderer.play('idle')).rejects.toThrow(/清单尚未装载/);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const r2 = new SpritesheetRenderer({
      host: f.host,
      surfaceFactory: (src) => ({ src, play: async () => { await gate; throw 'string failure'; }, pause: () => undefined, detach: () => undefined }),
    });
    await r2.load(manifest, { rng: () => 0.99 });
    const first = r2.play('idle', { force: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(r2.play('idle', { force: true })).rejects.toThrow(/上一次切换/);
    await r2.playClip({ ...manifest.ambientPool[0]!, loop: false, playbackRate: 1, fps: 12 });
    release();
    await expect(first).rejects.toThrow(/string failure/);
    r2.dispose();
    r2.dispose();
  });
});
