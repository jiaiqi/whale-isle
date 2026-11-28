/**
 * 跨日失败动作账本（V2-P4-01，2026-11-28 秋5 真机）。
 *
 * 真机现象：夏28 已经学到「(69,16) 四周没有可以站的地方 → 站位不可达」，
 * 但秋5 换了一天、失败记忆窗口（最近 8 条回执）被新回执冲掉后，模型又在
 * **同一个坐标**连续失败 3 次，心得本里那条教训也没被检索到（检索只看
 * 季节/地点/状态原文，不看失败上下文）。
 *
 * 这里补一个**只陈述事实**的账本：
 *   - 按「工具 + 关键参数（坐标/物品/地点）」归并，跨日保留；
 *   - 同一签名累计失败 ≥ 阈值时，生成一句事实提示（写明次数与最近原文）；
 *   - 不判定该怎么办、不改回执状态、不替模型选动作（符合 AI-first 红线）。
 *
 * 关键参数提取规则保持保守：坐标 (x,y)、物品名、location 目标，只取能稳定
 * 复现的那一个，避免把不同问题误并成同一签名。
 */
import { createHash } from 'node:crypto';
/** 同一签名累计失败多少次才提示（1 次可能是偶发，2 次即开始像物理限制） */
export const FAILED_ACTION_ALERT_THRESHOLD = 2;
/** 账本最多保留多少条签名（避免无限增长） */
export const FAILED_ACTION_LEDGER_LIMIT = 60;

export interface FailedActionRecord {
  /** 签名（工具 + 关键参数摘要） */
  signature: string;
  /** 工具名 */
  tool: string;
  /** 提取出的关键参数摘要，如 "(69,16)" / "AnimalShop" / "普通蘑菇" */
  subject: string;
  /** 累计失败次数 */
  count: number;
  /** 最近一次失败的游戏时钟 */
  lastClock: string;
  /** 最近一次失败原文（首行） */
  lastSummary: string;
  /** 最近一次失败时间戳 */
  lastTs: string;
  /** 首次出现的游戏日期键，如 "1-秋5" */
  firstDayKey: string;
}

/** 从失败回执原文里提取「稳定可复现」的关键参数摘要。 */
export function extractFailureSubject(tool: string, summary: string): string {
  // 去掉回执前缀的「失败：」，避免把同一原因归并成不同签名
  const detail = summary.replace(/^失败[:：]\s*/, '').trim();
  // 坐标：失败点几乎都是坐标相关
  const coord = /\((\d{1,3})\s*,\s*(\d{1,3})\)/.exec(detail);
  if (coord?.[1] !== undefined && coord[2] !== undefined) return `(${coord[1]},${coord[2]})`;
  // 物品名：引号内的物品
  const quoted = /[“"「]([^”"」\s]{1,20})[”"」]/.exec(detail);
  if (quoted?.[1] !== undefined) return quoted[1];
  // 地点：还没开门 / 进不去这类（地点常带中英文括号，如「玛妮的牧场（AnimalShop）」）
  const place = /([A-Za-z]{2,20})[）)]?(?:还没开门|进不去)/.exec(detail);
  if (place?.[1] !== undefined) return place[1];
  // 原因首句归并（按前 20 字）
  return detail.split(/[，。\n]/)[0]?.slice(0, 20) ?? '';
}

/** 失败回执 → 账本记录；非失败回执返回 null。 */
export function parseFailedActionRecord(receipt: string, clock: string, dayKey: string, ts: string): FailedActionRecord | null {
  const m = /^FAILED\s+([^\s:：]+)\s*[:：]\s*(.*)$/s.exec(receipt);
  if (m?.[1] === undefined) return null;
  const tool = m[1];
  const detail = (m[2] ?? '').trim();
  if (detail === '') return null;
  const subject = extractFailureSubject(tool, detail);
  const signature = `${tool}|${subject}`;
  return {
    signature,
    tool,
    subject,
    count: 1,
    lastClock: clock,
    lastSummary: detail.split('\n')[0]?.slice(0, 160) ?? '',
    lastTs: ts,
    firstDayKey: dayKey,
  };
}

/** 账本状态（可序列化，跨日保留） */
export interface FailedActionLedger {
  records: FailedActionRecord[];
}

