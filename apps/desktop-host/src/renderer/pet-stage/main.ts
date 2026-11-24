/**
 * pet-stage 渲染层装配（T-M1-02）：WebmVideoRenderer + alpha 穿透探针 + 拖拽甩抛。
 * 注意：webm 资产不入库（DEV_ONLY_NON_COMMERCIAL），未放置资产时舞台为透明空窗——属预期。
 */
import { mergePoseEffects, normalizePoseEffect, PoseSkinRenderer, SpritesheetRenderer, WebmVideoRenderer, pickAmbient, poseEffectOffsets, poseEffectSvg, spriteFrameIndex, spriteFrameRect, type RendererHost, type SpriteAudioController, type VideoFactory, type VideoHandle } from '@workbench/pet-renderer';
import { classifyAutodriveReceipt, GAME_EVENT_ACTION_MAP, RICE_LEVEL_ACTION_MAP } from '@workbench/pet-renderer/emotion-map';
import type { PetActionState } from '@workbench/shared-protocol';
import { createAlphaProbe } from './alpha-probe';
import { bubbleTick, createBubbleLifecycle, showBubble, speakerIdle, speechResult, speechStarted, type BubbleLifecycleState } from './bubble-lifecycle';
import { createInteractionState, DIZZY_ACTIONS, dockEdgeFor, headPat, recordShake, setAsleep, shouldBlockWhileAsleep, shouldEnterPowerSaver } from './interaction';
import { createGlide, createSlingshot, createThrow, velocityFromSamples, type Bounds, type DragSample } from './drag-throw';
import { poseSamplePoint } from './pose-hit';
import type { PetDesktopPrefs } from '@workbench/shared-protocol';
import { AudioLeaseManager } from './audio-lease';
import { mountBubbleWidgets } from './widgets/bubbles';
import { mountRiceBowlWidget } from './widgets/rice-bowl-widget';
import { buildPlaybackLease, sampleVisemeTimeline, type SpeakRequest } from './tts-router';
import { pickIdleMix } from './idle-mix';
import { glyphColors, glyphParticles, isReadingOrSearchingPose, type GlyphConfig } from './glyph-effects';

interface PetStageBridge {
  ready: boolean;
  setPassthrough(state: 'passthrough' | 'interactive'): Promise<boolean>;
  forceInteractive(on: boolean): Promise<boolean>;
  getState(): Promise<'passthrough' | 'interactive'>;
  screenBounds(): Promise<Bounds & { windowBounds: Bounds; displayId: string }>;
  mousePoint(): Promise<{ x: number; y: number }>;
  winPosition(): Promise<[number, number] | null>;
  dragTo(x: number, y: number): Promise<[number, number] | null>;
  prefsGet(): Promise<PetDesktopPrefs>;
  prefsSet(update: Partial<PetDesktopPrefs>): Promise<PetDesktopPrefs>;
  windowPrefsGet(agentId: string): Promise<{ scale: number; locked: boolean; characterId: string } | null>;
  windowPrefsSet(agentId: string, update: { scale?: number; locked?: boolean; characterId?: string }): Promise<unknown>;
  onWindowPrefsChanged?(handler: (prefs: { scale: number; locked: boolean; characterId: string }) => void): void;
  dockWindow?(agentId: string, edge: 'left' | 'right' | null): Promise<unknown>;
  clearDock?(agentId: string): Promise<{ ok: boolean }>;
  pokeLine?(agentId: string): Promise<{ ok: boolean; characterId?: string; line?: string }>;
  setPeek?(active: boolean): Promise<{ ok: boolean }>;
  onGlobalPrefsChanged?(handler: (prefs: PetDesktopPrefs) => void): () => void;
  onCoopSpeaker?(handler: (event: { activeAgentId: string | null; speakerName: string; state: 'speaking' | 'idle'; voiceId?: string }) => void): void;
  onSpeechResult?(handler: (event: { agentId: string; speakerName: string; status: 'completed' | 'failed' | 'timeout' | 'interrupted' }) => void): () => void;
  onPetAction?(handler: (event: { agentId: string; action: string }) => void): void;
  onPetBubble?(handler: (event: { agentId: string; text: string; kind?: 'thought' | 'dialog' }) => void): void;
  onPetState?(handler: (event: { agentId: string; state?: unknown }) => void): void;
  onScaleChanged?(handler: (scale: number) => void): void;
  characterManifest(id: string): Promise<{ ok: boolean; manifest?: unknown; error?: string }>;
  /** T-M6-48：CrossPet pose-skin 预置台词（character.json.lines） */
  crossPetLines(characterId: string): Promise<Record<string, string[]>>;
  /** T-M6-48：友谊涨分（摸头/戳/协作）与睡眠态上报（提醒免打扰） */
  friendRecord?(characterId: string, action: 'pat' | 'poke' | 'chat' | 'cowork' | 'cofinish'): Promise<unknown>;
  sleepState?(agentId: string, asleep: boolean): void;
  /** T-M6-48：当天首次见面问候（主进程按日去重） */
  friendMeet?(characterId: string): Promise<string>;
  /** T-M6-48：多宠互撞 */
  onPetBump?(handler: (payload: { partner: string; partnerName: string }) => void): void;
  /** T-M6-48：eggs 彩蛋被点中 → 逃跑关窗 */
  petFlee?(agentId: string): Promise<{ ok: boolean; fled?: boolean }>;
  petAssemble?(): Promise<{ ok: boolean; windows: unknown[] }>;
  petDismiss?(): Promise<{ ok: boolean; closed: number }>;
  petEggSummon?(): Promise<{ ok: boolean; agentId?: string; name?: string; error?: string }>;
  petOpenNotebook?(): Promise<{ ok: boolean }>;
  characterList?(): Promise<Array<{ id: string; displayName: string; packId?: string }>>;
  petSummon?(characterId: string): Promise<{ ok: boolean; agentId?: string; error?: string }>;
  /** T-M6-53：工作跟随代理/验收台按姿态名直放 */
  onPetPose?(handler: (payload: { pose: string; line?: string; source?: 'work-follow' | 'bench' }) => void): void;
  customPoseConfig?(characterId: string): Promise<{ ok: boolean; correctedPose?: string; longThink?: { after: number; pose: string }; pokePose?: string; fx?: Record<string, string>; egg?: boolean; idleActions?: string[]; glyph?: { fill?: string; stroke?: string; text?: string }; apps?: string[] }>;
  /** T-M6-55：时段/节日首见登场（主进程按角色+日期+键去重） */
  customGreeting?(characterId: string): Promise<{ ok: boolean; greeting?: { key: string; pose: string; line: string } | null }>;
  /** T-M6-55：验收台参考线与姿态轮播 */
  onBenchGuides?(handler: (payload: { on: boolean }) => void): void;
  onBenchCarousel?(handler: (payload: { on: boolean; pose?: string; index?: number; total?: number }) => void): void;
  /** 自定义角色热重载：重新读取注册表与 manifest（零重启） */
  reloadCharacters?(): Promise<{ ok: boolean; count?: number }>;
  /** T-M6-53：验收台暂停/睡眠演练与创作中心/验收台入口 */
  onBenchSleep?(handler: (payload: { asleep: boolean }) => void): void;
  onPauseEvents?(handler: (payload: { paused: boolean }) => void): void;
  openCreator?(): Promise<{ ok: boolean }>;
  openBench?(): Promise<{ ok: boolean }>;
  /** T-M6-49：本机驱动口/工作跟随下发 */
  onPetSay?(handler: (payload: { text: string }) => void): void;
  onPetWake?(handler: () => void): void;
  onPetCrown?(handler: (payload: { on: boolean }) => void): void;
  onCharacterChanged?(handler: (character: { id: string; anchorRatio: number }) => void): void;
  riceStatus(): Promise<{ balance: number; budget: number; consumedToday: number; level: string }>;
  appMeta(): Promise<{ transparent: boolean; frame: boolean; alwaysOnTop: boolean; skipTaskbar: boolean; testMode: boolean }>;
  forceAlpha?(alpha: number): Promise<boolean>;
  onTestAlpha?(handler: (alpha: number) => void): void;
}

declare global {
  interface Window {
    petStage: PetStageBridge;
  }
}

const bridge = window.petStage;
/**
 * 多桌宠：窗口身份只从 URL hash 读取（`#/pet-stage?agentId=...&characterId=...`）。
 * 无 hash 的旧启动方式回落 default，保持单窗兼容。
 */
