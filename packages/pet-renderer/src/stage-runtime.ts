/**
 * 统一 2D / Live2D / VRM 3D 舞台化身调度层（V2-P3-01 · REQ-EMB-02 / Blueprint 09 §8）：
 * - 同一 characterId（如 char_xiaojing）可在 desktop-2d / live2d / vrm-3d / obs-stage 之间无缝切换
 * - 切换后端时自动保留并重放场景、表情、口型包络（映射至 VRM BlendShapes / Live2D ParamMouth*）、舞蹈动作与双语歌词状态
 * - 严守许可证红线：DEV_ONLY_NON_COMMERCIAL 素材强制保持 devWatermarkActive = true
 * - 仅依赖 @workbench/shared-protocol，严守 dependency-cruiser pet-renderer-no-cross-layer 边界
 */
import {
  StageCharacterBindingSchema,
  StageRuntimeSnapshotSchema,
  StageSceneSpecSchema,
  type LipSyncFrame,
  type LyricsClockFrame,
  type PerformanceActivityMode,
  type PetActionState,
  type SpeechPerformancePlan,
  type StageBackendKind,
  type StageCharacterBinding,
  type StageCharacterBindingInput,
  type StageRuntimeSnapshot,
  type StageSceneSpec,
  type StageSceneSpecInput,
} from '@workbench/shared-protocol';

const CLOSED_LIP_FRAME: LipSyncFrame = {
  timestampMs: 0,
  durationMs: 0,
  viseme: 'closed',
  amplitude: 0,
  rmsDb: -80,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(4))));
}

/** 将统一口型帧映射为 VRM 标准 BlendShape 权重 */
export function visemeToVrmBlendShapes(
  frame: LipSyncFrame,
): Record<'aa' | 'ih' | 'ou' | 'ee' | 'oh', number> {
  const weights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  const amp = clamp01(frame.amplitude);
  switch (frame.viseme) {
    case 'closed':
      return weights;
    case 'open':
      weights.aa = amp;
      return weights;
    case 'wide':
      weights.ee = amp;
      return weights;
    case 'round':
      weights.ou = clamp01(amp * 0.85);
      weights.oh = clamp01(amp * 0.65);
      return weights;
    case 'teeth':
      weights.ih = amp;
      return weights;
  }
}

/** 将统一口型帧映射为 Live2D Cubism 参数 */
export function visemeToLive2dParams(
  frame: LipSyncFrame,
): Record<'ParamMouthOpenY' | 'ParamMouthForm', number> {
  const amp = clamp01(frame.amplitude);
  switch (frame.viseme) {
    case 'closed':
      return { ParamMouthOpenY: 0, ParamMouthForm: 0 };
    case 'open':
      return { ParamMouthOpenY: amp, ParamMouthForm: 0.2 };
    case 'wide':
      return { ParamMouthOpenY: clamp01(amp * 0.72), ParamMouthForm: 0.85 };
    case 'round':
      return { ParamMouthOpenY: clamp01(amp * 0.65), ParamMouthForm: -0.65 };
    case 'teeth':
      return { ParamMouthOpenY: clamp01(amp * 0.45), ParamMouthForm: 0.4 };
  }
}

/** 将统一情绪/表情映射为 VRM 标准情绪 BlendShapes */
export function expressionToVrmBlendShapes(
  expression: string,
  intensity: number,
): Record<'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised', number> {
  const val = clamp01(intensity);
  const out = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 };
  const norm = expression.trim().toLowerCase();
  if (norm.includes('happy') || norm.includes('sweet') || norm.includes('sing') || norm.includes('smile')) {
    out.happy = val;
  } else if (norm.includes('angry') || norm.includes('rage') || norm.includes('pout') || norm.includes('tsundere')) {
    out.angry = val;
  } else if (norm.includes('sad') || norm.includes('cry') || norm.includes('tired')) {
    out.sad = val;
  } else if (norm.includes('surpris') || norm.includes('panic') || norm.includes('shock')) {
    out.surprised = val;
  } else {
    out.relaxed = clamp01(val * 0.6);
  }
  return out;
}

