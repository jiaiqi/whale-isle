/** 彩蛋小剧场（T-M6-65）：host/hostSkin 优先、五段剧本双路径、并发防重入与解散清理。 */
import { describe, expect, it } from 'vitest';
import { createEggTheater, pickEggScript, skinNameOf, type EggScript, type EggTheaterTimerApi } from './egg-theater';

function script(overrides: Partial<EggScript> & Pick<EggScript, 'characterId'>): EggScript {
  return {
    name: overrides.characterId,
    host: '',
    hostSkin: '',
    aura: '',
    lines: {
      pop: ['pop-1', 'pop-2'],
      pretend: ['pretend-1', 'pretend-2'],
      caught: ['caught-1'],
      bye: ['bye-1'],
      escape: ['escape-1'],
    },
    ...overrides,
  };
}

function fakeTimers(): { api: EggTheaterTimerApi; advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    api: {
      setTimeout(fn, ms) {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id as number);
      },
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function harness(scripts: EggScript[], mainCharacterId = 'crosspet-gpt-onesie') {
  const timers = fakeTimers();
  const eggLines: string[] = [];
  const hostLines: string[] = [];
  const phases: string[] = [];
  const closed: string[] = [];
  const opened: string[] = [];
  const theater = createEggTheater({
    scripts: () => scripts,
    openEgg: (chosen) => {
      opened.push(chosen.characterId);
      return { ok: true, agentId: `agent-${chosen.characterId}` };
    },
    sayEgg: (_agentId, text) => eggLines.push(text),
    sayHost: (text) => hostLines.push(text),
    onPhase: (phase) => phases.push(phase),
    closeEgg: (agentId) => closed.push(agentId),
    timers: timers.api,
    rng: () => 0,
    popMs: 1_200,
    pretendMs: 5_000,
    pretendIntervalMs: 2_200,
    caughtToByeMs: 3_000,
    byeToCloseMs: 2_500,
    escapeToCloseMs: 2_500,
  });
  void mainCharacterId;
  return { theater, timers, eggLines, hostLines, phases, closed, opened };
}

describe('pickEggScript / skinNameOf', () => {
  it('hostSkin 精确优先于 host；无专属时随机通用彩蛋', () => {
    const skin = script({ characterId: 'egg-skin', hostSkin: 'gpt-onesie', host: 'claude' });
    const host = script({ characterId: 'egg-host', host: 'gpt-onesie' });
    const generic = script({ characterId: 'egg-generic', host: 'qwen' });
    expect(skinNameOf('crosspet-gpt-onesie')).toBe('gpt-onesie');
    expect(pickEggScript([generic, host, skin], 'crosspet-gpt-onesie', () => 0)?.characterId).toBe('egg-skin');
    expect(pickEggScript([generic, host, skin], 'crosspet-claude-saint', () => 0)?.characterId).toBe('egg-generic');
    expect(pickEggScript([], 'crosspet-gpt')).toBeNull();
  });

  it('同分候选按 rng 选择，不总是第一个', () => {
    const a = script({ characterId: 'a', host: 'gpt' });
    const b = script({ characterId: 'b', host: 'gpt' });
    expect(pickEggScript([a, b], 'crosspet-gpt', () => 0.99)?.characterId).toBe('b');
  });
});

describe('EggTheater：溜走分支 pop→pretend→escape', () => {
  it('pop 后进入 pretend 轮播，5s 后 escape，2.5s 自动关闭', async () => {
    const { theater, timers, eggLines, phases, closed } = harness([script({ characterId: 'egg-a' })]);
    const result = await theater.start('crosspet-gpt-onesie');
    expect(result.ok).toBe(true);
    expect(theater.state()).toBe('pop');
    expect(eggLines).toEqual(['pop-1']);
    expect(phases).toEqual(['pop']);

    timers.advance(1_200);
    expect(theater.state()).toBe('pretend');
    expect(eggLines.at(-1)).toBe('pretend-1');
    timers.advance(2_200);
    expect(eggLines.filter((line) => line.startsWith('pretend'))).toHaveLength(2);

    timers.advance(2_800); // 累计 6.2s：pretend 5s 结束 → escape
    expect(theater.state()).toBe('escape');
    expect(eggLines.at(-1)).toBe('escape-1');
    timers.advance(2_500);
    expect(theater.state()).toBe('idle');
    expect(closed).toEqual(['agent-egg-a']);
    expect(timers.pending()).toBe(0);
  });
});

describe('EggTheater：抓包分支与资源保护', () => {
  it('pop 期间抓包 → caught → 主宠回应 → bye → 关闭；状态机不再走进 escape', async () => {
    const { theater, timers, eggLines, hostLines, phases, closed } = harness([script({ characterId: 'egg-b' })]);
    await theater.start('crosspet-gpt');
    expect(theater.catch()).toEqual({ ok: true, caught: true });
    expect(theater.state()).toBe('caught');
    expect(eggLines.at(-1)).toBe('caught-1');
    expect(hostLines).toEqual(['抓住你啦！']);
    expect(phases).toEqual(['pop', 'caught']);
    timers.advance(3_000);
    expect(theater.state()).toBe('bye');
    expect(eggLines.at(-1)).toBe('bye-1');
    timers.advance(2_500);
    expect(theater.state()).toBe('idle');
    expect(closed).toEqual(['agent-egg-b']);
    expect(theater.catch()).toMatchObject({ ok: false });
    expect(timers.pending()).toBe(0);
  });

  it('同一时刻只允许一场；dismiss 立即清理定时器与窗口，不重复关闭', async () => {
    const { theater, timers, closed } = harness([script({ characterId: 'egg-c' })]);
    await theater.start('crosspet-gpt');
    const second = await theater.start('crosspet-gpt');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('已有一场');
    theater.dismiss();
    expect(theater.state()).toBe('idle');
    expect(closed).toEqual(['agent-egg-c']);
    expect(timers.pending()).toBe(0);
    timers.advance(60_000);
    expect(closed).toEqual(['agent-egg-c']);
    expect((await theater.start('crosspet-gpt')).ok).toBe(true);
  });

  it('没有可用彩蛋/打开失败如实返回；打开异常不抛出', async () => {
    const emptyTimers = fakeTimers();
    const empty = createEggTheater({
      scripts: () => [],
      openEgg: () => ({ ok: true, agentId: 'x' }),
      sayEgg: () => undefined,
      sayHost: () => undefined,
      closeEgg: () => undefined,
      timers: emptyTimers.api,
    });
    expect(await empty.start('crosspet-gpt')).toMatchObject({ ok: false, error: '未找到可用彩蛋素材' });

    const failTimers = fakeTimers();
    const fail = createEggTheater({
      scripts: () => [script({ characterId: 'egg-d' })],
      openEgg: () => ({ ok: false, error: '窗口忙' }),
      sayEgg: () => undefined,
      sayHost: () => undefined,
      closeEgg: () => undefined,
      timers: failTimers.api,
    });
    expect(await fail.start('crosspet-gpt')).toMatchObject({ ok: false, error: '窗口忙' });

    const throwTimers = fakeTimers();
    const thrown = createEggTheater({
      scripts: () => [script({ characterId: 'egg-e' })],
      openEgg: () => { throw new Error('boom'); },
      sayEgg: () => undefined,
      sayHost: () => undefined,
      closeEgg: () => undefined,
      timers: throwTimers.api,
    });
    expect(await thrown.start('crosspet-gpt')).toMatchObject({ ok: false, error: 'boom' });
  });
});
