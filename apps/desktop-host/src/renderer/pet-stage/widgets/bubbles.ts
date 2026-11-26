/**
 * 智能多语义气泡挂件（T-M1-05 重设计）：
 *   - 支持 6 种语义化气泡：thought（内心戏云朵）、dialog（海盐瓷对话）、status（深海青胶囊）、
 *     notice（海图金边通知）、reaction（珊瑚星芒反应）、hint（海浪问候提示）；
 *   - 感知角色位置/朝向/屏边/舞台障碍物（workCards/riceBowl），单气泡放大、多气泡智能防重叠；
 *   - 硬约束：pointer-events:none、z-index:7（角色视频之上、workCards(z8)/guide(z9) 之下）、
 *     渲染层入口必经 cleanBubbleText 清洗、不截断文字、省电降级。
 */
import {
  ttlForBubbleKind,
} from '../bubble-lifecycle';
import {
  computeBubbleLayout,
  computeSmartBubbleLayout,
  MAX_VISIBLE_BUBBLES,
  rectsOverlap,
  resolvePreferredSide,
  resolveTailDirection,
  type ActiveBubbleItem,
  type BubbleLayout,
  type BubbleRect,
  type BubbleStageContext,
  type BubbleTailDirection,
  type CharacterAnchor,
  type CharacterFacing,
  type PlacedBubble,
  type ScreenEdgeHint,
  type SmartBubbleLayout,
  type StageBox,
} from './bubble-layout';
import { cleanBubbleText } from './bubble-text';
import {
  ALL_BUBBLE_KINDS,
  bubbleTheme,
  bubbleWidthBudget,
  estimateBubbleSize,
  type BubbleKind,
  type BubbleVisualTheme,
} from './bubble-types';

export {
  ALL_BUBBLE_KINDS,
  bubbleTheme,
  bubbleWidthBudget,
  computeBubbleLayout,
  computeSmartBubbleLayout,
  estimateBubbleSize,
  MAX_VISIBLE_BUBBLES,
  rectsOverlap,
  resolvePreferredSide,
  resolveTailDirection,
  type ActiveBubbleItem,
  type BubbleKind,
  type BubbleLayout,
  type BubbleRect,
  type BubbleStageContext,
  type BubbleTailDirection,
  type CharacterAnchor,
  type CharacterFacing,
  type PlacedBubble,
  type ScreenEdgeHint,
  type SmartBubbleLayout,
  type StageBox,
};

export interface ShowBubbleOptions {
  ttlMs?: number;
  /** true 时交由语音租约托管，不启普通自动隐藏定时器 */
  voiceManaged?: boolean;
}

export interface BubbleWidgets {
  setStageBox(box: StageBox): void;
  setContext(patch: BubbleStageContext): void;
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

const FONT_STACK = '"ShangShouGummy","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const STYLE_ID = 'whale-bubble-styles';

function ensureBubbleStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '@keyframes whaleBubblePop{0%{opacity:0;transform:translateY(4px) scale(.94)}100%{opacity:1;transform:translateY(0) scale(1)}}',
    '@keyframes whaleBubbleBurst{0%{opacity:0;transform:scale(.86) rotate(-1.5deg)}65%{transform:scale(1.04) rotate(.5deg)}100%{opacity:1;transform:scale(1) rotate(0)}}',
    '@keyframes whaleStatusPulse{0%,100%{opacity:.72}50%{opacity:1}}',
    '.pet-bubble{position:absolute;box-sizing:border-box;pointer-events:none;z-index:7;overflow:visible;}',
    '.pet-bubble__body{display:flex;align-items:flex-start;gap:6px;width:100%;overflow:hidden;}',
    '.pet-bubble__icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;margin-top:2px;}',
    '.pet-bubble__text{flex:1 1 auto;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;overflow-wrap:anywhere;}',
    '.pet-bubble--status .pet-bubble__body{align-items:center;}',
    '.pet-bubble--status .pet-bubble__icon{margin-top:0;animation:whaleStatusPulse 2.2s ease-in-out infinite;}',
    '.pet-bubble__tail,.pet-bubble__clouds{position:absolute;pointer-events:none;}',
    '.pet-bubble-muted{flex:0 0 auto;display:none;align-items:center;gap:2px;padding:1px 5px;border-radius:999px;background:rgba(255,216,154,0.86);border:1px solid rgba(176,104,16,0.45);color:#7a3e00;font:600 9px/1.2 ui-monospace,monospace;align-self:flex-end;margin-left:2px;}',
    'html[data-power-saver="true"] .pet-bubble,html[data-power-saver="true"] .pet-bubble *{backdrop-filter:none !important;box-shadow:none !important;animation:none !important;}',
    '@media (prefers-reduced-motion: reduce){.pet-bubble,.pet-bubble *{animation:none !important;}}',
  ].join('');
  document.head.appendChild(style);
}

