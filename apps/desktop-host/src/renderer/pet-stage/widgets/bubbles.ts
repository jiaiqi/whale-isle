/**
 * 智能多语义气泡挂件（连续融合 SVG 外壳版）：
 *   - 7 种语义气泡：thought / dialog / legacy（经典右下角半透蓝玻泡）/ status / notice / reaction / hint；
 *   - 7 种数据驱动情绪变体：happy / angry / sleepy / surprised / thinking / coquettish / shy；
 *   - 4 套随包字体：上首软糖体（默认）+ 龙藏体（手写感）+ 站酷快乐体（圆体）+ 站酷小薇体（正式体），全链路 SIL OFL 1.1 商用授权与系统回退链；
 *   - 连续闭合 SVG 路径渲染气泡与 8 向尾巴（无接缝无贴片感）；pointer-events:none、z-index:7、stripThink 清洗不绕过。
 */
import { ttlForBubbleKind } from '../bubble-lifecycle';
import {
  buildBubbleShellPath,
  buildThoughtCloudDots,
  computeBubbleLayout,
  computeSmartBubbleLayout,
  MAX_VISIBLE_BUBBLES,
  rectsOverlap,
  resolvePreferredSide,
  resolveTailDirection,
  type ActiveBubbleItem,
  type BubbleLayout,
  type BubbleRect,
  type BubbleShellGeometry,
  type BubbleStageContext,
  type BubbleTailDirection,
  type CharacterAnchor,
  type CharacterFacing,
  type CloudDot,
  type PlacedBubble,
  type ScreenEdgeHint,
  type SmartBubbleLayout,
  type StageBox,
} from './bubble-layout';
import { cleanBubbleText } from './bubble-text';
import {
  ALL_BUBBLE_FONT_IDS,
  ALL_BUBBLE_KINDS,
  ALL_BUBBLE_MOODS,
  BUBBLE_FONTS,
  BUBBLE_MOOD_THEMES,
  bubbleFontDefinition,
  bubbleFontStack,
  bubbleTheme,
  bubbleWidthBudget,
  buildBubbleFontFacesCss,
  estimateBubbleSize,
  moodForTrigger,
  resolveBubbleStyle,
  TRIGGER_TO_MOOD,
  type BubbleFontDefinition,
  type BubbleFontId,
  type BubbleKind,
  type BubbleMood,
  type BubbleVisualTheme,
  type ResolvedBubbleStyle,
} from './bubble-types';

export {
  ALL_BUBBLE_FONT_IDS,
  ALL_BUBBLE_KINDS,
  ALL_BUBBLE_MOODS,
  BUBBLE_FONTS,
  BUBBLE_MOOD_THEMES,
  bubbleFontDefinition,
  bubbleFontStack,
  bubbleTheme,
  bubbleWidthBudget,
  buildBubbleFontFacesCss,
  buildBubbleShellPath,
  buildThoughtCloudDots,
  computeBubbleLayout,
  computeSmartBubbleLayout,
  estimateBubbleSize,
  MAX_VISIBLE_BUBBLES,
  moodForTrigger,
  rectsOverlap,
  resolveBubbleStyle,
  resolvePreferredSide,
  resolveTailDirection,
  TRIGGER_TO_MOOD,
  type ActiveBubbleItem,
  type BubbleFontDefinition,
  type BubbleFontId,
  type BubbleKind,
  type BubbleLayout,
  type BubbleMood,
  type BubbleRect,
  type BubbleShellGeometry,
  type BubbleStageContext,
  type BubbleTailDirection,
  type BubbleVisualTheme,
  type CharacterAnchor,
  type CharacterFacing,
  type CloudDot,
  type PlacedBubble,
  type ResolvedBubbleStyle,
  type ScreenEdgeHint,
  type SmartBubbleLayout,
  type StageBox,
};

export interface ShowBubbleOptions {
  ttlMs?: number;
  /** true 时交由语音租约托管，不启普通自动隐藏定时器 */
  voiceManaged?: boolean;
  mood?: BubbleMood;
}

export interface BubbleWidgets {
  setStageBox(box: StageBox): void;
  setContext(patch: BubbleStageContext): void;
  setFont(fontId: BubbleFontId): void;
  fontId(): BubbleFontId;
  show(kind: BubbleKind, text: string, opts?: ShowBubbleOptions): boolean;
  hide(kind: BubbleKind): void;
  hideAll(): void;
  showThought(text: string, opts?: ShowBubbleOptions): void;
  showDialog(text: string, opts?: ShowBubbleOptions): void;
  hideThought(): void;
  hideDialog(): void;
  setDialogMuted(muted: boolean): void;
  rects(): { thought: BubbleRect; dialog: BubbleRect };
  activeRects(): Partial<Record<BubbleKind, BubbleRect>>;
  activeKinds(): BubbleKind[];
}

