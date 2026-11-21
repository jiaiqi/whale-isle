/**
 * pet-stage 渲染层装配（T-M1-02）：WebmVideoRenderer + alpha 穿透探针 + 拖拽甩抛。
 * 注意：webm 资产不入库（DEV_ONLY_NON_COMMERCIAL），未放置资产时舞台为透明空窗——属预期。
 */
import { WebmVideoRenderer, type RendererHost, type VideoFactory, type VideoHandle } from '@workbench/pet-renderer';
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

// ---- autodrive 事件驱动（T-M5-02 宿主层）：回执 → 动作映射（人格化） ----
type AutodriveEventLite = {
  type: 'state' | 'decision' | 'receipt' | 'watchdog' | 'cycle-end';
  tool?: string; status?: string; summary?: string; intent?: string; clock?: string;
};
if (window.directorBridge?.onAutodriveEvent) {
  window.directorBridge.onAutodriveEvent((event: AutodriveEventLite) => {
    if (event.type === 'receipt' && event.status && event.tool !== 'autodrive') {
      // 回执 → 人格化动作（uncertain → 心虚冒汗；error → 气急败坏；完成 → 开心）
      if (event.status === 'UNCERTAIN') void renderer.play('clumsy_panic');
      else if (event.status === 'FAILED' || event.status === 'ERROR') void renderer.play('rage_spray');
      else if (event.status === 'COMPLETED' && /fish|收获|收获|钓/.test(`${event.tool}${event.summary ?? ''}`)) void renderer.play('happy_maid');
      // 决策进行中 → 专注
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

stage.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  throwSim = null;
  samples = [{ t: performance.now(), x: event.screenX, y: event.screenY }];
});

window.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  samples.push({ t: performance.now(), x: event.screenX, y: event.screenY });
  const grabOffsetX = 20; // 抓取点近似（窗口内指针相对位置）
  const grabOffsetY = 20;
  void bridge.dragTo(event.screenX - grabOffsetX, event.screenY - grabOffsetY);
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
const widgets = mountBubbleWidgets(stage, { width: 440, height: 300 });
const riceBowlWidget = mountRiceBowlWidget(stage);

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
      setRiceRatio: (ratio: number) => riceBowlWidget.setRatio(ratio),
      riceRatio: () => riceBowlWidget.ratio(),
      bubbleElements: () => ({
        thought: document.querySelector('.pet-bubble--thought')?.getBoundingClientRect().toJSON() ?? null,
        dialog: document.querySelector('.pet-bubble--dialog')?.getBoundingClientRect().toJSON() ?? null,
      }),
    };
  }
});
