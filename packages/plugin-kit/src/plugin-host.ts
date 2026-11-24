/**
 * 零依赖插件容器（Cordis 语义最小重写，按 T-M6-03 决策不引入 @cordisjs/core）：
 * - register(manifest, setup)：校验清单 → 登记 → 立即启用（等价 ctx.plugin 装载）
 * - enable/disable：可逆副作用；disable 逆序执行 setup 收集的全部清理器，并注销工具/订阅
 * - 插件树：parentId 组织子插件；disable 父级级联禁用全部后代；父级禁用时子级不得单独启用
 * - 崩溃隔离：setup 抛错只记录 {id,error} 并回滚半成品副作用；工具 execute 异常包装为 {ok:false}
 * - 事件总线：domain:* 通配 + once，监听器抛错不扩散
 */
import type { z } from 'zod';
import type { Disposable, DisposableLike } from './disposable';
import { disposeAll, formatError, toDisposable } from './disposable';
import { ToolRegistry, defineTool } from './define-tool';
import type { Tool, ToolResult, ToolSpec, ToolContext } from './define-tool';
import { EventBus } from './event-bus';
import type { EventHandler } from './event-bus';
import { PluginManifestSchema } from './manifest';
import type { PluginManifest, PluginManifestInput } from './manifest';

/** 插件启用期上下文：插件只能通过它接触宿主能力（工具/事件/清理登记），无旁路 */
export interface PluginContext {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly parentId: string | undefined;
  /**
   * T-M6-49：桌宠本机驱动口。仅当清单声明 `{ resource: 'pet:control', policy: 'allow' }`
   * 时由宿主注入，否则为 undefined（插件不得自行伪造）。
   */
  readonly petApi?: {
    state(agentId: string): Promise<unknown>;
    say(agentId: string, text: string, options?: { wake?: boolean; scene?: 'normal' | 'inner' | 'p0' }): Promise<{ ok: boolean; error?: string }>;
    action(agentId: string, actionState: string, durationMs?: number): Promise<{ ok: boolean; error?: string }>;
  };
  /** 定义并注册工具（随 disable 自动注销）；重名抛错 → setup 失败回滚 */
  defineTool<TSchema extends z.ZodTypeAny, TResult>(spec: ToolSpec<TSchema, TResult>): Tool<TSchema, TResult>;
  on<T = unknown>(event: string, handler: EventHandler<T>): Disposable;
  once<T = unknown>(event: string, handler: EventHandler<T>): Disposable;
  /** 总线广播（插件之间只经总线通信，禁止直接持有彼此引用） */
  emit<T = unknown>(event: string, payload: T): number;
  /**
   * 可逆副作用（Cordis effect 语义）：立即执行 callback，其返回的清理器在 disable 时执行。
   * 需要"登记一个待执行清理器"时写成 `() => () => cleanup()`。
   */
  effect(callback: () => DisposableLike | void): Disposable;
}

/** 插件 setup：返回的清理器（单个/数组/void）在 disable 时逆序释放 */
export type PluginSetup = (ctx: PluginContext) => DisposableLike | DisposableLike[] | void;

/** list() 对外条目（Shell 插件页渲染用） */
export interface PluginListEntry {
  id: string;
  manifest: PluginManifest;
  enabled: boolean;
}

/** 错误阶段：enable=setup 崩溃 / disable=清理器抛错 / event=监听器抛错 */
export type PluginErrorPhase = 'enable' | 'disable' | 'event';

export interface PluginError {
  id: string;
  error: string;
  phase: PluginErrorPhase;
}

interface PluginRuntime {
  disposables: Disposable[];
}

interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  parentId: string | undefined;
  setup: PluginSetup;
  enabled: boolean;
  /** 启用期句柄（register/enable 时新建，disable/crash 后重置为空壳，永不为 null） */
  runtime: PluginRuntime;
}