function readPetStageContext(): { agentId: string; characterId?: string } {
  const decode = (url: URLSearchParams): { agentId: string; characterId?: string } => {
    const agentId = url.get('agentId')?.trim() || 'default';
    const characterId = url.get('characterId')?.trim() || undefined;
    return { agentId, ...(characterId === undefined ? {} : { characterId }) };
  };
  const hashQuery = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '';
  if (hashQuery !== '') return decode(new URLSearchParams(hashQuery));
  return decode(new URLSearchParams(location.search));
}
const petContext = readPetStageContext();
const interaction = createInteractionState();
let dockedEdge: 'left' | 'right' | null = null;
let dockHomeEdge: 'left' | 'right' | null = null;
const dockedAgentId = petContext.agentId;
let pointerOnStage = false;
let lastActivityAt = Date.now();
let powerSaver = false;
let bubbleState: BubbleLifecycleState = createBubbleLifecycle();
let bubbleVoiceEnabled = true;
let clickTimer: ReturnType<typeof setTimeout> | null = null;
let lastDizzyVisual = 0;
let slingshotRaf = 0;
const isEventForThisPet = (agentId: string | undefined): boolean =>
  agentId === undefined ? petContext.agentId === 'default' : agentId === '*' || agentId === petContext.agentId;
const stage = document.getElementById('stage') as HTMLDivElement;
const badgeEl = document.getElementById('dev-badge') as HTMLDivElement;

// ---- RendererHost（真实 DOM） ----
const host: RendererHost = {
  mountVideo(handle) {
    const el = handle.el as HTMLVideoElement;
    el.style.opacity = '0';
    stage.appendChild(el);
  },
  showVideo(handle) {
    (handle.el as HTMLVideoElement).style.opacity = '1';
  },
  hideVideo(handle) {
    (handle.el as HTMLVideoElement).style.opacity = '0';
  },
  detachVideo(handle) {
    (handle.el as HTMLVideoElement).remove();
  },
  setDevBadge(text) {
    // D5 用户豁免（2026-11-21）：本地自用不显示非商用提示 UI；licenseScope 数据与台账登记保持完整。
    // 公开/商用前必须恢复显示（还原为：badgeEl.textContent = text ?? ''; badgeEl.style.display = text ? 'block' : 'none';）
    badgeEl.style.display = 'none';
    if (text) console.debug('[pet-stage] DEV 素材标记（UI 已按 D5 豁免隐藏）：', text);
  },
  applyLayout(layout) {
    stage.style.left = `${layout.offsetX}px`;
    stage.style.top = `${layout.offsetY}px`;
  },
  applySquash(pose) {
    stage.style.scale = `${pose.scaleX} ${pose.scaleY}`;
  },
};

const videoFactory: VideoFactory = (src): VideoHandle => {
  const el = document.createElement('video');
  el.src = src;
  el.muted = true;
  el.playsInline = true;
  el.style.position = 'absolute';
  let rejectLoad: ((reason: Error) => void) | null = null;
  el.addEventListener('error', () => rejectLoad?.(new Error('video load error')));
  return {
    src,
    el,
    play(loop, playbackRate) {
      return new Promise((resolve, reject) => {
        rejectLoad = reject;
        el.loop = loop;
        el.playbackRate = playbackRate;
        const onReady = () => {
          el.removeEventListener('loadeddata', onReady);
          el.play().then(() => resolve()).catch(reject);
        };
        if (el.readyState >= 2) onReady();
        else el.addEventListener('loadeddata', onReady);
      });
    },
    pause() {
      el.pause();
    },
    detach() {
      el.remove();
    },
  };
};

const webmRenderer = new WebmVideoRenderer({ host, videoFactory });
let renderer: WebmVideoRenderer | SpritesheetRenderer | PoseSkinRenderer = webmRenderer;

/** T-M6-48：CrossPet 姿势图句柄（<img> 交叉淡入）。 */
class PoseImageSurface implements VideoHandle {
  readonly src: string;
  readonly el: HTMLImageElement;
  constructor(src: string) {
    this.src = src;
    this.el = document.createElement('img');
    this.el.decoding = 'async';
    this.el.style.position = 'absolute';
    this.el.style.width = `${BASE_STAGE.width}px`;
    this.el.style.height = `${BASE_STAGE.height}px`;
    this.el.style.objectFit = 'contain';
    this.el.style.opacity = '0';
    this.el.style.transition = 'opacity 220ms ease';
  }
  play(): Promise<void> {
    // 创建时机可能晚于初始 applyStageScale；这里按当前缩放补一次，避免小窗时图超出舞台
    this.el.style.width = `${BASE_STAGE.width * petScale}px`;
    this.el.style.height = `${BASE_STAGE.height * petScale}px`;
    return new Promise((resolve, reject) => {
      this.el.onload = () => resolve();
      this.el.onerror = () => reject(new Error(`姿势图加载失败：${this.src}`));
      this.el.src = this.src;
      if (this.el.complete && this.el.naturalWidth > 0) resolve();
    });
  }
  pause(): void { /* 静态图无需暂停 */ }
  detach(): void { this.el.remove(); }
}

const poseImageFactory = (src: string): PoseImageSurface => new PoseImageSurface(src);

/** CrossPet 姿势 → 头顶 SVG 动效（T-M6-48）。 */
const POSE_EFFECTS: Record<string, string> = {
  pat: 'heart', happy: 'sparkle', proud: 'sparkle', coaxed: 'heart', hum: 'note',
  sleeping: 'zzz', sulk: 'zzz', puffed: 'steam', redhot: 'steam', annoyed: 'anger', dizzy: 'anger',
};
const poseEffectLayer = document.createElement('div');
poseEffectLayer.id = 'pose-effect-layer';
poseEffectLayer.style.cssText = 'position:absolute;left:50%;top:0;transform:translateX(-50%);pointer-events:none;z-index:6;display:flex;gap:2px';
stage.appendChild(poseEffectLayer);
let lastEffect = '';
function renderPoseEffect(raw: string | null): void {
  // 自定义 fx 先用别名归一（celebrate/priceDown…），未识别不画空壳
  const kind = raw === null ? null : normalizePoseEffect(raw);
  if (kind === lastEffect) return;
  lastEffect = kind ?? '';
  poseEffectLayer.innerHTML = '';
  if (kind === null) return;
  const svg = poseEffectSvg(kind);
  for (const offset of poseEffectOffsets(kind)) {
    const holder = document.createElement('span');
    holder.style.cssText = `position:absolute;transform:translate(${offset.dx}px,${offset.dy}px);animation:poseFloat 1.6s ease-in-out ${offset.delayMs}ms infinite`;
    holder.innerHTML = svg;
    poseEffectLayer.appendChild(holder);
  }
}
setInterval(() => {
  if (!(renderer instanceof PoseSkinRenderer)) { renderPoseEffect(null); return; }
  renderPoseEffect(renderer.effectOf(renderer.currentAction() ?? 'idle'));
}, 700);

class CanvasSpriteSurface implements VideoHandle {
  readonly src: string;
  readonly el: HTMLCanvasElement;
  private image: HTMLImageElement | null = null;
  private raf = 0;
  private paused = false;
  private lastDrawAt = 0;
  constructor(src: string, private readonly meta: SpriteMeta, private readonly rate: number) {
    this.src = src;
    this.el = document.createElement('canvas');
    this.el.width = meta.frameWidth;
    this.el.height = meta.frameHeight;
    this.el.style.position = 'absolute';
    this.el.style.width = `${BASE_STAGE.width}px`;
    this.el.style.height = `${BASE_STAGE.height}px`;
  }
  async play(loop: boolean): Promise<void> {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`精灵图加载失败：${this.src}`));
      img.src = this.src;
    });
    this.image = image;
    const start = performance.now();
    const draw = (now: number): void => {
      if (this.paused) return;
      if (powerSaver && now - this.lastDrawAt < 1000 / 30) { this.raf = requestAnimationFrame(draw); return; }
      this.lastDrawAt = now;
      const ctx = this.el.getContext('2d');
      if (ctx !== null && this.image !== null) {
        const index = spriteFrameIndex(this.meta, (now - start) * this.rate, loop);
        const rect = spriteFrameRect(this.meta, index);
        ctx.clearRect(0, 0, this.meta.frameWidth, this.meta.frameHeight);
        ctx.drawImage(this.image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, this.meta.frameWidth, this.meta.frameHeight);
      }
      if (!loop && spriteFrameIndex(this.meta, (now - start) * this.rate, false) >= this.meta.frameCount - 1) return;
      this.raf = requestAnimationFrame(draw);
    };
    const ctx = this.el.getContext('2d');
    if (ctx !== null) {
      const rect = spriteFrameRect(this.meta, 0);
      ctx.clearRect(0, 0, this.meta.frameWidth, this.meta.frameHeight);
      ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, this.meta.frameWidth, this.meta.frameHeight);
    }
    this.raf = requestAnimationFrame(draw);
  }
  pause(): void { this.paused = true; cancelAnimationFrame(this.raf); }
  detach(): void { this.pause(); this.el.remove(); }
}

