/**
 * SpritesheetRenderer（T-M6-41）：aboutme-pets 透明 WebP 精灵图渲染器。
 *
 * 与 WebmVideoRenderer 共用同一 RendererHost 双画面切换语义：新 canvas 首帧画完后再撤旧画面，
 * 保证动作切换零黑帧。帧循环、图片解码与音频播放由宿主注入，纯状态机可无头单测。
 */
import {
  PetAvatarManifestSchema,
  PetSpriteMetaSchema,
  type PetActionState,
  type PetAvatarClip,
  type PetAvatarManifest,
  type PetSpriteMeta,
} from '@workbench/shared-protocol';
import {
  PetRendererError,
  type PlayOptions,
  type PetAvatarRenderer,
  type RendererHost,
  type VideoHandle,
} from './types';
import { squashAt, type SquashOptions, type SquashPose } from './squash';

/** 帧索引 → 精灵图裁切矩形（越界钳到末帧）。 */
export function spriteFrameRect(meta: PetSpriteMeta, frameIndex: number): { sx: number; sy: number; sw: number; sh: number } {
  const index = Math.min(Math.max(0, Math.floor(frameIndex)), Math.max(0, meta.frameCount - 1));
  const column = index % meta.columns;
  const row = Math.floor(index / meta.columns);
  return { sx: column * meta.frameWidth, sy: row * meta.frameHeight, sw: meta.frameWidth, sh: meta.frameHeight };
}

/** 播放时间 → 帧索引；loop=false 时停在末帧。 */
export function spriteFrameIndex(meta: PetSpriteMeta, elapsedMs: number, loop = true): number {
  const raw = Math.floor((Math.max(0, elapsedMs) / 1000) * meta.sampleFps);
  if (loop) return raw % meta.frameCount;
  return Math.min(raw, meta.frameCount - 1);
}

export type SpriteSurfaceFactory = (
  src: string,
  meta: PetSpriteMeta,
  playbackRate: number,
  loop: boolean,
) => VideoHandle;

export type SpriteMetaLoader = (src: string) => Promise<unknown>;

export interface SpriteAudioController {
  play(src: string, opts: { loop: boolean; volume: number }): Promise<void>;
  stop(): void;
  setVolume(volume: number): void;
}

export interface SpritesheetRendererOptions {
  host: RendererHost;
  surfaceFactory?: SpriteSurfaceFactory;
  spriteMetaLoader?: SpriteMetaLoader;
  audio?: SpriteAudioController;
  squash?: SquashOptions;
  sfxEnabled?: boolean;
  sfxVolume?: number;
  /** TTS speaking 时原声 duck 比例（默认 0.15） */
  duckRatio?: number;
}

export class SpritesheetRenderer implements PetAvatarRenderer {
  private manifestState: PetAvatarManifest | null = null;
  private readonly metas = new Map<string, PetSpriteMeta>();
  private active: VideoHandle | null = null;
  private activeAction: PetActionState | null = null;
  private switching = false;
  private devWatermarkState = false;
  private sfxEnabled: boolean;
  private sfxVolume: number;
  private speakerActive = false;
  private rng: () => number = Math.random;

  constructor(private readonly options: SpritesheetRendererOptions) {
    this.sfxEnabled = options.sfxEnabled ?? true;
    this.sfxVolume = clamp01(options.sfxVolume ?? 0.7);
  }

  get manifest(): PetAvatarManifest | null { return this.manifestState; }
  get devWatermark(): boolean { return this.devWatermarkState; }
  currentAction(): PetActionState | null { return this.activeAction; }

  async load(manifest: PetAvatarManifest, opts?: { rng?: () => number }): Promise<void> {
    const validated = PetAvatarManifestSchema.parse(manifest);
    this.manifestState = validated;
    this.metas.clear();
    if (opts?.rng) this.rng = opts.rng;
    this.devWatermarkState = validated.licenseScope === 'DEV_ONLY_NON_COMMERCIAL';
    this.options.host.setDevBadge(this.devWatermarkState ? `[DEV-ASSET-ONLY] 非商用素材 · ${validated.attribution}` : null);
    this.options.host.applyLayout({ offsetX: 0, offsetY: 0, width: validated.width, height: validated.height });

    const all = [...validated.actions.flatMap((entry) => entry.clips), ...validated.ambientPool];
    for (const clip of all) {
      if (clip.sprite !== undefined) {
        this.metas.set(clip.clipId, clip.sprite);
        continue;
      }
      if (clip.spriteMetaPath === undefined || this.options.spriteMetaLoader === undefined) continue;
      try {
        const parsed = PetSpriteMetaSchema.safeParse(await this.options.spriteMetaLoader(clip.spriteMetaPath));
        if (parsed.success) this.metas.set(clip.clipId, parsed.data);
      } catch {
        /* 单条元数据失败不阻断整个角色；播放该动作时明确报缺元数据 */
      }
    }
  }

