/**
 * 记忆宿主（T-M5-04）：主进程持有 MemoryStore——
 *   - autodrive 回执自动入图谱（event 节点 + 游戏日 meta）
 *   - 换日（游戏日期变化）自动写日记 summary 节点
 *   - 聊天问句走混合检索 → 记忆上下文注入 LLM system prompt
 * 数据落 userData/memory/（JSONL）；隐私：sanitizeMemoryText 消毒 + wipe IPC。
 */
import { ipcMain } from 'electron';
import { join } from 'node:path';
import { MemoryStore, formatMemoryContext, retrieve } from '@workbench/memory-graph';

export interface MemoryHost {
  readonly store: MemoryStore;
  /** 回执入口（编排器调用）：写入 event 节点；返回是否触发换日日记 */
  onReceipt(input: { summary: string; tool: string; status: string; gameClock: string }): void;
  /** 聊天检索：返回格式化记忆上下文（无命中返回空串） */
  contextFor(query: string): string;
}

/** 从「第1年春16日」格式提取游戏日键 */
export function dayKeyOf(gameClock: string): string {
  const m = /第\d+年\s*([春夏秋冬]\d+日)/.exec(gameClock);
  return m?.[1] ?? gameClock.slice(0, 12);
}

export function createMemoryHost(userDataDir: string): MemoryHost {
  const store = new MemoryStore({ dir: join(userDataDir, 'memory') });
  let lastDay: string | null = null;

  const onReceipt = (input: { summary: string; tool: string; status: string; gameClock: string }): void => {
    const day = dayKeyOf(input.gameClock);
    // 换日：上一日先写日记（幂等——同一天只写一次）
    if (lastDay !== null && lastDay !== day) {
      store.writeDiary(lastDay);
      store.compact();
    }
    lastDay = day;
    store.recordAction({ summary: input.summary.slice(0, 120), tool: input.tool, day, status: input.status });
  };

  const contextFor = (query: string): string => {
    const memories = retrieve(store, query, { topN: 5 });
    return formatMemoryContext(memories);
  };

  ipcMain.handle('memory:query', (_e, query: string) => {
    const memories = retrieve(store, query, { topN: 8 });
    return {
      ok: true,
      context: formatMemoryContext(memories),
      hits: memories.map((m) => ({ text: m.node.text, score: Number(m.score.toFixed(3)), type: m.node.nodeType })),
      totalNodes: store.size,
    };
  });
  ipcMain.handle('memory:diary', (_e, day?: string) => {
    const target = day ?? lastDay;
    if (!target) return { ok: false, error: '暂无游戏日' };
    const diary = store.writeDiary(target); // 幂等 upsert
    return { ok: true, day: target, text: diary?.text ?? '（当天没有记录）' };
  });
  ipcMain.handle('memory:stats', () => ({
    nodes: store.size,
    edges: store.allEdges().length,
    lastDay,
  }));
  // 记忆图谱（T-M6-07 UI v4 记忆页）：节点上限 200（钉住 > 重要度 > 新近），边只保留两端可见
  ipcMain.handle('memory:graph', () => {
    const all = store.allNodes();
    const picked = [...all]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, 200);
    const ids = new Set(picked.map((n) => n.id));
    const edges = store.allEdges().filter((e) => ids.has(e.from) && ids.has(e.to));
    const days = [...new Set(all.filter((n) => n.nodeType === 'event' && n.meta?.['day']).map((n) => String(n.meta?.['day'])))].sort();
    return {
      nodes: picked.map((n) => ({
        id: n.id,
        nodeType: n.nodeType,
        text: n.text,
        importance: n.importance,
        pinned: n.pinned,
        createdAt: n.createdAt,
        day: String(n.meta?.['day'] ?? ''),
        instanceCount: n.instanceCount,
      })),
      edges,
      days,
      stats: { nodes: store.size, edges: store.allEdges().length, lastDay: lastDay ?? days[days.length - 1] ?? null },
    };
  });
  ipcMain.handle('memory:pin', (_e, id: string, pinned: boolean) => {
    store.pin(id, pinned === true);
    return { ok: true };
  });
  ipcMain.handle('memory:wipe', () => {
    store.wipe();
    lastDay = null;
    return { ok: true };
  });

  return { store, onReceipt, contextFor };
}
