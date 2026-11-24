/**
 * 友谊 / 小本子账本（T-M6-48，移植 CrossPet `friendship.js` 规则：10 颗心 + 1/4 填充 + 每日上限 15）。
 *
 * 独立 SQLite 文件（`userData/friendship.sqlite`），与常客账本物理隔离：
 * 一键隐私擦除只清这一份，不触碰 Token 流水/点歌缓存。所有写入口都必须经过
 * `addPoints`（按日累计 + DAILY_CAP），避免 UI 侧随意加心。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DAILY_CAP = 15;
export const HEARTS_MAX = 10;
/** 1 颗心 = 40 分；1/4 心 = 10 分 */
export const POINTS_PER_HEART = 40;

export type FriendshipAction = 'pat' | 'poke' | 'chat' | 'cowork' | 'cofinish';

/** 每种互动的分数（每日封顶 15，跨日重置）。 */
export const POINTS_BY_ACTION: Record<FriendshipAction, number> = {
  pat: 3,
  poke: 2,
  chat: 1,
  cowork: 4,
  cofinish: 6,
};

export interface FriendshipStats {
  characterId: string;
  points: number;
  /** 今日已获得分数（0..15） */
  dailyGained: number;
  /** 心数 ×4（0..40 个 1/4 格） */
  quarterHearts: number;
  hearts: number;
  tier: 'stranger' | 'familiar' | 'friend' | 'best';
  pats: number;
  pokes: number;
  rounds: number;
  cowork: number;
  cofinish: number;
}

export interface NotebookBanter {
  id: number;
  aName: string;
  aText: string;
  bName: string;
  bText: string;
  createdAt: number;
}

export interface NotebookNote {
  id: number;
  text: string;
  createdAt: number;
}

export function quarterHeartsOf(points: number): number {
  return Math.max(0, Math.min(HEARTS_MAX * 4, Math.floor(points / (POINTS_PER_HEART / 4))));
}

export function tierOf(quarterHearts: number): FriendshipStats['tier'] {
  if (quarterHearts >= 36) return 'best';
  if (quarterHearts >= 20) return 'friend';
  if (quarterHearts >= 4) return 'familiar';
  return 'stranger';
}

