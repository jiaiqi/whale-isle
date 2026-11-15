/**
 * 三层人格引擎门面（T-M1-04）：
 *   第 1 层 系统提示模板填充（人设/主人/饭碗余量）
 *   第 2 层 <think> 内心戏剥离 + 跑题碎碎念
 *   第 3 层 0.1s 雷区反射钩子（预设台词直出，不烧主脑）
 * 运行期安全锁：引擎为纯规则机——零网络、零模型调用，只消费 Schema 校验过的配置。
 */
import { PetPersonaConfigSchema, type PetPersonaConfig } from '@workbench/shared-protocol';
import { createReflexInterceptor, type ReflexHit, type ReflexOptions } from './reflex';
import {
  createThinkStreamParser,
  parseEmotionPrefix,
  stripThink,
  type EmotionPrefixResult,
  type ThinkStripResult,
  type ThinkStreamParser,
} from './think';
import { RiceBowl } from './rice-bowl';

export type { ReflexHit, ReflexOptions } from './reflex';
export type { ThinkStripResult, ThinkStreamParser, ThinkStreamFeed, EmotionPrefixResult } from './think';
export { EMOTION_PREFIX_MAP, parseEmotionPrefix, stripThink, createThinkStreamParser } from './think';
export { RiceBowl, type SideDishInput, type ConsumeResult } from './rice-bowl';

export type PersonaErrorCode = 'INVALID_PERSONA' | 'INVALID_REFLEX_REGEX';

export class PersonaError extends Error {
  constructor(
    readonly code: PersonaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PersonaError';
  }
}

export interface PersonaEngine {
  readonly config: PetPersonaConfig;
  readonly rice: RiceBowl;
  /** 第 3 层：雷区反射（<10ms 级，不消耗主脑 Token） */
  reflex(text: string, now?: number): ReflexHit | null;
  /** 第 2 层：<think> 整段剥离 */
  stripThink(text: string): ThinkStripResult;
  /** 第 2 层：流式剥离（分块安全） */
  createThinkStream(): ThinkStreamParser;
  /** 跑题碎碎念：以 derailmentProbability 概率返回跑题主题，否则 null */
  maybeDerail(rng?: () => number): string | null;
  /** 情绪前缀解析（[傲娇反驳] → tsundere_refuse，路由 TTS 参考音频） */
  parseEmotionPrefix(text: string): EmotionPrefixResult;
  /** 第 1 层：系统提示模板填充（{name}/{title}/{owner}/{riceRatio}） */
  buildSystemPrompt(): string;
}

export interface LoadPersonaOptions {
  rng?: () => number;
  now?: () => number;
}

/** 装载并校验人设（运行期只消费 Schema 校验过的配置；雷区正则装载期编译以防运行期 ReDoS） */
export function loadPersona(config: unknown, options: LoadPersonaOptions = {}): PersonaEngine {
  let persona: PetPersonaConfig;
  try {
    persona = PetPersonaConfigSchema.parse(config);
  } catch (error) {
    throw new PersonaError('INVALID_PERSONA', `人设配置未通过契约校验：${error instanceof Error ? error.message : String(error)}`);
  }
  // 雷区正则装载期编译：无效/危险正则拦截在装载期而非运行期
  for (const rule of persona.reflexRules) {
    try {
      new RegExp(rule.triggerRegex, 'u');
    } catch (error) {
      throw new PersonaError('INVALID_REFLEX_REGEX', `雷区规则 ${rule.id} 正则非法：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const interceptor = createReflexInterceptor(persona, { rng: options.rng, now: options.now });
  const rice = new RiceBowl(persona.riceBowl, options.now ?? Date.now);

  return {
    config: persona,
    rice,
    reflex(text: string, now?: number): ReflexHit | null {
      return interceptor.intercept(text, now);
    },
    stripThink(text: string): ThinkStripResult {
      return stripThink(text, persona.innerVoiceConfig.thinkTagName);
    },
    createThinkStream(): ThinkStreamParser {
      return createThinkStreamParser(persona.innerVoiceConfig.thinkTagName);
    },
    maybeDerail(rng: () => number = Math.random): string | null {
      const { enabled, derailmentProbability, derailmentPrompts } = persona.innerVoiceConfig;
      if (!enabled || derailmentPrompts.length === 0) return null;
      if (rng() >= derailmentProbability) return null;
      const index = Math.min(derailmentPrompts.length - 1, Math.floor(rng() * derailmentPrompts.length));
      const prompt = derailmentPrompts[index];
      return prompt ?? null;
    },
    parseEmotionPrefix(text: string): EmotionPrefixResult {
      return parseEmotionPrefix(text);
    },
    buildSystemPrompt(): string {
      const owner = persona.ownerTitles[0] ?? '主人';
      return persona.systemPromptTemplate
        .replaceAll('{name}', persona.name)
        .replaceAll('{title}', persona.title)
        .replaceAll('{owner}', owner)
        .replaceAll('{riceRatio}', `${Math.round(rice.ratioRemaining() * 100)}%`);
    },
  };
}

