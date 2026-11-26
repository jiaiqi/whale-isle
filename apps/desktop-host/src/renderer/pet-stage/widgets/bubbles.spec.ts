import { describe, expect, it } from 'vitest';
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
  type BubbleKind,
  type BubbleRect,
  type BubbleTailDirection,
} from './bubbles';
import { cleanBubbleText } from './bubble-text';

const STAGE = { width: 400, height: 260 };

function assertNoOverlapAndInside(rects: readonly BubbleRect[], stage: { width: number; height: number }): void {
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i]!;
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(stage.width);
    expect(r.y + r.height).toBeLessThanOrEqual(stage.height);
    for (let j = i + 1; j < rects.length; j += 1) {
      expect(rectsOverlap(r, rects[j]!)).toBe(false);
    }
  }
}

describe('bubble-types（7 种语义 × 7 种情绪 × 4 套随包字体）', () => {
  it('7 种气泡（含 legacy 经典蓝玻）均具备独立优先级、TTL 与零彩色 Emoji 令牌', () => {
    expect(ALL_BUBBLE_KINDS).toHaveLength(7);
    expect(ALL_BUBBLE_KINDS).toContain('legacy');
    const priorities = new Set<number>();
    for (const kind of ALL_BUBBLE_KINDS) {
      const theme = bubbleTheme(kind);
      expect(theme.kind).toBe(kind);
      expect(theme.defaultTtlMs).toBeGreaterThanOrEqual(6_000);
      priorities.add(theme.priority);
      if (theme.iconSvg !== '') {
        expect(theme.iconSvg).toContain('<svg');
      }
    }
    expect(priorities.size).toBe(7);
    expect(bubbleTheme('legacy')).toMatchObject({
      fontSizePx: 13,
      lineHeight: 1.55,
      radiusPx: 16,
      tailKind: 'pointer',
    });
  });

  it('7 种情绪变体与事件触发查表完整，无尾巴语义气泡透传 mood 时仍维持无尾形态', () => {
    expect(ALL_BUBBLE_MOODS).toHaveLength(7);
    for (const mood of ALL_BUBBLE_MOODS) {
      const moodTheme = BUBBLE_MOOD_THEMES[mood];
      expect(moodTheme.iconSvg).toContain('<svg');
      const dialogStyled = resolveBubbleStyle('dialog', mood);
      expect(dialogStyled.mood).toBe(mood);
      expect(dialogStyled.strokeColor).toBe(moodTheme.strokeColor);
      expect(dialogStyled.tailKind).toBe(moodTheme.tailKind);
      expect(dialogStyled.animationName).toBe(moodTheme.animationName);

      // status 原生无尾巴，叠心情时保持无尾巴不破坏胶囊形态
      const statusStyled = resolveBubbleStyle('status', mood);
      expect(statusStyled.tailKind).toBe('none');
    }

    for (const [trigger, expectedMood] of Object.entries(TRIGGER_TO_MOOD)) {
      expect(moodForTrigger(trigger)).toBe(expectedMood);
    }
    expect(moodForTrigger('unknown_event')).toBeUndefined();
    expect(resolveBubbleStyle('dialog', null).mood).toBeUndefined();
  });

  it('4 套随包字体含完整回退链与 3 类可商用 SIL OFL 1.1 woff2 @font-face', () => {
    expect(ALL_BUBBLE_FONT_IDS).toEqual(['shangshou-gummy', 'handwriting', 'rounded', 'formal']);
    expect(bubbleFontDefinition().id).toBe('shangshou-gummy');
    expect(bubbleFontStack()).toContain('ShangShouGummy');

    for (const fontId of ALL_BUBBLE_FONT_IDS) {
      const def = BUBBLE_FONTS[fontId];
      expect(def.fallbackStack).toContain(def.family);
      expect(def.fallbackStack).toContain('PingFang SC');
      expect(bubbleFontStack(fontId)).toBe(def.fallbackStack);
    }

    const css = buildBubbleFontFacesCss();
    expect(css).toContain('long-cang.woff2');
    expect(css).toContain('zcool-kuaile.woff2');
    expect(css).toContain('zcool-xiaowei.woff2');
    expect(css).not.toContain('上首软糖体.ttf');
  });

  it('单气泡突破旧 220px 上限；legacy 保持紧凑上限；窄舞台自动安全夹紧', () => {
    const single = estimateBubbleSize({
      kind: 'dialog',
      text: '今天星露谷春天收获了满满一筐防风草和草莓，鱼片晚上想不想一起吃海鲜饭呀！',
      stage: STAGE,
      activeCount: 1,
      mood: 'happy',
    });
    expect(single.width).toBeGreaterThan(240);
    expect(single.width).toBeLessThanOrEqual(304);

    const legacySingle = estimateBubbleSize({
      kind: 'legacy',
      text: '正在帮你盯着星露谷农田浇水和体力状况，放心交给本鱼！',
      stage: STAGE,
      activeCount: 1,
    });
    expect(legacySingle.width).toBeLessThanOrEqual(220);

    const legacyDual = bubbleWidthBudget('legacy', 400, 2);
    expect(legacyDual.maxWidth).toBeLessThanOrEqual(192);

    const shortText = estimateBubbleSize({ kind: 'reaction', text: '哼！', stage: STAGE, activeCount: 1, fontScale: 1.2 });
    expect(shortText.width).toBeLessThan(160);

    const tinyBudget = bubbleWidthBudget('dialog', 96, 1);
    expect(tinyBudget.minWidth).toBeLessThanOrEqual(tinyBudget.maxWidth);
    expect(tinyBudget.maxWidth).toBeGreaterThanOrEqual(48);

    const twoDialog = bubbleWidthBudget('dialog', 400, 2);
    expect(twoDialog.maxWidth).toBeLessThanOrEqual(252);
    const twoReaction = bubbleWidthBudget('reaction', 400, 2);
    expect(twoReaction.maxWidth).toBeLessThanOrEqual(212);
    const twoThought = bubbleWidthBudget('thought', 400, 2);
    expect(twoThought.maxWidth).toBeLessThanOrEqual(196);
    const threeBudget = bubbleWidthBudget('status', 400, 3);
    expect(threeBudget.maxWidth).toBeLessThanOrEqual(220);
  });
});

