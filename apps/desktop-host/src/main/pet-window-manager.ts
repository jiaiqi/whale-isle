/**
 * 多桌宠窗口管理器（T-M6-38）。
 *
 * 单点事实：
 *   - agentId → BrowserWindow + 独立坐标/缩放/锁定（userData/pet-window-prefs.json）
 *   - 主进程事件按 agentId 定向投递；`*` 才允许广播
 *
 * 设计取舍：管理器本身不 import Electron，窗口创建/装载由宿主注入，便于确定性单测；
 * 默认主桌宠 `default` 的旧 PetDesktopPrefs 坐标可在首次启动时迁移。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PetWindowPreferencesFileSchema,
  type PetWindowPreferences,
  type PetWindowView,
} from '@workbench/shared-protocol';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ManagedPetWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  focus(): void;
  showInactive(): void;
  close(): void;
  setBounds(bounds: WindowBounds): void;
  getBounds(): WindowBounds;
  send(channel: string, payload: unknown): void;
  loadStage(hash: string): Promise<void>;
  onBoundsChanged(listener: (bounds: WindowBounds) => void): () => void;
  onClosed(listener: () => void): () => void;
}

export interface PetWindowCreateInput {
  agentId: string;
  characterId: string;
  bounds: WindowBounds;
  scale: number;
  locked: boolean;
}

export interface PetWindowManagerOptions {
  userDataDir: string;
  createWindow(input: PetWindowCreateInput): ManagedPetWindow;
  /** 主屏工作区；新窗口自动 +220px 时用于避免越界 */
  workArea?: () => WindowBounds;
  /** 首次无 pet-window-prefs.json 时，从旧 PetDesktopPrefs 继承 default 窗口位置/缩放 */
  legacyDefault?: () => { x: number; y: number; displayId: string; scale: number; characterId: string };
  onWindowsChanged?: (windows: PetWindowView[]) => void;
}

export interface PetWindowOpenResult {
  ok: boolean;
  window?: PetWindowView;
  error?: string;
}

const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 新开一列桌宠在上一只右侧 220px（≈半只桌宠），刻意保留错位以便一眼分清角色 */
const OFFSET_X = 220;
const BASE_WIDTH = 400;
const BASE_HEIGHT = 284;
const PREFS_FILE = 'pet-window-prefs.json';

interface Entry {
  preference: PetWindowPreferences;
  window: ManagedPetWindow;
  unsubscribe: Array<() => void>;
}

