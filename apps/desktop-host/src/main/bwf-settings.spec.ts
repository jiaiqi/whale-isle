/**
 * BWF /settings 推送单测（T-M6-16）：fetch 全注入（零网络）。
 * 契约形状：POST {revision, settings:{showHud}} → 快照回读 settings.showHud 判断 applied；
 * 旧 DLL 忽略未知键 → 快照无 showHud → applied:false（UI 据此提示需重启游戏换补丁版）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BWF_DEFAULT_PORT, pushBwfPlayerInControl, pushBwfShowHud, resolveBwfEndpoint, syncBwfConfigPort } from './bwf-settings';

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe('pushBwfShowHud', () => {
  it('新 DLL：快照回读 showHud === 目标值 → applied:true', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) as unknown });
      return jsonResponse({ settings: { showHud: false } });
    }) as unknown as typeof fetch;
    const res = await pushBwfShowHud(false, 'http://localhost:18088', fetchImpl);
    expect(res).toEqual({ applied: true, reachable: true, showHud: false });
    expect(calls[0]?.url).toBe('http://localhost:18088/settings');
    expect(calls[0]?.method).toBe('POST');
    expect((calls[0]?.body as { settings: { showHud: boolean } }).settings).toEqual({ showHud: false });
  });

  it('旧 DLL：接受 POST 但快照里没有 showHud → applied:false（需重启游戏）', async () => {
    const fetchImpl = (async () => jsonResponse({ settings: { freezeTime: true } })) as unknown as typeof fetch;
    const res = await pushBwfShowHud(true, 'http://localhost:18088', fetchImpl);
    expect(res).toEqual({ applied: false, reachable: true, showHud: true });
  });

  it('HTTP 非 200 → reachable:true applied:false；连接拒绝 → reachable:false（游戏没开，静默）', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await pushBwfShowHud(false, 'http://localhost:18088', bad)).toEqual({ applied: false, reachable: true, showHud: false });
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await pushBwfShowHud(false, 'http://localhost:18088', dead)).toEqual({ applied: false, reachable: false, showHud: false });
  });
});

describe('syncBwfConfigPort', () => {
  it('默认端口避开 18080，原子更新 BlindWhaleFarmer/config.json 且保留其他字段', () => {
    expect(BWF_DEFAULT_PORT).toBe(18088);
    const root = mkdtempSync(join(tmpdir(), 'bwf-port-'));
    try {
      const bwfDir = join(root, 'BlindWhaleFarmer');
      mkdirSync(bwfDir, { recursive: true });
      const configPath = join(bwfDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ McpPort: 18080, ShowHud: false, KeepField: 'ok' }), 'utf8');
      const first = syncBwfConfigPort(root, 18088);
      expect(first).toMatchObject({ ok: true, updated: true, previousPort: 18080 });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ McpPort: 18088, ShowHud: false, KeepField: 'ok' });
      // 幂等：已是目标端口不重复写盘
      expect(syncBwfConfigPort(root, 18088)).toMatchObject({ ok: true, updated: false, previousPort: 18088 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缺少 BlindWhaleFarmer 目录时如实返回 ok:false', () => {
    const root = mkdtempSync(join(tmpdir(), 'bwf-port-empty-'));
    try {
      expect(syncBwfConfigPort(root, 18088).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * T-M6-73：托管开关同步到游戏侧。BWF 补丁把 SetPlayerInControl 排到主线程，
 * POST 返回的快照还是旧值，所以必须回读若干次；旧 DLL 快照里根本没有这个键。
 */
describe('pushBwfPlayerInControl', () => {
  it('新 DLL：回读快照 playerInControl === 目标值 → applied:true / supported:true', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
      return jsonResponse({ settings: { playerInControl: true } });
    }) as unknown as typeof fetch;
    const res = await pushBwfPlayerInControl(true, 'http://localhost:18088', fetchImpl);
    expect(res).toEqual({ applied: true, reachable: true, supported: true, playerInControl: true });
    expect(calls[0]?.method).toBe('POST');
    expect((calls[0]?.body as { settings: { playerInControl: boolean } }).settings).toEqual({ playerInControl: true });
  });

  it('主线程调度竞态：第一次回读还是旧值，第二次才变 → applied:true', async () => {
    let reads = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ settings: { playerInControl: false } });
      reads += 1;
      return jsonResponse({ settings: { playerInControl: reads >= 2 } });
    }) as unknown as typeof fetch;
    const res = await pushBwfPlayerInControl(true, 'http://localhost:18088', fetchImpl);
    expect(res.applied).toBe(true);
    expect(reads).toBe(2);
  });

  it('旧 DLL：快照里没有 playerInControl → supported:false（不重试，提示按 F7）', async () => {
    let reads = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') reads += 1;
      return jsonResponse({ settings: { showHud: false } });
    }) as unknown as typeof fetch;
    const res = await pushBwfPlayerInControl(true, 'http://localhost:18088', fetchImpl);
    expect(res).toEqual({ applied: false, reachable: true, supported: false, playerInControl: true });
    expect(reads).toBe(1);
  });

  it('补丁在但一直没生效 → applied:false / supported:true；连接拒绝 → reachable:false', async () => {
    const stuck = (async (_url: string | URL, init?: RequestInit) =>
      jsonResponse({ settings: { playerInControl: init?.method === 'POST' ? false : false } })) as unknown as typeof fetch;
    expect(await pushBwfPlayerInControl(true, 'http://localhost:18088', stuck))
      .toEqual({ applied: false, reachable: true, supported: true, playerInControl: true });

    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await pushBwfPlayerInControl(true, 'http://localhost:18088', dead))
      .toEqual({ applied: false, reachable: false, supported: false, playerInControl: true });
  });

  it('HTTP 非 200 → reachable:true / supported:false', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await pushBwfPlayerInControl(false, 'http://localhost:18088', bad))
      .toEqual({ applied: false, reachable: true, supported: false, playerInControl: false });
  });
});

describe('resolveBwfEndpoint（E2E 仿真端点注入）', () => {
  it('未注入 / 空串 → 回落真实端口端点', () => {
    expect(resolveBwfEndpoint({ port: 18088 })).toBe('http://127.0.0.1:18088/mcp');
    expect(resolveBwfEndpoint({ testEndpoint: undefined, port: 18088 })).toBe('http://127.0.0.1:18088/mcp');
    expect(resolveBwfEndpoint({ testEndpoint: '   ', port: 18088 })).toBe('http://127.0.0.1:18088/mcp');
    expect(resolveBwfEndpoint({})).toBe(`http://127.0.0.1:${BWF_DEFAULT_PORT}/mcp`);
  });

  it('注入测试端点 → 原样使用（不改协议、不加路径、不看端口）', () => {
    expect(resolveBwfEndpoint({ testEndpoint: 'http://127.0.0.1:51234/mcp', port: 18088 })).toBe('http://127.0.0.1:51234/mcp');
    expect(resolveBwfEndpoint({ testEndpoint: ' http://127.0.0.1:1/custom ', port: 18088 })).toBe('http://127.0.0.1:1/custom');
  });
});