let activeSpriteAudio: HTMLAudioElement | null = null;
let sfxVolume = 0.7;
let speakerDucking = false;
const spriteAudio: SpriteAudioController = {
  async play(src, opts) {
    activeSpriteAudio?.pause();
    const audio = new Audio(src);
    activeSpriteAudio = audio;
    audio.volume = opts.volume;
    await audio.play();
  },
  stop() { activeSpriteAudio?.pause(); activeSpriteAudio = null; },
  setVolume(volume) {
    sfxVolume = volume;
    if (activeSpriteAudio !== null) activeSpriteAudio.volume = speakerDucking ? volume * 0.15 : volume;
  },
};
const surfaceFactory = (src: string, meta: SpriteMeta, rate: number): VideoHandle => new CanvasSpriteSurface(src, meta, rate);


// 装载当前角色真形象清单（T-M6-21：manifest 经主进程契约校验后由 IPC 下发，不再写死 blue-whale-maid）
type PetAvatarManifest = import('@workbench/shared-protocol').PetAvatarManifest;
type SpriteMeta = import('@workbench/shared-protocol').PetSpriteMeta;
/** 当前窗口正显示的角色（友谊记分 / pose 台词用）。 */
let currentCharacterId = petContext.characterId ?? 'blue-whale-maid';
/** 自定义角色的纠正/长思考姿态（T-M6-53）与闲时动作/飘字/前台应用（T-M6-55） */
let poseConfig: {
  correctedPose?: string;
  longThink?: { after: number; pose: string };
  pokePose?: string;
  fx?: Record<string, string>;
  egg?: boolean;
  idleActions?: string[];
  glyph?: GlyphConfig;
  apps?: string[];
} | null = null;
/** 当前实际播放的姿态名（参考线角标用；未知时回退动作槽位） */
let lastPoseName = 'idle';
let lastFailureAt = 0;
let longThinkTimer: ReturnType<typeof setTimeout> | null = null;
async function loadCharacterManifest(id: string): Promise<void> {
  currentCharacterId = id;
  const res = await bridge.characterManifest(id);
  if (!res.ok || res.manifest === undefined) throw new Error(res.error ?? 'manifest 不可用');
  const rawManifest = res.manifest as PetAvatarManifest;
  // webmPath 为仓库视角（assets/...）→ 渲染进程相对 html 改写为 ./assets/...
  for (const action of rawManifest.actions) {
    for (const clip of action.clips) {
      if (clip.webmPath.startsWith('assets/')) clip.webmPath = `./${clip.webmPath}`;
    }
  }
  // 自定义角色配置必须先取：fx 要并入 PoseSkinRenderer，pokePose/egg 后续交互直接消费
  const config = bridge.customPoseConfig === undefined
    ? null
    : await bridge.customPoseConfig(id).catch(() => null);
  if (rawManifest.renderer === 'sprite-sheet') {
    renderer.dispose();
    renderer = new SpritesheetRenderer({
      host,
      surfaceFactory,
      audio: spriteAudio,
      sfxVolume,
      spriteMetaLoader: async (src) => (await fetch(src)).json() as Promise<unknown>,
    });
  } else if (rawManifest.renderer === 'pose-skin') {
    const lines = await bridge.crossPetLines(id).catch(() => ({}));
    renderer.dispose();
    renderer = new PoseSkinRenderer({
      host,
      imageFactory: poseImageFactory,
      lines,
      effects: mergePoseEffects(POSE_EFFECTS, config?.ok === true ? config.fx : undefined),
    });
  } else if (!(renderer instanceof WebmVideoRenderer)) {
    renderer.dispose();
    renderer = webmRenderer;
  }
  await renderer.load(rawManifest);
  await renderer.play('idle');
  poseConfig = config?.ok === true ? config : null;
  lastFailureAt = 0;
  if (longThinkTimer !== null) { clearTimeout(longThinkTimer); longThinkTimer = null; }
}
void (async () => {
  const globals = await bridge.prefsGet();
  let characterId = petContext.characterId;
  if (characterId === undefined) {
    const own = await bridge.windowPrefsGet(petContext.agentId).catch(() => null);
    characterId = own?.characterId ?? globals.characterId;
  }
  await loadCharacterManifest(characterId);
  playGreeting(characterId);
})().catch((error) => console.warn('[pet-stage] 角色清单未就绪（回退占位渲染）：', error));
bridge.onCharacterChanged?.((character) => {
  // manager 只会向 default 窗口发送全局角色快切；各联机窗角色由 URL/窗口 prefs 固定
  if (typeof character.anchorRatio === 'number') {
    document.documentElement.style.setProperty('--pet-anchor-ratio', String(character.anchorRatio));
  }
  void loadCharacterManifest(character.id)
    .then(() => playGreeting(character.id))
    .catch((error) => console.warn('[pet-stage] 角色切换失败：', error));
});

/**
 * 首见登场（T-M6-55）：自定义角色的节日姿态 → 时段姿态 → 缺图回退原每日问候。
 * 去重在主进程（角色 id + 日期 + 键），这里只负责播图与弹台词。
 */
function playGreeting(characterId: string): void {
  void (async () => {
    const custom = bridge.customGreeting === undefined
      ? null
      : await bridge.customGreeting(characterId).catch(() => null);
    const greeting = custom?.ok === true ? custom.greeting ?? null : null;
    if (greeting !== null) {
      if (renderer instanceof PoseSkinRenderer) {
        try {
          await renderer.playPose(greeting.pose);
          lastPoseName = greeting.pose;
        } catch {
          /* 缺图已由主进程过滤，播放失败仍继续弹问候 */
        }
      }
      if (greeting.line !== '') {
        widgets.showDialog(greeting.line);
        setTimeout(() => widgets.hideDialog(), 9_000);
      }
      lastEventAt = Date.now();
      return;
    }
    const line = await bridge.friendMeet?.(characterId).catch(() => '') ?? '';
    if (line === '') return;
    widgets.showDialog(line);
    setTimeout(() => widgets.hideDialog(), 9_000);
  })();
}

// ---- T-M5-16（D16）：动作库预览 + ambient 空闲随机链 + 三层情绪映射 ----
let lastEventAt = Date.now();
let thoughtTimer: ReturnType<typeof setTimeout> | undefined;
let dialogTimer: ReturnType<typeof setTimeout> | undefined;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
const AMBIENT_IDLE_MS = 30_000;   // 空闲 30s 播一条氛围动作
const AMBIENT_PLAY_MS = 6_000;    // 播 6s 回 idle

// 预览：Shell 动作库页点击 → main pets:preview → preload 桥 petStage.onPetPreview → 本窗即播
const petStageBridge = (window as unknown as {
  petStage?: {
    onPetPreview?: (h: (d: { action: string; clipId: string | null }) => void) => void;
    onPetRice?: (h: (d: { level: string; balance: number }) => void) => void;
    riceStatus?: () => Promise<{ balance: number; budget: number; consumedToday: number; level: string }>;
  };
}).petStage;
// D16：饭碗档位 → 桌宠动作（hungry→饿瘪/starving→睡觉/fed_buff→开吃/full→女仆礼）
// 2026-11-22 改版：饭碗默认隐藏（hover 桌宠显示 / 米量 <15% 强制亮灯），并随档位事件实时刷新真实米量
let hoverOnPet = false;
let lastRiceRatio = 1;
/** 饭碗显隐统一入口：hover 或饿态（<15%）才显示，平时不占桌面视觉（widget 在下方挂载，回调晚于初始化） */
function refreshRiceWidget(ratio?: number): void {
  if (ratio !== undefined) {
    lastRiceRatio = Math.min(Math.max(ratio, 0), 1);
    riceBowlWidget.setRatio(lastRiceRatio);
  }
  if (hoverOnPet || lastRiceRatio < 0.15) riceBowlWidget.show();
  else riceBowlWidget.hide();
}
if (petStageBridge?.onPetRice) {
  petStageBridge.onPetRice((detail) => {
    if (shouldBlockWhileAsleep(interaction, 'rice')) return;
    const action = RICE_LEVEL_ACTION_MAP[detail.level as keyof typeof RICE_LEVEL_ACTION_MAP];
    if (action) void renderer.play(action).catch(() => undefined);
    lastEventAt = Date.now(); // 档位事件抑制 ambient 链
    // 随档位事件刷新真实米量：budget 从 bridge 异步读取（widget 已在下方挂载，此处回调晚于初始化）
    void petStageBridge?.riceStatus?.().then((st) => {
      if (st.budget > 0) refreshRiceWidget(detail.balance / st.budget);
    }).catch(() => undefined);
  });
}
if (petStageBridge?.onPetPreview) {
  petStageBridge.onPetPreview((detail) => {    if (detail.clipId) {
      const manifest = renderer.manifest;
      // ambient 单条：先找槽位（语义命中播槽位）→ 不在槽位则直查 ambientPool 走 playClip
      const slotAction = previewActionFor(detail.clipId);
      const ambientEntry = manifest?.ambientPool.find((c) => c.clipId === detail.clipId);
      const slotClip = manifest?.actions.flatMap((a) => a.clips).find((c) => c.clipId === detail.clipId);
      if (slotAction && slotClip) {
        void renderer.play(slotAction).catch(() => undefined);
      } else if (ambientEntry) {
        void renderer.playClip({ ...ambientEntry, loop: false, playbackRate: 1, fps: 24, weight: ambientEntry.weight }).catch(() => undefined);
      } else {
        void renderer.play(detail.action as PetActionState).catch(() => undefined);
      }
    } else {
      void renderer.play(detail.action as PetActionState).catch(() => undefined);
    }
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      void renderer.play('idle');
    }, AMBIENT_PLAY_MS);
  });
}
// T-M6-53：验收台暂停真实事件 / 睡眠演练
let eventsPaused = false;
bridge.onPauseEvents?.((payload) => { eventsPaused = payload.paused; });
bridge.onBenchSleep?.((payload) => {
  if (payload.asleep) { if (!interaction.asleep) toggleSleep(); }
  else if (interaction.asleep) wakeUp();
});

