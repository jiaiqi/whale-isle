import manifestFixture from '../fixtures/blue-whale-maid.manifest.json';
import { describe, expect, it } from 'vitest';
import { PetAvatarManifestSchema, type PetAvatarManifest } from '@workbench/shared-protocol';
import { computeFootlineLayout, WebmVideoRenderer } from './webm-renderer';
import { squashAt } from './squash';
import { PetRendererError, type RendererHost, type VideoFactory, type VideoHandle } from './types';

/** [SIMULATION] T-M1-01 门禁：状态切换零黑帧时序 / DEV 水印挂载 / 脚底对齐 / Q 弹 */

const MANIFEST: PetAvatarManifest = PetAvatarManifestSchema.parse(manifestFixture);

// ---- 测试替身 ----
class FakeVideo implements VideoHandle {
  readonly playCalls: Array<{ loop: boolean; rate: number }> = [];
  paused = false;
  detached = false;
  constructor(
    readonly src: string,
    private readonly fail: boolean,
  ) {}
  play(loop: boolean, rate: number): Promise<void> {
    this.playCalls.push({ loop, rate });
    return this.fail ? Promise.reject(new Error('decode error')) : Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  detach(): void {
    this.detached = true;
  }
}

class RecordingHost implements RendererHost {
  ops: string[] = [];
  badge: string | null = null;
  layout: Record<string, number> | null = null;
  squashes: Array<{ scaleX: number; scaleY: number }> = [];

