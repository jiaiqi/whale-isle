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
 * 双轨布局策略：云朵泡固定左上（宽 ≤46%），对话泡固定右上头部侧面（宽 ≤46%，
 * 经典对白位，tail 朝左指向角色），垂直带隔离——对话泡顶边强制在云朵泡底缘之下。
 * 对话泡不再贴底：底部居中区域属于饭碗挂件，且贴底最容易与角色身体叠在一起。
 */
export function computeBubbleLayout(stage: StageBox): BubbleLayout {
  const margin = 8;
  const width = Math.min(Math.floor(stage.width * 0.46), 220);
  const thoughtHeight = Math.floor(stage.height * 0.3);
  const dialogHeight = Math.floor(stage.height * 0.26);
  const thought: BubbleRect = { x: margin, y: 6, width, height: thoughtHeight };
  // 隔离带 20px：DOM 侧云朵泡 max-height 有几何保证区 +16 的余量，隔离带必须覆盖该余量才不重叠
  const dialogY = thought.y + thoughtHeight + 20;
  const dialog: BubbleRect = {
    x: stage.width - width - margin,
    y: dialogY,
    width,
    height: Math.min(dialogHeight, stage.height - dialogY - 6),
  };
  return { thought, dialog };
}

export function rectsOverlap(a: BubbleRect, b: BubbleRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