// T-M6-53：按姿态名直放（pose-skin）；缺失回退已由主进程解析
bridge.onPetPose?.((payload) => {
  // 验收台演练期间屏蔽真实工作跟随事件（bench 自身除外）
  if (eventsPaused && payload.source !== 'bench') return;
  if (!(renderer instanceof PoseSkinRenderer)) return;
  void renderer.playPose(payload.pose).then(() => {
    lastPoseName = payload.pose;
    // T-M6-55：读文件/搜索 → 代码符号飘字；回 idle 立即清空
    if (isReadingOrSearchingPose(payload.pose)) showGlyphs();
    else if (payload.pose === 'idle') clearGlyphs();
    if (payload.line !== undefined && payload.line !== '') {
      widgets.showDialog(payload.line);
      setTimeout(() => widgets.hideDialog(), 8_000);
    }
    lastEventAt = Date.now();
  }).catch(() => undefined);
});

// ── T-M6-55：代码符号飘字层（阅读/搜索姿态触发，省电自动关闭） ──
const glyphLayer = document.createElement('div');
glyphLayer.id = 'glyph-layer';
glyphLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5';
stage.appendChild(glyphLayer);
const glyphKeyframes = document.createElement('style');
glyphKeyframes.textContent = '@keyframes whaleGlyphFloat{0%{opacity:0;transform:translateY(0) rotate(var(--glyph-rotate,0deg))}18%{opacity:.92}100%{opacity:0;transform:translateY(-86px) rotate(var(--glyph-rotate,0deg))}}';
document.head.appendChild(glyphKeyframes);
let glyphActive = false;
function clearGlyphs(): void {
  if (glyphLayer.childElementCount > 0) glyphLayer.replaceChildren();
  glyphActive = false;
}
function showGlyphs(): void {
  if (powerSaver) return;
  clearGlyphs();
  const colors = glyphColors(poseConfig?.glyph ?? null);
  for (const particle of glyphParticles(poseConfig?.glyph ?? null)) {
    const el = document.createElement('span');
    el.textContent = particle.symbol;
    el.style.cssText = `position:absolute;left:${particle.leftPercent}%;bottom:${particle.bottomPx}px;
      font:700 ${particle.sizePx}px ui-monospace, SFMono-Regular, Menlo, monospace;
      color:${colors.fill};-webkit-text-stroke:1px ${colors.stroke};paint-order:stroke fill;
      opacity:0;--glyph-rotate:${particle.rotateDeg}deg;
      animation:whaleGlyphFloat ${particle.durationMs}ms ease-out ${particle.delayMs}ms forwards;`;
    glyphLayer.appendChild(el);
  }
  glyphActive = true;
}

// ── T-M6-55：验收台参考线层（90% 身高虚线框 + 97% 脚底基线 + 当前姿态角标） ──
const guideLayer = document.createElement('div');
guideLayer.id = 'guide-layer';
guideLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9;display:none';
guideLayer.innerHTML = [
  '<div style="position:absolute;left:14%;right:14%;top:7%;height:90%;border:1.5px dashed rgba(111,183,255,.62);border-radius:10px"></div>',
  '<div style="position:absolute;left:0;right:0;top:97%;border-top:1.5px dashed rgba(48,209,88,.85)"></div>',
  '<div style="position:absolute;left:6px;top:97%;transform:translateY(-13px);font:9px ui-monospace,monospace;color:#7ee2a8;background:rgba(8,14,24,.72);padding:1px 5px;border-radius:5px">97% 脚底基线</div>',
  '<div style="position:absolute;left:6px;top:7%;font:9px ui-monospace,monospace;color:#9ccfff;background:rgba(8,14,24,.72);padding:1px 5px;border-radius:5px">90% 身高</div>',
  '<div id="guide-label" style="position:absolute;right:6px;top:4px;font:10px ui-monospace,monospace;color:#cfe6ff;background:rgba(8,14,24,.78);padding:2px 6px;border-radius:6px;border:1px solid rgba(111,183,255,.4)">姿态 idle</div>',
].join('');
stage.appendChild(guideLayer);
const guideLabel = guideLayer.querySelector('#guide-label') as HTMLDivElement | null;
function setGuidesVisible(on: boolean): void {
  guideLayer.style.display = on ? 'block' : 'none';
  if (on) updateGuideLabel(lastPoseName);
}
function updateGuideLabel(pose: string): void {
  if (guideLabel !== null) guideLabel.textContent = `姿态 ${pose} · 1.5s 轮播`;
}
bridge.onBenchGuides?.((payload) => { setGuidesVisible(payload.on); });
bridge.onBenchCarousel?.((payload) => {
  if (!payload.on) {
    setGuidesVisible(false);
    lastPoseName = 'idle';
    clearGlyphs();
    return;
  }
  setGuidesVisible(true);
  if (payload.pose !== undefined) {
    lastPoseName = payload.pose;
    updateGuideLabel(payload.pose);
  }
});

// T-M6-48：两只桌宠撞在一起 → Q 弹互撞 + 吐槽（主进程按真实窗口几何触发）
bridge.onPetBump?.((payload) => {
  if (shouldBlockWhileAsleep(interaction, 'ambient')) return;
  void renderer.play('clumsy_panic').catch(() => undefined);
  stage.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
    { duration: 260, iterations: 2 },
  );
  widgets.showDialog(`哎呀，撞到${payload.partnerName}了，你走路不看路呀！`);
  setTimeout(() => widgets.hideDialog(), 6_000);
  lastEventAt = Date.now();
});
// T-M6-49：本机驱动口 say / wake / 工作跟随戴皇冠
bridge.onPetSay?.((payload) => {
  wakeUp();
  widgets.showDialog(payload.text);
  void renderer.play('happy_maid').catch(() => undefined);
  setTimeout(() => widgets.hideDialog(), 8_000);
  lastEventAt = Date.now();
});
bridge.onPetWake?.(() => { wakeUp(); });
const crownLayer = document.createElement('div');
crownLayer.id = 'crown-layer';
crownLayer.style.cssText = 'position:absolute;left:50%;top:-6px;transform:translateX(-50%);z-index:7;pointer-events:none;display:none';
crownLayer.innerHTML = '<svg viewBox="0 0 32 22" width="34" height="24" aria-label="大活皇冠"><path d="M2 19 3.5 6l7 5L16 3l5.5 8 7-5L30 19Z" fill="#ffd166" stroke="#c99a1e" stroke-width="1.2" stroke-linejoin="round"/><rect x="4" y="19" width="24" height="2.4" rx="1.2" fill="#e0a92a"/></svg>';
stage.appendChild(crownLayer);
bridge.onPetCrown?.((payload) => {
  crownLayer.style.display = payload.on ? 'block' : 'none';
  if (payload.on) {
    widgets.showDialog('大活干完啦，戴上小皇冠！');
    setTimeout(() => widgets.hideDialog(), 8_000);
  }
});

