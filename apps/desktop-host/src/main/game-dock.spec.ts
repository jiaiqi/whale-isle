import { describe, expect, it } from 'vitest';
import { computeGameBottomRightBounds, GameDockTracker } from './game-dock';

const WORK_AREA = { x: 0, y: 25, width: 1920, height: 1055 };
const GAME_RECT = { x: 560, y: 238, width: 1280, height: 748 };
const PET_SIZE = { width: 400, height: 284 };

describe('game-dock（桌宠自动贴边游戏右下角）', () => {
  it('贴边坐标落在游戏右下角（快捷栏上方、体力条左侧）并严格夹紧在 workArea 内', () => {
    const docked = computeGameBottomRightBounds(GAME_RECT, PET_SIZE, WORK_AREA);
    expect(docked.width).toBe(400);
    expect(docked.height).toBe(284);
    expect(docked.x).toBeGreaterThan(GAME_RECT.x + GAME_RECT.width - 500);
    expect(docked.x + docked.width).toBeLessThan(GAME_RECT.x + GAME_RECT.width);
    expect(docked.y + docked.height).toBeLessThan(GAME_RECT.y + GAME_RECT.height);
    expect(docked.x).toBeGreaterThanOrEqual(WORK_AREA.x);
    expect(docked.x + docked.width).toBeLessThanOrEqual(WORK_AREA.x + WORK_AREA.width);

    // 游戏贴在显示器右底角时，仍然夹紧在屏幕内不溢出
    const edgeGame = { x: 1000, y: 600, width: 1280, height: 748 };
    const clamped = computeGameBottomRightBounds(edgeGame, PET_SIZE, WORK_AREA);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(WORK_AREA.x + WORK_AREA.width);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height);
  });

  it('开启开关检测到游戏立即贴边、窗口微移跟随、手拖后本局不再拉回、关闭游戏连续 2 轮复原', () => {
    const tracker = new GameDockTracker();
    const initialPet = { x: 80, y: 80, width: 400, height: 284 };

    // 1) 游戏开启 -> 自动贴到右下角
    const first = tracker.sync({
      enabled: true,
      locked: false,
      gameRect: GAME_RECT,
      petBounds: initialPet,
      workArea: WORK_AREA,
    });
    expect(first.kind).toBe('move');
    if (first.kind !== 'move') return;
    expect(first.reason).toBe('dock');
    expect(tracker.isDocked()).toBe(true);

    // 2) 游戏位置不变 -> noop
    const steady = tracker.sync({
      enabled: true,
      locked: false,
      gameRect: GAME_RECT,
      petBounds: { ...first.position, width: 400, height: 284 },
      workArea: WORK_AREA,
    });
    expect(steady).toEqual({ kind: 'noop' });

    // 3) 游戏移动 -> 平滑跟随
    const shifted = tracker.sync({
      enabled: true,
      locked: false,
      gameRect: { ...GAME_RECT, x: 420, y: 180 },
      petBounds: { ...first.position, width: 400, height: 284 },
      workArea: WORK_AREA,
    });
    expect(shifted).toMatchObject({ kind: 'move', reason: 'follow' });

    // 4) 用户手动拖走 -> 本局游戏内不再强制拉回
    tracker.noteExternalMove({ x: 200, y: 300 });
    expect(tracker.hasUserOverrode()).toBe(true);
    expect(tracker.isDocked()).toBe(false);
    expect(tracker.sync({
      enabled: true,
      locked: false,
      gameRect: GAME_RECT,
      petBounds: { x: 200, y: 300, width: 400, height: 284 },
      workArea: WORK_AREA,
    })).toEqual({ kind: 'noop' });

    // 5) 手动重开开关 -> 清掉覆盖，立刻贴回右下角
    tracker.resetOverride();
    const redock = tracker.sync({
      enabled: true,
      locked: false,
      gameRect: GAME_RECT,
      petBounds: { x: 200, y: 300, width: 400, height: 284 },
      workArea: WORK_AREA,
    });
    expect(redock).toMatchObject({ kind: 'move', reason: 'dock' });

    // 6) 游戏关闭：第 1 轮防抖不乱动，第 2 轮复原到打开游戏前位置 { 200, 300 }
    expect(tracker.sync({
      enabled: true,
      locked: false,
      gameRect: null,
      petBounds: { ...GAME_RECT, width: 400, height: 284 },
      workArea: WORK_AREA,
    })).toEqual({ kind: 'noop' });
    expect(tracker.sync({
      enabled: true,
      locked: false,
      gameRect: null,
      petBounds: { ...GAME_RECT, width: 400, height: 284 },
      workArea: WORK_AREA,
    })).toEqual({ kind: 'restore', position: { x: 200, y: 300 }, docked: false, reason: 'game-closed' });
  });

  it('关闭开关时：游戏打开不移动；已贴边时关闭立即复原原位', () => {
    const tracker = new GameDockTracker();
    expect(tracker.sync({
      enabled: false,
      locked: false,
      gameRect: GAME_RECT,
      petBounds: { x: 100, y: 120, width: 400, height: 284 },
      workArea: WORK_AREA,
    })).toEqual({ kind: 'noop' });

    tracker.sync({
      enabled: true,
      locked: false,
      gameRect: GAME_RECT,
      petBounds: { x: 100, y: 120, width: 400, height: 284 },
      workArea: WORK_AREA,
    });
    const disabled = tracker.sync({
      enabled: false,
      locked: false,
      gameRect: GAME_RECT,
      petBounds: { x: 1400, y: 650, width: 400, height: 284 },
      workArea: WORK_AREA,
    });
    expect(disabled).toEqual({ kind: 'restore', position: { x: 100, y: 120 }, docked: false, reason: 'disabled' });
  });
});
