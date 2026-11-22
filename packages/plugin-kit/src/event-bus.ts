/**
 * 零依赖事件总线（Cordis typed events 的最小重写）：
 * - `domain:*` 尾部通配（`domain.*` 写法等价，本质是前缀匹配）；`*` 全匹配
 * - `once` 只响应首个命中事件（命中即自动注销，防重入重复触发）
 * - 监听器异常隔离：回调给宿主写 errors，绝不中断同一事件的其他监听器
 * - 每个订阅返回幂等 dispose，插件 disable 时统一回收
 */
import type { Disposable } from './disposable';

export type EventHandler<T = unknown> = (payload: T) => void;

/** 监听器异常回调（宿主用于写入 errors 列表，ownerId 用于定位肇事插件） */
export type ListenerErrorHandler = (ownerId: string, error: unknown) => void;

interface Subscription {
  pattern: string;
  handler: (payload: unknown) => void;
  once: boolean;
  ownerId: string;
  active: boolean;
}

/** 尾通配匹配：'stardew:*' / 'stardew.*' 前缀命中；'*' 全匹配；其余精确匹配 */
function matchesPattern(pattern: string, event: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}

export class EventBus {
  private readonly subscriptions = new Set<Subscription>();

  constructor(private readonly onListenerError: ListenerErrorHandler = () => {}) {}

  on<T = unknown>(pattern: string, handler: EventHandler<T>, ownerId = 'host'): Disposable {
    return this.add(pattern, handler, ownerId, false);
  }

  once<T = unknown>(pattern: string, handler: EventHandler<T>, ownerId = 'host'): Disposable {
    return this.add(pattern, handler, ownerId, true);
  }

  /** 广播事件，返回命中的监听器数量（含抛错但仍被调用的） */
  emit<T = unknown>(event: string, payload: T): number {
    let delivered = 0;
    // 快照遍历：监听器在回调里增删订阅不影响本轮投递
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.active || !matchesPattern(subscription.pattern, event)) continue;
      delivered++;
      if (subscription.once) this.remove(subscription);
      try {
        subscription.handler(payload);
      } catch (error) {
        this.onListenerError(subscription.ownerId, error);
      }
    }
    return delivered;
  }

  /** 按 owner（插件 id）兜底回收全部订阅，返回回收数量 */
  removeByOwner(ownerId: string): number {
    let removed = 0;
    for (const subscription of [...this.subscriptions]) {
      if (subscription.ownerId !== ownerId) continue;
      this.remove(subscription);
      removed++;
    }
    return removed;
  }

  /** 活跃订阅数（诊断/测试用） */
  get size(): number {
    return this.subscriptions.size;
  }

  private add<T>(pattern: string, handler: EventHandler<T>, ownerId: string, once: boolean): Disposable {
    const subscription: Subscription = {
      pattern,
      handler: handler as (payload: unknown) => void,
      once,
      ownerId,
      active: true,
    };
    this.subscriptions.add(subscription);
    return { dispose: () => this.remove(subscription) };
  }

  /** 注销订阅（幂等：已失效的订阅重复 dispose 无副作用） */
  private remove(subscription: Subscription): void {
    subscription.active = false;
    this.subscriptions.delete(subscription);
  }
}