  mountVideo(handle: VideoHandle): void {
    this.ops.push(`mount(${handle.src})`);
  }
  showVideo(handle: VideoHandle): void {
    this.ops.push(`show(${handle.src})`);
  }
  hideVideo(handle: VideoHandle): void {
    this.ops.push(`hide(${handle.src})`);
  }
  detachVideo(handle: VideoHandle): void {
    this.ops.push(`detach(${handle.src})`);
  }
  setDevBadge(text: string | null): void {
    this.badge = text;
    this.ops.push(text ? `badge(${text})` : 'badge(null)');
  }
  applyLayout(layout: { offsetX: number; offsetY: number; width: number; height: number }): void {
    this.layout = { ...layout };
    this.ops.push(`layout(${layout.offsetY})`);
  }
  applySquash(pose: { scaleX: number; scaleY: number }): void {
    this.squashes.push({ ...pose });
  }
}

function makeRenderer(manifest: PetAvatarManifest, failSrcs: string[] = []) {
  const host = new RecordingHost();
  const videos = new Map<string, FakeVideo>();
  const factory: VideoFactory = (src) => {
    const video = new FakeVideo(src, failSrcs.includes(src));
    videos.set(src, video);
    return video;
  };
  const renderer = new WebmVideoRenderer({ host, videoFactory: factory, squash: { amplitude: 0.28 } });
  // 默认 rng=0：加权选片确定性命中首段（避免 Math.random 的测试抖动）
  const load = (m: PetAvatarManifest = manifest) => renderer.load(m, { rng: () => 0 });
  return { host, videos, renderer, load };
}

// ---- 零黑帧与切换状态机 ----
describe('WebmVideoRenderer 零黑帧切换', () => {
  it('时序：mount → play 可展示 → show(new) → hide(old) → detach(old)，全程不空屏', async () => {
    const { host, renderer, load } = makeRenderer(MANIFEST);
    await load();
    host.ops = [];
    await renderer.play('idle');
    expect(renderer.currentAction()).toBe('idle');
    const showIdx = host.ops.indexOf('show(webm/daiji-huxi-xiuxian.webm)');
    expect(showIdx).toBeGreaterThan(-1);
    // 首切无旧画面：show 之后不得再出现 hide/detach 旧片的黑洞期
    expect(host.ops.slice(0, showIdx).some((op) => op.startsWith('hide('))).toBe(false);
    // 第二次切换：严格 show(new) 先于 hide(old)（交叉淡入），且 detach 在 hide 之后
    await renderer.play('rage_spray');
    const showRage = host.ops.indexOf('show(webm/jingyu-tu-paopao-texiao.webm)');
    const hideIdle = host.ops.indexOf('hide(webm/daiji-huxi-xiuxian.webm)');
    const detachIdle = host.ops.indexOf('detach(webm/daiji-huxi-xiuxian.webm)');
    expect(showRage).toBeGreaterThan(-1);
    expect(hideIdle).toBeGreaterThan(showRage);
    expect(detachIdle).toBeGreaterThan(hideIdle);
  });

  it('新片加载失败：旧画面原样保留（不黑屏），报 CLIP_LOAD_FAILED', async () => {
    const { host, renderer, load } = makeRenderer(MANIFEST, ['webm/qingkuai-yaobaiwu.webm']);
    await load();
    await renderer.play('idle');
    host.ops = [];
    await expect(renderer.play('sing_stage')).rejects.toMatchObject({
      code: 'CLIP_LOAD_FAILED',
    } satisfies Partial<PetRendererError>);
    // 失败后：备用片被撤下，旧 idle 未被动过
    expect(host.ops.some((op) => op.startsWith('detach(webm/qingkuai-yaobaiwu.webm)'))).toBe(true);
    expect(host.ops.some((op) => op.startsWith('hide(webm/daiji-huxi-xiuxian.webm)'))).toBe(false);
    expect(renderer.currentAction()).toBe('idle');
  });

  it('同动作短路（循环片段不重切）；force 强制重切', async () => {
    const { host, renderer, load } = makeRenderer(MANIFEST);
    await load();
    await renderer.play('idle');
    const opsAfterFirst = host.ops.length;
    await renderer.play('idle');
    expect(host.ops.length).toBe(opsAfterFirst);
    await renderer.play('idle', { force: true });
    expect(host.ops.length).toBeGreaterThan(opsAfterFirst);
  });

  it('切换互斥：上一次切换未完成时并发 play 报 SWITCH_IN_PROGRESS', async () => {
    const host = new RecordingHost();
    let releaseSlow: () => void = () => undefined;
    const slowFactory: VideoFactory = (src): VideoHandle =>
      src === 'webm/pangxie-zoulu.webm'
        ? {
            src,
            play: () =>
              new Promise<void>((resolve) => {
                releaseSlow = resolve;
              }),
            pause: () => {},
            detach: () => {},
          }
        : new FakeVideo(src, false);
    const renderer = new WebmVideoRenderer({ host, videoFactory: slowFactory });
    await renderer.load(MANIFEST);
    await renderer.play('idle');
    const pending = renderer.play('walk');
    await expect(renderer.play('rage_spray')).rejects.toMatchObject({
      code: 'SWITCH_IN_PROGRESS',
    } satisfies Partial<PetRendererError>);
    releaseSlow();
    await pending;
    expect(renderer.currentAction()).toBe('walk');
  });

  it('未登记动作 / 未装载清单 / 缺工厂 → 专属错误码', async () => {
    const { renderer, host, load } = makeRenderer(MANIFEST);
    await expect(renderer.play('idle')).rejects.toMatchObject({ code: 'NO_MANIFEST' } satisfies Partial<PetRendererError>);
    await load();
    await expect(renderer.play('sleep_mute')).rejects.toMatchObject({
      code: 'ACTION_NOT_IN_MANIFEST',
    } satisfies Partial<PetRendererError>);
    const noFactory = new WebmVideoRenderer({ host });
    await expect(noFactory.load(MANIFEST).then(() => noFactory.play('idle'))).rejects.toMatchObject({
      code: 'NO_FACTORY',
    } satisfies Partial<PetRendererError>);
  });

  it('清单运行期二次校验：非法 renderer 拒绝装载', async () => {
    const { renderer } = makeRenderer(MANIFEST);
    await expect(
      renderer.load({ ...MANIFEST, renderer: 'gif' } as unknown as PetAvatarManifest),
    ).rejects.toBeTruthy();
  });

  it('加权选片：rng=0 命中首段，rng≈1 命中尾段（rage 0.7/0.3）', async () => {
    const { renderer, videos, load } = makeRenderer(MANIFEST);
    await load();
    await renderer.play('rage_spray');
    expect(videos.get('webm/jingyu-tu-paopao-texiao.webm')?.playCalls).toHaveLength(1);
    const host2 = new RecordingHost();
    const renderer2 = new WebmVideoRenderer({ host: host2, videoFactory: (src) => new FakeVideo(src, false) });
    await renderer2.load(MANIFEST, { rng: () => 0.99 });
    await renderer2.play('rage_spray');
    expect(host2.ops).toContain('show(webm/yong-jingyu-weiba-paidadi.webm)');
  });

  it('加权退化为顺序：权重全 0 命中首段；load 可换装新工厂', async () => {
    const zeroWeight: PetAvatarManifest = PetAvatarManifestSchema.parse({
      ...MANIFEST,
      actions: [
        {
          actionState: 'rage_spray',
          clips: [
            { clipId: 'a', webmPath: 'webm/a.webm', weight: 0 },
            { clipId: 'b', webmPath: 'webm/b.webm', weight: 0 },
          ],
        },
      ],
    });
    const { host, renderer, load } = makeRenderer(zeroWeight);
    await load(zeroWeight);
    await renderer.play('rage_spray');
    expect(host.ops).toContain('show(webm/a.webm)');
    // load 时可注入新工厂（opts.videoFactory 分支）：工厂优先级 load > 构造器
    // 用 canary 证明新工厂已生效——新工厂对 a.webm 注入加载失败
    await renderer.load(zeroWeight, {
      videoFactory: (src) => new FakeVideo(src, src === 'webm/a.webm'),
      rng: () => 0,
    });
    await expect(renderer.play('rage_spray', { force: true })).rejects.toMatchObject({
      code: 'CLIP_LOAD_FAILED',
    } satisfies Partial<PetRendererError>);
    expect(renderer.currentAction()).toBe('rage_spray'); // 失败后旧画面保留
  });

  it('DEV 素材缺省署名：徽标仅含红线前缀', async () => {
    const noAttribution: PetAvatarManifest = PetAvatarManifestSchema.parse({
      ...MANIFEST,
      attribution: '',
    });
    const { host, load } = makeRenderer(noAttribution);
    await load(noAttribution);
    expect(host.badge).toBe('[DEV-ASSET-ONLY] 非商用素材');
  });

  it('dispose：暂停并撤离当前画面，状态清空', async () => {
    const { host, renderer } = makeRenderer(MANIFEST);
    await renderer.load(MANIFEST);
    await renderer.play('idle');
    renderer.dispose();
    expect(renderer.currentAction()).toBeNull();
    expect(renderer.manifest).toBeNull();
    expect(host.ops).toContain('detach(webm/daiji-huxi-xiuxian.webm)');
  });
});

// ---- DEV 水印（素材红线） ----
describe('DEV_ONLY_NON_COMMERCIAL 水印', () => {
  it('DEV 素材自动挂 [DEV-ASSET-ONLY] 徽标并带署名', async () => {
    const { host, renderer, load } = makeRenderer(MANIFEST);
    await load();
    expect(renderer.devWatermark).toBe(true);
    expect(host.badge).toContain('[DEV-ASSET-ONLY]');
    expect(host.badge).toContain('@ZipZipPipe');
  });

  it('COMMERCIAL_READY 素材不挂徽标', async () => {
    const commercial: PetAvatarManifest = PetAvatarManifestSchema.parse({
      ...MANIFEST,
      licenseScope: 'COMMERCIAL_READY',
    });
    const { host, renderer } = makeRenderer(commercial);
    await renderer.load(commercial, { rng: () => 0 });
    expect(renderer.devWatermark).toBe(false);
    expect(host.badge).toBeNull();
  });
});

// ---- 脚底基准线对齐 ----
describe('脚底基准线对齐', () => {
  it('纯函数：脚底线落点 = 基线 - 帧高×ratio', () => {
    expect(computeFootlineLayout(800, 360, 0.5)).toMatchObject({ offsetY: 620 });
    expect(computeFootlineLayout(800, 360, 1)).toMatchObject({ offsetY: 440 }); // 完全贴底
    expect(computeFootlineLayout(800, 360, 0.92, 20)).toMatchObject({ offsetY: Math.round(780 - 331.2) });
  });

  it('load 时按清单自动应用布局', async () => {
    const { host, renderer, load } = makeRenderer(MANIFEST);
    await load();
    expect(host.layout).toMatchObject({ offsetY: Math.round(360 - 331.2), height: 360 });
  });
});

// ---- Q 弹挤压形变 ----
describe('Q 弹挤压形变（Squash & Stretch）', () => {
  it('落地瞬间压扁、体积近似守恒', () => {
    const pose = squashAt(0, 1);
    expect(pose.scaleY).toBeCloseTo(1 - 0.28, 5);
    expect(pose.scaleX * pose.scaleY).toBeCloseTo(1, 5);
  });

  it('阻尼回弹收敛到 (1,1)；impact=0 恒等；强度截断至 3', () => {
    const rest = squashAt(1500, 1);
    expect(Math.abs(rest.scaleY - 1)).toBeLessThan(0.01);
    expect(squashAt(0, 0)).toEqual({ scaleX: 1, scaleY: 1 });
    // 负 t 视作 0
    expect(squashAt(-5, 1)).toEqual(squashAt(0, 1));
    // 强度上限 3（超重落地也只压到 1-3×amplitude）
    expect(squashAt(0, 5).scaleY).toBeCloseTo(1 - 0.28 * 3, 5);
  });

  it('渲染器透传 Q 弹参数与宿主', async () => {
    const { host, renderer, load } = makeRenderer(MANIFEST);
    await load();
    const pose = renderer.squashPoseAt(0, 2);
    expect(pose.scaleY).toBeCloseTo(1 - 0.56, 5);
    host.applySquash(pose);
    expect(host.squashes).toHaveLength(1);
  });
});
