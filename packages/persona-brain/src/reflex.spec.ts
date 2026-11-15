import { describe, expect, it } from 'vitest';
import { PetPersonaConfigSchema, type PetPersonaConfig } from '@workbench/shared-protocol';
import { createReflexInterceptor } from './reflex';

/** T-M1-04：0.1s 雷区反射钩子（<10ms / 冷却 / 加权台词 / 不烧主脑） */

const PERSONA: PetPersonaConfig = PetPersonaConfigSchema.parse({
  id: 'blue-whale-maid',
  name: '小鲸（大肥鱼）',
  title: '傲娇干饭蓝鲸女仆',
  licenseScope: 'DEV_ONLY_NON_COMMERCIAL',
  avatarManifestPath: 'assets/pets/blue-whale-maid/manifest.json',
  systemPromptTemplate: '你是{name}。',
  reflexRules: [
    {
      id: 'taboo-fat-fish',
      triggerRegex: '(大肥鱼|胖鱼|肥鲸|多少斤|水桶腰|卡门)',
      priority: 'P0_INTERRUPT',
      actionState: 'rage_spray',
      emotionTag: 'rage_spray',
      ledgerGrudgeTag: '叫我大肥鱼的坏蛋',
      presetResponses: ['才不是大肥鱼！', '噗——（喷水抗议）'],
    },
    {
      id: 'taboo-overflow',
      triggerRegex: '(盖饭|大碗)',
      priority: 'P0_INTERRUPT',
      actionState: 'happy_maid',
      emotionTag: 'tsundere_refuse',
      cooldownMs: 100,
      ledgerGrudgeTag: '提大碗的坏蛋',
      presetResponses: ['饭碗是我的！'],
    },
  ],
  innerVoiceConfig: { enabled: true, derailmentPrompts: [] },
  riceBowl: { dailyRiceGrainBudget: 500000, consumedRiceGrainsToday: 0, activeSideDishes: [] },
  stardewWeights: {
    lazyDefault: { farmingProfit: 0.3, npcGossipAndTrashCan: 0.85, miningCombat: 0.2, slackingAndScenery: 0.9, minStaminaThreshold: 0.45 },
    seriousForOwner: { farmingProfit: 0.95, npcGossipAndTrashCan: 0.3, miningCombat: 0.75, slackingAndScenery: 0.1, minStaminaThreshold: 0.15 },
  },
  voiceProfile: { ttsVoicePackId: 'v1', rvcModelPath: 'a.pth' },
});

describe('createReflexInterceptor（雷区反射）', () => {
  it('命中雷区返回 P0_INTERRUPT + rage_spray，结构性不消耗主脑 Token', () => {
    const interceptor = createReflexInterceptor(PERSONA, { rng: () => 0 });
    const hit = interceptor.intercept('你这大肥鱼又偷吃！');
    expect(hit).not.toBeNull();
    expect(hit?.ruleId).toBe('taboo-fat-fish');
    expect(hit?.actionState).toBe('rage_spray');
    expect(hit?.priority).toBe('P0_INTERRUPT');
    expect(hit?.consumedMainBrainTokens).toBe(false);
    expect(hit?.ledgerGrudgeTag).toBe('叫我大肥鱼的坏蛋');
    expect(hit?.response).toBe('才不是大肥鱼！'); // rng=0 → 首条
  });

  it('冷却窗口内不重复触发（默认 8000ms），窗口后恢复；冷却中可命中其他规则', () => {
    let clock = 1000;
    const interceptor = createReflexInterceptor(PERSONA, { rng: () => 0, now: () => clock });
    expect(interceptor.intercept('大肥鱼！', clock)).not.toBeNull();
    // 8s 内：fat-fish 冷却中；"盖饭" 命中另一规则（cooldown 100ms 已过）
    clock += 3000;
    const second = interceptor.intercept('再来个大盖饭', clock);
    expect(second?.ruleId).toBe('taboo-overflow');
    // fat-fish 冷却已过 → 再命中
    clock += 6000;
    expect(interceptor.intercept('胖鱼！', clock)?.ruleId).toBe('taboo-fat-fish');
  });

  it('未命中返回 null', () => {
    const interceptor = createReflexInterceptor(PERSONA, { rng: () => 0 });
    expect(interceptor.intercept('今天天气真不错')).toBeNull();
  });

  it('加载期拦截非法正则（防运行期 ReDoS）', () => {
    const broken = {
      ...PERSONA,
      reflexRules: [{ ...PERSONA.reflexRules[0]!, triggerRegex: '([unclosed' }],
    } as PetPersonaConfig;
    expect(() => createReflexInterceptor(broken)).toThrow();
  });
});