// ---- autodrive 事件驱动（T-M5-02 宿主层）：回执 → 动作映射（人格化） ----
type AutodriveEventLite = {
  type: 'state' | 'decision' | 'receipt' | 'watchdog' | 'cycle-end' | 'user';
  tool?: string; status?: string; summary?: string; intent?: string; clock?: string;
  /** T-M6-27 会话归属：联机端点事件（agentId）与旧 generation 事件不驱动主桌宠 */
  agentId?: string; generation?: number;
};
if (window.directorBridge?.onAutodriveEvent) {
  let latestGeneration = -1;
  window.directorBridge.onAutodriveEvent((event: AutodriveEventLite) => {
    // T-M6-38：只消费本窗 agent 的事件；无 agentId 的旧单机事件只归 default，
    // 避免单机自驾回执把其他联机桌宠也带着播动作/气泡。
    if (!isEventForThisPet(event.agentId)) return;
    if (eventsPaused) return;
    // T-M6-53：出错/打断后 3 分钟内再次对话 → 播放自定义 correctedPose（一次性）
    if (event.type === 'receipt' && (event.status === 'FAILED' || event.status === 'UNCERTAIN')) lastFailureAt = Date.now();
    if (event.type === 'receipt' && event.tool === 'chat_reply' && lastFailureAt > 0 && Date.now() - lastFailureAt < 180_000) {
      if (poseConfig?.correctedPose !== undefined && renderer instanceof PoseSkinRenderer) {
        void renderer.playPose(poseConfig.correctedPose).catch(() => undefined);
      }
      lastFailureAt = 0;
    }
    // 长思考：decision 后超过 longThink.after 秒仍未完成 → 切 deepthink 姿态
    if (longThinkTimer !== null) { clearTimeout(longThinkTimer); longThinkTimer = null; }
    if (event.type === 'decision' && poseConfig?.longThink !== undefined && renderer instanceof PoseSkinRenderer) {
      const { after, pose } = poseConfig.longThink;
      longThinkTimer = setTimeout(() => {
        longThinkTimer = null;
        if (renderer instanceof PoseSkinRenderer) void renderer.playPose(pose).catch(() => undefined);
      }, Math.max(1, after) * 1_000);
    }
    if (shouldBlockWhileAsleep(interaction, event.type === 'receipt' ? 'work' : 'thought')) return;
    lastActivityAt = Date.now();
    if (dockedEdge !== null) {
      const edge = dockedEdge;
      dockedEdge = null;
      void bridge.dockWindow?.(dockedAgentId, null);
      if (edge !== null) scheduleDockBack(edge);
    }
    // 旧会话的迟到事件（切游戏/重启后）不得再驱动动画与内心戏
    if (typeof event.generation === 'number') {
      if (event.generation < latestGeneration) return;
      latestGeneration = event.generation;
    }
    lastEventAt = Date.now();
    // 双轨气泡（设计稿 §L1/L2）：decision 意图 → 紫云朵内心戏；回话/反射 → 正式对话泡
    if (event.type === 'decision' && typeof event.intent === 'string' && event.intent.length > 0) {
      widgets.showThought(event.intent);
      clearTimeout(thoughtTimer);
      thoughtTimer = setTimeout(() => widgets.hideThought(), 12_000);
    }
    if (event.type === 'receipt' && (event.tool === 'chat_reply' || event.tool === 'reflex_spray') && event.summary) {
      const voiceBridge = (window as unknown as { directorBridge?: { voiceConfigGet?: () => Promise<{ enabled: boolean }> } }).directorBridge;
      void voiceBridge?.voiceConfigGet?.().then((config) => { bubbleVoiceEnabled = config.enabled; }).catch(() => undefined);
      const effect = showBubble(bubbleState, event.summary, Date.now(), bubbleVoiceEnabled);
      bubbleState = effect.state;
      widgets.showDialog(event.summary);
      widgets.setDialogMuted(effect.muted);
    }
    if (event.type === 'receipt' && event.status && event.tool !== 'autodrive') {
      const kind = classifyAutodriveReceipt(event.status, event.tool ?? '', event.summary ?? '');
      const action = GAME_EVENT_ACTION_MAP[kind];
      if (action) void renderer.play(action);
    }
    if (event.type === 'decision') void renderer.play('game_focus');
    if (event.type === 'state' && typeof event.clock === 'string') {
      widgets.showThought(`星露谷 ${event.clock}`);
    }
  });
}

// ── T-M6-38：多桌宠发言态 / 定向动作 / 定向气泡 ──
// 同一时刻最多一只 speaking；非发言桌宠切倾听微动作，idle 后回无事态。
let listeningToTeammate = false;
bridge.onCoopSpeaker?.((event) => {
  speakerDucking = event.state === 'speaking';
  if (renderer instanceof SpritesheetRenderer) renderer.setSpeakerActive(speakerDucking);
  if (event.state === 'speaking') {
    if (event.activeAgentId === petContext.agentId) {
      bubbleState = speechStarted(bubbleState).state;
      listeningToTeammate = false;
      lastEventAt = Date.now();
      // 现有角色动作库没有独立 talk 槽位：用「认真状态」承载开口播报，避免假装有口型资产
      void renderer.play('game_focus').catch(() => undefined);
    } else if (event.activeAgentId !== null) {
      listeningToTeammate = true;
      void renderer.play('thinking_tail_wag').catch(() => undefined);
    }
  } else {
    const effect = speakerIdle(bubbleState);
    bubbleState = effect.state;
    if (effect.hide) widgets.hideDialog();
    if (listeningToTeammate) {
      listeningToTeammate = false;
      void renderer.play('idle').catch(() => undefined);
    }
  }
});
bridge.onSpeechResult?.((event) => {
  if (!isEventForThisPet(event.agentId)) return;
  const effect = speechResult(bubbleState, event.status);
  bubbleState = effect.state;
  if (effect.hide) widgets.hideDialog();
  widgets.setDialogMuted(effect.muted);
});
bridge.onPetAction?.((event) => {
  if (!isEventForThisPet(event.agentId)) return;
  lastEventAt = Date.now();
  void renderer.play(event.action as PetActionState).catch(() => undefined);
});
bridge.onPetBubble?.((event) => {
  if (!isEventForThisPet(event.agentId)) return;
  lastEventAt = Date.now();
  if (event.kind === 'thought') {
    widgets.showThought(event.text);
    clearTimeout(thoughtTimer);
    thoughtTimer = setTimeout(() => widgets.hideThought(), 12_000);
  } else {
    widgets.showDialog(event.text);
    clearTimeout(dialogTimer);
    dialogTimer = setTimeout(() => widgets.hideDialog(), 10_000);
  }
});
bridge.onPetState?.((event) => {
  if (!isEventForThisPet(event.agentId)) return;
  lastEventAt = Date.now();
  if (typeof event.state === 'string') widgets.showThought(event.state);
});

// ---- alpha 穿透探针 ----
const probeCanvas = document.createElement('canvas');
probeCanvas.width = 1;
probeCanvas.height = 1;
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
let stageOffset = { x: 0, y: 0 };
/** T-M6-20 缩放倍率：舞台/窗口按此倍率同步放大，探针采样需把窗口坐标换算回视频原始坐标 */
let petScale = 1;
const BASE_STAGE = { width: 400, height: 260 };
const originalApplyLayout = host.applyLayout.bind(host);
host.applyLayout = (layout) => {
  stageOffset = { x: layout.offsetX, y: layout.offsetY };
  originalApplyLayout(layout);
  applyStageScale();
};

/** 直接放大 CSS 尺寸（不用 transform，避免与 Q 弹的 scale 属性互相干扰）；脚线 offset 同比例 */
function applyStageScale(): void {
  stage.style.width = `${BASE_STAGE.width * petScale}px`;
  stage.style.height = `${BASE_STAGE.height * petScale}px`;
  stage.style.left = `${stageOffset.x * petScale}px`;
  stage.style.top = `${stageOffset.y * petScale}px`;
  for (const video of stage.querySelectorAll('video')) {
    video.style.width = `${BASE_STAGE.width * petScale}px`;
    video.style.height = `${BASE_STAGE.height * petScale}px`;
  }
  for (const canvas of stage.querySelectorAll('canvas')) {
    canvas.style.width = `${BASE_STAGE.width * petScale}px`;
    canvas.style.height = `${BASE_STAGE.height * petScale}px`;
  }
  // T-M6-51：CrossPet pose-skin 用 <img> 渲染，必须与 video/canvas 同步缩放
  for (const img of stage.querySelectorAll('img')) {
    img.style.width = `${BASE_STAGE.width * petScale}px`;
    img.style.height = `${BASE_STAGE.height * petScale}px`;
  }
}

/** 当前可见的姿势图（交叉淡入期间取透明度最高的那张）。 */
function activePoseImage(): HTMLImageElement | null {
  let best: HTMLImageElement | null = null;
  let bestOpacity = 0.05;
  for (const img of stage.querySelectorAll('img')) {
    if (img.naturalWidth === 0) continue;
    const opacity = Number(getComputedStyle(img).opacity);
    if (opacity > bestOpacity) {
      best = img;
      bestOpacity = opacity;
    }
  }
  return best;
}

/**
 * <img> + object-fit: contain 的 alpha 采样：先把舞台坐标换算到图片实际绘制矩形，
 * 再映射到 natural 像素并只画 1×1 到探针画布。
 */
function samplePoseImageAlpha(img: HTMLImageElement, vx: number, vy: number): number {
  const point = poseSamplePoint(BASE_STAGE.width, BASE_STAGE.height, img.naturalWidth, img.naturalHeight, vx, vy);
  if (point === null) return 0;
  try {
    probeCtx?.clearRect(0, 0, 1, 1);
    probeCtx?.drawImage(img, point.sx, point.sy, 1, 1, 0, 0, 1, 1);
    return probeCtx?.getImageData(0, 0, 1, 1).data[3] ?? 0;
  } catch {
    return 0;
  }
}

