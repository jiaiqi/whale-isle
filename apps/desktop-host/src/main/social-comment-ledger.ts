/** 抖音评论审计：发送前写 journal，SQLite 失败时禁止发送；不自动重试结果不明的动作。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SocialCommentActionSchema, type SocialCommentAction, type SocialCommentSettings } from '@workbench/shared-protocol';
import type { DouyinCommentLedgerPort } from '@workbench/character-core';

export class SocialCommentLedger implements DouyinCommentLedgerPort {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly accountId: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS social_comment_actions (
        account_id TEXT NOT NULL, action_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        attempted_at INTEGER NOT NULL, video_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (account_id, action_id)
      );
      CREATE INDEX IF NOT EXISTS social_comment_by_time ON social_comment_actions(account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS social_comment_by_attempt ON social_comment_actions(account_id, attempted_at);`);
    // 崩溃或退出中断的 pending 不能假称失败，更不能自动重发。
    for (const action of this.list(0, Number.MAX_SAFE_INTEGER)) {
      if (action.status === 'pending') this.append({ ...action, status: 'uncertain', failureKind: 'receipt_failed',
        reason: '上次进程在等待回执时退出，结果不确定；已停止自动评论，不自动重发', completedAt: Date.now() });
    }
  }
  private rows(since: number, until = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT payload FROM social_comment_actions WHERE account_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC')
      .all(this.accountId, since, until) as Array<{ payload: string }>;
  }
  list(since: number, until: number): SocialCommentAction[] {
    return this.rows(since, until).map(row => SocialCommentActionSchema.parse(JSON.parse(row.payload)));
  }
  countSentSince(ts: number): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM social_comment_actions WHERE account_id = ? AND attempted_at > 0 AND attempted_at >= ?')
      .get(this.accountId, ts)?.['n'] ?? 0);
  }
  lastSentAt(): number | null {
    const value = this.db.prepare('SELECT max(attempted_at) AS ts FROM social_comment_actions WHERE account_id = ? AND attempted_at > 0').get(this.accountId)?.['ts'];
    return value === null || value === undefined ? null : Number(value);
  }
  hasCommentedVideo(videoId: string, since: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM social_comment_actions WHERE account_id = ? AND video_id = ? AND attempted_at > 0 AND attempted_at >= ? LIMIT 1')
      .get(this.accountId, videoId, since));
  }
  recentSentTexts(since: number): string[] {
    return this.list(since, Number.MAX_SAFE_INTEGER).filter(action => action.attemptedAt > 0).map(action => action.text);
  }
  append(raw: SocialCommentAction, settings?: SocialCommentSettings): void {
    const action = SocialCommentActionSchema.parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (action.status === 'pending' && settings) {
        const at = action.attemptedAt;
        const midnight = new Date(at); midnight.setHours(0, 0, 0, 0);
        const last = this.lastSentAt();
        if (this.countSentSince(midnight.getTime()) >= settings.maxPerDay ||
            this.countSentSince(at - 3_600_000) >= settings.maxPerHour ||
            (last !== null && at - last < settings.minIntervalMs) ||
            this.hasCommentedVideo(action.videoId, at - settings.sameVideoCooldownMs)) {
          throw new Error('SQLite 发送额度或同视频冷却已被另一任务占用，未发送');
        }
      }
      this.db.prepare(`INSERT INTO social_comment_actions VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, action_id) DO UPDATE SET attempted_at = excluded.attempted_at, status = excluded.status, payload = excluded.payload`)
        .run(this.accountId, action.actionId, action.createdAt, action.attemptedAt, action.videoId, action.status, JSON.stringify(action));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
