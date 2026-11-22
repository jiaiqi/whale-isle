/**
 * dsh 兼容适配器（T-M6-03）：把 deepseek-harness / dsh-plugin-yushe 形态的 Cordis 插件
 * 原样装载进本容器，不改 dsh 插件源码（ARCHITECTURE §3.3 铁律）。
 *
 * dsh 侧最小面：{ name, apply(ctx) }，ctx 提供 tool / on / effect 三个能力。
 * 适配映射：
 *   ctx.tool(name, handler) → 本容器 defineTool（schema 宽松为 record，policy 默认 ask，外来代码先审批）
 *   ctx.on(event, fn)       → 本容器事件总线（事件名透传，dsh 插件按 domain:event 自行命名）
 *   ctx.effect(fn)          → 本容器 effect（立即执行 fn，其返回清理器随 disable 执行）
 */
import { z } from 'zod';
import type { PluginHost } from './plugin-host';
import type { PluginSetup } from './plugin-host';
import type { PluginExtension, PluginManifestInput, PluginPermission, PolicyLevel } from './manifest';

/** dsh 工具处理函数：参数为宽松对象（dsh 侧无 manifest 级 schema 契约） */
export type DshToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** dsh 插件可见的 Context 最小面（Cordis 子集，结构化匹配即可装载真实 dsh 插件） */
export interface DshContext {
  tool(name: string, handler: DshToolHandler): void;
  on(event: string, handler: (payload: unknown) => void): void;
  /** Cordis 语义：立即执行，返回的清理函数在 disable 时调用 */
  effect(callback: () => void | (() => void)): void;
}

/** 待适配的 dsh 插件形态 */
export interface DshLikePlugin {
  /** dsh 插件名（可为 @scope/名字 或下划线写法，适配时规范化为 id） */
  name: string;
  apply(ctx: DshContext): void;
  description?: string;
  version?: string;
}

export interface AdaptDshOptions {
  /** 覆盖展示图标（lucide 名，默认 puzzle） */
  icon?: string;
  /** 覆盖扩展点声明（默认 ['tool']） */
  extensions?: PluginExtension[];
  /** 覆盖权限声明（默认空） */
  permissions?: PluginPermission[];
  /** dsh 工具权限（默认 ask：外来插件默认走审批，deny/allow 由宿主显式提升） */
  policy?: PolicyLevel;
}

/** 适配产物：可直接 host.register(manifest, setup) */
export interface AdaptedDshPlugin {
  /** 规范化后的插件 id（用于 host.enable/disable 寻址） */
  id: string;
  manifest: PluginManifestInput;
  setup: PluginSetup;
}

/** dsh 插件名 → 合法插件 id（小写 kebab-case、字母开头；scope/下划线/点号统一转连字符） */
export function normalizePluginId(rawName: string): string {
  const slug = rawName
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/_.\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return 'dsh-plugin';
  return /^[a-z]/.test(slug) ? slug : `dsh-${slug}`;
}

/** 把 dsh 插件形态适配为本容器的 manifest + setup（不执行插件） */
export function adaptDshPlugin(dsh: DshLikePlugin, options: AdaptDshOptions = {}): AdaptedDshPlugin {
  const id = normalizePluginId(dsh.name);
  const manifest: PluginManifestInput = {
    id,
    name: dsh.name,
    version: dsh.version ?? '0.0.0',
    description: dsh.description ?? `dsh 兼容插件：${dsh.name}`,
    icon: options.icon ?? 'puzzle',
    extensions: options.extensions ?? ['tool'],
    permissions: options.permissions ?? [],
    dshCompatible: true,
  };
  const policy: PolicyLevel = options.policy ?? 'ask';
  const setup: PluginSetup = (ctx) => {
    dsh.apply({
      tool(name, handler) {
        ctx.defineTool({
          name,
          description: `[dsh] ${name}`,
          schema: z.record(z.string(), z.unknown()).default({}),
          policy,
          execute: (args) => handler(args),
        });
      },
      on(event, handler) {
        ctx.on(event, handler);
      },
      effect(callback) {
        ctx.effect(callback);
      },
    });
  };
  return { id, manifest, setup };
}

/** 便捷装载：适配 + register 一步完成，返回适配产物（含规范化 id） */
export function registerDshPlugin(host: PluginHost, dsh: DshLikePlugin, options: AdaptDshOptions = {}): AdaptedDshPlugin {
  const adapted = adaptDshPlugin(dsh, options);
  host.register(adapted.manifest, adapted.setup);
  return adapted;
}