export function dayKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class FriendshipStore {
  private readonly db: DatabaseSync;

  /**
   * 用 Electron/Node 内置的 `node:sqlite`（Node 24+），而不是 better-sqlite3 原生模块：
   * 主进程与单测都能直接加载，避免 Electron ABI 重编译；语法仍是标准 SQLite。
   */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS friendship (
        character_id TEXT PRIMARY KEY,
        points INTEGER NOT NULL DEFAULT 0,
        daily_day TEXT NOT NULL DEFAULT '',
        daily_gained INTEGER NOT NULL DEFAULT 0,
        pats INTEGER NOT NULL DEFAULT 0,
        pokes INTEGER NOT NULL DEFAULT 0,
        rounds INTEGER NOT NULL DEFAULT 0,
        cowork INTEGER NOT NULL DEFAULT 0,
        cofinish INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS notebook_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notebook_banter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_id TEXT NOT NULL,
        a_name TEXT NOT NULL,
        a_text TEXT NOT NULL,
        b_id TEXT NOT NULL,
        b_name TEXT NOT NULL,
        b_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** 记一次互动；返回写入后的完整状态。超过每日上限时分数不再增长，但计数照记。 */
  addPoints(characterId: string, action: FriendshipAction, now = Date.now()): FriendshipStats {
    const id = characterId.trim();
    if (id === '') throw new Error('缺少角色 id');
    const day = dayKey(now);
    const requested = POINTS_BY_ACTION[action];
    this.db.prepare(`
      INSERT INTO friendship (character_id, points, daily_day, daily_gained)
      VALUES (?, 0, ?, 0)
      ON CONFLICT(character_id) DO NOTHING
    `).run(id, day);
    const row = this.db.prepare('SELECT * FROM friendship WHERE character_id = ?').get(id) as
      | { points: number; daily_day: string; daily_gained: number }
      | undefined;
    if (row === undefined) throw new Error(`友谊记录创建失败：${id}`);
    const sameDay = row.daily_day === day;
    const gainedToday = sameDay ? row.daily_gained : 0;
    const delta = Math.max(0, Math.min(requested, DAILY_CAP - gainedToday));
    const column = action === 'pat' ? 'pats' : action === 'poke' ? 'pokes' : action === 'cowork' ? 'cowork' : action === 'cofinish' ? 'cofinish' : 'rounds';
    this.db.prepare(`
      UPDATE friendship SET
        points = points + ?,
        daily_day = ?,
        daily_gained = ?,
        ${column} = ${column} + 1
      WHERE character_id = ?
    `).run(delta, day, gainedToday + delta, id);
    return this.get(id, now) as FriendshipStats;
  }

  get(characterId: string, now = Date.now()): FriendshipStats | null {
    const row = this.db.prepare('SELECT * FROM friendship WHERE character_id = ?').get(characterId) as Record<string, number | string> | undefined;
    if (row === undefined) return null;
    return this.toStats(row, now);
  }

  list(now = Date.now()): FriendshipStats[] {
    const rows = this.db.prepare('SELECT * FROM friendship ORDER BY points DESC').all() as Array<Record<string, number | string>>;
    return rows.map((row) => this.toStats(row, now));
  }

  addNote(characterId: string, text: string, now = Date.now()): NotebookNote {
    const value = text.trim().slice(0, 280);
    if (value === '') throw new Error('留言不能为空');
    const info = this.db.prepare('INSERT INTO notebook_notes (character_id, text, created_at) VALUES (?, ?, ?)').run(characterId, value, now);
    return { id: Number(info.lastInsertRowid), text: value, createdAt: now };
  }

  listNotes(characterId: string, limit = 20): NotebookNote[] {
    const rows = this.db.prepare('SELECT id, text, created_at FROM notebook_notes WHERE character_id = ? ORDER BY id DESC LIMIT ?').all(characterId, limit) as Array<{ id: number; text: string; created_at: number }>;
    return rows.map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }));
  }

  addBanter(entry: { aId: string; aName: string; aText: string; bId: string; bName: string; bText: string }, now = Date.now()): NotebookBanter {
    const clipped = (value: string): string => value.trim().slice(0, 280);
    const info = this.db.prepare(`
      INSERT INTO notebook_banter (a_id, a_name, a_text, b_id, b_name, b_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entry.aId, clipped(entry.aName), clipped(entry.aText), entry.bId, clipped(entry.bName), clipped(entry.bText), now);
    return {
      id: Number(info.lastInsertRowid),
      aName: clipped(entry.aName),
      aText: clipped(entry.aText),
      bName: clipped(entry.bName),
      bText: clipped(entry.bText),
      createdAt: now,
    };
  }

  listBanter(limit = 10): NotebookBanter[] {
    const rows = this.db.prepare('SELECT * FROM notebook_banter ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, number | string>>;
    return rows.map((row) => ({
      id: Number(row.id),
      aName: String(row.a_name),
      aText: String(row.a_text),
      bName: String(row.b_name),
      bText: String(row.b_text),
      createdAt: Number(row.created_at),
    }));
  }

  /** 隐私擦除：只清友谊/小本子三表并 VACUUM。 */
  wipe(): void {
    this.db.exec('DELETE FROM friendship; DELETE FROM notebook_notes; DELETE FROM notebook_banter;');
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }

  private toStats(row: Record<string, number | string>, now: number): FriendshipStats {
    const points = Number(row.points);
    const sameDay = String(row.daily_day) === dayKey(now);
    const quarterHearts = quarterHeartsOf(points);
    return {
      characterId: String(row.character_id),
      points,
      dailyGained: sameDay ? Number(row.daily_gained) : 0,
      quarterHearts,
      hearts: Math.floor(quarterHearts / 4),
      tier: tierOf(quarterHearts),
      pats: Number(row.pats),
      pokes: Number(row.pokes),
      rounds: Number(row.rounds),
      cowork: Number(row.cowork),
      cofinish: Number(row.cofinish),
    };
  }
}
