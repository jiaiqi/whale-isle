import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SocialCommentActionSchema, SocialCommentSettingsSchema } from '@workbench/shared-protocol';
import { SocialCommentLedger } from './social-comment-ledger';

const at = new Date(2026, 10, 27, 12).getTime();
const pending = (id = 'a1', videoId = '7703599797286223291') => SocialCommentActionSchema.parse({
  actionId: id, platform: 'douyin', targetUrl: `https://www.douyin.com/video/${videoId}`, videoId,
  text: '这段介绍让我明白了原理', status: 'pending', createdAt: at, attemptedAt: at,
});

describe('[SIMULATION] SQLite 评论审计（真实临时磁盘库）', () => {
  it('发送前预留占额度、同 actionId 更新不双计；重启后 pending 转 uncertain，账号相互隔离', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comment-ledger-'));
    try {
      const path = join(dir, 'workbench.db');
      const first = new SocialCommentLedger(path, 'owner-pilot');
      first.append(pending());
      expect(first.countSentSince(at - 1)).toBe(1);
      expect(first.hasCommentedVideo(pending().videoId, at - 1)).toBe(true);
      expect(first.lastSentAt()).toBe(at);
      first.close();
      const reopened = new SocialCommentLedger(path, 'owner-pilot');
      expect(reopened.list(at - 1, at + 1)[0]?.status).toBe('uncertain');
      expect(reopened.countSentSince(at - 1)).toBe(1);
      const action = pending('a2', '7703599797286223292');
      reopened.append(action);
      reopened.append({ ...action, status: 'sent', completedAt: at + 100 });
      expect(reopened.countSentSince(at - 1)).toBe(2);
      expect(reopened.list(at - 1, at + 1)).toHaveLength(2);
      expect(reopened.recentSentTexts(at - 1)).toHaveLength(2);
      expect(reopened.list(at + 1, at + 2)).toEqual([]);
      const other = new SocialCommentLedger(path, 'different-account');
      expect(other.countSentSince(0)).toBe(0);
      expect(other.lastSentAt()).toBeNull();
      other.close(); reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('两个连接争用最后一份额度时，SQLite 事务拒绝第二次预留，原始记录保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'comment-quota-'));
    const path = join(dir, 'db.sqlite');
    const first = new SocialCommentLedger(path, 'owner');
    const second = new SocialCommentLedger(path, 'owner');
    try {
      const settings = SocialCommentSettingsSchema.parse({ enabled: true, maxPerDay: 1 });
      first.append(pending(), settings);
      expect(() => second.append(pending('a2', '7703599797286223292'), settings)).toThrow('额度');
      expect(first.list(at - 1, at + 1)).toHaveLength(1);
      second.append({ ...pending('skip'), status: 'skipped', attemptedAt: 0 });
      expect(first.countSentSince(0)).toBe(1);
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
