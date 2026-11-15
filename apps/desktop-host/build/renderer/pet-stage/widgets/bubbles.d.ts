/**
 * 双轨气泡挂件（T-M1-05，dsh-pet 概念）：
 *   轨 1 — <think> 云朵半透明气泡（左上，内心戏流式渲染）
 *   轨 2 — 正式对话气泡（右下，带尾巴）
 * 不重叠由 computeBubbleLayout 纯函数保证（./bubble-layout，单测）+ E2E 几何断言双保险。
 */
import { type BubbleRect, type StageBox } from './bubble-layout';
export { computeBubbleLayout, rectsOverlap, type BubbleLayout, type BubbleRect, type StageBox } from './bubble-layout';
export interface BubbleWidgets {
    showThought(text: string): void;
    showDialog(text: string): void;
    hideThought(): void;
    hideDialog(): void;
    rects(): {
        thought: BubbleRect;
        dialog: BubbleRect;
    };
}
/** 舞台挂载双轨气泡（样式：云朵半透明 / 对话泡带尾巴；均不拦截穿透语义外的点击） */
export declare function mountBubbleWidgets(stage: HTMLElement, stageBox: StageBox): BubbleWidgets;
//# sourceMappingURL=bubbles.d.ts.map