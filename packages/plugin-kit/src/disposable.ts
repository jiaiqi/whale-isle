/**
 * 生命周期原语（零依赖）：可逆副作用句柄、逆序批量释放与错误格式化。
 * 设计来源：Cordis effect/dispose 语义的最小重写——插件在 enable 期建立的一切副作用
 * （定时器、订阅、子进程、文件句柄）都必须在 disable 时被完整撤销；单个清理器抛错
 * 不得中断其余清理（崩溃隔离铁律，ARCHITECTURE §3.2）。
 */

/** 可逆副作用句柄：disable 时调用 dispose 撤销该副作用（实现必须幂等） */
export interface Disposable {
  dispose(): void;
}

/** 允许把裸函数直接当作清理器使用（插件作者最省事的写法） */
export type DisposableLike = Disposable | (() => void);

/** 归一化为 Disposable（裸函数包一层） */
export function toDisposable(value: DisposableLike): Disposable {
  return typeof value === 'function' ? { dispose: value } : value;
}

/**
 * 逆序释放（LIFO，与建立顺序相反）：后建立的副作用可能依赖先建立的，
 * 必须后拆先建。单个抛错不中断其余清理，异常收集后返回，由宿主写入 errors。
 */
export function disposeAll(items: readonly Disposable[]): Error[] {
  const errors: Error[] = [];
  for (const item of [...items].reverse()) {
    try {
      item.dispose();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(formatError(error)));
    }
  }
  return errors;
}

/** 统一错误文案：Error / 字符串 / 其它抛出物 → 可读字符串（禁止 [object Object] 之外再丢信息） */
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
