/**
 * ACP Harness 宿主接线（T-M6-02）：主进程持有 HarnessManager，
 * 事件单源多播到 director 窗；审批 Y/N/A 回填。
 */
import { ipcMain, type WebContents } from 'electron';
import { AGENT_PROVIDER_PRESETS, HarnessManager, type AcpAgentEvent } from '@workbench/agent-harness';

export interface HarnessHost {
  readonly manager: HarnessManager;
  setTargets(targets: WebContents[]): void;
}

export function createHarnessHost(): HarnessHost {
  const windows: WebContents[] = [];
  const manager = new HarnessManager((presetId, event: AcpAgentEvent) => {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('harness:event', { presetId, ...event });
    }
  });

  ipcMain.handle('harness:presets', () => AGENT_PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, command: p.command, authHint: p.authHint })));
  ipcMain.handle('harness:start', async (_e, presetId: string) => {
    const preset = AGENT_PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return { ok: false, error: '未知 provider' };
    return manager.startPreset(preset, process.cwd());
  });
  ipcMain.handle('harness:prompt', async (_e, presetId: string, text: string) => manager.prompt(presetId, text));
  ipcMain.handle('harness:permission', (_e, presetId: string, requestId: number, outcome: 'allow' | 'always' | 'reject') => {
    manager.resolvePermission(presetId, requestId, outcome);
    return { ok: true };
  });
  ipcMain.handle('harness:stop', (_e, presetId: string) => {
    manager.stopPreset(presetId);
    return { ok: true };
  });
  ipcMain.handle('harness:status', () => manager.list());

  return {
    manager,
    setTargets(targets) {
      windows.length = 0;
      windows.push(...targets);
    },
  };
}
