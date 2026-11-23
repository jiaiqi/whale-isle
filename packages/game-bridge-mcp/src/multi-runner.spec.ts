/**
 * T-M6-27 双 runner 并发隔离：两个独立端点同时自驾时，
 * 事件各自携带自己的 sessionId，互不串台；停掉一个不影响另一个。
 * 用进程内 HTTP 假 BWF 服务（同 mcp-client 双解析路径），不触网。
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AutodriveRunner, type AutodriveEvent } from './autodrive';
import { StardewAdapter } from './adapter';

function stateText(location: string): string {
  return `## 基本状态
时间：第1年春16日 07:30，天气：晴，明天天气：晴
金钱：100g  体力：200/270  生命：100/100
## 当前界面
无（可以自由行动）
## 位置
地点：${location}，室外
## 背包
（空）`;
}

async function startFakeBwf(location: string): Promise<{ server: Server; endpoint: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const payload = JSON.parse(body) as { params?: { name?: string } };
      const tool = payload.params?.name ?? 'get_state';
      calls.push(tool);
      const text = tool === 'get_state' ? stateText(location) : `完成 ${tool}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError: false } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, endpoint: `http://127.0.0.1:${port}/mcp`, calls };
}

describe('T-M6-27 双 runner 并发', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('两个端点的 sessionId 不同，事件各归各；停一台不影响另一台', async () => {
    const a = await startFakeBwf('FarmA');
    const b = await startFakeBwf('FarmB');
    servers.push(a.server, b.server);

    const events: Array<{ sid: string; event: AutodriveEvent }> = [];
    const runnerA = new AutodriveRunner(
      (event) => events.push({ sid: runnerA.sessionId, event }),
      { maxCycles: 4, stepDelayMs: 1, pollDelayMs: 1, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); } },
      new StardewAdapter(a.endpoint),
    );
    const runnerB = new AutodriveRunner(
      (event) => events.push({ sid: runnerB.sessionId, event }),
      { maxCycles: 4, stepDelayMs: 1, pollDelayMs: 1, sleep: async () => { await new Promise((r) => setTimeout(r, 5)); } },
      new StardewAdapter(b.endpoint),
    );

    expect(runnerA.sessionId).not.toBe(runnerB.sessionId);
    await runnerA.start();
    await runnerB.start();

    // A 收到专属指令，B 不应被影响
    runnerA.submitDirective('water_crops', {}, '只给 A 的指令');
    // 等到 A 真正执行完这条指令（最多 10s；不提前 stopAndWait，否则会中断循环）
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !a.calls.includes('water_crops')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Promise.all([runnerA.stopAndWait(), runnerB.stopAndWait()]);

    const sidA = runnerA.sessionId;
    const sidB = runnerB.sessionId;
    expect(events.length).toBeGreaterThan(0);
    // 每个事件都带有自己 runner 的 sessionId（调用点即归属，不会出现对方的 sid）
    for (const entry of events) expect([sidA, sidB]).toContain(entry.sid);

    // A 的指令只出现在 A 的端点调用里
    expect(a.calls).toContain('water_crops');
    expect(b.calls).not.toContain('water_crops');

    // A 的状态事件只报 FarmA，B 只报 FarmB（证明两条链路互不串台）
    const clockA = events.filter((e) => e.sid === sidA && e.event.type === 'state').map((e) => e.event);
    const clockB = events.filter((e) => e.sid === sidB && e.event.type === 'state').map((e) => e.event);
    expect(clockA.length).toBeGreaterThan(0);
    expect(clockB.length).toBeGreaterThan(0);
    for (const event of clockA) expect(event.type === 'state' ? event.location : '').toContain('FarmA');
    for (const event of clockB) expect(event.type === 'state' ? event.location : '').toContain('FarmB');
  }, 20_000);
});
