/**
 * Whale Isle V2 统一类型化事件总线：
 * - 标准信封（id / seq / type / source / characterId / timestamp / payload）
 * - 支持精确匹配、'domain:*' 前缀通配、'*' 全匹配
 * - 支持有界环形历史（渲染层刷新水合 / WebUI 晚连回放）
 * - 监听器异常隔离，防止单点错误中断总线广播
 */
import { randomUUID } from 'node:crypto';
import type { Disposable } from '@workbench/plugin-kit';

export interface RuntimeEventEnvelope<T = unknown> {
  id: string;
  seq: number;
  type: string;
  source: string;
  timestamp: number;
  characterId?: string;
  payload: T;
}

export type RuntimeEventHandler<T = unknown> = (event: RuntimeEventEnvelope<T>) => void;

export interface EventPublishMeta {
  source?: string;
  characterId?: string;
}

export interface RuntimeEventBusOptions {
  maxHistory?: number;
  now?: () => number;
  onListenerError?: (type: string, error: unknown) => void;
}

interface Subscription {
  pattern: string;
  handler: (event: RuntimeEventEnvelope<unknown>) => void;
  once: boolean;
  active: boolean;
}

export function matchesEventPattern(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return eventType.startsWith(pattern.slice(0, -1));
  return pattern === eventType;
}

export class RuntimeEventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly ring: RuntimeEventEnvelope<unknown>[] = [];
  private readonly maxHistory: number;
  private readonly now: () => number;
  private readonly onListenerError: ((type: string, error: unknown) => void) | undefined;
  private seq = 0;

  constructor(options: RuntimeEventBusOptions = {}) {
    this.maxHistory = Math.max(10, options.maxHistory ?? 200);
    this.now = options.now ?? Date.now;
    this.onListenerError = options.onListenerError;
  }

  publish<T>(type: string, payload: T, meta: EventPublishMeta = {}): RuntimeEventEnvelope<T> {
    const envelope: RuntimeEventEnvelope<T> = {
      id: randomUUID(),
      seq: ++this.seq,
      type,
      source: meta.source ?? 'kernel',
      timestamp: this.now(),
      ...(meta.characterId === undefined ? {} : { characterId: meta.characterId }),
      payload,
    };
    this.ring.push(envelope);
    if (this.ring.length > this.maxHistory) {
      this.ring.splice(0, this.ring.length - this.maxHistory);
    }

    for (const sub of [...this.subscriptions]) {
      if (!sub.active || !matchesEventPattern(sub.pattern, type)) continue;
      if (sub.once) this.remove(sub);
      try {
        sub.handler(envelope);
      } catch (error) {
        this.onListenerError?.(type, error);
      }
    }
    return envelope;
  }

  subscribe<T = unknown>(pattern: string, handler: RuntimeEventHandler<T>): Disposable {
    return this.add(pattern, handler, false);
  }

  once<T = unknown>(pattern: string, handler: RuntimeEventHandler<T>): Disposable {
    return this.add(pattern, handler, true);
  }

  history(limit = 50, pattern?: string): RuntimeEventEnvelope<unknown>[] {
    const matched = pattern === undefined
      ? this.ring
      : this.ring.filter((event) => matchesEventPattern(pattern, event.type));
    return matched.slice(-Math.max(1, limit));
  }

  clearHistory(): void {
    this.ring.length = 0;
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  private add<T>(pattern: string, handler: RuntimeEventHandler<T>, once: boolean): Disposable {
    const sub: Subscription = {
      pattern,
      handler: handler as (event: RuntimeEventEnvelope<unknown>) => void,
      once,
      active: true,
    };
    this.subscriptions.add(sub);
    return { dispose: () => this.remove(sub) };
  }

  private remove(sub: Subscription): void {
    sub.active = false;
    this.subscriptions.delete(sub);
  }
}
