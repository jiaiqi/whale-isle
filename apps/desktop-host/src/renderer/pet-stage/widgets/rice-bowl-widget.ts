/**
 * 赛博饭碗挂件（T-M1-05；2026-11-22 用户指令改版）：
 *   - 位置从头顶右上挪到**脚下左下**（对话泡贴右下、云朵泡左上，左下无冲突）；
 *   - **默认隐藏**——hover 桌宠时显示，米量低于 15%（persona 饥饿线）时强制亮灯提醒；
 *   - 低于 15% 切换「饿瘪」配色，与 hungry_lazy 状态对齐。
 */

export interface RiceBowlWidget {
  setRatio(ratio: number): void;
  ratio(): number;
  show(): void;
  hide(): void;
  visible(): boolean;
}

export function mountRiceBowlWidget(stage: HTMLElement): RiceBowlWidget {
  const LOW_RICE_WARNING_RATIO = 0.15;
  const root = document.createElement('div');
  root.className = 'pet-widget--rice-bowl';
  // 角色主体水平锚点（T-M6-21）：由当前角色 manifest 的 anchorRatio 写入 CSS 变量；
  // 默认 68.7% = 小鲸真机截图测量值；translateX(-50%) 以角色脚下水平居中
  root.style.cssText = `
    position:absolute; left:var(--pet-anchor-ratio, 68.7%); transform:translateX(-50%); bottom:6px;
    display:none; align-items:center; gap:6px;
    background:rgba(15,43,76,0.55); border-radius:12px;
    padding:3px 8px; pointer-events:none; font:11px/1.4 monospace; color:#ffe9b8;`;
  const emoji = document.createElement('span');
  emoji.textContent = '🍚';
  const bar = document.createElement('div');
  bar.style.cssText = `
    width:64px; height:8px; border-radius:4px; overflow:hidden;
    background:rgba(255,255,255,0.25);`;
  const fill = document.createElement('div');
  fill.style.cssText = `width:100%; height:100%; background:linear-gradient(90deg,#ffd88a,#ffb347); transition:width .4s ease;`;
  bar.appendChild(fill);
  const label = document.createElement('span');
  label.textContent = '100%';
  root.append(emoji, bar, label);
  stage.appendChild(root);

  let current = 1;
  let shown = false;
  const applyVisible = (next: boolean): void => {
    shown = next;
    root.style.display = next ? 'flex' : 'none';
  };
  return {
    setRatio(ratio: number) {
      const clamped = Math.min(Math.max(ratio, 0), 1);
      current = clamped;
      fill.style.width = `${Math.round(clamped * 100)}%`;
      fill.style.background = clamped < LOW_RICE_WARNING_RATIO
        ? 'linear-gradient(90deg,#b0b0b0,#8a8a8a)' // 饿瘪灰
        : 'linear-gradient(90deg,#ffd88a,#ffb347)';
      label.textContent = `${Math.round(clamped * 100)}%`;
      emoji.textContent = clamped < LOW_RICE_WARNING_RATIO ? '🥣' : '🍚';
    },
    ratio() {
      return current;
    },
    show() {
      applyVisible(true);
    },
    hide() {
      applyVisible(false);
    },
    visible() {
      return shown;
    },
  };
}
