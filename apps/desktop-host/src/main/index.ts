/**
 * Electron 主进程入口（T-M1-02）：透明桌宠窗。
 * transparent + frame:false + alwaysOnTop + skipTaskbar；穿透策略见 ./passthrough.ts。
 */
import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, screen } from 'electron';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerStageIpc } from './passthrough';
import { registerProviderVaultIpc } from './provider-vault';
import { createModsHost } from './mods-host';
import { createPetPrefsStore } from './pet-prefs';
import { PetWindowManager, type ManagedPetWindow, type PetWindowCreateInput, type WindowBounds } from './pet-window-manager';
import { createCharacterRegistry } from './character-registry';
import { characterPokeLine, setCurrentPersonaCharacter, setCurrentPersonaPrompt } from './character-persona';
import { createCoopHost } from './coop-host';
import { createProviderImportHost } from './provider-import-host';
import { createAutodriveHost } from './autodrive-host';
import { createHarnessHost } from './agent-host';
import { createVoiceHost, registerVoiceHostIpc } from './voice-host';
import { importAboutmePets, readPackCatalog } from '@workbench/pet-renderer/aboutme-pets';
import { createMemoryHost, dayKeyOf } from './memory-host';
import { createWebUIServer } from './webui-server';
import { createPluginHost } from './plugin-host';
import { createLiveHost } from './live-host';
import { fetchDstSnapshot, GAME_CONNECT_GUIDANCE, probeGameHealth } from './game-health';
import { detectLaunchStatus, prepareStardewProfile, spawnGameProcess } from './coop-launcher';
import { detectFullscreenForDisplay, parseFullscreenRect, type RectLike } from './fullscreen-detector';
import { GlobalAltMonitor, resolveAltPeekTargets } from './global-alt-peek';
import { guessModsDirs } from '@workbench/stardew-mods';
import { homedir } from 'node:os';
import type { GameId } from '@workbench/game-bridge-mcp';
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
let petWindowManager: PetWindowManager | null = null;
/** agentId → 真实 BrowserWindow：旧 IPC 仍需要默认主窗，协作主机按 id 定向投递。 */
const petBrowserWindows = new Map<string, BrowserWindow>();
let petPrefsStore: ReturnType<typeof createPetPrefsStore> | null = null;
let coopHost: ReturnType<typeof createCoopHost> | null = null;

/**
 * Electron 适配层：PetWindowManager 只依赖最小窗口接口，真实 BrowserWindow 在此创建。
 * 每个 agentId 的 bounds / scale 由 manager 决定，窗口本身不再读写全局 PetDesktopPrefs。
 */
