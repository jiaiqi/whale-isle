/**
 * Electron 主进程入口（T-M1-02）：透明桌宠窗。
 * transparent + frame:false + alwaysOnTop + skipTaskbar；穿透策略见 ./passthrough.ts。
 */
import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerStageIpc } from './passthrough';
import { registerProviderVaultIpc } from './provider-vault';
import { createModsHost } from './mods-host';
import { createAutodriveHost } from './autodrive-host';
import { createHarnessHost } from './agent-host';
import { createVoiceHost, registerVoiceHostIpc } from './voice-host';
import { createMemoryHost, dayKeyOf } from './memory-host';
import { createWebUIServer } from './webui-server';

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
  // 星露谷 Mod 管理（T-M6-06）：只读写玩家 Mods 目录，配置落 userData
  const modsHost = createModsHost(app.getPath('userData'));
  void modsHost;
  // 语音宿主（D11）：先创建并注册 IPC，再注入 autodrive（DI——IPC 只挂一次）
  const voice = createVoiceHost();
  registerVoiceHostIpc(voice);
  // 记忆图谱（T-M5-04）：回执入图谱 + 聊天检索
  const memory = createMemoryHost(app.getPath('userData'));
  void dayKeyOf;
  // autodrive 宿主（T-M5-02）：事件单源多播到两窗；启停由 Shell 显式触发
  const autodrive = createAutodriveHost('http://127.0.0.1:18080/mcp', join(app.getPath('userData'), 'provider-vault.json'), voice, memory);
  const harness = createHarnessHost();
  // WebUI 形态（T-M6-04）：本机浏览器复核口（HTTP/WS + 远程审批）。
  // 包裹 try/catch：WebUI 起不来只告警，绝不拖垮 Electron 主进程。
  try {
    const webui = createWebUIServer({
      getState: () => ({
        running: autodrive.runner.isRunning(),
        brainMode: autodrive.getBrainMode().mode,
        memoryStats: { nodes: memory.store.size, edges: memory.store.allEdges().length },
        voice: {
          enabled: voice.config.enabled,
          innerVoice: voice.config.innerVoice,
          volume: voice.config.volume,
          ratePercent: voice.config.ratePercent,
          voice: voice.config.voice,
          voiceId: voice.config.voiceId,
          pitchMul: voice.config.pitchMul,
        },
      }),
      // 浏览器聊天复用 Shell 同款回话（人设/记忆/雷区反射/自动发声全一致）
      onCommand: (text) => autodrive.say(text),
      // 总线事件（决策/回执/聊天）实时推给 WebUI WS
      getBusEventSources: () => [
        { subscribe: (listener) => autodrive.subscribe((event) => listener(event)) },
      ],
      // 远程审批：浏览器审批卡直接回填 ACP permission（Y/N/A）
      onApprove: (payload) => {
        harness.manager.resolvePermission(payload.providerId, payload.requestId, payload.outcome);
        return { ok: true };
      },
    });
    void webui.ready
      .then(() => {
        console.log(`[webui] http://127.0.0.1:${webui.port}/?token=${webui.token}`);
      })
      .catch((error: unknown) => {
        console.warn('[webui] 启动失败（不影响主进程）:', error);
      });
  } catch (error) {
    console.warn('[webui] 初始化失败（不影响主进程）:', error);
  }
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
