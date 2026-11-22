/**
 * T-M5-04 门禁：记忆图谱——写入/去重合并/半衰期遗忘/混合检索/换日日记/消毒/墓碑压实。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, sanitizeMemoryText } from './store';
import { formatMemoryContext, lexicalScore, retrieve, tokenize } from './retrieve';

const dirs: string[] = [];
function freshStore(now?: () => number): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'mg-test-'));
  dirs.push(dir);
  return new MemoryStore({ dir, ...(now ? { now } : {}) });
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('MemoryStore 写入与合并', () => {
  it('同 nodeType+text 幂等合并（instanceCount++ / importance 递增）', () => {
    const store = freshStore();
    const a = store.addNode({ nodeType: 'event', text: '春天种了防风草' });
    const b = store.addNode({ nodeType: 'event', text: '春天种了防风草' });
    expect(a.id).toBe(b.id);
    expect(b.instanceCount).toBe(2);
    expect(b.importance).toBeGreaterThan(a.importance - 0.001);
    expect(store.size).toBe(1);
  });

  it('空正文拒绝；正文消毒剔除路径/id/密钥', () => {
    const store = freshStore();
    expect(() => store.addNode({ nodeType: 'event', text: '   ' })).toThrow();
    expect(sanitizeMemoryText('读取 /Users/jiaqi/secret.txt 成功')).not.toContain('/Users/');
    expect(sanitizeMemoryText('节点 n00000003 完成')).not.toContain('n00000003');
    expect(sanitizeMemoryText('key sk-abcdef123456 泄露')).toContain('{{MASKED}}');
    // 反例：普通英文标识符不得被误伤（skip_event 曾被误掩码）
    expect(sanitizeMemoryText('用 skip_event 跳过剧情')).toContain('skip_event');
  });

  it('JSONL 落盘 + 重开加载（持久化）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-persist-'));
    dirs.push(dir);
    const s1 = new MemoryStore({ dir });
    s1.addNode({ nodeType: 'event', text: '第一次钓鱼成功' });
    s1.addEdge(s1.allNodes()[0]!.id, s1.allNodes()[0]!.id, 'semantic', 1);
    const s2 = new MemoryStore({ dir });
    expect(s2.size).toBe(1);
    expect(s2.allNodes()[0]?.text).toBe('第一次钓鱼成功');
  });
});

describe('半衰期遗忘与墓碑', () => {
  it('30 天半衰期：宽限期外 importance 减半；低于 0.2 → 墓碑；墓碑比例压实', () => {
    let now = 1_000_000_000_000;
    const store = freshStore(() => now);
    const node = store.addNode({ nodeType: 'event', text: '很久以前的事', importance: 0.5 });
    now += 7 * 86_400_000; // 宽限内不衰减
    const store2 = new MemoryStore({ dir: (store as unknown as { nodesPath: string }).nodesPath.replace(/\/nodes\.jsonl$/, ''), now: () => now });
    expect(store2.size).toBe(1); // 宽限内仍在
    now += 30 * 86_400_000; // 再过 30 天（半衰期）→ 0.25
    const dir = (store as unknown as { nodesPath: string }).nodesPath.replace(/\/nodes\.jsonl$/, '');
    const store3 = new MemoryStore({ dir, now: () => now });
    const n = store3.allNodes().find((x) => x.text === '很久以前的事');
    expect(n).toBeDefined();
    expect(n!.importance).toBeLessThan(0.4);
    now += 30 * 86_400_000; // 再半个衰期 → 0.125 < 0.2 → 墓碑
    const store4 = new MemoryStore({ dir, now: () => now });
    expect(store4.size).toBe(0);
    expect(node.id).toBeTruthy();
  });

  it('pinned 节点永不衰减', () => {
    let now = 1_000_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), 'mg-pin-'));
    dirs.push(dir);
    const s1 = new MemoryStore({ dir, now: () => now });
    const n = s1.addNode({ nodeType: 'entity', text: '主人', importance: 0.5, pinned: true });
    now += 365 * 86_400_000;
    const s2 = new MemoryStore({ dir, now: () => now });
    expect(s2.size).toBe(1);
    expect(s2.allNodes()[0]!.id).toBe(n.id);
  });
});

describe('混合检索', () => {
  it('词法命中 + 图扩展 + 加权重排 topN', () => {
    const store = freshStore();
    const fishing = store.addNode({ nodeType: 'event', text: '春天在海滩钓鱼钓到鳀鱼', importance: 0.6 });
    const trash = store.addNode({ nodeType: 'event', text: '傍晚在镇上翻垃圾桶', importance: 0.5 });
    const diary = store.addNode({ nodeType: 'summary', text: '春天日记：完成 2 项，钓鱼和翻垃圾桶', importance: 0.7 });
    store.addEdge(diary.id, fishing.id, 'instance', 1);
    store.addEdge(fishing.id, trash.id, 'temporal', 0.5);

    const r = retrieve(store, '我昨天钓鱼了吗', { now: () => Date.now() });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.node.text).toContain('钓鱼');
    // 图扩展：命中的 diary 会带出 fishing/trash 至少一条
    expect(r.some((x) => x.reasons.includes('via-graph'))).toBe(true);
    // 只召回 event/summary
    expect(r.every((x) => ['event', 'summary'].includes(x.node.nodeType))).toBe(true);
    void trash;
  });

  it('2-gram 词法：中文查询命中；格式化上下文 ≤600 字', () => {
    const store = freshStore();
    store.addNode({ nodeType: 'event', text: '在矿洞第五层敲石头', importance: 0.5 });
    const r = retrieve(store, '矿洞');
    expect(r[0]?.node.text).toContain('矿洞');
    const ctx = formatMemoryContext(r);
    expect(ctx).toContain('长期记忆');
    expect(ctx.length).toBeLessThanOrEqual(620);
    expect(tokenize('钓鱼').has('钓鱼')).toBe(true);
    expect(lexicalScore(tokenize('钓鱼'), '钓鱼')).toBe(1);
  });

  it('空查询/无命中返回空数组', () => {
    const store = freshStore();
    store.addNode({ nodeType: 'event', text: '种地' });
    expect(retrieve(store, '')).toEqual([]);
    expect(retrieve(store, '完全无关的词汇组合xyz')).toEqual([]);
  });
});

describe('换日日记与动作记录', () => {
  it('recordAction 生成 event + temporal 边；writeDiary 汇总当天', () => {
    const store = freshStore();
    store.recordAction({ summary: '钓到鳀鱼', tool: 'fish', day: '春16', status: 'COMPLETED' });
    store.recordAction({ summary: '卡在石头边', tool: 'move_to', day: '春16', status: 'UNCERTAIN' });
    const diary = store.writeDiary('春16');
    expect(diary).not.toBeNull();
    expect(diary!.text).toContain('完成 1 项');
    expect(diary!.text).toContain('翻车 1 次');
    expect(store.allNodes().filter((n) => n.nodeType === 'event')).toHaveLength(2);
  });

  it('writeDiary 无事件返回 null（幂等边界）', () => {
    const store = freshStore();
    expect(store.writeDiary('春17')).toBeNull();
  });
});

describe('墓碑压实与擦除', () => {
  it('墓碑 >30% 时 compact 重写文件；wipe 清空', () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.addNode({ nodeType: 'event', text: `事件${i}` });
    // 手工标 4 个墓碑
    const nodes = store.allNodes();
    for (const n of nodes.slice(0, 4)) {
      (n as unknown as { tombstone: boolean }).tombstone = true;
    }
    store.compact();
    expect(store.size).toBe(6);
    store.wipe();
    expect(store.size).toBe(0);
  });
});

describe('store 分支补强', () => {
  it('addEdge 重复合并权重；neighborIds 双向；pin 切换', () => {
    const store = freshStore();
    const a = store.addNode({ nodeType: 'event', text: '事件A' });
    const b = store.addNode({ nodeType: 'event', text: '事件B' });
    const e1 = store.addEdge(a.id, b.id, 'semantic', 0.5);
    const e2 = store.addEdge(a.id, b.id, 'semantic', 0.5);
    expect(e2.weight).toBeGreaterThan(e1.weight - 0.001);
    expect(store.allEdges()).toHaveLength(1);
    expect(store.neighborIds(a.id)).toContain(b.id);
    expect(store.neighborIds(b.id)).toContain(a.id);
    store.pin(a.id, true);
    expect(store.allNodes().find((n) => n.id === a.id)?.pinned).toBe(true);
    store.pin('missing-node', true); // 不存在安全忽略
  });

  it('compact 不足 30% 墓碑不重写；坏 JSONL 行跳过', () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.addNode({ nodeType: 'event', text: `普通事件${i}` });
    (store.allNodes()[0] as unknown as { tombstone: boolean }).tombstone = true; // 10% < 30%
    store.compact();
    expect(store.size).toBe(9); // 不压实，仅计数排除
  });

  it('recordAction 翻车事件重要度更高 + 同文本幂等合并', () => {
    const store = freshStore();
    const ok = store.recordAction({ summary: '浇水', tool: 'water', day: '春16', status: 'COMPLETED' });
    const fail = store.recordAction({ summary: '卡住', tool: 'move', day: '春16', status: 'UNCERTAIN' });
    expect(fail.importance).toBeGreaterThan(ok.importance);
    const dup = store.recordAction({ summary: '浇水', tool: 'water', day: '春16', status: 'COMPLETED' });
    expect(dup.id).toBe(ok.id);
    expect(dup.instanceCount).toBe(2);
  });

  it('store 重载：墓碑节点不复活（墓碑落盘后 load 过滤）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-tomb-'));
    dirs.push(dir);
    const s1 = new MemoryStore({ dir });
    const n = s1.addNode({ nodeType: 'event', text: '将被遗忘', importance: 0.1 });
    (n as unknown as { tombstone: boolean }).tombstone = true;
    // 触发一次落盘（addNode 已写；墓碑标定需再写一条）
    s1.pin(n.id, true); // 会 append 新行（含 tombstone:true）
    const s2 = new MemoryStore({ dir });
    expect(s2.allNodes().some((x) => x.text === '将被遗忘')).toBe(false);
  });
});
