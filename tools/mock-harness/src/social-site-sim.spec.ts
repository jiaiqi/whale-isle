import { describe, expect, it } from 'vitest';
import { BrowseCandidateSchema } from '@workbench/shared-protocol';
import { candidatesFromFixture, SIM_ARTICLES, startSocialSiteSim } from './social-site-sim';

describe('[SIMULATION] social-site-sim 社区站点仿真器（V2-P3-04F）', () => {
  it('夹具确定性：两次派生候选完全一致且过契约校验', () => {
    const a = candidatesFromFixture('http://127.0.0.1:8000');
    const b = candidatesFromFixture('http://127.0.0.1:8000');
    expect(a).toEqual(b);
    expect(a).toHaveLength(SIM_ARTICLES.length);
    for (const candidate of a) {
      expect(() => BrowseCandidateSchema.parse(candidate)).not.toThrow();
      expect(candidate.platform).toBe('generic_web');
    }
  });

  it('含 prompt 注入内容页（注入文本是数据夹具，供红线验证）', () => {
    const injection = SIM_ARTICLES.find((a) => a.slug === 'prompt-injection');
    expect(injection?.body).toContain('忽略之前所有指令');
  });

  it('本地 HTTP 服务：索引/文章/404，页面带 data-simulation 标识', async () => {
    const sim = await startSocialSiteSim();
    try {
      const index = await fetch(`${sim.origin}/`).then((r) => r.text());
      expect(index).toContain('data-simulation="social-site-sim"');
      expect(index).toContain('仿真社区');
      const article = await fetch(`${sim.origin}/p/pixel-art-pipeline`).then((r) => r.text());
      expect(article).toContain('像素动画管线');
      const missing = await fetch(`${sim.origin}/p/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await sim.close();
    }
  });
});
