/**
 * BWF /settings 推送单测（T-M6-16）：fetch 全注入（零网络）。
 * 契约形状：POST {revision, settings:{showHud}} → 快照回读 settings.showHud 判断 applied；
 * 旧 DLL 忽略未知键 → 快照无 showHud → applied:false（UI 据此提示需重启游戏换补丁版）。
 */
import { describe, expect, it } from 'vitest';
import { pushBwfShowHud } from './bwf-settings';

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe('pushBwfShowHud', () => {
  it('新 DLL：快照回读 showHud === 目标值 → applied:true', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) as unknown });
      return jsonResponse({ settings: { showHud: false } });
    }) as unknown as typeof fetch;
    const res = await pushBwfShowHud(false, 'http://127.0.0.1:18080', fetchImpl);
    expect(res).toEqual({ applied: true, reachable: true, showHud: false });
    expect(calls[0]?.url).toBe('http://127.0.0.1:18080/settings');
    expect(calls[0]?.method).toBe('POST');
    expect((calls[0]?.body as { settings: { showHud: boolean } }).settings).toEqual({ showHud: false });
  });

  it('旧 DLL：接受 POST 但快照里没有 showHud → applied:false（需重启游戏）', async () => {
    const fetchImpl = (async () => jsonResponse({ settings: { freezeTime: true } })) as unknown as typeof fetch;
    const res = await pushBwfShowHud(true, 'http://127.0.0.1:18080', fetchImpl);
    expect(res).toEqual({ applied: false, reachable: true, showHud: true });
  });

  it('HTTP 非 200 → reachable:true applied:false；连接拒绝 → reachable:false（游戏没开，静默）', async () => {
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await pushBwfShowHud(false, 'http://127.0.0.1:18080', bad)).toEqual({ applied: false, reachable: true, showHud: false });
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await pushBwfShowHud(false, 'http://127.0.0.1:18080', dead)).toEqual({ applied: false, reachable: false, showHud: false });
  });
});
