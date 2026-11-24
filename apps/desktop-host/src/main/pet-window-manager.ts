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
  hide(): void;
  setOpacity(opacity: number): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  /** T-M6-63：显示层级切换（level 由宿主按 macOS/Windows 平台注入） */
  setAlwaysOnTop(flag: boolean, level?: string): void;
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
  /** T-M6-48：两只桌宠窗口相撞（去抖后） */
  onCollision?: (hit: { a: PetWindowView; b: PetWindowView; ratio: number }) => void;
  /** 测试注入：平滑探出帧间隔等待 */
  sleep?: (ms: number) => Promise<void>;
  /** 平滑探出总时长与帧间隔（默认 240ms / 16ms） */
  undockDurationMs?: number;
  undockFrameMs?: number;
  /** T-M6-63：置顶层级名（macOS 'screen-saver' / Windows 11 'floating'），由宿主注入平台判断 */
  alwaysOnTopLevel?: () => string | undefined;
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
  private undocked = new Map<string, WindowBounds>();
  private undockSeq = new Map<string, number>();
  private peeking = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** T-M6-63：全局显示层级 + AI 活跃态（follow-ai 时据此决定置顶） */
  private windowLayer: 'always' | 'follow-ai' | 'normal' = 'always';
  private aiActive = false;
  /** T-M6-64：贴边记忆（agent → 边缘）与「因干活自动探出」的原边缘 */
  private dockedEdges = new Map<string, 'left' | 'right'>();
  private autoUndockedFrom = new Map<string, 'left' | 'right'>();
  /** 互撞去抖：`a|b` → 上次播报时间 */
  private readonly lastCollisionAt = new Map<string, number>();

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
    window.setAlwaysOnTop(this.shouldFloat(), this.options.alwaysOnTopLevel?.());
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
      this.checkCollision(agentId);
    }));
    entry.unsubscribe.push(window.onClosed(() => {
      const current = this.entries.get(agentId);
      if (current?.window !== window) return;
      this.entries.delete(agentId);
      current.preference.visible = false;
      this.undocked.delete(agentId);
      this.dockedEdges.delete(agentId);
      this.autoUndockedFrom.delete(agentId);
      this.undockSeq.delete(agentId);
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

  /** 两两相交的可见窗口对（T-M6-48 互撞）：重叠面积 > 较小窗口面积 12% 才算撞上。 */
  collisions(): Array<{ a: PetWindowView; b: PetWindowView; ratio: number }> {
    const views = this.list().filter((view) => view.visible);
    const hits: Array<{ a: PetWindowView; b: PetWindowView; ratio: number }> = [];
    for (let i = 0; i < views.length; i += 1) {
      for (let j = i + 1; j < views.length; j += 1) {
        const a = views[i]!;
        const b = views[j]!;
        const width = Math.max(0, Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - Math.max(a.bounds.x, b.bounds.x));
        const height = Math.max(0, Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - Math.max(a.bounds.y, b.bounds.y));
        const area = Math.max(1, Math.min(a.bounds.width * a.bounds.height, b.bounds.width * b.bounds.height));
        const ratio = (width * height) / area;
        if (ratio > 0.12) hits.push({ a, b, ratio });
      }
    }
    return hits;
  }

  /** 集合：按给定顺序在屏幕底部排排站（宽度按各自 scale，间隔 12px）。 */
  assemble(agentIds: string[], screenBounds?: WindowBounds): PetWindowView[] {
    const entries = agentIds
      .map((agentId) => ({ agentId, entry: this.entries.get(agentId) }))
      .filter((pair): pair is { agentId: string; entry: Entry } => pair.entry !== undefined);
    if (entries.length === 0) return [];
    const workArea = screenBounds ?? this.options.workArea?.() ?? { x: 0, y: 0, width: 1440, height: 900 };
    const gap = 12;
    const totalWidth = entries.reduce((sum, pair) => sum + pair.entry.preference.scale * BASE_WIDTH, 0) + gap * (entries.length - 1);
    let cursor = workArea.x + Math.max(0, Math.round((workArea.width - totalWidth) / 2));
    const placed: PetWindowView[] = [];
    for (const { agentId, entry } of entries) {
      const width = entry.preference.scale * BASE_WIDTH;
      const x = Math.round(cursor);
      const y = Math.round(workArea.y + workArea.height - entry.preference.scale * BASE_HEIGHT - 8);
      entry.window.setBounds({ x, y, width: Math.round(width), height: Math.round(entry.preference.scale * BASE_HEIGHT) });
      entry.preference.position = { x, y, displayId: entry.preference.position.displayId };
      cursor += width + gap;
      const view = this.view(agentId);
      if (view !== null) placed.push(view);
    }
    this.scheduleSave();
    this.notify();
    return placed;
  }

  /** 解散：关掉除 keep 之外的所有桌宠窗。 */
  dismissAll(keep: string | null = 'default'): number {
    let closed = 0;
    for (const agentId of [...this.entries.keys()]) {
      if (agentId === keep) continue;
      if (this.close(agentId)) closed += 1;
    }
    return closed;
  }

  /** 窗口移动后检查是否撞到别的桌宠；同一对 2 秒内只报一次。 */
  private checkCollision(agentId: string): void {
    const callback = this.options.onCollision;
    if (callback === undefined) return;
    for (const hit of this.collisions()) {
      if (hit.a.agentId !== agentId && hit.b.agentId !== agentId) continue;
      const key = [hit.a.agentId, hit.b.agentId].sort().join('|');
      const last = this.lastCollisionAt.get(key) ?? 0;
      if (Date.now() - last < 2_000) continue;
      this.lastCollisionAt.set(key, Date.now());
      callback(hit);
    }
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
      // 缩放按底边中心锚点调整后必须重新夹紧到工作区：持久化 scale 被强制归 1 时，
      // 旧 anchor 可能把窗口留在离屏幕右缘 60px 处（desktop E2E 真机复现）。
      const candidate = this.boundsFor({
        ...next,
        position: {
          x: Math.round(old.x + (old.width - Math.round(BASE_WIDTH * next.scale)) / 2),
          y: Math.round(old.y + old.height - Math.round(BASE_HEIGHT * next.scale)),
          displayId: previous.position.displayId,
        },
      });
      entry.window.setBounds(candidate);
      entry.preference.position.x = candidate.x;
      entry.preference.position.y = candidate.y;
      entry.window.send('pet:scale-changed', next.scale);
    }
    this.scheduleSave();
    this.notify();
    entry.window.send('pet:window-prefs-changed', this.prefs(agentId));
    return this.prefs(agentId);
  }

  /** 贴边：只露 45%，保存原位置供探出恢复。 */
  dock(agentId: string, edge: 'left' | 'right'): PetWindowView | null {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return null;
    if (this.dockedEdges.get(agentId) === edge) return this.view(agentId);
    const current = entry.window.getBounds();
    if (!this.undocked.has(agentId)) this.undocked.set(agentId, current);
    const work = this.options.workArea?.() ?? { x: current.x, y: current.y, width: current.width, height: current.height };
    const visible = Math.round(current.width * 0.45);
    entry.window.setBounds({
      x: edge === 'left' ? work.x - current.width + visible : work.x + work.width - visible,
      y: current.y,
      width: current.width,
      height: current.height,
    });
    this.dockedEdges.set(agentId, edge);
    return this.view(agentId);
  }

  /** 当前是否贴边（T-M6-64：工作事件自动探出/收回用）。 */
  isDocked(agentId: string): 'left' | 'right' | null {
    return this.dockedEdges.get(agentId) ?? null;
  }

  /**
   * 干活自动探出（T-M6-64）：仅当确实贴边时记录原边缘并平滑探出。
   * 用户手动拖离后 `clearDock` 会清掉这条记忆，不会再被自动收回。
   */
  async requestAutoUndock(agentId: string): Promise<boolean> {
    const edge = this.dockedEdges.get(agentId);
    if (edge === undefined) return false;
    if (!this.autoUndockedFrom.has(agentId)) this.autoUndockedFrom.set(agentId, edge);
    await this.undock(agentId);
    this.dockedEdges.delete(agentId);
    return true;
  }

  /** 该 agent 是否因干活被自动探出（且用户未手动拖离）。 */
  autoUndockedEdge(agentId: string): 'left' | 'right' | null {
    return this.autoUndockedFrom.get(agentId) ?? null;
  }

  /** 活干完收回：恢复自动探出前的边缘；已销毁或用户拖离则不做事。 */
  redockAuto(agentId: string): boolean {
    const edge = this.autoUndockedFrom.get(agentId);
    if (edge === undefined) return false;
    this.autoUndockedFrom.delete(agentId);
    if (this.entries.get(agentId) === undefined) return false;
    return this.dock(agentId, edge) !== null;
  }

  /** 鼠标靠近/工作事件：从贴边探出到原位置。 */
  async undock(agentId: string): Promise<PetWindowView | null> {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return null;
    const saved = this.undocked.get(agentId);
    if (saved === undefined) return this.view(agentId);
    const seq = (this.undockSeq.get(agentId) ?? 0) + 1;
    this.undockSeq.set(agentId, seq);
    const start = entry.window.getBounds();
    const durationMs = Math.max(32, this.options.undockDurationMs ?? 240);
    const frameMs = Math.max(1, this.options.undockFrameMs ?? 16);
    const steps = Math.max(1, Math.round(durationMs / frameMs));
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let step = 1; step <= steps; step += 1) {
      if (this.undockSeq.get(agentId) !== seq || entry.window.isDestroyed()) return this.view(agentId);
      const t = step / steps;
      const eased = t * t * (3 - 2 * t);
      entry.window.setBounds({
        x: Math.round(start.x + (saved.x - start.x) * eased),
        y: Math.round(start.y + (saved.y - start.y) * eased),
        width: saved.width,
        height: saved.height,
      });
      if (step < steps) await sleep(frameMs);
    }
    if (this.undockSeq.get(agentId) === seq) {
      this.undocked.delete(agentId);
      this.undockSeq.delete(agentId);
      this.dockedEdges.delete(agentId);
    }
    return this.view(agentId);
  }

  /**
   * 三档显示层级（T-M6-63）：always 全部置顶；normal 全部取消；follow-ai 仅在 AI 活跃时置顶。
   * 新开窗口也会在 open() 里套用当前层级。
   */
  applyWindowLayer(layer: 'always' | 'follow-ai' | 'normal', aiActive: boolean): void {
    this.windowLayer = layer;
    this.aiActive = aiActive;
    const float = this.shouldFloat();
    const level = this.options.alwaysOnTopLevel?.();
    for (const entry of this.entries.values()) {
      if (!entry.window.isDestroyed()) entry.window.setAlwaysOnTop(float, level);
    }
  }

  /** 当前应有的置顶状态（follow-ai 由 aiActive 驱动）。 */
  currentWindowLayer(): { layer: 'always' | 'follow-ai' | 'normal'; aiActive: boolean; floating: boolean } {
    return { layer: this.windowLayer, aiActive: this.aiActive, floating: this.shouldFloat() };
  }

  private shouldFloat(): boolean {
    return this.windowLayer === 'always' || (this.windowLayer === 'follow-ai' && this.aiActive);
  }

  /** 主进程全局 Alt：只对目标窗口降透明+穿透，其余恢复。 */
  applyPeekTargets(agentIds: readonly string[]): void {
    const desired = new Set(agentIds);
    for (const [agentId, entry] of this.entries) {
      if (desired.has(agentId)) {
        entry.window.setOpacity(0.35);
        entry.window.setIgnoreMouseEvents(true, { forward: true });
        this.peeking.add(agentId);
      } else if (this.peeking.delete(agentId)) {
        entry.window.setOpacity(1);
        entry.window.setIgnoreMouseEvents(false);
      }
    }
  }

  /** 拖离边缘：只清除贴边/自动收回记忆，绝不把窗口弹回旧位置。 */
  clearDock(agentId: string): boolean {
    this.undockSeq.set(agentId, (this.undockSeq.get(agentId) ?? 0) + 1);
    this.dockedEdges.delete(agentId);
    this.autoUndockedFrom.delete(agentId);
    return this.undocked.delete(agentId);
  }

  setHidden(agentId: string, hidden: boolean): boolean {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return false;
    if (hidden) entry.window.hide(); else entry.window.showInactive();
    this.notify();
    return true;
  }

  hideAll(): void {
    for (const entry of this.entries.values()) entry.window.hide();
    if (this.entries.size > 0) this.notify();
  }
  showAll(): void {
    for (const entry of this.entries.values()) entry.window.showInactive();
    if (this.entries.size > 0) this.notify();
  }
  anyHidden(): boolean { return [...this.entries.values()].some((entry) => !entry.window.isVisible()); }

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

  /**
   * 事件定向投递（唯一公开入口）：agentId 在前、channel 在后，payload 自动携带 agentId。
   * 刻意不提供 `send(channel, agentId, payload)` 重载——两个 string 参数无法靠类型区分，
   * 之前 6 处调用就是把二者写反后事件被静默丢弃（T-M6-51）。
   */
  sendAgent(agentId: string, channel: string, payload: Record<string, unknown> = {}): void {
    const body = { agentId, ...payload };
    if (agentId === '*') {
      this.broadcast(channel, body);
      return;
    }
    const entry = this.entries.get(agentId);
    if (entry !== undefined && !entry.window.isDestroyed()) entry.window.send(channel, body);
  }

  /** 全窗广播（只给确实需要所有桌宠都收到的系统级事件用）。 */
  broadcast(channel: string, payload: Record<string, unknown> = {}): void {
    for (const entry of this.entries.values()) {
      if (!entry.window.isDestroyed()) entry.window.send(channel, payload);
    }
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
    // 主分支已移除桌宠缩放入口（T-M6-60 后统一 1.0×）；旧磁盘里的 1.3× 必须在
    // boundsFor 夹紧前就归 1，否则会先按 1.3× 夹紧、再按 1.0× 居中留下 60px 缝。
    if (stored !== undefined) {
      return { ...stored, scale: 1, ...(characterId === undefined ? {} : { characterId }) };
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
      scale: 1,
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