const STYLE_ID = 'whale-bubble-styles';
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHELL_PAD = 14;

function ensureBubbleStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    buildBubbleFontFacesCss(),
    '@keyframes whaleBubblePop{0%{opacity:0;transform:translateY(4px) scale(.95)}100%{opacity:1;transform:translateY(0) scale(1)}}',
    '@keyframes whaleBubbleBurst{0%{opacity:0;transform:scale(.85) rotate(-1.5deg)}65%{transform:scale(1.04) rotate(.5deg)}100%{opacity:1;transform:scale(1) rotate(0)}}',
    '@keyframes whaleStatusPulse{0%,100%{opacity:.72}50%{opacity:1}}',
    '@keyframes whaleMoodBounce{0%{opacity:0;transform:translateY(6px) scale(.92)}60%{transform:translateY(-2px) scale(1.03)}100%{opacity:1;transform:translateY(0) scale(1)}}',
    '@keyframes whaleMoodShake{0%{opacity:0;transform:translateX(-4px) scale(.94)}35%{opacity:1;transform:translateX(4px) scale(1.02)}70%{transform:translateX(-2px)}100%{opacity:1;transform:translateX(0) scale(1)}}',
    '@keyframes whaleMoodDrift{0%{opacity:0;transform:translateY(5px) scale(.96)}100%{opacity:1;transform:translateY(0) scale(1)}}',
    '@keyframes whaleMoodPop{0%{opacity:0;transform:scale(.76)}65%{opacity:1;transform:scale(1.06)}100%{opacity:1;transform:scale(1)}}',
    '@keyframes whaleMoodFloat{0%{opacity:0;transform:translateY(6px)}100%{opacity:1;transform:translateY(0)}}',
    '@keyframes whaleMoodWiggle{0%{opacity:0;transform:rotate(-2deg) scale(.93)}60%{opacity:1;transform:rotate(1.4deg) scale(1.02)}100%{opacity:1;transform:rotate(0) scale(1)}}',
    '@keyframes whaleMoodShy{0%{opacity:0;transform:translateY(4px) scale(.94)}100%{opacity:1;transform:translateY(0) scale(1)}}',
    '.pet-bubble{position:absolute;box-sizing:border-box;pointer-events:none;z-index:7;overflow:visible;}',
    '.pet-bubble__glass{position:absolute;pointer-events:none;z-index:0;}',
    '.pet-bubble__shell{position:absolute;pointer-events:none;z-index:1;overflow:visible;}',
    '.pet-bubble__body{position:relative;z-index:2;display:flex;align-items:flex-start;gap:6px;width:100%;overflow:hidden;}',
    '.pet-bubble__icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;margin-top:2px;}',
    '.pet-bubble__text{flex:1 1 auto;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;overflow-wrap:anywhere;}',
    '.pet-bubble--status .pet-bubble__body{align-items:center;}',
    '.pet-bubble--status .pet-bubble__icon{margin-top:0;animation:whaleStatusPulse 2.2s ease-in-out infinite;}',
    '.pet-bubble-muted{flex:0 0 auto;display:none;align-items:center;gap:2px;padding:1px 5px;border-radius:999px;background:rgba(255,216,154,0.88);border:1px solid rgba(176,104,16,0.45);color:#7a3e00;font:600 9px/1.2 ui-monospace,monospace;align-self:flex-end;margin-left:2px;}',
    'html[data-power-saver="true"] .pet-bubble,html[data-power-saver="true"] .pet-bubble *{backdrop-filter:none !important;filter:none !important;box-shadow:none !important;animation:none !important;}',
    '@media (prefers-reduced-motion: reduce){.pet-bubble,.pet-bubble *{animation:none !important;}}',
  ].join('');
  document.head.appendChild(style);
}

function splitCssColor(raw: string): { color: string; opacity: string } {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(raw.trim());
  if (m === null) return { color: raw, opacity: '1' };
  return { color: `rgb(${m[1]},${m[2]},${m[3]})`, opacity: m[4] ?? '1' };
}

