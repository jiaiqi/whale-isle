/**
 * autodrive 宿主接线（T-M5-02 宿主层）：主进程持有 AutodriveRunner，
 * 事件单源多播到 director + pet-stage 两窗（webContents.send，preload 桥中继）。
 * 启停由 Shell 显式触发（用户不在游戏时不自动跑）。
 */
import { ipcMain, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // ---- T-M5-16（D16）pets 动作库：manifest 读取 + 预览转发 ----
  ipcMain.handle('pets:manifest', () => {
    try {
      const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../renderer/pet-stage/assets/blue-whale-maid/manifest.json');
      return { ok: true, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // preview：actionState（槽位）或 clipId（ambient 单条）——转发给 pet-stage 窗
  ipcMain.handle('pets:preview', (_e, action: string, clipId: string | null) => {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('pet:preview', { action, clipId });
    }
    return { ok: true };
  });
  // ---- D16：饭碗档位联动（每回执扣米 → 档位广播 → 桌宠档位动作） ----
  let riceBalance = 12_480; // 初始（与 fixtures 一致）；后续接 token_ledger 真实计量（T-M5-04）
  let riceLevel = 'hungry'; // 初始 12.48% 即在饥饿线下——首个回执前不发（避免启动即广播）
  const broadcastRice = (level: string): void => {
    // D16 边沿触发：仅档位变化时广播（同档持续不重复刷桌宠动作）
    if (level === riceLevel) return;
    riceLevel = level;
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('pet:rice', { level, balance: riceBalance });
    }
  };
  ipcMain.handle('rice:feed', (_e, grains: number) => {
    riceBalance += Math.max(0, grains);
    // 投喂下饭菜 → fed_buff 档（dsh-pet Buff 思想）；低于满 buff 线回落 ok
    broadcastRice(riceBalance > 100_000 * 0.9 ? 'fed_buff' : riceBalance > 80_000 ? 'full' : 'ok');
    return { ok: true, balance: riceBalance };
  });
  ipcMain.handle('rice:status', () => ({ balance: riceBalance }));
  const broadcast = (event: AutodriveEvent): void => {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('autodrive:event', event);
    }
  };
  const runner = new AutodriveRunner((event) => {
    // 回执扣米（1 回执 = 30 粒模拟计量；真实 token 计量待 T-M5-04 token_ledger 接线）
    if (event.type === 'receipt' && event.tool !== 'autodrive') {
      riceBalance = Math.max(0, riceBalance - 30);
      const ratio = riceBalance / 100_000;
      broadcastRice(ratio < 0.05 ? 'starving' : ratio < 0.15 ? 'hungry' : ratio > 0.8 ? 'full' : 'ok');
      void riceLevel;
    }
    broadcast(event);
  }, { endpoint });

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
