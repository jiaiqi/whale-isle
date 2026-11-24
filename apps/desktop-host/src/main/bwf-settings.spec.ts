/**
 * BWF /settings 推送单测（T-M6-16）：fetch 全注入（零网络）。
 * 契约形状：POST {revision, settings:{showHud}} → 快照回读 settings.showHud 判断 applied；
 * 旧 DLL 忽略未知键 → 快照无 showHud → applied:false（UI 据此提示需重启游戏换补丁版）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BWF_DEFAULT_PORT, pushBwfShowHud, syncBwfConfigPort } from './bwf-settings';

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
