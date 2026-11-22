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
  ipcMain.handle('memory:wipe', () => {
    store.wipe();
    lastDay = null;
    return { ok: true };
  });

  return { store, onReceipt, contextFor };
}
