import { describe, expect, it } from 'vitest';
import {
  buildFailedActionLedgerSection,
  concreteHintForFailure,
  createFailedActionLedger,
  extractFailureSubject,
  FAILED_ACTION_ALERT_THRESHOLD,
  FAILED_ACTION_LEDGER_LIMIT,
  parseFailedActionLedgerFile,
  parseFailedActionRecord,
  recordFailedAction,
  serializeFailedActionLedger,
  type FailedActionRecord,
} from './failed-action-ledger';
import { failedActionLedgerPromptText, observeFailedAction, type FailedActionLedgerHost } from './failed-action-ledger-wiring';

function rec(receipt: string, clock = '第1年秋5日 06:00', dayKey = '1-秋5', ts = '2026-11-28T07:00:00.000Z') {
  return parseFailedActionRecord(receipt, clock, dayKey, ts);
}

describe('跨日失败动作账本（V2-P4-01 秋5 真机）', () => {
  it('只解析 FAILED 回执，非失败回执返回 null', () => {
    expect(rec('COMPLETED take_items: 成功：取出木材x10')).toBeNull();
    expect(rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')).not.toBeNull();
    expect(rec('FAILED take_items: ')).toBeNull();
  });

  it('关键参数提取：坐标优先，其次引号物品，再次地点', () => {
    expect(extractFailureSubject('take_items', '失败：(69,16) 四周没有可以站的地方')).toBe('(69,16)');
    expect(extractFailureSubject('list_chests', '失败：哪个箱子里都没有“花椰菜”')).toBe('花椰菜');
    expect(extractFailureSubject('travel_to', '失败：玛妮的牧场（AnimalShop）还没开门（营业 09:00-18:00，现在 06:00）')).toBe('AnimalShop');
  });

  it('同签名累计失败并跨日保留：夏28 学到的限制在秋5 再次被提示', () => {
    const ledger = createFailedActionLedger();
    const summer = rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方', '第1年夏28日 07:40', '1-夏28', '2026-11-28T00:00:00.000Z');
    expect(summer).not.toBeNull();
    const first = recordFailedAction(ledger, summer!);
    // 一次失败还不提示
    expect(buildFailedActionLedgerSection(first, '1-夏28')).toBe('');

    const autumn = rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方', '第1年秋5日 06:30', '1-秋5', '2026-11-28T07:00:00.000Z');
    const second = recordFailedAction(first, autumn!);
    expect(second.records[0]?.count).toBe(FAILED_ACTION_ALERT_THRESHOLD);

    const section = buildFailedActionLedgerSection(second, '1-秋5');
    expect(section).toContain('跨日累计失败动作');
    expect(section).toContain('(69,16)');
    expect(section).toContain('累计失败2次');
    // 跨日标记
    expect(section).toContain('首次见于1-夏28');
  });

  it('不同签名互不干扰', () => {
    let ledger = createFailedActionLedger();
    ledger = recordFailedAction(ledger, rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')!);
    ledger = recordFailedAction(ledger, rec('FAILED travel_to: 失败：玛妮的牧场（AnimalShop）还没开门')!);
    ledger = recordFailedAction(ledger, rec('FAILED travel_to: 失败：玛妮的牧场（AnimalShop）还没开门')!);
    expect(ledger.records).toHaveLength(2);
    const section = buildFailedActionLedgerSection(ledger, '1-秋5');
    expect(section).toContain('AnimalShop');
    expect(section).not.toContain('(69,16)');
  });

  it('提示段只陈述事实，不出现硬性措辞（AI-first 红线）', () => {
    let ledger = createFailedActionLedger();
    ledger = recordFailedAction(ledger, rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')!);
    ledger = recordFailedAction(ledger, rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')!);
    const section = buildFailedActionLedgerSection(ledger, '1-秋5');
    expect(section).not.toMatch(/必须|只能|立刻前往|禁止/);
    // 但要给出「换个做法」的具体可选项，否则模型只是知道失败过、不知道该怎么做
    expect(section).toContain('相邻');
    expect(section).toContain('list_chests');
  });

  it('失败原因无坐标无引号时按首句归并', () => {
    expect(extractFailureSubject('sleep', '失败：太累了站不稳')).toBe('太累了站不稳');
    expect(extractFailureSubject('eat', '失败：没有可以吃的东西')).toBe('没有可以吃的东西');
  });

  it('按回执真实措辞给出一条对得上号的方向（不新增玩法规则）', () => {
    expect(concreteHintForFailure('失败：(69,16) 四周没有可以站的地方')).toContain('move_to');
    expect(concreteHintForFailure('失败：走不到(13,7) 旁边')).toContain('可站坐标');
    expect(concreteHintForFailure('失败：要穿过玛妮的房门，得先和玛妮有 2 心好感才能进')).toContain('改日');
    expect(concreteHintForFailure('失败：玛妮的牧场（AnimalShop）还没开门（营业 09:00-18:00）')).toContain('营业时间');
    expect(concreteHintForFailure('失败：哪个箱子里都没有“花椰菜”')).toContain('list_chests');
    expect(concreteHintForFailure('失败：(68,18) 是宝箱')).toContain('take_items');
    expect(concreteHintForFailure('失败：没有打开商店，先用 open_shop')).toContain('open_shop');
    // 认不出的原因不硬编建议
    expect(concreteHintForFailure('失败：某种未见过的新原因')).toBe('');
  });

  it('提示段把方向挂在对应条目后面', () => {
    let ledger = createFailedActionLedger();
    ledger = recordFailedAction(ledger, rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')!);
    ledger = recordFailedAction(ledger, rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')!);
    const section = buildFailedActionLedgerSection(ledger, '1-秋7');
    expect(section).toMatch(/\(69,16\)[\s\S]*四周没有可以站的地方 → .*move_to/);
  });

  it('账本超过上限时只保留最近若干条', () => {
    let ledger = createFailedActionLedger();
    for (let i = 0; i < FAILED_ACTION_LEDGER_LIMIT + 5; i += 1) {
      ledger = recordFailedAction(ledger, rec(`FAILED tool${i}: 失败：原因${i}`)!);
    }
    expect(ledger.records.length).toBe(FAILED_ACTION_LEDGER_LIMIT);
    expect(ledger.records[ledger.records.length - 1]?.subject).toContain('原因');
  });

  it('落盘格式可往返，损坏文件安全退回空账本', () => {
    let ledger = createFailedActionLedger();
    ledger = recordFailedAction(ledger, rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')!);
    ledger = recordFailedAction(ledger, rec('FAILED take_items: 失败：(69,16) 四周没有可以站的地方')!);
    const file = serializeFailedActionLedger(ledger);
    expect(file.version).toBe(1);
    const restored = parseFailedActionLedgerFile(file);
    expect(restored.records).toHaveLength(1);
    expect(restored.records[0]?.count).toBe(2);
    expect(buildFailedActionLedgerSection(restored, '1-秋5')).toContain('(69,16)');

    expect(parseFailedActionLedgerFile(null).records).toEqual([]);
    expect(parseFailedActionLedgerFile({ version: 1, records: 'not-an-array' }).records).toEqual([]);
    expect(parseFailedActionLedgerFile({ version: 1, records: [null, { count: 1 }, { signature: 's', tool: 't', count: 0 }] }).records).toEqual([]);
    const partial = parseFailedActionLedgerFile({ version: 1, records: [{ signature: 'a|t', tool: 'a', count: 3 }] });
    expect(partial.records[0]?.subject).toBe('');
    expect(partial.records[0]?.firstDayKey).toBe('未知');
  });

  it('失败动作账本接线：只记 FAILED，成功回执不建条目', () => {
    const entries: FailedActionRecord[] = [];
    const host: FailedActionLedgerHost = {
      failedActionLedgerSnapshot: () => ({ records: entries }),
      recordFailedActionLedgerEntry: (entry) => { entries.push(entry); },
    };
    const ok = observeFailedAction(host, { tool: 'take_items', status: 'COMPLETED', summary: '成功：取出木材x10', clock: '第1年秋5日 06:00', dayKey: '1-秋5', ts: '2026-11-28T07:00:00.000Z' });
    expect(ok).toBeNull();
    expect(entries).toHaveLength(0);

    const bad = observeFailedAction(host, { tool: 'take_items', status: 'FAILED', summary: '失败：(69,16) 四周没有可以站的地方', clock: '第1年秋5日 06:00', dayKey: '1-秋5', ts: '2026-11-28T07:00:00.000Z' });
    expect(bad).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(failedActionLedgerPromptText(host, '1-秋5')).toBe('');

    // 失败回执正文为空时不建条目（parse 阶段直接拒绝）
    const empty = observeFailedAction(host, { tool: 'take_items', status: 'FAILED', summary: '', clock: '第1年秋5日 06:00', dayKey: '1-秋5', ts: '2026-11-28T07:00:00.000Z' });
    expect(empty).toBeNull();
    expect(entries).toHaveLength(1);
  });
});
