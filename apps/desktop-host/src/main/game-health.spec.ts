/**
 * 三游戏桥接探活单测（T-M6-25）：fetch 全注入（零网络），三态语义如实断言。
 *   online = 桥接在线且游戏侧就绪；reachable = 连得上但未就绪；offline = 连不上。
 * 铁律：探活只反映连通性，绝不把「没连上」粉饰成「已连接」。
 */
import { describe, expect, it } from 'vitest';
import { fetchDstSnapshot, probeAllGames, probeGameHealth } from './game-health';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const HEALTHY_TERRARIA = {
  ok: true,
  gameId: 'terraria',
  bridgeVersion: '0.1.0',
  gameVersion: '1.4.4.9',
  control: 'AI_AUTOPILOT',
};

describe('probeGameHealth · 星露谷（BWF MCP）', () => {
  it('get_state 正常应答 → online，且不给启动指引', async () => {
    const fetchImpl = (async () => json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '时间：第1年春3日' }] } })) as unknown as typeof fetch;
    const report = await probeGameHealth('stardew', { fetchImpl });
    expect(report.status).toBe('online');
    expect(report.ok).toBe(true);
    expect(report.guidance).toEqual([]);
    expect(report.detail).toContain('BWF MCP 在线');
  });

  it('SSE 形态响应同样解析为 online（真机在 JSON/SSE 间摇摆）', async () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n';
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const report = await probeGameHealth('stardew', { fetchImpl });
    expect(report.status).toBe('online');
  });

  it('标题画面：HTTP 200 + isError:false +「还没有进入存档」→ reachable，不冒充 online', async () => {
    const fetchImpl = (async () => json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '游戏还没有进入存档（在标题画面或正在加载）。请玩家先读取存档。' }],
        isError: false,
      },
    })) as unknown as typeof fetch;
    const report = await probeGameHealth('stardew', { fetchImpl });
    expect(report.status).toBe('reachable');
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('标题画面');
    expect(report.guidance.length).toBeGreaterThan(0);
  });

  it('MCP 返回 error（游戏在跑但没进存档）→ reachable + 启动指引', async () => {
    const fetchImpl = (async () => json({ jsonrpc: '2.0', id: 1, error: { message: 'no save loaded' } })) as unknown as typeof fetch;
    const report = await probeGameHealth('stardew', { fetchImpl });
    expect(report.status).toBe('reachable');
    expect(report.ok).toBe(false);
    expect(report.error).toContain('no save loaded');
    expect(report.guidance.length).toBeGreaterThan(0);
  });

  it('连接被拒 → offline + 启动指引（绝不显示「已连接」）', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const report = await probeGameHealth('stardew', { fetchImpl });
    expect(report.status).toBe('offline');
    expect(report.ok).toBe(false);
    expect(report.guidance.join('')).toContain('星露谷');
  });
});

describe('probeGameHealth · 泰拉瑞亚 / DST（统一 /health）', () => {
  it('健康契约通过且 gameId 匹配 → online（摘要含版本与控制权）', async () => {
    const fetchImpl = (async () => json(HEALTHY_TERRARIA)) as unknown as typeof fetch;
    const report = await probeGameHealth('terraria', { fetchImpl });
    expect(report.status).toBe('online');
    expect(report.detail).toContain('桥接 0.1.0');
    expect(report.detail).toContain('AI 托管中');
    expect(report.guidance).toEqual([]);
  });

  it('health.ok=false → reachable（桥接在、游戏侧未就绪）', async () => {
    const fetchImpl = (async () => json({ ...HEALTHY_TERRARIA, ok: false })) as unknown as typeof fetch;
    const report = await probeGameHealth('terraria', { fetchImpl });
    expect(report.status).toBe('reachable');
    expect(report.guidance.length).toBeGreaterThan(0);
  });

  it('gameId 不匹配 → reachable（串台了，如实提示）', async () => {
    const fetchImpl = (async () => json({ ...HEALTHY_TERRARIA, gameId: 'dst' })) as unknown as typeof fetch;
    const report = await probeGameHealth('terraria', { fetchImpl });
    expect(report.status).toBe('reachable');
    expect(report.detail).toContain('dst');
  });

  it('HTTP 500 / 非 JSON / 契约违规 → reachable 并带错误说明', async () => {
    const serverError = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    expect((await probeGameHealth('dst', { fetchImpl: serverError })).status).toBe('reachable');

    const notJson = (async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch;
    expect((await probeGameHealth('dst', { fetchImpl: notJson })).detail).toContain('非 JSON');

    const badContract = (async () => json({ ok: true })) as unknown as typeof fetch;
    expect((await probeGameHealth('dst', { fetchImpl: badContract })).detail).toContain('不符合契约');
  });

  it('连接被拒 → offline（带引导）', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const report = await probeGameHealth('dst', { fetchImpl });
    expect(report.status).toBe('offline');
    expect(report.guidance.join('')).toContain('cluster_token');
  });
});

describe('probeAllGames / fetchDstSnapshot', () => {
  it('probeAllGames 一次给出三游戏报告（互不阻塞）', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      if (target.includes('/mcp')) return json({ jsonrpc: '2.0', id: 1, result: {} });
      if (target.includes('18100')) return json({ ...HEALTHY_TERRARIA, gameId: 'dst' });
      return json(HEALTHY_TERRARIA);
    }) as unknown as typeof fetch;
    const reports = await probeAllGames({ fetchImpl });
    expect(reports.map((r) => r.gameId)).toEqual(['stardew', 'terraria', 'dst']);
    expect(reports.every((r) => r.status === 'online')).toBe(true);
  });

  it('fetchDstSnapshot：快照过契约才返回，否则如实报错', async () => {
    const snapshot = {
      schemaVersion: 1,
      capturedAt: 1,
      clock: { cycle: 1, phase: 'day', season: 'autumn', isRaining: false },
      player: {
        character: 'wilson',
        health: { current: 150, max: 150 },
        hunger: { current: 118, max: 150 },
        sanity: { current: 185, max: 200 },
        temperature: 20,
        position: { x: 1, z: 3 },
        inventory: [],
      },
      nearby: { entities: [], campfires: [] },
      threats: [],
      control: { authority: 'AI_AUTOPILOT', isPlayerMovingPhysically: false },
    };
    const fetchImpl = (async () => json(snapshot)) as unknown as typeof fetch;
    const ok = await fetchDstSnapshot({ fetchImpl });
    expect(ok.ok).toBe(true);
    expect(ok.snapshot?.clock.cycle).toBe(1);

    const broken = (async () => json({ schemaVersion: 1 })) as unknown as typeof fetch;
    const bad = await fetchDstSnapshot({ fetchImpl: broken });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('契约违规');
  });
});
