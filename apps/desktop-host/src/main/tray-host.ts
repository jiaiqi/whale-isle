/**
 * macOS / Windows 11 状态栏（托盘）常驻图标 + Magpie 风格快捷浮窗（T-M6-60）。
 *
 * 设计边界：
 *   - 几何/防抖/图标选择全部是纯函数，Node 单测不需要启动 Electron；
 *   - Electron 运行时按需 `import('electron')`，避免把 Tray/BrowserWindow 拖进单测环境；
 *   - 浮窗只做「快捷入口」，所有业务动作仍走既有 IPC（chat/autodrive/rice/voice/work-follow）。
 *
 * 平台差异：
 *   - macOS：18×18 Template 图标（Electron 自动合并 @2x），菜单栏顶部托盘 → 浮窗贴下方 6px；
 *   - Windows 11：32×32 深/浅两套图标，跟随 nativeTheme 实时切换；任务栏在底部 → 浮窗贴上方 8px；
 *     图标被折叠进 ^ 溢出区时 tray.getBounds() 返回全 0，回退到光标所在屏右下角，绝不弹到 (0,0)。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BrowserWindow,
  NativeImage,
  Point,
  Rectangle,
  Tray,
  WebContents,
} from 'electron';

export interface PopoverSize {
  width: number;
  height: number;
}

export const POPOVER_SIZE: PopoverSize = { width: 360, height: 500 };

/** 浮窗与托盘/任务栏之间的视觉间距（macOS 6px，Windows 8px）。 */
export const POPOVER_GAP = { darwin: 6, win32: 8, other: 8 } as const;

/** 托盘点击与失焦隐藏之间的防闪关窗口。 */
export const POPOVER_BLUR_GUARD_MS = 250;

export type PopoverEdge = 'top' | 'bottom' | 'left' | 'right';

export interface ComputePopoverBoundsInput {
  trayBounds: Rectangle;
  cursorPoint: Point;
  /** 浮窗目标显示器的工作区（DIP，已扣除菜单栏/任务栏）；溢出区回退时必须是光标所在屏。 */
  workArea: Rectangle;
  /** 该显示器的完整 bounds（用于判断托盘贴哪条边）。 */
  displayBounds: Rectangle;
  popoverSize: PopoverSize;
  platform: NodeJS.Platform;
}