describe('连续融合尾巴 SVG 路径 & 思绪云粒', () => {
  const directions: BubbleTailDirection[] = [
    'none',
    'top-left',
    'top-center',
    'top-right',
    'right',
    'bottom-right',
    'bottom-center',
    'bottom-left',
    'left',
  ];

  it('8 方向尾巴均生成单条闭合 SVG <path>，无二次断开 M 指令', () => {
    for (const tailKind of ['pointer', 'sharp', 'soft'] as const) {
      for (const tail of directions) {
        const geom = buildBubbleShellPath({
          width: 180,
          height: 54,
          radius: 16,
          tail,
          tailKind,
        });
        expect(geom.svgWidth).toBe(180 + 28);
        expect(geom.svgHeight).toBe(54 + 28);
        expect(geom.path.startsWith('M ')).toBe(true);
        expect(geom.path.endsWith(' Z')).toBe(true);
        expect(geom.path.match(/\bM\b/g)).toHaveLength(1);
        expect(geom.path.match(/\bZ\b/g)).toHaveLength(1);
      }
    }
    const cloudShell = buildBubbleShellPath({
      width: 140,
      height: 44,
      radius: 19,
      tail: 'bottom-left',
      tailKind: 'cloud',
      pad: 12,
    });
    expect(cloudShell.pad).toBe(12);
    expect(cloudShell.path.match(/\bM\b/g)).toHaveLength(1);
  });

  it('思绪气泡在 8 个朝向下均生成 3 颗递减云粒，none 返回空数组', () => {
    expect(buildThoughtCloudDots({ width: 150, height: 48, tail: 'none' })).toEqual([]);
    for (const tail of directions.filter((d) => d !== 'none')) {
      const dots = buildThoughtCloudDots({ width: 150, height: 48, tail });
      expect(dots).toHaveLength(3);
      expect(dots.map((d) => d.r)).toEqual([4.1, 2.8, 1.7]);
    }
  });
});