function applyTailVisual(
  tailEl: HTMLElement,
  cloudsEl: HTMLElement,
  theme: BubbleVisualTheme,
  tail: BubbleTailDirection,
): void {
  tailEl.style.display = 'none';
  cloudsEl.style.display = 'none';
  if (tail === 'none' || theme.tailKind === 'none') return;

  if (theme.tailKind === 'cloud') {
    cloudsEl.style.display = 'block';
    const [dotA, dotB] = cloudsEl.children as unknown as [HTMLElement, HTMLElement];
    if (dotA === undefined || dotB === undefined) return;
    cloudsEl.style.cssText = 'position:absolute;pointer-events:none;display:block;';
    if (tail === 'left') {
      cloudsEl.style.left = '-14px';
      cloudsEl.style.top = '50%';
      cloudsEl.style.transform = 'translateY(-50%)';
      dotA.style.cssText = `position:absolute;left:4px;top:-4px;width:8px;height:8px;border-radius:50%;background:${theme.tailFill};border:1px dashed ${theme.tailStroke};`;
      dotB.style.cssText = `position:absolute;left:-4px;top:3px;width:5px;height:5px;border-radius:50%;background:${theme.tailFill};border:1px dashed ${theme.tailStroke};`;
    } else if (tail === 'right') {
      cloudsEl.style.right = '-14px';
      cloudsEl.style.top = '50%';
      cloudsEl.style.transform = 'translateY(-50%)';
      dotA.style.cssText = `position:absolute;right:4px;top:-4px;width:8px;height:8px;border-radius:50%;background:${theme.tailFill};border:1px dashed ${theme.tailStroke};`;
      dotB.style.cssText = `position:absolute;right:-4px;top:3px;width:5px;height:5px;border-radius:50%;background:${theme.tailFill};border:1px dashed ${theme.tailStroke};`;
    } else {
      const anchorX = tail === 'bottom-left' ? 'left:18px;' : tail === 'bottom-right' ? 'right:18px;' : 'left:50%;transform:translateX(-50%);';
      cloudsEl.style.cssText = `position:absolute;bottom:-13px;${anchorX}width:18px;height:14px;pointer-events:none;display:block;`;
      dotA.style.cssText = `position:absolute;left:4px;top:0;width:8px;height:8px;border-radius:50%;background:${theme.tailFill};border:1px dashed ${theme.tailStroke};`;
      dotB.style.cssText = `position:absolute;left:1px;top:9px;width:5px;height:5px;border-radius:50%;background:${theme.tailFill};border:1px dashed ${theme.tailStroke};`;
    }
    return;
  }

  tailEl.style.display = 'block';
  const sharp = theme.tailKind === 'sharp';
  const soft = theme.tailKind === 'soft';
  const svgPath = sharp
    ? 'M1 0 L6 10 L12 0 Z'
    : soft
      ? 'M1 0 Q6 10 12 0 Z'
      : 'M1 0 L6 8 L12 0 Z';
  tailEl.innerHTML = `<svg viewBox="0 0 13 11" width="12" height="10" aria-hidden="true" style="display:block;overflow:visible"><path d="${svgPath}" fill="${theme.tailFill}" stroke="${theme.tailStroke}" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

  if (tail === 'bottom-left') {
    tailEl.style.cssText = 'position:absolute;left:22px;bottom:-9px;transform:none;pointer-events:none;display:block;';
  } else if (tail === 'bottom-right') {
    tailEl.style.cssText = 'position:absolute;right:22px;bottom:-9px;transform:scaleX(-1);pointer-events:none;display:block;';
  } else if (tail === 'bottom-center') {
    tailEl.style.cssText = 'position:absolute;left:50%;bottom:-9px;transform:translateX(-50%);pointer-events:none;display:block;';
  } else if (tail === 'left') {
    tailEl.style.cssText = 'position:absolute;left:-10px;top:50%;transform:translateY(-50%) rotate(90deg);pointer-events:none;display:block;';
  } else {
    tailEl.style.cssText = 'position:absolute;right:-10px;top:50%;transform:translateY(-50%) rotate(-90deg);pointer-events:none;display:block;';
  }
}

interface BubbleNodeRefs {
  kind: BubbleKind;
  theme: BubbleVisualTheme;
  root: HTMLDivElement;
  body: HTMLDivElement;
  icon: HTMLSpanElement;
  text: HTMLSpanElement;
  tail: HTMLDivElement;
  clouds: HTMLDivElement;
}

export function mountBubbleWidgets(stage: HTMLElement, stageBox: StageBox): BubbleWidgets {
  ensureBubbleStyles();

  let box: StageBox = { ...stageBox };
  let context: BubbleStageContext = {};
  let currentText = new Map<BubbleKind, string>();
  const hideTimers = new Map<BubbleKind, ReturnType<typeof setTimeout>>();
  let latestLayout: SmartBubbleLayout = computeSmartBubbleLayout(box, [], context);

  const mutedBadge = document.createElement('span');
  mutedBadge.className = 'pet-bubble-muted';
  mutedBadge.textContent = '静音';

  const nodes = new Map<BubbleKind, BubbleNodeRefs>();

  for (const kind of ALL_BUBBLE_KINDS) {
    const theme = bubbleTheme(kind);
    const root = document.createElement('div');
    root.className = `pet-bubble pet-bubble--${kind}`;
    root.dataset.bubbleKind = kind;
    root.dataset.tail = 'none';
    root.style.cssText = [
      'position:absolute',
      'display:none',
      'pointer-events:none',
      'z-index:7',
      `background:${theme.background}`,
      `border:${theme.border}`,
      theme.borderLeftAccent !== undefined ? `border-left:${theme.borderLeftAccent}` : '',
      `border-radius:${theme.borderRadius}`,
      `font-family:${FONT_STACK}`,
      `font-size:calc(${theme.fontSizePx}px * var(--pet-bubble-font-scale, 1))`,
      `line-height:${theme.lineHeight}`,
      `color:${theme.color}`,
      theme.fontWeight !== undefined ? `font-weight:${theme.fontWeight}` : '',
      theme.tabularNums === true ? 'font-variant-numeric:tabular-nums' : '',
      `padding:${theme.paddingY}px ${theme.paddingX}px`,
      `box-shadow:${theme.boxShadow}`,
      theme.backdropFilter !== undefined ? `backdrop-filter:${theme.backdropFilter}` : '',
    ].filter(Boolean).join(';');

    const body = document.createElement('div');
    body.className = 'pet-bubble__body';

    const icon = document.createElement('span');
    icon.className = 'pet-bubble__icon';
    if (theme.iconSvg !== '') {
      icon.innerHTML = theme.iconSvg;
    } else {
      icon.style.display = 'none';
    }

    const textEl = document.createElement('span');
    textEl.className = 'pet-bubble__text';
    textEl.style.setProperty('-webkit-line-clamp', String(theme.maxLines));

    body.append(icon, textEl);
    if (kind === 'dialog') body.appendChild(mutedBadge);

    const tail = document.createElement('div');
    tail.className = 'pet-bubble__tail';
    tail.style.display = 'none';

    const clouds = document.createElement('div');
    clouds.className = 'pet-bubble__clouds';
    clouds.style.display = 'none';
    clouds.append(document.createElement('span'), document.createElement('span'));

    root.append(body, tail, clouds);
    stage.appendChild(root);
    nodes.set(kind, { kind, theme, root, body, icon, text: textEl, tail, clouds });
  }

  const clearTimer = (kind: BubbleKind): void => {
    const timer = hideTimers.get(kind);
    if (timer !== undefined) {
      clearTimeout(timer);
      hideTimers.delete(kind);
    }
  };

  const renderLayout = (freshKind?: BubbleKind): void => {
    const active: ActiveBubbleItem[] = [];
    for (const [kind, text] of currentText) {
      active.push({ kind, text });
    }
    latestLayout = computeSmartBubbleLayout(box, active, context);

    for (const kind of ALL_BUBBLE_KINDS) {
      const node = nodes.get(kind)!;
      const placed = latestLayout.items[kind];
      if (placed === undefined) {
        node.root.style.display = 'none';
        node.root.dataset.tail = 'none';
        if (currentText.has(kind)) {
          currentText.delete(kind);
          clearTimer(kind);
        }
        if (kind === 'dialog') mutedBadge.style.display = 'none';
        continue;
      }

      const textValue = currentText.get(kind) ?? '';
      node.text.textContent = textValue;
      node.text.style.setProperty('-webkit-line-clamp', String(placed.maxLines));

      const bodyMaxHeight = Math.max(12, placed.rect.height - node.theme.paddingY * 2);
      node.body.style.maxHeight = `${bodyMaxHeight}px`;

      node.root.style.left = `${placed.rect.x}px`;
      node.root.style.top = `${placed.rect.y}px`;
      node.root.style.width = `${placed.rect.width}px`;
      node.root.style.maxHeight = `${placed.rect.height}px`;
      node.root.dataset.tail = placed.tail;

      const wasHidden = node.root.style.display === 'none';
      node.root.style.display = 'block';
      if (wasHidden || freshKind === kind) {
        node.root.style.animation = 'none';
        void node.root.offsetWidth;
        node.root.style.animation = `${node.theme.animationName} 180ms cubic-bezier(.22,1,.36,1) both`;
      }
      applyTailVisual(node.tail, node.clouds, node.theme, placed.tail);
    }
  };

  const hideKind = (kind: BubbleKind): void => {
    clearTimer(kind);
    if (!currentText.has(kind)) {
      const node = nodes.get(kind);
      if (node !== undefined) node.root.style.display = 'none';
      if (kind === 'dialog') mutedBadge.style.display = 'none';
      return;
    }
    currentText.delete(kind);
    if (kind === 'dialog') mutedBadge.style.display = 'none';
    renderLayout();
  };

  const showKind = (kind: BubbleKind, text: string, opts?: ShowBubbleOptions): boolean => {
    const cleaned = cleanBubbleText(text, kind);
    if (cleaned === '') return false;
    clearTimer(kind);
    currentText.set(kind, cleaned);
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
    show(kind: BubbleKind, text: string, opts?: ShowBubbleOptions) {
      return showKind(kind, text, opts);
    },
    hide(kind: BubbleKind) {
      hideKind(kind);
    },
    hideAll() {
      for (const kind of ALL_BUBBLE_KINDS) clearTimer(kind);
      currentText = new Map();
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
      mutedBadge.style.display = muted ? 'inline-flex' : 'none';
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
