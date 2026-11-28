/**
 * 桌宠贴边游戏窗口状态机与几何计算（纯函数，无 Electron 依赖）。
 *
 * 规则：
 *   - `dockToGame` 默认开启：检测到游戏窗口打开且可见（非全屏、非最小化）时，
 *     把主桌宠自动停靠在游戏窗口右下角（工具栏上方、体力条左侧的留白区），避免遮挡 HUD；
 *   - 若用户手动把桌宠拖走，本局游戏内尊重用户手放位置不再强行拉回；
 *   - 连续 2 轮未检测到游戏窗口（关闭或最小化），恢复打开游戏前的桌宠位置并复位会话；
 *   - 关闭 `dockToGame` 开关后立即解除游戏停靠并恢复原位；重新开启若游戏仍开着则立刻贴回右下角。
 */
import type { RectLike } from './fullscreen-detector';

export interface PetWindowSize {
  width: number;
  height: number;
}

export interface GameDockPosition {
  x: number;
  y: number;
}

export type GameDockStepResult =
  | { kind: 'noop' }
  | { kind: 'move'; position: GameDockPosition; docked: true; reason: 'dock' | 'follow' }
  | { kind: 'restore'; position: GameDockPosition; docked: false; reason: 'disabled' | 'game-closed' };

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/**
 * 计算桌宠贴靠游戏窗口右下角的建议左上角坐标（并严格夹紧在所在显示器 workArea 内）：
 *   - 水平：距游戏右缘留出 ~3.2%（24–56px）安全距，给右侧体力条与右向气泡留空间；
 *   - 垂直：距游戏底缘留出 ~8.5%（40–80px）安全距，让桌宠双脚落于底部快捷栏正上方。
 */
export function computeGameBottomRightBounds(
  gameRect: RectLike,
  petSize: PetWindowSize,
  workArea: RectLike,
): { x: number; y: number; width: number; height: number } {
  const rightInset = Math.round(Math.min(56, Math.max(24, gameRect.width * 0.032)));
  const bottomInset = Math.round(Math.min(80, Math.max(40, gameRect.height * 0.085)));
  const rawX = gameRect.x + gameRect.width - petSize.width - rightInset;
  const rawY = gameRect.y + gameRect.height - petSize.height - bottomInset;
  const maxX = workArea.x + Math.max(0, workArea.width - petSize.width);
  const maxY = workArea.y + Math.max(0, workArea.height - petSize.height);
  return {
    x: Math.round(clamp(rawX, workArea.x, maxX)),
    y: Math.round(clamp(rawY, workArea.y, maxY)),
    width: petSize.width,
    height: petSize.height,
  };
}

function movedEnough(a: GameDockPosition, b: GameDockPosition, thresholdPx = 8): boolean {
  return Math.abs(a.x - b.x) > thresholdPx || Math.abs(a.y - b.y) > thresholdPx;
}

export class GameDockTracker {
  private docked = false;
  private userOverrode = false;
  private savedBeforeGame: GameDockPosition | null = null;
  private lastApplied: GameDockPosition | null = null;
  private absentTicks = 0;

  isDocked(): boolean {
    return this.docked;
  }

  hasUserOverrode(): boolean {
    return this.userOverrode;
  }

  /** 启动新一局游戏或重新开启开关时清除手拖覆盖，确保打开游戏就能立即贴边。 */
  resetOverride(): void {
    this.userOverrode = false;
  }

  /** 主进程之外的原因（真实鼠标拖拽/手动置位/右键贴边）改动位置时调用。 */
  noteExternalMove(nextPos: GameDockPosition): void {
    if (!this.docked || this.lastApplied === null) return;
    if (movedEnough(nextPos, this.lastApplied, 12)) {
      this.userOverrode = true;
      this.docked = false;
      this.savedBeforeGame = null;
      this.lastApplied = null;
    }
  }

  sync(input: {
    enabled: boolean;
    locked: boolean;
    gameRect: RectLike | null;
    petBounds: RectLike;
    workArea: RectLike;
    /** 当前已处于屏幕左右半隐贴边时记住的原始位置（可选） */
    restoreFromScreenDock?: GameDockPosition | null;
  }): GameDockStepResult {
    if (!input.enabled) {
      const restore = this.docked ? this.savedBeforeGame : null;
      this.docked = false;
      this.userOverrode = false;
      this.savedBeforeGame = null;
      this.lastApplied = null;
      this.absentTicks = 0;
      return restore !== null
        ? { kind: 'restore', position: restore, docked: false, reason: 'disabled' }
        : { kind: 'noop' };
    }

    if (input.gameRect === null) {
      this.absentTicks += 1;
      // 连续 2 轮不见游戏窗口才判定为游戏退出/最小化，避免切焦或重载瞬间抖动
      if (this.absentTicks < 2) return { kind: 'noop' };
      const restore = this.docked && !this.userOverrode ? this.savedBeforeGame : null;
      this.docked = false;
      this.userOverrode = false;
      this.savedBeforeGame = null;
      this.lastApplied = null;
      return restore !== null
        ? { kind: 'restore', position: restore, docked: false, reason: 'game-closed' }
        : { kind: 'noop' };
    }

    this.absentTicks = 0;
    if (input.locked || this.userOverrode) return { kind: 'noop' };

    const target = computeGameBottomRightBounds(
      input.gameRect,
      { width: input.petBounds.width, height: input.petBounds.height },
      input.workArea,
    );
    const nextPos: GameDockPosition = { x: target.x, y: target.y };

    if (!this.docked) {
      this.savedBeforeGame = input.restoreFromScreenDock ?? {
        x: Math.round(input.petBounds.x),
        y: Math.round(input.petBounds.y),
      };
      this.docked = true;
      this.lastApplied = nextPos;
      return { kind: 'move', position: nextPos, docked: true, reason: 'dock' };
    }

    if (this.lastApplied === null || movedEnough(nextPos, this.lastApplied, 6)) {
      this.lastApplied = nextPos;
      return { kind: 'move', position: nextPos, docked: true, reason: 'follow' };
    }

    return { kind: 'noop' };
  }
}
