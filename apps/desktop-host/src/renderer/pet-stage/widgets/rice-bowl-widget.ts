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
  /** T-M6-63：点击饭碗挂件 → 播放当前余额档位动画 */
  onClick(handler: () => void): void;
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
    padding:3px 8px; pointer-events:auto; cursor:pointer; font:11px/1.4 monospace; color:#ffe9b8;`;
  root.setAttribute('role', 'button');
  root.setAttribute('aria-label', '赛博饭碗：查看当前余额动画');
  // 零 emoji：内联 SVG 饭碗图标（碗沿 + 米粒 + 底座）
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '14');
  icon.setAttribute('height', '14');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', '#ffe9b8');
  icon.setAttribute('stroke-width', '1.7');
  icon.setAttribute('stroke-linecap', 'round');
  icon.innerHTML = '<path d="M3.5 11h17a8.5 8.5 0 0 1-17 0Z"/><path d="M7.5 11c0-2.2 1.8-3.6 4.5-3.6s4.5 1.4 4.5 3.6"/><path d="M5 20h14"/><circle cx="9" cy="8" r="0.6" fill="#ffe9b8"/><circle cx="13" cy="6.6" r="0.6" fill="#ffe9b8"/>';
  const bar = document.createElement('div');
  bar.style.cssText = `
    width:64px; height:8px; border-radius:4px; overflow:hidden;
    background:rgba(255,255,255,0.25);`;
  const fill = document.createElement('div');
  fill.style.cssText = `width:100%; height:100%; background:linear-gradient(90deg,#ffd88a,#ffb347); transition:width .4s ease;`;
  bar.appendChild(fill);
  const label = document.createElement('span');
  label.textContent = '100%';
  root.append(icon, bar, label);
  stage.appendChild(root);

  let current = 1;
  let shown = false;
  let clickHandler: (() => void) | null = null;
  root.addEventListener('click', (event) => {
    event.stopPropagation();
    clickHandler?.();
  });
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
      // 饿态图标降饱和；不切 emoji、不换文案
      icon.setAttribute('stroke', clamped < LOW_RICE_WARNING_RATIO ? '#b9b9b9' : '#ffe9b8');
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
    onClick(handler: () => void) {
      clickHandler = handler;
    },
  };
}