function renderShellSvg(
  svg: SVGSVGElement,
  glass: HTMLDivElement,
  kind: BubbleKind,
  style: ResolvedBubbleStyle,
  width: number,
  height: number,
  tail: BubbleTailDirection,
): void {
  const shell = buildBubbleShellPath({
    width,
    height,
    radius: style.radiusPx,
    tail,
    tailKind: style.tailKind,
    pad: SHELL_PAD,
  });

  svg.setAttribute('width', String(shell.svgWidth));
  svg.setAttribute('height', String(shell.svgHeight));
  svg.setAttribute('viewBox', `0 0 ${shell.svgWidth} ${shell.svgHeight}`);
  svg.style.left = `-${shell.pad}px`;
  svg.style.top = `-${shell.pad}px`;
  svg.style.width = `${shell.svgWidth}px`;
  svg.style.height = `${shell.svgHeight}px`;
  svg.style.filter = style.dropShadow;

  if (style.backdropFilter !== undefined) {
    glass.style.display = 'block';
    glass.style.left = `-${shell.pad}px`;
    glass.style.top = `-${shell.pad}px`;
    glass.style.width = `${shell.svgWidth}px`;
    glass.style.height = `${shell.svgHeight}px`;
    glass.style.backdropFilter = style.backdropFilter;
    glass.style.clipPath = `path('${shell.path}')`;
  } else {
    glass.style.display = 'none';
    glass.style.backdropFilter = 'none';
    glass.style.clipPath = 'none';
  }

  const gradId = `whale-bubble-grad-${kind}`;
  const start = splitCssColor(style.fillStart);
  const end = splitCssColor(style.fillEnd);

  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0%');
  grad.setAttribute('y1', '0%');
  grad.setAttribute('x2', '100%');
  grad.setAttribute('y2', '100%');

  const stop0 = document.createElementNS(SVG_NS, 'stop');
  stop0.setAttribute('offset', '0%');
  stop0.setAttribute('stop-color', start.color);
  stop0.setAttribute('stop-opacity', start.opacity);

  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '100%');
  stop1.setAttribute('stop-color', end.color);
  stop1.setAttribute('stop-opacity', end.opacity);
  grad.append(stop0, stop1);
  defs.appendChild(grad);

  const mainPath = document.createElementNS(SVG_NS, 'path');
  mainPath.setAttribute('d', shell.path);
  mainPath.setAttribute('fill', `url(#${gradId})`);
  mainPath.setAttribute('stroke', style.strokeColor);
  mainPath.setAttribute('stroke-width', String(style.strokeWidth));
  mainPath.setAttribute('stroke-linejoin', 'round');
  mainPath.setAttribute('stroke-linecap', 'round');
  if (style.strokeDasharray !== undefined) {
    mainPath.setAttribute('stroke-dasharray', style.strokeDasharray);
  }

  const children: SVGElement[] = [defs, mainPath];

  if (style.borderLeftAccentColor !== undefined) {
    const accent = document.createElementNS(SVG_NS, 'rect');
    accent.setAttribute('x', String(shell.pad + 4));
    accent.setAttribute('y', String(shell.pad + 6));
    accent.setAttribute('width', '3');
    accent.setAttribute('height', String(Math.max(8, height - 12)));
    accent.setAttribute('rx', '1.5');
    accent.setAttribute('fill', style.borderLeftAccentColor);
    children.push(accent);
  }

  if (style.tailKind === 'cloud') {
    const dots = buildThoughtCloudDots({ width, height, tail, pad: shell.pad });
    for (const dot of dots) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(dot.cx));
      circle.setAttribute('cy', String(dot.cy));
      circle.setAttribute('r', String(dot.r));
      circle.setAttribute('fill', start.color);
      circle.setAttribute('fill-opacity', start.opacity);
      circle.setAttribute('stroke', style.strokeColor);
      circle.setAttribute('stroke-width', '1.25');
      if (style.strokeDasharray !== undefined) {
        circle.setAttribute('stroke-dasharray', '2.5 1.8');
      }
      children.push(circle);
    }
  }

  svg.replaceChildren(...children);
}

interface BubbleNodeRefs {
  kind: BubbleKind;
  root: HTMLDivElement;
  glass: HTMLDivElement;
  shell: SVGSVGElement;
  body: HTMLDivElement;
  icon: HTMLSpanElement;
  text: HTMLSpanElement;
}

