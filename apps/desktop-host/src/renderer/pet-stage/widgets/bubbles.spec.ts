import { describe, expect, it } from 'vitest';
import { computeBubbleLayout, rectsOverlap } from './bubble-layout';
import { cleanBubbleText } from './bubble-text';

/** T-M1-05：双轨气泡布局纯函数（不重叠的几何保证） */

const STAGE = { width: 440, height: 300 };

describe('computeBubbleLayout（双轨不重叠）', () => {
  it('常规舞台：云朵泡左上、对话泡右上头部侧面，两轨几何不重叠', () => {
    const layout = computeBubbleLayout(STAGE);
    expect(rectsOverlap(layout.thought, layout.dialog)).toBe(false);
    expect(layout.thought.x).toBe(8);
    expect(layout.thought.y).toBe(6);
    // 对话泡顶边在云朵泡几何保证区底缘 +20px 隔离带之下
    // （DOM 侧云朵泡 max-height 有 +16 余量，隔离带必须覆盖）
    expect(layout.dialog.y).toBeGreaterThanOrEqual(layout.thought.y + layout.thought.height + 20);
    // 对话泡不再贴底：底部区域留给饭碗挂件与角色站位
    expect(layout.dialog.y + layout.dialog.height).toBeLessThan(STAGE.height - 12);
    // 两者都在舞台内
    expect(layout.dialog.x + layout.dialog.width).toBeLessThanOrEqual(STAGE.width);
    expect(layout.dialog.y + layout.dialog.height).toBeLessThanOrEqual(STAGE.height);
  });

  it('窄舞台（多屏异构缩放）仍不重叠', () => {
    const layout = computeBubbleLayout({ width: 240, height: 180 });
    expect(rectsOverlap(layout.thought, layout.dialog)).toBe(false);
  });

  it('极矮舞台：对话泡高度被舞台裁剪且不越界', () => {
    const layout = computeBubbleLayout({ width: 400, height: 100 });
    expect(rectsOverlap(layout.thought, layout.dialog)).toBe(false);
    expect(layout.dialog.height).toBeGreaterThan(0);
    expect(layout.dialog.y + layout.dialog.height).toBeLessThanOrEqual(100);
  });

  it('rectsOverlap 语义自检（相交/相离样例）', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 10, width: 10, height: 10 })).toBe(false);
  });
});

describe('cleanBubbleText（<think> 标签渲染层防御清洗）', () => {
  it('dialog 轨：剥掉 think 块只留可见文本，标签符号绝不显示', () => {
    expect(cleanBubbleText('<think>想小鱼了</think>哼，本鱼才没有偷懒！', 'dialog')).toBe('哼，本鱼才没有偷懒！');
    expect(cleanBubbleText('开头<think>偷偷数白米饭</think>结尾', 'dialog')).toBe('开头 结尾');
    expect(cleanBubbleText('<think>白米饭真香</think>', 'dialog')).toBe(''); // 纯内心戏不进对话泡
  });

  it('thought 轨：有 think 块取标签内内容，多块拼接', () => {
    expect(cleanBubbleText('<think>今晚吃几碗白米饭</think>', 'thought')).toBe('今晚吃几碗白米饭');
    expect(cleanBubbleText('a<think>一</think>b<think>二</think>c', 'thought')).toBe('一 二');
  });

  it('流式半截未闭合 think 块也吃掉标签符号', () => {
    expect(cleanBubbleText('开头<think>偷偷数', 'dialog')).toBe('开头');
    expect(cleanBubbleText('开头<think>偷偷数', 'thought')).toBe('开头'); // 未闭合块无完整内心，回退可见部分
  });

  it('无标签文本原样返回（快慢路径一致）', () => {
    expect(cleanBubbleText('  星露谷 第1年夏17日 06:10  ', 'thought')).toBe('星露谷 第1年夏17日 06:10');
    expect(cleanBubbleText('普通台词', 'dialog')).toBe('普通台词');
  });
});
