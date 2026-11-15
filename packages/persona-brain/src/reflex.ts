/**
 * 0.1s 雷区反射钩子（T-M1-04，dsh-douyin-agent 反射思想重写）。
 *
 * 铁律：命中雷区 → P0_INTERRUPT 预设台词直出，结构性不经过主脑（不消耗 Token）；
 * 规则按声明顺序尝试，命中且未冷却即返回；冷却中的规则跳过（不重复触发）。
 */
import type { PetPersonaConfig, PetActionState } from '@workbench/shared-protocol';

export interface ReflexHit {
  ruleId: string;
  actionState: PetActionState;
  emotionTag: 'rage_spray' | 'tsundere_refuse';
  /** 预设台词（加权随机抽取）——直接播报，不请求主脑 */
  response: string;
  /** 记入常客记仇账本的标签（宿主层落 SQLite grudge_ledger） */
  ledgerGrudgeTag: string;
  priority: 'P0_INTERRUPT';
  /** 结构性保证：反射路径永远不消耗主脑 Token */
  consumedMainBrainTokens: false;
}

export interface ReflexOptions {
  rng?: () => number;
  now?: () => number;
}

export interface ReflexInterceptor {
  /** 命中返回 ReflexHit（<10ms 级正则开销），未命中/全部冷却返回 null */
  intercept(text: string, now?: number): ReflexHit | null;
}

function pickWeighted<T>(items: Array<T & { weight?: number }>, rng: () => number): T {
  const total = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight ?? 1;
    if (roll <= 0) return item;
  }
  const fallback = items[items.length - 1];
  if (!fallback) throw new Error('加权选择空集合');
  return fallback;
}

export function createReflexInterceptor(
  persona: PetPersonaConfig,
  options: ReflexOptions = {},
): ReflexInterceptor {
  const rng = options.rng ?? Math.random;
  const clock = options.now ?? Date.now;
  const compiled = persona.reflexRules.map((rule) => ({
    rule,
    matcher: new RegExp(rule.triggerRegex, 'u'),
    lastHitAt: Number.NEGATIVE_INFINITY,
  }));

  return {
    intercept(text: string, now?: number): ReflexHit | null {
      const timestamp = now ?? clock();
      for (const compiledRule of compiled) {
        const { rule, matcher } = compiledRule;
        if (!matcher.test(text)) continue;
        // 冷却窗口内：跳过该规则（不重复触发），继续尝试后续规则
        if (timestamp - compiledRule.lastHitAt < rule.cooldownMs) continue;
        compiledRule.lastHitAt = timestamp;
        const pool = rule.presetResponses.map((response) => ({ response }));
        const picked = pickWeighted(pool, rng);
        return {
          ruleId: rule.id,
          actionState: rule.actionState,
          emotionTag: rule.emotionTag,
          response: picked.response,
          ledgerGrudgeTag: rule.ledgerGrudgeTag,
          priority: 'P0_INTERRUPT',
          consumedMainBrainTokens: false,
        };
      }
      return null;
    },
  };
}
