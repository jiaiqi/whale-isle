/**
 * 外部插件生产链路（T-M6-31 切片一）：把 plugin-kit 从「库」接到宿主进程。
 *
 * 发现规则（唯一入口，禁止绕过）：
 *   <userData>/plugins/<id>/manifest.json  —— 清单，必须过 PluginManifestSchema，且 id === 目录名
 *   <userData>/plugins/<id>/index.mjs      —— dsh 形态 ESM 模块：export default { name, apply(ctx) }
 *
 * 安全边界（如实声明）：
 *   - 插件是用户本机放置的可信代码；一旦 import 就运行在 main 进程，Policy **不是 JS 沙箱**。
 *   - 硬拒：manifest 声明 vault://*（密钥单咽喉）或 shell://*（审批 UI 未接线）→ 不装载。
 *   - 工具策略：allow 直接执行；ask 必须先经 plugin:approve（本次会话内授权）；deny 永拒。
 *   - 崩溃隔离：setup 抛错由 PluginHost 回滚；tool invoke 异常统一 {ok:false}；错误写入 errors。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ipcMain, type WebContents } from 'electron';
import {
  adaptDshPlugin,
  PluginHost,
  parsePluginManifest,
  type PluginError,
  type PluginManifest,
} from '@workbench/plugin-kit';
import type { ToolResult, Tool } from '@workbench/plugin-kit';

export interface PluginViewEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  tools: string[];
  error?: string;
}

export interface PluginToolView {
  name: string;
  pluginId: string;
  policy: 'allow' | 'ask' | 'deny';
  description: string;
}

export interface PluginHostHandle {
  list(): Promise<PluginViewEntry[]>;
  tools(): PluginToolView[];
  invoke(name: string, args: unknown): Promise<ToolResult>;
  approve(name: string): { ok: boolean; error?: string };
  errors(): PluginError[];
  clearErrors(): void;
  emit(event: string, payload: unknown): void;
  setTargets(targets: WebContents[]): void;
  stopAll(): void;
}

interface Discovery {
  id: string;
  manifest: PluginManifest;
  modulePath: string;
}

const SETTINGS_FILE = 'plugin-settings.json';
const MODULE_FILE = 'index.mjs';

/** 路径边界：realpath 必须在 pluginsRoot 内，挡住符号链接逃逸 */
function isInside(root: string, candidate: string): boolean {
  const realRoot = resolve(realpathSync(root));
  const realCandidate = resolve(realpathSync(candidate));
  return realCandidate.startsWith(realRoot + sep);
}

