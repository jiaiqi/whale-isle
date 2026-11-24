/**
 * 结构化环境障碍摘要（T-M6-57）。
 *
 * 中小模型在真机上常白撞两轮才发现「商店没开门 / 背包没鱼竿 / 快满了」。
 * 这里把 get_state 与最近回执里**已确证**的高价值前置事实提炼成 ≤240 字，
 * 每轮注入 LlmPlanner user prompt；纯函数、零网络、缺证据绝不编造。
 */
const MAX_HINTS_CHARS = 240;

function backpackSection(raw: string): string | null {
  const match = /## 背包[^\n]*\n([\s\S]*?)(?=\n## |\n\n|$)/.exec(raw);
  return match?.[1] ?? null;
}

function clockLabel(minutes: number): string {
  const hh = `${Math.floor(minutes / 60) % 24}`.padStart(2, '0');
  const mm = `${Math.round(minutes % 60)}`.padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 从最近回执里取最后一条 list_chests 成功摘要（不含正文隐私，只是物品清单）。 */
function latestChestSummary(receipts: readonly string[]): string {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index] ?? '';
    const match = /^(?:OK|COMPLETED)\s+list_chests\s*[:：]?\s*([\s\S]*)$/i.exec(receipt.trim());
    if (match?.[1] === undefined) continue;
    const summary = match[1].replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
    if (summary !== '') return summary;
  }
  return '';
}

/**
 * @param stateRaw 最近一次 get_state 原文（BWF 文本）
 * @param clockMinutes 游戏内分钟数（6:00 = 360）
 * @param recentReceipts 最近回执（`COMPLETED tool: summary`）
 */
export function extractEnvironmentHints(
  stateRaw: string,
  clockMinutes: number,
  recentReceipts: readonly string[],
): string {
  const facts: string[] = [];
  const backpack = backpackSection(stateRaw);
  if (backpack !== null && !/鱼竿/.test(backpack)) {
    facts.push('背包没有鱼竿：先查箱子 list_chests，没有再去鱼店买（09:00-17:00）');
  }
  const free = /背包空位：(\d+)/.exec(stateRaw);
  if (free?.[1] !== undefined) {
    const slots = Number(free[1]);
    if (slots <= 2) facts.push(`背包只剩 ${slots} 个空位：先整理/出货再进货`);
  }
  if (Number.isFinite(clockMinutes)) {
    if (clockMinutes < 9 * 60) {
      facts.push(`现在 ${clockLabel(clockMinutes)}，鱼店和皮埃尔 09:00 才开门，别白跑`);
    } else if (clockMinutes >= 17 * 60) {
      facts.push(`现在 ${clockLabel(clockMinutes)}，鱼店和皮埃尔 17:00 已打烊，别白跑`);
    }
  }
  const chest = latestChestSummary(recentReceipts);
  if (chest !== '') facts.push(`刚查到的箱子：${chest.slice(0, 80)}`);
  const text = facts.join('；');
  return text.length > MAX_HINTS_CHARS ? `${text.slice(0, MAX_HINTS_CHARS - 1)}…` : text;
}
