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
  setStageBox(box: StageBox): void; // T-M6-20 缩放后重排双轨气泡
  showThought(text: string): void;
  showDialog(text: string): void;
  hideThought(): void;
  hideDialog(): void;
  rects(): { thought: BubbleRect; dialog: BubbleRect };
}

/** 舞台挂载双轨气泡（样式：云朵半透明 / 对话泡带尾巴；均不拦截穿透语义外的点击） */
export function mountBubbleWidgets(stage: HTMLElement, stageBox: StageBox): BubbleWidgets {
  let box = stageBox;
  let layout = computeBubbleLayout(box);

  const thought = document.createElement('div');
  thought.className = 'pet-bubble pet-bubble--thought';
  thought.style.cssText = `
    position:absolute; left:${layout.thought.x}px; top:${layout.thought.y}px;
    width:${layout.thought.width}px; max-height:${layout.thought.height + 16}px;
    display:none; overflow:hidden;
    background:linear-gradient(135deg, rgba(191,90,242,0.30), rgba(120,60,160,0.24));
    backdrop-filter:blur(6px);
    border:1.5px dashed rgba(216,170,255,0.75); border-radius:18px 18px 22px 10px;
    font:12px/1.55 "PingFang SC",system-ui,sans-serif; color:#f0e2ff;
    padding:8px 10px; box-sizing:border-box; pointer-events:none;
    text-shadow:0 1px 2px rgba(60,20,90,0.5);
    box-shadow:0 4px 16px rgba(0,0,0,0.35);`;
  const cloudDot = document.createElement('div');
  cloudDot.style.cssText = `
    position:absolute; left:26px; bottom:-12px; width:14px; height:14px; border-radius:50%;
    background:rgba(191,90,242,0.12); border:1.5px dashed rgba(191,90,242,0.4); pointer-events:none; display:none;`;
  thought.appendChild(cloudDot);
  stage.appendChild(thought);

  const dialog = document.createElement('div');
  dialog.className = 'pet-bubble pet-bubble--dialog';
  dialog.style.cssText = `
    position:absolute; left:${layout.dialog.x}px; bottom:12px;
    width:${Math.round(stageBox.width * 0.42)}px; max-height:${Math.max(72, stageBox.height - layout.thought.y - layout.thought.height - 24)}px;
    display:none; overflow:hidden;
    background:rgba(20,20,24,0.74);
    backdrop-filter:blur(14px) saturate(1.5);
    border:1.5px solid rgba(10,132,255,0.55); border-radius:16px;
    font:13px/1.55 "PingFang SC",system-ui,sans-serif; color:#f5f5f7;
    padding:9px 12px; box-sizing:border-box; pointer-events:none;
    box-shadow:0 8px 28px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08);`;
  // 对话泡尾巴（伪三角）
  const tail = document.createElement('div');
  tail.style.cssText = `
    position:absolute; left:22px; bottom:-8px;
    border-left:8px solid transparent; border-right:8px solid transparent;
    border-top:9px solid rgba(10,132,255,0.55);`;
  dialog.appendChild(tail);
  stage.appendChild(dialog);

  const setBubbleText = (el: HTMLElement, text: string) => {
    const body = document.createElement('span');
    body.textContent = text;
    el.replaceChildren(...(el === dialog ? [tail, body] : [cloudDot, body]));
    el.style.display = 'block';
    cloudDot.style.display = el === thought ? 'block' : 'none';
  };

  return {
    /** T-M6-20 缩放：舞台尺寸变化后重排气泡（保持双轨不重叠的几何保证） */
    setStageBox(next: StageBox) {
      box = next;
      layout = computeBubbleLayout(next);
      thought.style.left = `${layout.thought.x}px`;
      thought.style.top = `${layout.thought.y}px`;
      thought.style.width = `${layout.thought.width}px`;
      thought.style.maxHeight = `${layout.thought.height + 16}px`;
      dialog.style.left = `${layout.dialog.x}px`;
      dialog.style.width = `${Math.round(box.width * 0.42)}px`;
      dialog.style.maxHeight = `${Math.max(72, box.height - layout.thought.y - layout.thought.height - 24)}px`;
    },
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
