/**
 * Token 饭碗计量单测（P0 收尾）：真实 usage 扣米 / 投喂 bonus / 跨日重置 / 重启恢复 / 档位阈值。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenMeter, DAILY_RICE_BUDGET, riceLevelOf } from './token-meter';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rice-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const usage = (input: number, output: number) => ({
  slot: 'STARDEW_GAME_PLANNER',
  providerId: 'deepseek-official',
  modelId: 'deepseek-flash',
  inputTokens: input,
  cachedInputTokens: 0,
  outputTokens: output,
  latencyMs: 120,
});

describe('token-meter', () => {
  it('初始 500,000 粒；usage 1:1 扣米并写 JSONL 流水', () => {
    const dir = tempDir();
    const meter = createTokenMeter({ dir });
    expect(meter.status()).toMatchObject({ balance: DAILY_RICE_BUDGET, consumedToday: 0, level: 'fed_buff' });
    const res = meter.recordUsage(usage(900, 100));
    expect(res.tokens).toBe(1000);
    expect(res.status.balance).toBe(DAILY_RICE_BUDGET - 1000);
    const lines = readFileSync(join(dir, 'token-ledger.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ riceGrains: 1000, providerId: 'deepseek-official' });
  });

  it('投喂只加 bonus，不写流水；重启从状态文件恢复', () => {
    const dir = tempDir();
    const meter = createTokenMeter({ dir });
    meter.recordUsage(usage(500, 0));
    meter.feed(5000);
    const restored = createTokenMeter({ dir });
    expect(restored.status()).toMatchObject({ balance: DAILY_RICE_BUDGET - 500 + 5000, consumedToday: 500 });
  });

  it('跨日重置 consumed/bonus', () => {
    const dir = tempDir();
    let clock = new Date('2026-11-22T23:00:00').getTime();
    const meter = createTokenMeter({ dir, now: () => clock });
    meter.recordUsage(usage(1000, 0));
    expect(meter.status().consumedToday).toBe(1000);
    clock = new Date('2026-11-23T00:10:00').getTime();
    expect(meter.status()).toMatchObject({ consumedToday: 0, balance: DAILY_RICE_BUDGET });
  });

  it('0 token usage 不扣米也不写流水', () => {
    const dir = tempDir();
    const meter = createTokenMeter({ dir });
    const res = meter.recordUsage(usage(0, 0));
    expect(res.tokens).toBe(0);
    expect(() => readFileSync(join(dir, 'token-ledger.jsonl'))).toThrow();
  });

  it('档位阈值：5%/15%/80%/90%', () => {
    expect(riceLevelOf(0, 100)).toBe('starving');
    expect(riceLevelOf(10, 100)).toBe('hungry');
    expect(riceLevelOf(50, 100)).toBe('ok');
    expect(riceLevelOf(85, 100)).toBe('full');
    expect(riceLevelOf(95, 100)).toBe('fed_buff');
  });
});
