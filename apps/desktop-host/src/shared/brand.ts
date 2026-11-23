/**
 * 品牌单点事实源（T-brand-01，用户指令 2026-11-22）：
 * 应用名「鲸屿 / Whale Isle」——鲸是住在桌面上的小鲸，屿是承载她的小小桌面岛屿。
 * 主进程、中控台、WebUI 的展示名一律从这里取，避免硬编码漂移。
 */
export const APP_NAME = '鲸屿';
export const APP_NAME_EN = 'Whale Isle';
export const APP_TAGLINE = '一座住在桌面上的鲸屿';
export const APP_ID = 'com.whaleisle.desktop';

/** userData 目录名：新增英文名避免中文路径工具兼容问题；旧 Electron 数据首次启动自动合并迁移 */
export const APP_DATA_DIR = 'Whale Isle';
export const LEGACY_USER_DATA_DIRS = ['Electron', '大肥鱼工作台'] as const;
export const BRAND_MIGRATION_MARKER = '.whale-isle-migrated.json';

export const BRAND_ASSETS = {
  iconIcns: 'icon.icns',
  iconPng: 'icon-512.png',
  iconSmallPng: 'icon-64.png',
  markSvg: 'whale-isle-mark.svg',
} as const;

/** 侧栏/WebUI 复用的极简鲸鱼标记（与 iconset 同一视觉语言：鲸身 + 尾鳍 + 女仆头带） */
export function whaleMarkPaths(): {
  body: string;
  tail: string;
  band: string;
  eye: { cx: number; cy: number; r: number };
  glint: { cx: number; cy: number; r: number };
} {
  return {
    body: 'M 8.1 13.7 C 8.1 10.1 11 7.2 14.6 7.2 C 18.7 7.2 22 10.1 22 13.9 C 22 17.7 18.7 20.5 14.6 20.5 C 11.3 20.5 8.1 17.8 8.1 13.7 Z',
    tail: 'M 8.2 13.6 C 6.5 12.3 4.4 11.7 2.2 12 C 3.7 12.9 4.8 14.1 5.5 15.5 C 4.5 16.6 3.7 17.9 3.1 19.3 C 5.3 18.9 7.3 17.9 8.8 16.4 Z',
    band: 'M 11.2 8.3 C 13.3 6.9 16.5 6.9 18.6 8.4',
    eye: { cx: 17.5, cy: 12.2, r: 1.15 },
    glint: { cx: 17.85, cy: 11.85, r: 0.38 },
  };
}
