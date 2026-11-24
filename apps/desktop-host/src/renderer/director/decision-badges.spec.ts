/** 游戏共玩决策徽标（T-M6-57）：4 种来源判定，优先级 remote > fallback > objective > brain。 */
import { describe, expect, it } from 'vitest';
import { decisionBadgeOf } from './game-panel';

describe('decisionBadgeOf', () => {
  it('remote 优先：即使有活跃目标也显示主人插队', () => {
    expect(decisionBadgeOf({ planner: 'remote', intent: '规则兜底：x' }, true).kind).toBe('remote');
  });

  it('规则兜底按 intent 前缀识别', () => {
    expect(decisionBadgeOf({ planner: 'llm-xiaojing', intent: '规则兜底：去海滩' }, false).kind).toBe('fallback');
    expect(decisionBadgeOf({ planner: 'llm-xiaojing', intent: '随便说说规则兜底' }, false).kind).toBe('brain');
  });

  it('有活跃目标 → 目标推进中；否则大脑决策', () => {
    expect(decisionBadgeOf({ planner: 'llm-xiaojing', intent: '去钓鱼' }, true)).toMatchObject({ kind: 'objective', label: '目标推进中' });
    expect(decisionBadgeOf({ planner: 'llm-xiaojing', intent: '去钓鱼' }, false)).toMatchObject({ kind: 'brain', label: '大脑决策' });
    expect(decisionBadgeOf(undefined, false)).toMatchObject({ kind: 'brain' });
  });
});
