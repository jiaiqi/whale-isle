import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqlite';

/** T-M0-03 门禁断言：常客记仇标签读写、记忆一键删除（隐私合规）、Token 流水、点歌缓存 */

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('常客记仇/好感账本', () => {
  it('写入并读回记仇标签（去重合并）', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-1', nickname: '路过的鱼干' });
    expect(store.addGrudgeTag('douyin', 'u-1', '叫我大肥鱼的坏蛋')?.grudgeTags).toEqual([
      '叫我大肥鱼的坏蛋',
    ]);
    // 重复标签不重复入账
    store.addGrudgeTag('douyin', 'u-1', '叫我大肥鱼的坏蛋');
    expect(store.getViewer('douyin', 'u-1')?.grudgeTags).toHaveLength(1);
    // 多标签累计
    store.addGrudgeTag('douyin', 'u-1', '半夜点《学猫叫》');
    expect(store.getViewer('douyin', 'u-1')?.grudgeTags).toEqual(['叫我大肥鱼的坏蛋', '半夜点《学猫叫》']);
  });

  it('好感度 bump 与排序榜单', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-a' });
    store.upsertViewer({ platform: 'douyin', uid: 'u-b' });
    store.bumpIntimacy('douyin', 'u-a', 5);
    store.bumpIntimacy('douyin', 'u-a', 3);
    store.bumpIntimacy('douyin', 'u-b', 9);
    expect(store.getViewer('douyin', 'u-a')?.intimacyScore).toBe(8);
    const board = store.listViewers();
    expect(board[0]?.uid).toBe('u-b');
  });

  it('备注更新、未知观众返回 null', () => {
    expect(store.addGrudgeTag('douyin', 'nobody', 'x')).toBeNull();
    expect(store.bumpIntimacy('douyin', 'nobody', 1)).toBeNull();
    expect(store.getViewer('douyin', 'nobody')).toBeNull();
    store.upsertViewer({ platform: 'douyin', uid: 'u-n' });
    expect(store.setViewerNotes('douyin', 'u-n', '上次送过红烧肉')?.notes).toBe('上次送过红烧肉');
    expect(store.setViewerNotes('douyin', 'nobody', 'x')).toBeNull();
  });

  it('昵称保留策略：空昵称覆盖不冲掉旧昵称', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-2', nickname: '老粉' });
    store.upsertViewer({ platform: 'douyin', uid: 'u-2' });
    expect(store.getViewer('douyin', 'u-2')?.nickname).toBe('老粉');
  });

  it('隐私合规：单观众删除与一键擦除', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-3', grudgeTags: ['x'] });
    store.upsertViewer({ platform: 'douyin', uid: 'u-4' });
    expect(store.deleteViewer('douyin', 'u-3')).toBe(true);
    expect(store.deleteViewer('douyin', 'u-3')).toBe(false);
    expect(store.wipeAllViewers()).toBe(1);
    expect(store.listViewers()).toEqual([]);
  });

  it('grudge_tags 损坏 JSON / 非 JSON 数组的容错（返回空数组）', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-5' });
    const rawDb = (
      store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
    ).db;
    // 直接写坏数据模拟历史脏数据
    rawDb.prepare('UPDATE grudge_ledger SET grudge_tags = ? WHERE uid = ?').run('not-json', 'u-5');
    expect(store.getViewer('douyin', 'u-5')?.grudgeTags).toEqual([]);
    // 合法 JSON 但不是数组
    rawDb.prepare('UPDATE grudge_ledger SET grudge_tags = ? WHERE uid = ?').run('"str"', 'u-5');
    expect(store.getViewer('douyin', 'u-5')?.grudgeTags).toEqual([]);
    rawDb.prepare('UPDATE grudge_ledger SET grudge_tags = ? WHERE uid = ?').run('null', 'u-5');
    expect(store.getViewer('douyin', 'u-5')?.grudgeTags).toEqual([]);
  });

  it('初始好感度与备注随首次登记落库', () => {
    store.upsertViewer({
      platform: 'douyin',
      uid: 'u-init',
      nickname: '榜一',
      intimacyScore: 42,
      grudgeTags: ['初始标签'],
      notes: '投喂过豪华海鲜饭',
    });
    const viewer = store.getViewer('douyin', 'u-init');
    expect(viewer?.intimacyScore).toBe(42);
    expect(viewer?.notes).toBe('投喂过豪华海鲜饭');
  });
});