async function sampleAlpha(): Promise<number> {
  const video = stage.querySelector('video');
  const sprite = stage.querySelector('canvas');
  const pose = activePoseImage();
  if ((!video || video.readyState < 2) && sprite === null && pose === null) return 0;
  const point = await bridge.mousePoint();
  const winPos = await bridge.winPosition();
  if (!winPos) return 0;
  const vx = (point.x - winPos[0]) / petScale - stageOffset.x;
  const vy = (point.y - winPos[1]) / petScale - stageOffset.y;
  if (video !== null && video.readyState >= 2) {
    ctxDraw(video, vx * video.videoWidth / BASE_STAGE.width, vy * video.videoHeight / BASE_STAGE.height);
    return probeCtx?.getImageData(0, 0, 1, 1).data[3] ?? 0;
  }
  if (sprite !== null) {
    const ctx = sprite.getContext('2d');
    if (ctx === null) return 0;
    const px = Math.round(vx * sprite.width / BASE_STAGE.width);
    const py = Math.round(vy * sprite.height / BASE_STAGE.height);
    if (px < 0 || py < 0 || px >= sprite.width || py >= sprite.height) return 0;
    return ctx.getImageData(px, py, 1, 1).data[3] ?? 0;
  }
  if (pose !== null) return samplePoseImageAlpha(pose, vx, vy);
  return 0;
}

function ctxDraw(video: HTMLVideoElement, sx: number, sy: number): void {
  probeCtx?.drawImage(video, sx, sy, 1, 1, 0, 0, 1, 1);
}

const probe = createAlphaProbe({
  sample: sampleAlpha,
  apply: (state) => void bridge.setPassthrough(state),
  intervalMs: 50,
});
probe.start();

// ---- T-M6-43 交互、防打扰与省电 ----
let altPeeking = false;
let powerSaverEnabled = true;
const setPeek = (active: boolean): void => {
  if (altPeeking === active) return;
  altPeeking = active;
  if (active) probe.stop(); else probe.start();
  void bridge.setPeek?.(active);
};
const wakeUp = (): void => {
  if (!interaction.asleep) return;
  setAsleep(interaction, false);
  bridge.sleepState?.(dockedAgentId, false);
  void renderer.play('idle').catch(() => undefined);
  lastEventAt = Date.now();
};
const toggleSleep = (): void => {
  if (interaction.asleep) { wakeUp(); return; }
  setAsleep(interaction, true);
  bridge.sleepState?.(dockedAgentId, true);
  headPat(interaction);
  void renderer.play('sleep_mute').catch(() => undefined);
};
/** 右键「戳一下」：自定义角色优先用自己的 pokePose，缺图才回退内置 rage_spray。 */
const playPokePose = (): void => {
  const custom = poseConfig?.pokePose;
  if (custom !== undefined && custom !== '' && renderer instanceof PoseSkinRenderer && renderer.availablePoses().includes(custom)) {
    void renderer.playPose(custom).catch(() => { void renderer.play('rage_spray').catch(() => undefined); });
    return;
  }
  void renderer.play('rage_spray').catch(() => undefined);
};
const patHeadOnce = (): void => {
  wakeUp();
  headPat(interaction);
  void bridge.friendRecord?.(currentCharacterId, 'pat').catch(() => undefined);
  // 串门彩蛋：CrossPet egg-* 与 userData 里 egg:true 的自定义角色被点中都逃跑（关窗）
  if (poseConfig?.egg === true || currentCharacterId.startsWith('crosspet-egg-')) {
    widgets.showDialog('被抓住了！下次再来串门～');
    setTimeout(() => { void bridge.petFlee?.(dockedAgentId).catch(() => undefined); }, 900);
    return;
  }
  lastDizzyVisual = 0;
  lastActivityAt = Date.now();
  void renderer.play('happy_maid').catch(() => undefined);
};
window.addEventListener('keydown', (event) => {
  if ((event.key === 's' || event.key === 'S') && !(event.target instanceof HTMLInputElement)) {
    if (!event.repeat) toggleSleep();
  }
});
stage.addEventListener('mouseenter', () => {
  pointerOnStage = true;
  lastActivityAt = Date.now();
  if (dockedEdge !== null) {
    const edge = dockHomeEdge;
    dockedEdge = null;
    void bridge.dockWindow?.(dockedAgentId, null);
    if (edge !== null) scheduleDockBack(edge);
  }
});
stage.addEventListener('mouseleave', () => { pointerOnStage = false; setPeek(false); });
stage.addEventListener('click', () => {
  if (dragMoved) return;
  if (interaction.asleep) { wakeUp(); return; }
  if (clickTimer !== null) clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { clickTimer = null; patHeadOnce(); }, 240);
});
stage.addEventListener('dblclick', (event) => {
  if (clickTimer !== null) { clearTimeout(clickTimer); clickTimer = null; }
  cancelAnimationFrame(slingshotRaf);
  void (async () => {
    const screen = await bridge.screenBounds();
    const position = await bridge.winPosition();
    if (position === null) return;
    const wb = screen.windowBounds ?? screen;
    const start = { x: position[0], y: position[1] };
    const sim = createSlingshot({
      start,
      bounds: { minX: wb.minX, minY: wb.minY, maxX: wb.maxX, maxY: wb.maxY },
      direction: event.clientX < window.innerWidth / 2 ? -1 : 1,
      amplitudePx: 96,
    });
    const started = performance.now();
    const step = (now: number): void => {
      const pos = sim.step(16);
      void bridge.dragTo(pos.x, pos.y);
      host.applySquash(renderer.squashPoseAt(now - started, 1.2));
      if (!sim.done()) slingshotRaf = requestAnimationFrame(step);
      else {
        void bridge.dragTo(start.x, start.y);
        host.applySquash({ scaleX: 1, scaleY: 1 });
        lastActivityAt = Date.now();
      }
    };
    slingshotRaf = requestAnimationFrame(step);
  })();
});
setInterval(() => {
  const bubbleEffect = bubbleTick(bubbleState, Date.now());
  bubbleState = bubbleEffect.state;
  if (bubbleEffect.hide) widgets.hideDialog();
  const idle = Date.now() - lastActivityAt;
  const next = shouldEnterPowerSaver(lastActivityAt, Date.now(), powerSaverEnabled, 30_000);
  if (next !== powerSaver) {
    powerSaver = next;
    document.documentElement.dataset.powerSaver = String(next);
    // 省电模式立即关掉飘字粒子（不再为装饰性动画唤醒 GPU）
    if (next && glyphActive) clearGlyphs();
  }
  if (interaction.asleep && idle > 90_000 && Math.random() < 0.05) {
    widgets.showDialog('唔……梦里也有好多米饭……');
    setTimeout(() => widgets.hideDialog(), 6_000);
  }
}, 5_000);
const applyGlobalPrefs = (p: PetDesktopPrefs): void => {
  powerSaverEnabled = p.powerSaverEnabled;
  sfxVolume = p.sfxVolume;
  if (renderer instanceof SpritesheetRenderer) {
    renderer.setSfxEnabled(p.sfxEnabled);
    renderer.setSfxVolume(p.sfxVolume);
  }
};
void bridge.prefsGet().then(applyGlobalPrefs).catch(() => undefined);
bridge.onGlobalPrefsChanged?.(applyGlobalPrefs);

// E2E 通道：main 中继的 alpha 注入（preload onTestAlpha 已按 PET_STAGE_E2E 门控）
bridge.onTestAlpha?.((alpha) => void probe.force(alpha));

// ---- 拖拽甩抛 ----
let petLocked = false;
let dragging = false;
let dragMoved = false;
let lastPointerX = 0;
let samples: DragSample[] = [];
let throwSim: ReturnType<typeof createThrow> | null = null;
let raf = 0;
/** 抓取锚点：按下瞬间指针相对窗口左上角的真实偏移（真机修复：旧版写死 20×20 近似，
 *  抓哪里都变成「拖窗口左上角」——必须按真实偏移拖拽，桌宠才不会在按下瞬间跳位） */
let grabOffset: { x: number; y: number } | null = null;

stage.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || petLocked) return;
  dragging = true;
  throwSim = null;
  grabOffset = null;
  dragMoved = false;
  lastPointerX = event.screenX;
  lastActivityAt = Date.now();
  samples = [{ t: performance.now(), x: event.screenX, y: event.screenY }];
  // 按下瞬间取窗口原点 → 锚点 = 指针屏幕坐标 − 窗口原点（异步取位，就绪前的 mousemove 先不挪窗）
  void bridge.winPosition().then((pos) => {
    if (!dragging || pos === null) return;
    grabOffset = { x: event.screenX - pos[0], y: event.screenY - pos[1] };
  });
});

