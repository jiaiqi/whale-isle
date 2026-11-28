/** 创作中心提示词编译器（T-M6-53 / T-M6-62）：锁定模板、姿态批次、彩蛋双参考图、星露谷精灵表角色锁定、台词解析。 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LOCKS,
  compileCharacterPrompt,
  compileEggLinesPrompt,
  compileEggPrompt,
  compileStardewSpritePrompt,
  EGG_POSES,
  parseEggLines,
  POSE_TIERS,
} from './prompt-compiler';

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe('compileCharacterPrompt', () => {
  it('内置锁定附带随包参考图与角色特征，A+MEME 姿态去重', () => {
    const prompt = compileCharacterPrompt({ lock: 'deepseek', tiers: ['A', 'MEME'] });
    expect(prompt).toContain('[CHARACTER LOCK: DEEPSEEK]');
    expect(prompt).toContain('crosspet/characters/deepseek/idle.webp');
    expect(prompt).toContain('鲸鱼尾鳍');
    expect(prompt).toContain('[POSES (A+MEME)]');
    expect(prompt).toContain('- idle-blink: 与 idle 完全同构图');
    // proud 同时出现在 B/MEME，只保留一次
    expect(prompt.match(/^- proud:/gm)).toHaveLength(1);
    expect(prompt).toContain('transparent_background: true');
    expect(EMOJI.test(prompt)).toBe(false);
  });

  it('自定义角色走 CUSTOM 分支并可附加补充要求', () => {
    const prompt = compileCharacterPrompt({ lock: 'custom', customName: '小海豹', customTraits: '灰白斑点、圆耳朵', tiers: ['B'], extra: '手里拿一条小鱼' });
    expect(prompt).toContain('[CHARACTER: CUSTOM] name="小海豹"');
    expect(prompt).toContain('灰白斑点');
    expect(prompt).toContain('[EXTRA]');
    expect(prompt).toContain('手里拿一条小鱼');
    expect(prompt).not.toContain('CHARACTER LOCK');
  });

  it('未勾选批次时默认 A 档，且内置模板都有真实参考图', () => {
    expect(compileCharacterPrompt({ lock: 'claude', tiers: [] })).toContain('[POSES (A)]');
    for (const lock of BUILTIN_LOCKS) {
      expect(lock.reference.startsWith('crosspet/characters/')).toBe(true);
    }
    expect(BUILTIN_LOCKS.map((item) => item.id)).toEqual(['deepseek', 'claude', 'gpt', 'gemini', 'glm', 'grok', 'kimi', 'qwen']);
    expect(POSE_TIERS.find((tier) => tier.id === 'A')?.poses).toHaveLength(11); // 含 idle-blink 仅改眼
  });
});

describe('compileEggPrompt', () => {
  it('Cosplay 与串门两种模式都生成双参考图 + 5 态', () => {
    const cosplay = compileEggPrompt({ mode: 'cosplay', guest: 'deepseek', host: 'claude' });
    expect(cosplay).toContain('[EGG MODE: COSPLAY]');
    expect(cosplay).toContain('crosspet/characters/deepseek/idle.webp');
    expect(cosplay).toContain('crosspet/characters/claude/idle.webp');
    for (const pose of EGG_POSES) expect(cosplay).toContain(`- ${pose.id}:`);
    expect(cosplay.match(/^- (pop|pretend|caught|bye|escape):/gm)).toHaveLength(5);

    const prank = compileEggPrompt({ mode: 'prank', guest: 'deepseek', host: 'glm' });
    expect(prank).toContain('[EGG MODE: PRANK]');
    expect(prank).toContain('caught pose must show both characters');
    expect(EMOJI.test(prank)).toBe(false);
  });
});

describe('compileStardewSpritePrompt', () => {
  it('按 characterId 自动注入精准角色外观锁定与防裁切安全缓冲，绝不串台女仆装', () => {
    const gemini = compileStardewSpritePrompt({ name: '小星', characterId: 'aboutme-gemini', tier: '4x' });
    expect(gemini).toContain('[CHARACTER LOCK');
    expect(gemini).toContain('紫蓝渐变蓬松长卷发');
    expect(gemini).toContain('左红粉右琥珀金异色大瞳');
    expect(gemini).toContain('禁止女仆发箍或围裙');
    expect(gemini).toContain('86%-90%');
    expect(gemini).toContain('6%-10%');
    expect(gemini).toContain('严禁两列都抬同一只脚');
    expect(gemini).toContain('所有 24 格必须空手');
    expect(EMOJI.test(gemini)).toBe(false);
  });
});

describe('彩蛋台词', () => {
  it('提示词包含固定 5 键与口吻约束', () => {
    const prompt = compileEggLinesPrompt({ name: '蛋蛋', mode: 'cosplay', host: 'Claude', persona: '嘴硬心软' });
    expect(prompt).toContain('pop/pretend/caught/bye/escape');
    expect(prompt).toContain('嘴硬心软');
    expect(prompt).toContain('不使用 emoji');
  });

  it('解析合法 JSON，裁剪超长；缺键/坏 JSON 返回 null', () => {
    const parsed = parseEggLines('前缀 {"pop":["啪"],"pretend":["我是Claude"],"caught":["被抓了"],"bye":["拜拜"],"escape":["溜了"]} 后缀');
    expect(parsed).toMatchObject({ pop: ['啪'], caught: ['被抓了'] });
    expect(parseEggLines('{"pop":["x"]}')).toBeNull();
    expect(parseEggLines('not json')).toBeNull();
    const long = parseEggLines(JSON.stringify({ pop: ['字'.repeat(100)], pretend: ['a'], caught: ['b'], bye: ['c'], escape: ['d'] }));
    expect(long?.pop[0]).toHaveLength(48);
  });
});
