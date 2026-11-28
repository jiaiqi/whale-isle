/**
 * WebmVideoRenderer（T-M1-01）—— renderer: 'webm-alpha' 的第一方实现。
 *
 * 零黑帧切换时序（dsh-pet 双 `<video>` 交叉淡入概念）：
 *   mount(standby, 隐藏) → standby.play() 可展示 → show(standby) → hide(active) → detach(active)
 * 任何时刻舞台上都至少有一个可视画面；新片加载失败时旧画面原样保留。
 */
import { PetAvatarManifestSchema, type PetActionState, type PetAvatarClip, type PetAvatarManifest } from '@workbench/shared-protocol';
import {
  PetRendererError,
  type PlayOptions,
  type PetAvatarRenderer,
  type RendererHost,
  type VideoFactory,
  type VideoHandle,
} from './types';
import { squashAt, type SquashOptions, type SquashPose } from './squash';

/** 脚底基准线布局：把清单里的 footlineRatio 对到舞台基线 */
export function computeFootlineLayout(
  stageHeight: number,
  frameHeight: number,
  footlineRatio: number,
  baselineOffsetFromBottom = 0,
): { offsetX: number; offsetY: number; width: number; height: number } {
  const baselineY = stageHeight - baselineOffsetFromBottom;
  // 视频顶边位置 = 基线 - 帧内脚底线绝对高度
  const offsetY = baselineY - frameHeight * footlineRatio;
  return { offsetX: 0, offsetY: Math.round(offsetY), width: 0, height: frameHeight };
}

export interface WebmRendererOptions {
  host: RendererHost;
  /** 缺省时 load() 报 NO_FACTORY（真实 DOM 工厂由 desktop-host 提供） */
  videoFactory?: VideoFactory;
  /** Q 弹参数（透传 squashAt） */
  squash?: SquashOptions;
}

export class WebmVideoRenderer implements PetAvatarRenderer {
  private manifestState: PetAvatarManifest | null = null;
  private factory: VideoFactory | null = null;
  private rng: () => number = Math.random;
  private active: VideoHandle | null = null;
  private activeAction: PetActionState | null = null;
  private switching = false;
  private loadEpoch = 0;
  private devWatermarkState = false;

  constructor(private readonly options: WebmRendererOptions) {}

  get manifest(): PetAvatarManifest | null {
    return this.manifestState;
  }

  get devWatermark(): boolean {
    return this.devWatermarkState;
  }

  currentAction(): PetActionState | null {
    return this.activeAction;
  }

  async load(
    manifest: PetAvatarManifest,
    opts?: { videoFactory?: VideoFactory; rng?: () => number },
  ): Promise<void> {
    // 契约二次校验：宿主/文件读入的清单不可信（运行期安全锁：只消费 Schema 校验过的配置）
    const validated: PetAvatarManifest = PetAvatarManifestSchema.parse(manifest);
    this.manifestState = validated;
    // 工厂优先级：load 注入 > 构造器注入
    if (opts?.videoFactory) {
      this.factory = opts.videoFactory;
    } else if (this.options.videoFactory) {
      this.factory = this.options.videoFactory;
    }
    if (opts?.rng) this.rng = opts.rng;

    // 素材红线：DEV 素材自动挂水印徽标并要求署名（dsh-pet 二创约定）
    this.devWatermarkState = validated.licenseScope === 'DEV_ONLY_NON_COMMERCIAL';
    if (this.devWatermarkState) {
      const attribution = validated.attribution.trim();
      this.options.host.setDevBadge(
        `[DEV-ASSET-ONLY] 非商用素材${attribution ? ` · ${attribution}` : ''}`,
      );
    } else {
      this.options.host.setDevBadge(null);
    }

    const layout = computeFootlineLayout(
      validated.height,
      validated.height,
      validated.footlineRatio,
    );
    this.options.host.applyLayout(layout);
  }

  /** 播放任意单条 clip（T-M5-16 动作库预览：ambient 池条目不在槽位内，走此 API）。
   *  与 play 同一条零黑帧链路；不写 activeAction（预览回落 idle 不受同动作短路影响）。 */
  async playClip(clip: PetAvatarClip): Promise<void> {
    if (!this.factory) throw new PetRendererError('NO_FACTORY', '缺少 videoFactory（真实工厂由 desktop-host 注入）');
    if (this.switching) return; // 预览不因并发切换抛错（静默让位）
    this.switching = true;
    const epoch = this.loadEpoch;
    const standby = this.factory(clip.webmPath);
    try {
      this.options.host.mountVideo(standby);
      await standby.play(clip.loop, clip.playbackRate);
      if (epoch !== this.loadEpoch) {
        this.options.host.detachVideo(standby);
        return;
      }
      this.options.host.showVideo(standby);
      if (this.active) {
        this.options.host.hideVideo(this.active);
        this.options.host.detachVideo(this.active);
      }
      this.active = standby;
      // 单条预览不更新 activeAction/entry 缓存——后续 play(action) 正常接管
    } catch (error) {
      this.options.host.detachVideo(standby);
      if (epoch !== this.loadEpoch) return;
      // 加载失败保留旧画面（不黑屏）
      if (error instanceof Error) {
        throw new PetRendererError('CLIP_PLAY_FAILED', `片段播放失败：${clip.webmPath}（${error.message}）`);
      }
      throw new PetRendererError('CLIP_PLAY_FAILED', `片段播放失败：${clip.webmPath}`);
    } finally {
      if (epoch === this.loadEpoch) this.switching = false;
    }
  }

