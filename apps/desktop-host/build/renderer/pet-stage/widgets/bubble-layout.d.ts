/**
 * 双轨气泡布局纯函数（T-M1-05）：不重叠的几何保证（单测覆盖）。
 * DOM 渲染见 ./bubbles.ts（由 E2E 真实 Electron 覆盖）。
 */
export interface StageBox {
    width: number;
    height: number;
}
export interface BubbleRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface BubbleLayout {
    thought: BubbleRect;
    dialog: BubbleRect;
}
/**
 * 双轨布局策略：云朵泡固定左上（宽 ≤46%），对话泡贴右下（宽 ≤46%），
 * 垂直带隔离——对话泡顶边强制在云朵泡底缘之下。
 */
export declare function computeBubbleLayout(stage: StageBox): BubbleLayout;
export declare function rectsOverlap(a: BubbleRect, b: BubbleRect): boolean;
//# sourceMappingURL=bubble-layout.d.ts.map