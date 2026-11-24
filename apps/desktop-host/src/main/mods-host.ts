/**
 * 星露谷 Mod 管理宿主（T-M6-06）：主进程唯一入口。
 *   - 配置落 userData/stardew-mods.json（StardewModsConfig 契约校验后才消费）
 *   - 扫描/启停/安装委托 @workbench/stardew-mods（纯逻辑、可单测）
 *   - 安装 ZIP：系统解压到临时目录 → installModFromDirectory → 清理临时目录
 *   - BWF 端口单点管理：默认 18088（避开 18080 冲突），自动同步写入 Mods/BlindWhaleFarmer/config.json
 * 铁律：只操作玩家自己的 Mods 目录；不改游戏本体；路径一律来自玩家配置或平台默认候选。
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { StardewModsConfigSchema, type StardewModsConfig } from '@workbench/shared-protocol';
import {
  guessModsDirs,
  installModFromDirectory,
  isSafeModFolderName,
  scanModsDir,
  setModEnabled,
} from '@workbench/stardew-mods';
import { bwfBaseUrl, pushBwfShowHud, syncBwfConfigPort } from './bwf-settings';

const run = promisify(execFile);

export interface ModsHost {
  /** 当前生效的 Mods 目录（可能尚不存在） */
  readonly modsDir: string;
  /** 配置是否来自玩家手动指定 */
  readonly configured: boolean;
  /** 当前生效的 BWF MCP 端口（默认 18088） */
  readonly bwfMcpPort: number;
  /** 订阅 BWF 端口变更（用于实时更新主进程 autodrive 端点） */
  onBwfPortChange(listener: (port: number) => void): () => void;
}

function readConfig(configPath: string): StardewModsConfig {
  try {
    const parsed = StardewModsConfigSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    /* 文件不存在/坏 JSON → 回落默认 */
  }
  return StardewModsConfigSchema.parse({});
}

function writeConfig(configPath: string, config: StardewModsConfig): void {
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** 解压 zip 到目标目录（macOS ditto / Linux unzip / Windows PowerShell，均走系统自带工具） */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (process.platform === 'darwin') {
    await run('ditto', ['-x', '-k', zipPath, destDir]);
    return;
  }
  if (process.platform === 'win32') {
    const script = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return;
  }
  await run('unzip', ['-o', zipPath, '-d', destDir]);
}

