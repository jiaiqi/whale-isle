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
  alwaysOnTop = true;
  alwaysOnTopLevel: string | undefined;
  setOpacity = (opacity: number): void => { this.opacity = opacity; };
  setIgnoreMouseEvents = (ignore: boolean): void => { this.ignoreMouse = ignore; };
  setAlwaysOnTop = (flag: boolean, level?: string): void => {
    this.alwaysOnTop = flag;
    this.alwaysOnTopLevel = level;
  };
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
    alwaysOnTopLevel: () => 'screen-saver',
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

    manager.sendAgent('agent-2', 'pet:action', { action: 'game_focus' });
    expect(windows.get('default')?.sent.some((item) => item.channel === 'pet:action')).toBe(false);
    expect(windows.get('agent-2')?.sent.some((item) => item.channel === 'pet:action')).toBe(true);
    manager.broadcast('coop:speaker', { activeAgentId: null, state: 'idle', speakerName: '' });
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

describe('PetWindowManager 多宠社交（T-M6-48）', () => {
  it('窗口相撞触发 onCollision 且 2 秒内去抖；分开后不再触发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-window-manager-'));
    dirs.push(dir);
    const windows = new Map<string, FakeWindow>();
    const hits: string[] = [];
    const manager = new PetWindowManager({
      userDataDir: dir,
      createWindow: (input) => { const window = new FakeWindow(input); windows.set(input.agentId, window); return window; },
      workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      sleep: async () => undefined,
      onCollision: ({ a, b }) => hits.push([a.agentId, b.agentId].sort().join('|')),
    });
    await manager.open('default', 'blue-whale-maid');
    await manager.open('agent-2', 'aboutme-dsh');
    const first = windows.get('default')!;
    const second = windows.get('agent-2')!;
    second.setBounds({ ...first.getBounds() });
    expect(hits).toEqual(['agent-2|default']);
    second.setBounds({ ...first.getBounds(), x: first.getBounds().x + 2 });
    expect(hits).toHaveLength(1); // 去抖
    second.setBounds({ x: 3000, y: 3000, width: 400, height: 284 });
    expect(manager.collisions()).toEqual([]);
  });

  it('assemble 排排站不重叠；dismissAll 保留 default', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    await manager.open('agent-2', 'aboutme-dsh');
    await manager.open('agent-3', 'aboutme-grok');
    const placed = manager.assemble(['default', 'agent-2', 'agent-3'], { x: 0, y: 0, width: 1440, height: 900 });
    expect(placed).toHaveLength(3);
    const bounds = placed.map((view) => view.bounds ?? windows.get(view.agentId)!.getBounds());
    for (let i = 1; i < bounds.length; i += 1) {
      expect(bounds[i]!.x).toBeGreaterThanOrEqual(bounds[i - 1]!.x + bounds[i - 1]!.width);
    }
    const closed = manager.dismissAll('default');
    expect(closed).toBe(2);
    expect(manager.list().map((view) => view.agentId)).toEqual(['default']);
  });
});


describe('PetWindowManager 定向投递（T-M6-51）', () => {
  it('bump / crown / say / wake / preview 只发给目标 agent，payload 自动带 agentId', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    await manager.open('agent-ai', 'crosspet-claude');
    const channels = [
      ['pet:bump', { partner: 'crosspet-claude', partnerName: 'Claude' }],
      ['pet:crown', { on: true }],
      ['pet:say', { text: '巡检完成！' }],
      ['pet:wake', {}],
      ['pet:preview', { action: 'happy_maid', clipId: null }],
    ] as const;
    for (const [channel, payload] of channels) manager.sendAgent('agent-ai', channel, payload);
    const target = windows.get('agent-ai')!;
    const other = windows.get('default')!;
    for (const [channel] of channels) {
      const sent = target.sent.find((item) => item.channel === channel);
      expect(sent, channel).toBeDefined();
      expect(sent?.payload).toMatchObject({ agentId: 'agent-ai' });
      expect(other.sent.some((item) => item.channel === channel), channel).toBe(false);
    }
    expect(target.sent.find((item) => item.channel === 'pet:say')?.payload).toMatchObject({ text: '巡检完成！' });
    expect(target.sent.filter((item) => item.channel === 'pet:preview')).toHaveLength(1);
  });

  it('未知 agentId 静默丢弃；* 广播不破坏原有 payload', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    manager.sendAgent('ghost', 'pet:say', { text: 'x' });
    expect(windows.get('default')?.sent.some((item) => item.channel === 'pet:say')).toBe(false);
    manager.sendAgent('*', 'pet:bump', { partner: 'x' });
    const payload = windows.get('default')?.sent.find((item) => item.channel === 'pet:bump')?.payload;
    expect(payload).toMatchObject({ agentId: '*', partner: 'x' });
  });

  it('setHidden / hideAll / showAll 均触发 onWindowsChanged 并同步最新 visible 状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-window-manager-'));
    dirs.push(dir);
    const snapshots: Array<Array<{ agentId: string; visible: boolean }>> = [];
    const manager = new PetWindowManager({
      userDataDir: dir,
      createWindow: (input) => new FakeWindow(input),
      onWindowsChanged: (list) => {
        snapshots.push(list.map((view) => ({ agentId: view.agentId, visible: view.visible })));
      },
    });
    await manager.open('default', 'blue-whale-maid');
    await manager.open('agent-2', 'blue-whale-maid');
    snapshots.length = 0;

    expect(manager.setHidden('agent-2', true)).toBe(true);
    expect(snapshots.at(-1)).toEqual([
      { agentId: 'default', visible: true },
      { agentId: 'agent-2', visible: false },
    ]);

    manager.hideAll();
    expect(snapshots.at(-1)).toEqual([
      { agentId: 'default', visible: false },
      { agentId: 'agent-2', visible: false },
    ]);

    manager.showAll();
    expect(snapshots.at(-1)).toEqual([
      { agentId: 'default', visible: true },
      { agentId: 'agent-2', visible: true },
    ]);
  });
});

