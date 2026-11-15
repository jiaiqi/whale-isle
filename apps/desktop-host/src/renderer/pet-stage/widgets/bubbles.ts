/**
 * 双轨气泡挂件（T-M1-05，dsh-pet 概念）：
 *   轨 1 — <think> 云朵半透明气泡（左上，内心戏流式渲染）
 *   轨 2 — 正式对话气泡（右下，带尾巴）
 * 不重叠由 computeBubbleLayout 纯函数保证（./bubble-layout，单测）+ E2E 几何断言双保险。
 */
import {
  computeBubbleLayout,
  type BubbleLayout,
  type BubbleRect,
  type StageBox,
} from './bubble-layout';

export { computeBubbleLayout, rectsOverlap, type BubbleLayout, type BubbleRect, type StageBox } from './bubble-layout';
export interface BubbleWidgets {
  showThought(text: string): void;
  showDialog(text: string): void;
  hideThought(): void;
  hideDialog(): void;
  rects(): { thought: BubbleRect; dialog: BubbleRect };
}

/** 舞台挂载双轨气泡（样式：云朵半透明 / 对话泡带尾巴；均不拦截穿透语义外的点击） */
export function mountBubbleWidgets(stage: HTMLElement, stageBox: StageBox): BubbleWidgets {
  const layout = computeBubbleLayout(stageBox);

  const thought = document.createElement('div');
  thought.className = 'pet-bubble pet-bubble--thought';
  thought.style.cssText = `
    position:absolute; left:${layout.thought.x}px; top:${layout.thought.y}px;
    width:${layout.thought.width}px; height:${layout.thought.height}px;
    display:none; overflow:hidden;
    background:rgba(190,225,255,0.5); backdrop-filter:blur(2px);
    border:1px solid rgba(255,255,255,0.6); border-radius:18px 18px 22px 10px;
    font:12px/1.5 "PingFang SC",system-ui,sans-serif; color:#1c3a5e;
    padding:8px 10px; box-sizing:border-box; pointer-events:none;`;
  stage.appendChild(thought);

  const dialog = document.createElement('div');
  dialog.className = 'pet-bubble pet-bubble--dialog';
  dialog.style.cssText = `
    position:absolute; left:${layout.dialog.x}px; top:${layout.dialog.y}px;
    width:${layout.dialog.width}px; height:${layout.dialog.height}px;
    display:none; overflow:hidden;
    background:rgba(255,255,255,0.92);
    border:1.5px solid rgba(80,150,220,0.8); border-radius:14px;
    font:13px/1.5 "PingFang SC",system-ui,sans-serif; color:#0f2b4c;
    padding:9px 12px; box-sizing:border-box; pointer-events:none;`;
  // 对话泡尾巴（伪三角）
  const tail = document.createElement('div');
  tail.style.cssText = `
    position:absolute; left:22px; bottom:-8px;
    border-left:8px solid transparent; border-right:8px solid transparent;
    border-top:9px solid rgba(80,150,220,0.8);`;
  dialog.appendChild(tail);
  stage.appendChild(dialog);

  const setBubbleText = (el: HTMLElement, text: string) => {
    const body = document.createElement('span');
    body.textContent = text;
    el.replaceChildren(...(el === dialog ? [tail, body] : [body]));
    el.style.display = 'block';
  };

  return {
    showThought(text: string) {
      setBubbleText(thought, text);
    },
    showDialog(text: string) {
      setBubbleText(dialog, text);
    },
    hideThought() {
      thought.style.display = 'none';
    },
    hideDialog() {
      dialog.style.display = 'none';
    },
    rects() {
      return {
        thought: { ...layout.thought },
        dialog: { ...layout.dialog },
      };
    },
  };
}