window.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  const dx = event.screenX - lastPointerX;
  lastPointerX = event.screenX;
  if (Math.abs(dx) > 3) dragMoved = true;
  const level = recordShake(interaction, dx, performance.now());
  if (level !== lastDizzyVisual) {
    lastDizzyVisual = level;
    void renderer.play(DIZZY_ACTIONS[level]).catch(() => undefined);
  }
  samples.push({ t: performance.now(), x: event.screenX, y: event.screenY });
  if (grabOffset === null) return; // 锚点未就绪：跳过本帧，避免按旧偏移跳位
  void bridge.dragTo(event.screenX - grabOffset.x, event.screenY - grabOffset.y);
});

async function applyDockEdge(position: [number, number]): Promise<void> {
  const bounds = await bridge.screenBounds();
  const wb = bounds.windowBounds ?? bounds;
  const width = window.innerWidth;
  const edge = dockEdgeFor({ x: position[0], width }, { x: wb.minX, width: wb.maxX - wb.minX + width });
  if (edge !== dockedEdge) {
    dockedEdge = edge;
    dockHomeEdge = edge;
    await bridge.dockWindow?.(dockedAgentId, edge);
  }
}

function scheduleDockBack(edge: 'left' | 'right'): void {
  setTimeout(() => {
    if (!pointerOnStage && Date.now() - lastActivityAt >= 10_000) {
      dockedEdge = edge;
      void bridge.dockWindow?.(dockedAgentId, edge);
    }
  }, 10_000);
}



window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  void (async () => {
    const velocity = velocityFromSamples(samples);
    const bounds = await bridge.screenBounds();
    const winPos = await bridge.winPosition();
    if (!winPos) return;
    const prefs = await bridge.prefsGet();
    const start = { x: winPos[0], y: winPos[1] };
    // 窗口左上角可达区域（已扣窗口宽高）——甩抛/惯性都必须用它，否则窗口会滑出屏幕
    const wb = bounds.windowBounds ?? bounds;
    const simBounds: Bounds = { minX: wb.minX, minY: wb.minY, maxX: wb.maxX, maxY: wb.maxY };
    const mode = prefs.dragBehavior;

    // 落定回调用释放速度驱动 Q 弹（stick 无位移也照常弹一下，手感还在）
    const settle = (impact: number): void => {
      cancelAnimationFrame(raf);
      const started = performance.now();
      const squashLoop = (now: number) => {
        const pose = renderer.squashPoseAt(now - started, Math.min(impact / 400, 2));
        host.applySquash(pose);
        if (now - started < 600) raf = requestAnimationFrame(squashLoop);
        else host.applySquash({ scaleX: 1, scaleY: 1 });
      };
      raf = requestAnimationFrame(squashLoop);
    };

    if (mode === 'gravity') {
      throwSim = createThrow({ start, velocity, bounds: simBounds });
    } else if (mode === 'glide') {
      throwSim = createGlide({ start, velocity, bounds: simBounds });
    } else {
      // stick（默认）：放哪停哪——不再创建位移模拟，窗口停在拖拽最后位置；只记位置持久化
      throwSim = null;
    }

    if (throwSim !== null) {
      let lastTs = performance.now();
      const stepLoop = (ts: number) => {
        if (!throwSim || throwSim.done()) {
          const impact = throwSim?.landingImpact() ?? Math.hypot(velocity.vx, velocity.vy) * 0.4;
          settle(impact);
          // 持久化落定后的真实位置（不是拖拽起点）——否则重启后桌宠会回到松手前的位置
          const rest = throwSim?.position() ?? start;
          void bridge.prefsSet({ position: { x: Math.round(rest.x), y: Math.round(rest.y), displayId: bounds.displayId || prefs.position.displayId } });
          void applyDockEdge([Math.round(rest.x), Math.round(rest.y)]);
          return;
        }
        const dt = ts - lastTs;
        lastTs = ts;
        const pos = throwSim.step(dt);
        void bridge.dragTo(pos.x, pos.y);
        raf = requestAnimationFrame(stepLoop);
      };
      raf = requestAnimationFrame(stepLoop);
    } else {
      settle(Math.hypot(velocity.vx, velocity.vy) * 0.4);
      // 拖拽期间窗口已跟手移动 → 用最终真实位置持久化（windowBounds 由主进程 dragTo 夹紧）
      const final = await bridge.winPosition();
      if (final !== null) {
        void bridge.prefsSet({ position: { x: final[0], y: final[1], displayId: bounds.displayId || prefs.position.displayId } });
        await applyDockEdge(final);
      }
    }
  })();
});

