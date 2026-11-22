/**
 * Electron 主进程入口（T-M1-02）：透明桌宠窗。
 * transparent + frame:false + alwaysOnTop + skipTaskbar；穿透策略见 ./passthrough.ts。
 */
import { app, BrowserWindow, ipcMain, nativeImage, screen } from 'electron';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerStageIpc } from './passthrough';
import { registerProviderVaultIpc } from './provider-vault';
import { createModsHost } from './mods-host';
import { createPetPrefsStore } from './pet-prefs';
import { createProviderImportHost } from './provider-import-host';
import { createAutodriveHost } from './autodrive-host';
import { createHarnessHost } from './agent-host';
import { createVoiceHost, registerVoiceHostIpc } from './voice-host';
import { createMemoryHost, dayKeyOf } from './memory-host';
import { createWebUIServer } from './webui-server';
import {
  APP_DATA_DIR,
  APP_ID,
  APP_NAME,
  APP_NAME_EN,
  APP_TAGLINE,
  BRAND_ASSETS,
  BRAND_MIGRATION_MARKER,
  LEGACY_USER_DATA_DIRS,
} from '../shared/brand';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_MODE = process.env.PET_STAGE_E2E === '1';

// macOS 的 safeStorage Keychain 服务名是「<app name> Safe Storage」；开发态沿用 Electron 名称
// 才能解密旧版凭据库。打包后 productName 已是鲸屿，Keychain 服务自然切换；显示名各处显式用 APP_NAME。
const USE_BRANDED_APP_NAME = process.platform !== 'darwin' || app.isPackaged;
if (USE_BRANDED_APP_NAME) app.setName(APP_NAME);

/** 品牌资源：打包后 dist/renderer/brand；直接跑源码时回落 assets/brand */
function brandAssetPath(file: string): string {
  const fromDist = join(here, '../renderer/brand', file);
  return existsSync(fromDist) ? fromDist : join(here, '../../assets/brand', file);
}

/** 旧版 Electron/大肥鱼工作台 userData 是否包含我们的数据（避免误迁移其他 Electron 应用） */
function looksLikeWorkbenchData(dir: string): boolean {
  return ['provider-vault.json', 'meter', 'memory', 'stardew-mods.json', 'IndexedDB'].some((name) => existsSync(join(dir, name)));
}

/**
 * 品牌更名后的数据迁移（2026-11-22）：
 * 旧版开发运行把 provider-vault / 饭碗 / 记忆 / IndexedDB 落在通用 `Electron` 目录；
 * 新版本改用 `Whale Isle`。首次启动只做「薄拷贝」：不覆盖新目录已有文件，保留 e2e 隔离目录，
 * 迁移完写 marker 幂等；失败也不阻断启动（用户仍可从旧目录手工恢复）。
 */
function migrateLegacyUserData(target: string): void {
  if (existsSync(join(target, BRAND_MIGRATION_MARKER))) return;
  const appDataRoot = app.getPath('appData');
  const legacy = LEGACY_USER_DATA_DIRS.map((name) => join(appDataRoot, name)).find((dir) => looksLikeWorkbenchData(dir));
  if (legacy === undefined) {
    mkdirSync(target, { recursive: true });
    return;
  }
  // 只迁我们自己的数据：`Electron` 目录可能被其他本地 Electron 开发实例共用，
  // 不整目录复制 Cookies/Cache，避免把别人的会话带进来。
  const migratable = new Set([
    'provider-vault.json',
    'meter',
    'memory',
    'stardew-mods.json',
    'IndexedDB',
    'Local Storage',
    'Session Storage',
  ]);
  try {
    mkdirSync(target, { recursive: true });
    cpSync(legacy, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (src) => {
        if (src === legacy) return true;
        const rel = relative(legacy, src);
        const top = rel.split(sep)[0];
        return top !== undefined && migratable.has(top);
      },
    });
    writeFileSync(
      join(target, BRAND_MIGRATION_MARKER),
      `${JSON.stringify({ from: legacy, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    console.log(`[brand] userData 已从 ${legacy} 合并迁移到 ${target}`);
  } catch (error) {
    console.warn('[brand] userData 迁移失败（继续使用新目录）:', error);
    mkdirSync(target, { recursive: true });
  }
}

// E2E 模式使用同一品牌目录下的独立 userData：与开发实例并发时 IndexedDB LevelDB 锁互不干扰。
// 必须在 app ready 前调用。
const userDataRoot = join(app.getPath('appData'), APP_DATA_DIR);
if (TEST_MODE) {
  app.setPath('userData', join(userDataRoot, 'e2e-profile'));
} else {
  migrateLegacyUserData(userDataRoot);
  app.setPath('userData', userDataRoot);
}

let stageWindow: BrowserWindow | null = null;
let directorWindow: BrowserWindow | null = null;
let petPrefsStore: ReturnType<typeof createPetPrefsStore> | null = null;

function createStageWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // 窗口贴合舞台 400×260（footline 21px 余量 → 284）：旧 440×300 右侧 40px、底部 19px
    // 是纯透明死区，用户真机反馈「透明宽度影响桌面操作」——收边减少屏幕占用与命中面积
    width: 400,
    height: 284,
    title: `${APP_NAME} · 桌宠`,
    icon: brandAssetPath(BRAND_ASSETS.iconPng),
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
  // T-M6-19：启动恢复桌宠上次落点（位置持久化）。越界/显示器已拔 → 回落主屏安全位置，绝不把桌宠放到屏幕外
  const prefs = (petPrefsStore ??= createPetPrefsStore(app.getPath('userData'))).get();
  const { x, y } = prefs.position;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x >= a.x - 40 && y >= a.y - 40 && x <= a.x + a.width && y <= a.y + a.height;
  });
  if (onScreen) win.setPosition(Math.round(x), Math.round(y));
  else win.setPosition(120, 120);
  win.loadFile(join(here, '../renderer/pet-stage/index.html'));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function createDirectorWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1120,
    minHeight: 700,
    title: `${APP_NAME} · 中控台`,
    icon: brandAssetPath(BRAND_ASSETS.iconPng),
    autoHideMenuBar: true,
    backgroundColor: '#050507',
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
  app.setAppUserModelId(APP_ID);
  const dockIcon = nativeImage.createFromPath(brandAssetPath(BRAND_ASSETS.iconPng));
  if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: `${APP_NAME_EN} · ${APP_TAGLINE}`,
    copyright: `© 2026 ${APP_NAME_EN}`,
    credits: `${APP_TAGLINE}\n${APP_NAME_EN}`,
    iconPath: brandAssetPath(BRAND_ASSETS.iconIcns),
  });
  registerStageIpc({ getWindow: () => stageWindow, testMode: TEST_MODE });
  // 供应商凭据库：key 经 safeStorage 加密落盘 userData/provider-vault.json（渲染进程只见掩码）
  const vaultPath = join(app.getPath('userData'), 'provider-vault.json');
  registerProviderVaultIpc(vaultPath);
  // Magpie / CC Switch 只读导入（T-M6-09）：扫描只回掩码，导入时主进程直接加密写 vault
  createProviderImportHost(vaultPath);
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
    ipcMain.handle('webui:info', () => ({ ok: true, port: webui.port, token: webui.token }));
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
