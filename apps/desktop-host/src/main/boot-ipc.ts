/**
 * 启动早期就必须就位的 IPC（`V2-P2-10`）。
 *
 * 中控台 renderer 首挂即调用 `petSleepStatus()`（`renderer/director/App.tsx`），而历史实现把
 * `ipcMain.handle('pet:sleep-status')` 放在 `createDirectorWindow()` 之后；冷启动在
 * `await petWindowManager.open(...)` 让出事件循环的窗口里，renderer 会跑赢 boot，主进程打印
 * `Error occurred in handler for 'pet:sleep-status': ... No handler registered` 并丢掉这一次读取。
 *
 * 这里只收敛「启动期注册 + 纯计算」两件事，便于确定性单测；不改变 IPC 契约，也不动其它 handler
 * 的注册顺序：其余 `pet:*` handler 的闭包引用 boot 内后声明的 `const`（`prefs` / `characters` /
 * `petControl` 等），整组前移会在早期调用时撞 TDZ，只有本条只依赖模块级状态，可以安全前移。
 */

export interface PetSleepStatus {
  ok: boolean;
  asleep: boolean;
  count: number;
}

export interface SleepStatusInput {
  /** 当前在场的桌宠 agentId（`petWindowManager.list()` 的映射）；窗管理器未就绪时为空数组。 */
  agentIds: readonly string[];
  /** 处于安静睡眠的 agentId 集合（模块级，早于 boot 初始化；无持久化，冷启动为空）。 */
  asleepAgents: ReadonlySet<string>;
}

/**
 * 纯函数：只统计「在场且睡眠」的桌宠。
 * 冷启动两者都为空 → `{ ok: true, asleep: false, count: 0 }`，与 renderer 的初值一致。
 */
export function computeSleepStatus(input: SleepStatusInput): PetSleepStatus {
  let count = 0;
  for (const agentId of input.agentIds) {
    if (input.asleepAgents.has(agentId)) count += 1;
  }
  return { ok: true, asleep: count > 0, count };
}

/** 只依赖 `ipcMain.handle` 的结构类型，避免为了单测把整个 Electron 拉进来。 */
export interface EarlyIpcHost {
  handle(channel: string, listener: (event: unknown) => unknown): void;
}

export interface EarlyIpcDeps {
  ipcMain: EarlyIpcHost;
  asleepAgents: ReadonlySet<string>;
  listAgentIds: () => readonly string[];
}

/**
 * 必须在创建中控台窗之前调用（boot 顶部、任何 `await` 之前）。
 * handler 内惰性读取，注册时 `petWindowManager` 尚未初始化也没关系。
 */
export function registerEarlyIpc(deps: EarlyIpcDeps): void {
  deps.ipcMain.handle('pet:sleep-status', () =>
    computeSleepStatus({ agentIds: deps.listAgentIds(), asleepAgents: deps.asleepAgents }));
}

/** [E2E-HOST] 启动期错误留档的全局键（仅 E2E 进程内可见，不跨进程）。 */
export const BOOT_ERRORS_GLOBAL = '__whaleBootErrors';

export interface BootErrorTarget {
  error: (...args: unknown[]) => void;
}

/**
 * [E2E-HOST] 启动期 `console.error` 留档：原样转发（真实 stderr 行为不变），另存一份到
 * `globalThis.__whaleBootErrors`，供 `boot-ipc.e2e.spec.ts` 断言启动竞态不再出现
 * 「No handler registered」。只在 `PET_STAGE_E2E=1` 的宿主里安装。
 */
export function installBootErrorRecorder(target: BootErrorTarget = console): string[] {
  const errors: string[] = [];
  const original = target.error.bind(target);
  target.error = (...args: unknown[]): void => {
    errors.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '));
    original(...args);
  };
  (globalThis as Record<string, unknown>)[BOOT_ERRORS_GLOBAL] = errors;
  return errors;
}