  async play(action: PetActionState, opts?: PlayOptions): Promise<void> {
    const manifest = this.manifestState;
    if (!manifest) throw new PetRendererError('NO_MANIFEST', '清单尚未装载（先调用 load）');
    if (!this.factory) throw new PetRendererError('NO_FACTORY', '缺少 videoFactory（真实工厂由 desktop-host 注入）');
    if (this.switching) {
      throw new PetRendererError('SWITCH_IN_PROGRESS', '上一次切换尚未完成，禁止并发切换');
    }
    // 同动作短路：循环片段无需重切（避免无谓的加载与闪动）
    if (action === this.activeAction && !opts?.force) return;

    const entry = manifest.actions.find((a) => a.actionState === action);
    if (!entry) throw new PetRendererError('ACTION_NOT_IN_MANIFEST', `清单未登记动作：${action}`);

    const clip = this.pickClip(entry.clips);
    this.switching = true;
    const epoch = this.loadEpoch;
    const standby = this.factory(clip.webmPath);
    try {
      this.options.host.mountVideo(standby);
      await standby.play(clip.loop, clip.playbackRate);
      if (epoch !== this.loadEpoch) {
        this.options.host.detachVideo(standby);
        return;
      }
      // —— 交叉淡入分界线：新画面可展示后才动旧画面（零黑帧承诺） ——
      this.options.host.showVideo(standby);
      if (this.active) {
        this.options.host.hideVideo(this.active);
        this.options.host.detachVideo(this.active);
      }
      this.active = standby;
      this.activeAction = action;
    } catch (error) {
      // 加载失败：撤下备用画面，旧画面原样保留（不黑屏）
      this.options.host.detachVideo(standby);
      if (epoch !== this.loadEpoch) return;
      throw new PetRendererError(
        'CLIP_LOAD_FAILED',
        `片段加载失败：${clip.webmPath}（${error instanceof Error ? error.message : String(error)}）`,
      );
    } finally {
      if (epoch === this.loadEpoch) this.switching = false;
    }
  }

  /** 落地/被弹起时的 Q 弹姿态（由宿主在物理事件里驱动 t） */
  squashPoseAt(tMs: number, impact = 1): SquashPose {
    return squashAt(tMs, impact, this.options.squash);
  }

  dispose(): void {
    this.loadEpoch += 1;
    this.switching = false;
    if (this.active) {
      this.active.pause();
      this.options.host.detachVideo(this.active);
    }
    this.active = null;
    this.activeAction = null;
    this.manifestState = null;
  }

  private pickClip(clips: PetAvatarClip[]): PetAvatarClip {
    const first = clips[0];
    // 契约已保证 min(1) 片段；此处为直接调用方的防御兜底
    if (first === undefined) throw new PetRendererError('ACTION_NOT_IN_MANIFEST', '动作未配置任何片段');
    if (clips.length === 1) return first;
    const total = clips.reduce((sum, clip) => sum + clip.weight, 0);
    if (total <= 0) return first;
    let roll = this.rng() * total;
    for (const clip of clips) {
      roll -= clip.weight;
      if (roll <= 0) return clip;
    }
    // roll 初始 < total，逐段扣减后数学上必在末段前命中
    return clips[clips.length - 1]!;
  }
}

export function pickAmbient(
  manifest: PetAvatarManifest,
  rng: () => number = Math.random,
): { clipId: string; webmPath: string; category: string } {
  const pool = manifest.ambientPool.filter((c) => c.weight > 0);
  if (pool.length === 0) {
    const idle = manifest.actions.find((a) => a.actionState === manifest.defaultAction) ?? manifest.actions[0];
    const clip = idle?.clips[0];
    return { clipId: clip?.clipId ?? 'idle', webmPath: clip?.webmPath ?? '', category: 'idle' };
  }
  const total = pool.reduce((s, c) => s + c.weight, 0);
  let roll = rng() * total;
  for (const c of pool) {
    roll -= c.weight;
    if (roll <= 0) return { clipId: c.clipId, webmPath: c.webmPath, category: c.category };
  }
  // rng() < 1 数学保证 roll 在最后一项前必 ≤0，循环必返回
  const last = pool[pool.length - 1]!;
  return { clipId: last.clipId, webmPath: last.webmPath, category: last.category };
}