describe('PetWindowManager 显示层级与贴边自动收回（T-M6-63/64）', () => {
  it('三档层级：always 全部置顶、normal 全部取消、follow-ai 由 aiActive 驱动；新窗继承当前层级', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    const win = windows.get('default')!;
    expect(win.alwaysOnTop).toBe(true);
    expect(win.alwaysOnTopLevel).toBe('screen-saver');

    manager.applyWindowLayer('normal', false);
    expect(win.alwaysOnTop).toBe(false);
    manager.applyWindowLayer('follow-ai', false);
    expect(win.alwaysOnTop).toBe(false);
    manager.applyWindowLayer('follow-ai', true);
    expect(win.alwaysOnTop).toBe(true);
    expect(manager.currentWindowLayer()).toEqual({ layer: 'follow-ai', aiActive: true, floating: true });

    // 新开窗口套用当前层级（follow-ai + aiActive=true）
    await manager.open('agent-2', 'crosspet-claude');
    expect(windows.get('agent-2')!.alwaysOnTop).toBe(true);

    manager.applyWindowLayer('normal', false);
    expect(win.alwaysOnTop).toBe(false);
    expect(windows.get('agent-2')!.alwaysOnTop).toBe(false);
  });

  it('贴边 → 干活自动探出并记录原边缘 → 10s 后 redockAuto 收回；手动 clearDock 后不再收回', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    const win = windows.get('default')!;
    win.bounds = { x: 0, y: 100, width: 400, height: 284 };
    win.boundsHistory = [];
    manager.dock('default', 'left');
    expect(manager.isDocked('default')).toBe('left');
    expect(win.bounds.x).toBeLessThan(0);

    const undocked = await manager.requestAutoUndock('default');
    expect(undocked).toBe(true);
    expect(manager.isDocked('default')).toBeNull();
    expect(manager.autoUndockedEdge('default')).toBe('left');
    expect(win.bounds.x).toBe(0);

    expect(manager.redockAuto('default')).toBe(true);
    expect(manager.isDocked('default')).toBe('left');
    expect(manager.autoUndockedEdge('default')).toBeNull();

    // 再次自动探出后用户手动拖离：clearDock 清掉自动收回记忆
    win.bounds = { x: 0, y: 100, width: 400, height: 284 };
    manager.dock('default', 'left');
    await manager.requestAutoUndock('default');
    expect(manager.autoUndockedEdge('default')).toBe('left');
    manager.clearDock('default');
    expect(manager.autoUndockedEdge('default')).toBeNull();
    expect(manager.redockAuto('default')).toBe(false);

    // 未贴边时 requestAutoUndock 为 false；dock 相同边缘幂等
    expect(await manager.requestAutoUndock('agent-missing')).toBe(false);
    win.bounds = { x: 500, y: 100, width: 400, height: 284 };
    manager.dock('default', 'right');
    const once = { ...win.bounds };
    manager.dock('default', 'right');
    expect(win.bounds).toEqual(once);

    // assemble 不打断正在靠边停靠的窗口（如星露谷防遮挡停靠期间伴随宠开窗）
    win.bounds = { x: 0, y: 100, width: 400, height: 284 };
    manager.dock('default', 'left');
    const dockedPos = { ...win.bounds };
    await manager.open('helper-pet', 'crosspet-deepseek');
    manager.assemble(['default', 'helper-pet']);
    expect(manager.isDocked('default')).toBe('left');
    expect(win.bounds).toEqual(dockedPos);
  });

  it('placeNeighbor 在右缘空间不足时自动左移，且超宽 assemble 与 externalDock 永不重叠堆叠', async () => {
    const { manager, windows } = makeManager();
    await manager.open('default', 'blue-whale-maid');
    manager.setPosition('default', { x: 1000, y: 580 });
    manager.setExternalDock('default', true);
    await manager.open('egg-1', 'crosspet-egg-claude');
    const neighbor = manager.placeNeighbor('egg-1', windows.get('default')!.getBounds(), { x: 0, y: 0, width: 1440, height: 900 });
    expect(neighbor?.bounds.x).toBeLessThan(windows.get('default')!.getBounds().x);
    expect(manager.collisions()).toEqual([]);

    await manager.open('agent-a', 'crosspet-claude');
    await manager.open('agent-b', 'crosspet-deepseek');
    await manager.open('agent-c', 'crosspet-gemini');
    await manager.open('agent-d', 'crosspet-gpt');
    const placed = manager.assemble(['default', 'egg-1', 'agent-a', 'agent-b', 'agent-c', 'agent-d'], { x: 0, y: 0, width: 1440, height: 900 });
    expect(placed).toHaveLength(6);
    expect(windows.get('default')!.getBounds().x).toBe(1000);
    expect(manager.collisions()).toEqual([]);

    manager.setHidden('default', true);
    windows.get('default')!.setAlwaysOnTop(false);
    manager.setHidden('default', false);
    expect(windows.get('default')!.alwaysOnTop).toBe(true);
    expect(windows.get('default')!.alwaysOnTopLevel).toBe('screen-saver');
  });
});
