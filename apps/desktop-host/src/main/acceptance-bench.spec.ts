/** 验收台纯函数（T-M6-53）：12 场景、回退报告、脱敏报告。 */
import { describe, expect, it } from 'vitest';
import { AUDIT_POSES, BENCH_SCENARIOS, buildAcceptanceReport, buildFallbackReport, scrubReportText } from './acceptance-bench';

describe('BENCH_SCENARIOS', () => {
  it('恰好 12 个场景，id 唯一，每场景至少一步且含真实驱动类型', () => {
    expect(BENCH_SCENARIOS).toHaveLength(12);
    expect(new Set(BENCH_SCENARIOS.map((item) => item.id)).size).toBe(12);
    for (const scenario of BENCH_SCENARIOS) {
      expect(scenario.steps.length).toBeGreaterThan(0);
      expect(scenario.label.length).toBeGreaterThan(0);
      for (const step of scenario.steps) {
        expect(['pose', 'action', 'say', 'sleep', 'wake', 'crown', 'egg']).toContain(step.kind);
        expect(step.value.length).toBeGreaterThan(0);
      }
    }
    expect(BENCH_SCENARIOS.map((item) => item.id)).toContain('crown');
    expect(BENCH_SCENARIOS.map((item) => item.id)).toContain('sleep');
  });
});

describe('buildFallbackReport', () => {
  it('命中/回退/缺失三态如实标注', () => {
    const entries = buildFallbackReport(['idle', 'writing', 'listening', 'proud', 'sorry', 'pat', 'thinking', 'reading', 'running', 'searching', 'delegating', 'happy', 'surprised', 'bye']);
    const find = (pose: string): (typeof entries)[number] | undefined => entries.find((item) => item.requested === pose);
    expect(find('idle')).toMatchObject({ status: 'ok', pose: 'idle' });
    expect(find('compact')).toMatchObject({ status: 'fallback', pose: 'writing' });
    expect(find('asking')).toMatchObject({ status: 'fallback', pose: 'listening' });
    expect(find('greet_night')).toMatchObject({ status: 'fallback', pose: 'idle' });
    const missing = buildFallbackReport([]);
    expect(missing.every((item) => item.status === 'missing')).toBe(true);
    expect(missing[0]?.reason).toContain('没有任何姿态素材');
  });

  it('默认审计集合覆盖关键 CrossPet 场景键', () => {
    expect(AUDIT_POSES).toEqual(expect.arrayContaining(['idle-blink', 'compact', 'asking', 'greet_night', 'fest_midautumn']));
  });
});

describe('buildAcceptanceReport', () => {
  it('输出 12 场景结果 + 回退表，并脱敏路径/密钥', () => {
    const fallbacks = buildFallbackReport(['idle', 'writing']);
    const report = buildAcceptanceReport({
      characterName: '小鲸',
      characterId: 'custom-seal',
      results: [
        { scenarioId: 'work-cycle', label: '一轮完整工作', status: 'completed', steps: 4, note: 'ok' },
        { scenarioId: 'crown', label: '大活戴皇冠 (>=8 工具)', status: 'failed', steps: 3, note: '文件 /Users/jiaqi/secret.png 读取失败' },
      ],
      fallbacks,
      generatedAt: 0,
    });
    expect(report).toContain('# 姿态与场景验收报告');
    expect(report).toContain('- 角色：小鲸（custom-seal）');
    expect(report).toContain('[x] 一轮完整工作');
    expect(report).toContain('[ ] 大活戴皇冠');
    expect(report).toContain('compact → writing（fallback');
    expect(report).not.toContain('/Users/jiaqi');
    expect(report).toContain('<path>');
    expect(report).toContain('不含对话正文');
  });

  it('scrubReportText 清除路径与常见密钥/token', () => {
    const text = 'path=/Users/a/b.png key=sk-abcdefgh12345678 token=Bearer abcdefgh12345678 win=C:\\Users\\a\\b.png';
    const scrubbed = scrubReportText(text);
    expect(scrubbed).not.toContain('/Users/');
    expect(scrubbed).not.toContain('sk-abcdefgh');
    expect(scrubbed).not.toContain('Bearer');
    expect(scrubbed).toContain('<path>');
    expect(scrubbed).toContain('<redacted>');
  });
});