describe('Token 消耗流水（赛博饭碗）', () => {
  it('记录并按槽位汇总（1 粒米 = input + output）', () => {
    store.recordTokenUsage({
      slot: 'MAIN_PERSONA_BRAIN',
      providerId: 'deepseek-official',
      modelId: 'deepseek-reasoner',
      inputTokens: 12000,
      cachedInputTokens: 8000,
      outputTokens: 300,
      purpose: '内心戏',
    });
    const slotSummary = store.recordTokenUsage({
      slot: 'DANMAKU_FAST_ROUTER',
      providerId: 'siliconflow',
      modelId: 'qwen-turbo',
      inputTokens: 500,
      outputTokens: 100,
    });
    expect(slotSummary.riceGrains).toBe(600);
    const brain = store.getTokenSummary('MAIN_PERSONA_BRAIN');
    expect(brain.inputTokens).toBe(12000);
    expect(brain.cachedInputTokens).toBe(8000);
    expect(brain.riceGrains).toBe(12300);
    const total = store.getTokenSummary();
    expect(total.calls).toBe(2);
    expect(total.riceGrains).toBe(12900);
    expect(total.outputTokens).toBe(400);
  });

  it('饭碗流水擦除', () => {
    store.recordTokenUsage({ slot: 'VOICE_TTS_SPEECH', providerId: 'local', modelId: 'gpt-sovits-v2' });
    expect(store.wipeTokenLedger()).toBe(1);
    expect(store.getTokenSummary().calls).toBe(0);
  });
});

describe('点歌缓存索引', () => {
  it('upsert / 命中计数 / 未命中 / 删除', () => {
    const key = 'blue-whale-maid_<hash>';
    store.putSongCache({ cacheKey: key, songTitle: '晴天', filePath: 'cache/songs/a.ogg', sizeBytes: 3_200_000 });
    const first = store.hitSongCache(key);
    expect(first?.hitCount).toBe(1);
    expect(first?.songTitle).toBe('晴天');
    expect(store.hitSongCache(key)?.hitCount).toBe(2);
    expect(store.hitSongCache('missing')).toBeNull();
    // 同 key upsert 更新元数据、保留命中计数
    store.putSongCache({ cacheKey: key, songTitle: '晴天 (Live)', filePath: 'cache/songs/b.ogg', sizeBytes: 4_000_000 });
    const updated = store.hitSongCache(key);
    expect(updated?.filePath).toBe('cache/songs/b.ogg');
    expect(updated?.hitCount).toBe(3);
    expect(store.deleteSongCache(key)).toBe(true);
    expect(store.hitSongCache(key)).toBeNull();
  });

  it('缓存擦除', () => {
    store.putSongCache({ cacheKey: 'k1', songTitle: 'a', filePath: 'p1' });
    store.putSongCache({ cacheKey: 'k2', songTitle: 'b', filePath: 'p2' });
    expect(store.wipeSongCache()).toBe(2);
  });
});

describe('隐私合规总开关与持久化', () => {
  it('wipeAllData 清空全部业务表；meta 读写正常', () => {
    store.upsertViewer({ platform: 'douyin', uid: 'u-9' });
    store.recordTokenUsage({ slot: 'MAIN_PERSONA_BRAIN', providerId: 'p', modelId: 'm' });
    store.putSongCache({ cacheKey: 'k', songTitle: 's', filePath: 'f' });
    store.wipeAllData();
    expect(store.listViewers()).toEqual([]);
    expect(store.getTokenSummary().calls).toBe(0);
    expect(store.hitSongCache('k')).toBeNull();
    store.setMeta('schemaVersion', '2026-11-15');
    expect(store.getMeta('schemaVersion')).toBe('2026-11-15');
    expect(store.getMeta('absent')).toBeNull();
  });

  it('文件库 WAL 持久化：关库重开数据仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-store-'));
    const dbPath = join(dir, 'workbench.db');
    try {
      const fileStore = new SqliteStore(dbPath);
      fileStore.upsertViewer({ platform: 'douyin', uid: 'persist-1', nickname: '常客' });
      fileStore.setMeta('lastBoot', '1');
      fileStore.close();

      const reopened = new SqliteStore(dbPath);
      expect(reopened.getViewer('douyin', 'persist-1')?.nickname).toBe('常客');
      expect(reopened.getMeta('lastBoot')).toBe('1');
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
