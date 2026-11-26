/**
 * V2-P3-03b Electron 确定性浏览器引擎（REQ-AUTO-01 / REQ-SEC-02）：
 * - 用隐藏 BrowserWindow + 每角色/账号独立 partition 执行确定性 DOM 动作，不连接用户日常 Chrome Profile。
 * - 只允许 http/https；页面正文仅作为数据返回，绝不执行页面给出的指令。
 * - Cookie 双向同步：启动时从隔离 Profile 的 cookies.json 导入 Chromium partition，dispose 时把 partition 现状回写 cookies.json（人工交接登录的登录态因此跨任务存活）。不进 Git、不进导出。
 * - Playwright 引擎可在同一 BrowserEnginePort 下替换，本文件是当前无额外依赖的默认可执行引擎。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, session, type Session } from 'electron';
import type { BrowserEnginePort, BrowserPageSnapshot } from '@workbench/runtime-core';
import type { BrowserProfile } from '@workbench/shared-protocol';

const LOAD_TIMEOUT_MS = 20_000;

function partitionFor(profile: BrowserProfile): string {
  const safe = `${profile.characterId}-${profile.accountId}`.replace(/[^a-zA-Z0-9._-]/gu, '_');
  return `persist:whale-${safe}`;
}

function assertHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`只允许 http/https 导航，拒绝 ${url.protocol}`);
  }
  return url;
}

interface CookieStore {
  [origin: string]: { [key: string]: string };
}

export class ElectronBrowserEngine implements BrowserEnginePort {
  readonly kind = 'electron' as const;
  private readonly profile: BrowserProfile;
  private readonly partition: Session;
  private window: BrowserWindow | null = null;

  constructor(options: { profile: BrowserProfile; show?: boolean }) {
    this.profile = options.profile;
    this.partition = session.fromPartition(partitionFor(options.profile));
    this.applyStoredCookies();
  }

  async load(rawUrl: string): Promise<BrowserPageSnapshot> {
    const url = assertHttpUrl(rawUrl);
    const win = this.ensureWindow();
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('页面加载超时（20s）')), LOAD_TIMEOUT_MS);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
        if (!isMainFrame) return;
        clearTimeout(timer);
        reject(new Error(`页面加载失败 ${code}：${desc}`));
      });
    });
    void loaded.catch(() => undefined); // loadURL 自己失败时避免未处理拒绝
    // 用 race 保证 20s 超时真正生效：loadURL 自身卡住时也能收敛
    await Promise.race([win.loadURL(url.toString()), loaded]);
    await loaded;
    const page = await this.readPage();
    return page;
  }

  async click(selector: string): Promise<void> {
    const found = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if (typeof el.click === 'function') el.click();
        return true;
      })()
    `);
    if (!found) throw new Error(`未找到可点击元素：${selector}`);
  }

  async fill(selector: string, value: string): Promise<void> {
    const ok = await this.evaluate<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)});
        else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `);
    if (!ok) throw new Error(`未找到可填写元素：${selector}`);
  }

  async extract(): Promise<{ title: string; text: string }> {
    const page = await this.readPage();
    return { title: page.title, text: page.text };
  }

  async dispose(): Promise<void> {
    // 回写 Cookie 再关窗：人工交接登录后的新登录态必须落盘，否则下轮任务无登录态（单向导入缺陷修复）
    await this.persistCookies();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, target) => {
      try {
        assertHttpUrl(target);
      } catch {
        event.preventDefault();
      }
    });
    return this.window;
  }

  private async readPage(): Promise<BrowserPageSnapshot> {
    const payload = await this.evaluate<{ title: string; text: string; url: string }>(`
      (() => ({
        title: document.title || '',
        text: (document.body && document.body.innerText) ? document.body.innerText.slice(0, 200000) : '',
        url: location.href,
      }))()
    `);
    return payload;
  }

  private async evaluate<T>(script: string): Promise<T> {
    const win = this.ensureWindow();
    if (win.webContents.isLoading()) {
      await Promise.race([
        new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    return (await win.webContents.executeJavaScript(script, true)) as T;
  }

  /** 把隔离 Profile 里已有的 Cookie 单向导入 Chromium partition；损坏文件安全忽略 */
  private applyStoredCookies(): void {
    const file = join(this.profile.profileDir, 'cookies.json');
    if (!existsSync(file)) return;
    let store: CookieStore;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      store = parsed as CookieStore;
    } catch {
      return;
    }
    for (const [origin, cookies] of Object.entries(store)) {
      let url: URL;
      try {
        url = assertHttpUrl(origin);
      } catch {
        continue;
      }
      for (const [name, value] of Object.entries(cookies)) {
        void this.partition.cookies
          .set({ url: url.toString(), name, value, sameSite: 'lax' })
          .catch(() => undefined);
      }
    }
  }

  /**
   * 把 partition 当前 Cookie 全量回写隔离 Profile 的 cookies.json（与 applyStoredCookies 互逆）。
   * 原子写（tmp + rename）防半截文件；回写失败只告警不炸 dispose（清理路径不因此改变任务结论）。
   * 隐私边界不变：cookies.json 只在隔离 Profile 目录（userData 下），不进 Git、不进导出。
   */
  private async persistCookies(): Promise<void> {
    try {
      const all = await this.partition.cookies.get({});
      const store: CookieStore = {};
      for (const cookie of all) {
        const host = (cookie.domain ?? '').replace(/^\./, '');
        if (host === '') continue;
        const origin = `${cookie.secure === true ? 'https' : 'http'}://${host}`;
        (store[origin] ??= {})[cookie.name] = cookie.value;
      }
      const file = join(this.profile.profileDir, 'cookies.json');
      const tmpFile = `${file}.tmp`;
      writeFileSync(tmpFile, `${JSON.stringify(store, null, 1)}\n`, 'utf8');
      renameSync(tmpFile, file);
    } catch (error) {
      console.warn('[browser-engine] Cookie 回写失败：', error instanceof Error ? error.message : error);
    }
  }
}
