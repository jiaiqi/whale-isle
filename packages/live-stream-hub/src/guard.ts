/**
 * 防封护栏（T-M5-05）——输入侧第一道闸：违规词三级处置 / 频控 / 长度截断。
 *
 *  - block：直接丢弃（政治、色情、导流广告等占位词表，可配置）；
 *  - mask ：就地掩码为 ***，观众能看到「被处理过」但不会把脏字喂给模型与 TTS；
 *  - warn ：保留但标记（契约里没有 warn 字段，标记通过返回的 reason 与统计透出，绝不私改契约）。
 *
 * 截断按 UTF-16 码元边界安全进行，并清洗孤立代理对——emoji 被砍半会变成 �，
 * 参考 dsh-fish clip.js 的文本切分思想重写，不复制其实现。
 */
import type { NormalizedLiveEvent } from '@workbench/shared-protocol';

export type GuardAction = 'pass' | 'mask' | 'drop';

export interface GuardRules {
  /** 命中即丢弃 */
  block: string[];
  /** 命中即掩码 */
  mask: string[];
  /** 命中保留但标记 */
  warn: string[];
}

/** 默认词表是占位样本：真实运营词表由 Shell 配置页下发（运行期只消费校验过的配置） */
export const DEFAULT_GUARD_RULES: GuardRules = {
  block: ['政治敏感占位词', '色情违规占位词', '加微信', '代开发票', '私聊下单'],
  mask: ['傻逼', '去死', 'fuck'],
  warn: ['滚', '恶心', '退钱'],
};

export interface GuardOptions {
  /** 逐类覆盖默认词表（未提供的类别沿用默认） */
  rules?: Partial<GuardRules>;
  /** 单条文本最大 UTF-16 码元数 */
  maxTextLength?: number;
  /** 同 uid 在窗口内最多可发送的文本条数 */
  maxMessagesPerWindow?: number;
  /** 频控窗口（默认 60s） */
  frequencyWindowMs?: number;
  /** 时间注入（确定性测试） */
  now?: () => number;
}

export interface GuardResult {
  action: GuardAction;
  /** pass/mask 时为清洗后的事件；drop 时为原始事件（调用方应丢弃） */
  event: NormalizedLiveEvent;
  /** block:<词> / frequency:<uid> / mask:<词> / warn:<词> */
  reason?: string;
}

export interface GuardStats {
  inspected: number;
  passed: number;
  masked: number;
  warned: number;
  blocked: number;
  frequencyDropped: number;
  dropped: number;
  /** 发生截断的事件数 */
  truncated: number;
  /** 清洗掉孤立代理对的事件数 */
  loneSurrogateCleaned: number;
}

/** 正则元字符转义（词表来自配置，不能假设干净） */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 清洗孤立代理对：合法的高低位代理对原样保留，孤零零的高位/低位代理直接丢弃。
 * 例：'A\uD83DB'（BMP 前的高位代理）→ 'AB'。
 */
export function stripLoneSurrogates(input: string): string {
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += input.charAt(index) + input.charAt(index + 1);
        index += 1;
      }
      // 孤立高位代理：丢弃
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立低位代理：丢弃
      continue;
    }
    output += input.charAt(index);
  }
  return output;
}

/**
 * 按 UTF-16 码元上限安全截断：绝不砍开代理对（emoji 不会被切成半个）。
 * 返回是否真的发生了截断，供统计与调试。
 */
export function truncateUtf16Safe(input: string, maxUnits: number): { text: string; truncated: boolean } {
  if (maxUnits <= 0) return { text: '', truncated: input.length > 0 };
  if (input.length <= maxUnits) return { text: input, truncated: false };
  let output = '';
  for (const char of input) {
    if (output.length + char.length > maxUnits) break;
    output += char;
  }
  return { text: output, truncated: true };
}

/** 清洗 + 截断二合一（对外导出便于直接单测边界） */
export function sanitizeOutgoingText(input: string, maxUnits: number): { text: string; truncated: boolean; cleanedSurrogate: boolean } {
  const stripped = stripLoneSurrogates(input);
  const result = truncateUtf16Safe(stripped, maxUnits);
  return { text: result.text, truncated: result.truncated, cleanedSurrogate: stripped !== input };
}

/** 事件是否带可清洗文本（礼物/进场等环境事件没有文本，不参与频控与截断） */
function hasText(event: NormalizedLiveEvent): boolean {
  return event.payload.rawText !== undefined || event.payload.sanitizedText !== undefined;
}

export class Guard {
  private readonly rules: GuardRules;
  private readonly maxTextLength: number;
  private readonly maxMessagesPerWindow: number;
  private readonly frequencyWindowMs: number;
  private readonly now: () => number;

  /** uid → 窗口内的发送时间戳（只保留窗口内的活跃用户，空数组即删） */
  private readonly frequency = new Map<string, number[]>();

