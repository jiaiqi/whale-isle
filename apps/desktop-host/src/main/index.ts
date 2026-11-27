/**
 * Electron 主进程入口（T-M1-02）：透明桌宠窗。
 * transparent + frame:false + alwaysOnTop + skipTaskbar；穿透策略见 ./passthrough.ts。
 */
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, screen, type MenuItemConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerStageIpc } from './passthrough';
import { installBootErrorRecorder, registerEarlyIpc } from './boot-ipc';
import { createPetPacksProtocolHandler, PET_PACKS_SCHEME, readBundledAboutmePacks, readCrossPetCharacters, readCrossPetEggScripts, registerPetPacksIpc, resolvePetPacksDir } from './pet-packs';
import { createEggTheater } from './egg-theater';
import { decidePeakOutfit, isPeakOutfitFamily, resolvePeakPeriod, type PeakOutfitState } from './peak-schedule';
import { isMockKeychainLaunch, logVaultStartup, registerProviderVaultIpc, resolveVaultPath } from './provider-vault';
import { createModsHost } from './mods-host';
import { bwfMcpEndpoint, resolveBwfEndpoint } from './bwf-settings';
import { randomUUID } from 'node:crypto';
import { createPetPrefsStore } from './pet-prefs';
import { PetWindowManager, type ManagedPetWindow, type PetWindowCreateInput, type WindowBounds } from './pet-window-manager';
import { createCharacterRegistry } from './character-registry';
import { bindCharacterCorePrompt, characterPokeLine, setCurrentPersonaCharacter, setCurrentPersonaPrompt } from './character-persona';
import { createCoopHost } from './coop-host';
import { createProviderImportHost } from './provider-import-host';
import { createAutodriveHost } from './autodrive-host';
import { createHarnessHost } from './agent-host';
import { createVoiceHost, registerVoiceHostIpc } from './voice-host';
import { createVoiceBindingStore, registerVoiceBindingIpc } from './voice-bindings';
import { createFriendshipHost, registerFriendshipIpc } from './friendship-host';
import { backfillCliHistory } from './cli-history-backfill';
import { characterFamilyOf, createPetControlHost, matchPetViewForCharacter } from './pet-control-host';
import { createCoopLaunchHost } from './coop-launch-host';
import { createAcpSessionCache } from './acp-session-cache';
import { createCustomCharacterHost } from './custom-character-host';
import { createCreatorHost } from './creator-host';
import { createAcceptanceHost } from './acceptance-host';
import { customCharacterPairs, invalidateCustomCharacters, linesForPose, matchCharacterForApp, readCustomCharacters, resolveProxyCharacter } from './custom-character';
import { resolvePose } from './pose-resolver';
import { createWorkFollowHost } from './work-follow-host';
import { createCliLogWatcher } from './cli-log-watcher';
import { createWorkFollowInstaller } from './work-follow-installer';
import { createStardewAvatarHost, isSafeCharacterId } from './stardew-avatar-host';
import { createFrontAppWatcher } from './front-app-watcher';
import { mapLocaleToStardewLanguage, PetApiStateSchema } from '@workbench/shared-protocol';
import { importAboutmePets, readPackCatalog } from '@workbench/pet-renderer/aboutme-pets';
import { createMemoryHost, dayKeyOf } from './memory-host';
import { createWebUIServer } from './webui-server';
import { createPluginHost } from './plugin-host';
import { createV2KernelHost, type V2KernelHost } from './v2-kernel-host';
import { LipSyncTimelinePlayer, resolveCommercialTtsProvider, synthesizeTextLipSyncFrames } from '@workbench/voice-runtime';
import { createLiveHost } from './live-host';
import { fetchDstSnapshot, GAME_CONNECT_GUIDANCE, probeGameHealth } from './game-health';
import { createFakeStardewLauncher, createStardewLauncher } from './stardew-launcher';
import { createStardewLaunchPrefs, defaultIsolatedDataDir } from './stardew-launch-prefs';
import { detectFullscreenForDisplay, parseFullscreenRect, type RectLike } from './fullscreen-detector';
import { GlobalAltMonitor, resolveAltPeekTargets } from './global-alt-peek';
import { createTrayHost, shouldHideDirectorOnClose, shouldQuitOnAllWindowsClosed, type TrayHost } from './tray-host';
import { buildPetContextMenuTemplate, labelForActionState } from './pet-context-menu';
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
// [E2E-HOST] 启动期 console.error 留档（原样转发 stderr，只多存一份到 globalThis），
// 供 boot-ipc.e2e 断言「renderer 抢跑 → No handler registered」不再复现。生产环境不安装。
if (TEST_MODE) installBootErrorRecorder();
/**
 * [SIMULATION] 单桌宠链路 E2E：宿主指向测试进程里起的仿真 BWF（mock-harness 农场仿真），
 * 只在 `PET_STAGE_E2E=1` 时生效；不读也不写真实 Mods 配置，生产环境永远为 undefined。
 */
const TEST_BWF_ENDPOINT = TEST_MODE ? process.env.WHALE_E2E_BWF_ENDPOINT : undefined;

// whale-pet:// 必须在 app ready 之前登记特权（standard/secure/supportFetchAPI），
// 否则 <img>/<audio>/fetch 会被当成非标准协议拦截。见 T-M6-45。
protocol.registerSchemesAsPrivileged([{
  scheme: PET_PACKS_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

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
// 预览构建验收（V2-P4-05）：WHALE_USER_DATA_DIR 允许显式指定绝对路径的独立 userData，
// 与 owner 正在跑的客户端完全隔离；该分支不迁移旧数据、也不碰默认目录。
// 必须在 app ready 前调用。
const userDataRoot = join(app.getPath('appData'), APP_DATA_DIR);
const userDataOverride = process.env.WHALE_USER_DATA_DIR;
if (userDataOverride !== undefined && userDataOverride !== '') {
  if (!isAbsolute(userDataOverride)) {
    console.warn(`[brand] 忽略非绝对路径 WHALE_USER_DATA_DIR=${userDataOverride}`);
    app.setPath('userData', userDataRoot);
  } else {
    app.setPath('userData', resolve(userDataOverride));
  }
} else if (TEST_MODE) {
  app.setPath('userData', join(userDataRoot, 'e2e-profile'));
} else {
  migrateLegacyUserData(userDataRoot);
  app.setPath('userData', userDataRoot);
}

let stageWindow: BrowserWindow | null = null;
let directorWindow: BrowserWindow | null = null;
let petWindowManager: PetWindowManager | null = null;
/** T-M6-60：托盘常驻宿主 + 真正退出标志（决定中控台关闭是隐藏还是销毁）。 */
let trayHost: TrayHost | null = null;
/** E2E 就绪门：tray-popover 测试 handler 提前注册后，'open'/'hide' 必须等 trayHost 建好（成败都落定，绝不悬挂） */
let trayHostReadyResolve!: () => void;
const trayHostReady = new Promise<void>((resolve) => {
  trayHostReadyResolve = resolve;
});
let webuiRef: { port: number; token: string } | null = null;
let isQuitting = false;
/** agentId → 真实 BrowserWindow：旧 IPC 仍需要默认主窗，协作主机按 id 定向投递。 */
const petBrowserWindows = new Map<string, BrowserWindow>();
let petPrefsStore: ReturnType<typeof createPetPrefsStore> | null = null;
let coopHost: ReturnType<typeof createCoopHost> | null = null;
/** 任一桌宠处于安静睡眠时，久坐/喝水提醒免打扰（T-M6-48）。 */
const asleepAgents = new Set<string>();
/** T-M6-63：显示层级实时应用（workFollow 初始化后赋值，prefs 回调只负责触发）。 */
let applyWindowLayerNow: () => void = () => undefined;

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
    setAlwaysOnTop: (flag: boolean, level?: string) => {
      win.setAlwaysOnTop(flag, level as Parameters<BrowserWindow['setAlwaysOnTop']>[1]);
    },
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

/**
 * 中控台标题栏策略（owner 2026-11-26 反馈：macOS 深色模式下系统标题栏是一条黑条，
 * 与 Tidepaper 暖色纸面内容割裂，要求顶栏自绘并跟随软件主题，但红绿灯必须是真的）。
 *
 * - macOS：`hiddenInset` —— 内容一直画到标题栏区域，关闭/最小化/缩放三颗红绿灯仍由
 *   AppKit 原生绘制（不做假按钮、不接管行为）。`trafficLightPosition` 让灯组与渲染层
 *   40px 自绘顶栏垂直居中对齐：灯组 12px 高，y=14 → 圆心 20 = 顶栏中线；x=18 → 灯组右缘
 *   约 74px，渲染层 `.wb-titlebar` 左侧留 80px 安全区。双击拖拽区的「系统缩放」
 *   （不是最大化）由 AppKit 原生处理，已用真实鼠标事件在本机验证 zoom/unzoom 都可逆。
 * - Windows：保留 `frame: true` 原生边框。理由：`titleBarOverlay` 需要主进程按主题色
 *   双向同步按钮区底色与高度，且 Windows 自绘拖拽区没有 macOS 的「双击=系统缩放」语义；
 *   原生边框零维护成本，并保证窗口按钮永远存在（owner 明确不要「没有按钮的窗口」）。
 * - Linux：保留原生边框。各发行版 WM 对 hiddenInset / overlay 支持不一致，原生最稳。
 *
 * 只作用于中控台：桌宠窗（frameless + transparent + alwaysOnTop）与托盘浮窗的窗口参数
 * 分别在 pet-window-manager / tray-host 里，互不影响。
 */
const DIRECTOR_CUSTOM_TITLEBAR = process.platform === 'darwin';

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
    ...(DIRECTOR_CUSTOM_TITLEBAR
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 14 } }
      : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: join(here, '../preload/index.cjs'),
    },
  });
  win.loadFile(join(here, '../renderer/director/index.html'));
  win.once('ready-to-show', () => win.show());
  // T-M6-60：托盘常驻后「关窗口中控台」= 藏到后台，只有显式退出才允许销毁。
  win.on('close', (event) => {
    if (!shouldHideDirectorOnClose(isQuitting)) return;
    event.preventDefault();
    win.hide();
  });
  return win;
}

