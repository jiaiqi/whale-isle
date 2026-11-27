/** [SIMULATION] 独立 MCP 子进程 + HTTP BWF 回环 + 真实磁盘 SQLite，未启动真实游戏。 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvoyKnowledgeSource } from '@workbench/agent-harness';
import { ActionLock, StardewAdapter } from '@workbench/game-bridge-mcp';
import { KnowledgeHost, registerKnowledgeIpc, type KnowledgeGamePort } from './knowledge-host';

const fixture = fileURLToPath(new URL('../../../../tools/mock-harness/fixtures/knowledge-slice/envoy-fixture.cjs', import.meta.url));
const materialText = readFileSync(new URL('../../../../tools/mock-harness/fixtures/knowledge-slice/spring-guide.md', import.meta.url), 'utf8');
const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.reverse()) await dispose(); disposers.length = 0; });

async function setup(mode = 'ready', outcome = 'COMPLETED') {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-host-'));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'authorized'); mkdirSync(root);
  const file = join(root, 'spring.md'); writeFileSync(file, materialText);
  let changed = false;
  const tools: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += String(chunk); });
    request.on('end', () => {
      const rpc = JSON.parse(body) as { id: number; params: { name: string } };
      tools.push(rpc.params.name);
      const getState = rpc.params.name === 'get_state';
      if (!getState && outcome === 'COMPLETED') changed = true;
      const text = getState
        ? `游戏版本：1.6.15\n已装 Mod：原版\n时间：第1年春3日 06:00，天气：晴\n需浇水：${changed ? 0 : 4}`
        : outcome === 'COMPLETED' || outcome === 'NO_CHANGE' ? '成功：浇水完成' : outcome === 'UNCERTAIN' ? 'UNCERTAIN：可能被接管' : '失败：没有作物';
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }], isError: !getState && ['UNCERTAIN', 'FAILED'].includes(outcome) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  disposers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const adapter = new StardewAdapter(`http://127.0.0.1:${address.port}/mcp`);
  const port: KnowledgeGamePort = { adapter, lock: new ActionLock(adapter.transport), blockedReason: () => null };
  let currentPort: KnowledgeGamePort | null = port;
  const source = new EnvoyKnowledgeSource({ materialsRoot: root, stateDir: join(dir, 'state'), command: mode === 'missing' ? '' : process.execPath, uvCommand: process.execPath, args: [fixture, mode], timeoutMs: 2_000 });
  const createHost = (newSource = source) => new KnowledgeHost({ userDataDir: join(dir, 'profile'), materialsRoot: root, source: newSource, game: () => currentPort, simulation: true, guides: { 本地: materialText } });
  const host = createHost(); disposers.push(() => host.close());
  const importMaterial = (extra = {}) => host.importMaterial({ filePath: file, topic: '春季浇水', licenseScope: 'mit', ...extra });
  return { host, file, importMaterial, tools, port, dir, root, source, setPort: (value: KnowledgeGamePort | null) => { currentPort = value; }, createHost };
}

describe('04D：知识宿主四段链路与反例', () => {
  it('读材料 → 同 digest → candidate → get_state → 真 HTTP 动作回执 → SQLite 复查', async () => {
    const { host, importMaterial, tools } = await setup();
    const imported = await importMaterial({ applicability: ['春季', '第3日'] });
    expect(imported.ok).toBe(true);
    expect(imported.units[0]).toMatchObject({ unitState: 'candidate', evidenceLevel: 'unverified', confidence: 0.5 });
    const twice = await importMaterial({ applicability: ['春季', '第3日'] });
    expect(twice.pack!.digest).toBe(imported.pack!.digest);
    expect(host.evidence()).toHaveLength(1);
    const id = imported.units[0]!.knowledgeId;
    expect(await host.assess(id)).toMatchObject({ executable: true, runtimeGameVersion: '1.6.15' });
    const result = await host.execute({ knowledgeId: id, tool: 'water_crops' });
    expect(result.receipt).toMatchObject({ receiptStatus: 'COMPLETED', stateChanged: true, suspicious: false, evidenceLevel: 'simulation' });
    expect(result.receipt!.rawReceipt).toContain('成功：浇水完成');
    expect(host.receipts(id)).toHaveLength(1);
    expect(tools).toContain('water_crops');
    expect(host.list().units.find((item) => item.knowledgeId === id)!.unitState).toBe('candidate');
    const handlers = new Map<string, (_event: unknown, input?: unknown) => unknown>();
    registerKnowledgeIpc({ handle: (channel, handler) => { handlers.set(channel, handler); } }, host);
    expect(handlers.size).toBe(7);
    expect(await handlers.get('v2:knowledge-source-status')!(null)).toMatchObject({ state: 'available', readOnly: true, materialCount: 1 });
    expect(handlers.get('v2:knowledge-receipts')!(null)).toEqual(host.receipts());
    expect(handlers.get('v2:knowledge-evidence')!(null)).toEqual(host.evidence());
    expect(handlers.get('v2:knowledge-list')!(null)).toEqual(host.list());
    expect(await handlers.get('v2:knowledge-assess')!(null, id)).toMatchObject({ executable: true });
  });
  it('材料缺失或修订变更后证据失败/部分抽取，停止执行且不写假回执', async () => {
    const { host, file, importMaterial, tools } = await setup();
    const imported = await importMaterial(); const id = imported.units[0]!.knowledgeId;
    writeFileSync(file, `${materialText}\n新增版本\n`);
    expect(host.list().units.find((item) => item.knowledgeId === id)!.evidenceRefs[0]!.extraction).toBe('partial');
    rmSync(file);
    expect(host.list().units.find((item) => item.knowledgeId === id)!.evidenceRefs[0]!.extraction).toBe('failed');
    expect((await importMaterial()).ok).toBe(false);
    expect((await host.execute({ knowledgeId: id, tool: 'water_crops' })).availability).toBe('blocked');
    expect(host.receipts()).toEqual([]);
    expect(tools).not.toContain('water_crops');
  });
  it.each(['missing', 'blocked', 'unlocatable', 'derived'])('Envoy/材料异常 %s 回退真实本地攻略，无假证据', async (mode) => {
    const { host, importMaterial } = await setup(mode);
    const result = await importMaterial();
    expect(result.ok).toBe(false); expect(result.units).toEqual([]);
    expect(result.degradedReason).toContain('本地攻略');
    expect(host.evidence()).toEqual([]);
    expect(host.list().localTopics).toEqual(['本地']);
    expect(host.list().units.every((unit) => unit.evidenceRefs.length === 0)).toBe(true);
  });
  it('BWF 不可达时返回 unavailable，无动作无回执', async () => {
    const { host, importMaterial, setPort, tools } = await setup();
    const imported = await importMaterial(); setPort(null);
    const result = await host.execute({ knowledgeId: imported.units[0]!.knowledgeId, tool: 'water_crops', ownerOverride: true });
    expect(result).toMatchObject({ availability: 'unavailable', applicability: { status: 'uncertain', executable: false } });
    expect(result.receipt).toBeUndefined(); expect(host.receipts()).toEqual([]); expect(tools).toEqual([]);
  });
  it.each(['NO_CHANGE', 'FAILED', 'UNCERTAIN'])('游戏回执 %s 原样保存；无变化不升级', async (outcome) => {
    const { host, importMaterial } = await setup('ready', outcome);
    const imported = await importMaterial(); const id = imported.units[0]!.knowledgeId;
    const result = await host.execute({ knowledgeId: id, tool: 'water_crops' });
    expect(result.receipt!.receiptStatus).toBe(outcome === 'FAILED' ? 'FAILED' : 'UNCERTAIN');
    expect(result.receipt!.suspicious).toBe(outcome === 'NO_CHANGE');
    expect(host.receipts(id)[0]!.rawReceipt).toBe(result.receipt!.rawReceipt);
    if (outcome !== 'FAILED') expect(host.list().units.find((item) => item.knowledgeId === id)!.confidence).toBe(0.5);
  });
  it('版本/Mod/条件不匹配、许可未知、急停/接管与非白名单动作全部拒绝', async () => {
    for (const extra of [{ gameVersion: '1.5' }, { modContext: ['SVE'] }, { applicability: ['夏季'] }, { licenseScope: 'unknown' }]) {
      const { host, importMaterial, tools } = await setup();
      const imported = await importMaterial(extra);
      const result = await host.execute({ knowledgeId: imported.units[0]!.knowledgeId, tool: 'water_crops' });
      expect(result.availability).toBe('blocked'); expect(tools).not.toContain('water_crops');
    }
    const { host, port, importMaterial } = await setup();
    const imported = await importMaterial(); const id = imported.units[0]!.knowledgeId;
    port.blockedReason = () => '急停';
    expect((await host.execute({ knowledgeId: id, tool: 'water_crops' })).reason).toBe('急停');
    expect((await host.execute({ knowledgeId: id, tool: 'exec' })).availability).toBe('blocked');
    await expect(host.execute({ knowledgeId: 'missing', tool: 'wait' })).rejects.toThrow('知识不存在');
  });
  it('部分抽取不升验证，使用保存的证据包仍可复核', async () => {
    const { host, importMaterial } = await setup('partial');
    const imported = await importMaterial();
    expect(imported.pack!.extraction).toBe('partial');
    expect(imported.units[0]!.confidence).toBe(0);
    expect((await host.assess(imported.units[0]!.knowledgeId)).executable).toBe(false);
  });
});
