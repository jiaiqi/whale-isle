/**
 * 真实 Token 饭碗计量（P0 收尾）：1 粒米 = 1 Token，日预算 500,000 粒（RiceBowlEconomy 契约）。
 *
 * 为什么不用主进程 SQLite：better-sqlite3 的 Node ABI(137) 与 Electron ABI 不同，
 * provider-vault 已因此改文件 KV；Token 流水同样用 JSONL（append-only）+ 状态文件原子写，
 * 避免每次 `pnpm install/rebuild` 后 Electron 启动即崩。
 *
 * - usage 只来自 model-gateway 的供应商真实回报（prompt/completion tokens）；
 * - 日界按本地日期滚动，跨日重置 consumed/bonus；
 * - 投喂（rice:feed）计入 bonus，不写 token 流水（不是消耗）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RiceBowlStatus } from '@workbench/shared-protocol';

export const DAILY_RICE_BUDGET = 500_000;

export interface TokenUsageInput {
  slot: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

interface MeterState {
  day: string;
  consumed: number;
  bonus: number;
}

export interface TokenMeter {
  recordUsage(usage: TokenUsageInput): { status: RiceBowlStatus; tokens: number };
  feed(grains: number): RiceBowlStatus;
  status(): RiceBowlStatus;
}

function dayKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function riceLevelOf(balance: number, budget: number): RiceBowlStatus['level'] {
  const ratio = budget <= 0 ? 0 : balance / budget;
  if (ratio < 0.05) return 'starving';
  if (ratio < 0.15) return 'hungry';
  if (ratio > 0.9) return 'fed_buff';
  if (ratio > 0.8) return 'full';
  return 'ok';
}

export function createTokenMeter(options: {
  dir: string;
  budget?: number;
  now?: () => number;
}): TokenMeter {
  const budget = options.budget ?? DAILY_RICE_BUDGET;
  const now = options.now ?? Date.now;
  const statePath = join(options.dir, 'rice-state.json');
  const ledgerPath = join(options.dir, 'token-ledger.jsonl');
  mkdirSync(options.dir, { recursive: true });

  let state: MeterState = { day: dayKey(now()), consumed: 0, bonus: 0 };
  try {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<MeterState>;
      if (typeof parsed.day === 'string' && typeof parsed.consumed === 'number') {
        state = {
          day: parsed.day,
          consumed: Math.max(0, parsed.consumed),
          bonus: Math.max(0, typeof parsed.bonus === 'number' ? parsed.bonus : 0),
        };
      }
    }
  } catch {
    /* 坏文件 → 当日重置 */
  }

  const rollDay = (): void => {
    const today = dayKey(now());
    if (state.day !== today) state = { day: today, consumed: 0, bonus: 0 };
  };

  const save = (): void => {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, statePath);
  };

  const balanceOf = (): number => Math.max(0, budget - state.consumed + state.bonus);

  const status = (): RiceBowlStatus => {
    rollDay();
    const balance = balanceOf();
    return { balance, budget, consumedToday: state.consumed, level: riceLevelOf(balance, budget) };
  };

  return {
    recordUsage(usage) {
      rollDay();
      const tokens = Math.max(0, Math.round(usage.inputTokens + usage.outputTokens));
      if (tokens === 0) return { status: status(), tokens: 0 };
      state.consumed += tokens;
      save();
      appendFileSync(
        ledgerPath,
        `${JSON.stringify({
          ts: now(),
          slot: usage.slot,
          providerId: usage.providerId,
          modelId: usage.modelId,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          riceGrains: tokens,
          latencyMs: usage.latencyMs,
        })}\n`,
        'utf8',
      );
      return { status: status(), tokens };
    },
    feed(grains) {
      rollDay();
      state.bonus += Math.max(0, Math.round(grains));
      save();
      return status();
    },
    status,
  };
}