describe('computeSmartBubbleLayout（智能定位 + legacy 右下 + 不重叠）', () => {
  it('空列表与纯空白文本返回空布局', () => {
    const empty = computeSmartBubbleLayout(STAGE, [{ kind: 'dialog', text: '   ' }]);
    expect(empty.ordered).toHaveLength(0);
    expect(empty.preferredSide).toBe('right');
  });

  it('方向决策优先屏边避让，其次角色朝向与偏位', () => {
    expect(resolvePreferredSide({ edgeHint: 'right', anchor: { facing: 'right', xRatio: 0.2 } })).toBe('left');
    expect(resolvePreferredSide({ edgeHint: 'left', anchor: { facing: 'left', xRatio: 0.8 } })).toBe('right');
    expect(resolvePreferredSide({ anchor: { facing: 'left' } })).toBe('left');
    expect(resolvePreferredSide({ anchor: { facing: 'right' } })).toBe('right');
    expect(resolvePreferredSide({ anchor: { xRatio: 0.72 } })).toBe('left');
    expect(resolvePreferredSide({ anchor: { xRatio: 0.28 } })).toBe('right');
    expect(resolvePreferredSide({})).toBe('right');
  });

  it('角色朝向切换时主侧与尾巴方向智能镜像', () => {
    const rightLayout = computeSmartBubbleLayout(
      STAGE,
      [
        { kind: 'thought', text: '要不要先去海边钓一条比目鱼呢', mood: 'thinking' },
        { kind: 'dialog', text: '鱼片看好了，这杆肯定能钓到大货！', mood: 'happy' },
      ],
      { anchor: { xRatio: 0.5, headYRatio: 0.34, facing: 'right' } },
    );
    const leftLayout = computeSmartBubbleLayout(
      STAGE,
      [
        { kind: 'thought', text: '要不要先去海边钓一条比目鱼呢', mood: 'thinking' },
        { kind: 'dialog', text: '鱼片看好了，这杆肯定能钓到大货！', mood: 'happy' },
      ],
      { anchor: { xRatio: 0.5, headYRatio: 0.34, facing: 'left' } },
    );

    expect(rightLayout.preferredSide).toBe('right');
    expect(leftLayout.preferredSide).toBe('left');
    expect(rightLayout.items.dialog!.rect.x).toBeGreaterThan(leftLayout.items.dialog!.rect.x);
    expect(leftLayout.items.thought!.rect.x).toBeGreaterThan(rightLayout.items.thought!.rect.x);
    expect(rightLayout.items.dialog!.tail).not.toBe(leftLayout.items.dialog!.tail);
    assertNoOverlapAndInside(rightLayout.ordered.map((i) => i.rect), STAGE);
    assertNoOverlapAndInside(leftLayout.ordered.map((i) => i.rect), STAGE);
  });

  it('legacy 半透蓝泡默认落在角色右下方且避开底部居中饭碗与脸身区', () => {
    const avatarGuard: BubbleRect = { x: 144, y: 73, width: 112, height: 159 };
    const riceBowl: BubbleRect = { x: 136, y: 228, width: 128, height: 30 };
    const layout = computeSmartBubbleLayout(
      STAGE,
      [{ kind: 'legacy', text: '收到指令，这就过去帮忙照看星露谷农田！' }],
      { anchor: { xRatio: 0.5, headYRatio: 0.34, facing: 'center' }, occupied: [riceBowl] },
    );
    const placed = layout.items.legacy!;
    expect(placed).toBeDefined();
    expect(placed.rect.x).toBeGreaterThan(200);
    expect(placed.rect.y).toBeGreaterThan(100);
    expect(['top-left', 'left']).toContain(placed.tail);
    expect(rectsOverlap(placed.rect, avatarGuard)).toBe(false);
    expect(rectsOverlap(placed.rect, riceBowl)).toBe(false);
    assertNoOverlapAndInside([placed.rect], STAGE);

    // 若右下空间被占据，自动让位并保持不重叠
    const blocked = computeSmartBubbleLayout(
      STAGE,
      [{ kind: 'legacy', text: '收到指令！' }],
      { occupied: [{ x: 240, y: 120, width: 158, height: 112 }] },
    );
    assertNoOverlapAndInside([blocked.items.legacy!.rect], STAGE);
  });

  it('400×260 舞台下双轨长文本自动避开角色中心脸身保护区', () => {
    const avatarGuard: BubbleRect = { x: 144, y: 73, width: 112, height: 159 };
    const layout = computeSmartBubbleLayout(STAGE, [
      { kind: 'thought', text: '今晚吃几碗白米饭配红烧肉……' },
      { kind: 'dialog', text: '哼，本鱼才没有偷懒！鱼片你再乱叫今晚不给你浇菜了！' },
    ]);
    const rects = layout.ordered.map((i) => i.rect);
    expect(rects).toHaveLength(2);
    assertNoOverlapAndInside(rects, STAGE);
    for (const r of rects) {
      expect(rectsOverlap(r, avatarGuard)).toBe(false);
    }
  });

  it('尾巴解析覆盖 8 向与无尾巴全部分支', () => {
    const anchor = { x: 200, y: 100 };
    expect(resolveTailDirection('status', { x: 100, y: 10, width: 140, height: 28 }, anchor)).toBe('none');
    expect(resolveTailDirection('dialog', { x: 10, y: 10, width: 120, height: 40 }, anchor, 'none')).toBe('none');
    expect(resolveTailDirection('dialog', { x: 10, y: 10, width: 120, height: 40 }, anchor)).toBe('bottom-right');
    expect(resolveTailDirection('dialog', { x: 250, y: 10, width: 120, height: 40 }, anchor)).toBe('bottom-left');
    expect(resolveTailDirection('dialog', { x: 140, y: 10, width: 120, height: 40 }, anchor)).toBe('bottom-center');
    expect(resolveTailDirection('dialog', { x: 10, y: 150, width: 120, height: 40 }, anchor)).toBe('top-right');
    expect(resolveTailDirection('dialog', { x: 250, y: 150, width: 120, height: 40 }, anchor)).toBe('top-left');
    expect(resolveTailDirection('dialog', { x: 140, y: 150, width: 120, height: 40 }, anchor)).toBe('top-center');
    expect(resolveTailDirection('dialog', { x: 240, y: 105, width: 120, height: 40 }, anchor)).toBe('left');
    expect(resolveTailDirection('dialog', { x: 10, y: 105, width: 120, height: 40 }, anchor)).toBe('right');
  });

  it('存在右侧 workCards 与底部饭碗障碍物时自动避让不重叠', () => {
    const occupied: BubbleRect[] = [
      { x: 242, y: 4, width: 156, height: 80 },
      { x: 136, y: 228, width: 128, height: 30 },
    ];
    const layout = computeSmartBubbleLayout(
      STAGE,
      [
        { kind: 'dialog', text: '正在帮鱼片盯紧后台编译任务进度！' },
        { kind: 'hint', text: '干完这活去喝杯海盐气泡水' },
      ],
      { anchor: { facing: 'right' }, occupied },
    );
    const rects = layout.ordered.map((i) => i.rect);
    assertNoOverlapAndInside(rects, STAGE);
    for (const r of rects) {
      expect(rectsOverlap(r, occupied[0]!)).toBe(false);
      expect(rectsOverlap(r, occupied[1]!)).toBe(false);
    }
  });

  it('多气泡并发（3 轨 & 7 轨裁剪）保持优先级裁剪且 0 重叠', () => {
    const threeA = computeSmartBubbleLayout(STAGE, [
      { kind: 'status', text: '星露谷 第1年夏17日 09:20' },
      { kind: 'thought', text: '今天天气真不错呀' },
      { kind: 'dialog', text: '走吧，一起去镇上买些蓝莓种子！' },
    ]);
    expect(threeA.ordered).toHaveLength(3);
    assertNoOverlapAndInside(threeA.ordered.map((i) => i.rect), STAGE);

    const threeB = computeSmartBubbleLayout(STAGE, [
      { kind: 'reaction', text: '哇！被吓了一跳！', mood: 'surprised' },
      { kind: 'notice', text: '大活干完啦，戴上小皇冠！' },
      { kind: 'hint', text: '轻点摸头会很开心哦', mood: 'shy' },
    ]);
    expect(threeB.ordered).toHaveLength(3);
    assertNoOverlapAndInside(threeB.ordered.map((i) => i.rect), STAGE);

    const overflow = computeSmartBubbleLayout(STAGE, [
      { kind: 'status', text: '状态' },
      { kind: 'hint', text: '提示' },
      { kind: 'thought', text: '内心戏' },
      { kind: 'notice', text: '通知' },
      { kind: 'legacy', text: '经典蓝玻' },
      { kind: 'dialog', text: '对话' },
      { kind: 'reaction', text: '反应' },
    ]);
    expect(overflow.ordered).toHaveLength(MAX_VISIBLE_BUBBLES);
    expect(overflow.ordered.map((i) => i.kind)).toEqual(['reaction', 'dialog', 'legacy']);
    assertNoOverlapAndInside(overflow.ordered.map((i) => i.rect), STAGE);
  });

  it('窄舞台、大缩放舞台、极矮舞台（含三气泡水平分栏兜底）全量不重叠且不越界', () => {
    const stages = [
      { width: 240, height: 180 },
      { width: 400, height: 100 },
      { width: 560, height: 364 },
    ];
    for (const box of stages) {
      const triple = computeSmartBubbleLayout(box, [
        { kind: 'status', text: '状态播报条' },
        { kind: 'thought', text: '内心戏思考内容比较长也要自动排列不重叠' },
        { kind: 'dialog', text: '这是正式对话内容，在各种极端窗口比例下都绝对不能重叠或越出舞台！' },
      ]);
      expect(triple.ordered).toHaveLength(3);
      assertNoOverlapAndInside(triple.ordered.map((i) => i.rect), box);
    }

    const tiny = computeSmartBubbleLayout(
      { width: 320, height: 64 },
      [
        { kind: 'reaction', text: '好耶！' },
        { kind: 'dialog', text: '这里是一段比较长的说明文字' },
        { kind: 'thought', text: '另一段内心活动文字' },
      ],
      {
        occupied: [{ x: 0, y: 0, width: 320, height: 64 }],
      },
    );
    expect(tiny.ordered).toHaveLength(3);
    assertNoOverlapAndInside(tiny.ordered.map((i) => i.rect), { width: 320, height: 64 });
  });
});

