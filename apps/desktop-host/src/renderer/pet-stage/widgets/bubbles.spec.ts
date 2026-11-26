import { describe, expect, it } from 'vitest';
import {
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
  type BubbleKind,
  type BubbleRect,
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

describe('bubble-types（语义视觉令牌与自适应尺寸）', () => {
  it('6 种气泡均具备独立高对比视觉令牌且无彩色 Emoji', () => {
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
    expect(priorities.size).toBe(6);
  });

  it('单气泡突破旧 220px 狭窄上限，窄舞台自动安全夹紧', () => {
    const single = estimateBubbleSize({
      kind: 'dialog',
      text: '今天星露谷春天收获了满满一筐防风草和草莓，鱼片晚上想不想一起吃海鲜饭呀！',
      stage: STAGE,
      activeCount: 1,
    });
    expect(single.width).toBeGreaterThan(240);
    expect(single.width).toBeLessThanOrEqual(304);

    const shortText = estimateBubbleSize({ kind: 'reaction', text: '哼！', stage: STAGE, activeCount: 1 });
    expect(shortText.width).toBeLessThan(150);

    const tinyBudget = bubbleWidthBudget('dialog', 96, 1);
    expect(tinyBudget.minWidth).toBeLessThanOrEqual(tinyBudget.maxWidth);
    expect(tinyBudget.maxWidth).toBeGreaterThanOrEqual(48);

    const threeBudget = bubbleWidthBudget('status', 400, 3);
    expect(threeBudget.maxWidth).toBeLessThanOrEqual(220);
  });
});

describe('computeSmartBubbleLayout（智能定位 + 不重叠）', () => {
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
        { kind: 'thought', text: '要不要先去海边钓一条比目鱼呢' },
        { kind: 'dialog', text: '鱼片看好了，这杆肯定能钓到大货！' },
      ],
      { anchor: { xRatio: 0.5, headYRatio: 0.34, facing: 'right' } },
    );
    const leftLayout = computeSmartBubbleLayout(
      STAGE,
      [
        { kind: 'thought', text: '要不要先去海边钓一条比目鱼呢' },
        { kind: 'dialog', text: '鱼片看好了，这杆肯定能钓到大货！' },
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

  it('尾巴解析覆盖顶左/顶右/顶中/左右侧/无尾巴全部分支', () => {
    const anchor = { x: 200, y: 100 };
    expect(resolveTailDirection('status', { x: 100, y: 10, width: 140, height: 28 }, anchor)).toBe('none');
    expect(resolveTailDirection('dialog', { x: 10, y: 10, width: 120, height: 40 }, anchor)).toBe('bottom-right');
    expect(resolveTailDirection('dialog', { x: 250, y: 10, width: 120, height: 40 }, anchor)).toBe('bottom-left');
    expect(resolveTailDirection('dialog', { x: 140, y: 10, width: 120, height: 40 }, anchor)).toBe('bottom-center');
    expect(resolveTailDirection('dialog', { x: 240, y: 130, width: 120, height: 40 }, anchor)).toBe('left');
    expect(resolveTailDirection('dialog', { x: 10, y: 130, width: 120, height: 40 }, anchor)).toBe('right');
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

  it('多气泡并发（3 轨 & 6 轨裁剪）保持优先级裁剪且 0 重叠', () => {
    const threeA = computeSmartBubbleLayout(STAGE, [
      { kind: 'status', text: '星露谷 第1年夏17日 09:20' },
      { kind: 'thought', text: '今天天气真不错呀' },
      { kind: 'dialog', text: '走吧，一起去镇上买些蓝莓种子！' },
    ]);
    expect(threeA.ordered).toHaveLength(3);
    assertNoOverlapAndInside(threeA.ordered.map((i) => i.rect), STAGE);

    const threeB = computeSmartBubbleLayout(STAGE, [
      { kind: 'reaction', text: '哇！被吓了一跳！' },
      { kind: 'notice', text: '大活干完啦，戴上小皇冠！' },
      { kind: 'hint', text: '轻点摸头会很开心哦' },
    ]);
    expect(threeB.ordered).toHaveLength(3);
    assertNoOverlapAndInside(threeB.ordered.map((i) => i.rect), STAGE);

    const overflow = computeSmartBubbleLayout(STAGE, [
      { kind: 'status', text: '状态' },
      { kind: 'hint', text: '提示' },
      { kind: 'thought', text: '内心戏' },
      { kind: 'notice', text: '通知' },
      { kind: 'dialog', text: '对话' },
      { kind: 'reaction', text: '反应' },
    ]);
    expect(overflow.ordered).toHaveLength(MAX_VISIBLE_BUBBLES);
    expect(overflow.ordered.map((i) => i.kind)).toEqual(['reaction', 'dialog', 'notice']);
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

    // 占满障碍物且极限矮舞台强制走水平分栏兜底路径
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

  it('rectsOverlap 语义自检（相交/相离样例）', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 10, width: 10, height: 10 })).toBe(false);
  });
});

describe('cleanBubbleText（<think> 标签渲染层防御清洗）', () => {
  it('thought 轨取 think 块内文；其余 5 种轨一律剥离闭合与未闭合 think 块', () => {
    expect(cleanBubbleText('<think>今晚吃几碗白米饭</think>', 'thought')).toBe('今晚吃几碗白米饭');
    expect(cleanBubbleText('a<think>一</think>b<think>二</think>c', 'thought')).toBe('一 二');
    expect(cleanBubbleText('开头<think>偷偷数', 'thought')).toBe('开头');

    const nonThoughtKinds: BubbleKind[] = ['dialog', 'status', 'notice', 'reaction', 'hint'];
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