// ---- 情绪感知 TTS 编排（T-M2-02）：语音锁 + 口型驱动 + 动作切换 ----
/** 语音播放适配器：真实实现走 WebAudio（onended 释放租约）；此处为编排骨架（音频由 Sidecar 提供） */
const leaseManager = new AudioLeaseManager({
  adapter: {
    async play(leaseId) {
      const started = performance.now();
      await new Promise<void>((resolve) => {
        // 真实实现：<audio>.play() + onended → resolve；此处按口型时间线推进到末尾
        const timeline = visemeTimelines.get(leaseId) ?? [];
        const total = timeline.at(-1)?.atMs ?? 0;
        const tick = (): void => {
          const elapsed = performance.now() - started;
          const current = timeline.find((item) => item.atMs <= elapsed)?.viseme ?? 'closed';
          void renderer.play('idle'); // 动作切换由情绪映射决定（见下）
          void current;
          if (elapsed >= total) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    abort() {
      /* 真实实现：停止 <audio> 元素 */
    },
  },
  onReceipt: (receipt) => {
    // 真实回执 → 气泡收起 / 账本落库（宿主组装层）
    void receipt;
  },
});
const visemeTimelines = new Map<string, Array<{ atMs: number; viseme: string }>>();

/** 合成结果 → 语音租约 → 播放 + 动作切换 + 口型驱动（T-M2-02 编排入口） */
function speakWithEmotion(request: SpeakRequest, leaseId: string): void {
  const { lease, visemeTimeline } = buildPlaybackLease({ leaseId, request });
  visemeTimelines.set(leaseId, visemeTimeline);
  // 情绪 → 桌宠动作切换（SPEC §3.4）
  void renderer.play(lease.actionState);
  const granted = leaseManager.acquire({
    leaseId: lease.leaseId,
    priority: lease.priority,
    ttlMs: lease.ttlMs,
    durationMs: request.durationMs,
  });
  if (granted === 'queued') {
    // 排队中：气泡先显示，说话到点再播（dsh-pet「气泡会等语音」语义）
    widgets.showDialog(request.text);
  }
}

// ---- UI 挂件（T-M1-05）：双轨气泡 + 赛博饭碗 ----
// 舞台 CSS 实际 400×260（窗口 400×284 留脚线 21px 余量）；旧代码按 440×300 算气泡会贴出窗右缘
const widgets = mountBubbleWidgets(stage, { width: 400, height: 260 });
const riceBowlWidget = mountRiceBowlWidget(stage);

// ── T-M6-20 缩放：滚轮 / 右键菜单 / 主进程广播（中控台滑块）同步 ──
const setScale = (next: number): void => {
  if (petLocked) return;
  const clamped = Math.min(Math.max(Math.round(next * 10) / 10, 0.6), 2);
  if (clamped === petScale) return;
  // 乐观更新：滚轮连续滚动时不等主进程广播回来就累计，否则连滚两格只生效一格
  petScale = clamped;
  applyStageScale();
  widgets.setStageBox({ width: BASE_STAGE.width * petScale, height: BASE_STAGE.height * petScale });
  void bridge.windowPrefsSet(petContext.agentId, { scale: clamped }); // manager 改本窗 bounds + 广播
};
void bridge.windowPrefsGet(petContext.agentId).then((p) => {
  if (p === null) return;
  petLocked = p.locked;
  if (p.scale !== 1) {
    petScale = p.scale;
    applyStageScale();
    widgets.setStageBox({ width: BASE_STAGE.width * petScale, height: BASE_STAGE.height * petScale });
  }
}).catch(() => undefined);
bridge.onWindowPrefsChanged?.((prefs) => {
  petLocked = prefs.locked;
  if (prefs.scale !== petScale) {
    petScale = prefs.scale;
    applyStageScale();
    widgets.setStageBox({ width: BASE_STAGE.width * petScale, height: BASE_STAGE.height * petScale });
  }
});
bridge.onScaleChanged?.((scale) => {
  petScale = scale;
  applyStageScale();
  widgets.setStageBox({ width: BASE_STAGE.width * petScale, height: BASE_STAGE.height * petScale });
});
// 滚轮缩放：只在桌宠实体区域触发（透明区仍穿透，不影响桌面操作）
stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (petLocked) return;
  setScale(petScale + (event.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

// 右键菜单：设为交互态防止 alpha 探针把窗口切穿透导致菜单点不到；档位即时生效
let scaleMenu: HTMLDivElement | null = null;
const closeScaleMenu = (): void => {
  scaleMenu?.remove();
  scaleMenu = null;
  void bridge.forceInteractive(false);
};
stage.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  // T-M6-53：Option/Alt + 右键直达验收台
  if (event.altKey && bridge.openBench !== undefined) {
    void bridge.openBench();
    return;
  }
  wakeUp();
  void bridge.friendRecord?.(currentCharacterId, 'poke').catch(() => undefined);
  playPokePose();
  void bridge.pokeLine?.(dockedAgentId).then((result) => {
    if (result.ok && result.line !== undefined) {
      widgets.showDialog(result.line);
      setTimeout(() => widgets.hideDialog(), 10_000);
    }
  }).catch(() => undefined);
  if (scaleMenu !== null) { closeScaleMenu(); return; }
  void bridge.forceInteractive(true);
  scaleMenu = document.createElement('div');
  scaleMenu.style.cssText = `position:absolute; left:${Math.round(BASE_STAGE.width * petScale / 2 - 60)}px; bottom:8px;
    display:flex; gap:4px; padding:6px; border-radius:12px; pointer-events:auto;
    background:rgba(12,20,32,0.92); border:1px solid rgba(120,180,255,0.35); z-index:20;`;
  const makeTextButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'font:11px monospace;color:#cdd8e8;background:transparent;border:1px solid rgba(120,180,255,.25);border-radius:8px;padding:4px 6px;cursor:pointer;';
    btn.addEventListener('click', onClick);
    scaleMenu?.appendChild(btn);
    return btn;
  };
  for (const option of [0.6, 0.8, 1, 1.2, 1.5, 2]) {
    const btn = document.createElement('button');
    btn.textContent = `${option}×`;
    btn.style.cssText = `font:11px monospace; color:${option === petScale ? '#8cc8ff' : '#cdd8e8'};
      background:transparent; border:1px solid rgba(120,180,255,0.25); border-radius:8px; padding:4px 6px; cursor:pointer;`;
    btn.addEventListener('click', () => { setScale(option); closeScaleMenu(); });
    scaleMenu.appendChild(btn);
  }
  makeTextButton('戳一下', () => { wakeUp(); playPokePose(); closeScaleMenu(); });
  makeTextButton(interaction.asleep ? '叫醒' : '睡觉', () => { toggleSleep(); closeScaleMenu(); });
  makeTextButton('叫她出来 ▸', () => {
    // 只移除一级菜单 DOM，保持交互态；二级面板关闭/超时后再恢复穿透
    scaleMenu?.remove();
    scaleMenu = null;
    void bridge.characterList?.().then((list) => {
      const others = list.filter((character) => character.id !== currentCharacterId && !(character.packId ?? '').startsWith('crosspet-')).slice(0, 10);
      if (others.length === 0) return;
      const panel = document.createElement('div');
      panel.style.cssText = `position:absolute; left:50%; bottom:34px; transform:translateX(-50%); display:flex; flex-wrap:wrap; gap:4px;
        max-width:${Math.round(BASE_STAGE.width * petScale - 20)}px; padding:6px; border-radius:12px; pointer-events:auto; z-index:21;
        background:rgba(12,20,32,0.94); border:1px solid rgba(120,180,255,0.35);`;
      for (const character of others) {
        const btn = document.createElement('button');
        btn.textContent = character.displayName;
        btn.style.cssText = 'font:11px monospace;color:#cdd8e8;background:transparent;border:1px solid rgba(120,180,255,.25);border-radius:8px;padding:4px 6px;cursor:pointer;';
        btn.addEventListener('click', () => {
          void bridge.petSummon?.(character.id).then((result) => {
            if (result.ok) widgets.showDialog(`${character.displayName} 来啦！`);
            else {
              widgets.showDialog(result.error ?? '召唤失败');
            }
            setTimeout(() => widgets.hideDialog(), 6_000);
          });
          panel.remove();
          void bridge.forceInteractive(false);
        });
        panel.appendChild(btn);
      }
      stage.appendChild(panel);
      setTimeout(() => { panel.remove(); void bridge.forceInteractive(false); }, 8_000);
    });
  });
  makeTextButton('集合！', () => { void bridge.petAssemble?.(); closeScaleMenu(); });
  makeTextButton('解散', () => { void bridge.petDismiss?.(); closeScaleMenu(); });
  makeTextButton('彩蛋', () => {
    void bridge.petEggSummon?.().then((result) => {
      if (result?.ok === false) {
        widgets.showDialog(result.error ?? '彩蛋召唤失败');
        setTimeout(() => widgets.hideDialog(), 6_000);
      }
    });
    closeScaleMenu();
  });
  makeTextButton('小本子', () => { void bridge.petOpenNotebook?.(); closeScaleMenu(); });
  makeTextButton('创作中心', () => { void bridge.openCreator?.(); closeScaleMenu(); });
  makeTextButton('验收台', () => { void bridge.openBench?.(); closeScaleMenu(); });
  makeTextButton('重新载入', () => {
    void bridge.reloadCharacters?.().then((result) => {
      if (result.ok) void loadCharacterManifest(currentCharacterId).then(() => widgets.showDialog('角色配置已重新载入')).catch(() => undefined);
    });
    closeScaleMenu();
  });
  stage.appendChild(scaleMenu);
  window.addEventListener('mousedown', (e) => {
    if (scaleMenu !== null && !scaleMenu.contains(e.target as Node)) closeScaleMenu();
  }, { once: true });
});
// 初始米量水合 + hover 显隐（默认隐藏；<15% 饿态强制亮灯）
void bridge.riceStatus().then((st) => {
  if (st.budget > 0) refreshRiceWidget(st.balance / st.budget);
}).catch(() => undefined);
stage.addEventListener('mouseenter', () => { hoverOnPet = true; refreshRiceWidget(); });
stage.addEventListener('mouseleave', () => { hoverOnPet = false; refreshRiceWidget(); });

// E2E 就绪标记 + 测试钩子（PET_STAGE_E2E=1 门控）
void bridge.appMeta().then((meta) => {
  (window as unknown as { __petStageReady: boolean }).__petStageReady = Boolean(meta);
  if (meta.testMode) {
    (window as unknown as { __petStageTest: object }).__petStageTest = {
      showBubbles(input: { thought: string; dialog: string }) {
        widgets.showThought(input.thought);
        widgets.showDialog(input.dialog);
      },
      hideBubbles() {
        widgets.hideThought();
        widgets.hideDialog();
      },
      bubbleRects: () => widgets.rects(),
      setRiceRatio: (ratio: number) => refreshRiceWidget(ratio), // 饿态（<15%）测试自动亮灯，与线上行为一致
      riceRatio: () => riceBowlWidget.ratio(),
      riceVisible: () => riceBowlWidget.visible(),
      bubbleElements: () => ({
        thought: document.querySelector('.pet-bubble--thought')?.getBoundingClientRect().toJSON() ?? null,
        dialog: document.querySelector('.pet-bubble--dialog')?.getBoundingClientRect().toJSON() ?? null,
      }),
    };
  }
});


// T-M5-16：事件分类与映射（三层映射表消费端——import 已移至文件头）

// ambient 空闲随机链：30s 无事件 → 自定义 idleActions 与内置氛围池混播 6s 回 idle（T-M6-55）
const ambientLoop = setInterval(() => {
  if (shouldBlockWhileAsleep(interaction, 'ambient') || powerSaver) return;
  if (Date.now() - lastEventAt < AMBIENT_IDLE_MS) return;
  if (previewTimer) return; // 预览播放中不抢
  const manifest = renderer.manifest;
  if (!manifest || manifest.ambientPool.length === 0) return;
  if (renderer instanceof PoseSkinRenderer) {
    const picked = pickIdleMix({
      idleActions: poseConfig?.idleActions ?? [],
      available: renderer.availablePoses(),
      ambientIds: manifest.ambientPool.map((clip) => clip.clipId),
    });
    if (picked === null) return;
    void renderer.playPose(picked.id).then(() => { lastPoseName = picked.id; }).catch(() => { void renderer.play('idle').catch(() => undefined); });
  } else {
    const picked = pickAmbient(manifest);
    if (!picked.webmPath) return;
    void renderer.play(previewActionFor(picked.clipId) ?? 'idle').catch(() => undefined);
  }
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void renderer.play('idle');
    lastPoseName = 'idle';
  }, AMBIENT_PLAY_MS);
}, 5_000);
void ambientLoop;

// clipId → 尝试匹配语义槽位；匹配不到回落 detail.action（预览页给的槽位名）
function previewActionFor(clipId: string): PetActionState | null {
  const manifest = renderer.manifest;
  if (!manifest) return null;
  for (const action of manifest.actions) {
    if (action.clips.some((c) => c.clipId === clipId)) return action.actionState;
  }
  return null;
}