describe('computeBubbleLayout（兼容双轨不重叠接口）', () => {
  it('常规舞台下双轨几何不重叠、不贴底、均在舞台内', () => {
    const stage = { width: 440, height: 300 };
    const layout = computeBubbleLayout(stage);
    expect(rectsOverlap(layout.thought, layout.dialog)).toBe(false);
    expect(layout.dialog.y + layout.dialog.height).toBeLessThanOrEqual(stage.height - 28);
    assertNoOverlapAndInside([layout.thought, layout.dialog], stage);
  });

  it('窄舞台与极矮舞台均不重叠且不越界', () => {
    for (const box of [{ width: 240, height: 180 }, { width: 400, height: 100 }]) {
      const layout = computeBubbleLayout(box);
      assertNoOverlapAndInside([layout.thought, layout.dialog], box);
    }
  });

  it('rectsOverlap 语义自检（相交/相离与不等高矩形回归）', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 10, width: 10, height: 10 })).toBe(false);

    // 不等高矩形上下分离不得误判重叠
    const topBar = { x: 0, y: 0, width: 100, height: 20 };
    const tallGuard = { x: 0, y: 50, width: 100, height: 150 };
    expect(rectsOverlap(topBar, tallGuard)).toBe(false);
    expect(rectsOverlap(tallGuard, topBar)).toBe(false);

    // 单气泡长文本在 400×260 舞台上宽于 240px 且不撞脸身区
    const singleLong = computeSmartBubbleLayout(
      STAGE,
      [{ kind: 'dialog', text: '今天星露谷春天收获了满满一筐防风草和草莓，鱼片晚上要不要一起吃海鲜炖菜呀！' }],
      { anchor: { xRatio: 0.5, headYRatio: 0.34, facing: 'right' } },
    );
    expect(singleLong.items.dialog!.rect.width).toBeGreaterThan(240);
    assertNoOverlapAndInside([singleLong.items.dialog!.rect], STAGE);
  });
});

