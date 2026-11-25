/**
 * T-M6-67 卡死判定：四条判定（clock-stall / repeat-failure / bwf-self-pause / sentinel）、
 * 白名单豁免、同签名 5 分钟去重、失败签名归一化。
 */
import { describe, expect, it } from 'vitest';
import type { AutodriveEvent } from '@workbench/game-bridge-mcp';
import {
  failureSignature,
  normalizeFailureReason,
  normalizeLocation,
  PAUSE_TEXT_RE,
  StuckDetector,
  WHITELIST_TEXT_RE,
} from './stuck-detector';

const CLOCK_A = '第1年春16日 10:00';
const CLOCK_B = '第1年春16日 10:10';

function stateEvent(clock: string, location = 'Farm'): AutodriveEvent {
  return { type: 'state', clock, stamina: 100, staminaMax: 270, money: 100, location };
}

function receipt(tool: string, status: 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'TIMEOUT' | 'ERROR', summary: string): AutodriveEvent {
  return { type: 'receipt', tool, status, summary };
}

describe('失败签名归一化', () => {
  it('同一原因的不同坐标/数量得到同一签名', () => {
    const a = failureSignature('fish', '背包里没有鱼竿 (12,34)', 'Beach');
    const b = failureSignature('fish', '背包里没有鱼竿 (55,7)', 'Beach（海滩）');
    expect(a).toBe(b);
    expect(a).toBe('fish|背包里没有鱼竿 (坐标)|Beach');
  });

  it('引号物品名、星级、think 段与标点都被抹平', () => {
    const left = normalizeFailureReason('<think>犹豫</think>背包里没有“竹鱼竿” 金星 x3，请先准备。');
    const right = normalizeFailureReason('背包里没有“铱星鱼竿” 银星 x9，请先准备！');
    expect(left).toBe('背包里没有〈物品〉 x# 请先准备');
    expect(left).toBe(right);
  });

  it('超长原因截断到 80 字内', () => {
    const text = normalizeFailureReason('错'.repeat(200));
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text.endsWith('…')).toBe(true);
  });

  it('地点缺省为「未知」并去掉括号说明', () => {
    expect(normalizeLocation('Farm（泡泡湾农场）')).toBe('Farm');
    expect(normalizeLocation('   ')).toBe('未知');
  });

  it('暂停/白名单文案正则覆盖真机两种写法', () => {
    expect(PAUSE_TEXT_RE.test('已暂停游戏')).toBe(true);
    expect(PAUSE_TEXT_RE.test('120 秒没有动作')).toBe(true);
    expect(PAUSE_TEXT_RE.test('一切正常')).toBe(false);
    expect(WHITELIST_TEXT_RE.test('正在存档…')).toBe(true);
    expect(WHITELIST_TEXT_RE.test('无（可以自由行动）')).toBe(false);
  });
});

