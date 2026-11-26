/**
 * 双轨气泡挂件（T-M1-05，dsh-pet 概念）：
 *   轨 1 — <think> 云朵气泡（左上，内心戏流式渲染，深紫底保证明暗桌面都可读）
 *   轨 2 — 正式对话气泡（右上头部侧面，带朝左尾巴；不贴底以避开角色与饭碗挂件）
 * 不重叠由 computeBubbleLayout 纯函数保证（./bubble-layout，单测）+ E2E 几何断言双保险。
 * z-index:7 在角色视频之上（视频交叉淡入会重挂载 DOM，无 z-index 会被新视频压盖住）、
 * 在 workCards(z8)/guide(z9) 之下。
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
  setDialogMuted(muted: boolean): void;
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
    display:none; overflow:hidden; z-index:7;
    background:linear-gradient(135deg, rgba(96,44,150,0.68), rgba(56,24,96,0.62));
    backdrop-filter:blur(6px);
    border:1.5px dashed rgba(216,170,255,0.85); border-radius:18px 18px 22px 10px;
    font-family:"ShangShouGummy","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    font-size:calc(12px * var(--pet-bubble-font-scale, 1)); line-height:1.55; color:#f8f1ff;
    padding:8px 10px; box-sizing:border-box; pointer-events:none;
    text-shadow:0 1px 3px rgba(28,8,52,0.85);
    box-shadow:0 4px 16px rgba(0,0,0,0.35);`;
  const cloudDot = document.createElement('div');
  cloudDot.style.cssText = `
    position:absolute; left:26px; bottom:-12px; width:14px; height:14px; border-radius:50%;
    background:rgba(96,44,150,0.35); border:1.5px dashed rgba(170,120,220,0.55); pointer-events:none; display:none;`;
  thought.appendChild(cloudDot);
  stage.appendChild(thought);

  const dialog = document.createElement('div');
  dialog.className = 'pet-bubble pet-bubble--dialog';
  dialog.style.cssText = `
    position:absolute; left:${layout.dialog.x}px; top:${layout.dialog.y}px;
    width:${layout.dialog.width}px; max-height:${Math.max(72, stageBox.height - layout.dialog.y - 12)}px;
    display:none; overflow:hidden; z-index:7;
    background:rgba(20,20,24,0.82);
    backdrop-filter:blur(14px) saturate(1.5);
    border:1.5px solid rgba(10,132,255,0.55); border-radius:16px;
    font-family:"ShangShouGummy","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    font-size:calc(13px * var(--pet-bubble-font-scale, 1)); line-height:1.55; color:#f5f5f7;
    padding:9px 12px; box-sizing:border-box; pointer-events:none;
    box-shadow:0 8px 28px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08);`;
  // 对话泡尾巴（伪三角，左边缘朝左指向角色头部——对白泡位于角色右上侧）
  const tail = document.createElement('div');
  tail.style.cssText = `
    position:absolute; left:-9px; bottom:20px;
    border-top:8px solid transparent; border-bottom:8px solid transparent;
    border-right:9px solid rgba(10,132,255,0.55);`;
  const mutedBadge = document.createElement('span');
  mutedBadge.className = 'pet-bubble-muted';
  mutedBadge.textContent = '静音';
  mutedBadge.style.cssText = 'position:absolute;right:7px;bottom:5px;font:9px/1 monospace;color:#ffd48a;opacity:.9;display:none;';
  dialog.appendChild(tail);
  dialog.appendChild(mutedBadge);
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
      dialog.style.top = `${layout.dialog.y}px`;
      dialog.style.width = `${layout.dialog.width}px`;
      dialog.style.maxHeight = `${Math.max(72, box.height - layout.dialog.y - 12)}px`;
    },
    showThought(text: string) {
      setBubbleText(thought, text);
    },
    showDialog(text: string) {
      setBubbleText(dialog, text);
      dialog.appendChild(mutedBadge);
    },
    hideThought() {
      thought.style.display = 'none';
    },
    hideDialog() {
      dialog.style.display = 'none';
      mutedBadge.style.display = 'none';
    },
    setDialogMuted(muted: boolean) {
      mutedBadge.style.display = muted ? 'block' : 'none';
    },
    rects() {
      return {
        thought: { ...layout.thought },
        dialog: { ...layout.dialog },
      };
    },
  };
}
