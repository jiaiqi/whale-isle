/**
 * 跨日失败动作账本与 planner 的接线（V2-P4-01 秋5 真机）。
 *
 * 单独成文件是为了让 `llm-planner.ts` 保持在 500 行硬门禁内（T-M6-70）。
 * 这里只做「记入失败 + 生成事实提示段」两件事，判定口径全在 failed-action-ledger.ts。
 */
import {
  buildFailedActionLedgerSection,
  parseFailedActionRecord,
  type FailedActionLedger,
  type FailedActionRecord,
} from './failed-action-ledger';

/** 账本宿主：只要求「读快照 + 记入并落盘」两个能力（由 StrategyNotebook 实现） */
export interface FailedActionLedgerHost {
  failedActionLedgerSnapshot(): FailedActionLedger;
  recordFailedActionLedgerEntry(entry: FailedActionRecord): void;
}

/**
 * 记入一次失败回执；成功回执返回 null（不改账本）。
 * 只在 FAILED 时累计，「工具 + 关键参数」签名跨日保留。
 */
export function observeFailedAction(
  host: FailedActionLedgerHost,
  input: { tool: string; status: string; summary: string; clock: string; dayKey: string; ts: string },
): FailedActionRecord | null {
  if (input.status !== 'FAILED') return null;
  const record = parseFailedActionRecord(`FAILED ${input.tool}: ${input.summary}`, input.clock, input.dayKey, input.ts);
  if (record === null) return null;
  host.recordFailedActionLedgerEntry(record);
  return record;
}

/** 生成注入 prompt 的事实提示段（无重复失败时返回空串） */
export function failedActionLedgerPromptText(host: FailedActionLedgerHost, currentDayKey: string): string {
  return buildFailedActionLedgerSection(host.failedActionLedgerSnapshot(), currentDayKey);
}
