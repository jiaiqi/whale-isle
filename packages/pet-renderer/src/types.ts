/**
 * 渲染抽象层契约（T-M1-01）。
 *
 * 设计：真实 DOM/WebM 解码细节通过 VideoFactory / RendererHost 注入隔离——
 * 引擎状态机（双 video 交叉淡入、脚底对齐、水印、切换互斥）无头可测；
 * 真实 HTMLVideoElement 工厂由 apps/desktop-host（T-M1-02）提供。
 */
import type { PetAvatarManifest, PetActionState } from '@workbench/shared-protocol';

/** 单段视频句柄：引擎只依赖此接口，不直接触碰 HTMLVideoElement */
export interface VideoHandle {
  readonly src: string;
  /** 播放；resolve 时机 = 画面可安全展示（真实实现监听 loadeddata），reject = 加载失败 */
  play(loop: boolean, playbackRate: number): Promise<void>;
  pause(): void;
  /** 从舞台上移除（宿主实现：removeChild） */
  detach(): void;
}

/** 视频工厂：src → 句柄。测试注入 Fake；宿主注入真实 webm 句柄 */
export type VideoFactory = (src: string) => VideoHandle;

/** 舞台宿主：引擎对 DOM 的全部副作用都经由此接口 */
export interface RendererHost {
  /** 把句柄挂上舞台（初始隐藏） */
  mountVideo(handle: VideoHandle): void;
  /** 交叉淡入：新画面顶到可视层 */
  showVideo(handle: VideoHandle): void;
  /** 交叉淡入：旧画面退场（在 showVideo(new) 之后调用） */
  hideVideo(handle: VideoHandle): void;
  /** 彻底移除 */
  detachVideo(handle: VideoHandle): void;
  /** DEV 水印徽标（licenseScope=DEV_ONLY_NON_COMMERCIAL 时由引擎自动挂载） */
  setDevBadge(text: string | null): void;
  /** 脚底基准线布局（见 computeFootlineLayout） */
  applyLayout(layout: { offsetX: number; offsetY: number; width: number; height: number }): void;
  /** Q 弹挤压形变（Squash & Stretch） */
  applySquash(pose: { scaleX: number; scaleY: number }): void;
}

export interface PlayOptions {
  /** 忽略"同动作不重切"的短路（用于点击回应等强制重播） */
  force?: boolean;
}

/** 渲染器统一接口（Live2D/SpriteSheet 实现以同一接口接入，renderer 类型见契约） */
export interface PetAvatarRenderer {
  /** 校验并装载清单（重复装载以最后一次为准） */
  load(manifest: PetAvatarManifest, opts?: { videoFactory?: VideoFactory; rng?: () => number }): Promise<void>;
  /** 切换动作；resolve = 新画面已上屏（零黑帧承诺） */
  play(action: PetActionState, opts?: PlayOptions): Promise<void>;
  currentAction(): PetActionState | null;
  /** licenseScope=DEV_ONLY_NON_COMMERCIAL 时为 true（水印已挂载） */
  readonly devWatermark: boolean;
  readonly manifest: PetAvatarManifest | null;
  dispose(): void;
}

/** 渲染器错误码（宿主据此做 UI 兜底） */
export type RendererErrorCode =
  | 'NO_FACTORY'
  | 'NO_MANIFEST'
  | 'ACTION_NOT_IN_MANIFEST'
  | 'SWITCH_IN_PROGRESS'
  | 'CLIP_LOAD_FAILED';

export class PetRendererError extends Error {
  constructor(
    readonly code: RendererErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PetRendererError';
  }
}