  private readonly counters: GuardStats = {
    inspected: 0,
    passed: 0,
    masked: 0,
    warned: 0,
    blocked: 0,
    frequencyDropped: 0,
    dropped: 0,
    truncated: 0,
    loneSurrogateCleaned: 0,
  };

  constructor(options: GuardOptions | (() => number) = {}) {
    // 允许直接传时钟函数（等价于 { now }），便于测试与宿主快速接线
    const opts: GuardOptions = typeof options === 'function' ? { now: options } : options;
    this.rules = {
      block: opts.rules?.block ?? DEFAULT_GUARD_RULES.block,
      mask: opts.rules?.mask ?? DEFAULT_GUARD_RULES.mask,
      warn: opts.rules?.warn ?? DEFAULT_GUARD_RULES.warn,
    };
    this.maxTextLength = opts.maxTextLength ?? 200;
    this.maxMessagesPerWindow = opts.maxMessagesPerWindow ?? 20;
    this.frequencyWindowMs = opts.frequencyWindowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** 主入口：先判 block，再判频控，最后 mask/warn + 清洗截断 */
  filter(event: NormalizedLiveEvent): GuardResult {
    this.counters.inspected += 1;
    if (!hasText(event)) {
      this.counters.passed += 1;
      return { action: 'pass', event };
    }

    const source = event.payload.rawText ?? event.payload.sanitizedText ?? '';
    const now = this.now();

    const blockedWord = this.firstHit(source, this.rules.block);
    if (blockedWord !== null) {
      this.counters.blocked += 1;
      this.counters.dropped += 1;
      return { action: 'drop', event, reason: `block:${blockedWord}` };
    }

    if (this.isOverFrequency(event.sender.uid, now)) {
      this.counters.frequencyDropped += 1;
      this.counters.dropped += 1;
      return { action: 'drop', event, reason: `frequency:${event.sender.uid}` };
    }
    this.recordFrequency(event.sender.uid, now);

    const maskHits: string[] = [];
    let processed = source;
    for (const word of this.rules.mask) {
      if (word.length === 0) continue;
      if (this.firstHit(processed, [word]) === null) continue;
      processed = processed.replace(new RegExp(escapeRegExp(word), 'gi'), '***');
      maskHits.push(word);
    }

    let action: GuardAction = 'pass';
    let reason: string | undefined;
    if (maskHits.length > 0) {
      action = 'mask';
      reason = `mask:${maskHits.join(',')}`;
      this.counters.masked += 1;
    }

    const warnWord = this.firstHit(processed, this.rules.warn);
    if (warnWord !== null) {
      this.counters.warned += 1;
      // mask 与 warn 同时命中时保留更强的 mask 语义，warn 仅计数（reason 不覆盖）
      if (reason === undefined) reason = `warn:${warnWord}`;
    }

    const sanitized = sanitizeOutgoingText(processed, this.maxTextLength);
    if (sanitized.truncated) this.counters.truncated += 1;
    if (sanitized.cleanedSurrogate) this.counters.loneSurrogateCleaned += 1;

    // rawText 也一并落成清洗后的文本——下游即使误读 rawText 也拿不到脏字/超长文本，
    // 原始文本只保留在总线日志侧（Hub 不入库原文，符合最小化留存）
    const outgoing: NormalizedLiveEvent = {
      ...event,
      payload: {
        ...event.payload,
        rawText: sanitized.text,
        sanitizedText: sanitized.text,
      },
    };

    if (action === 'pass') this.counters.passed += 1;
    return reason === undefined ? { action, event: outgoing } : { action, event: outgoing, reason };
  }

  stats(): GuardStats {
    return { ...this.counters };
  }

  // --------------------------------------------------------------------------
  // 内部实现
  // --------------------------------------------------------------------------

  /** 大小写不敏感地找第一个命中词（返回词表原词，便于日志） */
  private firstHit(text: string, words: readonly string[]): string | null {
    for (const word of words) {
      if (word.length === 0) continue;
      if (new RegExp(escapeRegExp(word), 'i').test(text)) return word;
    }
    return null;
  }

  private isOverFrequency(uid: string, now: number): boolean {
    const stamps = this.frequency.get(uid);
    if (stamps === undefined) return false;
    this.pruneStamps(stamps, now);
    if (stamps.length === 0) {
      // 窗口内已无记录：顺手释放 uid，长时间直播不积累空数组
      this.frequency.delete(uid);
      return false;
    }
    return stamps.length >= this.maxMessagesPerWindow;
  }

  private recordFrequency(uid: string, now: number): void {
    const stamps = this.frequency.get(uid) ?? [];
    stamps.push(now);
    this.frequency.set(uid, stamps);
  }

  private pruneStamps(stamps: number[], now: number): void {
    while (stamps.length > 0) {
      const head = stamps[0];
      if (head === undefined || now - head <= this.frequencyWindowMs) break;
      stamps.shift();
    }
  }
}