export function createModsHost(userDataDir: string): ModsHost {
  const configPath = join(userDataDir, 'stardew-mods.json');
  let config = readConfig(configPath);
  const portListeners = new Set<(port: number) => void>();
  const candidates = () => guessModsDirs(process.platform, homedir());

  /** 配置优先；未配置时取第一个真实存在的平台候选 */
  const resolveDir = (): { dir: string; configured: boolean } => {
    if (config.modsDir.trim() !== '') return { dir: config.modsDir, configured: true };
    const found = candidates().find((p) => existsSync(p));
    return { dir: found ?? candidates()[0] ?? '', configured: false };
  };

  // 启动即把本地 BWF 端口偏好自愈同步到星露谷 Mods/BlindWhaleFarmer/config.json（例如从旧 18080 迁到 18088）
  const initialDir = resolveDir().dir;
  if (initialDir !== '') syncBwfConfigPort(initialDir, config.bwfMcpPort);

  ipcMain.handle('mods:state', async () => {
    const { dir, configured } = resolveDir();
    if (dir !== '') syncBwfConfigPort(dir, config.bwfMcpPort);
    const snapshot = dir === '' ? null : await scanModsDir(dir);
    // 自愈同步（T-M6-16）：打开星露谷/Mod 页时把本地偏好推给 BWF（Mod 升级重置 config.json 后自动纠正）；
    // 游戏没开就静默跳过，开关切换与下次打开页面时再推
    void pushBwfShowHud(config.bwfShowHud, bwfBaseUrl(config.bwfMcpPort)).catch(() => undefined);
    return {
      ok: true,
      configured,
      bwfShowHud: config.bwfShowHud,
      bwfMcpPort: config.bwfMcpPort,
      candidates: candidates().map((path) => ({ path, exists: existsSync(path) })),
      snapshot,
    };
  });

  // BWF 游戏内 HUD 开关（T-M6-16 用户指令）：默认关闭；本地持久化 + /settings 运行时下发
  ipcMain.handle('mods:set-bwf-hud', async (_e, value: boolean) => {
    if (typeof value !== 'boolean') return { ok: false, error: 'value 必须是布尔值' };
    config = { ...config, bwfShowHud: value };
    writeConfig(configPath, config);
    const push = await pushBwfShowHud(value, bwfBaseUrl(config.bwfMcpPort));
    return {
      ok: true,
      showHud: value,
      applied: push.applied,
      // 旧 DLL（无 showHud 远程键）→ 如实提示需重启游戏加载补丁版
      needsGameRestart: push.reachable && !push.applied,
      gameOffline: !push.reachable,
    };
  });

  // BWF MCP 端口配置：持久化到 stardew-mods.json + 同步写入星露谷 Mods/BlindWhaleFarmer/config.json
  ipcMain.handle('mods:set-bwf-port', async (_e, rawPort: unknown) => {
    const parsed = StardewModsConfigSchema.shape.bwfMcpPort.safeParse(Number(rawPort));
    if (!parsed.success) {
      return { ok: false, error: '端口必须是 1024–65535 之间的整数' };
    }
    const nextPort = parsed.data;
    config = { ...config, bwfMcpPort: nextPort };
    writeConfig(configPath, config);
    const { dir } = resolveDir();
    const synced = dir === ''
      ? { ok: false, updated: false, error: '未找到星露谷 Mods 目录，已保存工作台端口；请手动核对 BWF config.json' }
      : syncBwfConfigPort(dir, nextPort);
    for (const listener of portListeners) {
      try { listener(nextPort); } catch { /* 隔离单个监听异常 */ }
    }
    return {
      ok: true,
      port: nextPort,
      configSynced: synced.ok,
      configUpdated: synced.updated,
      ...(synced.configPath === undefined ? {} : { configPath: synced.configPath }),
      ...(synced.error === undefined ? {} : { warning: synced.error }),
      needsGameRestart: true,
    };
  });

  ipcMain.handle('mods:set-dir', async (_e, dir: string) => {
    if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: '目录不能为空' };
    if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` };
    config = { ...config, modsDir: dir.trim() };
    writeConfig(configPath, config);
    syncBwfConfigPort(config.modsDir, config.bwfMcpPort);
    return { ok: true, snapshot: await scanModsDir(config.modsDir) };
  });

  ipcMain.handle('mods:scan', async () => {
    const { dir } = resolveDir();
    if (dir === '') return { ok: false, error: '未找到星露谷 Mods 目录，请手动指定' };
    return { ok: true, snapshot: await scanModsDir(dir) };
  });

  ipcMain.handle('mods:toggle', async (_e, folderName: string, enabled: boolean) => {
    const { dir } = resolveDir();
    if (dir === '') return { ok: false, error: '未找到星露谷 Mods 目录' };
    if (!isSafeModFolderName(folderName)) return { ok: false, error: '非法目录名' };
    return setModEnabled(dir, folderName, enabled === true);
  });

  ipcMain.handle('mods:install-zip', async () => {
    const { dir } = resolveDir();
    if (dir === '') return { ok: false, error: '未找到星露谷 Mods 目录，请先指定' };
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: '选择 Mod 压缩包',
      properties: ['openFile' as const],
      filters: [{ name: 'Mod 压缩包', extensions: ['zip'] }],
    };
    const picked = owner === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(owner, options);
    const zipPath = picked.filePaths[0];
    if (picked.canceled || zipPath === undefined) return { ok: false, error: '已取消' };
    const tempDir = await mkdtemp(join(tmpdir(), 'sdv-mod-'));
    try {
      await extractZip(zipPath, tempDir);
      return await installModFromDirectory(tempDir, dir);
    } catch (error) {
      return { ok: false, error: `解压失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  ipcMain.handle('mods:open-dir', async () => {
    const { dir } = resolveDir();
    if (dir === '') return { ok: false, error: '未找到星露谷 Mods 目录' };
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const message = await shell.openPath(dir);
    return message === '' ? { ok: true } : { ok: false, error: message };
  });

  return {
    get modsDir() {
      return resolveDir().dir;
    },
    get configured() {
      return config.modsDir.trim() !== '';
    },
    get bwfMcpPort() {
      return config.bwfMcpPort;
    },
    onBwfPortChange(listener) {
      portListeners.add(listener);
      return () => { portListeners.delete(listener); };
    },
  };
}