describe('cleanBubbleText（<think> 标签渲染层防御清洗）', () => {
  it('thought 轨取 think 块内文；其余 6 种轨一律剥离闭合与未闭合 think 块', () => {
    expect(cleanBubbleText('<think>今晚吃几碗白米饭</think>', 'thought')).toBe('今晚吃几碗白米饭');
    expect(cleanBubbleText('a<think>一</think>b<think>二</think>c', 'thought')).toBe('一 二');
    expect(cleanBubbleText('开头<think>偷偷数', 'thought')).toBe('开头');

    const nonThoughtKinds: BubbleKind[] = ['dialog', 'legacy', 'status', 'notice', 'reaction', 'hint'];
    for (const kind of nonThoughtKinds) {
      expect(cleanBubbleText('<think>想小鱼了</think>哼，本鱼才没有偷懒！', kind)).toBe('哼，本鱼才没有偷懒！');
      expect(cleanBubbleText('开头<think>偷偷数白米饭</think>结尾', kind)).toBe('开头 结尾');
      expect(cleanBubbleText('<think>白米饭真香</think>', kind)).toBe('');
      expect(cleanBubbleText('开头<think>偷偷数', kind)).toBe('开头');
    }
  });

  it('无标签文本原样返回（默认参数回退 dialog）', () => {
    expect(cleanBubbleText('  星露谷 第1年夏17日 06:10  ', 'status')).toBe('星露谷 第1年夏17日 06:10');
    expect(cleanBubbleText('  普通台词  ')).toBe('普通台词');
  });
});