describe('clock-stall', () => {
  it('时钟连续 180s 不推进才判定；时钟变化会重置计时', () => {
    const detector = new StuckDetector({ clockStallMs: 1_000 });
    expect(detector.onClock(CLOCK_A, '', 0)).toBeNull();
    expect(detector.onClock(CLOCK_B, '', 500)).toBeNull(); // 时钟变化 → 重置
    expect(detector.onClock(CLOCK_B, '', 1_300)).toBeNull();
    const verdict = detector.onClock(CLOCK_B, '', 1_600);
    expect(verdict).toMatchObject({ kind: 'clock-stall', clock: CLOCK_B });
    expect(verdict?.detail).toContain('未推进');
  });

  it('判定后同签名 5 分钟内只报一次（冷却去重）', () => {
    const detector = new StuckDetector({ clockStallMs: 500 });
    detector.onClock(CLOCK_A, '', 0);
    expect(detector.onClock(CLOCK_A, '', 600)?.kind).toBe('clock-stall');
    expect(detector.onClock(CLOCK_A, '', 1_200)).toBeNull();
    expect(detector.onClock(CLOCK_A, '', 5 * 60_000 + 700)?.kind).toBe('clock-stall');
  });

  it('睡觉决策与睡觉回执之间豁免；回执到达后从回执时刻重新计时', () => {
    const detector = new StuckDetector({ clockStallMs: 500 });
    detector.onClock(CLOCK_A, '', 0);
    detector.onEvent({ type: 'decision', planner: 'rule', tool: 'sleep', args: {}, intent: '睡觉' }, 0);
    expect(detector.onClock(CLOCK_A, '', 10_000)).toBeNull(); // 决策后的白名单窗口
    detector.onEvent(receipt('sleep', 'COMPLETED', '睡了一觉'), 10_100);
    expect(detector.onClock(CLOCK_A, '', 10_400)).toBeNull(); // 换日过场：重新给满一个阈值
    expect(detector.onClock(CLOCK_A, '', 10_700)?.kind).toBe('clock-stall');
  });

  it('过场/存档文本、02:00–06:00 换日窗口都豁免', () => {
    const detector = new StuckDetector({ clockStallMs: 500 });
    detector.onClock(CLOCK_A, '正在存档…', 0);
    expect(detector.onClock(CLOCK_A, '正在存档…', 10_000)).toBeNull();

    const night = '第1年春17日 03:00';
    const nightDetector = new StuckDetector({ clockStallMs: 500 });
    nightDetector.onClock(night, '', 0);
    expect(nightDetector.onClock(night, '', 10_000)).toBeNull();
  });

  it('时钟无法解析时不判定（状态异常 ≠ 卡死）', () => {
    const detector = new StuckDetector({ clockStallMs: 500 });
    expect(detector.onClock(null, '乱码', 0)).toBeNull();
    expect(detector.onClock(null, '乱码', 10_000)).toBeNull();
    expect(detector.onClock('第9年??', '', 20_000)).toBeNull();
  });

  it('resetClock 可在恢复动作后重新计时', () => {
    const detector = new StuckDetector({ clockStallMs: 500 });
    detector.onClock(CLOCK_A, '', 0);
    detector.resetClock(900);
    expect(detector.onClock(CLOCK_A, '', 1_000)).toBeNull();
  });

  it('state 事件推进时钟并记录地点（签名带地点）', () => {
    const detector = new StuckDetector({ clockStallMs: 500 });
    detector.onEvent(stateEvent(CLOCK_A, 'Beach（海滩）'), 0);
    detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 10);
    expect(detector.failureCounts().has('fish|背包里没有鱼竿|Beach')).toBe(true);
  });
});

describe('repeat-failure', () => {
  it('同签名 3 次且游戏时间未推进 → 判定；第 4 次被冷却去重', () => {
    const detector = new StuckDetector();
    detector.onEvent(stateEvent(CLOCK_A, 'Beach'), 0);
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 1)).toBeNull();
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 2)).toBeNull();
    const verdict = detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 3);
    expect(verdict?.kind).toBe('repeat-failure');
    expect(verdict?.signature).toBe('fish|背包里没有鱼竿|Beach');
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 4)).toBeNull();
  });

  it('游戏时间推进超过 1 小时（有进展）不判定', () => {
    const detector = new StuckDetector();
    detector.onEvent(stateEvent(CLOCK_A, 'Beach'), 0);
    detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 1);
    detector.onClock('第1年春16日 11:30', '', 2);
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 3)).toBeNull();
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 4)).toBeNull();
  });

  it('COMPLETED 回执不触发，且窗口只保留最近 30 条', () => {
    const detector = new StuckDetector({ repeatWindow: 3 });
    detector.onEvent(stateEvent(CLOCK_A, 'Farm'), 0);
    detector.onEvent(receipt('fish', 'FAILED', '没有鱼竿'), 1);
    detector.onEvent(receipt('water_crops', 'COMPLETED', '浇完了'), 2);
    detector.onEvent(receipt('forage', 'COMPLETED', '采到 2 个'), 3);
    detector.onEvent(receipt('fish', 'FAILED', '没有鱼竿'), 4);
    // 前两条失败已被 3 条窗口挤出，只剩 1 条 → 不判定
    expect(detector.onEvent(receipt('fish', 'FAILED', '没有鱼竿'), 5)).toBeNull();
  });

  it('失败签名计数包含 ERROR/TIMEOUT，不含 UNCERTAIN', () => {
    const detector = new StuckDetector();
    detector.onEvent(stateEvent(CLOCK_A, 'Farm'), 0);
    detector.onEvent(receipt('water_crops', 'ERROR', '客户端错误'), 1);
    detector.onEvent(receipt('water_crops', 'TIMEOUT', '超时（water_crops 仍在游戏侧执行的风险）'), 2);
    detector.onEvent(receipt('water_crops', 'UNCERTAIN', '不确定'), 3);
    const counts = [...detector.failureCounts().keys()];
    expect(counts).toContain('water_crops|客户端错误|Farm');
    expect(counts.some((signature) => signature.includes('超时'))).toBe(true);
    expect(counts.some((signature) => signature.includes('不确定'))).toBe(false);
  });

  it('autodrive 汇总回执不参与判定', () => {
    const detector = new StuckDetector();
    detector.onEvent(stateEvent(CLOCK_A, 'Farm'), 0);
    expect(detector.onEvent(receipt('autodrive', 'COMPLETED', '达到 maxCycles'), 1)).toBeNull();
    expect(detector.failureCounts().size).toBe(0);
  });
});

