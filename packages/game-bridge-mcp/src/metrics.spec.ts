/**
 * T-M6-35 自治质量指标单测：全部从事件流派生，空集不伪造数值。
 */
import { describe, expect, it } from 'vitest';
import { formatRate, summarizeAutodriveQuality, type QualityEventLike } from './metrics';

const ev = (type: string, tool?: string, status?: string): QualityEventLike => ({ type, ...(tool === undefined ? {} : { tool }), ...(status === undefined ? {} : { status }) });

describe('summarizeAutodriveQuality', () => {
  it('空事件流：计数为 0，比率为 null（不伪造 100%/0%）', () => {
    const q = summarizeAutodriveQuality([]);
    expect(q.decisions).toBe(0);
    expect(q.receipts).toBe(0);
    expect(q.successRate).toBeNull();
    expect(q.failureRate).toBeNull();
    expect(q.repeatRate).toBeNull();
    expect(formatRate(null)).toBe('—');
  });

  it('回执成功/失败/超时口径：TIMEOUT 不计成功也不计失败', () => {
    const q = summarizeAutodriveQuality([
      ev('receipt', 'fish', 'COMPLETED'),
      ev('receipt', 'mine', 'FAILED'),
      ev('receipt', 'travel_to', 'TIMEOUT'),
      ev('receipt', 'water_crops', 'UNCERTAIN'),
      ev('receipt', 'shop', 'ERROR'),
    ]);
    expect(q.receipts).toBe(5);
    expect(q.completed).toBe(1);
    expect(q.failed).toBe(1);
    expect(q.timeout).toBe(1);
    expect(q.uncertain).toBe(1);
    expect(q.error).toBe(1);
    expect(q.successRate).toBeCloseTo(0.2);
    // FAILED + ERROR = 2/5；TIMEOUT/UNCERTAIN 不算失败
    expect(q.failureRate).toBeCloseTo(0.4);
  });

  it('重复动作率：连续同工具才算重复，think 不参与', () => {
    const q = summarizeAutodriveQuality([
      ev('decision', 'think'),
      ev('decision', 'travel_to'),
      ev('decision', 'travel_to'),
      ev('decision', 'travel_to'),
      ev('decision', 'fish'),
      ev('decision', 'travel_to'),
    ]);
    expect(q.decisions).toBe(5);
    expect(q.distinctTools).toBe(2);
    expect(q.longestToolStreak).toBe(3);
    // 3 次 travel_to 中第 2、3 次算重复 → 2/5
    expect(q.repeatRate).toBeCloseTo(0.4);
  });

  it('编排器汇总回执（tool=autodrive）不计入回执统计', () => {
    const q = summarizeAutodriveQuality([
      ev('receipt', 'autodrive', 'COMPLETED'),
      ev('receipt', 'fish', 'COMPLETED'),
    ]);
    expect(q.receipts).toBe(1);
    expect(q.successRate).toBe(1);
  });

  it('watchdog 计数独立，不影响回执比率', () => {
    const q = summarizeAutodriveQuality([
      ev('watchdog'),
      ev('watchdog'),
      ev('receipt', 'fish', 'COMPLETED'),
    ]);
    expect(q.watchdogs).toBe(2);
    expect(q.receipts).toBe(1);
    expect(q.successRate).toBe(1);
  });

  it('无 tool 的 decision 与非决策事件被忽略', () => {
    const q = summarizeAutodriveQuality([
      { type: 'decision' },
      { type: 'state' },
      { type: 'cycle-end' },
      { type: 'decision', tool: 'fish' },
    ]);
    expect(q.decisions).toBe(1);
    expect(q.distinctTools).toBe(1);
    expect(q.repeatRate).toBe(0);
  });

  it('未知回执状态（如 ABORTED_BY_HUMAN_TAKEOVER）计入回执但不进任何分类', () => {
    const q = summarizeAutodriveQuality([
      ev('receipt', 'fish', 'ABORTED_BY_HUMAN_TAKEOVER'),
      ev('receipt', 'fish', 'COMPLETED'),
    ]);
    expect(q.receipts).toBe(2);
    expect(q.completed).toBe(1);
    expect(q.failed).toBe(0);
    expect(q.successRate).toBe(0.5);
  });

  it('formatRate 输出整数百分比', () => {
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.666)).toBe('67%');
    expect(formatRate(1)).toBe('100%');
  });
});
