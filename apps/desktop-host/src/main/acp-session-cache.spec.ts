/** ACP 会话 id 一致性（T-M6-51）：start/permission/exit 必须共用同一 sessionId。 */
import { describe, expect, it } from 'vitest';
import { createAcpSessionCache } from './acp-session-cache';

describe('acp-session-cache', () => {
  it('session-started 后 permission/exit 使用同一 sessionId', () => {
    const cache = createAcpSessionCache();
    expect(cache.onStarted('claude', 'sess-real-1')).toBe('sess-real-1');
    expect(cache.resolve('claude')).toBe('sess-real-1');
    expect(cache.onExit('claude')).toBe('sess-real-1');
  });

  it('未握手时回退稳定 id；exit 后重新回退，不串会话', () => {
    const cache = createAcpSessionCache();
    expect(cache.resolve('codex')).toBe('acp-codex');
    expect(cache.resolve('codex')).toBe('acp-codex');
    cache.onStarted('codex', 's1');
    expect(cache.onExit('codex')).toBe('s1');
    expect(cache.resolve('codex')).toBe('acp-codex');
  });

  it('多 preset 互不影响', () => {
    const cache = createAcpSessionCache();
    cache.onStarted('claude', 'a');
    cache.onStarted('gemini', 'b');
    expect(cache.resolve('claude')).toBe('a');
    expect(cache.resolve('gemini')).toBe('b');
    cache.onExit('claude');
    expect(cache.resolve('claude')).toBe('acp-claude');
    expect(cache.resolve('gemini')).toBe('b');
  });
});
