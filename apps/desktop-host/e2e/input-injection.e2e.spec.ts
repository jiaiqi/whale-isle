/**
 * [E2E-HOST] V2-P3-03c 真实 OS 输入注入（macOS CGEvent via whale-input-helper）：
 *   helper 编译/缓存 → 申请 ComputerUseLease → WHALE_ENABLE_OS_INPUT=1 下真实移动鼠标 →
 *   回读指针位置确认落位 → 合成事件被 human-input-monitor 正确排除（不触发人类抢占撤销租约）。
 *
 * 诚实口径：无辅助功能权限（如 CI）时断言如实降级（permission_denied），不伪造注入成功；
 * 仅当本机已授权时走真实注入断言（[REAL-DEVICE] 等价路径，本地开发机）。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface AutoBridge {
  v2Resume(mode?: string): Promise<unknown>;
  v2AutoInputStatus(): Promise<{
    executor: { enabled: boolean; mode: string; permission: string; executedCount: number };
    nativeHelper?: { ok: boolean; reason?: string; compileMs?: number };
  }>;
  v2AutoLease(input: unknown): Promise<{ ok: boolean; lease?: { leaseId: string }; error?: string }>;
  v2AutoExecInput(input: unknown): Promise<{ ok: boolean; executed: boolean; code: string; detail: string }>;
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as { directorBridge?: unknown }).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

/** 通过 helper 二进制外的一次性 swift 探测当前指针位置（真机读回证据） */
function readPointer(): { x: number; y: number } | null {
  const r = spawnSync('swift', [
    '-e',
    'import CoreGraphics; let e = CGEvent(source: nil); print("\\(e!.location.x) \\(e!.location.y)")',
  ], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  const m = /([\d.]+) ([\d.]+)/.exec(r.stdout ?? '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

describe('[E2E-HOST] V2-P3-03c 真实 OS 输入注入', () => {
  it('helper 装配 → lease → 真实移动鼠标 → 合成事件不误伤租约', { timeout: 180_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_ENABLE_OS_INPUT: '1' },
    });
    try {
      const director = await waitForDirector(app);
      await director.evaluate(() => (window as unknown as { directorBridge: AutoBridge }).directorBridge.v2Resume('autonomous'));

      // ① helper 装配状态如实上报（编译成功或如实给出原因）
      const status = await director.evaluate(() =>
        (window as unknown as { directorBridge: AutoBridge }).directorBridge.v2AutoInputStatus(),
      );
      expect(status.executor.enabled).toBe(true);
      if (!status.nativeHelper?.ok) {
        // swiftc 不可用等环境限制：如实断言 not_implemented 路径
        expect(status.executor.mode).toBe('dry_run');
        return;
      }
      expect(status.executor.enabled).toBe(true);

      // ② 申请桌面租约
      const lease = await director.evaluate(() =>
        (window as unknown as { directorBridge: AutoBridge }).directorBridge.v2AutoLease({
          action: 'acquire', deviceId: 'e2e-input-device', purpose: 'e2e-input-injection',
        }),
      );
      expect(lease.ok).toBe(true);
      const leaseId = lease.lease!.leaseId;

      // ③ 无权限（CI）时如实降级 permission_denied；有权限（本机）时真实注入
      const before = readPointer();
      const target = { x: Math.round((before?.x ?? 600) + 37), y: Math.round((before?.y ?? 400) + 29) };
      const moved = await director.evaluate(async ({ leaseId: lid, tx, ty }) => {
        const bridge = (window as unknown as { directorBridge: AutoBridge }).directorBridge;
        return bridge.v2AutoExecInput({ leaseId: lid, step: { kind: 'move', x: tx, y: ty, detail: 'e2e 指针落位' } });
      }, { leaseId, tx: target.x, ty: target.y });

      console.log('[input-injection-e2e] moved:', JSON.stringify(moved));
      if (moved.code === 'permission_denied') {
        expect(moved.ok).toBe(false);
        expect(moved.executed).toBe(false);
        return; // CI 路径：fail-closed 如实拒绝即为通过
      }

      expect(moved.code).toBe('executed');
      expect(moved.executed).toBe(true);

      // ④ 真机读回：指针确实落在目标坐标
      const after = readPointer();
      console.log('[input-injection-e2e] pointer before:', JSON.stringify(before), 'target:', JSON.stringify(target), 'after:', JSON.stringify(after));
      expect(after).not.toBeNull();
      expect(Math.abs(after!.x - target.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(after!.y - target.y)).toBeLessThanOrEqual(2);

      // ⑤ 合成事件被 monitor 排除：租约未被误撤销，仍可继续执行
      const again = await director.evaluate(async (lid) => {
        const bridge = (window as unknown as { directorBridge: AutoBridge }).directorBridge;
        return bridge.v2AutoExecInput({ leaseId: lid, step: { kind: 'move', x: 640, y: 420, detail: 'e2e 回位' } });
      }, leaseId);
      expect(again.code).toBe('executed');

      const finalStatus = await director.evaluate(() =>
        (window as unknown as { directorBridge: AutoBridge }).directorBridge.v2AutoInputStatus(),
      );
      expect(finalStatus.executor.mode).toBe('live');
      expect(finalStatus.executor.executedCount).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });
});
