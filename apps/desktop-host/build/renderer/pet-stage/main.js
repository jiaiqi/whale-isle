/**
 * pet-stage 渲染层装配（T-M1-02）：WebmVideoRenderer + alpha 穿透探针 + 拖拽甩抛。
 * 注意：webm 资产不入库（DEV_ONLY_NON_COMMERCIAL），未放置资产时舞台为透明空窗——属预期。
 */
import { WebmVideoRenderer } from '@workbench/pet-renderer';
import { createAlphaProbe } from './alpha-probe';
import { createThrow, velocityFromSamples } from './drag-throw';
import { mountBubbleWidgets } from './widgets/bubbles';
import { mountRiceBowlWidget } from './widgets/rice-bowl-widget';
const bridge = window.petStage;
const stage = document.getElementById('stage');
const badgeEl = document.getElementById('dev-badge');
// ---- RendererHost（真实 DOM） ----
const host = {
    mountVideo(handle) {
        const el = handle.el;
        el.style.opacity = '0';
        stage.appendChild(el);
    },
    showVideo(handle) {
        handle.el.style.opacity = '1';
    },
    hideVideo(handle) {
        handle.el.style.opacity = '0';
    },
    detachVideo(handle) {
        handle.el.remove();
    },
    setDevBadge(text) {
        badgeEl.textContent = text ?? '';
        badgeEl.style.display = text ? 'block' : 'none';
    },
    applyLayout(layout) {
        stage.style.left = `${layout.offsetX}px`;
        stage.style.top = `${layout.offsetY}px`;
    },
    applySquash(pose) {
        stage.style.scale = `${pose.scaleX} ${pose.scaleY}`;
    },
};
const videoFactory = (src) => {
    const el = document.createElement('video');
    el.src = src;
    el.muted = true;
    el.playsInline = true;
    el.style.position = 'absolute';
    let rejectLoad = null;
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
                if (el.readyState >= 2)
                    onReady();
                else
                    el.addEventListener('loadeddata', onReady);
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
// 装载清单（build 脚本会把 fixtures 拷到同目录）；失败不阻塞穿透探针
void fetch('./blue-whale-maid.manifest.json')
    .then((res) => res.json())
    .then((manifest) => renderer.load(manifest))
    .catch((error) => console.warn('[pet-stage] 清单/素材未就绪（预期，待 T-M2-04 管线）：', error));
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
async function sampleAlpha() {
    const video = stage.querySelector('video');
    if (!video || video.readyState < 2 || !probeCtx)
        return 0; // 无画面 → 透明（穿透），E2E 走 forceAlpha
    const point = await bridge.mousePoint();
    const winPos = await bridge.winPosition();
    if (!winPos)
        return 0;
    ctxDraw(video, point.x - winPos[0] - stageOffset.x, point.y - winPos[1] - stageOffset.y);
    return probeCtx.getImageData(0, 0, 1, 1).data[3] ?? 0;
}
function ctxDraw(video, sx, sy) {
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
let samples = [];
let throwSim = null;
let raf = 0;
stage.addEventListener('mousedown', (event) => {
    if (event.button !== 0)
        return;
    dragging = true;
    throwSim = null;
    samples = [{ t: performance.now(), x: event.screenX, y: event.screenY }];
});
window.addEventListener('mousemove', (event) => {
    if (!dragging)
        return;
    samples.push({ t: performance.now(), x: event.screenX, y: event.screenY });
    const grabOffsetX = 20; // 抓取点近似（窗口内指针相对位置）
    const grabOffsetY = 20;
    void bridge.dragTo(event.screenX - grabOffsetX, event.screenY - grabOffsetY);
});
window.addEventListener('mouseup', () => {
    if (!dragging)
        return;
    dragging = false;
    void (async () => {
        const velocity = velocityFromSamples(samples);
        const bounds = await bridge.screenBounds();
        const winPos = await bridge.winPosition();
        if (!winPos)
            return;
        throwSim = createThrow({
            start: { x: winPos[0], y: winPos[1] },
            velocity,
            bounds: { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY },
        });
        cancelAnimationFrame(raf);
        let lastTs = performance.now();
        const stepLoop = (ts) => {
            if (!throwSim || throwSim.done()) {
                // 落定：按冲击速度触发 Q 弹（squashAt），600ms 内收敛回恒等
                const impact = throwSim?.landingImpact() ?? 0;
                const started = performance.now();
                const squashLoop = (now) => {
                    const pose = renderer.squashPoseAt(now - started, Math.min(impact / 400, 2));
                    host.applySquash(pose);
                    if (now - started < 600)
                        raf = requestAnimationFrame(squashLoop);
                    else
                        host.applySquash({ scaleX: 1, scaleY: 1 });
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
// ---- UI 挂件（T-M1-05）：双轨气泡 + 赛博饭碗 ----
const widgets = mountBubbleWidgets(stage, { width: 440, height: 300 });
const riceBowlWidget = mountRiceBowlWidget(stage);
// E2E 就绪标记 + 测试钩子（PET_STAGE_E2E=1 门控）
void bridge.appMeta().then((meta) => {
    window.__petStageReady = Boolean(meta);
    if (meta.testMode) {
        window.__petStageTest = {
            showBubbles(input) {
                widgets.showThought(input.thought);
                widgets.showDialog(input.dialog);
            },
            hideBubbles() {
                widgets.hideThought();
                widgets.hideDialog();
            },
            bubbleRects: () => widgets.rects(),
            setRiceRatio: (ratio) => riceBowlWidget.setRatio(ratio),
            riceRatio: () => riceBowlWidget.ratio(),
            bubbleElements: () => ({
                thought: document.querySelector('.pet-bubble--thought')?.getBoundingClientRect().toJSON() ?? null,
                dialog: document.querySelector('.pet-bubble--dialog')?.getBoundingClientRect().toJSON() ?? null,
            }),
        };
    }
});
//# sourceMappingURL=main.js.map