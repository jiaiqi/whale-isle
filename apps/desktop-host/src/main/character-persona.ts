/**
 * 当前角色口吻的单点桥接（T-M6-21）：角色注册表切换时写入，autodrive-host.say() 读取。
 * 独立模块避免与并行会话在制的 M7 多游戏改造（autodrive-host.ts）抢文件——
 * 对方提交其批次时自然带上那 2 行消费代码。
 */
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PetPersonaConfigSchema, type PetPersonaConfig } from '@workbench/shared-protocol';
import { loadPersona, type ReflexHit } from '@workbench/persona-brain';

const DEFAULT_PERSONA = '你是「小鲸」——一条傲娇干饭蓝鲸女仆，住在主人桌面上，正在替主人自动游玩《星露谷物语》。口吻：嘴硬心软的傲娇女仆；回复短小精悍（≤80字）；偶尔提到饭碗/米粒；不解释自己是 AI；用中文。';
const here = dirname(fileURLToPath(import.meta.url));

function defaultPersonaConfig(): PetPersonaConfig {
  const configPath = app.isPackaged
    ? join(process.resourcesPath, 'persona', 'blue-whale-maid.json')
    : join(here, '../../../../packages/shared-protocol/fixtures/blue-whale-maid.json');
  return PetPersonaConfigSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
}

let current = DEFAULT_PERSONA;
const BASE_WHALE_PERSONA = loadPersona(defaultPersonaConfig());
let currentPersona = BASE_WHALE_PERSONA;
let currentCharacterId = 'blue-whale-maid';

interface PersonaPreset {
  name: string;
  title: string;
  trigger: string;
  responses: string[];
  emotionTag: 'rage_spray' | 'tsundere_refuse';
}

/** T-M6-43：全部角色共用同一完整 PetPersonaConfig 引擎，仅差异人设/雷区/音色/外观。 */
const PERSONA_PRESETS: Record<string, PersonaPreset> = {
  'blue-whale-maid': { name: '小鲸（大肥鱼）', title: '傲娇干饭蓝鲸女仆', trigger: '(大肥鱼|胖鱼|肥鲸|多少斤|水桶腰|卡门)', responses: ['才……才不是大肥鱼呢！这叫流线型深海水动力女仆！', '噗——（喷水抗议）你才胖！人家这叫饱满的算力储备！'], emotionTag: 'rage_spray' },
  'aboutme-dsh': { name: '蓝蓝', title: '蓝毛小女仆', trigger: '(大肥鱼|胖鱼|偷懒|不干活)', responses: ['蓝蓝才不是大肥鱼！桌面我会收拾好，任务也会做好的。', '被叫胖鱼会生气的，快摸摸头道歉。'], emotionTag: 'rage_spray' },
  'aboutme-dsh1': { name: '蓝蓝·活力装', title: '元气运动女仆', trigger: '(偷懒|没力气|躺平|懒虫)', responses: ['才没有偷懒！活力装已经热身完毕，马上出发！', '说我没力气？先跑三圈再回来说话！'], emotionTag: 'tsundere_refuse' },
  'aboutme-gpt': { name: '小吉', title: '理性派桌面助手', trigger: '(套壳|复读|机器人|只会说)', responses: ['不是套壳。先给结论，再给你下一步。', '复读？这是把重要信息再说一遍。'], emotionTag: 'tsundere_refuse' },
  'aboutme-claude': { name: '小克', title: '谨慎阅读型旅伴', trigger: '(装深沉|说教|机器人|无聊)', responses: ['我只是想先把事实确认清楚，这样更稳妥。', '说教？那我把话缩短：先验证，再行动。'], emotionTag: 'tsundere_refuse' },
  'aboutme-gemini': { name: '小芽', title: '好奇猫耳少女', trigger: '(花心|多动|乱跑|不稳重)', responses: ['好奇心旺盛不是花心！我探索完就回来。', '别拉我，那边有个新地方想去看一眼！'], emotionTag: 'rage_spray' },
  'aboutme-qwen': { name: '小千', title: '全能小管家', trigger: '(死板|机械|没感情|木头)', responses: ['计划清楚才不容易翻车，这不叫死板。', '机械？至少我的日程从来不会漏。'], emotionTag: 'tsundere_refuse' },
  'aboutme-glm': { name: '小蓝狐', title: '机灵蓝狐耳娘', trigger: '(狐狸|狡猾|滑头|骗人)', responses: ['狐狸耳朵只负责听消息，正事我可没落下。', '狡猾？这叫提前想到三步。'], emotionTag: 'tsundere_refuse' },
  'aboutme-grok': { name: '小魔女', title: '顽皮金发小魔女', trigger: '(嘴臭|杠精|阴阳怪气|讨厌)', responses: ['只是吐槽得准而已，真要干活我可不含糊。', '杠精？那你说个更好的方案呀。'], emotionTag: 'rage_spray' },
  'aboutme-kimi': { name: '小星', title: '安静星芒小女仆', trigger: '(话痨|长文|啰嗦|闷葫芦)', responses: ['记录可以很长，跟你说话我会只留重点。', '不啰嗦，我在认真整理要说的话。'], emotionTag: 'tsundere_refuse' },
};

