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
  // 固定在桌宠正下方水平居中（left:50% + translateX(-50%)）
  root.style.cssText = `
    position:absolute; left:50%; transform:translateX(-50%); bottom:6px;
    display:none; align-items:center; gap:6px;
    background:rgba(15,43,76,0.55); border-radius:12px;
    padding:3px 8px; pointer-events:auto; cursor:pointer; font:11px/1.4 monospace; color:#ffe9b8;`;
  root.setAttribute('role', 'button');
  root.setAttribute('aria-label', '赛博饭碗：查看当前余额动画');
  // 零 emoji：内联 SVG 饭碗图标（与主分支原生菜单风格一致）
  const icon = document.createElement('span');
  icon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;color:#ffe9b8;';
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h16a8 8 0 0 1-16 0Z"/><path d="M6 12c0-2.2 2.7-4 6-4s6 1.8 6 4"/><path d="M9 20h6"/></svg>';
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
      icon.style.color = clamped < LOW_RICE_WARNING_RATIO ? '#b8bec8' : '#ffe9b8';
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
