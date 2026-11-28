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
import { bubblePageReadingMs, paginateBubbleText } from './bubble-pages';
import { cleanBubbleText, hasVisibleGlyph } from './bubble-text';
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
  /** true 时跳过打字机逐字揭示，立即显示完整文本 */
  instant?: boolean;
}

export interface TypewriterPlan {
  enabled: boolean;
  glyphs: string[];
  stepChars: number;
  intervalMs: number;
  estimatedMs: number;
}

/** 计算气泡打字机逐字揭示节奏（status 状态条即时渲染；长文本自适应每帧字数控制在 ~2s 内完成）。 */
export function computeTypewriterPlan(
  kind: BubbleKind,
  text: string,
  opts?: { instant?: boolean; reducedMotion?: boolean },
): TypewriterPlan {
  const glyphs = Array.from(text);
  const enabled = kind !== 'status' && opts?.instant !== true && opts?.reducedMotion !== true && glyphs.length > 1;
  const stepChars = glyphs.length <= 45 ? 1 : glyphs.length <= 90 ? 2 : 3;
  const intervalMs = 32;
  const estimatedMs = enabled ? Math.ceil(glyphs.length / stepChars) * intervalMs : 0;
  return { enabled, glyphs, stepChars, intervalMs, estimatedMs };
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
  setDialogSpeaking(speaking: boolean): void;
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
    '.pet-bubble__text{flex:1 1 auto;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:break-word;word-break:normal;}',
    '.pet-bubble--status .pet-bubble__body{align-items:center;}',
    '.pet-bubble--status .pet-bubble__icon{margin-top:0;animation:whaleStatusPulse 2.2s ease-in-out infinite;}',
    '.pet-bubble-muted{flex:0 0 auto;display:none;align-items:center;gap:2px;padding:1px 5px;border-radius:999px;background:rgba(255,216,154,0.88);border:1px solid rgba(176,104,16,0.45);color:#7a3e00;font:600 9px/1.2 ui-monospace,monospace;align-self:flex-end;margin-left:2px;}',
    '.pet-bubble-voice{flex:0 0 auto;display:none;align-items:flex-end;gap:2px;height:11px;align-self:flex-end;margin-left:3px;padding:0 2px;}',
    '.pet-bubble-voice i{display:block;width:2px;border-radius:2px;background:currentColor;opacity:.75;transition:height 70ms linear;}',
    '.pet-bubble-voice i:nth-child(1){height:calc(3px + var(--pet-lip-amplitude, 0) * 6px);}',
    '.pet-bubble-voice i:nth-child(2){height:calc(4px + var(--pet-lip-amplitude, 0) * 8px);}',
    '.pet-bubble-voice i:nth-child(3){height:calc(3px + var(--pet-lip-amplitude, 0) * 5px);}',
    'html[data-power-saver="true"] .pet-bubble,html[data-power-saver="true"] .pet-bubble *{backdrop-filter:none !important;filter:none !important;box-shadow:none !important;animation:none !important;transition:none !important;}',
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
  let currentItems = new Map<BubbleKind, { text: string; mood?: BubbleMood; instant?: boolean }>();
  const hideTimers = new Map<BubbleKind, ReturnType<typeof setTimeout>>();
  const typingTimers = new Map<BubbleKind, ReturnType<typeof setInterval>>();
  const pageTimers = new Map<BubbleKind, ReturnType<typeof setTimeout>>();
  interface Presentation {
    fullText: string;
    layoutKey: string;
    pages: string[];
    page: number;
    revealed: number;
    done: boolean;
    readDone: boolean;
    hideRequested: boolean;
    blocked: boolean;
  }
  const typingStates = new Map<BubbleKind, Presentation>();
  let fontRevision = 0;
  let latestLayout: SmartBubbleLayout = computeSmartBubbleLayout(box, [], context);

  stage.style.setProperty('--pet-bubble-font-family', bubbleFontStack(activeFontId));

  const mutedBadge = document.createElement('span');
  mutedBadge.className = 'pet-bubble-muted';
  mutedBadge.textContent = '静音';
  let mutedState = false;

  const voiceWave = document.createElement('span');
  voiceWave.className = 'pet-bubble-voice';
  voiceWave.setAttribute('aria-hidden', 'true');
  voiceWave.innerHTML = '<i></i><i></i><i></i>';
  let speakingState = false;

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

  const clearTypewriter = (kind: BubbleKind): void => {
    const timer = typingTimers.get(kind);
    if (timer !== undefined) {
      clearInterval(timer);
      typingTimers.delete(kind);
    }
    const pageTimer = pageTimers.get(kind);
    if (pageTimer !== undefined) clearTimeout(pageTimer);
    pageTimers.delete(kind);
  };

  const shouldUseTypewriter = (kind: BubbleKind, entry?: { instant?: boolean }): boolean => {
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    return computeTypewriterPlan(kind, 'ab', { instant: entry?.instant === true, reducedMotion: reduced }).enabled;
  };

  const syncMutedAttachment = (): void => {
    const dialogVisible = latestLayout.items.dialog !== undefined;
    const reactionVisible = latestLayout.items.reaction !== undefined;
    const targetKind: BubbleKind = dialogVisible ? 'dialog' : reactionVisible ? 'reaction' : 'legacy';
    const targetNode = nodes.get(targetKind);
    if (targetNode !== undefined) {
      if (mutedBadge.parentElement !== targetNode.body) targetNode.body.appendChild(mutedBadge);
      if (voiceWave.parentElement !== targetNode.body) targetNode.body.appendChild(voiceWave);
    }
    const hasSpeechBubble = dialogVisible || reactionVisible || latestLayout.items.legacy !== undefined;
    mutedBadge.style.display = mutedState && hasSpeechBubble ? 'inline-flex' : 'none';
    voiceWave.style.display = speakingState && !mutedState && hasSpeechBubble ? 'inline-flex' : 'none';
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
        delete node.root.dataset.fullText;
        delete node.root.dataset.pageText;
        delete node.root.dataset.page;
        delete node.root.dataset.pageCount;
        delete node.root.dataset.readingBlocked;
        clearTypewriter(kind);
        typingStates.delete(kind);
        if (currentItems.has(kind)) {
          currentItems.delete(kind);
          clearTimer(kind);
        }
        continue;
      }

      const itemEntry = currentItems.get(kind);
      const textValue = itemEntry?.text ?? '';
      const style = resolveBubbleStyle(kind, itemEntry?.mood);

      // 渲染层最终防线：正文完全没有会出墨的字符时直接收起气泡外壳。
      // 真机 2026-11-28 出现过只剩心形徽标、正文空白的「空气泡」。
      if (!hasVisibleGlyph(textValue)) {
        node.root.style.display = 'none';
        node.root.dataset.tail = 'none';
        node.root.dataset.bubbleMood = '';
        delete node.root.dataset.fullText;
        delete node.root.dataset.pageText;
        delete node.root.dataset.page;
        delete node.root.dataset.pageCount;
        delete node.root.dataset.readingBlocked;
        clearTypewriter(kind);
        typingStates.delete(kind);
        currentItems.delete(kind);
        clearTimer(kind);
        continue;
      }

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

      const bodyMaxHeight = Math.max(12, placed.rect.height - style.paddingY * 2);
      const scaleNum = context.fontScale ?? 1;
      const linePx = style.fontSizePx * scaleNum * style.lineHeight;
      const fittingLines = linePx > 0 ? Math.max(1, Math.min(placed.maxLines, Math.floor(bodyMaxHeight / linePx))) : placed.maxLines;
      node.text.style.height = '';
      node.text.style.display = '-webkit-box';
      node.text.textContent = textValue;
      node.root.dataset.fullText = textValue;
      node.text.style.setProperty('-webkit-line-clamp', String(fittingLines));
      node.body.style.maxHeight = `${bodyMaxHeight}px`;

      node.root.style.left = `${placed.rect.x}px`;
      node.root.style.top = `${placed.rect.y}px`;
      node.root.style.width = `${placed.rect.width}px`;
      node.root.style.height = '';
      node.root.style.maxHeight = `${placed.rect.height}px`;
      node.body.style.minHeight = '';

      const wasHidden = node.root.style.display === 'none';
      node.root.style.display = 'block';

      if (wasHidden || freshKind === kind) {
        node.root.style.animation = 'none';
        void node.root.offsetWidth;
        node.root.style.animation = `${style.animationName} 200ms cubic-bezier(.22,1,.36,1) both`;
      }
    }

    syncMutedAttachment();

    for (const kind of ALL_BUBBLE_KINDS) {
      const node = nodes.get(kind)!;
      const placed = latestLayout.items[kind];
      if (placed === undefined || node.root.style.display === 'none') continue;
      const style = resolveBubbleStyle(kind, currentItems.get(kind)?.mood);
      const scaleNum = context.fontScale ?? 1;
      const linePx = style.fontSizePx * scaleNum * style.lineHeight;
      if (node.text.scrollHeight > node.text.clientHeight + 2 && linePx > 0) {
        // Real DOM font wrapping exceeded estimated lines cleanly within maxLines: grow downward, or lift upward within stage wing without overlapping other bubbles or pet face
        const bottomLimit = box.height > 150 ? box.height - 28 : box.height - 6;
        const petGw = Math.round(box.width * 0.28);
        const petGy = Math.round(box.height * 0.28);
        const petZone = { x: Math.round(box.width * 0.5 - petGw / 2), y: petGy, width: petGw, height: Math.max(20, bottomLimit - petGy) };
        const others = [...latestLayout.ordered.filter((o) => o.kind !== kind).map((o) => o.rect), petZone];
        const xOverlaps = others.filter((r) => !(r.x + r.width <= placed.rect.x || r.x >= placed.rect.x + placed.rect.width));
        const blockerY = xOverlaps
          .filter((r) => r.y >= placed.rect.y + placed.rect.height - 2)
          .reduce((best, r) => Math.min(best, r.y - 6), bottomLimit);
        const aboveBlockerY = xOverlaps
          .filter((r) => r.y + r.height <= placed.rect.y + 2)
          .reduce((best, r) => Math.max(best, r.y + r.height + 6), 6);
        const maxDownH = Math.max(placed.rect.height, blockerY - placed.rect.y);
        const neededH = Math.ceil(node.text.scrollHeight + style.paddingY * 2 + 2);
        const extraNeed = Math.max(0, neededH - maxDownH);
        const liftPx = Math.min(extraNeed, Math.max(0, placed.rect.y - aboveBlockerY));
        const nextY = placed.rect.y - liftPx;
        const maxRoomH = Math.max(placed.rect.height, Math.min(bottomLimit - nextY, blockerY - nextY));
        const grownH = Math.min(maxRoomH, Math.max(placed.rect.height, neededH));
        if (liftPx > 0) {
          node.root.style.top = `${nextY}px`;
        }
        if (grownH > placed.rect.height) {
          const nextBodyMax = Math.max(12, grownH - style.paddingY * 2);
          const nextClamp = Math.max(1, Math.floor((nextBodyMax + 2) / linePx));
          node.root.style.maxHeight = `${grownH}px`;
          node.body.style.maxHeight = `${nextBodyMax}px`;
          node.text.style.setProperty('-webkit-line-clamp', String(nextClamp));
        }
        // If even at maxRoomH Chromium's line-clamp cuts overflow (causing scrollHeight > clientHeight), snap line-clamp to fit clientHeight lines cleanly so nothing clips half-line
        const finalBodyH = parseFloat(node.body.style.maxHeight) || placed.rect.height;
        const maxFitLines = Math.max(1, Math.floor((finalBodyH + 1) / linePx));
        if (node.text.scrollHeight > node.text.clientHeight + 2) {
          node.text.style.setProperty('-webkit-line-clamp', String(maxFitLines));
        }
      }
      const actualW = Math.max(28, Math.round(node.root.offsetWidth || placed.rect.width));
      const actualH = Math.max(20, Math.round(node.root.offsetHeight || placed.rect.height));
      renderShellSvg(node.shell, node.glass, kind, style, actualW, actualH, placed.tail);

      // 锁定最终测算好的外框宽高后，再启动打字机逐字揭示，防止文字逐字增加时气泡外框反复跳变
      const entry = currentItems.get(kind);
      const fullText = entry?.text ?? '';
      node.root.style.height = `${actualH}px`;
      node.body.style.minHeight = `${Math.max(12, actualH - style.paddingY * 2)}px`;
      const existingTyping = typingStates.get(kind);
      // 固定整行文本区域，移除省略号；分页判据读取真实 DOM 的溢出情况。
      const visibleBodyH = Math.max(0, Math.min(
        actualH - style.paddingY * 2,
        node.body.clientHeight,
        Number.parseFloat(node.body.style.maxHeight),
      ));
      const availableH = linePx > 0 ? Math.floor((visibleBodyH + 0.01) / linePx) * linePx : 0;
      node.text.style.display = 'block';
      node.text.style.setProperty('-webkit-line-clamp', 'unset');
      node.text.style.overflowWrap = 'anywhere';
      node.text.style.height = `${availableH}px`;
      const layoutKey = `${node.text.clientWidth}/${node.text.clientHeight}/${activeFontId}/${fontRevision}/${scaleNum}/${style.fontSizePx}`;
      if (existingTyping !== undefined && !existingTyping.blocked && existingTyping.fullText === fullText && existingTyping.layoutKey === layoutKey) {
        const currentPageText = existingTyping.pages[existingTyping.page] ?? fullText;
        node.text.textContent = Array.from(currentPageText).slice(0, existingTyping.revealed).join('');
        continue;
      }
      clearTypewriter(kind);
      const readPrefix = existingTyping?.fullText === fullText
        ? existingTyping.pages.slice(0, existingTyping.page).join('') : '';
      const remaining = fullText.slice(readPrefix.length);
      // 已全部读完时布局重算（字体加载/尺寸变化）不得把正文清空留下空壳气泡，保留当前页原文。
      if (remaining === '' && existingTyping !== undefined && existingTyping.fullText === fullText) {
        node.text.textContent = existingTyping.pages[existingTyping.page] ?? fullText;
        node.root.dataset.pageText = node.text.textContent;
        node.root.dataset.page = String(existingTyping.page + 1);
        node.root.dataset.pageCount = String(existingTyping.pages.length);
        node.root.dataset.readingBlocked = 'false';
        existingTyping.readDone = true;
        continue;
      }
      let pages: string[];
      let blocked = availableH < linePx || node.text.clientWidth <= 0;
      try {
        pages = blocked ? [remaining] : paginateBubbleText(remaining, (candidate) => {
          node.text.textContent = candidate;
          return node.text.scrollHeight <= node.text.clientHeight + 1 && node.text.scrollWidth <= node.text.clientWidth + 1;
        });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        // 极小舞台或临时徽标挤占导致连一个完整字也无法显示：保留未读原文等待空间恢复。
        blocked = true;
        pages = [remaining];
      }
      const presentation: Presentation = {
        fullText, layoutKey, pages: readPrefix === '' ? pages : [readPrefix, ...pages],
        page: readPrefix === '' ? 0 : 1, revealed: 0, done: false, readDone: false,
        hideRequested: existingTyping?.hideRequested ?? false, blocked,
      };
      typingStates.set(kind, presentation);
      node.root.dataset.readingBlocked = String(blocked);
      if (blocked) {
        // 没有可容纳一个字的空间时不显示空心气泡壳；保留原文等待下一次布局恢复。
        node.text.textContent = '';
        node.root.style.display = 'none';
        node.root.dataset.pageText = remaining;
        node.root.dataset.page = String(presentation.page + 1);
        node.root.dataset.pageCount = String(presentation.pages.length);
        continue;
      }
      const revealPage = (): void => {
        if (typingStates.get(kind) !== presentation || !currentItems.has(kind)) return;
        const pageText = presentation.pages[presentation.page] ?? '';
        const plan = computeTypewriterPlan(kind, pageText, { instant: !shouldUseTypewriter(kind, entry) });
        node.root.dataset.pageText = pageText;
        node.root.dataset.page = String(presentation.page + 1);
        node.root.dataset.pageCount = String(presentation.pages.length);
        presentation.revealed = plan.enabled ? 1 : plan.glyphs.length;
        presentation.done = !plan.enabled;
        const finishPage = (): void => {
          const timer = typingTimers.get(kind);
          if (timer !== undefined) clearInterval(timer);
          typingTimers.delete(kind);
          presentation.done = true;
          pageTimers.set(kind, setTimeout(() => {
            if (typingStates.get(kind) !== presentation) return;
            pageTimers.delete(kind);
            if (presentation.page + 1 < presentation.pages.length) {
              presentation.page += 1;
              revealPage();
            } else {
              presentation.readDone = true;
              if (presentation.hideRequested) hideKind(kind);
            }
          }, bubblePageReadingMs(pageText)));
        };
        node.text.textContent = plan.glyphs.slice(0, presentation.revealed).join('');
        if (!plan.enabled) { finishPage(); return; }
        typingTimers.set(kind, setInterval(() => {
          if (typingStates.get(kind) !== presentation) return;
          presentation.revealed = Math.min(plan.glyphs.length, presentation.revealed + plan.stepChars);
          node.text.textContent = plan.glyphs.slice(0, presentation.revealed).join('');
          if (presentation.revealed >= plan.glyphs.length) finishPage();
        }, plan.intervalMs));
      };
      revealPage();
    }
  };

  const hideKind = (kind: BubbleKind): void => {
    clearTimer(kind);
    clearTypewriter(kind);
    typingStates.delete(kind);
    if (!currentItems.has(kind)) {
      const node = nodes.get(kind);
      if (node !== undefined) node.root.style.display = 'none';
      syncMutedAttachment();
      return;
    }
    currentItems.delete(kind);
    renderLayout();
  };

  const requestHide = (kind: BubbleKind): void => {
    const presentation = typingStates.get(kind);
    if (presentation !== undefined && (presentation.blocked || presentation.pages.length > 1) && !presentation.readDone) {
      presentation.hideRequested = true;
      clearTimer(kind);
      return;
    }
    hideKind(kind);
  };

  const showKind = (kind: BubbleKind, text: string, opts?: ShowBubbleOptions): boolean => {
    const cleaned = cleanBubbleText(text, kind);
    if (cleaned === '') return false;
    // 只有零宽/组合记号等无墨字符的文本：外壳会照画但正文空白（真机 2026-11-28「空气泡」）。
    // 这里直接拒绝展示，避免出现只有徽标没有正文的空壳气泡。
    if (!hasVisibleGlyph(cleaned)) return false;
    clearTimer(kind);
    clearTypewriter(kind);
    typingStates.delete(kind);
    currentItems.set(kind, {
      text: cleaned,
      ...(opts?.mood !== undefined ? { mood: opts.mood } : {}),
      ...(opts?.instant !== undefined ? { instant: opts.instant } : {}),
    });
    renderLayout(kind);
    if (latestLayout.items[kind] === undefined) return false;
    if (opts?.voiceManaged !== true) {
      const estTypingMs = computeTypewriterPlan(kind, cleaned, { instant: !shouldUseTypewriter(kind, opts) }).estimatedMs;
      const ttl = Math.min(60_000, Math.max(ttlForBubbleKind(kind, opts?.ttlMs), estTypingMs + 4_500));
      hideTimers.set(kind, setTimeout(() => requestHide(kind), ttl));
    }
    return true;
  };

  // 随包字体完成加载后按未读页起点重测，避免 fallback 字体的分页容量遗留。
  const refreshFonts = (): void => { fontRevision += 1; renderLayout(); };
  void document.fonts?.ready.then(refreshFonts);
  document.fonts?.addEventListener('loadingdone', refreshFonts);

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
      for (const kind of ALL_BUBBLE_KINDS) {
        clearTimer(kind);
        clearTypewriter(kind);
      }
      typingStates.clear();
      currentItems = new Map();
      mutedState = false;
      speakingState = false;
      mutedBadge.style.display = 'none';
      voiceWave.style.display = 'none';
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
      requestHide('dialog');
    },
    setDialogMuted(muted: boolean) {
      if (mutedState === muted) return;
      mutedState = muted;
      renderLayout();
    },
    setDialogSpeaking(speaking: boolean) {
      if (speakingState === speaking) return;
      speakingState = speaking;
      renderLayout();
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
