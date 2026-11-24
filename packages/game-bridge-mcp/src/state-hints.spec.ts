/** 环境障碍摘要（T-M6-57）：商店打烊/无鱼竿/低空位/箱子摘要 + ≤240 字上限。 */
import { describe, expect, it } from 'vitest';
import { extractEnvironmentHints } from './state-hints';

const STATE = `时间：第1年春16日 07:30（Tue），天气：晴
金钱：640g  体力：98/270  生命：100/100
## 背包
5: 防风草种子 x15
6: 木材 x22
背包空位：2 个（共 12 格）`;

describe('extractEnvironmentHints', () => {
  it('早上 8:30：鱼店未开门 + 无鱼竿 + 只剩 2 格', () => {
    const hints = extractEnvironmentHints(STATE, 8 * 60 + 30, []);
    expect(hints).toContain('背包没有鱼竿');
    expect(hints).toContain('list_chests');
    expect(hints).toContain('09:00 才开门');
    expect(hints).toContain('背包只剩 2 个空位');
  });

  it('17:00 后提醒打烊；10:00 营业时间不提醒', () => {
    expect(extractEnvironmentHints(STATE, 18 * 60, [])).toContain('17:00 已打烊');
    expect(extractEnvironmentHints(STATE, 10 * 60, [])).not.toContain('打烊');
    expect(extractEnvironmentHints(STATE, 10 * 60, [])).not.toContain('才开门');
  });

  it('背包有鱼竿不提醒；状态省略背包段时绝不断言「没有鱼竿」', () => {
    expect(extractEnvironmentHints(STATE.replace('木材 x22', '竹鱼竿（手持）'), 10 * 60, [])).not.toContain('没有鱼竿');
    const noBackpack = '时间：第1年春16日 10:00\n## 位置\n地点：Farm';
    expect(extractEnvironmentHints(noBackpack, 10 * 60, [])).not.toContain('没有鱼竿');
    expect(extractEnvironmentHints(noBackpack, 10 * 60, [])).not.toContain('空位');
  });

  it('空位 3 格不告警；0 格告警', () => {
    expect(extractEnvironmentHints(STATE.replace('背包空位：2', '背包空位：3'), 10 * 60, [])).not.toContain('空位');
    expect(extractEnvironmentHints(STATE.replace('背包空位：2', '背包空位：0'), 10 * 60, [])).toContain('只剩 0 个空位');
  });

  it('取最后一条 list_chests 成功回执摘要（COMPLETED/OK 两种前缀）', () => {
    const receipts = [
      'COMPLETED list_chests: 旧箱子：石头 x9',
      'FAILED list_chests: 附近没有箱子',
      'COMPLETED list_chests: Farm 箱子1：鱼竿 x1、木材 x50',
    ];
    const hints = extractEnvironmentHints(STATE, 10 * 60, receipts);
    expect(hints).toContain('Farm 箱子1：鱼竿 x1、木材 x50');
    expect(hints).not.toContain('旧箱子');
    expect(extractEnvironmentHints(STATE, 10 * 60, ['OK list_chests: 箱子A：蟹笼 x2'])).toContain('箱子A：蟹笼 x2');
    expect(extractEnvironmentHints(STATE, 10 * 60, ['COMPLETED buy: 买了种子'])).not.toContain('刚查到的箱子');
    // 成功前缀但摘要为空 → 跳过，不生成空箱子提示
    expect(extractEnvironmentHints(STATE, 10 * 60, ['COMPLETED list_chests:   '])).not.toContain('刚查到的箱子');
  });

  it('总长 ≤240 字（注入预算硬上限）', () => {
    const huge = `${STATE}\n${'COMPLETED list_chests: ' + '箱子：' + '物品'.repeat(200)}`;
    const hints = extractEnvironmentHints(huge, 18 * 60, [huge.split('\n').pop() ?? '']);
    expect(hints.length).toBeLessThanOrEqual(240);
  });

  it('空状态/无回执返回空串（不编造）', () => {
    expect(extractEnvironmentHints('', Number.NaN, [])).toBe('');
  });
});