describe('bwf-self-pause / sentinel', () => {
  it('回执出现「已暂停游戏」→ bwf-self-pause（冷却内只报一次）', () => {
    const detector = new StuckDetector();
    detector.onEvent(stateEvent(CLOCK_A, 'Farm'), 0);
    const verdict = detector.onEvent(receipt('get_state', 'FAILED', '游戏已暂停'), 1);
    expect(verdict?.kind).toBe('bwf-self-pause');
    expect(detector.onEvent(receipt('get_state', 'FAILED', '游戏已暂停'), 2)).toBeNull();
  });

  it('状态文本出现「秒没有动作」→ bwf-self-pause', () => {
    const detector = new StuckDetector();
    expect(detector.onClock(CLOCK_A, '提示：BWF 120 秒没有动作，已暂停游戏', 0)?.kind).toBe('bwf-self-pause');
  });

  it('runner watchdog kind=stuck → sentinel；heartbeat 忽略', () => {
    const detector = new StuckDetector();
    expect(detector.onEvent({ type: 'watchdog', kind: 'heartbeat', detail: 'get_state 超时' }, 0)).toBeNull();
    const verdict = detector.onEvent({ type: 'watchdog', kind: 'stuck', detail: '同一动作连续失败 3 次' }, 1);
    expect(verdict?.kind).toBe('sentinel');
    expect(detector.last).toBe(verdict);
  });
});

describe('human-control 临时介入防误判（T-M6-72b）', () => {
  it('介入期间时钟停滞、自暂停文案与连续失败均不判卡死；退出后重新计时', () => {
    const detector = new StuckDetector({ clockStallMs: 1_000 });
    detector.onClock(CLOCK_A, '', 0);
    detector.onEvent({ type: 'human-control', active: true, reason: 'switch' }, 200);
    expect(detector.isHumanControl).toBe(true);

    // 远超 1s 阈值 + 自暂停文案 + 3 次同签名失败，全豁免
    expect(detector.onClock(CLOCK_A, '已暂停游戏', 10_000)).toBeNull();
    expect(detector.onClock(CLOCK_B, '', 11_000)).toBeNull();
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 11_100)).toBeNull();
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 11_200)).toBeNull();
    expect(detector.onEvent(receipt('fish', 'FAILED', '背包里没有鱼竿'), 11_300)).toBeNull();
    expect(detector.failureCounts().size).toBe(0);

    // 交还时重置时钟基线：须完整走满 1_000ms 才判 clock-stall
    detector.onEvent({ type: 'human-control', active: false, reason: 'resume', summary: '介入了 11 秒' }, 12_000);
    expect(detector.isHumanControl).toBe(false);
    expect(detector.onClock(CLOCK_B, '', 12_500)).toBeNull();
    expect(detector.onClock(CLOCK_B, '', 13_100)?.kind).toBe('clock-stall');
  });
});