  async play(action: PetActionState, opts?: PlayOptions): Promise<void> {
    const manifest = this.manifestState;
    if (manifest === null) throw new PetRendererError('NO_MANIFEST', '清单尚未装载（先调用 load）');
    if (this.switching) throw new PetRendererError('SWITCH_IN_PROGRESS', '上一次切换尚未完成，禁止并发切换');
    if (action === this.activeAction && opts?.force !== true) return;
    const entry = manifest.actions.find((item) => item.actionState === action);
    if (entry === undefined) throw new PetRendererError('ACTION_NOT_IN_MANIFEST', `清单未登记动作：${action}`);
    const clip = pickClip(entry.clips, this.rng);
    await this.switchTo(clip, action);
  }

  /** 动作库预览/空闲氛围池（不写 activeAction，保持后续 play 可接管） */
  async playClip(clip: PetAvatarClip): Promise<void> {
    if (this.switching) return;
    await this.switchTo(clip, null);
  }

  squashPoseAt(tMs: number, impact = 1): SquashPose {
    return squashAt(tMs, impact, this.options.squash);
  }

  /** 全局 speaker 状态：true 时动作原声 duck 到 15%，避免与 TTS 叠音。 */
  setSpeakerActive(active: boolean): void {
    this.speakerActive = active;
    this.applyAudioVolume();
  }

  setSfxEnabled(enabled: boolean): void {
    this.sfxEnabled = enabled;
    this.applyAudioVolume();
  }

  setSfxVolume(volume: number): void {
    this.sfxVolume = clamp01(volume);
    this.applyAudioVolume();
  }

  dispose(): void {
    if (this.active !== null) {
      this.active.pause();
      this.options.host.detachVideo(this.active);
    }
    this.active = null;
    this.activeAction = null;
    this.manifestState = null;
    this.metas.clear();
    this.options.audio?.stop();
  }

  private async switchTo(clip: PetAvatarClip, action: PetActionState | null): Promise<void> {
    const meta = this.metas.get(clip.clipId);
    if (this.options.surfaceFactory === undefined) throw new PetRendererError('NO_FACTORY', '缺少 sprite surfaceFactory');
    if (meta === undefined) throw new PetRendererError('CLIP_LOAD_FAILED', `精灵图缺少帧元数据：${clip.clipId}`);
    const src = clip.spriteSheetPath ?? clip.webmPath;
    this.switching = true;
    let standby: VideoHandle | null = null;
    try {
      standby = this.options.surfaceFactory(src, meta, clip.playbackRate, clip.loop);
      this.options.host.mountVideo(standby);
      await standby.play(clip.loop, clip.playbackRate);
      this.options.host.showVideo(standby);
      if (this.active !== null) {
        this.options.host.hideVideo(this.active);
        this.options.host.detachVideo(this.active);
      }
      this.active = standby;
      this.activeAction = action;
      if (clip.audioPath !== undefined && this.options.audio !== undefined && this.sfxEnabled) {
        this.options.audio.stop();
        void this.options.audio.play(clip.audioPath, { loop: false, volume: this.effectiveVolume() }).catch(() => undefined);
      } else {
        this.options.audio?.stop();
      }
    } catch (error) {
      if (standby !== null) this.options.host.detachVideo(standby);
      throw new PetRendererError('CLIP_LOAD_FAILED', `精灵图播放失败：${clip.clipId}（${error instanceof Error ? error.message : String(error)}）`);
    } finally {
      this.switching = false;
    }
  }

  private effectiveVolume(): number {
    if (!this.sfxEnabled) return 0;
    return this.speakerActive ? this.sfxVolume * (this.options.duckRatio ?? 0.15) : this.sfxVolume;
  }

  private applyAudioVolume(): void {
    this.options.audio?.setVolume(this.effectiveVolume());
    if (!this.sfxEnabled) this.options.audio?.stop();
  }
}

function pickClip(clips: PetAvatarClip[], rng: () => number): PetAvatarClip {
  const first = clips[0];
  if (first === undefined) throw new PetRendererError('ACTION_NOT_IN_MANIFEST', '动作未配置任何片段');
  if (clips.length === 1) return first;
  const total = clips.reduce((sum, clip) => sum + clip.weight, 0);
  let roll = rng() * total;
  for (const clip of clips) {
    roll -= clip.weight;
    if (roll <= 0) return clip;
  }
  return clips[clips.length - 1]!;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
