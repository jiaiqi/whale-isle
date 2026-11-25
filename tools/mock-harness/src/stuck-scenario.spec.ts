/**
 * 剧本 schema / 加载器（T-M6-68）：非法剧本必须显性报错，绝不静默跳过。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenarios, plannerModeOf, StuckScenarioSchema } from './stuck-scenario';

const MINIMAL = {
  id: 'S99-minimal-scenario',
  signature: 'fish|背包里没有鱼竿|Beach',
  source: 'unit-test',
  initialState: '时间：第1年春16日 07:30\n## 当前界面\n无（可以自由行动）',
  rules: [{ tool: '*', receipt: { text: '完成' } }],
  expect: { maxCycles: 5, maxSameFailure: 1 },
};

function scenarioDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-scenario-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

describe('StuckScenarioSchema', () => {
  it('最小合法剧本：isError 默认 false，planner 按 llmScript 推断', () => {
    const parsed = StuckScenarioSchema.parse(MINIMAL);
    expect(parsed.rules[0]?.receipt.isError).toBe(false);
    expect(plannerModeOf(parsed)).toBe('rule');
    expect(plannerModeOf({ ...parsed, llmScript: ['x'], planner: 'llm' })).toBe('llm');
  });

  it('ill-formed id / 空 rules / 缺 expect 全部拒绝', () => {
    expect(StuckScenarioSchema.safeParse({ ...MINIMAL, id: 'S1-bad' }).success).toBe(false);
    expect(StuckScenarioSchema.safeParse({ ...MINIMAL, rules: [] }).success).toBe(false);
    const { expect: _dropped, ...withoutExpect } = MINIMAL;
    expect(StuckScenarioSchema.safeParse(withoutExpect).success).toBe(false);
  });

  it('planner=llm 必须给 llmScript；planner=idle 不许给', () => {
    expect(StuckScenarioSchema.safeParse({ ...MINIMAL, planner: 'llm' }).success).toBe(false);
    expect(StuckScenarioSchema.safeParse({ ...MINIMAL, planner: 'idle', llmScript: ['x'] }).success).toBe(false);
    expect(StuckScenarioSchema.safeParse({ ...MINIMAL, planner: 'idle' }).success).toBe(true);
  });

  it('advanceMinutes / maxCycles 越界拒绝', () => {
    expect(StuckScenarioSchema.safeParse({
      ...MINIMAL,
      rules: [{ tool: 'wait', receipt: { text: '完成' }, advanceMinutes: 24 * 60 + 1 }],
    }).success).toBe(false);
    expect(StuckScenarioSchema.safeParse({ ...MINIMAL, expect: { maxCycles: 0, maxSameFailure: 0 } }).success).toBe(false);
  });
});

describe('loadScenarios', () => {
  it('按 id 排序加载，忽略非 json', () => {
    const dir = scenarioDir({
      'b.json': { ...MINIMAL, id: 'S02-bbb' },
      'a.json': { ...MINIMAL, id: 'S01-aaa' },
      'README.md': '# 不是剧本',
    });
    expect(loadScenarios(dir).map((scenario) => scenario.id)).toEqual(['S01-aaa', 'S02-bbb']);
  });

  it('目录为空 / 坏 JSON / schema 不合法 / id 重复都抛错', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stuck-scenario-empty-'));
    expect(() => loadScenarios(empty)).toThrow(/剧本目录为空/);

    const broken = scenarioDir({ 'x.json': '{ not json' });
    expect(() => loadScenarios(broken)).toThrow(/JSON 解析失败/);

    const invalid = scenarioDir({ 'x.json': { ...MINIMAL, id: 'bad-id' } });
    expect(() => loadScenarios(invalid)).toThrow(/不符合 schema/);

    const duplicated = scenarioDir({ 'a.json': MINIMAL, 'b.json': MINIMAL });
    expect(() => loadScenarios(duplicated)).toThrow(/id 重复/);
  });

  it('真实剧本目录：6 个剧本全部可加载且签名是三段式', () => {
    const dir = new URL('../scenarios/stuck', import.meta.url);
    const scenarios = loadScenarios(dir.pathname);
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    for (const scenario of scenarios) expect(scenario.signature.split('|')).toHaveLength(3);
  });
});
