import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * [E2E-HOST] V2-P2-09C 宿主联机身份绑定：
 *   ① host 与 farmhand 各绑定一个游戏内身体，两份租约互不抢占；
 *   ② 「玩家一动即接管」按**身体**判定：只有 farmhand 身体的真人输入才夺走该 AI 的租约；
 *   ③ 动作路由拒绝跨身体写入与未绑定成员的写入。
 *
 * 诚实口径：本用例验证的是**宿主 IPC 与运行时判定逻辑**，
 * 不验证真实《星露谷》分屏（BWF 分屏感知补丁是 `V2-P2-09D`，尚未开工）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron') as string;
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

interface DirectorCoopBridgeWindow {
  directorBridge: {
    v2CoopRoomCreate(input: { roomId: string; sharedGoal: string }): Promise<{ ok: boolean; error?: string }>;
    v2CoopParticipantJoin(input: {
      participantId: string;
      kind: 'human' | 'ai';
      characterId: string;
      displayName: string;
      bodyBinding?: { screenId: number; uniqueMultiplayerID: string; role: 'host' | 'farmhand' };
    }): Promise<{ ok: boolean; error?: string }>;
    v2CoopBodyLeases(): Promise<{ bodyLeases: Array<{ uniqueMultiplayerID: string; screenId: number; role: string; participantId: string; controlOwner: string }> }>;
    v2CoopHumanTakeover(input: { uniqueMultiplayerID?: string }): Promise<{ takenOver: boolean; participantId?: string; reason: string }>;
    v2CoopActionRoute(input: { participantId: string; targetUniqueMultiplayerID: string }): Promise<{ allowed: boolean; reason: string }>;
  };
}

async function waitForDirector(app: import('playwright-core').ElectronApplication, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((w) => w.url().includes('director'));
    if (found) {
      const ready = await found.evaluate(() => Boolean((window as unknown as Partial<DirectorCoopBridgeWindow>).directorBridge));
      if (ready) return found;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('director window not ready within timeout');
}

describe('[E2E-HOST] V2-P2-09C 宿主联机身份绑定（host/farmhand 双租约互不抢占）', () => {
  it('按身体绑定租约、按身体判定接管、拒绝跨身体与未绑定的动作写入', { timeout: 120_000 }, async () => {
    const app = await electron.launch({
      args: ['--use-mock-keychain', mainEntry],
      executablePath: electronBinary,
      env: { ...process.env, PET_STAGE_E2E: '1' },
    });
    const pageErrors: string[] = [];
    try {
      const director = await waitForDirector(app);
      director.on('pageerror', (err) => pageErrors.push(err.message));
      const created = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge
          .v2CoopRoomCreate({ roomId: 'e2e-p209c', sharedGoal: 'E2E 身份绑定自检' }));
      expect(created.ok).toBe(true);

      const hostJoin = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge.v2CoopParticipantJoin({
          participantId: 'human-host',
          kind: 'human',
          characterId: 'farmer-host',
          displayName: '人类房主',
          bodyBinding: { screenId: 0, uniqueMultiplayerID: '1001', role: 'host' },
        }));
      expect(hostJoin.ok).toBe(true);

      const aiJoin = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge.v2CoopParticipantJoin({
          participantId: 'ai-xiaojing',
          kind: 'ai',
          characterId: 'char_xiaojing',
          displayName: '小鲸',
          bodyBinding: { screenId: 1, uniqueMultiplayerID: '2002', role: 'farmhand' },
        }));
      expect(aiJoin.ok).toBe(true);

      // ① 两份身体绑定并存，互不抢占
      const leases = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge.v2CoopBodyLeases());
      expect(leases.bodyLeases).toHaveLength(2);
      const farmhand = leases.bodyLeases.find((v) => v.role === 'farmhand');
      const host = leases.bodyLeases.find((v) => v.role === 'host');
      expect(farmhand).toMatchObject({ uniqueMultiplayerID: '2002', participantId: 'ai-xiaojing', controlOwner: 'ai' });
      expect(host).toMatchObject({ uniqueMultiplayerID: '1001', participantId: 'human-host', controlOwner: 'human' });

      // ② 人类在 host 身体操作 → 不夺走 farmhand 的 AI 租约
      const hostTouch = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge.v2CoopHumanTakeover({ uniqueMultiplayerID: '1001' }));
      expect(hostTouch.takenOver).toBe(false);
      const afterHostTouch = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge.v2CoopBodyLeases());
      expect(afterHostTouch.bodyLeases.find((v) => v.role === 'farmhand')?.controlOwner).toBe('ai');

      // ③ 人类在 farmhand 身体操作 → 只接管该 AI 租约
      const farmhandTouch = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge.v2CoopHumanTakeover({ uniqueMultiplayerID: '2002' }));
      expect(farmhandTouch.takenOver).toBe(true);
      expect(farmhandTouch.participantId).toBe('ai-xiaojing');
      const afterFarmhandTouch = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge.v2CoopBodyLeases());
      expect(afterFarmhandTouch.bodyLeases.find((v) => v.role === 'farmhand')?.controlOwner).toBe('human');
      expect(afterFarmhandTouch.bodyLeases.find((v) => v.role === 'host')?.controlOwner).toBe('human');

      // ④ 动作路由：跨身体写入被拒
      const cross = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge
          .v2CoopActionRoute({ participantId: 'ai-xiaojing', targetUniqueMultiplayerID: '1001' }));
      expect(cross.allowed).toBe(false);
      expect(cross.reason).toContain('跨身体写入');

      // ⑤ 被接管后 AI 对自己身体的写入也被拒（租约已交还人类）
      const own = await director.evaluate(() =>
        (window as unknown as DirectorCoopBridgeWindow).directorBridge
          .v2CoopActionRoute({ participantId: 'ai-xiaojing', targetUniqueMultiplayerID: '2002' }));
      expect(own.allowed).toBe(false);
      expect(own.reason).toContain('控制租约未就绪');

      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