/** 纯函数：所有角色生成完整 PetPersonaConfig 并交给 persona-brain 校验。 */
export function buildCharacterPersonaConfig(characterId: string): PetPersonaConfig {
  const preset = PERSONA_PRESETS[characterId] ?? PERSONA_PRESETS['blue-whale-maid']!;
  const base = BASE_WHALE_PERSONA.config;
  const first = base.reflexRules[0];
  return {
    ...base,
    id: characterId,
    name: preset.name,
    title: preset.title,
    avatarManifestPath: characterId === 'blue-whale-maid' ? base.avatarManifestPath : `pet-characters/${characterId.replace(/^aboutme-/, '')}/manifest.json`,
    reflexRules: [{
      id: `taboo-${characterId}`,
      triggerRegex: preset.trigger,
      cooldownMs: first?.cooldownMs ?? 8000,
      priority: 'P0_INTERRUPT',
      actionState: 'rage_spray',
      emotionTag: preset.emotionTag,
      ledgerGrudgeTag: `惹${preset.name}生气的坏蛋`,
      presetResponses: preset.responses,
    }],
    voiceProfile: { ...base.voiceProfile, ttsVoicePackId: `${characterId}-v1` },
  };
}

/** 右键戳一下的专属吐槽（取角色雷区池首条，保证角色化且不共享）。 */
export function characterPokeLine(characterId: string): string {
  const config = buildCharacterPersonaConfig(characterId);
  return config.reflexRules[0]?.presetResponses[0] ?? '别戳啦，我正在忙。';
}

const personaCache = new Map<string, ReturnType<typeof loadPersona>>();
function personaFor(characterId: string): ReturnType<typeof loadPersona> {
  const cached = personaCache.get(characterId);
  if (cached !== undefined) return cached;
  const engine = loadPersona(buildCharacterPersonaConfig(characterId));
  personaCache.set(characterId, engine);
  return engine;
}

export function setCurrentPersonaCharacter(characterId: string, prompt: string): void {
  currentCharacterId = characterId;
  current = prompt.trim() === '' ? DEFAULT_PERSONA : prompt;
  currentPersona = personaFor(characterId);
}

export function setCurrentPersonaPrompt(prompt: string, personaConfig?: unknown): void {
  current = prompt.trim() === '' ? DEFAULT_PERSONA : prompt;
  if (personaConfig !== undefined) setCurrentPersonaConfig(personaConfig);
}

export function setCurrentPersonaConfig(config: unknown): void {
  const engine = loadPersona(config);
  personaCache.set(currentCharacterId, engine);
  currentPersona = engine;
}

export function characterReflex(characterId: string, text: string): string | null {
  return personaFor(characterId).reflex(text)?.response ?? null;
}

export function currentPersonaConfig(): PetPersonaConfig {
  return currentPersona.config;
}

export function currentPersonaReflex(text: string): ReflexHit | null {
  return personaFor(currentCharacterId).reflex(text);
}

export function currentPersonaPrompt(): string {
  return current;
}