/** 将统一表情映射为 2D 桌宠标准动作槽位 */
export function expressionToDesktopAction(expression: string): PetActionState {
  const norm = expression.trim().toLowerCase();
  if (norm.includes('rage') || norm.includes('angry')) return 'rage_spray';
  if (norm.includes('think')) return 'thinking_tail_wag';
  if (norm.includes('sleep') || norm.includes('rest')) return 'sleep_mute';
  if (norm.includes('sing') || norm.includes('dance')) return 'sing_stage';
  if (norm.includes('happy') || norm.includes('speak') || norm.includes('talk')) return 'happy_maid';
  if (norm.includes('gam')) return 'game_focus';
  return 'idle';
}

export interface StageEmbodimentAdapter {
  readonly backend: StageBackendKind;
  readonly capability: string;
  loadCharacter(binding: StageCharacterBinding): void;
  loadScene(scene: StageSceneSpec): void;
  setExpression(expression: string, intensity: number): void;
  playAnimation(animationId: string): void;
  applyLipSync(frame: LipSyncFrame): void;
  showLyrics(frame: LyricsClockFrame | null): void;
  stop(reason: string): void;
  inspectState(): Record<string, unknown>;
}

export class Desktop2dStageAdapter implements StageEmbodimentAdapter {
  readonly backend: StageBackendKind;
  readonly capability = 'webm-alpha / spritesheet 2d + obs transparent overlay';
  private binding: StageCharacterBinding | null = null;
  private scene: StageSceneSpec | null = null;
  private petAction: PetActionState = 'idle';
  private expression = 'idle';
  private animationId = 'idle';
  private lipSync: LipSyncFrame = CLOSED_LIP_FRAME;
  private lyricsLine = '';
  private stoppedReason: string | null = null;

  constructor(backend: 'desktop-2d' | 'obs-stage' = 'desktop-2d') {
    this.backend = backend;
  }

  loadCharacter(binding: StageCharacterBinding): void {
    this.binding = binding;
    this.stoppedReason = null;
  }

  loadScene(scene: StageSceneSpec): void {
    this.scene = scene;
  }

  setExpression(expression: string, _intensity: number): void {
    this.expression = expression;
    this.petAction = expressionToDesktopAction(expression);
  }

  playAnimation(animationId: string): void {
    this.animationId = animationId;
  }

  applyLipSync(frame: LipSyncFrame): void {
    this.lipSync = frame;
  }

  showLyrics(frame: LyricsClockFrame | null): void {
    this.lyricsLine = frame?.activeLine?.primaryText ?? '';
  }

  stop(reason: string): void {
    this.stoppedReason = reason;
    this.lipSync = CLOSED_LIP_FRAME;
    this.animationId = 'idle';
    this.petAction = 'idle';
  }

  inspectState(): Record<string, unknown> {
    return {
      backend: this.backend,
      assetPath: this.binding?.assetPath ?? null,
      transparentBackground: this.backend === 'obs-stage' ? true : (this.scene?.transparentBackground ?? false),
      petAction: this.petAction,
      expression: this.expression,
      animationId: this.animationId,
      viseme: this.lipSync.viseme,
      amplitude: this.lipSync.amplitude,
      lyricsPreview: this.lyricsLine,
      stoppedReason: this.stoppedReason,
    };
  }
}

export class Live2dStageAdapter implements StageEmbodimentAdapter {
  readonly backend: StageBackendKind = 'live2d';
  readonly capability = 'cubism model3.json + ParamMouthOpenY/Form + MotionGroup';
  private binding: StageCharacterBinding | null = null;
  private scene: StageSceneSpec | null = null;
  private expression = 'idle';
  private motionGroup = 'Idle';
  private params: Record<string, number> = {
    ParamMouthOpenY: 0,
    ParamMouthForm: 0,
    ParamEyeLOpen: 1,
    ParamEyeROpen: 1,
    ParamBodyAngleX: 0,
  };
  private lyricsLine = '';

