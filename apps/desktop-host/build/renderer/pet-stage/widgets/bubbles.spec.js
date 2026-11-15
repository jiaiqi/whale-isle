import { describe, expect, it } from 'vitest';
import { computeBubbleLayout, rectsOverlap } from './bubble-layout';
/** T-M1-05：双轨气泡布局纯函数（不重叠的几何保证） */
const STAGE = { width: 440, height: 300 };
describe('computeBubbleLayout（双轨不重叠）', () => {
    it('常规舞台：云朵泡左上、对话泡右下，两轨几何不重叠', () => {
        const layout = computeBubbleLayout(STAGE);
        expect(rectsOverlap(layout.thought, layout.dialog)).toBe(false);
        expect(layout.thought.x).toBe(8);
        expect(layout.thought.y).toBe(6);
        // 对话泡顶边严格在云朵泡底缘之下（垂直隔离带）
        expect(layout.dialog.y).toBeGreaterThanOrEqual(layout.thought.y + layout.thought.height + 8);
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
//# sourceMappingURL=bubbles.spec.js.map