export class PetWindowManager {
  private readonly path: string;
  private entries = new Map<string, Entry>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PetWindowManagerOptions) {
    this.path = join(options.userDataDir, PREFS_FILE);
  }

  async open(agentId: string, characterId?: string): Promise<PetWindowOpenResult> {
    if (!AGENT_ID_RE.test(agentId)) {
      return { ok: false, error: `非法 agentId：${agentId}` };
    }
    const existing = this.entries.get(agentId);
    if (existing !== undefined && !existing.window.isDestroyed()) {
      if (characterId !== undefined && characterId !== existing.preference.characterId) {
        this.close(agentId);
      } else {
        existing.window.showInactive();
        const view = this.view(agentId);
        return view === null ? { ok: true } : { ok: true, window: view };
      }
    }

    const preference = this.preferenceFor(agentId, characterId);
    const bounds = this.boundsFor(preference);
    let window: ManagedPetWindow;
    try {
      window = this.options.createWindow({
        agentId,
        characterId: preference.characterId,
        bounds,
        scale: preference.scale,
        locked: preference.locked,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const entry: Entry = { preference: { ...preference, position: { x: bounds.x, y: bounds.y, displayId: preference.position.displayId }, visible: true }, window, unsubscribe: [] };
    this.entries.set(agentId, entry);
    entry.unsubscribe.push(window.onBoundsChanged((next) => {
      const current = this.entries.get(agentId);
      if (current === undefined || current.window !== window) return;
      current.preference.position = {
        x: Math.round(next.x),
        y: Math.round(next.y),
        displayId: current.preference.position.displayId,
      };
      this.scheduleSave();
      this.notify();
    }));
    entry.unsubscribe.push(window.onClosed(() => {
      const current = this.entries.get(agentId);
      if (current?.window !== window) return;
      this.entries.delete(agentId);
      current.preference.visible = false;
      for (const off of current.unsubscribe) off();
      this.scheduleSave();
      this.notify();
    }));

    // URL 用 hash 路由，保持未来可迁移到统一 router；hash 同时携带角色，避免全窗依赖全局当前角色
    const hash = `/pet-stage?agentId=${encodeURIComponent(agentId)}&characterId=${encodeURIComponent(entry.preference.characterId)}`;
    try {
      await window.loadStage(hash);
      window.showInactive();
    } catch (error) {
      this.entries.delete(agentId);
      try { window.close(); } catch { /* 已销毁 */ }
      this.notify();
      return { ok: false, error: `桌宠窗装载失败：${error instanceof Error ? error.message : String(error)}` };
    }
    this.scheduleSave();
    this.notify();
    const view = this.view(agentId);
    return view === null ? { ok: true } : { ok: true, window: view };
  }

  close(agentId: string): boolean {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return false;
    try {
      entry.window.close();
    } catch {
      /* close 事件仍会完成清理 */
    }
    if (!entry.window.isDestroyed()) {
      // 测试假窗可能不自动触发 closed：显式清理，真实 BrowserWindow 的 closed 回调幂等
      this.entries.delete(agentId);
      entry.preference.visible = false;
      for (const off of entry.unsubscribe) off();
      this.scheduleSave();
      this.notify();
    }
    return true;
  }

  list(): PetWindowView[] {
    return [...this.entries.keys()]
      .map((agentId) => this.view(agentId))
      .filter((view): view is PetWindowView => view !== null);
  }

  get(agentId: string): PetWindowView | null {
    return this.view(agentId);
  }

  prefs(agentId: string): PetWindowPreferences | null {
    const entry = this.entries.get(agentId);
    return entry === undefined ? null : { ...entry.preference, position: { ...entry.preference.position } };
  }

  /** 更新某只桌宠的缩放/锁定并持久化；缩放按底边中心锚点调整窗口，不改变角色。 */
  patch(agentId: string, update: { scale?: number; locked?: boolean; characterId?: string }): PetWindowPreferences | null {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return null;
    const previous = entry.preference;
    const next = {
      ...previous,
      ...(typeof update.scale === 'number' ? { scale: Math.min(2, Math.max(0.6, Math.round(update.scale * 10) / 10)) } : {}),
      ...(typeof update.locked === 'boolean' ? { locked: update.locked } : {}),
      ...(typeof update.characterId === 'string' && update.characterId !== '' ? { characterId: update.characterId } : {}),
    };
    entry.preference = next;
    if (next.scale !== previous.scale) {
      const old = entry.window.getBounds();
      const width = Math.round(BASE_WIDTH * next.scale);
      const height = Math.round(BASE_HEIGHT * next.scale);
      entry.window.setBounds({
        x: Math.round(old.x + (old.width - width) / 2),
        y: Math.round(old.y + old.height - height),
        width,
        height,
      });
      entry.preference.position.x = Math.round(old.x + (old.width - width) / 2);
      entry.preference.position.y = Math.round(old.y + old.height - height);
      entry.window.send('pet:scale-changed', next.scale);
    }
    this.scheduleSave();
    this.notify();
    entry.window.send('pet:window-prefs-changed', this.prefs(agentId));
    return this.prefs(agentId);
  }

  /** 兼容旧 PetDesktopPrefs 位置写入：立即更新 default/指定窗口坐标并落盘。 */
  setPosition(agentId: string, position: { x: number; y: number; displayId?: string }): PetWindowPreferences | null {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return null;
    const bounds = this.boundsFor({
      ...entry.preference,
      position: { x: position.x, y: position.y, displayId: position.displayId ?? entry.preference.position.displayId },
    });
    entry.preference.position = { x: bounds.x, y: bounds.y, displayId: position.displayId ?? entry.preference.position.displayId };
    entry.window.setBounds(bounds);
    this.flush();
    this.notify();
    return this.prefs(agentId);
  }

  /** 事件定向：'*' 广播，其余只发给目标 agentId；未知目标静默丢弃。 */
  send(channel: string, agentId: string, payload: unknown): void {
    if (agentId === '*') {
      for (const entry of this.entries.values()) {
        if (!entry.window.isDestroyed()) entry.window.send(channel, payload);
      }
      return;
    }
    const entry = this.entries.get(agentId);
    if (entry !== undefined && !entry.window.isDestroyed()) entry.window.send(channel, payload);
  }

  sendAgent(agentId: string, channel: string, payload: Record<string, unknown> = {}): void {
    this.send(channel, agentId, { agentId, ...payload });
  }

  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }

  closeAll(): void {
    for (const agentId of [...this.entries.keys()]) this.close(agentId);
    this.flush();
  }

  private preferenceFor(agentId: string, characterId?: string): PetWindowPreferences {
    const stored = this.read().windows[agentId];
    if (stored !== undefined) {
      return { ...stored, ...(characterId === undefined ? {} : { characterId }) };
    }
    const legacy = agentId === 'default' ? this.options.legacyDefault?.() : undefined;
    const previous = [...this.entries.values()].at(-1)?.window.getBounds();
    const position = legacy !== undefined
      ? { x: legacy.x, y: legacy.y, displayId: legacy.displayId }
      : previous !== undefined
        ? this.offsetFrom(previous)
        : { x: 80, y: 80, displayId: '' };
    return {
      agentId,
      characterId: characterId ?? legacy?.characterId ?? 'blue-whale-maid',
      position,
      scale: legacy?.scale ?? 1,
      locked: false,
      visible: true,
    };
  }

  private offsetFrom(previous: WindowBounds): { x: number; y: number; displayId: string } {
    const work = this.options.workArea?.();
    const width = Math.round(BASE_WIDTH * 1);
    const x = previous.x + OFFSET_X;
    if (work === undefined) return { x, y: previous.y, displayId: '' };
    if (x + width > work.x + work.width) {
      return { x: work.x + 16, y: Math.min(previous.y + 72, work.y + Math.max(0, work.height - BASE_HEIGHT)), displayId: '' };
    }
    return { x, y: previous.y, displayId: '' };
  }

  private boundsFor(preference: PetWindowPreferences): WindowBounds {
    const width = Math.round(BASE_WIDTH * preference.scale);
    const height = Math.round(BASE_HEIGHT * preference.scale);
    const work = this.options.workArea?.();
    let { x, y } = preference.position;
    if (work !== undefined) {
      x = Math.min(Math.max(x, work.x), work.x + Math.max(0, work.width - width));
      y = Math.min(Math.max(y, work.y), work.y + Math.max(0, work.height - height));
    }
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  private view(agentId: string): PetWindowView | null {
    const entry = this.entries.get(agentId);
    if (entry === undefined || entry.window.isDestroyed()) return null;
    const bounds = entry.window.getBounds();
    return {
      agentId,
      characterId: entry.preference.characterId,
      visible: entry.window.isVisible(),
      locked: entry.preference.locked,
      bounds: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
    };
  }

  private read(): ReturnType<typeof PetWindowPreferencesFileSchema.parse> {
    try {
      if (existsSync(this.path)) {
        const parsed = PetWindowPreferencesFileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
        if (parsed.success) return parsed.data;
      }
    } catch {
      /* 坏文件 → 空表，绝不崩主进程 */
    }
    return PetWindowPreferencesFileSchema.parse({});
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 200);
  }

  private save(): void {
    const windows: Record<string, PetWindowPreferences> = {};
    for (const [agentId, entry] of this.entries) {
      windows[agentId] = { ...entry.preference, position: { ...entry.preference.position } };
    }
    // 已关闭窗口的持久化坐标不能因保存而丢失：合并磁盘中的旧记录
    for (const [agentId, preference] of Object.entries(this.read().windows)) {
      if (windows[agentId] === undefined) windows[agentId] = preference;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, windows }, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }

  private notify(): void {
    this.options.onWindowsChanged?.(this.list());
  }
}
