/**
 * PoseSkinRenderer（T-M6-48，Contract: PetRendererType='pose-skin'）。
 *
 * CrossPet 的 7 套换装皮肤 / 15 套串门彩蛋是**静态姿势图**（webp），不是精灵图或 webm。
 * 本渲染器把「一个姿势 = 一个 1 帧 clip」映射到既有 PetAvatarManifest，复用
 * RendererHost 的交叉淡入与 Q 弹接口：
 *   - play(action)：取该动作首个 clip 的姿势图，交叉淡入；
 *   - 切换时按 `bounce` 配置触发一次 Q 弹（SVG 动效由宿主的 pose-effects 叠加）；
 *   - `lineFor(action)`：返回该角色 `character.json.lines` 里的预置台词（53 类文本），
 *     供气泡使用——纯数据，不伪造 LLM 输出。
 *
 * 素材：lokicorvus/crosspet（CC BY-NC-SA 4.0 → DEV_ONLY_NON_COMMERCIAL）。
 */
import type { PetActionState, PetAvatarClip, PetAvatarManifest } from '@workbench/shared-protocol';
import { squashAt, type SquashPose } from './squash';
import { PetRendererError, type PetAvatarRenderer, type PlayOptions, type RendererHost } from './types';

export interface PoseImageHandle {
  readonly src: string;
  readonly el?: unknown;
  /** resolve = 图片可展示 */
  play(): Promise<void>;
  pause(): void;
  detach(): void;
}

export type PoseImageFactory = (src: string) => PoseImageHandle;

export interface PoseSkinRendererOptions {
  host: RendererHost;
  imageFactory: PoseImageFactory;
  /** character.json.lines：姿势/动作 → 预置台词池 */
  lines?: Record<string, string[]>;
  /** 姿势 → 叠加动效类名（heart / steam / sparkle / note / zzz / anger） */
  effects?: Record<string, string>;
  rng?: () => number;
}

const DEFAULT_EFFECTS: Record<string, string> = {
  pat: 'heart',
  happy: 'sparkle',
  proud: 'sparkle',
  puffed: 'steam',
  redhot: 'steam',
  annoyed: 'anger',
  sulk: 'zzz',
  sleeping: 'zzz',
  hum: 'note',
  greet_morning: 'note',
  greet_noon: 'note',
  greet_evening: 'note',
  greet_night: 'zzz',
  dizzy: 'anger',
};

function clipPose(clip: PetAvatarClip): string {
  return clip.clipId;
}

export class PoseSkinRenderer implements PetAvatarRenderer {
  private readonly options: PoseSkinRendererOptions;
  private host: RendererHost;
  private imageFactory: PoseImageFactory;
  private manifestValue: PetAvatarManifest | null = null;
  private current: PetActionState | null = null;
  private active: PoseImageHandle | null = null;
  private previous: PoseImageHandle | null = null;
  private loading = false;
  private readonly poseByAction = new Map<PetActionState, string>();
  /** clipId → clip（含 ambientPool），供按姿态名直放 */
  private readonly clips = new Map<string, PetAvatarClip>();
  devWatermark = false;

  constructor(options: PoseSkinRendererOptions) {
    this.options = options;
    this.host = options.host;
    this.imageFactory = options.imageFactory;
  }

  get manifest(): PetAvatarManifest | null {
    return this.manifestValue;
  }

  async load(manifest: PetAvatarManifest): Promise<void> {
    if (manifest.renderer !== 'pose-skin') throw new PetRendererError('NO_MANIFEST', `renderer 不是 pose-skin：${manifest.renderer}`);
    this.dispose();
    this.manifestValue = manifest;
    this.poseByAction.clear();
    this.clips.clear();
    for (const action of manifest.actions) {
      const clip = action.clips[0];
      if (clip !== undefined) this.poseByAction.set(action.actionState, clipPose(clip));
      for (const item of action.clips) this.clips.set(item.clipId, item);
    }
    for (const clip of manifest.ambientPool) this.clips.set(clip.clipId, { loop: false, playbackRate: 1, fps: 1, ...clip });
    if (manifest.licenseScope === 'DEV_ONLY_NON_COMMERCIAL') {
      this.host.setDevBadge('DEV-ASSET-ONLY · CrossPet CC BY-NC-SA 4.0');
      this.devWatermark = true;
    } else {
      this.host.setDevBadge(null);
      this.devWatermark = false;
    }
    this.host.applyLayout({ offsetX: 0, offsetY: 0, width: manifest.width, height: manifest.height });
  }

