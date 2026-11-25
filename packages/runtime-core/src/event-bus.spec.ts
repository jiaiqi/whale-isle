import { describe, expect, it, vi } from 'vitest';
import { matchesEventPattern, RuntimeEventBus } from './index';

describe('RuntimeEventBus', () => {
  it('matches exact, wildcard suffix, and catch-all patterns', () => {
    expect(matchesEventPattern('*', 'anything')).toBe(true);
    expect(matchesEventPattern('character:*', 'character:mood')).toBe(true);
    expect(matchesEventPattern('character:*', 'kernel:started')).toBe(false);
    expect(matchesEventPattern('kernel:started', 'kernel:started')).toBe(true);
    expect(matchesEventPattern('kernel:started', 'kernel:stopped')).toBe(false);
  });

  it('publishes typed envelopes, isolates listener errors, supports once/dispose and history replay', () => {
    const onListenerError = vi.fn();
    let tick = 100;
    const bus = new RuntimeEventBus({ maxHistory: 10, now: () => ++tick, onListenerError });

    const seenAll: string[] = [];
    const seenOnce: number[] = [];
    const subAll = bus.subscribe('*', (ev) => {
      seenAll.push(`${ev.seq}:${ev.type}:${ev.source}`);
    });
    bus.subscribe('character:*', () => {
      throw new Error('bad handler');
    });
    bus.once<{ v: number }>('character:mood', (ev) => {
      seenOnce.push(ev.payload.v);
    });

    expect(bus.subscriberCount).toBe(3);

    bus.publish('character:mood', { v: 1 }, { source: 'test', characterId: 'char_xiaojing' });
    bus.publish('character:mood', { v: 2 });
    expect(seenOnce).toEqual([1]);
    expect(onListenerError).toHaveBeenCalledTimes(2);
    expect(seenAll).toEqual(['1:character:mood:test', '2:character:mood:kernel']);

    subAll.dispose();
    subAll.dispose();
    expect(bus.subscriberCount).toBe(1);

    for (let i = 0; i < 12; i += 1) {
      bus.publish('tick:step', { i });
    }
    expect(bus.history(50)).toHaveLength(10);
    expect(bus.history(50, 'character:*')).toHaveLength(0);
    expect(bus.history(3, 'tick:*')).toHaveLength(3);

    bus.clearHistory();
    expect(bus.history()).toHaveLength(0);
  });
});
