import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMemoryContext, MemoryStore, retrieve } from './index';

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mg-v2-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('V2-P1-04 human-like 5-category memory, fuzzy impressions & cascade hard delete', () => {
  it('supports all 5 categories, emotion-weighted decay resistance, and mood-congruent recall', () => {
    let tick = 1_000_000_000_000;
    const dir = freshDir();
    const store = new MemoryStore({ dir, now: () => tick });

    store.addNode({ nodeType: 'event', category: 'working', text: '正在调试星露谷背包' });
    const emoHigh = store.addNode({
      nodeType: 'event',
      category: 'episodic',
      text: '海滩惊喜钓到传说鱼王',
      importance: 0.45,
      emotionWeight: 0.95,
      emotionValence: 0.8,
    });
    const emoLow = store.addNode({
      nodeType: 'event',
      category: 'episodic',
      text: '海滩普通走路经过木桥',
      importance: 0.45,
      emotionWeight: 0,
      emotionValence: 0.1,
    });
    store.addNode({ nodeType: 'concept', category: 'semantic', text: '下雨天海滩容易出现特定鱼类' });
    store.addNode({ nodeType: 'entity', category: 'relational', text: '烤鱼干经常晚上来直播间', entityKey: 'viewer:u-1', entityDisplayName: '烤鱼干' });
    store.addNode({ nodeType: 'concept', category: 'self', text: '我是傲娇蓝鲸女仆小鲸' });

    expect(store.listByCategory('working')).toHaveLength(1);
    expect(store.listByCategory('episodic')).toHaveLength(2);
    expect(store.listByCategory('semantic')).toHaveLength(1);
    expect(store.listByCategory('relational')).toHaveLength(1);
    expect(store.listByCategory('self')).toHaveLength(1);

    // 45 天后：无情绪权重的普通事件衰减淘汰，高情绪记忆与 Self 记忆依然保留
    tick += 45 * 86_400_000;
    const reloaded = new MemoryStore({ dir, now: () => tick });
    expect(reloaded.allNodes().some((n) => n.id === emoHigh.id)).toBe(true);
    expect(reloaded.allNodes().some((n) => n.id === emoLow.id)).toBe(false);
    expect(reloaded.listByCategory('self')).toHaveLength(1);

    // 情绪同向检索与主动回忆巩固
    const hits = retrieve(reloaded, '海滩钓到鱼', {
      currentEmotionValence: 0.7,
      categories: ['episodic'],
      recordRecall: true,
      now: () => tick,
    });
    expect(hits[0]?.node.id).toBe(emoHigh.id);
    expect(hits[0]?.reasons).toContain('mood-congruent');
    expect(reloaded.allNodes().find((n) => n.id === emoHigh.id)?.recallCount).toBe(1);
  });

  it('consolidates fuzzy relational impressions that outlive decayed raw sentences and marks uncertain memories', () => {
    let tick = 1_000_000_000_000;
    const dir = freshDir();
    const store = new MemoryStore({ dir, now: () => tick });

    const r1 = store.addNode({
      nodeType: 'event',
      category: 'relational',
      text: '烤鱼干说今天加班好累',
      importance: 0.35,
      entityKey: 'viewer:u-42',
      entityDisplayName: '烤鱼干',
    });
    const r2 = store.addNode({
      nodeType: 'event',
      category: 'relational',
      text: '烤鱼干送了一条小鱼干',
      importance: 0.35,
      entityKey: 'viewer:u-42',
      entityDisplayName: '烤鱼干',
    });

    const impressions = store.consolidateRelationalImpressions({ entityKey: 'viewer:u-42', minInteractions: 2 });
    expect(impressions).toHaveLength(1);
    expect(impressions[0]?.interactionCount).toBe(2);

    // 再次新增一条并二次归纳（覆盖已有 consolidated 节点）
    store.addNode({
      nodeType: 'event',
      category: 'relational',
      text: '烤鱼干夸小鲸钓鱼厉害',
      importance: 0.35,
      entityKey: 'viewer:u-42',
      entityDisplayName: '烤鱼干',
    });
    const updatedImpressions = store.consolidateRelationalImpressions({ minInteractions: 2 });
    expect(updatedImpressions[0]?.interactionCount).toBe(3);

    // 90 天后：旧单句自然淡忘，但模糊印象仍保留且检索标为 fuzzy
    tick += 90 * 86_400_000;
    const afterDecay = new MemoryStore({ dir, now: () => tick });
    expect(afterDecay.allNodes().some((n) => n.id === r1.id)).toBe(false);
    expect(afterDecay.allNodes().some((n) => n.id === r2.id)).toBe(false);

    const fuzzyHits = retrieve(afterDecay, '烤鱼干', { now: () => tick });
    expect(fuzzyHits.length).toBeGreaterThanOrEqual(1);
    expect(fuzzyHits[0]?.certainty).toBe('fuzzy');
    expect(formatMemoryContext(fuzzyHits)).toContain('[模糊印象]');

    // 低置信度记忆显式标为 uncertain，不假装笃定
    afterDecay.addNode({
      nodeType: 'event',
      category: 'episodic',
      text: '好像有人提过神秘种子',
      confidence: 0.3,
      importance: 0.5,
    });
    const uncertainHits = retrieve(afterDecay, '神秘种子', { now: () => tick });
    expect(uncertainHits[0]?.certainty).toBe('uncertain');
    expect(formatMemoryContext(uncertainHits)).toContain('不太确定');
  });

  it('supports manual correction, protects Self memories, and performs cascade hard deletion with physical wipe & content-free audit', () => {
    const dir = freshDir();
    const store = new MemoryStore({ dir });

    const selfNode = store.addNode({
      nodeType: 'concept',
      category: 'self',
      text: '小鲸核心人格不可随意删除',
    });
    const blocked = store.hardDelete(selfNode.id);
    expect(blocked).toEqual({ deleted: false, blockedReason: 'PROTECTED_SELF_MEMORY' });
    expect(store.hardDelete('nonexistent')).toEqual({ deleted: false, blockedReason: 'NOT_FOUND' });

    // 手动纠正记忆
    const ev = store.recordAction({
      summary: '私密敏感原话ABCDEFG',
      tool: 'chat',
      day: '第1年春3日',
      status: 'COMPLETED',
    });
    const rel = store.addNode({
      nodeType: 'event',
      category: 'relational',
      text: '观众XYZ发了私密敏感词HIJKLMN',
      entityKey: 'viewer:u-99',
      entityDisplayName: '观众XYZ',
    });
    const corrected = store.correctNode(rel.id, '观众XYZ来打过招呼', '去除敏感词');
    expect(corrected.confidence).toBe(1);
    expect(corrected.correctionHistory).toHaveLength(1);
    expect(() => store.correctNode('missing', 'text')).toThrow();
    expect(() => store.correctNode(rel.id, '   ')).toThrow();

    // 生成衍生日记摘要
    const diary = store.writeDiary('第1年春3日');
    expect(diary?.derivedFromIds).toContain(ev.id);

    // 二级衍生（摘要的摘要）：从日记再派生的周记，级联删除必须一并带走
    const weekly = store.addNode({
      nodeType: 'summary',
      text: '本周摘要（派生自日记）',
      derivedFromIds: [diary!.id],
    });

    // 级联真删除 ev 与 rel：验证衍生日记、图谱节点、磁盘 JSONL 原文、SQLite 回调及无明文审计
    const ledgerCallback = vi.fn((key: string) => key === 'viewer:u-99');
    const delEv = store.hardDelete(ev.id, { reason: '用户删除事件', onDeleteLedgerRef: ledgerCallback });
    expect(delEv.deleted).toBe(true);
    expect(delEv.audit?.deletedDerivedIds).toContain(diary!.id);
    // 二级衍生（摘要的摘要）必须级联，否则成为指向已删节点的孤儿
    expect(delEv.audit?.deletedDerivedIds).toContain(weekly.id);

    const delRel = store.hardDelete(rel.id, { reason: '用户删除常客记录', onDeleteLedgerRef: ledgerCallback });
    expect(delRel.deleted).toBe(true);
    expect(delRel.audit?.clearedLedgerRefs).toEqual(['viewer:u-99']);
    expect(ledgerCallback).toHaveBeenCalledWith('viewer:u-99');

    // 物理文件中彻底不可再包含被删正文，检索也零命中
    const rawNodesFile = readFileSync(join(dir, 'nodes.jsonl'), 'utf8');
    expect(rawNodesFile).not.toContain('ABCDEFG');
    expect(rawNodesFile).not.toContain('HIJKLMN');
    expect(retrieve(store, 'ABCDEFG')).toEqual([]);

    // 审计文件留痕但不含正文
    const rawAuditFile = readFileSync(join(dir, 'deletion-audit.jsonl'), 'utf8');
    expect(rawAuditFile).not.toContain('ABCDEFG');
    expect(rawAuditFile).not.toContain('HIJKLMN');

    const reloaded = new MemoryStore({ dir });
    expect(reloaded.deletionAudits()).toHaveLength(2);
    expect(reloaded.hardDelete(selfNode.id, { allowProtectedSelf: true }).deleted).toBe(true);
  });
});
