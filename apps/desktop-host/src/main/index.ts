/**
 * Electron 主进程入口（T-M1-02）：透明桌宠窗。
 * transparent + frame:false + alwaysOnTop + skipTaskbar；穿透策略见 ./passthrough.ts。
 */
import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerStageIpc } from './passthrough';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_MODE = process.env.PET_STAGE_E2E === '1';

let stageWindow: BrowserWindow | null = null;

function createStageWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(join(here, '../renderer/pet-stage/index.html'));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

app.whenReady().then(() => {
  registerStageIpc({ getWindow: () => stageWindow, testMode: TEST_MODE });
  stageWindow = createStageWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) stageWindow = createStageWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
