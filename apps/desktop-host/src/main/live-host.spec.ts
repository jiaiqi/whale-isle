/**
 * T-M6-37 直播最小链路单测：真实 LiveEventHub + 本地事件，零网络零 Electron。
 */
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { createLiveHost } from './live-host';

function event(text: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    eventId: randomUUID(),
    platform: 'douyin',
    eventType: 'DANMAKU',
    sender: { uid: 'u-1', nickname: '观众', intimacyScore: 0, grudgeTags: [] },
    payload: { rawText: text, mergedCount: 1 },
    assignedPriority: 'P1_CADENCE',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('直播最小链路', () => {
  it('非法事件被契约拒绝，合法事件被接受', () => {
    const host = createLiveHost({ windows: () => [] });
    expect(host.ingest({ nope: true }).status).toBe('rejected');
    const result = host.ingest(event('今天天气真好'));
    expect(['accepted', 'dropped']).toContain(result.status);
    host.stop();
  });

  it('回放样本：护栏/去重/注意力管线产出批次与事件视图', () => {
    const host = createLiveHost({ windows: () => [] });
    const accepted = host.replay();
    expect(accepted).toBeGreaterThan(0);
    const history = host.history();
    expect(history.length).toBeGreaterThan(0);
    const texts = history.flatMap((b) => b.events.map((e) => e.text));
    expect(texts.some((t) => t.includes('大肥鱼') || t.includes('晴天'))).toBe(true);
    const snapshot = host.snapshot();
    expect(snapshot.received).toBeGreaterThanOrEqual(4);
    expect(snapshot.attention).toBeDefined();
    host.stop();
  });

  it('重复 eventId 被去重，不清空则计数可观察', () => {
    const host = createLiveHost({ windows: () => [] });
    const fixed = { ...(event('重复弹幕') as Record<string, unknown>), eventId: '11111111-1111-4111-8111-111111111111' };
    expect(host.ingest(fixed).status).toBe('accepted');
    expect(host.ingest(fixed).status).toBe('duplicate');
    expect(host.snapshot().duplicates).toBe(1);
    host.stop();
  });

  it('批次会推送到渲染窗口与插件总线', () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const wc = {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    } as unknown as import('electron').WebContents;
    const pluginEvents: Array<[string, unknown]> = [];
    const host = createLiveHost({
      windows: () => [wc],
      onPluginEvent: (name, payload) => pluginEvents.push([name, payload]),
    });
    host.setTargets([wc]);
    host.replay();
    expect(sent.some((s) => s.channel === 'live:batch')).toBe(true);
    expect(pluginEvents.some(([name]) => name === 'live:batch')).toBe(true);
    host.stop();
  });
});
