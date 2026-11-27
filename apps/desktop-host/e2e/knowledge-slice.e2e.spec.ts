/** [E2E-HOST] + [SIMULATION]：真实 Electron/preload/SQLite + fake Envoy/BWF；不是真实 Envoy/游戏验收。 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { KnowledgeImportResult, KnowledgeExecutionResult, PlayReceipt } from '@workbench/shared-protocol';
import { startBwfHttpServer } from '../../../tools/mock-harness/src/bwf-replay-server';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
interface Bridge {
  v2KnowledgeSourceStatus(): Promise<{ state: string; readOnly: boolean }>;
  v2KnowledgeImport(input: unknown): Promise<KnowledgeImportResult>;
  v2KnowledgeExecute(input: unknown): Promise<KnowledgeExecutionResult>;
  v2KnowledgeReceipts(id: string): Promise<PlayReceipt[]>;
  v2KnowledgeList(): Promise<{ units: unknown[] }>;
}
async function director(app: ElectronApplication) {
  await expect.poll(() => app.windows().some((page) => page.url().includes('director')), { timeout: 30_000 }).toBe(true);
  const page = app.windows().find((page) => page.url().includes('director'))!;
  await page.waitForFunction(() => !!(window as unknown as { directorBridge?: unknown }).directorBridge);
  return page;
}

describe('04D 知识第一切片 IPC', () => {
  it('导入 fixture、复现摘要、真实回环动作、关闭并重启后回执仍可复查', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-electron-'));
    const materials = join(dir, 'authorized'); mkdirSync(materials);
    const file = join(materials, 'spring-guide.md');
    writeFileSync(file, readFileSync(join(root, 'tools/mock-harness/fixtures/knowledge-slice/spring-guide.md')));
    let water = 4;
    const calls: string[] = [];
    const bwf = await startBwfHttpServer(({ tool }) => {
      calls.push(tool);
      if (tool === 'get_state') return { text: `游戏版本：1.6.15\n已装 Mod：原版\n时间：第1年春3日 06:00，天气：晴\n需浇水：${water}` };
      if (tool === 'water_crops') { water = 0; return { text: '成功：已给四株作物浇水' }; }
      return { text: '失败：不支持的仿真动作', isError: true };
    });
    const launch = () => electron.launch({
      executablePath: require('electron') as string,
      args: ['--use-mock-keychain', join(root, 'apps/desktop-host/dist/main/index.js')],
      env: { ...process.env, PET_STAGE_E2E: '1', WHALE_E2E_GAME_OFFLINE: '1',
        WHALE_USER_DATA_DIR: join(dir, 'profile'), WHALE_E2E_BWF_ENDPOINT: bwf.endpoint,
        WHALE_E2E_KNOWLEDGE_ROOT: materials,
        WHALE_E2E_ENVOY_FIXTURE: join(root, 'tools/mock-harness/fixtures/knowledge-slice/envoy-fixture.cjs'),
      },
    });
    let app: ElectronApplication | undefined;
    try {
      app = await launch();
      let page = await director(app);
      expect(await page.evaluate(() => (window as unknown as { directorBridge: Bridge }).directorBridge.v2KnowledgeSourceStatus())).toMatchObject({ state: 'available', readOnly: true });
      const request = { filePath: file, topic: '春季浇水', licenseScope: 'mit', applicability: ['春季'] };
      const first = await page.evaluate((input) => (window as unknown as { directorBridge: Bridge }).directorBridge.v2KnowledgeImport(input), request);
      const second = await page.evaluate((input) => (window as unknown as { directorBridge: Bridge }).directorBridge.v2KnowledgeImport(input), request);
      expect(first.ok).toBe(true); expect(first.pack!.digest).toBe(second.pack!.digest);
      expect(first.units[0]!.unitState).toBe('candidate');
      const id = first.units[0]!.knowledgeId;
      const action = await page.evaluate((knowledgeId) => (window as unknown as { directorBridge: Bridge }).directorBridge.v2KnowledgeExecute({ knowledgeId, tool: 'water_crops' }), id);
      expect(action.receipt).toMatchObject({ receiptStatus: 'COMPLETED', stateChanged: true, evidenceLevel: 'simulation' });
      expect(calls).toContain('water_crops');
      await app.close(); app = await launch(); page = await director(app);
      const persisted = await page.evaluate((knowledgeId) => (window as unknown as { directorBridge: Bridge }).directorBridge.v2KnowledgeReceipts(knowledgeId), id);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.rawReceipt).toBe('成功：已给四株作物浇水');
      expect(persisted[0]!.beforeState).toContain('需浇水：4');
      expect(persisted[0]!.afterState).toContain('需浇水：0');
      const unchanged = await page.evaluate((knowledgeId) => (window as unknown as { directorBridge: Bridge }).directorBridge.v2KnowledgeExecute({ knowledgeId, tool: 'water_crops' }), id);
      expect(unchanged.receipt).toMatchObject({ receiptStatus: 'UNCERTAIN', suspicious: true });
      rmSync(file);
      const list = await page.evaluate(() => (window as unknown as { directorBridge: Bridge }).directorBridge.v2KnowledgeList());
      expect(JSON.stringify(list)).toContain('failed');
    } finally {
      await app?.close(); await bwf.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