function clampAxis(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** 距离托盘中心最近的显示器边缘 = 任务栏/菜单栏方位。 */
export function resolvePopoverEdge(trayBounds: Rectangle, displayBounds: Rectangle): PopoverEdge {
  const centerX = trayBounds.x + trayBounds.width / 2;
  const centerY = trayBounds.y + trayBounds.height / 2;
  const distances: Array<[PopoverEdge, number]> = [
    ['top', Math.abs(centerY - displayBounds.y)],
    ['bottom', Math.abs(displayBounds.y + displayBounds.height - centerY)],
    ['left', Math.abs(centerX - displayBounds.x)],
    ['right', Math.abs(displayBounds.x + displayBounds.width - centerX)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0]![0];
}

/** 托盘 bounds 是否不可用（Windows 11 图标折叠进 ^ 溢出区时全 0）。 */
export function isTrayBoundsUnavailable(trayBounds: Rectangle): boolean {
  return trayBounds.width <= 0 || trayBounds.height <= 0;
}

/**
 * 跨平台智能锚点：托盘可用时贴任务栏内侧，溢出区回退到工作区右下角（留 8px）。
 * 最终坐标严格夹紧在 workArea 内，兼容多屏负坐标与 Windows 125%/150%/200% DPI。
 */
export function computePopoverBounds(input: ComputePopoverBoundsInput): Rectangle {
  const { trayBounds, workArea, displayBounds, popoverSize } = input;
  const width = Math.max(1, Math.round(popoverSize.width));
  const height = Math.max(1, Math.round(popoverSize.height));
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  if (isTrayBoundsUnavailable(trayBounds)) {
    const margin = 8;
    return {
      x: Math.round(clampAxis(workArea.x + workArea.width - width - margin, workArea.x, maxX)),
      y: Math.round(clampAxis(workArea.y + workArea.height - height - margin, workArea.y, maxY)),
      width,
      height,
    };
  }

  const centerX = trayBounds.x + trayBounds.width / 2;
  const centerY = trayBounds.y + trayBounds.height / 2;
  const edge = resolvePopoverEdge(trayBounds, displayBounds);
  const gap = POPOVER_GAP[input.platform === 'darwin' ? 'darwin' : input.platform === 'win32' ? 'win32' : 'other'];

  let x = centerX - width / 2;
  let y = centerY - height / 2;
  switch (edge) {
    case 'top':
      y = trayBounds.y + trayBounds.height + gap;
      break;
    case 'bottom':
      y = trayBounds.y - height - gap;
      break;
    case 'left':
      x = trayBounds.x + trayBounds.width + gap;
      break;
    case 'right':
      x = trayBounds.x - width - gap;
      break;
  }

  return {
    x: Math.round(clampAxis(x, workArea.x, maxX)),
    y: Math.round(clampAxis(y, workArea.y, maxY)),
    width,
    height,
  };
}

export type TrayClickAction = 'show' | 'hide' | 'ignore';

export interface PopoverToggleGuard {
  /** 记下因失焦/主动关闭而隐藏的时刻（毫秒）。 */
  markHidden(now: number): void;
  /** 托盘点击意图：刚失焦隐藏的 250ms 内忽略，避免「关掉又被同一次点击重开」。 */
  onTrayClick(now: number, visible: boolean): TrayClickAction;
}

export function createPopoverToggleGuard(guardMs = POPOVER_BLUR_GUARD_MS): PopoverToggleGuard {
  let lastHiddenAt: number | null = null;
  return {
    markHidden(now: number): void {
      lastHiddenAt = now;
    },
    onTrayClick(now: number, visible: boolean): TrayClickAction {
      if (visible) return 'hide';
      if (lastHiddenAt !== null && now - lastHiddenAt < guardMs) return 'ignore';
      return 'show';
    },
  };
}

/**
 * 托盘图标选择：
 *   - macOS 只用 Template 文件，Electron 会自动找同名 `@2x`；
 *   - Windows 深色系统（深色任务栏）用浅色图标，浅色系统用深色图标；
 *   - Linux 暂无真机验收项，跟随 Windows 规则取可用的一套。
 */
export function trayIconFilenames(platform: NodeJS.Platform, darkColors: boolean): { primary: string; highDpi?: string } {
  if (platform === 'darwin') {
    return { primary: 'trayTemplate.png', highDpi: 'trayTemplate@2x.png' };
  }
  return { primary: darkColors ? 'tray-win-light.png' : 'tray-win-dark.png' };
}

/** 中控台关闭：非退出流程 → 隐藏常驻后台；只有真正退出才允许销毁窗口。 */
export function shouldHideDirectorOnClose(isQuitting: boolean): boolean {
  return !isQuitting;
}

/** 所有窗口关闭时是否退出：只有显式退出/系统退出才终止进程。 */
export function shouldQuitOnAllWindowsClosed(isQuitting: boolean): boolean {
  return isQuitting;
}

export interface TrayHostOptions {
  platform: NodeJS.Platform;
  appName: string;
  /** 品牌图标目录（打包后 dist/renderer/brand，源码态 assets/brand）。 */
  iconDir: string;
  popoverHtml: string;
  preloadPath: string;
  /** PET_STAGE_E2E=1：不创建真实系统 Tray，避免无头/CI 环境干扰。 */
  testMode: boolean;
  isQuitting: () => boolean;
  onOpenDirector: () => void;
  onOpenBench: () => void;
  /** 浮窗首次创建或重建后回调，供主进程把浮窗接入事件广播目标。 */
  onPopoverCreated?: (webContents: WebContents) => void;
  /** 显示/暂藏全部桌宠（菜单文案由 petState 驱动）。 */
  onTogglePets: () => void;
  petState: () => { anyHidden: boolean };
  onQuit: () => void;
  popoverSize?: PopoverSize;
}

export interface TrayHost {
  /** 测试模式为 null。 */
  tray: Tray | null;
  showPopover(): void;
  hidePopover(): void;
  /** 当前存活浮窗的 webContents（供主进程广播实时事件）。 */
  popoverWebContents(): WebContents | null;
  /** 最近一次浮窗坐标（E2E/诊断只读）。 */
  lastBounds(): Rectangle | null;
  isPopoverVisible(): boolean;
  destroy(): void;
}

/**
 * 创建托盘宿主。内部延迟加载 Electron 运行时，保证 tray-host.ts 的纯函数可被 Node 单测直接 import。
 */
export async function createTrayHost(options: TrayHostOptions): Promise<TrayHost> {
  const { BrowserWindow, Menu, Tray, nativeImage, nativeTheme, screen } = await import('electron');
  const popoverSize = options.popoverSize ?? POPOVER_SIZE;
  const guard = createPopoverToggleGuard();
  let popover: BrowserWindow | null = null;
  let popoverReady = false;
  let pendingShow = false;
  let tray: Tray | null = null;
  let lastBounds: Rectangle | null = null;
  let lastIconDark: boolean | null = null;
  let destroying = false;
  let themeListener: (() => void) | null = null;

  const iconFile = (): string => {
    const chosen = trayIconFilenames(options.platform, nativeTheme.shouldUseDarkColors);
    const candidates = [chosen.primary, chosen.highDpi, 'icon-32.png', 'icon-64.png'].filter((name): name is string => typeof name === 'string');
    const found = candidates.map((name) => join(options.iconDir, name)).find((candidate) => existsSync(candidate));
    if (found === undefined) {
      throw new Error(`托盘图标缺失：${options.iconDir}（先跑 pnpm exec tsx apps/desktop-host/scripts/generate-tray-icons.ts）`);
    }
    return found;
  };

  const iconForTheme = (): NativeImage => {
    const image = nativeImage.createFromPath(iconFile());
    if (options.platform === 'darwin') image.setTemplateImage(true);
    return image;
  };

  const applyTrayIcon = (force = false): void => {
    if (tray === null) return;
    const dark = nativeTheme.shouldUseDarkColors;
    if (!force && lastIconDark === dark) return;
    lastIconDark = dark;
    tray.setImage(iconForTheme());
  };

  const createPopover = (): BrowserWindow => {
    popoverReady = false;
    const win = new BrowserWindow({
      ...popoverSize,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: options.platform === 'darwin',
      backgroundColor: '#00000000',
      ...(options.platform === 'darwin' ? { vibrancy: 'popover' as const, visualEffectState: 'active' as const } : {}),
      webPreferences: {
        preload: options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.once('ready-to-show', () => {
      if (popover !== win || win.isDestroyed()) return;
      popoverReady = true;
      if (pendingShow && !destroying && !options.isQuitting()) {
        pendingShow = false;
        win.show();
        win.focus();
      }
    });
    win.loadFile(options.popoverHtml).catch((error: unknown) => {
      console.warn('[tray] 浮窗加载失败：', error);
    });
    win.on('blur', () => {
      if (destroying || options.isQuitting()) return;
      if (!win.isVisible()) return;
      win.hide();
      guard.markHidden(Date.now());
    });
    win.on('close', (event) => {
      if (destroying || options.isQuitting()) return;
      event.preventDefault();
      pendingShow = false;
      win.hide();
      guard.markHidden(Date.now());
    });
    win.on('closed', () => {
      if (popover === win) {
        popover = null;
        popoverReady = false;
        pendingShow = false;
      }
    });
    options.onPopoverCreated?.(win.webContents);
    return win;
  };

  const showPopover = (): void => {
    if (options.isQuitting()) return;
    if (popover === null || popover.isDestroyed()) {
      popover = createPopover();
    }
    const trayBounds = tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    const cursor = screen.getCursorScreenPoint();
    const display = isTrayBoundsUnavailable(trayBounds)
      ? screen.getDisplayNearestPoint(cursor)
      : screen.getDisplayMatching(trayBounds);
    const bounds = computePopoverBounds({
      trayBounds,
      cursorPoint: cursor,
      workArea: display.workArea,
      displayBounds: display.bounds,
      popoverSize,
      platform: options.platform,
    });
    lastBounds = bounds;
    popover.setBounds(bounds);
    if (popoverReady) {
      pendingShow = false;
      popover.show();
      popover.focus();
    } else {
      pendingShow = true;
    }
  };

  const hidePopover = (): void => {
    pendingShow = false;
    if (popover === null || popover.isDestroyed() || !popover.isVisible()) return;
    popover.hide();
    guard.markHidden(Date.now());
  };

  if (!options.testMode) {
    lastIconDark = nativeTheme.shouldUseDarkColors;
    tray = new Tray(iconForTheme());
    tray.setToolTip(options.appName);
    const onThemeUpdated = (): void => applyTrayIcon();
    themeListener = onThemeUpdated;
    nativeTheme.on('updated', onThemeUpdated);

    tray.on('click', () => {
      const action = guard.onTrayClick(Date.now(), popover?.isVisible() === true);
      if (action === 'show') showPopover();
      else if (action === 'hide') hidePopover();
    });
    if (options.platform === 'win32') {
      // Win11 双击托盘直接打开中控台（单击仍开快捷浮窗）。
      tray.on('double-click', () => {
        hidePopover();
        options.onOpenDirector();
      });
    }
    tray.on('right-click', () => {
      const menu = Menu.buildFromTemplate([
        { label: '打开中控台', click: () => { hidePopover(); options.onOpenDirector(); } },
        { label: '打开桌宠验收台', click: () => { hidePopover(); options.onOpenBench(); } },
        { label: options.petState().anyHidden ? '显示全部桌宠' : '暂藏全部桌宠', click: () => options.onTogglePets() },
        { type: 'separator' },
        { label: `退出 ${options.appName}`, click: () => options.onQuit() },
      ]);
      tray?.popUpContextMenu(menu);
    });
  }

  return {
    get tray() {
      return tray;
    },
    showPopover,
    hidePopover,
    popoverWebContents: () => (popover !== null && !popover.isDestroyed() ? popover.webContents : null),
    lastBounds: () => lastBounds,
    isPopoverVisible: () => popover?.isVisible() === true,
    destroy(): void {
      destroying = true;
      pendingShow = false;
      if (themeListener !== null) {
        nativeTheme.removeListener('updated', themeListener);
        themeListener = null;
      }
      if (popover !== null && !popover.isDestroyed()) popover.destroy();
      popover = null;
      popoverReady = false;
      if (tray !== null) {
        tray.destroy();
        tray = null;
      }
    },
  };
}