/** 同时向中控台与存活的托盘快捷浮窗广播 UI 实时更新。 */
function sendToUiWindows(channel: string, payload?: unknown): void {
  if (directorWindow !== null && !directorWindow.isDestroyed()) {
    directorWindow.webContents.send(channel, payload);
  }
  const popover = trayHost?.popoverWebContents() ?? null;
  if (popover !== null && !popover.isDestroyed()) {
    popover.send(channel, payload);
  }
}

// 托盘常驻必须启用单实例锁（E2E 多进程测试除外），避免 Windows 11 再次双击图标拉起双实例。
const gotSingleInstanceLock = TEST_MODE ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  isQuitting = true;
  app.quit();
}

if (gotSingleInstanceLock) app.whenReady().then(async () => {
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
  // V2-P2-10：pet:sleep-status 必须在中控台窗创建之前注册——中控台 renderer 首挂即调用
  // （director/App.tsx），历史实现在 createDirectorWindow() 之后注册，冷启动在
  // `await petWindowManager.open(...)` 让出事件循环时 renderer 跑赢 boot，报「No handler registered」。
  // 只前移这一条：它只依赖模块级 asleepAgents + 惰性读取的 petWindowManager，无 TDZ 风险；
  // 其余 pet:* handler 的闭包引用 boot 内后声明的 const（prefs/characters/petControl 等），
  // 整组前移会在早期调用时撞 TDZ，因此保持原位。
  registerEarlyIpc({
    ipcMain,
    asleepAgents,
    listAgentIds: () => (petWindowManager?.list() ?? []).map((view) => view.agentId),
  });
  // 随包素材（T-M6-45）：assets/pet-packs → 只读 whale-pet:// 协议；打包后取 Resources/pet-packs
  const petPacksRoot = resolvePetPacksDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: join(here, '../../../..'),
  });
  protocol.handle(PET_PACKS_SCHEME, createPetPacksProtocolHandler({
    packsRoot: petPacksRoot,
    fetchFile: (filePath) => net.fetch(pathToFileURL(filePath).toString()),
  }));
  registerPetPacksIpc({ packsRoot: petPacksRoot });
  if (!existsSync(petPacksRoot)) {
    console.warn(`[pet-packs] 素材目录不存在：${petPacksRoot}（先跑 pnpm sync:pet-packs；随包角色将只剩内置小鲸）`);
  }
  // 供应商凭据库：key 经 safeStorage 加密落盘 userData/provider-vault.json（渲染进程只见掩码）。
  // T-M6-66①：--use-mock-keychain（E2E/调试）的密钥与真实 Keychain 不兼容，强制写隔离文件，
  // 绝不再覆盖正常凭据库；启动时如实打印 Key 来源与可用性（零明文）。
  const vaultPath = resolveVaultPath(app.getPath('userData'), { mockKeychain: isMockKeychainLaunch() });
  registerProviderVaultIpc(vaultPath);
  logVaultStartup(vaultPath);
  const v2KernelHost: V2KernelHost = await createV2KernelHost({
    userDataDir: app.getPath('userData'),
    vaultPath,
  });
  bindCharacterCorePrompt(() => v2KernelHost.characterCore.buildRuntimeContextPrompt());
  app.on('will-quit', () => {
    bindCharacterCorePrompt(null);
    void v2KernelHost.stop();
  });
  // Magpie / CC Switch 只读导入（T-M6-09）：扫描只回掩码，导入时主进程直接加密写 vault
  createProviderImportHost(vaultPath);
  // 星露谷 Mod 管理（T-M6-06）：只读写玩家 Mods 目录，配置落 userData
  const modsHost = createModsHost(app.getPath('userData'));
  void modsHost;
  // 桌宠角色注册表（T-M6-21）：内置 + userData 自定义角色，切换落 PetDesktopPrefs（单点事实源）
  const prefs = (petPrefsStore ??= createPetPrefsStore(app.getPath('userData'), (prev, next) => {
    if (prev.shortcutHideEnabled !== next.shortcutHideEnabled) registerShortcut();
    // T-M6-63：气泡字号/显示层级等全局字段必须广播给所有桌宠窗（不依赖 default 窗口是否已创建）
    for (const target of petBrowserWindows.values()) {
      if (!target.isDestroyed()) target.webContents.send('pet:global-prefs-changed', next);
    }
    if (prev.windowLayer !== next.windowLayer) applyWindowLayerNow();
    // 主分支已移除桌宠缩放入口：不再把旧 PetDesktopPrefs.scale 同步回窗口，
    // 否则任意设置变更都会把 1.0× 窗口重新拉回旧的 1.3×。
    // 旧全局 API 仅作用于 default 窗口；新协作大厅走 pet:window-prefs-set 按 agent 隔离。
    const windowPrefs = petWindowManager?.prefs('default');
    if (windowPrefs === null || windowPrefs === undefined) return;
    if (
      windowPrefs.position.x !== next.position.x
      || windowPrefs.position.y !== next.position.y
      || windowPrefs.position.displayId !== next.position.displayId
    ) {
      petWindowManager?.setPosition('default', next.position);
    }
  }));
  /**
   * 全局角色切换（唯一实现）：写 prefs → 同步 persona → 只改 default 主桌宠 → 广播。
   * 工作跟随「单宠换装」复用此函数，绝不关闭 default（T-M6-51 P0）。
   * T-M6-64：若副宠窗口正好占着目标角色（含夜间睡衣变体），先与旧主宠角色对调，绝不重影。
   * 注意：这里**不**写星露谷外观——启动恢复/召唤/前台应用/工作跟随等后台路径都可能走它，
   * 静默写会让游戏形象在启动时被过期会话覆盖。游戏同步只由用户显式动作触发
   *（共玩页开关/同步当前/一键应用、工作台切角），见 stardew-avatar:* IPC 与 App.selectCharacter。
   */
  function switchDefaultCharacter(id: string): void {
    const previous = prefs.get().characterId;
    const manager = petWindowManager;
    if (manager !== null && previous !== '' && previous !== id) {
      // 与 pet-control-host 共用同一份「基础角色 + 睡衣变体」归一，绝不重影（含夜间睡衣目标）。
      const targetVariants = characterFamilyOf(id);
      const twin = manager.list().find((view) => view.agentId !== 'default' && targetVariants.has(view.characterId));
      if (twin !== undefined) {
        const replacement = characters.list().find((character) => character.id === previous);
        manager.patch(twin.agentId, { characterId: previous });
        manager.sendAgent(twin.agentId, 'pet:character-changed', replacement ?? { id: previous, anchorRatio: 0.5 });
      }
    }
    prefs.patch({ characterId: id });
    const next = characters.selected();
    setCurrentPersonaCharacter(next.id, next.personaPrompt);
    v2KernelHost.characterCore.applyLegacyAppearance({
      id: next.id,
      displayName: next.displayName,
      manifestPath: next.manifestPath,
      anchorRatio: next.anchorRatio,
      licenseScope: next.licenseScope,
      voiceId: next.voiceId,
      personaPrompt: next.personaPrompt,
    });
    // 全局角色快切只作用于 default 主桌宠；其他联机桌宠角色由各自 pet:window-open(agentId, characterId) 固定
    petWindowManager?.patch('default', { characterId: next.id });
    petWindowManager?.sendAgent('default', 'pet:character-changed', { ...next });
    sendToUiWindows('pet:character-changed', next);
  }

  const characters = createCharacterRegistry({
    userDataDir: app.getPath('userData'),
    getPrefs: () => prefs.get(),
    setCharacter: switchDefaultCharacter,
    builtinAssetsDir: join(here, '../renderer/pet-stage/assets'),
    bundled: () => {
      const aboutme = readBundledAboutmePacks(petPacksRoot);
      const crosspet = readCrossPetCharacters(petPacksRoot);
      const bundled = [...aboutme.characters, ...crosspet.characters].flatMap((character) => {
        const manifest = aboutme.manifests.get(character.id) ?? crosspet.manifests.get(character.id);
        return manifest === undefined ? [] : [{ character, manifest }];
      });
      // T-M6-53：userData 自定义角色（含克隆/热重载）与随包角色合并；同 id 随包优先
      const customIds = new Set(bundled.map((pair) => pair.character.id));
      return [...bundled, ...customCharacterPairs(app.getPath('userData')).filter((pair) => !customIds.has(pair.character.id))];
    },
  });
  void characters;

  // T-M6-65：DeepSeek/GLM 峰谷自动换装（仅跨时段边界触发一次，不覆盖同时段手动皮肤）
  let peakState: PeakOutfitState = { lastPeriod: null };
  const peakTick = (): void => {
    const current = prefs.get();
    const decision = decidePeakOutfit(peakState, new Date(), current.characterId, {
      enabled: current.peakOutfitEnabled,
      peakOutfitDay: current.peakOutfitDay,
      peakOutfitOffPeak: current.peakOutfitOffPeak,
    });
    peakState = decision.state;
    if (!decision.apply || decision.skinId === null) return;
    if (!characters.list().some((character) => character.id === decision.skinId)) return;
    switchDefaultCharacter(decision.skinId);
  };
  peakTick();
  const peakTimer = setInterval(peakTick, 60_000);
  peakTimer.unref();
  app.on('will-quit', () => clearInterval(peakTimer));
  ipcMain.handle('pet:peak-status', () => {
    const current = prefs.get();
    return {
      ...resolvePeakPeriod(new Date()),
      characterId: current.characterId,
      family: isPeakOutfitFamily(current.characterId),
      enabled: current.peakOutfitEnabled,
      peakOutfitDay: current.peakOutfitDay,
      peakOutfitOffPeak: current.peakOutfitOffPeak,
    };
  });

  // 语音中心（T-M6-46）：每个角色可独立改绑音色，覆盖值优先于角色包默认
  const voiceBindings = createVoiceBindingStore({
    filePath: join(app.getPath('userData'), 'voice-bindings.json'),
    defaultVoiceOf: (id) => characters.list().find((character) => character.id === id)?.voiceId,
  });
  registerVoiceBindingIpc({ store: voiceBindings, characters: () => characters.list() });

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
    // T-M6-63：macOS 用 screen-saver 层级，Windows 11 用 floating；其他平台交给 Electron 默认
    alwaysOnTopLevel: () => (process.platform === 'darwin' ? 'screen-saver' : process.platform === 'win32' ? 'floating' : undefined),
    onWindowsChanged: (list) => {
      sendToUiWindows('pet:window-list-changed', list);
    },
    // T-M6-48：两只桌宠撞在一起 → 双方 Q 弹互撞 + 互吐槽（真实窗口几何驱动）
    onCollision: ({ a, b }) => {
      const nameOf = (id: string): string => characters.list().find((character) => character.id === id)?.displayName ?? '桌宠';
      petWindowManager?.sendAgent(a.agentId, 'pet:bump', { partner: b.characterId, partnerName: nameOf(b.characterId) });
      petWindowManager?.sendAgent(b.agentId, 'pet:bump', { partner: a.characterId, partnerName: nameOf(a.characterId) });
    },
  });

  // 桌宠控制宿主（T-M6-51 拆分）：召唤/集合/解散/彩蛋 + 对外驱动口 + 相关 IPC
  const petControl = createPetControlHost({
    manager: () => petWindowManager,
    characters: () => characters,
    crossPetCharacters: () => readCrossPetCharacters(petPacksRoot).characters,
    customEggs: () => readCustomCharacters(app.getPath('userData')).entries.filter((entry) => entry.data.egg).map((entry) => entry.character),
    getPrefs: () => prefs.get(),
    switchDefaultCharacter,
    voice: () => voice,
    voiceBindings: () => voiceBindings,
    asleepAgents,
    openNotebook: () => {
      if (directorWindow && !directorWindow.isDestroyed()) {
        directorWindow.show();
        directorWindow.focus();
        directorWindow.webContents.send('pet:open-notebook');
      }
    },
  });
  petControl.registerIpc();
  const summonPet = petControl.summonPet;

  // T-M6-65：15 个 egg-* 彩蛋的双宠小剧场（专属 host/hostSkin 优先，pop→pretend→抓包/溜走）
  const eggTheater = createEggTheater({
    scripts: () => [
      ...readCrossPetEggScripts(petPacksRoot),
      ...readCustomCharacters(app.getPath('userData')).entries
        .filter((entry) => entry.data.egg)
        .map((entry) => ({
          characterId: entry.character.id,
          name: entry.character.displayName,
          host: entry.data.host,
          hostSkin: entry.data.hostSkin,
          aura: entry.data.aura,
          lines: {
            pop: entry.data.lines.pop ?? [],
            pretend: entry.data.lines.pretend ?? [],
            caught: entry.data.lines.caught ?? [],
            bye: entry.data.lines.bye ?? [],
            escape: entry.data.lines.escape ?? [],
          },
        })),
    ],
    openEgg: async (script) => {
      const manager = petWindowManager;
      if (manager === null) return { ok: false, error: '桌宠窗未就绪' };
      // 同角色不并存：彩蛋角色若已作为宠物在场，绝不再开第二只同款彩蛋。
      const available = petControl.assertCharacterAvailable(script.characterId);
      if (!available.ok) return { ok: false, error: available.error };
      const agentId = `egg-${script.characterId.replace(/[^A-Za-z0-9._-]/g, '').slice(-20)}-${Date.now().toString(36).slice(-4)}`;
      const opened = await manager.open(agentId, script.characterId);
      if (!opened.ok) return { ok: false, error: opened.error ?? '彩蛋窗打开失败' };
      // 放在主桌宠右侧，不抢焦点（manager.open 内部 showInactive）
      const main = manager.get('default');
      if (main !== null) {
        manager.setPosition(agentId, { x: main.bounds.x + main.bounds.width + 8, y: main.bounds.y, displayId: prefs.get().position.displayId });
      }
      manager.sendAgent(agentId, 'pet:egg-theater-mode', { active: true });
      return { ok: true, agentId };
    },
    sayEgg: (agentId, text) => { petWindowManager?.sendAgent(agentId, 'pet:say', { text }); },
    sayHost: (text) => { petWindowManager?.sendAgent('default', 'pet:say', { text }); },
    onPhase: (phase, agentId) => { petWindowManager?.sendAgent(agentId, 'pet:pose', { pose: phase }); },
    closeEgg: (agentId) => { petControl.closeAgent(agentId); },
  });
  ipcMain.handle('pet:egg-theater', () => eggTheater.start(prefs.get().characterId));
  ipcMain.handle('egg:catch', () => eggTheater.catch());
  const randomEggTimer = setInterval(() => {
    if (!prefs.get().randomEggEnabled || eggTheater.state() !== 'idle') return;
    if (workFollowRef?.status().sessions.some((session) => session.active) ?? false) return;
    if (Math.random() >= 0.2) return;
    void eggTheater.start(prefs.get().characterId);
  }, 15 * 60_000);
  randomEggTimer.unref();
  app.on('will-quit', () => { clearInterval(randomEggTimer); eggTheater.dismiss(); });

  // T-M6-55：前台应用自动切角（macOS 3s 低频只读轮询；偏好关闭时立即停止并保持手选角色）
  // T-M6-64：always-with-app 策略下，即使不切角也会在检测到对应 AI App 时自动召唤桌宠
  // 注意：watcher.start() 会立即 tick 一次，此时 workFollow 尚未初始化——用函数变量避免 TDZ。
  let presencePolicyOf = (): 'idle-leave' | 'app-exit' | 'always-with-app' => 'idle-leave';
  const frontAppWatcher = createFrontAppWatcher({
    enabled: () => prefs.get().followFrontApp || presencePolicyOf() === 'always-with-app',
    onBundle: (bundleId) => {
      if (isQuitting) return;
      const match = matchCharacterForApp({
        userDataDir: app.getPath('userData'),
        bundleId,
        packsRoot: petPacksRoot,
      });
      if (match === null) return;
      if (presencePolicyOf() === 'always-with-app') {
        void summonPet(petControl.nightOutfit(match.characterId));
      }
      if (!prefs.get().followFrontApp) return;
      if (prefs.get().characterId === match.characterId) return;
      console.log(`[pet] 前台应用 ${bundleId} → 自动切换到 ${match.name}（${match.characterId}）`);
      switchDefaultCharacter(petControl.nightOutfit(match.characterId));
    },
  });
  frontAppWatcher.start();
  app.on('before-quit', () => frontAppWatcher.stop());
  app.on('will-quit', () => frontAppWatcher.stop());

  /** 自定义角色热重载：清缓存 → 广播角色列表 → 每个桌宠窗重载自身 manifest（零重启）。 */
  const reloadCustomCharacters = (): number => {
    invalidateCustomCharacters();
    const fresh = characters.list();
    for (const view of petWindowManager?.list() ?? []) {
      const character = fresh.find((item) => item.id === view.characterId);
      if (character !== undefined) petWindowManager?.sendAgent(view.agentId, 'pet:character-changed', { ...character });
    }
    if (directorWindow && !directorWindow.isDestroyed()) directorWindow.webContents.send('pet:characters-changed');
    return fresh.length;
  };
  ipcMain.handle('pet:reload-characters', () => ({ ok: true, count: reloadCustomCharacters() }));
  createCustomCharacterHost({
    userDataDir: app.getPath('userData'),
    packsRoot: petPacksRoot,
    onReload: () => { reloadCustomCharacters(); },
  }).registerIpc();

  // 创作中心（T-M6-53）：生图提示词/彩蛋台词/拖入处理
  createCreatorHost({
    userDataDir: app.getPath('userData'),
    getDirectorWindow: () => directorWindow,
    vaultPath,
    homeDir: homedir(),
    packsRoot: petPacksRoot,
    chat: async (system, user) => {
      const result = await autodrive.completeForCoop('STARDEW_GAME_PLANNER' as never, system, user, 600);
      return result === null ? null : result.content;
    },
  }).registerIpc();

  // 姿态与场景验收台（T-M6-53）：12 场景直接驱动真实桌宠窗口
  createAcceptanceHost({
    characters: () => characters,
    petControl,
    manager: () => petWindowManager,
    defaultAgentId: () => 'default',
    summonEgg: () => petControl.summonEgg(),
  }).registerIpc();

  // 桌宠右键 / 托盘浮窗入口 → 聚焦或重建中控台并打开对应弹窗
  let showDirectorImpl: () => void = () => {
    if (directorWindow !== null && !directorWindow.isDestroyed()) {
      directorWindow.show();
      directorWindow.focus();
    }
  };
  const focusDirectorWith = (channel: string): { ok: boolean } => {
    trayHost?.hidePopover();
    showDirectorImpl();
    if (directorWindow !== null && !directorWindow.isDestroyed()) {
      directorWindow.webContents.send(channel);
    }
    return { ok: true };
  };
  ipcMain.handle('ui:open-creator', () => focusDirectorWith('ui:open-creator'));
  ipcMain.handle('ui:open-bench', () => focusDirectorWith('ui:open-bench'));

  // 跨 AI 工作跟随（T-M6-49）：只读事件 + 自动召唤/换装/戴皇冠
  let workFollowRef: import('./work-follow-host').WorkFollowHost | null = null;
  /** T-M6-64：活干完后 10s 自动收回贴边的定时器（characterId → timer） */
  const dockBackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelDockBack = (characterId: string): void => {
    const timer = dockBackTimers.get(characterId);
    if (timer !== undefined) {
      clearTimeout(timer);
      dockBackTimers.delete(characterId);
    }
  };
  const workFollow = createWorkFollowHost({
    userDataDir: app.getPath('userData'),
    summon: (characterId) => {
      if (isQuitting) return;
      // 多 AI 同屏最多 4 只跨 AI 桌宠，避免会话多开时窗口爆量
      const crossPets = petWindowManager?.list().filter((view) => view.characterId.startsWith('crosspet-')) ?? [];
      if (crossPets.length >= 4) return;
      // 角色未安装（crosspet 素材包未同步）或同角色已在场都不再静默开窗：如实记日志便于排查。
      void summonPet(characterId).then((result) => {
        if (!result.ok) console.warn(`[work-follow] 召唤 ${characterId} 未开窗：${result.error ?? '未知原因'}`);
      });
    },
    switchCharacter: (characterId) => {
      if (isQuitting) return;
      // 单宠换装：只关掉其他跨 AI 窗口，default 主窗保留并原地换角色（含夜间睡衣）
      petWindowManager?.dismissAll('default');
      switchDefaultCharacter(petControl.nightOutfit(characterId));
    },
    onSessionIdle: (session) => {
      // multi 模式闲置退场：同一角色还有活跃会话时保留窗口
      const stillActive = workFollowRef?.status().sessions.some((item) => item.active && item.characterId === session.characterId) ?? false;
      if (stillActive) return;
      const view = matchPetViewForCharacter(petWindowManager?.list() ?? [], session.characterId, (id) => petControl.nightOutfit(id));
      if (view === undefined) return;
      // 先告别再退场：气泡保留 2.5s 后关窗，避免“突然消失”
      petWindowManager?.sendAgent(view.agentId, 'pet:say', { text: '这边忙完啦，我先撤～下次再一起干活！' });
      setTimeout(() => petControl.closeAgent(view.agentId), 2_500);
    },
    resolveCharacter: (event) => resolveProxyCharacter(app.getPath('userData'), event.source, event.modelName)?.character.id ?? null,
    // T-M6-64：干活时若贴边自动探出；全部会话结束满 10s 且用户未手动拖离 → 自动收回
    onWorkActivity: (session, kind) => {
      const manager = petWindowManager;
      if (manager === null) return;
      const view = matchPetViewForCharacter(manager.list(), session.characterId, (id) => petControl.nightOutfit(id));
      if (view === undefined) return;
      if (kind !== 'stop') {
        cancelDockBack(session.characterId);
        if (manager.isDocked(view.agentId) !== null) void manager.requestAutoUndock(view.agentId);
        return;
      }
      const stillActive = workFollowRef?.status().sessions.some((item) => item.active && item.characterId === session.characterId) ?? false;
      if (stillActive) return;
      cancelDockBack(session.characterId);
      const timer = setTimeout(() => {
        dockBackTimers.delete(session.characterId);
        if (manager.autoUndockedEdge(view.agentId) === null) return;
        const activeNow = workFollowRef?.status().sessions.some((item) => item.active && item.characterId === session.characterId) ?? false;
        if (!activeNow) manager.redockAuto(view.agentId);
      }, 10_000);
      timer.unref?.();
      dockBackTimers.set(session.characterId, timer);
    },
    // T-M6-64：桌宠侧悬浮任务卡（只发标题/状态，最多 4 张）
    onCards: (characterId, cards) => {
      const view = matchPetViewForCharacter(petWindowManager?.list() ?? [], characterId, (id) => petControl.nightOutfit(id));
      if (view !== undefined) petWindowManager?.sendAgent(view.agentId, 'pet:work-cards', { cards });
    },
    onAgentPose: (session, pose) => {
      const view = matchPetViewForCharacter(petWindowManager?.list() ?? [], session.characterId, (id) => petControl.nightOutfit(id));
      if (view === undefined) return;
      const character = characters.list().find((item) => item.id === session.characterId);
      if (character === undefined) return;
      const manifestResult = characters.manifestOf(character);
      const available = manifestResult.ok
        ? [...manifestResult.manifest.actions.flatMap((action) => action.clips.map((clip) => clip.clipId)), ...manifestResult.manifest.ambientPool.map((clip) => clip.clipId)]
        : [];
      // T-M6-64：同角色并发 2 路 → busy，≥3 路 → swamped（渲染色按 busy_left/right 变体解析）
      const activeCount = workFollowRef?.status().sessions.filter((item) => item.active && item.characterId === session.characterId).length ?? 1;
      const effectivePose = activeCount >= 3 ? 'swamped' : activeCount === 2 ? 'busy' : pose;
      const resolved = resolvePose(effectivePose, available);
      let line: string | undefined;
      if (session.characterId.startsWith('custom-')) {
        const entry = readCustomCharacters(app.getPath('userData')).entries.find((item) => item.character.id === session.characterId);
        if (entry !== undefined) line = linesForPose(entry.data, resolved.pose)[0];
      }
      petControl.pose(view.agentId, resolved.pose, line, 'work-follow');
    },
    onCrown: (session) => {
      const view = matchPetViewForCharacter(petWindowManager?.list() ?? [], session.characterId, (id) => petControl.nightOutfit(id));
      if (view !== undefined) petWindowManager?.sendAgent(view.agentId, 'pet:crown', { on: true });
    },
    onUpdate: (status) => {
      sendToUiWindows('work-follow:update', status);
    },
  });
  workFollowRef = workFollow;
  presencePolicyOf = () => workFollow.presencePolicy();
  // T-M6-65：免 Hook 只读日志监听（启动即定位到 EOF，只取 sessionId/kind/tool/model/ts）
  const cliLogWatcher = createCliLogWatcher({
    homeDir: homedir(),
    enabled: () => workFollow.logWatchEnabled(),
    onEvent: (event) => {
      if (isQuitting) return;
      workFollow.ingest(event);
    },
  });
  cliLogWatcher.start();
  app.on('before-quit', () => { cliLogWatcher.stop(); workFollow.dispose(); });
  app.on('will-quit', () => cliLogWatcher.stop());
  // T-M6-58：8 家 CLI 钩子一键安装（只动已知标准 JSON 文件；手动模式只给可复制片段）
  const hookSourceCandidates = app.isPackaged
    ? [join(process.resourcesPath, 'hooks', 'work-follow-hook.mjs')]
    : [
      join(process.cwd(), 'tools/hooks/work-follow-hook.mjs'),
      join(process.cwd(), '../../tools/hooks/work-follow-hook.mjs'),
      join(here, '../../../tools/hooks/work-follow-hook.mjs'),
    ];
  const workFollowInstaller = createWorkFollowInstaller({
    homeDir: homedir(),
    userDataDir: app.getPath('userData'),
    hookSource: hookSourceCandidates.find((candidate) => existsSync(candidate)) ?? hookSourceCandidates[0]!,
  });
  ipcMain.handle('work-follow:cli-status', () => workFollowInstaller.catalog());
  ipcMain.handle('work-follow:cli-install', (_event, source: string) => workFollowInstaller.install(String(source)));
  ipcMain.handle('work-follow:cli-uninstall', (_event, source: string) => workFollowInstaller.uninstall(String(source)));
  ipcMain.handle('work-follow:cli-snippet', (_event, source: string) => ({ ok: true, snippet: workFollowInstaller.manualSnippet(String(source)) }));
  app.on('will-quit', () => workFollow.dispose());
  ipcMain.handle('pet:window-open', async (_event, agentId: string, characterId?: string) => {
    const known = characterId === undefined ? undefined : characters.list().find((character) => character.id === characterId);
    if (characterId !== undefined && known === undefined) return { ok: false, error: `未知角色：${characterId}` };
    // characterId 缺省时回退「当前主宠角色」（已保证存在于注册表）——同样要校验，否则会开出第二只主宠。
    const target = known?.id ?? characters.selected().id;
    const available = petControl.assertCharacterAvailable(target, { exceptAgentId: agentId });
    if (!available.ok) return { ok: false, error: available.error };
    return petWindowManager!.open(agentId, target);
  });
  ipcMain.handle('pet:window-close', (_event, agentId: string) => ({ ok: petWindowManager!.close(agentId) }));
  ipcMain.handle('pet:window-list', () => petWindowManager!.list());
  ipcMain.handle('pet:window-prefs-get', (_event, agentId: string) => petWindowManager!.prefs(agentId));
  ipcMain.handle('pet:window-prefs-set', (_event, agentId: string, update: { scale?: number; locked?: boolean; characterId?: string }) => {
    const next = update ?? {};
    // 只在真正要换角色时校验；纯 scale/locked 更新必须原样放行（pet-stage 启动即调 scale=1）。
    if (typeof next.characterId === 'string' && next.characterId !== '') {
      const available = petControl.assertCharacterAvailable(next.characterId, { exceptAgentId: agentId });
      if (!available.ok) return { ok: false, error: available.error };
    }
    return petWindowManager!.patch(agentId, next);
  });
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
  /** E2E 固定测试点：避免真实鼠标不在桌宠上时 50ms 轮询把透明度立刻复位（套件负载高时偶发） */
  let altTestPoint: { x: number; y: number } | null = null;
  setInterval(() => {
    const point = altTestOverride !== null && altTestPoint !== null ? altTestPoint : screen.getCursorScreenPoint();
    const windows = petWindowManager?.list().map((view) => ({ agentId: view.agentId, bounds: view.bounds })) ?? [];
    petWindowManager?.applyPeekTargets(resolveAltPeekTargets(windows, point, altTestOverride ?? altMonitor.current()));
  }, 50).unref();
  if (TEST_MODE) {
    ipcMain.handle('test:alt-peek', (_event, point: { x: number; y: number }, altDown: boolean) => {
      altTestOverride = altDown;
      altTestPoint = point;
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

  // 语音宿主（V2 生产闭环）：创作与生产统一走 V2 VoiceProviderRouter + 真实 WAV 口型包络 + 失败不静默换声
  let activeLipPlayer: LipSyncTimelinePlayer | null = null;
  let lipPlayerDrivenByRealWav = false;
  const startLipTimeline = (agentId: string, frames: ReturnType<typeof synthesizeTextLipSyncFrames>, realWav: boolean): void => {
    activeLipPlayer?.stop(true);
    activeLipPlayer = null;
    lipPlayerDrivenByRealWav = realWav;
    activeLipPlayer = new LipSyncTimelinePlayer({
      frames,
      onFrame: (frame) => {
        petWindowManager?.broadcast('pet:lip-sync', { agentId, frame });
      },
    });
    activeLipPlayer.start();
  };
  const voice = createVoiceHost(process.platform, {
    resolveVoiceId: (characterId) => voiceBindings.resolve(characterId) ?? null,
    synthesize: (input) => v2KernelHost.synthesizeForProduction(input),
    onLipFrames: ({ agentId, frames }) => {
      startLipTimeline(agentId, frames, true);
    },
    onSpeakerChange: (event) => {
      v2KernelHost.audioMixer.setSpeechDucking(event.state === 'speaking');
      if (event.state === 'speaking' && event.activeAgentId !== null) {
        if (!lipPlayerDrivenByRealWav) {
          const frames = synthesizeTextLipSyncFrames(event.speakerName || '小鲸', 1800, 60);
          startLipTimeline(event.activeAgentId, frames, false);
        }
      } else {
        activeLipPlayer?.stop(true);
        activeLipPlayer = null;
        lipPlayerDrivenByRealWav = false;
        petWindowManager?.broadcast('pet:lip-sync', {
          agentId: 'default',
          frame: { timestampMs: 0, durationMs: 0, viseme: 'closed', amplitude: 0, rmsDb: -80 },
        });
      }
      petWindowManager?.broadcast('coop:speaker', { ...event });
      if (directorWindow && !directorWindow.isDestroyed()) directorWindow.webContents.send('coop:speaker', event);
    },
    onSpeechResult: (event) => {
      activeLipPlayer?.stop(true);
      activeLipPlayer = null;
      lipPlayerDrivenByRealWav = false;
      petWindowManager?.broadcast('pet:speech-result', { ...event });
      if (directorWindow && !directorWindow.isDestroyed()) directorWindow.webContents.send('pet:speech-result', event);
    },
  });
  app.on('will-quit', () => {
    activeLipPlayer?.stop(false);
    activeLipPlayer = null;
  });
  /**
   * 试听走 V2 语音路由：用 prefs 里选中的商业 provider，而不是无条件 spawn mcode-tools。
   * 选中的那家不可用时由 `resolveCommercialTtsProvider` 如实回落并标 `degraded`，
   * 绝不把「其实换了一家」说成「就是你要的那家」。
   */
  registerVoiceHostIpc(voice, {
    synthesizeAudition: async ({ mode, text }) => {
      const statuses = await v2KernelHost.voiceRouter.listStatuses();
      const available = statuses.filter((status) => status.available).map((status) => status.kind);
      const preference = petPrefsStore?.get().voiceCommercialProvider ?? 'minimax-tts';
      const choice = resolveCommercialTtsProvider({ preference, available });
      const identity = v2KernelHost.characterCore.profile.voiceIdentity();
      const out = await v2KernelHost.voiceRouter.synthesize(
        {
          requestId: randomUUID(),
          characterId: identity.characterId,
          voiceRef: v2KernelHost.voiceRouter.resolveVoiceRef(identity),
          text,
          // 语音中心五档的档位 id 直接当情绪键，MiMo 的风格指令/标签按它取值
          emotion: mode,
          styleMode: mode === 'sleepy' ? 'inner' : 'normal',
        },
        { preferredProvider: choice.provider },
      );
      return {
        providerKind: out.providerKind,
        format: out.format,
        ...(out.audioBase64 === undefined ? {} : { audioBase64: out.audioBase64 }),
        degraded: out.degraded || !choice.honored,
        ...(out.degradedFrom === undefined
          ? (choice.honored ? {} : { degradedFrom: preference })
          : { degradedFrom: out.degradedFrom }),
      };
    },
  });
  // 记忆图谱（T-M5-04）：回执入图谱 + 聊天检索
  const memory = createMemoryHost(app.getPath('userData'));
  void dayKeyOf;
  // 友谊 / 小本子 / 互聊 / 久坐喝水提醒（T-M6-48）
  const friendship = createFriendshipHost({
    userDataDir: app.getPath('userData'),
    characters: () => characters.list(),
    speak: (characterId, text) => {
      const character = characters.list().find((item) => item.id === characterId);
      void voice.speak({
        text,
        scene: 'normal',
        ...(character === undefined ? {} : {
          characterId: character.id,
          speakerName: character.displayName,
          voiceId: voiceBindings.resolve(character.id) ?? character.voiceId,
          ratePercent: character.voiceRatePercent,
          pitchMul: character.voicePitchMul,
        }),
      });
    },
    remember: (text) => { memory.store.addNode({ nodeType: 'event', text }); },
    customCharacter: (characterId) => {
      const entry = readCustomCharacters(app.getPath('userData')).entries.find((item) => item.character.id === characterId);
      if (entry === undefined) return null;
      return { milestones: entry.data.milestones, notebook: entry.data.notebook };
    },
  });
  registerFriendshipIpc(friendship, {
    activeCharacterIds: () => (petWindowManager?.list() ?? []).filter((view) => view.visible).map((view) => view.characterId),
  });
  // T-M6-65：冷启动只读历史补录（幂等；只统计时间/模型/工具数，绝不读正文）
  ipcMain.handle('friendship:backfill-history', async () => {
    try {
      return await backfillCliHistory({ userDataDir: app.getPath('userData') });
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // 桌宠睡眠态由渲染层上报：提醒在任一桌宠入睡期间免打扰
  ipcMain.on('pet:sleep-state', (_event, agentId: string, asleep: boolean) => {
    if (asleep) asleepAgents.add(agentId);
    else asleepAgents.delete(agentId);
  });
  // 久坐/喝水提醒：60s 轮询，23:00–07:00 与睡眠态由 host 内部免打扰
  const reminderTimer = setInterval(() => {
    const reminder = friendship.tickReminders(Date.now(), asleepAgents.size > 0);
    if (reminder === null) return;
    const character = characters.selected();
    void voice.speak({
      text: reminder.text,
      scene: 'normal',
      characterId: character.id,
      speakerName: character.displayName,
      voiceId: voiceBindings.resolve(character.id) ?? character.voiceId,
    });
  }, 60_000);
  app.on('will-quit', () => { clearInterval(reminderTimer); friendship.close(); });

  // T-M6-31：外部插件生产链路（发现/启停/工具注册/审批/崩溃隔离）
  const plugins = createPluginHost({
    userDataDir: app.getPath('userData'),
    windows: () => [...petBrowserWindows.values(), directorWindow].filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.webContents),
    petApi: {
      state: (agentId) => petControl.petControlApi.state(agentId),
      say: (agentId, text, request) => petControl.petControlApi.say(agentId, text, request),
      action: (agentId, actionState, durationMs) => petControl.petControlApi.action(agentId, actionState, durationMs),
    },
  });
  // autodrive 宿主（T-M5-02）：事件单源多播到两窗；启停由 Shell 显式触发；端口随 modsHost 可配置项联动
  // E2E 指向仿真 BWF 时固定用注入端点，无视真实 Mods 端口变化（[SIMULATION]，仅测试态）。
  const mainGameEndpoint = (): string => resolveBwfEndpoint({ testEndpoint: TEST_BWF_ENDPOINT, port: modsHost.bwfMcpPort });
  const autodrive = createAutodriveHost(
    mainGameEndpoint(),
    vaultPath,
    voice,
    memory,
    'stardew',
    undefined,
    () => coopHost?.list().some((agent) => agent.running && agent.endpoint === mainGameEndpoint())
      ? '该端点已被「联机协作」页接管；请先停止对应 AI 队友，避免两个 Runner 抢同一角色'
      : null,
    characters,
  );
  v2KernelHost.attachV1Bridges({ autodrive, voice, memory });
  // V2-P3-04F：Digital Life L1 浏览状态投影到桌宠气泡（复用既有 pet:bubble 通道，不新增协议）
  // owner 口径（2026-11-26）：只报「开始一句 + 收官一句」，不逐条刷屏，所以不订阅 social.session.viewed。
  const petBubbleToDefault = (text: string): void => {
    const win = petBrowserWindows.get('default');
    if (win && !win.isDestroyed()) win.webContents.send('pet:bubble', { agentId: 'default', text, kind: 'thought' });
  };
  v2KernelHost.kernel.events.subscribe('social.session.started', () => {
    petBubbleToDefault('我去看看大家最近在聊什么～');
  });
  v2KernelHost.kernel.events.subscribe('social.session.completed', (event) => {
    const payload = event.payload as { session?: { itemsViewed?: number; stopReason?: string } };
    petBubbleToDefault(`本次浏览收官，看了 ${payload.session?.itemsViewed ?? 0} 条（${payload.session?.stopReason ?? '完成'}）`);
  });
  modsHost.onBwfPortChange((port) => {
    if (TEST_BWF_ENDPOINT !== undefined) return; // E2E 固定仿真端点，不被真实端口联动覆盖
    void autodrive.setEndpoint(bwfMcpEndpoint(port));
  });
  // 多桌宠联机协作（T-M6-39）：复用 autodrive 的 Gateway/饭碗，但每 Agent 独立 planner/persona/voice。
  coopHost = createCoopHost({
    userDataDir: app.getPath('userData'),
    windows: () => [...petBrowserWindows.values(), directorWindow].filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.webContents),
    brain: autodrive,
    voiceHost: voice,
    petWindows: petWindowManager,
    characters,
    assertCharacterAvailable: (characterId, exceptAgentId) => petControl.assertCharacterAvailable(characterId, { exceptAgentId }),
    isEndpointBusyByMain: (endpoint) => endpoint === mainGameEndpoint() && autodrive.runner.isRunning(),
    // 联机求助接力 / 共同目标完成 → 对应角色涨好感（T-M6-48）
    onFriendshipEvent: (kind, agentId) => {
      const endpoint = coopHost?.list().find((item) => item.id === agentId);
      if (endpoint !== undefined) friendship.record(kind, endpoint.characterId);
    },
  });

  // T-M6-62：星露谷桌宠像素外观同步（安装 Mod / 开关 / 原子写 active-avatar.json）
  const stardewAvatar = createStardewAvatarHost({
    userDataDir: app.getPath('userData'),
    homeDir: homedir(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: join(here, '../../../..'),
    // E2E 绝不能写到用户真实星露谷 Mods 目录：测试开关/切角只落在 e2e-profile 下的空 Mods 槽位
    ...(process.env.PET_STAGE_E2E === '1'
      ? { modsDirOverride: join(app.getPath('userData'), 'e2e-mods') }
      : {}),
    // 任何写入/安装/开关变化都广播给渲染层，避免共玩页的「游戏内当前角色」显示过期状态
    onChange: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('stardew-avatar:changed');
      }
    },
  });
  ipcMain.handle('stardew-avatar:state', () => stardewAvatar.state());
  ipcMain.handle('stardew-avatar:set-enabled', (_event, next: boolean) => {
    const state = stardewAvatar.setEnabled(Boolean(next));
    if (state.enabled) {
      const current = characters.selected();
      stardewAvatar.syncCharacter({ characterId: current.id, displayName: current.displayName });
    }
    return stardewAvatar.state();
  });
  ipcMain.handle('stardew-avatar:set-liveliness', (_event, next: boolean) => {
    const state = stardewAvatar.setLiveliness(Boolean(next));
    if (state.enabled && state.modInstalled) {
      const targetId = state.syncedCharacterId ?? characters.selected().id;
      const targetName = state.syncedDisplayName
        ?? characters.list().find((character) => character.id === targetId)?.displayName
        ?? targetId;
      stardewAvatar.syncCharacter({ characterId: targetId, displayName: targetName });
    }
    return stardewAvatar.state();
  });
  ipcMain.handle('stardew-avatar:install', () => stardewAvatar.installMod());
  ipcMain.handle('stardew-avatar:uninstall', () => stardewAvatar.uninstallMod());
  ipcMain.handle('stardew-avatar:sync-now', () => {
    const current = characters.selected();
    return stardewAvatar.syncCharacter({ characterId: current.id, displayName: current.displayName });
  });
  ipcMain.handle('stardew-avatar:apply-character', (_event, characterId: unknown) => {
    const id = typeof characterId === 'string' ? characterId : '';
    if (!isSafeCharacterId(id)) return { ok: false, error: '角色 id 非法（只允许小写字母/数字/连字符）' };
    const known = characters.list().find((character) => character.id === id);
    if (known === undefined) return { ok: false, error: `未知角色：${id.slice(0, 64)}` };
    return stardewAvatar.syncCharacter({ characterId: id, displayName: known.displayName });
  });

  // 联机启动器宿主（T-M6-51 拆分）：探测/隔离 profile/参数数组 spawn 全部在此
  const coopLaunch = createCoopLaunchHost({
    userDataDir: app.getPath('userData'),
    platform: process.platform,
    homeDir: homedir(),
    repoRoot: join(here, '../../../..'),
    endpoints: () => (coopHost?.list() ?? []).map((item) => ({
      id: item.id,
      gameId: item.gameId,
      routingId: item.routingId,
      characterId: item.characterId,
      endpoint: item.endpoint,
    })),
    avatarSync: stardewAvatar,
    characterName: (id) => characters.list().find((character) => character.id === id)?.displayName ?? id,
  });
  coopLaunch.registerIpc();
  // T-M6-37：直播最小链路（弹幕回放 → 护栏 → 注意力 → 中控台/插件总线/语音）
  const live = createLiveHost({
    windows: () => [...petBrowserWindows.values(), directorWindow].filter((w): w is NonNullable<typeof w> => w !== null).map((w) => w.webContents),
    voiceHost: voice,
    onPluginEvent: (event, payload) => plugins.emit(event, payload),
  });
  // 自驾事件进插件总线（插件只能经总线观察，不直接访问 autodrive）
  autodrive.subscribe((event) => plugins.emit('autodrive:event', event));

  // ── T-M6-63：显示层级 follow-ai 的 AI 活跃判定 ──
  // 活跃 = 工作跟随有活跃会话 | ACP 待审批 | 自驾回执后 15s 缓冲。
  let lastAutodriveReceiptAt = 0;
  let acpPendingUntil = 0;
  autodrive.subscribe((event) => { if (event.type === 'receipt') lastAutodriveReceiptAt = Date.now(); });
  let lastLayerKey = '';
  applyWindowLayerNow = (): void => {
    const manager = petWindowManager;
    if (manager === null) return;
    const workActive = workFollowRef?.status().sessions.some((session) => session.active) ?? false;
    const aiActive = workActive || Date.now() < acpPendingUntil || Date.now() - lastAutodriveReceiptAt < 15_000;
    const layer = prefs.get().windowLayer;
    const key = `${layer}:${aiActive}`;
    if (key === lastLayerKey) return;
    lastLayerKey = key;
    manager.applyWindowLayer(layer, aiActive);
  };
  const layerTimer = setInterval(applyWindowLayerNow, 1_000);
  layerTimer.unref();
  applyWindowLayerNow();
  app.on('will-quit', () => clearInterval(layerTimer));

  // ACP 会话 id 缓存：session-started / permission / exit 必须落在同一个 sessionId 上，
  // 否则在工作跟随面板会分裂成“开始一个、工具记到另一个、退出又一个”的幽灵会话。
  const acpSessions = createAcpSessionCache();
  const harness = createHarnessHost({
    // ACP 事件镜像到工作跟随（只取事件类型/工具名/会话 id，不碰正文）
    onEvent: (presetId, event) => {
      if (event.type === 'session-started') {
        const sessionId = acpSessions.onStarted(presetId, event.sessionId);
        workFollow.ingest({ source: 'acp', sessionId, kind: 'start', modelName: presetId, taskTitle: presetId });
      } else if (event.type === 'permission') {
        // 待审批 = AI 在等用户，属于活跃；120s 内无后续也自然过期
        acpPendingUntil = Date.now() + 120_000;
        workFollow.ingest({ source: 'acp', sessionId: acpSessions.resolve(presetId), kind: 'asking', toolName: event.toolName });
      } else if (event.type === 'exit') {
        acpPendingUntil = 0;
        workFollow.ingest({ source: 'acp', sessionId: acpSessions.onExit(presetId), kind: 'stop' });
      }
    },
  });
  // 三游戏桥接探活（T-M6-25）：只读探测当前配置端口（星露谷默认 18088 / 泰拉瑞亚 18090 / 饥荒 18100），结果如实回报
  ipcMain.handle('game:health', async (_event, gameId: GameId, endpoint?: string) => {
    const resolvedEndpoint = endpoint ?? (gameId === 'stardew' ? mainGameEndpoint() : undefined);
    // E2E 确定性：stardew-launcher.e2e 全用例假设游戏离线，本机真机游戏在线时真实探测会让横幅/提示路径测不到
    if (TEST_MODE && process.env.WHALE_E2E_GAME_OFFLINE === '1') {
      return {
        gameId,
        endpoint: resolvedEndpoint ?? '',
        status: 'offline' as const,
        ok: false,
        latencyMs: 0,
        detail: 'E2E 强制离线（WHALE_E2E_GAME_OFFLINE=1），未真实探测',
        guidance: GAME_CONNECT_GUIDANCE[gameId],
        checkedAt: Date.now(),
      };
    }
    try {
      return await probeGameHealth(gameId, { ...(resolvedEndpoint === undefined ? {} : { endpoint: resolvedEndpoint }) });
    } catch (error) {
      return {
        gameId,
        endpoint: resolvedEndpoint ?? '',
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
  // V2-P3-05 / V2-P3-07 星露谷启动与从 0 建档（默认隔离目录 + 中文 + 像素形象同步不改名；E2E 默认装配假启动器，显式 WHALE_E2E_REAL_STARDEW_LAUNCHER=1 时直通真实启动器）
  const stardewLaunchPrefs = createStardewLaunchPrefs(app.getPath('userData'));
  const stardewIsolatedDir = defaultIsolatedDataDir(app.getPath('userData'));
  const useFakeStardewLauncher = TEST_MODE && process.env.WHALE_E2E_REAL_STARDEW_LAUNCHER !== '1';
  const stardewLauncher = useFakeStardewLauncher
    ? createFakeStardewLauncher({ defaultIsolateDataDir: stardewIsolatedDir })
    : createStardewLauncher({
      defaultIsolateDataDir: stardewIsolatedDir,
      syncAvatar: ({ characterId, farmerName, modsPath }) => {
        const id = characterId ?? characters.selected().id;
        if (modsPath) {
          return stardewAvatar.writeForProfile({
            profileModsDir: modsPath,
            characterId: id,
            displayName: farmerName,
            syncDisplayName: false,
          });
        }
        return stardewAvatar.syncCharacter({
          characterId: id,
          displayName: farmerName,
          syncDisplayName: false,
          force: true,
        });
      },
    });
  ipcMain.handle('stardew:launch', async (_event, rawOptions?: unknown) => {
    if (rawOptions !== undefined && rawOptions !== null && (typeof rawOptions !== 'object' || Array.isArray(rawOptions))) {
      return stardewLauncher.launch(rawOptions as never);
    }
    const prefsNow = stardewLaunchPrefs.get();
    const input = (rawOptions ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      ...input,
      ...(input.storageMode === undefined && input.isolateDataDir === undefined ? { storageMode: prefsNow.storageMode } : {}),
      ...(input.language === undefined ? { language: prefsNow.language } : {}),
    };
    if ((merged.savePolicy === 'always_new' || merged.savePolicy === 'continue_or_create') && merged.newSave === undefined) {
      const selected = characters.selected();
      const mode = merged.gameMode === 'coop_host' ? 'coop_host' : 'singleplayer';
      merged.newSave = {
        farmerName: selected.displayName.slice(0, 24) || '小鲸',
        farmName: prefsNow.farmName,
        favoriteThing: prefsNow.favoriteThing,
        farmType: prefsNow.farmType,
        mode,
        startingCabins: mode === 'coop_host' ? prefsNow.startingCabins : 0,
        cabinLayout: prefsNow.cabinLayout,
        skipIntro: prefsNow.skipIntro,
        appearance: {
          characterId: selected.id,
          syncPixelAvatar: prefsNow.syncPixelAvatar,
        },
      };
    }
    if (TEST_BWF_ENDPOINT === undefined && typeof merged.port === 'number' && Number.isInteger(merged.port)) {
      void autodrive.setEndpoint(bwfMcpEndpoint(merged.port));
    }
    return stardewLauncher.launch(merged as never);
  });
  ipcMain.handle('stardew:launch-status', () => stardewLauncher.status());
  ipcMain.handle('stardew:launch-cancel', () => stardewLauncher.cancel());
  ipcMain.handle('stardew:launch-prefs-get', () => stardewLaunchPrefs.get());
  ipcMain.handle('stardew:launch-prefs-set', (_event, update?: unknown) => stardewLaunchPrefs.patch(update));
  ipcMain.handle('stardew:launch-defaults', () => {
    const current = characters.selected();
    return {
      characterId: current.id,
      farmerName: current.displayName.slice(0, 24) || '小鲸',
      spriteReady: stardewAvatar.spriteReady(current.id),
      isolatedDataDir: stardewIsolatedDir,
      prefs: stardewLaunchPrefs.get(),
      recommendedLanguage: mapLocaleToStardewLanguage('zh-CN'),
    };
  });
  app.on('will-quit', () => stardewLauncher.dispose());
  // WebUI 形态（T-M6-04）：本机浏览器复核口（HTTP/WS + 远程审批）。
  // 包裹 try/catch：WebUI 起不来只告警，绝不拖垮 Electron 主进程。
  try {
    const webui = createWebUIServer({
      petApi: {
        state: (agentId) => petControl.petControlApi.state(agentId),
        say: (agentId, request) => petControl.petControlApi.say(agentId, request.text, { scene: request.scene, wake: request.wake }),
        action: (agentId, request) => petControl.petControlApi.action(agentId, request.actionState, request.durationMs),
      },
      getState: () => ({
        running: autodrive.runner.isRunning(),
        brainMode: autodrive.getBrainMode().mode,
        characterName: characters.selected().displayName,
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
    webuiRef = { port: webui.port, token: webui.token };
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
    const popoverWc = trayHost?.popoverWebContents() ?? null;
    const targets = [
      ...[...petBrowserWindows.values(), directorWindow]
        .filter((w): w is NonNullable<typeof w> => w !== null && !w.isDestroyed())
        .map((w) => w.webContents),
      ...(popoverWc !== null && !popoverWc.isDestroyed() ? [popoverWc] : []),
    ];
    autodrive.setTargets(targets);
    harness.setTargets(targets);
    plugins.setTargets(targets);
    live.setTargets(targets);
  };
  if (TEST_MODE) {
    // E2E：无头环境没有真实 Tray，直接打开/隐藏复用浮窗，并回报真实坐标。
    // 提前注册（boot 顶部、任何 await 之前）：preload 暴露 directorBridge 时 handler 必须已就位，
    // 否则 renderer 偶尔跑赢 boot 报「无 handler」竞态；内部 await trayHostReady，
    // 保证 'open'/'hide' 调用时 trayHost 已建好（不成活则静默 no-op + 假 ok 超时）。
    ipcMain.handle('test:tray-popover', async (_event, action: 'open' | 'hide' | 'bounds') => {
      await trayHostReady;
      if (action === 'open') trayHost?.showPopover();
      else if (action === 'hide') trayHost?.hidePopover();
      return { ok: true, bounds: trayHost?.lastBounds() ?? null, visible: trayHost?.isPopoverVisible() ?? false };
    });
  }
  // 中控台先立即可用；默认桌宠需要在 loadFile 完成后才出现在窗口列表，避免 UI 空等。
  directorWindow = createDirectorWindow();
  const openedDefault = await petWindowManager.open('default', prefs.get().characterId);
  if (!openedDefault.ok) console.error('[pet-window] 默认桌宠窗启动失败：', openedDefault.error);
  stageWindow = petBrowserWindows.get('default') ?? null;
  wireTargets();

  /** 中控台显示/重建（托盘菜单、浮窗按钮、Dock 激活、单实例唤起共用）。 */
  const showDirector = (): void => {
    if (directorWindow !== null && !directorWindow.isDestroyed()) {
      directorWindow.show();
      directorWindow.focus();
      return;
    }
    directorWindow = createDirectorWindow();
    wireTargets();
  };
  showDirectorImpl = showDirector;
  app.on('second-instance', () => {
    showDirector();
  });

  /** 真正退出：先停 agent 池、销毁托盘，再让 Electron 关闭所有窗口。 */
  const quitApp = (): void => {
    if (isQuitting) {
      app.quit();
      return;
    }
    isQuitting = true;
    coopHost?.stopAll();
    trayHost?.destroy();
    trayHost = null;
    app.quit();
  };

  ipcMain.handle('ui:open-director', () => {
    trayHost?.hidePopover();
    showDirector();
    return { ok: true };
  });
  ipcMain.handle('app:quit', () => {
    quitApp();
    return { ok: true };
  });
  ipcMain.handle('app:copy-text', (_event, text: string) => {
    clipboard.writeText(String(text).slice(0, 20_000));
    return { ok: true };
  });
  ipcMain.handle('tray:popover-hide', () => {
    trayHost?.hidePopover();
    return { ok: true };
  });
  ipcMain.handle('pet:windows-visible', (_event, visible: boolean) => {
    const manager = petWindowManager;
    if (manager === null) return { ok: false, visible: Boolean(visible), count: 0, error: '桌宠窗未就绪' };
    const count = manager.list().length;
    if (visible) manager.showAll();
    else manager.hideAll();
    return { ok: true, visible: Boolean(visible), count };
  });
  ipcMain.handle('pet:sleep-all', (_event, asleep: boolean) => {
    const manager = petWindowManager;
    if (manager === null) return { ok: false, asleep: Boolean(asleep), count: 0, error: '桌宠窗未就绪' };
    const list = manager.list();
    for (const view of list) {
      if (asleep) asleepAgents.add(view.agentId);
      else asleepAgents.delete(view.agentId);
      manager.sendAgent(view.agentId, 'pet:bench-sleep', { asleep: Boolean(asleep) });
    }
    return { ok: true, asleep: Boolean(asleep), count: list.length };
  });
  ipcMain.handle('pet:dock-all', () => {
    const manager = petWindowManager;
    if (manager === null) return { ok: false, docked: 0, error: '桌宠窗未就绪' };
    const list = manager.list();
    for (const view of list) {
      const display = screen.getDisplayMatching(view.bounds);
      const center = view.bounds.x + view.bounds.width / 2;
      const edge = center < display.workArea.x + display.workArea.width / 2 ? 'left' : 'right';
      manager.dock(view.agentId, edge);
    }
    return { ok: true, docked: list.length };
  });
  ipcMain.handle('pet:context-menu', (event, rawAgentId?: string) => {
    const manager = petWindowManager;
    if (manager === null) return { ok: false };
    const agentId = typeof rawAgentId === 'string' && rawAgentId.trim() !== '' ? rawAgentId.trim() : 'default';
    const win = BrowserWindow.fromWebContents(event.sender) ?? petBrowserWindows.get(agentId) ?? stageWindow;
    if (win === null || win.isDestroyed()) return { ok: false };
    const view = manager.get(agentId);
    const allCharacters = characters.list();
    const characterId = view?.characterId ?? prefs.get().characterId;
    const character = allCharacters.find((item) => item.id === characterId) ?? characters.selected();
    const manifestResult = characters.manifestOf(character);
    const manifest = manifestResult.ok ? manifestResult.manifest : null;
    const selectable = allCharacters.filter((item) => !(item.packId ?? '').startsWith('crosspet-'));
    const bundled = selectable.filter((item) => item.packId !== undefined);
    const customs = selectable.filter((item) => !item.builtin && item.packId === undefined);
    const switchableCharacters = (bundled.length > 0 ? [...customs, ...bundled.slice(0, 9)] : selectable)
      .map((item) => ({ id: item.id, displayName: item.displayName }));
    const summonableCharacters = switchableCharacters.filter((item) => item.id !== character.id);
    const gameLabels: Record<GameId, string> = { stardew: '星露谷物语', terraria: '泰拉瑞亚', dst: '饥荒 DST' };
    const rice = autodrive.riceStatus();
    const sendBubble = (text: string): void => { manager.sendAgent(agentId, 'pet:bubble', { text, kind: 'dialog' }); };
    const template = buildPetContextMenuTemplate({
      agentId,
      isDefault: agentId === 'default',
      characterId: character.id,
      characterName: character.displayName,
      asleep: asleepAgents.has(agentId),
      locked: view?.locked ?? false,
      windowLayer: prefs.get().windowLayer,
      availableActions: (manifest?.actions ?? []).map((entry) => ({
        actionState: entry.actionState,
        label: labelForActionState(entry.actionState),
      })),
      hasAmbientPool: (manifest?.ambientPool.length ?? 0) > 0,
      switchableCharacters,
      summonableCharacters,
      onlinePetCount: manager.list().filter((item) => item.visible).length,
      autodriveRunning: autodrive.runner.isRunning(),
      gameLabel: gameLabels[autodrive.getGameId()],
      riceBalance: rice.balance,
      riceBudget: rice.budget,
      voiceEnabled: voice.config.enabled,
      sfxEnabled: prefs.get().sfxEnabled,
      webuiUrl: webuiRef === null ? null : 'ready',
    }, {
      onPat: () => {
        asleepAgents.delete(agentId);
        manager.sendAgent(agentId, 'pet:bench-sleep', { asleep: false });
        friendship.record('pat', character.id);
        manager.sendAgent(agentId, 'pet:preview', { action: 'happy_maid', clipId: null });
        sendBubble('嘿嘿，被摸头啦～');
      },
      onPoke: () => {
        asleepAgents.delete(agentId);
        manager.sendAgent(agentId, 'pet:bench-sleep', { asleep: false });
        friendship.record('poke', character.id);
        manager.sendAgent(agentId, 'pet:preview', { action: 'rage_spray', clipId: null });
        sendBubble(characterPokeLine(character.id));
      },
      onPlayAction: (actionState) => {
        asleepAgents.delete(agentId);
        manager.sendAgent(agentId, 'pet:bench-sleep', { asleep: false });
        manager.sendAgent(agentId, 'pet:preview', { action: actionState, clipId: null });
      },
      onPlayRandomAmbient: () => {
        asleepAgents.delete(agentId);
        manager.sendAgent(agentId, 'pet:bench-sleep', { asleep: false });
        manager.sendAgent(agentId, 'pet:preview', { action: 'idle', clipId: '__random__' });
      },
      onOpenQuickChat: () => { trayHost?.showPopover(); },
      onToggleSleep: () => {
        const next = !asleepAgents.has(agentId);
        if (next) asleepAgents.add(agentId);
        else asleepAgents.delete(agentId);
        manager.sendAgent(agentId, 'pet:bench-sleep', { asleep: next });
      },
      onSwitchCharacter: (nextId) => {
        switchDefaultCharacter(nextId);
        if (stardewAvatar.state().enabled) {
          const next = characters.selected();
          stardewAvatar.syncCharacter({ characterId: next.id, displayName: next.displayName });
        }
      },
      onSummonCharacter: (targetId) => {
        void summonPet(targetId).then((result) => {
          const target = allCharacters.find((item) => item.id === targetId);
          sendBubble(result.ok ? `${target?.displayName ?? '伙伴'}来陪你啦！` : (result.error ?? '召唤失败'));
        });
      },
      onAssemble: () => { manager.assemble(manager.list().map((item) => item.agentId)); },
      onDismissOthers: () => { manager.dismissAll('default'); },
      onPairChat: () => {
        const ids = manager.list().filter((item) => item.visible).map((item) => item.characterId);
        const result = friendship.pairChat(ids);
        if (!result.ok) sendBubble(result.error);
      },
      onSummonEgg: () => {
        void petControl.summonEgg().then((result) => {
          if (!result.ok) sendBubble(result.error ?? '没有可召唤的彩蛋');
        });
      },
      onStartEggTheater: () => {
        void eggTheater.start(character.id).then((result) => {
          if (!result.ok) sendBubble(result.error ?? '彩蛋小剧场启动失败');
        }).catch((error: unknown) => { sendBubble(error instanceof Error ? error.message : String(error)); });
      },
      onSetWindowLayer: (layer) => {
        prefs.patch({ windowLayer: layer });
        applyWindowLayerNow();
        sendBubble(layer === 'always' ? '已设为始终置顶' : layer === 'follow-ai' ? 'AI 干活时才置顶' : '已切换为普通窗口层级');
      },
      onToggleAutodrive: () => {
        void autodrive.toggleDrive().then((result) => {
          if (!result.ok) sendBubble(result.error ?? '自驾启动失败');
          else sendBubble(result.running ? `自驾已启动：${gameLabels[autodrive.getGameId()]}` : '已停止自驾，控制权交还给你');
        });
      },
      onFeedRice: () => {
        const updated = autodrive.feedRice(10_000);
        const pct = updated.budget > 0 ? Math.round((updated.balance / updated.budget) * 100) : 100;
        manager.sendAgent(agentId, 'pet:preview', { action: 'eat_rice', clipId: null });
        sendBubble(`加饭成功！饭碗余量 ${pct}%`);
      },
      onSyncStardewAvatar: () => {
        const synced = stardewAvatar.syncCharacter({ characterId: character.id, displayName: character.displayName });
        sendBubble(synced.ok ? `已同步「${character.displayName}」到星露谷外观` : (synced.error ?? '星露谷外观同步失败'));
      },
      onToggleLock: () => {
        manager.patch(agentId, { locked: !(view?.locked ?? false) });
      },
      onDock: (edge) => {
        if (edge === null) void manager.undock(agentId);
        else manager.dock(agentId, edge);
      },
      onResetPosition: () => {
        const area = screen.getPrimaryDisplay().workArea;
        const bounds = view?.bounds ?? { width: 400, height: 284 };
        const x = Math.max(area.x, area.x + area.width - bounds.width - 24);
        const y = Math.max(area.y, area.y + area.height - bounds.height - 24);
        manager.clearDock(agentId);
        manager.setPosition(agentId, { x, y, displayId: String(screen.getPrimaryDisplay().id) });
        prefs.patch({ position: { x, y, displayId: String(screen.getPrimaryDisplay().id) } });
      },
      onHideAllPets: () => { manager.hideAll(); },
      onToggleVoice: () => { voice.setConfig({ enabled: !voice.config.enabled }); },
      onToggleSfx: () => { prefs.patch({ sfxEnabled: !prefs.get().sfxEnabled }); },
      onOpenDirector: () => { trayHost?.hidePopover(); showDirector(); },
      onOpenNotebook: () => { focusDirectorWith('pet:open-notebook'); },
      onOpenCreator: () => { focusDirectorWith('ui:open-creator'); },
      onOpenBench: () => { focusDirectorWith('ui:open-bench'); },
      onReloadCharacters: () => {
        reloadCustomCharacters();
        sendBubble('角色配置已重新载入');
      },
      onCopyWebuiUrl: () => {
        if (webuiRef === null) return;
        const url = new URL(`http://localhost:${webuiRef.port}/`);
        url.searchParams.set('token', webuiRef.token);
        clipboard.writeText(url.toString());
        sendBubble('已复制 WebUI 地址到剪贴板');
      },
      onDismissSelf: () => { manager.close(agentId); },
      onQuit: () => { quitApp(); },
    });
    Menu.buildFromTemplate(template as MenuItemConstructorOptions[]).popup({ window: win });
    return { ok: true };
  });
  try {
    trayHost = await createTrayHost({
      platform: process.platform,
      appName: APP_NAME,
      iconDir: dirname(brandAssetPath(BRAND_ASSETS.iconPng)),
      popoverHtml: join(here, '../renderer/tray-popover/index.html'),
      preloadPath: join(here, '../preload/index.cjs'),
      testMode: TEST_MODE,
      isQuitting: () => isQuitting,
      onOpenDirector: showDirector,
      onOpenBench: () => { focusDirectorWith('ui:open-bench'); },
      onPopoverCreated: () => { wireTargets(); },
      onTogglePets: () => {
        if (petWindowManager?.anyHidden() === true) petWindowManager.showAll();
        else petWindowManager?.hideAll();
      },
      petState: () => ({ anyHidden: petWindowManager?.anyHidden() === true }),
      onQuit: quitApp,
    });
    trayHostReadyResolve();
  } catch (error) {
    console.warn('[tray] 托盘创建失败（应用继续运行）:', error);
    // 失败同样落定就绪门：测试 handler 拿到 trayHost=null 的如实回报，绝不悬挂
    trayHostReadyResolve();
  }

  app.on('activate', () => {
    showDirector();
    if ((petWindowManager?.list().length ?? 0) === 0) {
      void petWindowManager?.open('default', prefs.get().characterId).then(() => {
        stageWindow = petBrowserWindows.get('default') ?? null;
        wireTargets();
      });
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});
app.on('will-quit', () => {
  trayHost?.destroy();
  trayHost = null;
});

app.on('window-all-closed', () => {
  // 托盘常驻：只有显式退出（app:quit / Cmd+Q）才结束进程，关窗只隐藏。
  if (!shouldQuitOnAllWindowsClosed(isQuitting)) return;
  // 多桌宠 agent 池先停，避免残留 MCP 长轮询阻止进程退出
  coopHost?.stopAll();
  app.quit();
});
