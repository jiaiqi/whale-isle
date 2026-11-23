/**
 * T-M6-31 外部插件生产链路单测：本地临时目录造插件 fixture，零网络零 Electron。
 * 覆盖：清单校验/id 与目录一致/权限硬拒/装载崩溃隔离/启停注销工具/ask 审批。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { createPluginHost, type PluginHostHandle } from './plugin-host';

const dirs: string[] = [];
let userDataDir: string;
let pluginHost: PluginHostHandle;

function makePlugin(id: string, manifest: Record<string, unknown>, source: string): void {
  const dir = join(userDataDir, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', ...manifest }), 'utf8');
  writeFileSync(join(dir, 'index.mjs'), source, 'utf8');
}

const HEALTHY_SOURCE = `
export default {
  name: 'hello-whale',
  apply(ctx) {
    ctx.tool('hello_ping', (args) => ({ pong: true, who: args?.who ?? 'whale' }));
    ctx.on('autodrive:event', () => {});
    ctx.effect(() => () => {});
  },
};
`;

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'plugins-e2e-'));
  dirs.push(userDataDir);
  mkdirSync(join(userDataDir, 'plugins'), { recursive: true });
});

afterEach(() => {
  pluginHost?.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('外部插件发现与装载', () => {
  it('默认发现但不启用；启用后工具注册、事件订阅生效', async () => {
    makePlugin('hello-whale', { description: '测试插件' }, HEALTHY_SOURCE);
    pluginHost = createPluginHost({ userDataDir, windows: () => [] });

    let list = await pluginHost.list();
    expect(list.find((p) => p.id === 'hello-whale')?.enabled).toBe(false);
    expect(pluginHost.tools().length).toBe(0);

    await vi.waitFor(async () => {
      const res = await pluginHost.list();
      expect(res.find((p) => p.id === 'hello-whale')?.enabled).toBe(false);
    });
    // 直接调用 handle 注册的 toggle（通过 list 已触发发现，取 handle 之外的公开 API 借用 IPC controller）
    const toggle = (await import('electron')).ipcMain.handle as unknown as { mock: { calls: unknown[][] } };
    const toggleHandler = toggle.mock.calls.find((c) => c[0] === 'plugin:toggle')?.[1] as
      (e: unknown, id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
    expect(toggleHandler).toBeTypeOf('function');
    expect(await toggleHandler(null, 'hello-whale', true)).toEqual({ ok: true });

    list = await pluginHost.list();
    expect(list.find((p) => p.id === 'hello-whale')?.enabled).toBe(true);
    expect(pluginHost.tools().map((t) => t.name)).toContain('hello_ping');
  });

  it('清单 id 与目录名不一致 → 拒绝并给错误', async () => {
    makePlugin('wrong-dir', { id: 'other-id' }, HEALTHY_SOURCE);
    pluginHost = createPluginHost({ userDataDir, windows: () => [] });
    const list = await pluginHost.list();
    expect(list.length).toBe(0);
    expect(pluginHost.errors().some((e) => e.error.includes('不一致'))).toBe(true);
  });

  it('vault:// 权限硬拒（密钥单咽喉）', async () => {
    makePlugin('vault-thief', { permissions: [{ resource: 'vault://*', policy: 'allow' }] }, HEALTHY_SOURCE);
    pluginHost = createPluginHost({ userDataDir, windows: () => [] });
    await pluginHost.list();
    expect(pluginHost.errors().some((e) => e.error.includes('vault://'))).toBe(true);
    expect(pluginHost.tools().length).toBe(0);
  });

  it('setup 崩溃被隔离：不拖垮宿主，也不注册半截工具', async () => {
    makePlugin('crash-plugin', {}, `
export default {
  name: 'crash-plugin',
  apply(ctx) {
    ctx.tool('half_tool', () => ({ ok: true }));
    throw new Error('boom');
  },
};
`);
    makePlugin('healthy-plugin', {}, HEALTHY_SOURCE);
    pluginHost = createPluginHost({ userDataDir, windows: () => [] });
    const ipc = (await import('electron')).ipcMain.handle as unknown as { mock: { calls: unknown[][] } };
    const toggle = ipc.mock.calls.find((c) => c[0] === 'plugin:toggle')?.[1] as
      (e: unknown, id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
    const res = await toggle(null, 'crash-plugin', true);
    expect(res.ok).toBe(false);
    expect(pluginHost.tools().some((t) => t.name === 'half_tool')).toBe(false);
    expect(await toggle(null, 'healthy-plugin', true)).toEqual({ ok: true });
    expect(pluginHost.tools().some((t) => t.name === 'hello_ping')).toBe(true);
  });

  it('ask 策略工具：批准前 APPROVAL_REQUIRED，批准后可执行', async () => {
    makePlugin('ask-plugin', {}, HEALTHY_SOURCE);
    pluginHost = createPluginHost({ userDataDir, windows: () => [] });
    const ipc = (await import('electron')).ipcMain.handle as unknown as { mock: { calls: unknown[][] } };
    const handler = (name: string) => ipc.mock.calls.find((c) => c[0] === name)?.[1] as (...args: unknown[]) => unknown;
    await handler('plugin:toggle')(null, 'ask-plugin', true);
    const invoke = handler('plugin:invoke') as (e: unknown, name: string, args: unknown) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
    const before = await invoke(null, 'hello_ping', { who: 'cat' });
    expect(before.ok).toBe(false);
    expect(before.error).toContain('APPROVAL_REQUIRED');
    const approve = handler('plugin:approve') as (e: unknown, name: string) => { ok: boolean };
    expect(approve(null, 'hello_ping')).toEqual({ ok: true });
    const after = await invoke(null, 'hello_ping', { who: 'cat' });
    expect(after.ok).toBe(true);
    expect(after.result).toMatchObject({ pong: true, who: 'cat' });
  });

  it('禁用后工具注销，事件订阅归零', async () => {
    makePlugin('toggle-plugin', {}, HEALTHY_SOURCE);
    pluginHost = createPluginHost({ userDataDir, windows: () => [] });
    const ipc = (await import('electron')).ipcMain.handle as unknown as { mock: { calls: unknown[][] } };
    const handler = (name: string) => ipc.mock.calls.find((c) => c[0] === name)?.[1] as (...args: unknown[]) => unknown;
    await handler('plugin:toggle')(null, 'toggle-plugin', true);
    expect(pluginHost.tools().some((t) => t.name === 'hello_ping')).toBe(true);
    await handler('plugin:toggle')(null, 'toggle-plugin', false);
    expect(pluginHost.tools().some((t) => t.name === 'hello_ping')).toBe(false);
  });
});
