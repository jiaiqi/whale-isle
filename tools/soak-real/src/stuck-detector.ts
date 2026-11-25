/**
 * 卡死判定（T-M6-67）：四条判定的纯状态机 + 失败签名归一化。
 *
 *   1. clock-stall     游戏时钟连续 180s（现实）不推进；睡觉/过场/存档/换日点豁免
 *   2. repeat-failure  同一失败签名在最近 30 条回执里 ≥3 次，且期间游戏时间推进 ≤1 小时
 *   3. bwf-self-pause  回执或状态文本出现「已暂停游戏」「秒没有动作」
 *   4. sentinel        runner 自己发出 watchdog kind=stuck
 *
 * 同一签名 5 分钟内只报一次（冷却去重）。不读系统时钟、不发请求——now 由调用方传入。
 */
import type { AutodriveEvent } from '@workbench/game-bridge-mcp';
import { parseGameClock } from './day-tracker';

export type StuckKind = 'clock-stall' | 'repeat-failure' | 'bwf-self-pause' | 'sentinel';

export interface StuckVerdict {
  kind: StuckKind;
  /** 归一化签名（报告/台账主键） */
  signature: string;
  detail: string;
  /** 判定时刻（调用方传入的 epoch ms） */
  at: number;
  location: string;
  clock: string | null;
}

export interface StuckDetectorOptions {
  /** clock-stall 阈值（现实毫秒），默认 180s */
  clockStallMs?: number;
  /** repeat-failure 阈值，默认 3 次 */
  repeatThreshold?: number;
  /** repeat-failure 回执窗口，默认最近 30 条 */
  repeatWindow?: number;
  /** 同签名冷却去重，默认 5 分钟 */
  cooldownMs?: number;
  /** repeat-failure 期间允许的游戏时间推进（分钟），超过则认为有进展、不算卡死 */
  repeatClockBudgetMin?: number;
}

/** BWF 120s 无动作自暂停文案（真机「已暂停游戏」「120 秒没有动作」两种写法都见过） */
export const PAUSE_TEXT_RE = /已暂停游戏|暂停了游戏|游戏已暂停|秒没有动作|没有动作.{0,6}暂停/;

/** 过场 / 存档 / 菜单等「时钟本就该停」的白名单文案 */
export const WHITELIST_TEXT_RE = /睡觉|睡眠|过场|存档|读档|加载|黑屏|保存中|正在保存|剧情|动画|结算/;

