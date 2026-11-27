/**
 * ElectronBrowserEngine Cookie 双向同步回归（批次B 低危修复，2026-11-26）：
 *   人工交接登录后的新 Cookie 必须随 dispose 回写 cookies.json，否则下轮任务无登录态。
 * Electron 的 session/BrowserWindow 全部 mock，只验证导入→回写往返与容错。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 内存版 partition cookies：set/get 模拟 Electron Cookies API 子集 */
const partitionStores = new Map<string, Map<string, { name: string; value: string; domain: string; secure: boolean }>>();

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      if (!partitionStores.has(partition)) partitionStores.set(partition, new Map());
      const store = partitionStores.get(partition)!;
      return {
        cookies: {
          set: async (input: { url: string; name: string; value: string }) => {
            const host = new URL(input.url).host;
            store.set(`${host}|${input.name}`, {
              name: input.name,
              value: input.value,
              domain: host,
              secure: input.url.startsWith('https:'),
            });
          },
          get: async () => [...store.values()],
        },
      };
    },
  },
  BrowserWindow: class {
    static create(): never { throw new Error('测试不创建真实窗口'); }
  },
}));

import { ElectronBrowserEngine, ElectronDouyinSession } from './electron-browser-engine';
import type { BrowserProfile } from '@workbench/shared-protocol';

let dir = '';

function makeProfile(): BrowserProfile {
  return {
    profileId: 'prof-test',
    characterId: 'char_xiaojing',
    accountId: 'acct-1',
    profileDir: dir,
    status: 'ready',
    cookieCount: 0,
    isolatedFromUserDaily: true,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as BrowserProfile;
}

afterEach(() => {
  partitionStores.clear();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('ElectronBrowserEngine Cookie 双向同步', () => {
  it('启动导入 cookies.json，dispose 回写 partition 现状（含人工登录新增）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'browser-engine-cookie-'));
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ 'https://live.example.com': { old_token: 'seed-1' } }), 'utf8');

    const engine = new ElectronBrowserEngine({ profile: makeProfile() });
    await new Promise((resolve) => setTimeout(resolve, 20)); // applyStoredCookies 的 set 是异步 best-effort

    // 模拟人工交接登录：partition 里多出了新 Cookie
    const partition = partitionStores.get('persist:whale-char_xiaojing-acct-1')!;
    partition.set('live.example.com|session_id', { name: 'session_id', value: 'new-login', domain: 'live.example.com', secure: true });

    await engine.dispose();

    const written = JSON.parse(readFileSync(join(dir, 'cookies.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(written['https://live.example.com']?.['old_token']).toBe('seed-1'); // 旧 Cookie 保留
    expect(written['https://live.example.com']?.['session_id']).toBe('new-login'); // 新登录态回写
  });

  it('partition 为空也如实回写空对象；损坏的原 cookies.json 不影响启动', async () => {
    dir = mkdtempSync(join(tmpdir(), 'browser-engine-cookie-'));
    writeFileSync(join(dir, 'cookies.json'), '{bad json', 'utf8');

    const engine = new ElectronBrowserEngine({ profile: makeProfile() });
    await engine.dispose();

    const written = JSON.parse(readFileSync(join(dir, 'cookies.json'), 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({});
  });

  it('回写失败（目录只读/被删）只告警不炸 dispose', async () => {
    dir = mkdtempSync(join(tmpdir(), 'browser-engine-cookie-'));
    const engine = new ElectronBrowserEngine({ profile: makeProfile() });
    rmSync(dir, { recursive: true, force: true });
    dir = '';

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(engine.dispose()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Electron 驱动的受限评论端口（ADR-006）', () => {
  it('ElectronDouyinSession 与 CDP 会话实现同一个评论端口契约', () => {
    dir = mkdtempSync(join(tmpdir(), 'browser-engine-comment-'));
    const session = new ElectronDouyinSession(makeProfile());
    expect(typeof session.readComments).toBe('function');
    expect(typeof session.postComment).toBe('function');
  });
});