function createManagedPetWindow(input: PetWindowCreateInput): ManagedPetWindow {
  const win = new BrowserWindow({
    x: input.bounds.x,
    y: input.bounds.y,
    width: input.bounds.width,
    height: input.bounds.height,
    title: `${APP_NAME} · 桌宠 ${input.agentId === 'default' ? '' : input.agentId}`.trim(),
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
  petBrowserWindows.set(input.agentId, win);
  if (input.agentId === 'default') stageWindow = win;
  win.on('closed', () => {
    if (petBrowserWindows.get(input.agentId) === win) petBrowserWindows.delete(input.agentId);
    if (stageWindow === win) stageWindow = null;
  });
  const windowPath = join(here, '../renderer/pet-stage/index.html');
  return {
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible(),
    isMinimized: () => win.isMinimized(),
    focus: () => win.focus(),
    showInactive: () => win.showInactive(),
    hide: () => win.hide(),
    setOpacity: (opacity: number) => win.setOpacity(opacity),
    setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => win.setIgnoreMouseEvents(ignore, options),
    close: () => win.close(),
    setBounds: (bounds: WindowBounds) => win.setBounds(bounds),
    getBounds: () => win.getBounds(),
    send: (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
    loadStage: async (hash: string) => {
      await win.loadFile(windowPath, { hash });
    },
    onBoundsChanged: (listener) => {
      const notify = (): void => listener(win.getBounds());
      win.on('move', notify);
      win.on('resize', notify);
      return () => {
        win.removeListener('move', notify);
        win.removeListener('resize', notify);
      };
    },
    onClosed: (listener) => {
      win.on('closed', listener);
      return () => win.removeListener('closed', listener);
    },
  };
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

app.whenReady().then(async () => {
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
  // 桌宠角色注册表（T-M6-21）：内置 + userData 自定义角色，切换落 PetDesktopPrefs（单点事实源）
  const prefs = (petPrefsStore ??= createPetPrefsStore(app.getPath('userData'), (prev, next) => {
    // 旧全局 API 仅作用于 default 窗口；新协作大厅走 pet:window-prefs-set 按 agent 隔离。
    const windowPrefs = petWindowManager?.prefs('default');
    if (windowPrefs === null || windowPrefs === undefined) return;
    if (windowPrefs.scale !== next.scale) petWindowManager?.patch('default', { scale: next.scale });
    if (prev.shortcutHideEnabled !== next.shortcutHideEnabled) registerShortcut();
    for (const target of petBrowserWindows.values()) {
      if (!target.isDestroyed()) target.webContents.send('pet:global-prefs-changed', next);
    }
    if (
      windowPrefs.position.x !== next.position.x
      || windowPrefs.position.y !== next.position.y
      || windowPrefs.position.displayId !== next.position.displayId
    ) {
      petWindowManager?.setPosition('default', next.position);
    }
    void prev;
  }));
  const characters = createCharacterRegistry({
    userDataDir: app.getPath('userData'),
    getPrefs: () => prefs.get(),
    setCharacter: (id) => {
      prefs.patch({ characterId: id });
      const next = characters.selected();
      setCurrentPersonaCharacter(next.id, next.personaPrompt);
      // 全局角色快切只作用于 default 主桌宠；其他联机桌宠角色由各自 pet:window-open(agentId, characterId) 固定
      petWindowManager?.patch('default', { characterId: next.id });
      petWindowManager?.send('pet:character-changed', 'default', next);
      if (directorWindow && !directorWindow.isDestroyed()) directorWindow.webContents.send('pet:character-changed', next);
    },
    builtinAssetsDir: join(here, '../renderer/pet-stage/assets'),
  });
  void characters;

  let packImportBusy = false;
  ipcMain.handle('pet:pack-catalog', () => readPackCatalog(app.getPath('userData')));
  ipcMain.handle('pet:pack-import', async (_event, input?: { all?: boolean; packSlugs?: string[] }) => {
    if (packImportBusy) return { ok: false, error: '已有角色包导入任务在运行' };
    packImportBusy = true;
    try {
      const result = await importAboutmePets({
        userDataDir: app.getPath('userData'),
        all: input?.all === true,
        ...(input?.packSlugs === undefined ? {} : { packSlugs: input.packSlugs }),
        onProgress: (progress) => {
          for (const target of [stageWindow, directorWindow]) {
            if (target && !target.isDestroyed()) target.webContents.send('pet:pack-import-progress', progress);
          }
        },
      });
      return { ok: result.failed.length === 0, ...result, catalog: readPackCatalog(app.getPath('userData')) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      packImportBusy = false;
    }
  });

  ipcMain.handle('pet:poke-line', (_event, agentId?: string) => {
    const windowCharacterId = agentId === undefined ? null : petWindowManager?.prefs(agentId)?.characterId ?? null;
    const character = (windowCharacterId === null ? null : characters.list().find((item) => item.id === windowCharacterId)) ?? characters.selected();
    return { ok: true, characterId: character.id, line: characterPokeLine(character.id) };
  });

  // T-M6-38：多桌宠窗口管理器。所有窗口创建/坐标/缩放/锁定/事件定向在这里收口。
  petWindowManager = new PetWindowManager({
    userDataDir: app.getPath('userData'),
    createWindow: createManagedPetWindow,
    workArea: () => {
      const area = screen.getPrimaryDisplay().workArea;
      return { x: area.x, y: area.y, width: area.width, height: area.height };
    },
    legacyDefault: () => ({
      ...prefs.get().position,
      scale: prefs.get().scale,
      characterId: prefs.get().characterId,
    }),
    onWindowsChanged: (list) => {
      if (directorWindow && !directorWindow.isDestroyed()) directorWindow.webContents.send('pet:window-list-changed', list);
    },
  });
  ipcMain.handle('pet:window-open', async (_event, agentId: string, characterId?: string) => {
    const known = characterId === undefined ? undefined : characters.list().find((character) => character.id === characterId);
    if (characterId !== undefined && known === undefined) return { ok: false, error: `未知角色：${characterId}` };
    return petWindowManager!.open(agentId, known?.id ?? prefs.get().characterId);
  });
  ipcMain.handle('pet:window-close', (_event, agentId: string) => ({ ok: petWindowManager!.close(agentId) }));
  ipcMain.handle('pet:window-list', () => petWindowManager!.list());
  ipcMain.handle('pet:window-prefs-get', (_event, agentId: string) => petWindowManager!.prefs(agentId));
  ipcMain.handle('pet:window-prefs-set', (_event, agentId: string, update: { scale?: number; locked?: boolean; characterId?: string }) =>
    petWindowManager!.patch(agentId, update ?? {}));
  ipcMain.handle('pet:window-dock', (_event, agentId: string, edge: 'left' | 'right') => petWindowManager!.dock(agentId, edge));
  const autoHiddenAgents = new Set<string>();
  const applyFullscreenRect = (rect: RectLike | null): void => {
    const manager = petWindowManager;
    if (manager === null) return;
    for (const view of manager.list()) {
      const display = screen.getDisplayMatching(view.bounds);
      const decision = rect === null ? { hidden: false } : detectFullscreenForDisplay(
        { displayId: String(display.id), bounds: display.bounds },
        [{ bounds: rect }],
      );
      if (decision.hidden) { manager.setHidden(view.agentId, true); autoHiddenAgents.add(view.agentId); }
      else if (autoHiddenAgents.delete(view.agentId)) manager.setHidden(view.agentId, false);
    }
  };
  const altMonitor = new GlobalAltMonitor();
  altMonitor.start();
  let altTestOverride: boolean | null = null;
  setInterval(() => {
    const point = screen.getCursorScreenPoint();
    const windows = petWindowManager?.list().map((view) => ({ agentId: view.agentId, bounds: view.bounds })) ?? [];
    petWindowManager?.applyPeekTargets(resolveAltPeekTargets(windows, point, altTestOverride ?? altMonitor.current()));
  }, 50).unref();
  if (TEST_MODE) {
    ipcMain.handle('test:alt-peek', (_event, point: { x: number; y: number }, altDown: boolean) => {
      altTestOverride = altDown;
      const windows = petWindowManager?.list().map((view) => ({ agentId: view.agentId, bounds: view.bounds })) ?? [];
      const targets = resolveAltPeekTargets(windows, point, altDown);
      petWindowManager?.applyPeekTargets(targets);
      return { ok: true, targets };
    });
    ipcMain.handle('test:fullscreen-apply', (_event, rect: RectLike | null) => {
      applyFullscreenRect(rect);
      return { ok: true, hidden: [...autoHiddenAgents] };
    });
  }
  ipcMain.handle('pet:window-undock', (_event, agentId: string) => petWindowManager!.undock(agentId));
  ipcMain.handle('pet:window-clear-dock', (_event, agentId: string) => ({ ok: petWindowManager!.clearDock(agentId) }));
  ipcMain.handle('pet:peek', (event, active: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? stageWindow;
    if (win === null || win.isDestroyed()) return { ok: false };
    win.setOpacity(active ? 0.35 : 1);
    win.setIgnoreMouseEvents(active, { forward: active });
    return { ok: true };
  });
  const registerShortcut = (): void => {
    globalShortcut.unregister('Control+Alt+P');
    if (prefs.get().shortcutHideEnabled) {
      globalShortcut.register('Control+Alt+P', () => {
        if (petWindowManager?.anyHidden() === true) petWindowManager.showAll();
        else petWindowManager?.hideAll();
      });
    }
  };
  registerShortcut();
  const fullscreenScript = [
    'tell application "System Events"',
    'set p to first application process whose frontmost is true',
    'if (value of attribute "AXFullScreen" of window 1 of p) is true then',
    'set pos to position of window 1 of p',
    'set sz to size of window 1 of p',
    'return ((item 1 of pos) as string) & "," & ((item 2 of pos) as string) & "," & ((item 1 of sz) as string) & "," & ((item 2 of sz) as string)',
    'end if',
    'return ""',
    'end tell',
  ].join('\n');
  setInterval(() => {
    if (process.platform !== 'darwin' || !prefs.get().autoHideFullscreen) return;
    execFile('osascript', ['-e', fullscreenScript], { timeout: 2_000 }, (error, stdout) => {
      if (error) return;
      applyFullscreenRect(parseFullscreenRect(String(stdout)));
    });
  }, 5_000).unref();
  app.on('will-quit', () => { altMonitor.stop(); globalShortcut.unregisterAll(); });

  // T-M6-31：外部插件生产链路（发现/启停/工具注册/审批/崩溃隔离）
  const plugins = createPluginHost({
    userDataDir: app.getPath('userData'),
    windows: () => [...petBrowserWindows.values(), directorWindow].filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.webContents),
  });
  // 语音宿主（D11）：先创建并注册 IPC，再注入 autodrive（DI——IPC 只挂一次）
  const voice = createVoiceHost(process.platform, {
    resolveVoiceId: (characterId) => characters.list().find((character) => character.id === characterId)?.voiceId ?? null,
    onSpeakerChange: (event) => {
      petWindowManager?.send('coop:speaker', '*', event);
      if (directorWindow && !directorWindow.isDestroyed()) directorWindow.webContents.send('coop:speaker', event);
    },
    onSpeechResult: (event) => {
      petWindowManager?.send('pet:speech-result', '*', event);
      if (directorWindow && !directorWindow.isDestroyed()) directorWindow.webContents.send('pet:speech-result', event);
    },
  });
  registerVoiceHostIpc(voice);
  // 记忆图谱（T-M5-04）：回执入图谱 + 聊天检索
  const memory = createMemoryHost(app.getPath('userData'));
  void dayKeyOf;
  // autodrive 宿主（T-M5-02）：事件单源多播到两窗；启停由 Shell 显式触发
  const MAIN_GAME_ENDPOINT = 'http://127.0.0.1:18080/mcp';
  const autodrive = createAutodriveHost(
    MAIN_GAME_ENDPOINT,
    join(app.getPath('userData'), 'provider-vault.json'),
    voice,
    memory,
    'stardew',
    undefined,
    () => coopHost?.list().some((agent) => agent.running && agent.endpoint === MAIN_GAME_ENDPOINT)
      ? '该端点已被「联机协作」页接管；请先停止对应 AI 队友，避免两个 Runner 抢同一角色'
      : null,
    characters,
  );
  const stardewModsDir = (): string | null => guessModsDirs(process.platform, homedir()).find((dir) => existsSync(dir)) ?? null;
  const profilesRoot = join(app.getPath('userData'), 'coop-profiles', 'stardew');
  ipcMain.handle('coop:launch-status', async () => detectLaunchStatus(process.platform, homedir(), profilesRoot));
  ipcMain.handle('coop:launch-human', async (_e, gameId: 'stardew' | 'terraria' | 'dst') => {
    if (gameId !== 'stardew') return { ok: false, error: `${gameId} 一键启动需本机安装路径确认；当前仅完成星露谷参数数组启动` };
    const status = (await detectLaunchStatus(process.platform, homedir(), profilesRoot)).find((item) => item.gameId === 'stardew');
    if (status?.executable == null) return { ok: false, error: status?.detail ?? '未找到 StardewModdingAPI' };
    const child = spawnGameProcess(status.executable, []);
    child.unref();
    return { ok: true, pid: child.pid };
  });
  ipcMain.handle('coop:launch-ai', async (_e, agentId: string) => {
    const endpoint = coopHost?.list().find((item) => item.id === agentId);
    if (endpoint === undefined) return { ok: false, error: '未知队友端点' };
    if (endpoint.gameId !== 'stardew') return { ok: false, error: `${endpoint.gameId} AI 实例启动待本机路径确认` };
    const modsDir = stardewModsDir();
    if (modsDir === null) return { ok: false, error: '未找到星露谷 Mods 目录' };
    const port = Number(new URL(endpoint.endpoint).port || '18080');
    try {
      const prepared = await prepareStardewProfile({ modsDir, profileDir: profilesRoot, agentId, port });
      const status = (await detectLaunchStatus(process.platform, homedir(), profilesRoot)).find((item) => item.gameId === 'stardew');
      if (status?.executable == null) return { ok: false, error: '未找到 StardewModdingAPI' };
      const child = spawnGameProcess(status.executable, ['--mods-path', prepared.profileModsDir]);
      child.unref();
      return { ok: true, pid: child.pid, profileModsDir: prepared.profileModsDir, port };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });

  // 多桌宠联机协作（T-M6-39）：复用 autodrive 的 Gateway/饭碗，但每 Agent 独立 planner/persona/voice。
  coopHost = createCoopHost({
    userDataDir: app.getPath('userData'),
    windows: () => [...petBrowserWindows.values(), directorWindow].filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.webContents),
    brain: autodrive,
    voiceHost: voice,
    petWindows: petWindowManager,
    characters,
    isEndpointBusyByMain: (endpoint) => endpoint === MAIN_GAME_ENDPOINT && autodrive.runner.isRunning(),
  });
  // T-M6-37：直播最小链路（弹幕回放 → 护栏 → 注意力 → 中控台/插件总线/语音）
  const live = createLiveHost({
    windows: () => [...petBrowserWindows.values(), directorWindow].filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.webContents),
    voiceHost: voice,
    onPluginEvent: (event, payload) => plugins.emit(event, payload),
  });
  // 自驾事件进插件总线（插件只能经总线观察，不直接访问 autodrive）
  autodrive.subscribe((event) => plugins.emit('autodrive:event', event));
  const harness = createHarnessHost();
  // 三游戏桥接探活（T-M6-25）：只读探测 18080/18090/18100，结果如实回报（不伪造「已连接」）
  ipcMain.handle('game:health', async (_event, gameId: GameId, endpoint?: string) => {
    try {
      return await probeGameHealth(gameId, { ...(endpoint === undefined ? {} : { endpoint }) });
    } catch (error) {
      return {
        gameId,
        endpoint: endpoint ?? '',
        status: 'offline' as const,
        ok: false,
        latencyMs: 0,
        detail: '探活异常',
        error: error instanceof Error ? error.message : String(error),
        guidance: GAME_CONNECT_GUIDANCE[gameId],
        checkedAt: Date.now(),
      };
    }
  });
  ipcMain.handle('game:dst-state', async () => fetchDstSnapshot());
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
    const targets = [...petBrowserWindows.values(), directorWindow]
      .filter((w): w is NonNullable<typeof w> => w !== null)
      .map((w) => w.webContents);
    autodrive.setTargets(targets);
    harness.setTargets(targets);
    plugins.setTargets(targets);
    live.setTargets(targets);
  };
  // 中控台先立即可用；默认桌宠需要在 loadFile 完成后才出现在窗口列表，避免 UI 空等。
  directorWindow = createDirectorWindow();
  const openedDefault = await petWindowManager.open('default', prefs.get().characterId);
  if (!openedDefault.ok) console.error('[pet-window] 默认桌宠窗启动失败：', openedDefault.error);
  stageWindow = petBrowserWindows.get('default') ?? null;
  wireTargets();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      directorWindow = createDirectorWindow();
      void petWindowManager?.open('default', prefs.get().characterId).then(() => {
        stageWindow = petBrowserWindows.get('default') ?? null;
        wireTargets();
      });
    }
  });
});

app.on('window-all-closed', () => {
  // 多桌宠 agent 池先停，避免残留 MCP 长轮询阻止进程退出
  coopHost?.stopAll();
  app.quit();
});