/** 把 setup 返回值归一化为数组（void/单个/数组三种写法都接受） */
function normalizeDisposables(produced: DisposableLike | DisposableLike[] | void): DisposableLike[] {
  if (produced === undefined) return [];
  return Array.isArray(produced) ? produced : [produced];
}

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly toolRegistry = new ToolRegistry();
  private readonly eventBus: EventBus;
  private readonly errorLog: PluginError[] = [];

  constructor(private readonly options: { petApiFor?: (manifest: PluginManifest) => PluginContext['petApi'] } = {}) {
    this.eventBus = new EventBus((ownerId, error) => {
      this.recordError(ownerId, error, 'event');
    });
  }

  /** 工具注册表（LLM 编排器 / Shell / 插件同源调用的唯一事实源） */
  get tools(): ToolRegistry {
    return this.toolRegistry;
  }

  /** 运行期错误快照（副本，外部不可改写内部日志） */
  get errors(): readonly PluginError[] {
    return [...this.errorLog];
  }

  /**
   * 注册并立即启用插件。
   * @throws 清单非法（ZodError）/ id 重复 / 父插件不存在或未启用 / 自引用父级
   */
  register(manifestInput: PluginManifestInput, setup: PluginSetup, options: { parentId?: string } = {}): this {
    const manifest = PluginManifestSchema.parse(manifestInput);
    if (this.records.has(manifest.id)) throw new Error(`插件 id 重复注册：${manifest.id}`);
    const parentId = options.parentId;
    if (parentId !== undefined) {
      if (parentId === manifest.id) throw new Error(`插件不能以自身为父级：${manifest.id}`);
      const parent = this.records.get(parentId);
      if (!parent) throw new Error(`父插件不存在：${parentId}`);
      if (!parent.enabled) throw new Error(`父插件未启用，不能注册子插件：${parentId}`);
    }
    this.records.set(manifest.id, {
      id: manifest.id,
      manifest,
      parentId,
      setup,
      enabled: false,
      runtime: { disposables: [] },
    });
    this.enable(manifest.id);
    return this;
  }

  /** 启用插件（已启用时幂等；setup 崩溃被隔离，插件留在"已登记未启用"态可重试） */
  enable(id: string): this {
    const record = this.mustGet(id);
    if (record.enabled) return this;
    const parentId = record.parentId;
    if (parentId !== undefined) {
      // parentId 在 register 时已校验存在（容器无删除 API），此处只需校验父级仍启用
      if (!this.mustGet(parentId).enabled) throw new Error(`父插件未启用，不能启用子插件：${id}`);
    }
    const runtime: PluginRuntime = { disposables: [] };
    try {
      const produced = record.setup(this.createContext(record, runtime));
      for (const disposable of normalizeDisposables(produced)) runtime.disposables.push(toDisposable(disposable));
      record.runtime = runtime;
      record.enabled = true;
    } catch (error) {
      // 崩溃隔离：撤销 setup 期建立的半成品副作用、工具与订阅；容器与其它插件继续运行
      for (const disposeError of disposeAll(runtime.disposables)) this.recordError(id, disposeError, 'disable');
      this.toolRegistry.unregisterByPlugin(id);
      this.eventBus.removeByOwner(id);
      record.runtime = { disposables: [] };
      record.enabled = false;
      this.recordError(id, error, 'enable');
    }
    return this;
  }

  /** 禁用插件（幂等）：先自底向上级联禁用后代，再停自身 */
  disable(id: string): this {
    const record = this.mustGet(id);
    for (const descendant of this.descendantsOf(id)) this.stop(descendant);
    this.stop(record);
    return this;
  }

  /** 插件列表（Shell 插件页：{id, manifest, enabled}） */
  list(): PluginListEntry[] {
    return [...this.records.values()].map((record) => ({
      id: record.id,
      manifest: record.manifest,
      enabled: record.enabled,
    }));
  }

  /** 插件记录快照（含父子关系，供树形渲染；未知 id 返回 undefined） */
  get(id: string): { id: string; manifest: PluginManifest; enabled: boolean; parentId: string | undefined } | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    return { id: record.id, manifest: record.manifest, enabled: record.enabled, parentId: record.parentId };
  }

  isEnabled(id: string): boolean {
    return this.records.get(id)?.enabled ?? false;
  }

  /** 直接子插件 id 列表（不含孙辈；未知 id 返回空数组） */
  children(id: string): string[] {
    const result: string[] = [];
    for (const record of this.records.values()) {
      if (record.parentId === id) result.push(record.id);
    }
    return result;
  }

  /** 经宿主调用工具：未知工具/校验失败/execute 抛错统一返回 {ok:false}，不冒泡 */
  async invokeTool(name: string, rawArgs: unknown = {}): Promise<ToolResult> {
    const tool = this.toolRegistry.get(name);
    if (!tool) return { ok: false, error: `未知工具：${name}` };
    const ctx: ToolContext = {
      pluginId: tool.pluginId,
      emit: (event, payload) => {
        this.eventBus.emit(event, payload);
      },
    };
    return tool.invoke(rawArgs, ctx);
  }

  /** 宿主级订阅（渲染/桥接层观察全量事件；owner 固定为 'host'，随宿主生命周期） */
  on<T = unknown>(pattern: string, handler: EventHandler<T>): Disposable {
    return this.eventBus.on(pattern, handler, 'host');
  }

  once<T = unknown>(pattern: string, handler: EventHandler<T>): Disposable {
    return this.eventBus.once(pattern, handler, 'host');
  }

  emit<T = unknown>(event: string, payload: T): number {
    return this.eventBus.emit(event, payload);
  }

  /** 清空错误日志（测试/UI 手动确认后调用） */
  clearErrors(): void {
    this.errorLog.length = 0;
  }

  /** 停止单个插件（不递归；幂等：只有处于启用态才执行清理） */
  private stop(record: PluginRecord): void {
    if (!record.enabled) return;
    record.enabled = false;
    const runtime = record.runtime;
    record.runtime = { disposables: [] };
    // 工具与订阅先撤，避免清理器执行期间仍有外部调用打进来
    this.toolRegistry.unregisterByPlugin(record.id);
    this.eventBus.removeByOwner(record.id);
    for (const error of disposeAll(runtime.disposables)) this.recordError(record.id, error, 'disable');
  }

  /** 后代记录（后序遍历：孙辈在前、子辈在后，保证自底向上停止） */
  private descendantsOf(id: string): PluginRecord[] {
    const ordered: PluginRecord[] = [];
    const collect = (parentId: string): void => {
      for (const record of this.records.values()) {
        if (record.parentId !== parentId) continue;
        collect(record.id);
        ordered.push(record);
      }
    };
    collect(id);
    return ordered;
  }

  private createContext(record: PluginRecord, runtime: PluginRuntime): PluginContext {
    const host = this;
    const petApi = this.options.petApiFor?.(record.manifest);
    return {
      id: record.id,
      manifest: record.manifest,
      parentId: record.parentId,
      ...(petApi === undefined ? {} : { petApi }),
      defineTool<TSchema extends z.ZodTypeAny, TResult>(spec: ToolSpec<TSchema, TResult>): Tool<TSchema, TResult> {
        const tool = defineTool<TSchema, TResult>({ ...spec, pluginId: record.id });
        host.toolRegistry.register(tool, record.id);
        return tool;
      },
      on<T = unknown>(event: string, handler: EventHandler<T>): Disposable {
        const disposable = host.eventBus.on(event, handler, record.id);
        runtime.disposables.push(disposable);
        return disposable;
      },
      once<T = unknown>(event: string, handler: EventHandler<T>): Disposable {
        const disposable = host.eventBus.once(event, handler, record.id);
        runtime.disposables.push(disposable);
        return disposable;
      },
      emit<T = unknown>(event: string, payload: T): number {
        return host.eventBus.emit(event, payload);
      },
      effect(callback: () => DisposableLike | void): Disposable {
        const produced = callback();
        const disposable = produced === undefined ? { dispose: () => {} } : toDisposable(produced);
        runtime.disposables.push(disposable);
        return disposable;
      },
    };
  }

  private mustGet(id: string): PluginRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`插件不存在：${id}`);
    return record;
  }

  private recordError(id: string, error: unknown, phase: PluginErrorPhase): void {
    this.errorLog.push({ id, error: formatError(error), phase });
  }
}
