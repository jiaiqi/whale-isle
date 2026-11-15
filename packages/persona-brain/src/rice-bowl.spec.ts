import { describe, expect, it } from 'vitest';
import { PetPersonaConfigSchema, type PetPersonaConfig } from '@workbench/shared-protocol';
import { RiceBowl } from './rice-bowl';

/** T-M1-04：赛博饭碗经济（1 粒米 = 1 Token / 15% 饥饿线 / 下饭菜 Buff 过期与倍率） */

function makePersona(riceBowlOverrides: Partial<PetPersonaConfig['riceBowl']> = {}): PetPersonaConfig {
  return PetPersonaConfigSchema.parse({
    id: 'blue-whale-maid',
    name: '小鲸',
    title: '傲娇干饭蓝鲸女仆',
    licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
    avatarManifestPath: 'assets/pets/blue-whale-maid/manifest.json',
    systemPromptTemplate: '你是{name}。',
    reflexRules: [],
    innerVoiceConfig: { enabled: true, derailmentPrompts: [] },
    riceBowl: { dailyRiceGrainBudget: 500000, consumedRiceGrainsToday: 0, activeSideDishes: [], ...riceBowlOverrides },
    stardewWeights: {
      lazyDefault: { farmingProfit: 0.3, npcGossipAndTrashCan: 0.85, miningCombat: 0.2, slackingAndScenery: 0.9, minStaminaThreshold: 0.45 },
      seriousForOwner: { farmingProfit: 0.95, npcGossipAndTrashCan: 0.3, miningCombat: 0.75, slackingAndScenery: 0.1, minStaminaThreshold: 0.15 },
    },
    voiceProfile: { ttsVoicePackId: 'v1', rvcModelPath: 'a.pth' },
  });
}

describe('RiceBowl（赛博饭碗）', () => {
  it('扣费累计：1 粒米 = 1 Token', () => {
    const bowl = new RiceBowl(makePersona().riceBowl);
    const first = bowl.consume(120000);
    expect(first.consumedAfter).toBe(120000);
    expect(first.ratioRemaining).toBeCloseTo(0.76, 5);
    expect(first.hungry).toBe(false);
    const second = bowl.consume(350000);
    expect(second.consumedAfter).toBe(470000);
    expect(second.ratioRemaining).toBeCloseTo(0.06, 5);
    expect(second.hungry).toBe(true);
    expect(second.suggestedActionState).toBe('hungry_lazy'); // 瘫倒摸鱼
  });

  it('负数扣费被夹紧为 0；预算耗尽 ratio=0', () => {
    const bowl = new RiceBowl(makePersona().riceBowl);
    const negative = bowl.consume(-50);
    expect(negative.consumedAfter).toBe(0); // 负数扣费夹紧为 0
    const over = bowl.consume(600000);
    expect(over.ratioRemaining).toBe(0);
    expect(bowl.remainingGrains()).toBe(0);
  });

  it('下饭菜 Buff：工作热情 ×2 与深度推理解锁，到期自动失效', () => {
    let clock = 1_700_000_000_000;
    const bowl = new RiceBowl(makePersona().riceBowl, () => clock);
    bowl.applySideDish({ id: 'buff-1', dishName: '豪华海鲜饭', workEthicMultiplier: 2, unlockDeepReasoning: false, durationSec: 300 });
    expect(bowl.workEthicMultiplier()).toBe(2);
    expect(bowl.hasDeepReasoning()).toBe(false);
    // 到期 → Buff 失效
    clock += 300_001;
    expect(bowl.workEthicMultiplier()).toBe(1);
    expect(bowl.activeBuffs()).toHaveLength(0);
    // 深度推理 Buff（攻略红烧肉 RAG）
    bowl.applySideDish({ id: 'buff-2', dishName: '攻略红烧肉', workEthicMultiplier: 1, unlockDeepReasoning: true, durationSec: 600 });
    expect(bowl.hasDeepReasoning()).toBe(true);
  });

  it('预算为 0 被契约拒绝（positive()）——防线在装载期而非运行期', () => {
    expect(() => makePersona({ dailyRiceGrainBudget: 0 })).toThrow(); // Zod: must be greater than 0
  });

  it('消耗超出预算 → remaining 归零（不出现负数米粒）', () => {
    const bowl = new RiceBowl(makePersona().riceBowl);
    bowl.consume(600000);
    expect(bowl.remainingGrains()).toBe(0);
    expect(bowl.ratioRemaining()).toBe(0);
  });

  it('倍率取最大值；乘数越界夹紧 [1,5]', () => {
    let clock = 0;
    const bowl = new RiceBowl(makePersona().riceBowl, () => clock);
    bowl.applySideDish({ id: 'a', dishName: 'x2', workEthicMultiplier: 2, unlockDeepReasoning: false, durationSec: 60 });
    bowl.applySideDish({ id: 'b', dishName: 'x3', workEthicMultiplier: 3, unlockDeepReasoning: false, durationSec: 60 });
    expect(bowl.workEthicMultiplier()).toBe(3); // 取最大
    bowl.applySideDish({ id: 'c', dishName: 'x99', workEthicMultiplier: 99, unlockDeepReasoning: false, durationSec: 60 });
    expect(bowl.workEthicMultiplier()).toBe(5); // 夹紧上限
  });
});