const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const COORD_RE = /[（(]\s*-?\d+\s*,\s*-?\d+\s*[）)]/g;
const QUOTED_RE = /[“"「『][^”"」』\n]{1,24}[”"」』]/g;
const STAR_RE = /金星|银星|铱星/g;

/**
 * 失败签名里的「原因模板」：抹掉数字/坐标/引号物品名/星级，压平空白。
 * 目的：同一根因（如「背包里没有鱼竿」）在不同坐标、不同数量下得到同一签名。
 */
export function normalizeFailureReason(summary: string): string {
  const text = summary
    .replace(THINK_RE, ' ')
    .replace(COORD_RE, '(坐标)')
    .replace(QUOTED_RE, '〈物品〉')
    .replace(STAR_RE, '')
    .replace(/\d+/g, '#')
    .replace(/[，。；、,;.!！?？]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** 地点归一化：去掉括号补充说明（「Farm（泡泡湾农场）」→「Farm」） */
export function normalizeLocation(location: string): string {
  const text = location.replace(/[（(].*$/, '').replace(/\s+/g, ' ').trim();
  return text === '' ? '未知' : text;
}

/** 失败签名：`工具|原因模板|地点`（runbook S02 示例：`fish|背包里没有鱼竿|Beach`） */
export function failureSignature(tool: string, summary: string, location: string): string {
  return `${tool}|${normalizeFailureReason(summary)}|${normalizeLocation(location)}`;
}

interface ReceiptRecord {
  signature: string;
  absoluteMinutes: number | null;
}

const FAILED_STATUSES = new Set(['FAILED', 'ERROR', 'TIMEOUT']);

export class StuckDetector {
  private readonly clockStallMs: number;
  private readonly repeatThreshold: number;
  private readonly repeatWindow: number;
  private readonly cooldownMs: number;
  private readonly repeatClockBudgetMin: number;

  private lastClock: string | null = null;
  private lastClockAt = 0;
  private currentAbsoluteMinutes: number | null = null;
  private lastStateText = '';
  private location = '未知';
  /** 最近一次决策是 sleep 时，给「睡觉」一段白名单窗口（默认 10 分钟现实时间） */
  private sleepWhitelistUntil = 0;
  /** T-M6-72b/73：主人临时介入中（介入期间不判时钟停滞/自暂停/重复失败） */
  private humanControlActive = false;
  private readonly receipts: ReceiptRecord[] = [];
  private readonly reportedAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private lastVerdict: StuckVerdict | null = null;

  constructor(options: StuckDetectorOptions = {}) {
    this.clockStallMs = options.clockStallMs ?? 180_000;
    this.repeatThreshold = options.repeatThreshold ?? 3;
    this.repeatWindow = options.repeatWindow ?? 30;
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.repeatClockBudgetMin = options.repeatClockBudgetMin ?? 60;
  }

  /** 是否处于主人临时介入态 */
  get isHumanControl(): boolean {
    return this.humanControlActive;
  }

  /** 全部失败签名计数（报告 Top10 用；按真实失败回执累计，不做冷却） */
  failureCounts(): ReadonlyMap<string, number> {
    return this.failures;
  }

  /** 最近一次判定（供报告/现场包标注） */
  get last(): StuckVerdict | null {
    return this.lastVerdict;
  }

  /** 观察者拿到的 get_state 原文（白名单判定与现场包状态快照共用） */
  setStateText(text: string): void {
    if (text !== '') this.lastStateText = text;
  }

  /** 恢复动作/换日之后重置时钟基线，避免恢复瞬间又报一次 */
  resetClock(now: number): void {
    this.lastClockAt = now;
  }

  /**
   * 喂 runner 事件。state 事件会顺带推进时钟（长动作期间没有 state，由 onClock 兜底）。
   */
  onEvent(event: AutodriveEvent, now: number): StuckVerdict | null {
    switch (event.type) {
      case 'state':
        if (event.location !== '') this.location = normalizeLocation(event.location);
        return this.onClock(event.clock, this.lastStateText, now);
      case 'decision':
        if (event.tool === 'sleep') this.sleepWhitelistUntil = now + 10 * 60_000;
        return null;
      case 'receipt':
        return this.onReceipt(event, now);
      case 'human-control':
        this.humanControlActive = event.active;
        this.lastClockAt = now;
        if (!event.active) this.lastStateText = '';
        return null;
      case 'watchdog':
        if (event.kind !== 'stuck') return null;
        return this.emit('sentinel', `sentinel|${normalizeFailureReason(event.detail) || 'watchdog'}`, event.detail, now);
      default:
        return null;
    }
  }

  /**
   * 观察者时钟：同一个时钟值持续 ≥ clockStallMs 且不在白名单内 → clock-stall。
   * 时钟无法解析（null）时不判定，避免把「状态文本异常」误报成卡死。
   */
  onClock(clock: string | null, stateText: string, now: number): StuckVerdict | null {
    this.setStateText(stateText);
    if (this.humanControlActive) {
      const synced = parseGameClock(clock);
      if (synced !== null) {
        this.lastClock = clock;
        this.currentAbsoluteMinutes = synced.absoluteMinutes;
      }
      this.lastClockAt = now;
      return null;
    }
    const text = this.lastStateText;

    if (PAUSE_TEXT_RE.test(text)) {
      const verdict = this.emit(
        'bwf-self-pause',
        `bwf-self-pause|${normalizeFailureReason(text)}`,
        `状态文本提示 BWF 自暂停：${text.replace(/\s+/g, ' ').slice(0, 120)}`,
        now,
      );
      if (verdict !== null) return verdict;
    }

    const parsed = parseGameClock(clock);
    if (parsed === null) return null;
    this.currentAbsoluteMinutes = parsed.absoluteMinutes;

    if (this.lastClock === null) {
      this.lastClock = clock;
      this.lastClockAt = now;
      return null;
    }
    if (clock !== this.lastClock) {
      this.lastClock = clock;
      this.lastClockAt = now;
      return null;
    }
    if (this.isWhitelisted(parsed, now, text)) {
      this.lastClockAt = now; // 白名单期间重新计时：离开过场后仍需完整 180s 才算卡死
      return null;
    }

    const stallMs = now - this.lastClockAt;
    if (stallMs < this.clockStallMs) return null;
    const verdict = this.emit(
      'clock-stall',
      `clock-stall|${clock}|${this.location}`,
      `游戏时钟 ${clock} 连续 ${Math.round(stallMs / 1000)}s（现实）未推进`,
      now,
    );
    this.lastClockAt = now; // 报过之后重新计时，避免同一段停滞每轮都报
    return verdict;
  }

  private onReceipt(event: Extract<AutodriveEvent, { type: 'receipt' }>, now: number): StuckVerdict | null {
    if (this.humanControlActive) return null;
    if (event.tool === 'sleep') {
      // 睡觉回执到了：退出白名单，并从「回执时刻」重新计时——换日期间时钟本就还在停
      this.sleepWhitelistUntil = 0;
      this.lastClockAt = now;
    }
    const summary = event.summary ?? '';

    if (PAUSE_TEXT_RE.test(summary)) {
      return this.emit(
        'bwf-self-pause',
        `bwf-self-pause|${normalizeFailureReason(summary)}`,
        `回执提示 BWF 自暂停：${summary.replace(/\s+/g, ' ').slice(0, 120)}`,
        now,
      );
    }
    if (event.tool === 'autodrive') return null;

    const signature = failureSignature(event.tool, summary, this.location);
    const failed = FAILED_STATUSES.has(event.status);
    if (failed) this.failures.set(signature, (this.failures.get(signature) ?? 0) + 1);

    this.receipts.push({ signature, absoluteMinutes: this.currentAbsoluteMinutes });
    if (this.receipts.length > this.repeatWindow) this.receipts.splice(0, this.receipts.length - this.repeatWindow);
    if (!failed) return null;

    const hits = this.receipts.filter((receipt) => receipt.signature === signature);
    if (hits.length < this.repeatThreshold) return null;
    const first = hits[0];
    const last = hits[hits.length - 1];
    if (first === undefined || last === undefined) return null;
    const advanced = first.absoluteMinutes === null || last.absoluteMinutes === null
      ? 0
      : Math.abs(last.absoluteMinutes - first.absoluteMinutes);
    if (advanced > this.repeatClockBudgetMin) return null;

    return this.emit(
      'repeat-failure',
      signature,
      `同一失败签名 ${hits.length} 次（最近 ${this.receipts.length} 条回执内，游戏时间仅推进 ${advanced} 分钟）：${signature}`,
      now,
    );
  }

  private isWhitelisted(parsed: { clockMinutes: number }, now: number, text: string): boolean {
    if (now < this.sleepWhitelistUntil) return true;
    if (WHITELIST_TEXT_RE.test(text)) return true;
    // 02:00–06:00 是换日/存档结算窗口，时钟本就该停
    return parsed.clockMinutes >= 2 * 60 && parsed.clockMinutes < 6 * 60;
  }

  private emit(kind: StuckKind, signature: string, detail: string, now: number): StuckVerdict | null {
    const reportedAt = this.reportedAt.get(signature);
    if (reportedAt !== undefined && now - reportedAt < this.cooldownMs) return null;
    this.reportedAt.set(signature, now);
    const verdict: StuckVerdict = {
      kind,
      signature,
      detail,
      at: now,
      location: this.location,
      clock: this.lastClock,
    };
    this.lastVerdict = verdict;
    return verdict;
  }
}
