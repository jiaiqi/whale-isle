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
let currentPersona = loadPersona(defaultPersonaConfig());

export function setCurrentPersonaPrompt(prompt: string, personaConfig?: unknown): void {
  current = prompt.trim() === '' ? DEFAULT_PERSONA : prompt;
  if (personaConfig !== undefined) setCurrentPersonaConfig(personaConfig);
}

/** 当前角色的 P0 雷区配置由 persona-brain 校验与执行，不在聊天宿主重复维护规则。 */
export function setCurrentPersonaConfig(config: unknown): void {
  currentPersona = loadPersona(config);
}

export function currentPersonaConfig(): PetPersonaConfig {
  return currentPersona.config;
}

export function currentPersonaReflex(text: string): ReflexHit | null {
  return currentPersona.reflex(text);
}

export function currentPersonaPrompt(): string {
  return current;
}