export function createPluginHost(options: { userDataDir: string; windows: () => WebContents[] }): PluginHostHandle {
  const pluginsRoot = join(options.userDataDir, 'plugins');
  const settingsPath = join(options.userDataDir, SETTINGS_FILE);
  mkdirSync(pluginsRoot, { recursive: true });

  const host = new PluginHost();
  const windows: WebContents[] = [];
  const approvedTools = new Set<string>();
  const failures = new Map<string, string>();
  const discoveries = new Map<string, Discovery>();
  const settings = readSettings();

  function readSettings(): Record<string, boolean> {
    try {
      if (!existsSync(settingsPath)) return {};
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  function saveSettings(): void {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  /** 扫描目录：清单 Zod 校验 + id 与目录名一致 + 权限硬拒，返回可装载项 */
  function discover(): Discovery[] {
    const found: Discovery[] = [];
    for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(pluginsRoot, entry.name);
      const manifestPath = join(dir, 'manifest.json');
      const modulePath = join(dir, MODULE_FILE);
      if (!existsSync(manifestPath) || !existsSync(modulePath)) continue;
      if (!isInside(pluginsRoot, dir)) {
        failures.set(entry.name, '插件目录符号链接越界');
        continue;
      }
      try {
        const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
        if (manifest.id !== entry.name) {
          failures.set(entry.name, `清单 id=${manifest.id} 与目录名 ${entry.name} 不一致`);
          continue;
        }
        const forbidden = manifest.permissions.filter((p) => p.resource.startsWith('vault://') || p.resource.startsWith('shell://'));
        if (forbidden.length > 0) {
          failures.set(entry.name, `权限未获准：${forbidden.map((p) => p.resource).join(', ')}（密钥硬拒 / 命令审批未接线）`);
          continue;
        }
        discoveries.set(manifest.id, { id: manifest.id, manifest, modulePath });
        found.push(discoveries.get(manifest.id)!);
      } catch (error) {
        failures.set(entry.name, `清单非法：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return found;
  }

  /** 装载单个插件：import ESM 模块 → dsh 适配 → PluginHost.register（setup 崩溃被隔离） */
  async function activate(item: Discovery): Promise<void> {
    if (host.isEnabled(item.id)) return;
    try {
      // 查询参数破缓存：禁用→启用之间改了 index.mjs 也能生效
      const moduleUrl = `${pathToFileURL(item.modulePath).href}?v=${Date.now()}`;
      const loaded = (await import(moduleUrl)) as { default?: unknown; plugin?: unknown };
      const candidate = (loaded.default ?? loaded.plugin) as { name?: string; apply?: unknown } | undefined;
      if (candidate === null || typeof candidate !== 'object' || typeof candidate.apply !== 'function') {
        throw new Error(`${MODULE_FILE} 必须 export default { name, apply(ctx) }`);
      }
      const adapted = adaptDshPlugin(candidate as { name: string; apply(ctx: never): void }, {
        icon: item.manifest.icon,
        extensions: [...item.manifest.extensions],
        permissions: [...item.manifest.permissions],
      });
      // 清单 id 是宿主寻址的唯一事实源；dsh 模块自带 name 可能含 scope/下划线，不得覆盖目录 id
      host.register({ ...adapted.manifest, id: item.id }, adapted.setup);
      failures.delete(item.id);
    } catch (error) {
      failures.set(item.id, `装载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function broadcast(event: string, payload: unknown): void {
    for (const wc of windows) {
      if (!wc.isDestroyed()) wc.send('plugin:event', { event, payload });
    }
  }

  // 插件总线事件 → 渲染层（只观察，不回写插件状态）
  host.on('*', (payload) => broadcast('bus', payload));

  function view(): PluginViewEntry[] {
    return [...discoveries.values()].map((item) => ({
      id: item.id,
      name: item.manifest.name,
      version: item.manifest.version,
      description: item.manifest.description,
      enabled: host.isEnabled(item.id),
      tools: host.tools.list(item.id).map((tool: Tool) => tool.name),
      ...(failures.has(item.id) ? { error: failures.get(item.id) } : {}),
    }));
  }

  ipcMain.handle('plugin:list', async () => {
    await Promise.all(discover().filter((item) => settings[item.id] === true).map(activate));
    return view();
  });
  ipcMain.handle('plugin:toggle', async (_e, id: string, enabled: boolean) => {
    if (!discoveries.has(id) && discover().every((item) => item.id !== id)) {
      return { ok: false, error: `插件不存在：${id}` };
    }
    const item = discoveries.get(id)!;
    if (enabled) {
      await activate(item);
      if (!host.isEnabled(id)) return { ok: false, error: failures.get(id) ?? '启用失败' };
    } else {
      host.disable(id);
      approvedTools.clear();
    }
    settings[id] = enabled;
    saveSettings();
    broadcast('toggle', { id, enabled });
    return { ok: true };
  });
  ipcMain.handle('plugin:tools', () => host.tools.list().map((tool: Tool) => ({
    name: tool.name, pluginId: tool.pluginId, policy: tool.policy, description: tool.description,
  })));
  ipcMain.handle('plugin:invoke', async (_e, name: string, args: unknown) => {
    const tool = host.tools.get(name);
    if (!tool) return { ok: false, error: `未知工具：${name}` } satisfies ToolResult;
    if (name.startsWith('vault:') || name.includes('vault://')) {
      return { ok: false, error: 'vault://* 是密钥单咽喉，插件工具硬拒' } satisfies ToolResult;
    }
    if (tool.policy === 'deny') return { ok: false, error: `工具被策略拒绝：${name}` } satisfies ToolResult;
    if (tool.policy === 'ask' && !approvedTools.has(name)) {
      return { ok: false, error: `APPROVAL_REQUIRED: ${name}` } satisfies ToolResult;
    }
    return host.invokeTool(name, args);
  });
  ipcMain.handle('plugin:approve', (_e, name: string) => {
    const tool = host.tools.get(name);
    if (!tool) return { ok: false, error: `未知工具：${name}` };
    if (tool.policy !== 'ask') return { ok: true };
    approvedTools.add(name);
    broadcast('approve', { name });
    return { ok: true };
  });
  ipcMain.handle('plugin:errors', () => [...host.errors, ...[...failures].map(([id, error]) => ({ id, error, phase: 'enable' as const }))]);
  ipcMain.handle('plugin:clear-errors', () => { host.clearErrors(); failures.clear(); });

  discover();
  return {
    list: async () => {
      await Promise.all(discover().filter((item) => settings[item.id] === true).map(activate));
      return view();
    },
    tools: () => host.tools.list().map((tool: Tool) => ({
      name: tool.name, pluginId: tool.pluginId, policy: tool.policy, description: tool.description,
    })),
    invoke: (name, args) => host.invokeTool(name, args),
    approve: (name) => {
      const tool = host.tools.get(name);
      if (!tool) return { ok: false, error: `未知工具：${name}` };
      approvedTools.add(name);
      return { ok: true };
    },
    errors: () => [
      ...host.errors,
      ...[...failures].map(([id, error]) => ({ id, error, phase: 'enable' as const })),
    ],
    clearErrors: () => host.clearErrors(),
    emit: (event, payload) => host.emit(event, payload),
    setTargets(targets) { windows.length = 0; windows.push(...targets); },
    stopAll() {
      for (const item of discoveries.values()) {
        if (host.get(item.id)?.enabled === true) host.disable(item.id);
      }
    },
  };
}
