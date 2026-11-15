import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPersona, PersonaError } from './persona-engine';

/** T-M1-04 门禁：输入含"大肥鱼"文本，<10ms 返回 P0_INTERRUPT + rage_spray 且不消耗主脑 Token */

const FIXTURE_PATH = new URL('../../../packages/shared-protocol/fixtures/blue-whale-maid.json', import.meta.url);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as object;

describe('loadPersona（blue-whale-maid 三层人格引擎）', () => {
  it('共享夹具装载成功（与 shared-protocol 单一事实源同源）', () => {
    const engine = loadPersona(FIXTURE);
    expect(engine.config.id).toBe('blue-whale-maid');
    expect(engine.config.name).toBe('小鲸（大肥鱼）');
    expect(engine.config.reflexRules.length).toBeGreaterThan(0);
  });

  it('契约校验失败 → INVALID_PERSONA；雷区正则非法 → INVALID_REFLEX_REGEX', () => {
    expect(() => loadPersona({ id: 'x' })).toThrow(PersonaError);
    try {
      loadPersona({
        ...FIXTURE,
        reflexRules: [{ ...((FIXTURE as { reflexRules: Array<Record<string, unknown>> }).reflexRules[0]!), triggerRegex: '([bad' }],
      });
      expect.unreachable('应抛出 INVALID_REFLEX_REGEX');
    } catch (error) {
      expect((error as PersonaError).code).toBe('INVALID_REFLEX_REGEX');
    }
  });

  it('门禁：输入含"大肥鱼"，<10ms 返回 P0_INTERRUPT + rage_spray 且不消耗主脑 Token', () => {
    const engine = loadPersona(FIXTURE);
    const started = performance.now();
    const hit = engine.reflex('你这大肥鱼又偷吃白米饭！');
    const elapsed = performance.now() - started;
    expect(hit).not.toBeNull();
    expect(hit?.actionState).toBe('rage_spray');
    expect(hit?.priority).toBe('P0_INTERRUPT');
    expect(hit?.consumedMainBrainTokens).toBe(false); // 预设台词直出，主脑零调用
    expect(hit?.ledgerGrudgeTag).toBe('叫我大肥鱼的坏蛋');
    expect(elapsed).toBeLessThan(10);
    // 大批量输入下依然远低于 10ms（弹幕风暴 100 条/秒的余量）
    const batchStarted = performance.now();
    for (let i = 0; i < 1000; i++) engine.reflex(`普通弹幕 ${i} 大肥鱼`);
    expect(performance.now() - batchStarted).toBeLessThan(100); // 1000 次 <100ms
  });

  it('第 1 层：系统提示模板填充（{name}/{title}/{owner}/{riceRatio}）', () => {
    const engine = loadPersona(FIXTURE);
    const prompt = engine.buildSystemPrompt();
    expect(prompt).toContain('小鲸（大肥鱼）');
    expect(prompt).toContain('傲娇干饭蓝鲸女仆');
    expect(prompt).toContain('主人叫鱼片');
    expect(prompt).toContain('余量：100%');
  });

  it('第 2 层：<think> 剥离 + 跑题碎碎念（概率 0/1 两端）', () => {
    const engine = loadPersona(FIXTURE);
    const { visible, innerThoughts } = engine.stripThink('<think>白米饭真香</think>主人好~');
    expect(visible).toBe('主人好~');
    expect(innerThoughts).toEqual(['白米饭真香']);
    // derailmentProbability=0.35：rng=0.99 → 不跑题
    expect(engine.maybeDerail(() => 0.99)).toBeNull();
    // rng=0 → 跑题命中首条主题
    const derail = engine.maybeDerail(() => 0);
    expect(derail).toBe('今晚吃几碗白米饭配红烧肉');
    // rng=0.34（<0.35 命中）→ 按比例取第二条主题
    expect(engine.maybeDerail(() => 0.34)).toBe('偷偷观察鱼片今天写代码的侧脸');
    // disabled / 空 prompts → null
    const disabled = loadPersona({ ...FIXTURE, innerVoiceConfig: { enabled: false, derailmentProbability: 0.35, derailmentPrompts: ['x'] } });
    expect(disabled.maybeDerail(() => 0)).toBeNull();
    const noPrompts = loadPersona({ ...FIXTURE, innerVoiceConfig: { enabled: true, derailmentProbability: 0.35, derailmentPrompts: [] } });
    expect(noPrompts.maybeDerail(() => 0)).toBeNull();
  });

  it('流式内心戏：引擎暴露 createThinkStream（分块跨标签安全）', () => {
    const engine = loadPersona(FIXTURE);
    const parser = engine.createThinkStream();
    const first = parser.feed('好<thi');
    expect(first.visibleChunk).toBe('好');
    const second = parser.feed('nk>白米饭真香</think>，鱼片！');
    expect(second.thoughtChunk).toBe('白米饭真香');
    expect(parser.result().visible).toBe('好，鱼片！');
  });

  it('第 3 层与饭碗联动：雷区扣费路径互不干扰；饭碗低于 15% 建议 hungry_lazy', () => {
    const engine = loadPersona(FIXTURE);
    const hit = engine.reflex('大肥鱼！');
    expect(hit?.consumedMainBrainTokens).toBe(false);
    expect(engine.rice.isHungry()).toBe(false);
    // 消耗到只剩 5%（<15% 阈值）→ hungry_lazy
    engine.rice.consume(480000);
    expect(engine.rice.isHungry()).toBe(true);
    expect(engine.buildSystemPrompt()).toContain('余量：4%');
  });

  it('ownerTitles 为空 → 系统提示回落「主人」', () => {
    const engine = loadPersona({ ...FIXTURE, ownerTitles: [] });
    expect(engine.buildSystemPrompt()).toContain('主人叫主人');
  });

  it('maybeDerail 默认 rng 路径（不抛异常）', () => {
    const engine = loadPersona(FIXTURE);
    const result = engine.maybeDerail(); // 默认 Math.random
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('情绪前缀路由（T-M2-02 TTS 参考音频的输入契约）', () => {
    const engine = loadPersona(FIXTURE);
    const parsed = engine.parseEmotionPrefix('[傲娇反驳] 哼，本鱼才没有偷懒！');
    expect(parsed.emotionTag).toBe('tsundere_refuse');
    expect(parsed.body).toBe('哼，本鱼才没有偷懒！');
  });
});
