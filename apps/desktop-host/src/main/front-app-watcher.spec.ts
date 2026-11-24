/** 前台应用监听（T-M6-55）：开关门控、bundle 去重、自身/系统壳层忽略、非 macOS 空转。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrontAppWatcher, isIgnoredFrontApp } from './front-app-watcher';

afterEach(() => { vi.useRealTimers(); });

describe('pollOnce', () => {
  it('返回 trim 后的 bundle id；失败返回 null', async () => {
    const ok = createFrontAppWatcher({ enabled: () => true, onBundle: () => undefined, platform: 'darwin', run: async () => ' com.anthropic.claudefordesktop \n' });
    await expect(ok.pollOnce()).resolves.toBe('com.anthropic.claudefordesktop');
    const bad = createFrontAppWatcher({ enabled: () => true, onBundle: () => undefined, platform: 'darwin', run: async () => { throw new Error('osascript 权限'); } });
    await expect(bad.pollOnce()).resolves.toBeNull();
  });

  it('空输出返回 null；非 darwin 直接 null 且不执行外部命令', async () => {
    const empty = createFrontAppWatcher({ enabled: () => true, onBundle: () => undefined, platform: 'darwin', run: async () => '   ' });
    await expect(empty.pollOnce()).resolves.toBeNull();
    const run = vi.fn(async () => 'com.example');
    const win = createFrontAppWatcher({ enabled: () => true, onBundle: () => undefined, platform: 'win32', run });
    await expect(win.pollOnce()).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('start/stop 门控', () => {
  it('开关关闭时不轮询；开启后同一 bundle 只回调一次；自身应用被忽略', async () => {
    vi.useFakeTimers();
    let enabled = false;
    const seen: string[] = [];
    let current = 'com.anthropic.claudefordesktop';
    const watcher = createFrontAppWatcher({
      enabled: () => enabled,
      onBundle: (bundleId) => seen.push(bundleId),
      platform: 'darwin',
      pollMs: 3_000,
      run: async () => current,
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(seen).toEqual([]);

    enabled = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual(['com.anthropic.claudefordesktop']);

    current = 'com.whaleisle.desktop';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual(['com.anthropic.claudefordesktop']);

    current = 'com.todesktop.230313mzl4w4u92';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual(['com.anthropic.claudefordesktop', 'com.todesktop.230313mzl4w4u92']);

    watcher.stop();
    expect(watcher.running()).toBe(false);
    current = 'com.openai.chat';
    await vi.advanceTimersByTimeAsync(9_000);
    expect(seen).toHaveLength(2);
  });

  it('关闭开关后异步返回也不越权切角', async () => {
    vi.useFakeTimers();
    let enabled = true;
    const seen: string[] = [];
    let resolveRun: ((value: string) => void) | null = null;
    const watcher = createFrontAppWatcher({
      enabled: () => enabled,
      onBundle: (bundleId) => seen.push(bundleId),
      platform: 'darwin',
      pollMs: 3_000,
      run: () => new Promise<string>((resolve) => { resolveRun = resolve; }),
    });
    watcher.start();
    enabled = false;
    (resolveRun as ((value: string) => void) | null)?.('com.anthropic.claudefordesktop');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });

  it('系统壳层 bundle 被忽略', () => {
    expect(isIgnoredFrontApp('com.apple.finder')).toBe(true);
    expect(isIgnoredFrontApp('com.anthropic.claudefordesktop')).toBe(false);
  });
});
