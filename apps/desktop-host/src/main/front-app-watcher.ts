/**
 * 低频前台应用监听（T-M6-55）。
 *
 * macOS 每 3s 用 osascript 取 frontmost bundle id；非 macOS 直接空转（Windows 暂无标准 API，
 * 诚实不做假切换）。只有 `PetDesktopPrefs.followFrontApp` 开启时才轮询；关闭后立即停止，
 * 已选角色保持不动（绝不因为开关关闭而回退角色）。
 *
 * 安全边界：只读 bundle id，不读取窗口标题、不注入任何输入；子进程 2s 超时。
 */
import { execFile } from 'node:child_process';

const SCRIPT = 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true';

/** 自身/系统壳层：即使误配 apps 也不触发换角（避免自己抢占自己）。 */
const IGNORED_BUNDLES = new Set([
  'com.whaleisle.desktop',
  'com.github.Electron',
  'com.apple.finder',
  'com.apple.dock',
  'com.apple.systemuiserver',
]);

export interface FrontAppWatcher {
  start(): void;
  stop(): void;
  /** 单次轮询（测试/手动刷新）：返回本次 bundle id；失败返回 null */
  pollOnce(): Promise<string | null>;
  lastBundleId(): string | null;
  running(): boolean;
}

export function isIgnoredFrontApp(bundleId: string): boolean {
  return IGNORED_BUNDLES.has(bundleId.trim());
}

export function createFrontAppWatcher(options: {
  enabled: () => boolean;
  onBundle: (bundleId: string) => void;
  platform?: NodeJS.Platform;
  pollMs?: number;
  /** 测试注入：默认走 execFile('osascript', ['-e', script]) */
  run?: (script: string) => Promise<string>;
}): FrontAppWatcher {
  const platform = options.platform ?? process.platform;
  const pollMs = options.pollMs ?? 3_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: string | null = null;
  let inFlight = false;

  const run = options.run ?? ((script: string) => new Promise<string>((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 2_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  }));

  const pollOnce = async (): Promise<string | null> => {
    if (platform !== 'darwin') return null;
    if (inFlight) return last;
    inFlight = true;
    try {
      const stdout = await run(SCRIPT);
      const bundleId = stdout.trim();
      return bundleId === '' ? null : bundleId;
    } catch {
      return null;
    } finally {
      inFlight = false;
    }
  };

  const tick = (): void => {
    if (!options.enabled()) return;
    void pollOnce().then((bundleId) => {
      // 开关可能在异步期间被关闭：再查一次，绝不越权切角
      if (bundleId === null || !options.enabled()) return;
      if (isIgnoredFrontApp(bundleId)) return;
      if (bundleId === last) return;
      last = bundleId;
      options.onBundle(bundleId);
    }).catch(() => undefined);
  };

  return {
    start() {
      if (platform !== 'darwin' || timer !== null) return;
      timer = setInterval(tick, pollMs);
      timer.unref?.();
      tick();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    pollOnce,
    lastBundleId: () => last,
    running: () => timer !== null,
  };
}