  loadCharacter(binding: StageCharacterBinding): void {
    this.binding = binding;
  }

  loadScene(scene: StageSceneSpec): void {
    this.scene = scene;
  }

  setExpression(expression: string, intensity: number): void {
    this.expression = expression;
    const happyLike = expression.toLowerCase().includes('happy') || expression.toLowerCase().includes('sing');
    this.params.ParamEyeLOpen = clamp01(happyLike ? 0.9 + intensity * 0.1 : 1);
    this.params.ParamEyeROpen = this.params.ParamEyeLOpen;
  }

  playAnimation(animationId: string): void {
    this.motionGroup = animationId;
    this.params.ParamBodyAngleX = animationId.includes('dance') ? 8 : 0;
  }

  applyLipSync(frame: LipSyncFrame): void {
    const mapped = visemeToLive2dParams(frame);
    this.params.ParamMouthOpenY = mapped.ParamMouthOpenY;
    this.params.ParamMouthForm = mapped.ParamMouthForm;
  }

  showLyrics(frame: LyricsClockFrame | null): void {
    this.lyricsLine = frame?.activeLine?.primaryText ?? '';
  }

  stop(_reason: string): void {
    this.motionGroup = 'Idle';
    this.params.ParamMouthOpenY = 0;
    this.params.ParamMouthForm = 0;
    this.params.ParamBodyAngleX = 0;
  }

  inspectState(): Record<string, unknown> {
    return {
      backend: this.backend,
      modelPath: this.binding?.assetPath ?? null,
      sceneId: this.scene?.sceneId ?? null,
      expression: this.expression,
      motionGroup: this.motionGroup,
      parameters: { ...this.params },
      lyricsPreview: this.lyricsLine,
    };
  }
}

export class Vrm3dStageAdapter implements StageEmbodimentAdapter {
  readonly backend: StageBackendKind = 'vrm-3d';
  readonly capability = 'VRM 0.x/1.0 humanoid bones + expression/viseme BlendShapes';
  private binding: StageCharacterBinding | null = null;
  private scene: StageSceneSpec | null = null;
  private humanoidMotionTag = 'idle_breathing';
  private blendShapes: Record<string, number> = {
    aa: 0,
    ih: 0,
    ou: 0,
    ee: 0,
    oh: 0,
    happy: 0,
    angry: 0,
    sad: 0,
    relaxed: 0.4,
    surprised: 0,
  };
  private lyricsLine = '';

  loadCharacter(binding: StageCharacterBinding): void {
    this.binding = binding;
  }

  loadScene(scene: StageSceneSpec): void {
    this.scene = scene;
  }

  setExpression(expression: string, intensity: number): void {
    const mapped = expressionToVrmBlendShapes(expression, intensity);
    this.blendShapes.happy = mapped.happy;
    this.blendShapes.angry = mapped.angry;
    this.blendShapes.sad = mapped.sad;
    this.blendShapes.relaxed = mapped.relaxed;
    this.blendShapes.surprised = mapped.surprised;
  }

  playAnimation(animationId: string): void {
    this.humanoidMotionTag = animationId;
  }

  applyLipSync(frame: LipSyncFrame): void {
    const mapped = visemeToVrmBlendShapes(frame);
    this.blendShapes.aa = mapped.aa;
    this.blendShapes.ih = mapped.ih;
    this.blendShapes.ou = mapped.ou;
    this.blendShapes.ee = mapped.ee;
    this.blendShapes.oh = mapped.oh;
  }

  showLyrics(frame: LyricsClockFrame | null): void {
    this.lyricsLine = frame?.activeLine?.primaryText ?? '';
  }