/** 空账本 */
export function createFailedActionLedger(): FailedActionLedger {
  return { records: [] };
}

/** 记入一次失败；同签名累计计数并更新最近一次原文。 */
export function recordFailedAction(ledger: FailedActionLedger, record: FailedActionRecord): FailedActionLedger {
  const existing = ledger.records.find((r) => r.signature === record.signature);
  const records = existing === undefined
    ? [...ledger.records, record]
    : ledger.records.map((r) => (r.signature === record.signature
      ? { ...r, count: r.count + 1, lastClock: record.lastClock, lastSummary: record.lastSummary, lastTs: record.lastTs }
      : r));
  const trimmed = records.length > FAILED_ACTION_LEDGER_LIMIT
    ? records.slice(records.length - FAILED_ACTION_LEDGER_LIMIT)
    : records;
  return { records: trimmed };
}

/**
 * 生成事实提示段：只列出「累计失败 ≥ 阈值」的签名，写明次数、参数与最近原文。
 * 跨日也保留（这正是「夏28 学过、秋5 又踩」要治的病）。
 */
export function buildFailedActionLedgerSection(ledger: FailedActionLedger, currentDayKey?: string): string {
  const repeated = ledger.records.filter((r) => r.count >= FAILED_ACTION_ALERT_THRESHOLD);
  if (repeated.length === 0) return '';
  const lines = repeated
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((r) => {
      const crossDay = currentDayKey !== undefined && r.firstDayKey !== currentDayKey
        ? `（首次见于${r.firstDayKey}，跨日重复）`
        : '';
      return `- ${r.tool} 在「${r.subject}」已累计失败${r.count}次${crossDay}，最近一次（${r.lastClock}）：${r.lastSummary.slice(0, 120)}`;
    });
  return '\n\n## 跨日累计失败动作（真实回执事实）\n'
    + lines.join('\n')
    + '\n以上失败在之前的日子里也发生过，通常对应未改变的物理或前置限制（站位不可达、容器已满、门未开、物品不存在、路线不通）。'
    + '请先对照当前状态核对回执点名的限制是否仍然存在：'
    + '站位不可达就换一个相邻的可站坐标取放、门未开就先做别的事等营业、物品不存在就先 list_chests({}) 查全览、路线不通就改用经过的中转地图；'
    + '确认限制已消失前，不要在同一个坐标或同一个目标上原样重试。';
}

/** 账本落盘格式（与心得本同目录，按存档分文件，跨日与跨进程保留） */
export interface FailedActionLedgerFile {
  version: 1;
  records: FailedActionRecord[];
}

/** 从落盘文件恢复账本；损坏文件安全退回空账本，绝不阻断决策。 */
export function parseFailedActionLedgerFile(raw: unknown): FailedActionLedger {
  const file = raw as Partial<FailedActionLedgerFile> | null;
  if (file === null || typeof file !== 'object' || !Array.isArray(file.records)) return createFailedActionLedger();
  const records: FailedActionRecord[] = [];
  for (const item of file.records) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Partial<FailedActionRecord>;
    if (typeof r.signature !== 'string' || typeof r.tool !== 'string' || typeof r.count !== 'number') continue;
    if (r.count < 1) continue;
    records.push({
      signature: r.signature,
      tool: r.tool,
      subject: typeof r.subject === 'string' ? r.subject : '',
      count: Math.floor(r.count),
      lastClock: typeof r.lastClock === 'string' ? r.lastClock : '',
      lastSummary: typeof r.lastSummary === 'string' ? r.lastSummary : '',
      lastTs: typeof r.lastTs === 'string' ? r.lastTs : '',
      firstDayKey: typeof r.firstDayKey === 'string' ? r.firstDayKey : '未知',
    });
  }
  const trimmed = records.length > FAILED_ACTION_LEDGER_LIMIT
    ? records.slice(records.length - FAILED_ACTION_LEDGER_LIMIT)
    : records;
  return { records: trimmed };
}

/** 账本序列化为落盘格式 */
export function serializeFailedActionLedger(ledger: FailedActionLedger): FailedActionLedgerFile {
  return { version: 1, records: ledger.records };
}
