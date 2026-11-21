/**
 * autodrive 宿主接线（T-M5-02 宿主层）：主进程持有 AutodriveRunner，
 * 事件单源多播到 director + pet-stage 两窗（webContents.send，preload 桥中继）。
 * 启停由 Shell 显式触发（用户不在游戏时不自动跑）。
 */
import { ipcMain, type WebContents } from 'electron';
import {
  AutodriveRunner,
  type AutodriveEvent,
} from '@workbench/game-bridge-mcp';

export interface AutodriveHost {
  readonly runner: AutodriveRunner;
  /** 广播目标（两窗 webContents；窗口重建后由 main 更新） */
  setTargets(targets: WebContents[]): void;
}

export function createAutodriveHost(endpoint = 'http://127.0.0.1:18080/mcp'): AutodriveHost {
  const windows: WebContents[] = [];
  const broadcast = (event: AutodriveEvent): void => {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('autodrive:event', event);
    }
  };
  const runner = new AutodriveRunner(broadcast, { endpoint });

  ipcMain.handle('autodrive:start', async () => {
    try {
      await runner.start();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('autodrive:stop', () => {
    runner.stop();
    return { ok: true };
  });
  ipcMain.handle('autodrive:directive', (_e, tool: string, args: Record<string, unknown>, intent: string) => {
    runner.submitDirective(tool, args ?? {}, typeof intent === 'string' ? intent : '远程指令');
    return { ok: true };
  });
  ipcMain.handle('autodrive:status', () => ({ running: runner.isRunning() }));

  return {
    runner,
    setTargets(targets) {
      windows.length = 0;
      windows.push(...targets);
    },
  };
}
