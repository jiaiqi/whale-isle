/**
 * 中控台 macOS 自绘窗口顶栏（40px，owner 2026-11-26 反馈）。
 *
 * 背景/边框/文字全部走 Tidepaper 设计令牌（`--bg` / `--stroke` / `--text-1`），
 * 明暗主题与三套皮肤都随 `:root` 变量自动切换，不再出现系统黑条。
 * 左侧 80px 是红绿灯安全区：主进程 `trafficLightPosition: { x: 18, y: 14 }` 让灯组
 * 圆心落在 40px 中线、右缘约 74px，渲染层不画任何假按钮。
 *
 * 交互全部交给系统：整条顶栏 `-webkit-app-region: drag`（见 design-tokens.css），
 * 拖动移动窗口、双击触发 macOS 原生缩放（不是最大化），都不需要额外 IPC。
 * 顶栏里只有静态品牌信息，因此没有 `no-drag` 子元素；将来若要放按钮/链接/输入，
 * 必须显式加 `-webkit-app-region: no-drag`，否则点击会被拖拽区吞掉。
 */
import { APP_NAME, APP_TAGLINE } from '../../../shared/brand';
import { BrandMark } from './sidebar';

/**
 * 是否由渲染层自绘窗口顶栏：只有 macOS 走 `titleBarStyle: 'hiddenInset'`
 * （判断在主进程 createDirectorWindow，只有 darwin 分支）。Windows/Linux 保留原生边框，
 * 这里就不再叠一条 40px 空条。该判定只影响布局，不参与权限/安全决策，因此不新增 IPC。
 */
export function usesCustomTitleBar(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Electron 渲染进程里 navigator.platform = 'MacIntel'，UA 同时含 'Macintosh'；
  // 取两者任一命中即可，避免个别 Chromium 版本弃用 platform 后失效。
  return /mac/i.test(navigator.platform || navigator.userAgent);
}

export function TitleBar(): React.JSX.Element {
  return (
    <header className="wb-titlebar" data-wb-titlebar aria-label="窗口栏">
      <span className="wb-titlebar-brand" title={APP_TAGLINE}>
        <BrandMark />
        <span className="t">
          {APP_NAME}
          <small>Whale Isle · V2</small>
        </span>
      </span>
      <span className="sp" />
      {/* 窗口级标识，与下方顶栏的「组名 / 页面名」面包屑不重复 */}
      <span className="wb-titlebar-window">桌面中控台</span>
    </header>
  );
}
