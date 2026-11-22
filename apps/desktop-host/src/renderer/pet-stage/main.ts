/**
 * pet-stage 渲染层装配（T-M1-02）：WebmVideoRenderer + alpha 穿透探针 + 拖拽甩抛。
 * 注意：webm 资产不入库（DEV_ONLY_NON_COMMERCIAL），未放置资产时舞台为透明空窗——属预期。
 */
import { WebmVideoRenderer, pickAmbient, type RendererHost, type VideoFactory, type VideoHandle } from '@workbench/pet-renderer';
import { classifyAutodriveReceipt, GAME_EVENT_ACTION_MAP, RICE_LEVEL_ACTION_MAP } from '@workbench/pet-renderer/emotion-map';
import type { PetActionState } from '@workbench/shared-protocol';
import { createAlphaProbe } from './alpha-probe';
import { createThrow, velocityFromSamples, type Bounds, type DragSample } from './drag-throw';
import { AudioLeaseManager } from './audio-lease';
import { mountBubbleWidgets } from './widgets/bubbles';
import { mountRiceBowlWidget } from './widgets/rice-bowl-widget';
import { buildPlaybackLease, sampleVisemeTimeline, type SpeakRequest } from './tts-router';

interface PetStageBridge {
  ready: boolean;
  setPassthrough(state: 'passthrough' | 'interactive'): Promise<boolean>;
  getState(): Promise<'passthrough' | 'interactive'>;
  screenBounds(): Promise<Bounds>;
  mousePoint(): Promise<{ x: number; y: number }>;
  winPosition(): Promise<[number, number] | null>;
  dragTo(x: number, y: number): Promise<[number, number] | null>;
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

const renderer = new WebmVideoRenderer({ host, videoFactory });

// 装载真形象清单（T-M5-01：114 官方 VP9-alpha webm，随包分发 assets/blue-whale-maid/）
// webmPath 为「仓库视角」相对路径（assets/blue-whale-maid/x.webm）→ 渲染进程相对当前 html 即 ./assets/...
void fetch('./assets/blue-whale-maid/manifest.json')
  .then((res) => res.json())
  .then((rawManifest: import('@workbench/shared-protocol').PetAvatarManifest) => {
    // webmPath 为仓库视角（assets/...）→ 渲染进程相对 html 改写为 ./assets/...
    for (const action of rawManifest.actions) {
      for (const clip of action.clips) {
        if (clip.webmPath.startsWith('assets/')) clip.webmPath = `./${clip.webmPath}`;
      }
    }
    return rawManifest;
  })
  .then((manifest) => renderer.load(manifest))
  .then(() => renderer.play('idle'))
  .catch((error) => console.warn('[pet-stage] 真形象清单未就绪（回退占位渲染）：', error));

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
  petStageBridge.onPetPreview((detail) => {
    if (detail.clipId) {
      const manifest = renderer.manifest;
      // ambient 单条：先找槽位（语义命中播槽位）→ 不在槽位则直查 ambientPool 走 playClip
      const slotAction = previewActionFor(detail.clipId);
      const ambientEntry = manifest?.ambientPool.find((c) => c.clipId === detail.clipId);
      const slotClip = manifest?.actions.flatMap((a) => a.clips).find((c) => c.clipId === detail.clipId);
      if (slotAction && slotClip) {
        void renderer.play(slotAction).catch(() => undefined);
      } else if (ambientEntry) {
        void renderer.playClip({ clipId: ambientEntry.clipId, webmPath: ambientEntry.webmPath, loop: false, playbackRate: 1, fps: 24, weight: ambientEntry.weight }).catch(() => undefined);
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

// ---- autodrive 事件驱动（T-M5-02 宿主层）：回执 → 动作映射（人格化） ----
type AutodriveEventLite = {
  type: 'state' | 'decision' | 'receipt' | 'watchdog' | 'cycle-end' | 'user';
  tool?: string; status?: string; summary?: string; intent?: string; clock?: string;
};
if (window.directorBridge?.onAutodriveEvent) {
  window.directorBridge.onAutodriveEvent((event: AutodriveEventLite) => {
    lastEventAt = Date.now();
    // 双轨气泡（设计稿 §L1/L2）：decision 意图 → 紫云朵内心戏；回话/反射 → 正式对话泡
    if (event.type === 'decision' && typeof event.intent === 'string' && event.intent.length > 0) {
      widgets.showThought(event.intent);
      clearTimeout(thoughtTimer);
      thoughtTimer = setTimeout(() => widgets.hideThought(), 12_000);
    }
    if (event.type === 'receipt' && (event.tool === 'chat_reply' || event.tool === 'reflex_spray') && event.summary) {
      widgets.showDialog(event.summary);
      clearTimeout(dialogTimer);
      dialogTimer = setTimeout(() => widgets.hideDialog(), 10_000);
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

// ---- alpha 穿透探针 ----
const probeCanvas = document.createElement('canvas');
probeCanvas.width = 1;
probeCanvas.height = 1;
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
let stageOffset = { x: 0, y: 0 };
const originalApplyLayout = host.applyLayout.bind(host);
host.applyLayout = (layout) => {
  stageOffset = { x: layout.offsetX, y: layout.offsetY };
  originalApplyLayout(layout);
};

async function sampleAlpha(): Promise<number> {
  const video = stage.querySelector('video');
  if (!video || video.readyState < 2 || !probeCtx) return 0; // 无画面 → 透明（穿透），E2E 走 forceAlpha
  const point = await bridge.mousePoint();
  const winPos = await bridge.winPosition();
  if (!winPos) return 0;
  ctxDraw(video, point.x - winPos[0] - stageOffset.x, point.y - winPos[1] - stageOffset.y);
  return probeCtx.getImageData(0, 0, 1, 1).data[3] ?? 0;
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
// E2E 通道：main 中继的 alpha 注入（preload onTestAlpha 已按 PET_STAGE_E2E 门控）
bridge.onTestAlpha?.((alpha) => void probe.force(alpha));

// ---- 拖拽甩抛 ----
let dragging = false;
let samples: DragSample[] = [];
let throwSim: ReturnType<typeof createThrow> | null = null;
let raf = 0;
/** 抓取锚点：按下瞬间指针相对窗口左上角的真实偏移（真机修复：旧版写死 20×20 近似，
 *  抓哪里都变成「拖窗口左上角」——必须按真实偏移拖拽，桌宠才不会在按下瞬间跳位） */
let grabOffset: { x: number; y: number } | null = null;

stage.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  throwSim = null;
  grabOffset = null;
  samples = [{ t: performance.now(), x: event.screenX, y: event.screenY }];
  // 按下瞬间取窗口原点 → 锚点 = 指针屏幕坐标 − 窗口原点（异步取位，就绪前的 mousemove 先不挪窗）
  void bridge.winPosition().then((pos) => {
    if (!dragging || pos === null) return;
    grabOffset = { x: event.screenX - pos[0], y: event.screenY - pos[1] };
  });
});

window.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  samples.push({ t: performance.now(), x: event.screenX, y: event.screenY });
  if (grabOffset === null) return; // 锚点未就绪：跳过本帧，避免按旧偏移跳位
  void bridge.dragTo(event.screenX - grabOffset.x, event.screenY - grabOffset.y);
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  void (async () => {
    const velocity = velocityFromSamples(samples);
    const bounds = await bridge.screenBounds();
    const winPos = await bridge.winPosition();
    if (!winPos) return;
    throwSim = createThrow({
      start: { x: winPos[0], y: winPos[1] },
      velocity,
      bounds: { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY },
    });
    cancelAnimationFrame(raf);
    let lastTs = performance.now();
    const stepLoop = (ts: number) => {
      if (!throwSim || throwSim.done()) {
        // 落定：按冲击速度触发 Q 弹（squashAt），600ms 内收敛回恒等
        const impact = throwSim?.landingImpact() ?? 0;
        const started = performance.now();
        const squashLoop = (now: number) => {
          const pose = renderer.squashPoseAt(now - started, Math.min(impact / 400, 2));
          host.applySquash(pose);
          if (now - started < 600) raf = requestAnimationFrame(squashLoop);
          else host.applySquash({ scaleX: 1, scaleY: 1 });
        };
        raf = requestAnimationFrame(squashLoop);
        return;
      }
      const dt = ts - lastTs;
      lastTs = ts;
      const pos = throwSim.step(dt);
      void bridge.dragTo(pos.x, pos.y);
      raf = requestAnimationFrame(stepLoop);
    };
    raf = requestAnimationFrame(stepLoop);
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

// ambient 空闲随机链：30s 无事件 → pickAmbient 播 6s 回 idle（D16 素材全利用）
const ambientLoop = setInterval(() => {
  if (Date.now() - lastEventAt < AMBIENT_IDLE_MS) return;
  if (previewTimer) return; // 预览播放中不抢
  const manifest = renderer.manifest;
  if (!manifest || manifest.ambientPool.length === 0) return;
  const picked = pickAmbient(manifest);
  if (!picked.webmPath) return;
  void (async () => {
    try {
      await renderer.play(previewActionFor(picked.clipId) ?? 'idle');
    } catch { /* 预览失败静默回 idle */ }
  })();
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void renderer.play('idle');
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