  /** 该动作当前姿势名（皮肤 id），供宿主决定叠加动效。 */
  poseOf(action: PetActionState): string | null {
    return this.poseByAction.get(action) ?? null;
  }

  effectOf(action: PetActionState): string | null {
    const pose = this.poseOf(action);
    if (pose === null) return null;
    return this.options.effects?.[pose] ?? DEFAULT_EFFECTS[pose] ?? null;
  }

  /** 该姿势的预置台词；无则回退 idle，再回退 null（绝不编造）。 */
  lineFor(action: PetActionState): string | null {
    const lines = this.options.lines;
    if (lines === undefined) return null;
    const pose = this.poseOf(action);
    const pools = [pose === null ? undefined : lines[pose], lines.idle].filter((pool): pool is string[] => Array.isArray(pool) && pool.length > 0);
    const pool = pools[0];
    if (pool === undefined) return null;
    const rng = this.options.rng ?? Math.random;
    return pool[Math.floor(rng() * pool.length) % pool.length] ?? null;
  }

  async play(action: PetActionState, opts?: PlayOptions): Promise<void> {
    if (this.manifestValue === null) throw new PetRendererError('NO_MANIFEST', '未装载 manifest');
    if (this.current === action && opts?.force !== true) return;
    const pose = this.poseByAction.get(action);
    const clip = this.manifestValue.actions.find((entry) => entry.actionState === action)?.clips[0];
    if (pose === undefined || clip === undefined) throw new PetRendererError('ACTION_NOT_IN_MANIFEST', `pose-skin 缺少动作：${action}`);
    const src = clip.spriteSheetPath ?? clip.webmPath;
    if (this.loading) return;
    this.loading = true;
    const next = this.imageFactory(src);
    try {
      await next.play();
    } catch {
      this.loading = false;
      throw new PetRendererError('CLIP_PLAY_FAILED', `姿势图加载失败：${src}`);
    }
    this.host.mountVideo(next);
    this.host.showVideo(next);
    if (this.active !== null) {
      this.host.hideVideo(this.active);
      this.previous = this.active;
    }
    this.active = next;
    this.current = action;
    this.host.applySquash({ scaleX: 1.045, scaleY: 0.955 });
    setTimeout(() => this.host.applySquash({ scaleX: 1, scaleY: 1 }), 120);
    this.loading = false;
  }

  currentAction(): PetActionState | null {
    return this.current;
  }

  /** 当前 manifest 可用的姿态名（验收台回退检查用）。 */
  availablePoses(): string[] {
    return [...this.clips.keys()];
  }

  /** 按姿态名直放（工作跟随代理/验收台）：clip 不存在时抛 ACTION_NOT_IN_MANIFEST。 */
  async playPose(pose: string): Promise<void> {
    const clip = this.clips.get(pose);
    if (clip === undefined) throw new PetRendererError('ACTION_NOT_IN_MANIFEST', `pose-skin 缺少姿态：${pose}`);
    await this.playClip(clip);
    this.current = ([...this.poseByAction.entries()].find(([, id]) => id === pose)?.[0]) ?? this.current;
  }

  /** 单条 clip 直播（动作库/氛围池预览）：按 clipId 反查动作，找不到就按姿势图直放。 */
  async playClip(clip: PetAvatarClip): Promise<void> {
    const action = [...this.poseByAction.entries()].find(([, pose]) => pose === clip.clipId)?.[0];
    if (action !== undefined) return this.play(action, { force: true });
    const src = clip.spriteSheetPath ?? clip.webmPath;
    const next = this.imageFactory(src);
    await next.play();
    this.host.mountVideo(next);
    this.host.showVideo(next);
    if (this.active !== null) this.host.hideVideo(this.active);
    this.active = next;
  }

  /** 静态姿势无逐帧 Q 弹曲线，返回阻尼振荡姿态（与 WebM/精灵保持同一手感接口）。 */
  squashPoseAt(tMs: number, impact = 1): SquashPose {
    return squashAt(tMs, impact);
  }

  dispose(): void {
    if (this.active !== null) this.host.detachVideo(this.active);
    if (this.previous !== null) this.host.detachVideo(this.previous);
    this.active = null;
    this.previous = null;
    this.current = null;
    this.loading = false;
  }
}