  stop(_reason: string): void {
    this.humanoidMotionTag = 'idle_breathing';
    this.blendShapes.aa = 0;
    this.blendShapes.ih = 0;
    this.blendShapes.ou = 0;
    this.blendShapes.ee = 0;
    this.blendShapes.oh = 0;
  }

  inspectState(): Record<string, unknown> {
    return {
      backend: this.backend,
      vrmPath: this.binding?.assetPath ?? null,
      lightingPreset: this.scene?.lightingPreset ?? 'tidepaper_day',
      humanoidMotionTag: this.humanoidMotionTag,
      blendShapes: { ...this.blendShapes },
      lyricsPreview: this.lyricsLine,
    };
  }
}

export interface StageRuntimeOptions {
  adapters?: StageEmbodimentAdapter[];
}

/** 统一 2D / Live2D / VRM 3D / OBS 舞台管理器（对应 Blueprint 09 §8 统一 Stage API） */
export class StageRuntime {
  private readonly adapters = new Map<StageBackendKind, StageEmbodimentAdapter>();
  private readonly bindings = new Map<StageBackendKind, StageCharacterBinding>();
  private activeBackend: StageBackendKind = 'desktop-2d';
  private characterId: string | null = null;
  private displayName: string | null = null;
  private scene: StageSceneSpec | null = null;
  private expression = 'idle';
  private expressionIntensity = 0.6;
  private animationId = 'idle';
  private performingMode: PerformanceActivityMode = 'idle';
  private lipSync: LipSyncFrame = CLOSED_LIP_FRAME;
  private lyrics: LyricsClockFrame | null = null;
  private devWatermarkActive = true;

  constructor(options: StageRuntimeOptions = {}) {
    const defaults: StageEmbodimentAdapter[] = options.adapters ?? [
      new Desktop2dStageAdapter('desktop-2d'),
      new Live2dStageAdapter(),
      new Vrm3dStageAdapter(),
      new Desktop2dStageAdapter('obs-stage'),
    ];
    for (const adapter of defaults) {
      this.adapters.set(adapter.backend, adapter);
    }
  }

  registerBinding(rawBinding: StageCharacterBindingInput): StageCharacterBinding {
    const binding = StageCharacterBindingSchema.parse(rawBinding);
    if (this.characterId !== null && this.characterId !== binding.characterId) {
      this.bindings.clear();
    }
    this.characterId = binding.characterId;
    this.displayName = binding.displayName;
    this.bindings.set(binding.backend, binding);
    return binding;
  }

  loadCharacter(rawBinding: StageCharacterBindingInput): StageRuntimeSnapshot {
    const binding = this.registerBinding(rawBinding);
    const adapter = this.requireAdapter(binding.backend);
    this.activeBackend = binding.backend;
    this.devWatermarkActive = binding.licenseScope === 'DEV_ONLY_NON_COMMERCIAL';
    adapter.loadCharacter(binding);
    if (this.scene) adapter.loadScene(this.scene);
    adapter.setExpression(this.expression, this.expressionIntensity);
    adapter.playAnimation(this.animationId);
    adapter.applyLipSync(this.lipSync);
    adapter.showLyrics(this.lyrics);
    return this.snapshot();
  }

  /** 在不丢失角色身份、场景、表情、口型与歌词的前提下，将同一角色切换至另一渲染维度 */
  switchBackend(targetBackend: StageBackendKind): StageRuntimeSnapshot {
    const binding = this.bindings.get(targetBackend);
    if (!binding) {
      throw new Error(`角色 ${this.characterId ?? '<unloaded>'} 尚未登记 ${targetBackend} 化身绑定`);
    }
    const adapter = this.requireAdapter(targetBackend);
    this.activeBackend = targetBackend;
    this.devWatermarkActive = binding.licenseScope === 'DEV_ONLY_NON_COMMERCIAL';
    adapter.loadCharacter(binding);
    if (this.scene) adapter.loadScene(this.scene);
    adapter.setExpression(this.expression, this.expressionIntensity);
    adapter.playAnimation(this.animationId);
    adapter.applyLipSync(this.lipSync);
    adapter.showLyrics(this.lyrics);
    return this.snapshot();
  }

