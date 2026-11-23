/**
 * T-M6-27 会话隔离纯函数单测：渲染层只消费当前 autodrive 会话的事件。
 * 覆盖四条丢弃规则：联机端点事件 / 旧 generation / 异 sessionId / 异 gameId。
 */
import { describe, expect, it } from 'vitest';
import { isCurrentSessionEvent, type AutodriveEventView } from './bridge';

const receipt = (patch: Partial<AutodriveEventView> = {}): AutodriveEventView => ({
  type: 'receipt',
  tool: 'fish',
  status: 'COMPLETED',
  summary: '钓到一条沙丁鱼',
  ...patch,
});

describe('isCurrentSessionEvent', () => {
  it('同会话事件保留（sessionId + gameId + generation 全匹配）', () => {
    expect(isCurrentSessionEvent(
      receipt({ sessionId: 's1', gameId: 'stardew', generation: 3 }),
      { sessionId: 's1', gameId: 'stardew', generation: 3 },
      'stardew',
    )).toBe(true);
  });

  it('联机端点事件（agentId）不进单会话页', () => {
    expect(isCurrentSessionEvent(
      receipt({ agentId: 'ep-2', sessionId: 's9', gameId: 'stardew' }),
      { sessionId: 's1', gameId: 'stardew', generation: 1 },
      'stardew',
    )).toBe(false);
  });

  it('旧 generation 的迟到事件被丢弃（切游戏/重建 runner 后）', () => {
    expect(isCurrentSessionEvent(
      receipt({ sessionId: 's1', gameId: 'stardew', generation: 2 }),
      { sessionId: 's1', gameId: 'stardew', generation: 5 },
      'stardew',
    )).toBe(false);
    // 同代次仍保留
    expect(isCurrentSessionEvent(
      receipt({ sessionId: 's1', gameId: 'stardew', generation: 5 }),
      { sessionId: 's1', gameId: 'stardew', generation: 5 },
      'stardew',
    )).toBe(true);
  });

  it('异 sessionId 被丢弃；当前会话未知时放行（兼容旧主进程）', () => {
    expect(isCurrentSessionEvent(
      receipt({ sessionId: 's2', gameId: 'stardew', generation: 3 }),
      { sessionId: 's1', gameId: 'stardew', generation: 3 },
      'stardew',
    )).toBe(false);
    expect(isCurrentSessionEvent(
      receipt({ sessionId: 's2', gameId: 'stardew', generation: 3 }),
      { generation: -1 },
      'stardew',
    )).toBe(true);
  });

  it('异 gameId 被丢弃（切到泰拉瑞亚后星露谷残留不回显）', () => {
    expect(isCurrentSessionEvent(
      receipt({ sessionId: 's1', gameId: 'stardew', generation: 3 }),
      { sessionId: 's1', gameId: 'stardew', generation: 3 },
      'terraria',
    )).toBe(false);
  });

  it('无归属字段的旧事件保持兼容（不因升级丢失历史水合）', () => {
    expect(isCurrentSessionEvent(receipt(), { sessionId: 's1', generation: 3 }, 'stardew')).toBe(true);
  });
});