export function mountBubbleWidgets(stage: HTMLElement, stageBox: StageBox): BubbleWidgets {
  ensureBubbleStyles();

  let box: StageBox = { ...stageBox };
  let context: BubbleStageContext = {};
  let activeFontId: BubbleFontId = 'shangshou-gummy';
  let currentItems = new Map<BubbleKind, { text: string; mood?: BubbleMood }>();
  const hideTimers = new Map<BubbleKind, ReturnType<typeof setTimeout>>();
  let latestLayout: SmartBubbleLayout = computeSmartBubbleLayout(box, [], context);

  stage.style.setProperty('--pet-bubble-font-family', bubbleFontStack(activeFontId));

  const mutedBadge = document.createElement('span');
  mutedBadge.className = 'pet-bubble-muted';
  mutedBadge.textContent = '静音';
  let mutedState = false;

  const nodes = new Map<BubbleKind, BubbleNodeRefs>();

  for (const kind of ALL_BUBBLE_KINDS) {
    const theme = bubbleTheme(kind);
    const root = document.createElement('div');
    root.className = `pet-bubble pet-bubble--${kind}`;
    root.dataset.bubbleKind = kind;
    root.dataset.tail = 'none';
    root.dataset.bubbleFont = activeFontId;
    root.style.cssText = [
      'position:absolute',
      'display:none',
      'pointer-events:none',
      'z-index:7',
      `font-family:var(--pet-bubble-font-family, ${bubbleFontStack(activeFontId)})`,
      `font-size:calc(${theme.fontSizePx}px * var(--pet-bubble-font-scale, 1))`,
      `line-height:${theme.lineHeight}`,
      `color:${theme.color}`,
      theme.tabularNums === true ? 'font-variant-numeric:tabular-nums' : '',
      `padding:${theme.paddingY}px ${theme.paddingX}px`,
    ].filter(Boolean).join(';');

    const glass = document.createElement('div');
    glass.className = 'pet-bubble__glass';
    glass.setAttribute('aria-hidden', 'true');

    const shell = document.createElementNS(SVG_NS, 'svg');
    shell.setAttribute('class', 'pet-bubble__shell');
    shell.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'pet-bubble__body';

    const icon = document.createElement('span');
    icon.className = 'pet-bubble__icon';

    const textEl = document.createElement('span');
    textEl.className = 'pet-bubble__text';
    textEl.style.setProperty('-webkit-line-clamp', String(theme.maxLines));

    body.append(icon, textEl);
    root.append(glass, shell, body);
    stage.appendChild(root);
    nodes.set(kind, { kind, root, glass, shell, body, icon, text: textEl });
  }

  const clearTimer = (kind: BubbleKind): void => {
    const timer = hideTimers.get(kind);
    if (timer !== undefined) {
      clearTimeout(timer);
      hideTimers.delete(kind);
    }
  };

  const syncMutedAttachment = (): void => {
    const dialogVisible = latestLayout.items.dialog !== undefined;
    const targetKind: BubbleKind = dialogVisible ? 'dialog' : 'legacy';
    const targetNode = nodes.get(targetKind);
    if (targetNode !== undefined && mutedBadge.parentElement !== targetNode.body) {
      targetNode.body.appendChild(mutedBadge);
    }
    const visible = mutedState && (latestLayout.items.dialog !== undefined || latestLayout.items.legacy !== undefined);
    mutedBadge.style.display = visible ? 'inline-flex' : 'none';
  };

  const renderLayout = (freshKind?: BubbleKind): void => {
    const active: ActiveBubbleItem[] = [];
    for (const [kind, entry] of currentItems) {
      active.push({ kind, text: entry.text, ...(entry.mood !== undefined ? { mood: entry.mood } : {}) });
    }
    latestLayout = computeSmartBubbleLayout(box, active, context);

    for (const kind of ALL_BUBBLE_KINDS) {
      const node = nodes.get(kind)!;
      const placed = latestLayout.items[kind];
      if (placed === undefined) {
        node.root.style.display = 'none';
        node.root.dataset.tail = 'none';
        node.root.dataset.bubbleMood = '';
        if (currentItems.has(kind)) {
          currentItems.delete(kind);
          clearTimer(kind);
        }
        continue;
      }

      const itemEntry = currentItems.get(kind);
      const textValue = itemEntry?.text ?? '';
      const style = resolveBubbleStyle(kind, itemEntry?.mood);

      node.root.dataset.bubbleFont = activeFontId;
      node.root.dataset.bubbleMood = style.mood ?? '';
      node.root.dataset.tail = placed.tail;
      node.root.style.fontFamily = `var(--pet-bubble-font-family, ${bubbleFontStack(activeFontId)})`;
      node.root.style.fontSize = `calc(${style.fontSizePx}px * var(--pet-bubble-font-scale, 1))`;
      node.root.style.lineHeight = String(style.lineHeight);
      node.root.style.color = style.color;
      node.root.style.fontWeight = style.fontWeight !== undefined ? String(style.fontWeight) : '400';
      node.root.style.padding = `${style.paddingY}px ${style.paddingX}px`;

      if (style.iconSvg !== '') {
        node.icon.innerHTML = style.iconSvg;
        node.icon.style.display = 'inline-flex';
      } else {
        node.icon.innerHTML = '';
        node.icon.style.display = 'none';
      }

      node.text.textContent = textValue;
      node.text.style.setProperty('-webkit-line-clamp', String(placed.maxLines));

      const bodyMaxHeight = Math.max(12, placed.rect.height - style.paddingY * 2);
      node.body.style.maxHeight = `${bodyMaxHeight}px`;

      node.root.style.left = `${placed.rect.x}px`;
      node.root.style.top = `${placed.rect.y}px`;
      node.root.style.width = `${placed.rect.width}px`;
      node.root.style.maxHeight = `${placed.rect.height}px`;

      const wasHidden = node.root.style.display === 'none';
      node.root.style.display = 'block';

      const actualW = Math.max(28, Math.round(node.root.offsetWidth || placed.rect.width));
      const actualH = Math.max(20, Math.round(node.root.offsetHeight || placed.rect.height));
      renderShellSvg(node.shell, node.glass, kind, style, actualW, actualH, placed.tail);

      if (wasHidden || freshKind === kind) {
        node.root.style.animation = 'none';
        void node.root.offsetWidth;
        node.root.style.animation = `${style.animationName} 200ms cubic-bezier(.22,1,.36,1) both`;
      }
    }

    syncMutedAttachment();
  };

  const hideKind = (kind: BubbleKind): void => {
    clearTimer(kind);
    if (!currentItems.has(kind)) {
      const node = nodes.get(kind);
      if (node !== undefined) node.root.style.display = 'none';
      syncMutedAttachment();
      return;
    }
    currentItems.delete(kind);
    renderLayout();
  };

  const showKind = (kind: BubbleKind, text: string, opts?: ShowBubbleOptions): boolean => {
    const cleaned = cleanBubbleText(text, kind);
    if (cleaned === '') return false;
    clearTimer(kind);
    currentItems.set(kind, { text: cleaned, ...(opts?.mood !== undefined ? { mood: opts.mood } : {}) });
    renderLayout(kind);
    if (latestLayout.items[kind] === undefined) return false;
    if (opts?.voiceManaged !== true) {
      const ttl = ttlForBubbleKind(kind, opts?.ttlMs);
      hideTimers.set(kind, setTimeout(() => hideKind(kind), ttl));
    }
    return true;
  };

  return {
    setStageBox(next: StageBox) {
      box = { ...next };
      renderLayout();
    },
    setContext(patch: BubbleStageContext) {
      context = {
        ...context,
        ...patch,
        ...(patch.anchor !== undefined ? { anchor: { ...context.anchor, ...patch.anchor } } : {}),
      };
      renderLayout();
    },
    setFont(fontId: BubbleFontId) {
      activeFontId = fontId;
      stage.style.setProperty('--pet-bubble-font-family', bubbleFontStack(fontId));
      renderLayout();
    },
    fontId() {
      return activeFontId;
    },
    show(kind: BubbleKind, text: string, opts?: ShowBubbleOptions) {
      return showKind(kind, text, opts);
    },
    hide(kind: BubbleKind) {
      hideKind(kind);
    },
    hideAll() {
      for (const kind of ALL_BUBBLE_KINDS) clearTimer(kind);
      currentItems = new Map();
      mutedState = false;
      mutedBadge.style.display = 'none';
      renderLayout();
    },
    showThought(text: string, opts?: ShowBubbleOptions) {
      void showKind('thought', text, opts);
    },
    showDialog(text: string, opts?: ShowBubbleOptions) {
      void showKind('dialog', text, opts);
    },
    hideThought() {
      hideKind('thought');
    },
    hideDialog() {
      hideKind('dialog');
    },
    setDialogMuted(muted: boolean) {
      mutedState = muted;
      syncMutedAttachment();
    },
    rects() {
      const fallback = computeBubbleLayout(box, context);
      return {
        thought: latestLayout.items.thought?.rect ?? fallback.thought,
        dialog: latestLayout.items.dialog?.rect ?? fallback.dialog,
      };
    },
    activeRects() {
      const out: Partial<Record<BubbleKind, BubbleRect>> = {};
      for (const item of latestLayout.ordered) {
        out[item.kind] = { ...item.rect };
      }
      return out;
    },
    activeKinds() {
      return latestLayout.ordered.map((item) => item.kind);
    },
  };
}
