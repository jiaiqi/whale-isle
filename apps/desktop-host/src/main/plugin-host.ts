/**
 * 外部插件生产链路（V2-P2-02 进程隔离升级）：把 plugin-kit 与 Worker Isolate 沙箱接到宿主进程。
 *
 * 发现规则（唯一入口，禁止绕过）：
 *   <userData>/plugins/<id>/manifest.json  —— 清单，必须过 PluginManifestSchema，且 id === 目录名
 *   <userData>/plugins/<id>/index.mjs      —— dsh 形态 ESM 模块：export default { name, apply(ctx) }
 *
 * 安全边界（REQ-SEC-01 真实隔离）：
 *   - 退役主进程 `import(moduleUrl)`：所有第三方外部插件一律跑在剥离宿主机敏感 `process.env`
 *     且带 V8 堆限制、超时硬终止的独立 Worker Isolate（`IsolatedPluginRunner`）。
 *   - 硬拒：manifest 声明 `vault://*` 或 `shell://*` → 不装载；工具/Broker 调用经 `PolicyBroker` 校验与审计。
 *   - 工具策略：allow 直接执行；ask 必须先经 `plugin:approve`（本次会话内授权）；deny 永拒。
 *   - 崩溃/超时隔离：setup 或工具执行超时/抛错由沙箱与 PluginHost 回滚，绝不拖垮主进程。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import {
  IsolatedPluginRunner,
  PluginHost,
  PolicyBroker,
  parsePluginManifest,
  type PluginError,
  type PluginManifest,
  type PluginSetup,
  type Tool,
  type ToolResult,
} from '@workbench/plugin-kit';
import type { PluginSandboxStatus, PluginTrustLevel } from '@workbench/shared-protocol';

export interface PluginViewEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  tools: string[];
  isolated?: boolean;
  trustLevel?: PluginTrustLevel;
  sandboxStatus?: PluginSandboxStatus;
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

export function createPluginHost(options: {
  userDataDir: string;
  windows: () => WebContents[];
  /** 沙箱执行硬超时（ms），默认 5000ms */
  sandboxTimeoutMs?: number;
  /** T-M6-49：声明 pet:control 权限的插件可经 Broker 调用桌宠驱动口 */
  petApi?: {
    state(agentId: string): unknown;
    say(agentId: string, text: string, request: { scene: 'normal' | 'inner' | 'p0'; wake: boolean }): { ok: boolean; error?: string };
    action(agentId: string, actionState: string, durationMs: number): { ok: boolean; error?: string };
  };
}): PluginHostHandle {
  const pluginsRoot = join(options.userDataDir, 'plugins');
  const settingsPath = join(options.userDataDir, SETTINGS_FILE);
  mkdirSync(pluginsRoot, { recursive: true });

  const host = new PluginHost();
  const policyBroker = new PolicyBroker();
  const runners = new Map<string, IsolatedPluginRunner>();
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

  /** 在独立 Worker Isolate 沙箱内装载第三方插件，并向宿主注册 Broker 代理工具 */
  async function activate(item: Discovery): Promise<void> {
    if (host.isEnabled(item.id)) return;
    const timeoutMs = options.sandboxTimeoutMs ?? 5_000;
    const runner = new IsolatedPluginRunner({
      pluginId: item.id,
      modulePath: item.modulePath,
      manifest: item.manifest,
      setupTimeoutMs: timeoutMs,
      invokeTimeoutMs: timeoutMs,
      onEvent: (event, payload) => {
        host.emit(event, payload);
      },
      onBrokerCall: async (req) => {
        const check = policyBroker.evaluate({
          pluginId: req.pluginId,
          manifest: item.manifest,
          resource: req.capability,
          riskTier: req.method === 'state' ? 'P0_READ' : 'P2_REVERSIBLE_WRITE',
        });
        if (!check.allowed) throw new Error(`${check.reason}: ${req.capability}`);
        if (options.petApi === undefined) throw new Error('PET_API_UNAVAILABLE');
        const agentId = String(req.args[0] ?? 'char_xiaojing');
        if (req.method === 'state') return options.petApi.state(agentId);
        if (req.method === 'say') {
          const reqObj = (typeof req.args[2] === 'object' && req.args[2] !== null ? req.args[2] : {}) as {
            scene?: 'normal' | 'inner' | 'p0';
            wake?: boolean;
          };
          return options.petApi.say(agentId, String(req.args[1] ?? ''), {
            scene: reqObj.scene ?? 'normal',
            wake: reqObj.wake === true,
          });
        }
        return options.petApi.action(agentId, String(req.args[1] ?? 'idle'), Number(req.args[2] ?? 6000));
      },
    });

    try {
      const started = await runner.start();
      runners.set(item.id, runner);
      const setupProxy: PluginSetup = (ctx) => {
        for (const toolName of started.tools) {
          ctx.defineTool({
            name: toolName,
            description: `[isolated] ${toolName}`,
            schema: z.record(z.string(), z.unknown()).default({}),
            policy: 'ask',
            execute: async (args) => {
              const active = runners.get(item.id);
              if (active === undefined) throw new Error(`插件沙箱未运行：${item.id}`);
              const res = await active.invoke(toolName, args);
              if (!res.ok) throw new Error(res.error ?? 'PLUGIN_TOOL_ERROR');
              return res.result;
            },
          });
        }
        ctx.effect(() => () => {
          const active = runners.get(item.id);
          if (active !== undefined) {
            runners.delete(item.id);
            void active.stop();
          }
        });
      };

      if (host.get(item.id) === undefined) {
        host.register(
          {
            ...item.manifest,
            id: item.id,
            extensions: [...item.manifest.extensions],
            permissions: [...item.manifest.permissions],
            dshCompatible: true,
          },
          setupProxy,
        );
      } else {
        host.enable(item.id);
      }
      failures.delete(item.id);
    } catch (error) {
      runners.delete(item.id);
      await runner.stop();
      failures.set(item.id, `沙箱装载失败：${error instanceof Error ? error.message : String(error)}`);
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
    return [...discoveries.values()].map((item) => {
      const runnerHealth = runners.get(item.id)?.health();
      return {
        id: item.id,
        name: item.manifest.name,
        version: item.manifest.version,
        description: item.manifest.description,
        enabled: host.isEnabled(item.id),
        tools: host.tools.list(item.id).map((tool: Tool) => tool.name),
        isolated: true,
        trustLevel: 'third-party-isolated',
        sandboxStatus: runnerHealth?.status ?? 'idle',
        ...(failures.has(item.id) ? { error: failures.get(item.id) } : {}),
      };
    });
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
      policyBroker.revokePlugin(id);
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
    policyBroker.approve(tool.pluginId, name);
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
      policyBroker.approve(tool.pluginId, name);
      return { ok: true };
    },
    errors: () => [
      ...host.errors,
      ...[...failures].map(([id, error]) => ({ id, error, phase: 'enable' as const })),
    ],
    clearErrors: () => { host.clearErrors(); failures.clear(); },
    emit: (event, payload) => {
      host.emit(event, payload);
      for (const r of runners.values()) r.dispatchEvent(event, payload);
    },
    setTargets(targets) { windows.length = 0; windows.push(...targets); },
    stopAll() {
      for (const item of discoveries.values()) {
        if (host.get(item.id)?.enabled === true) host.disable(item.id);
      }
      for (const [id, runner] of runners.entries()) {
        runners.delete(id);
        void runner.stop();
      }
    },
  };
}
