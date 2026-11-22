/**
 * 混合检索（T-M5-04，feiyuos-memory-graph 思想重写）：
 *   词法相似度召回 topK → 沿边图扩展（2 跳） → 加权重排（0.5相似+0.3重要+0.2新近+0.3钉住）
 *   → topN；只召回 event/summary（entity/concept 作为桥不直接作答）。
 * 无外部 embedding 依赖（D14 独立运行）——中文按 2-gram 切分做词法匹配。
 */
import type { MemoryEdge, MemoryNode, MemoryStore } from './store';

export interface RetrieveOptions {
  topK?: number;
  topN?: number;
  hops?: number;
  now?: () => number;
}

export interface RetrievedMemory {
  node: MemoryNode;
  score: number;
  reasons: string[];
}

/** 中文 2-gram 词袋（无需分词器；英文按空白+标点切） */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const norm = text.toLowerCase().replace(/[，。！？；：、,.!?;:"'()（）：\s]+/g, ' ');
  for (const word of norm.split(' ')) {
    if (word === '') continue;
    if (/^[\x00-\x7F]+$/.test(word)) {
      tokens.add(word);
    } else {
      for (let i = 0; i < word.length - 1; i++) tokens.add(word.slice(i, i + 2));
      tokens.add(word); // 整词也留一份（短词命中更准）
    }
  }
  return tokens;
}

export function lexicalScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const docTokens = tokenize(text);
  if (docTokens.size === 0) return 0;
  let hit = 0;
  for (const q of queryTokens) if (docTokens.has(q)) hit++;
  return hit / queryTokens.size;
}

export function retrieve(store: MemoryStore, query: string, options: RetrieveOptions = {}): RetrievedMemory[] {
  const topK = options.topK ?? 10;
  const topN = options.topN ?? 5;
  const hops = options.hops ?? 2;
  const now = options.now ?? Date.now;
  const queryTokens = tokenize(query);

  // 1) 词法召回（event/summary 才可作答；entity/concept 可作桥）
  const scored = store
    .allNodes()
    .map((node) => ({ node, sim: lexicalScore(queryTokens, node.text) }))
    .filter((x) => x.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK);

  // 2) 图扩展：沿边最多 hops 跳（含桥节点邻域）
  const expanded = new Map<string, { node: MemoryNode; sim: number; viaGraph: boolean }>();
  const byId = new Map(store.allNodes().map((n) => [n.id, n] as const));
  for (const seed of scored) {
    expanded.set(seed.node.id, { node: seed.node, sim: seed.sim, viaGraph: false });
    const visited = new Set<string>([seed.node.id]);
    let frontier = [seed.node.id];
    for (let h = 0; h < hops; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of store.neighborIds(id)) {
          if (visited.has(nb)) continue;
          visited.add(nb);
          next.push(nb);
          const node = byId.get(nb);
          if (node && (node.nodeType === 'event' || node.nodeType === 'summary') && !expanded.has(nb)) {
            expanded.set(nb, { node, sim: seed.sim * 0.5 ** (h + 1), viaGraph: true });
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  // 3) 加权重排：0.5 相似 + 0.3 重要 + 0.2 新近 + 0.3 钉住
  const maxAge = 90 * 86_400_000;
  const results: RetrievedMemory[] = [];
  for (const { node, sim, viaGraph } of expanded.values()) {
    if (node.nodeType !== 'event' && node.nodeType !== 'summary') continue;
    const recency = Math.max(0, 1 - (now() - node.createdAt) / maxAge);
    const score =
      0.5 * sim + 0.3 * node.importance + 0.2 * recency + (node.pinned ? 0.3 : 0);
    const reasons = [
      `sim=${sim.toFixed(2)}`,
      `imp=${node.importance.toFixed(2)}`,
      `recency=${recency.toFixed(2)}`,
      ...(node.pinned ? ['pinned'] : []),
      ...(viaGraph ? ['via-graph'] : []),
    ];
    results.push({ node, score, reasons });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topN);
}

/** 把检索结果格式化为 LLM 可消费的记忆上下文（≤600 字，Token 预算） */
export function formatMemoryContext(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `- ${m.node.text}`).join('\n');
  return `【小鲸的长期记忆（检索命中 ${memories.length} 条）】\n${lines.slice(0, 600)}`;
}

export type { MemoryEdge };
