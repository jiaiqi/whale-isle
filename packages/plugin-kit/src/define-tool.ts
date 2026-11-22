/**
 * defineTool + ToolRegistry：把「插件工具」标准化为工作台唯一工具形态。
 * dsh-plugin-yushe 的 defineTool 思想重写：zod schema 是参数的单一事实源，
 * policy 声明权限级别，execute 的任何异常都被包装成 {ok:false,error}——
 * 工具崩溃绝不冒泡拖垮事件总线或宿主进程（运行期安全锁 + 崩溃隔离）。
 */
import { z } from 'zod';
import { formatError } from './disposable';
import type { PolicyLevel } from './manifest';

/** 工具权限级别（与 manifest permissions 同一三态，避免两套权限词汇） */
export type ToolPolicy = PolicyLevel;

/** 工具执行上下文：由宿主注入；裸用 defineTool 时可传空实现 */
export interface ToolContext {
  /** 工具归属插件 id（审计/日志定位用） */
  readonly pluginId: string;
  /** 总线广播（宿主注入；工具可借此发布领域事件，不得绕过总线直接 IPC） */
  emit(event: string, payload: unknown): void;
}

/** 工具执行结果（判别联合：调用方必须处理 ok=false，不得假设一定成功） */
export type ToolResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string };

/** 工具声明（插件作者书写的形态） */
export interface ToolSpec<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  /** 工具名（全局唯一；建议 '<领域>_<动作>' 蛇形命名，如 farm_water_crops） */
  name: string;
  description: string;
  /** 参数契约：唯一事实源，外部参数先 safeParse 再进入 execute */
  schema: TSchema;
  /** 权限声明（默认 allow；外来 dsh 插件由 bridge 提升为 ask） */
  policy?: ToolPolicy;
  /** 业务实现：args 已通过 schema 校验，可直接信任类型 */
  execute(args: z.output<TSchema>, ctx: ToolContext): TResult | Promise<TResult>;
}

/** 标准化工具对象（LLM 编排器 / Shell / 其它插件同源调用） */
export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly pluginId: string;
  readonly policy: ToolPolicy;
  readonly schema: TSchema;
  /** 校验参数 → 执行；校验失败/execute 抛错一律返回 {ok:false}（崩溃隔离） */
  invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<TResult>>;
}

/** 把 zod 校验错误压成一行可读文案（'path: message; ...'） */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * 定义工具并返回标准化对象。
 * pluginId 由宿主上下文注入（独立使用时默认 'standalone'）。
 */
export function defineTool<TSchema extends z.ZodTypeAny, TResult>(
  spec: ToolSpec<TSchema, TResult> & { pluginId?: string },
): Tool<TSchema, TResult> {
  return {
    name: spec.name,
    description: spec.description,
    pluginId: spec.pluginId ?? 'standalone',
    policy: spec.policy ?? 'allow',
    schema: spec.schema,
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult<TResult>> {
      const parsed = spec.schema.safeParse(rawArgs);
      if (!parsed.success) {
        return { ok: false, error: `参数校验失败（${spec.name}）：${formatIssues(parsed.error)}` };
      }
      try {
        // 泛型 schema 的 safeParse 返回值在约束层面被擦成 unknown，此处按 Output 还原（已通过校验）
        const result = await spec.execute(parsed.data as z.output<TSchema>, ctx);
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: `工具执行失败（${spec.name}）：${formatError(error)}` };
      }
    },
  };
}

/**
 * 工具注册表：全局唯一工具名 → 工具 + 归属插件。
 * 重名直接抛错（禁止静默覆盖，防止插件互相踩踏）；按插件批量注销供 disable/回滚使用。
 */
export class ToolRegistry {
  private readonly entries = new Map<string, { tool: Tool; pluginId: string }>();

  /** 注册工具（pluginId 缺省用工具自带的归属，用于独立测试） */
  register(tool: Tool, pluginId: string = tool.pluginId): this {
    const existing = this.entries.get(tool.name);
    if (existing) {
      throw new Error(`工具重名：${tool.name}（已被插件 ${existing.pluginId} 注册）`);
    }
    this.entries.set(tool.name, { tool, pluginId });
    return this;
  }

  get(name: string): Tool | undefined {
    return this.entries.get(name)?.tool;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** 列出全部工具；传 pluginId 时只列该插件的工具 */
  list(pluginId?: string): Tool[] {
    const result: Tool[] = [];
    for (const entry of this.entries.values()) {
      if (pluginId === undefined || entry.pluginId === pluginId) result.push(entry.tool);
    }
    return result;
  }

  /** 注销单个工具，返回是否真的删除了 */
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  /** 批量注销某插件的全部工具（disable/崩溃回滚用），返回被注销的工具名 */
  unregisterByPlugin(pluginId: string): string[] {
    const removed: string[] = [];
    for (const [name, entry] of this.entries) {
      if (entry.pluginId !== pluginId) continue;
      this.entries.delete(name);
      removed.push(name);
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
