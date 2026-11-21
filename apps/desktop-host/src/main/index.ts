/**
 * Electron 主进程入口（T-M1-02）：透明桌宠窗。
 * transparent + frame:false + alwaysOnTop + skipTaskbar；穿透策略见 ./passthrough.ts。
 */
import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerStageIpc } from './passthrough';
import { registerProviderVaultIpc } from './provider-vault';
import { createAutodriveHost } from './autodrive-host';
import { createHarnessHost } from './agent-host';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_MODE = process.env.PET_STAGE_E2E === '1';

// E2E 模式独立 userData：与开发实例并发时 IndexedDB LevelDB 锁互不干扰，测试数据不污染真实配置。
// 必须在 app ready 前调用。
if (TEST_MODE) {
  app.setPath('userData', join(app.getPath('userData'), 'e2e-profile'));
}

let stageWindow: BrowserWindow | null = null;
let directorWindow: BrowserWindow | null = null;

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

function createDirectorWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: '大肥鱼中控台',
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: join(here, '../preload/index.cjs'),
    },
  });
  win.loadFile(join(here, '../renderer/director/index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

app.whenReady().then(() => {
  registerStageIpc({ getWindow: () => stageWindow, testMode: TEST_MODE });
  // 供应商凭据库：key 经 safeStorage 加密落盘 userData/provider-vault.json（渲染进程只见掩码）
  registerProviderVaultIpc(join(app.getPath('userData'), 'provider-vault.json'));
  // autodrive 宿主（T-M5-02）：事件单源多播到两窗；启停由 Shell 显式触发
  const autodrive = createAutodriveHost('http://127.0.0.1:18080/mcp', join(app.getPath('userData'), 'provider-vault.json'));
  const harness = createHarnessHost();
  const wireTargets = () => {
    const targets = [stageWindow, directorWindow].filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.webContents);
    autodrive.setTargets(targets);
    harness.setTargets(targets);
  };
  stageWindow = createStageWindow();
  directorWindow = createDirectorWindow();
  wireTargets();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      stageWindow = createStageWindow();
      directorWindow = createDirectorWindow();
      wireTargets();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
