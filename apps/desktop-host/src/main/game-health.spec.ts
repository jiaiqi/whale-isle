/**
 * 三游戏桥接探活单测（T-M6-25）：fetch 全注入（零网络），三态语义如实断言。
 *   online = 桥接在线且游戏侧就绪；reachable = 连得上但未就绪；offline = 连不上。
 * 铁律：探活只反映连通性，绝不把「没连上」粉饰成「已连接」。
 */
import { describe, expect, it } from 'vitest';
import { fetchDstSnapshot, probeAllGames, probeBwfRuntime, probeGameHealth } from './game-health';

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

  it('MCP result.isError=true → reachable，不误判 online', async () => {
    const fetchImpl = (async () => json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '内部错误：状态未准备好' }],
        isError: true,
      },
    })) as unknown as typeof fetch;
    const report = await probeGameHealth('stardew', { fetchImpl });
    expect(report.status).toBe('reachable');
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('返回错误');
  });

  it('requireLanHost=true：进档但未开 LAN 监听 → reachable；房主 LAN 监听后 → online', async () => {
    const mcpOk = json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '时间：第1年春1日 06:00' }], isError: false } });
    const unreadySettings = json({
      revision: 'r1',
      runtime: { worldReady: true, saveFolderName: '鲸屿_123', capabilities: ['create_new_save', 'lan_status'] },
      lan: { isHost: true, multiplayerMode: 2, serverRunning: true, lanListening: false, lanPort: 24642 },
    });
    const fetchNotListening = (async (url: string | URL) =>
      String(url).endsWith('/settings') ? unreadySettings.clone() : mcpOk.clone()) as unknown as typeof fetch;
    const notListeningReport = await probeGameHealth('stardew', { fetchImpl: fetchNotListening, requireLanHost: true });
    expect(notListeningReport.status).toBe('reachable');
    expect(notListeningReport.detail).toContain('LAN 服务器尚未监听');

    const readySettings = json({
      revision: 'r2',
      runtime: { worldReady: true, saveFolderName: '鲸屿_123', capabilities: ['create_new_save', 'lan_status'] },
      lan: {
        isHost: true,
        multiplayerMode: 2,
        serverRunning: true,
        lanListening: true,
        lanPort: 24642,
        acceptIpConnections: true,
        inviteCode: null,
        startingCabins: 2,
        availableFarmhandSlots: 2,
        worldReady: true,
        saveFolderName: '鲸屿_123',
        languageCode: 'zh',
      },
    });
    const fetchListening = (async (url: string | URL) =>
      String(url).endsWith('/settings') ? readySettings.clone() : mcpOk.clone()) as unknown as typeof fetch;
    const listeningReport = await probeGameHealth('stardew', { fetchImpl: fetchListening, requireLanHost: true });
    expect(listeningReport.status).toBe('online');
    expect(listeningReport.runtime?.lan?.lanPort).toBe(24642);
    expect(listeningReport.runtime?.lan?.availableFarmhandSlots).toBe(2);
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

  it('probeBwfRuntime：兼容旧版无 runtime 字段，并能正确捕获异常返回 null', async () => {
    const legacy = await probeBwfRuntime('http://127.0.0.1:18088', 1000, (async () => json({ settings: { showHud: true } })) as unknown as typeof fetch);
    expect(legacy).toEqual({ reachable: true, capabilities: [], lan: null });

    const broken = await probeBwfRuntime('http://127.0.0.1:18088', 1000, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(broken).toBeNull();
  });
});
