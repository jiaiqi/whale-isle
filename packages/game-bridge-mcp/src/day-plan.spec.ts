import { describe, expect, it } from 'vitest';
import { DayPlanStore, parsePlanUpdate } from './day-plan.js';

const dawn = '第1年夏24日 06:00';
const later = '第1年夏24日 10:00';
const noon = '第1年夏24日 12:00';

function morning(): DayPlanStore {
  const store = new DayPlanStore();
  store.setMorningPlan('夏24', [
    { goal: '整理背包', why: '出门准备', status: 'in_progress' },
    { goal: '给威利送礼', why: '生日', status: 'pending' },
    { goal: '钓鱼', why: '补充收入', status: 'pending' },
  ], undefined, dawn);
  return store;
}

describe('每日计划引用与时间线回归', () => {
  it('模型显示的 ref 能准确更新首项和末项', () => {
    const store = morning();
    const refs = [...store.formatForPrompt().matchAll(/\[ref=(\d+)\]/g)].map((m) => Number(m[1]));
    expect(refs).toEqual([0, 1, 2]);
    const updated = store.applyUpdate('夏24', { done: [refs[0]!], inProgress: [refs[2]!] }, later);
    expect(updated?.items.map((item) => item.status)).toEqual(['done', 'pending', 'in_progress']);
    expect(store.applyUpdate('夏24', { remove: [refs[2]!] }, noon)?.items.map((item) => item.goal)).toEqual(['整理背包', '给威利送礼']);
  });

  it.each(['array', 'object'])('重排保留旧时间与完成态：%s 输入', (mode) => {
    const store = morning();
    store.applyUpdate('夏24', { done: [0] }, later);
    const items = [
      { goal: '给威利送礼', status: 'done' },
      { goal: '整理背包', why: '已经整理好' },
      { goal: '钓鱼' },
      { goal: '回家睡觉' },
    ];
    const update = parsePlanUpdate(mode === 'array' ? items : { replace: items, why: '礼物已送达，调整后续安排' });
    const result = store.applyUpdate('夏24', update!, noon)!;
    expect(result.items[0]).toMatchObject({ goal: '给威利送礼', addedAt: dawn, completedAt: noon, status: 'done' });
    expect(result.items[1]).toMatchObject({ goal: '整理背包', addedAt: dawn, completedAt: later, status: 'done' });
    expect(result.items[2]).toMatchObject({ goal: '钓鱼', addedAt: dawn, status: 'pending' });
    expect(result.items[3]?.addedAt).toBe(noon);
    expect(result.history?.at(-1)?.summary).toContain('完成「给威利送礼」');
  });

  it('重复新增不降级进行态，推进请求不重开已完成项', () => {
    const store = morning();
    const first = store.applyUpdate('夏24', parsePlanUpdate({ add: [{ goal: '整理背包！', why: '补充说明' }] })!, later);
    expect(first?.items[0]?.status).toBe('in_progress');
    store.applyUpdate('夏24', { done: [0] }, later);
    const second = store.applyUpdate('夏24', { inProgress: [0] }, noon);
    expect(second?.items[0]).toMatchObject({ status: 'done', completedAt: later });
  });

  it('移除最后目标后发布空列表并保留原因和时间', () => {
    const store = new DayPlanStore();
    store.setMorningPlan('夏24', [{ goal: '去找矮人', why: '送礼', status: 'pending' }], undefined, dawn);
    const result = store.applyUpdate('夏24', { remove: [0], why: '道路无法通过，今天取消' }, later);
    expect(result?.items).toEqual([]);
    expect(store.snapshot()?.items).toEqual([]);
    expect(result?.history?.at(-1)).toMatchObject({ atClock: later, why: '道路无法通过，今天取消' });
    expect(result?.history?.at(-1)?.summary).toContain('移除「去找矮人」');
  });

  it('计划条目达到 6 条时提示先确认是否与已有目标重复', () => {
    const store = new DayPlanStore();
    const items = Array.from({ length: 5 }, (_, i) => ({ goal: `目标${i + 1}`, why: '', status: 'pending' as const }));
    store.setMorningPlan('秋1', items, undefined, '第1年秋1日 06:00');
    expect(store.formatForPrompt()).not.toContain('计划条目已较多');

    const six = Array.from({ length: 6 }, (_, i) => ({ goal: `目标${i + 1}`, why: '', status: 'pending' as const }));
    store.setMorningPlan('秋1', six, undefined, '第1年秋1日 06:00');
    const text = store.formatForPrompt();
    expect(text).toContain('计划条目已较多');
    expect(text).toContain('不要另开同义目标');
  });
});
