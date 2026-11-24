import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false } }));
import { loadPersona } from '@workbench/persona-brain';
import { buildCharacterPersonaConfig, characterPokeLine, characterReflex } from './character-persona';

const CASES: Array<[string, string, string]> = [
  ['blue-whale-maid', '大肥鱼', '大肥鱼'],
  ['aboutme-dsh', '大肥鱼', '蓝蓝'],
  ['aboutme-dsh1', '偷懒', '活力'],
  ['aboutme-gpt', '套壳', '不是'],
  ['aboutme-claude', '说教', '事实'],
  ['aboutme-gemini', '花心', '好奇'],
  ['aboutme-qwen', '死板', '计划'],
  ['aboutme-glm', '狐狸', '耳朵'],
  ['aboutme-grok', '杠精', '吐槽'],
  ['aboutme-kimi', '话痨', '重点'],
];

describe('九角色 PetPersonaConfig 平权', () => {
  it('每个角色都生成完整配置并通过 persona-brain 校验', () => {
    for (const [id] of CASES) {
      const config = buildCharacterPersonaConfig(id);
      expect(config.id).toBe(id);
      expect(config.reflexRules.length).toBeGreaterThan(0);
      expect(config.reflexRules[0]).toMatchObject({ priority: 'P0_INTERRUPT', actionState: 'rage_spray' });
      expect(config.reflexRules[0]?.cooldownMs).toBeGreaterThan(0);
      expect(config.voiceProfile.ttsVoicePackId).toContain(id);
      expect(() => loadPersona(config)).not.toThrow();
    }
  });

  it('每个角色专属雷区都能 0-token 命中并返回角色化台词', () => {
    for (const [id, trigger, keyword] of CASES) {
      const response = characterReflex(id, trigger);
      expect(response, `${id} / ${trigger}`).toBeTruthy();
      expect(response?.length).toBeGreaterThan(4);
    }
  });

  it('右键戳触发每个角色不同的专属台词', () => {
    const lines = CASES.map(([id]) => characterPokeLine(id));
    expect(lines.every((line) => line.length > 4)).toBe(true);
    expect(new Set(lines).size).toBeGreaterThanOrEqual(8);
  });

  it('未命中雷区返回 null，不误打断聊天', () => {
    expect(characterReflex('aboutme-kimi', '今天天气不错')).toBeNull();
  });

  it('未登记角色回落到中性人设，不继承小鲸的「大肥鱼」雷区', () => {
    expect(characterReflex('unknown-character', '大肥鱼')).toBeNull();
    const config = buildCharacterPersonaConfig('custom-abc');
    expect(config.id).toBe('custom-abc');
    expect(config.reflexRules[0]?.triggerRegex).not.toContain('大肥鱼');
    expect(characterPokeLine('custom-abc')).toBeTruthy();
  });
});
