/**
 * T-M6-38：多桌宠窗口管理器确定性测试（不启动 Electron）。
 * 覆盖：多 agentId 独立窗口/偏好、+220 错位、事件定向、关闭后坐标恢复、非法 id。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PetWindowManager, type ManagedPetWindow, type PetWindowCreateInput } from './pet-window-manager';

class FakeWindow implements ManagedPetWindow {
  bounds: { x: number; y: number; width: number; height: number };
  visible = true;
  destroyed = false;
  loadedHash = '';
  boundsHistory: Array<{ x: number; y: number; width: number; height: number }> = [];
  sent: Array<{ channel: string; payload: unknown }> = [];
  private boundsListeners = new Set<(bounds: { x: number; y: number; width: number; height: number }) => void>();
  private closedListeners = new Set<() => void>();

  constructor(input: PetWindowCreateInput) {
    this.bounds = { ...input.bounds };
  }

  isDestroyed = (): boolean => this.destroyed;
  isVisible = (): boolean => this.visible;
  isMinimized = (): boolean => false;
  focus = (): void => undefined;
  showInactive = (): void => { this.visible = true; };
  hide = (): void => { this.visible = false; };
  opacity = 1;
  ignoreMouse = false;
  setOpacity = (opacity: number): void => { this.opacity = opacity; };
  setIgnoreMouseEvents = (ignore: boolean): void => { this.ignoreMouse = ignore; };
  close = (): void => {
    this.destroyed = true;
    this.visible = false;
    for (const listener of this.closedListeners) listener();
  };
  setBounds = (bounds: { x: number; y: number; width: number; height: number }): void => {
    this.bounds = { ...bounds };
    this.boundsHistory.push({ ...bounds });
    for (const listener of this.boundsListeners) listener(this.bounds);
  };
  getBounds = (): { x: number; y: number; width: number; height: number } => ({ ...this.bounds });
  send = (channel: string, payload: unknown): void => { this.sent.push({ channel, payload }); };
  loadStage = async (hash: string): Promise<void> => { this.loadedHash = hash; };
  onBoundsChanged = (listener: (bounds: { x: number; y: number; width: number; height: number }) => void): (() => void) => {
    this.boundsListeners.add(listener);
    return () => this.boundsListeners.delete(listener);
  };
  onClosed = (listener: () => void): (() => void) => {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  };
}

const dirs: string[] = [];
function makeManager(): { manager: PetWindowManager; windows: Map<string, FakeWindow>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pet-window-manager-'));
  dirs.push(dir);
  const windows = new Map<string, FakeWindow>();
  const manager = new PetWindowManager({
    userDataDir: dir,
    createWindow: (input) => {
      const window = new FakeWindow(input);
      windows.set(input.agentId, window);
      return window;
    },
    workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    sleep: async () => undefined,
  });
  return { manager, windows, dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PetWindowManager', () => {
  it('按 agentId 管理独立窗口，新窗相对前一只水平错开 +220px', async () => {
    const { manager, windows } = makeManager();
    const first = await manager.open('default', 'blue-whale-maid');
    const second = await manager.open('agent-2', 'blue-whale-maid');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(windows.get('agent-2')?.bounds.x).toBe(windows.get('default')!.bounds.x + 220);
    expect(windows.get('agent-2')?.loadedHash).toContain('agentId=agent-2');
    expect(manager.list()).toHaveLength(2);
  });

  it('缩放/锁定按 agent 隔离并持久化，事件只发目标窗口', async () => {
    const { manager, windows, dir } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    await manager.open('agent-2', 'blue-whale-maid');
    const patched = manager.patch('agent-2', { scale: 1.4, locked: true });
    expect(patched?.scale).toBe(1.4);
    expect(patched?.locked).toBe(true);
    expect(windows.get('default')?.getBounds().width).toBe(400);
    expect(windows.get('agent-2')?.getBounds().width).toBe(560);
    expect(windows.get('agent-2')?.sent.at(-1)?.channel).toBe('pet:window-prefs-changed');

    manager.send('pet:action', 'agent-2', { agentId: 'agent-2', action: 'game_focus' });
    expect(windows.get('default')?.sent.some((item) => item.channel === 'pet:action')).toBe(false);
    expect(windows.get('agent-2')?.sent.some((item) => item.channel === 'pet:action')).toBe(true);
    manager.send('coop:speaker', '*', { activeAgentId: null, state: 'idle', speakerName: '' });
    expect(windows.get('default')?.sent.some((item) => item.channel === 'coop:speaker')).toBe(true);

    manager.flush();
    const persisted = JSON.parse(readFileSync(join(dir, 'pet-window-prefs.json'), 'utf8')) as { windows: Record<string, { scale: number; locked: boolean }> };
    expect(persisted.windows['agent-2']?.scale).toBe(1.4);
    expect(persisted.windows['agent-2']?.locked).toBe(true);
  });

  it('关闭只移除目标窗口并保留其坐标，重新打开原位恢复', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    await manager.open('agent-2', 'blue-whale-maid');
    const original = windows.get('agent-2')!.getBounds();
    expect(manager.close('agent-2')).toBe(true);
    expect(manager.list().map((view) => view.agentId)).toEqual(['default']);
    manager.flush();

    await manager.open('agent-2', 'blue-whale-maid');
    expect(windows.get('agent-2')?.bounds).toEqual(original);
    expect(manager.list()).toHaveLength(2);
  });


  it('贴边探出逐帧 setBounds 并最终回到原位置', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    const window = windows.get('default')!;
    const original = window.getBounds();
    manager.dock('default', 'left');
    const docked = window.getBounds();
    expect(docked.x).toBeLessThan(original.x);
    window.boundsHistory = [];
    await manager.undock('default');
    expect(window.boundsHistory.length).toBeGreaterThan(3);
    expect(window.getBounds()).toEqual(original);
    expect(window.boundsHistory[0]?.x).toBeGreaterThan(docked.x);
  });

  it('拖离边缘 clearDock 不弹回旧位置，且取消在途 undock', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    const window = windows.get('default')!;
    manager.dock('default', 'left');
    const draggedAway = { x: 600, y: 200, width: 400, height: 284 };
    window.setBounds(draggedAway);
    expect(manager.clearDock('default')).toBe(true);
    await manager.undock('default');
    expect(window.getBounds()).toEqual(draggedAway);
    expect(manager.clearDock('default')).toBe(false);
  });

  it('全局 Alt peek 只对命中的窗口降透明和穿透', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    manager.applyPeekTargets(['default']);
    expect(windows.get('default')?.opacity).toBe(0.35);
    expect(windows.get('default')?.ignoreMouse).toBe(true);
    manager.applyPeekTargets([]);
    expect(windows.get('default')?.opacity).toBe(1);
    expect(windows.get('default')?.ignoreMouse).toBe(false);
  });

  it('非法 agentId 与不存在端点不崩溃', async () => {
    const { manager } = makeManager();
    expect((await manager.open('../escape')).ok).toBe(false);
    expect(manager.close('missing')).toBe(false);
    expect(manager.patch('missing', { scale: 2 })).toBeNull();
    expect(manager.get('missing')).toBeNull();
  });

  it('装载失败会关闭并回滚窗口表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-window-manager-'));
    dirs.push(dir);
    const manager = new PetWindowManager({
      userDataDir: dir,
      createWindow: (input) => {
        const window = new FakeWindow(input);
        window.loadStage = vi.fn().mockRejectedValue(new Error('load failed'));
        return window;
      },
    });
    const result = await manager.open('broken', 'blue-whale-maid');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('load failed');
    expect(manager.list()).toEqual([]);
  });
});