  loadScene(rawScene: StageSceneSpecInput): StageRuntimeSnapshot {
    const scene = StageSceneSpecSchema.parse(rawScene);
    this.scene = scene;
    this.requireAdapter(this.activeBackend).loadScene(scene);
    return this.snapshot();
  }

  transitionScene(rawScene: StageSceneSpecInput, _transitionMs = 350): StageRuntimeSnapshot {
    return this.loadScene(rawScene);
  }

  setExpression(expression: string, intensity = 0.7): StageRuntimeSnapshot {
    this.expression = expression.trim() === '' ? 'idle' : expression.trim();
    this.expressionIntensity = clamp01(intensity);
    this.requireAdapter(this.activeBackend).setExpression(this.expression, this.expressionIntensity);
    return this.snapshot();
  }

  playAnimation(animationId: string): StageRuntimeSnapshot {
    this.animationId = animationId.trim() === '' ? 'idle' : animationId.trim();
    this.requireAdapter(this.activeBackend).playAnimation(this.animationId);
    return this.snapshot();
  }

  applyLipSync(frame: LipSyncFrame): StageRuntimeSnapshot {
    this.lipSync = frame;
    this.requireAdapter(this.activeBackend).applyLipSync(frame);
    return this.snapshot();
  }

  showLyrics(frame: LyricsClockFrame | null): StageRuntimeSnapshot {
    this.lyrics = frame;
    this.requireAdapter(this.activeBackend).showLyrics(frame);
    return this.snapshot();
  }

  startSpeech(plan: Pick<SpeechPerformancePlan, 'expressionId' | 'emotion' | 'intensity' | 'gestureIds'>): StageRuntimeSnapshot {
    this.performingMode = 'speaking';
    this.setExpression(plan.expressionId ?? plan.emotion, plan.intensity);
    if (plan.gestureIds[0]) {
      this.playAnimation(plan.gestureIds[0]);
    }
    return this.snapshot();
  }

  startSinging(_songId: string, lyricsFrame: LyricsClockFrame, withDance = false): StageRuntimeSnapshot {
    this.performingMode = withDance ? 'singing_and_dancing' : 'singing';
    this.setExpression('singing', 0.85);
    this.playAnimation(withDance ? 'stage_dance_loop' : 'stage_sing_loop');
    this.showLyrics(lyricsFrame);
    return this.snapshot();
  }

  stopPerformance(reason = 'stopped'): StageRuntimeSnapshot {
    this.performingMode = 'idle';
    this.lipSync = CLOSED_LIP_FRAME;
    this.lyrics = null;
    this.expression = 'idle';
    this.animationId = 'idle';
    this.requireAdapter(this.activeBackend).stop(reason);
    return this.snapshot();
  }

  snapshot(): StageRuntimeSnapshot {
    const adapter = this.requireAdapter(this.activeBackend);
    return StageRuntimeSnapshotSchema.parse({
      characterId: this.characterId,
      displayName: this.displayName,
      activeBackend: this.activeBackend,
      registeredBackends: [...this.bindings.keys()],
      scene: this.scene,
      expression: this.expression,
      expressionIntensity: this.expressionIntensity,
      animationId: this.animationId,
      performingMode: this.performingMode,
      lipSync: this.lipSync,
      lyrics: this.lyrics,
      adapterState: adapter.inspectState(),
      realDeviceRenderVerified: false,
      devWatermarkActive: this.devWatermarkActive,
    });
  }

  private requireAdapter(backend: StageBackendKind): StageEmbodimentAdapter {
    const adapter = this.adapters.get(backend);
    if (!adapter) {
      throw new Error(`未注册舞台渲染适配器：${backend}`);
    }
    return adapter;
  }
}
