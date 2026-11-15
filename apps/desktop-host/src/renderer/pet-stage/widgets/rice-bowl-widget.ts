/**
 * 赛博饭碗挂件（T-M1-05）：右上角 🍚 + 余量进度条；
 * 低于 15%（persona-brain 饥饿线）切换"饿瘪"配色，与 hungry_lazy 状态对齐。
 */

export interface RiceBowlWidget {
  setRatio(ratio: number): void;
  ratio(): number;
}

export function mountRiceBowlWidget(stage: HTMLElement): RiceBowlWidget {
  const LOW_RICE_WARNING_RATIO = 0.15;
  const root = document.createElement('div');
  root.className = 'pet-widget--rice-bowl';
  root.style.cssText = `
    position:absolute; right:6px; top:4px;
    display:flex; align-items:center; gap:6px;
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
  };
}
