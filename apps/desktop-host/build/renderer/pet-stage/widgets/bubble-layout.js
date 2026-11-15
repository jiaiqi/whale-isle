/**
 * 双轨气泡布局纯函数（T-M1-05）：不重叠的几何保证（单测覆盖）。
 * DOM 渲染见 ./bubbles.ts（由 E2E 真实 Electron 覆盖）。
 */
/**
 * 双轨布局策略：云朵泡固定左上（宽 ≤46%），对话泡贴右下（宽 ≤46%），
 * 垂直带隔离——对话泡顶边强制在云朵泡底缘之下。
 */
export function computeBubbleLayout(stage) {
    const margin = 8;
    const width = Math.min(Math.floor(stage.width * 0.46), 220);
    const thoughtHeight = Math.floor(stage.height * 0.3);
    const dialogHeight = Math.floor(stage.height * 0.26);
    const thought = { x: margin, y: 6, width, height: thoughtHeight };
    const dialogY = Math.max(thought.y + thoughtHeight + 8, stage.height - dialogHeight - 12);
    const dialog = {
        x: stage.width - width - margin,
        y: dialogY,
        width,
        height: Math.min(dialogHeight, stage.height - dialogY - 6),
    };
    return { thought, dialog };
}
export function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
//# sourceMappingURL=bubble-layout.js.map