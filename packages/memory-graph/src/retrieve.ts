/**
 * 混合检索（T-M5-04 → V2-P1-04 情绪关联与不确定性分级）：
 *   词法相似度召回 topK → 沿边图扩展（2 跳） → 加权重排
 *   （0.5相似 + 0.3重要 + 0.2新近 + 0.3钉住 + 0.15情绪权重 + 0.08情绪同向）
 *   → 区分 clear / fuzzy / uncertain 不确定性，不把模糊记忆编造成笃定事实。
 */
import type { MemoryCategory, MemoryUncertaintyLevel } from '@workbench/shared-protocol';
import { inferMemoryCategory, type MemoryEdge, type MemoryNode, type MemoryStore } from './store';

export interface RetrieveOptions {
  topK?: number;
  topN?: number;
  hops?: number;
  now?: () => number;
  categories?: MemoryCategory[];
  currentEmotionValence?: number;
  recordRecall?: boolean;
}

export interface RetrievedMemory {
  node: MemoryNode;
  score: number;
  certainty: MemoryUncertaintyLevel;
  reasons: string[];
}

function isAnswerableNode(node: MemoryNode, categoryFilter?: Set<MemoryCategory>): boolean {
  const cat = node.category ?? inferMemoryCategory(node.nodeType);
  if (categoryFilter && !categoryFilter.has(cat)) return false;
  // 保持 V1 语义：未显式声明 category 的 entity/concept 仅作图桥节点，不直接作答；
  // 显式写入五类记忆或 event/summary 节点均可检索作答。
  if (node.category === undefined && (node.nodeType === 'entity' || node.nodeType === 'concept')) {
    return false;
  }
  return true;
}

function classifyCertainty(node: MemoryNode): MemoryUncertaintyLevel {
  if (node.retentionPolicy === 'consolidated') return 'fuzzy';
  const conf = node.confidence ?? 0.85;
  if (conf < 0.45 || node.importance < 0.3) return 'uncertain';
  if (conf < 0.72) return 'fuzzy';
  return 'clear';
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
      tokens.add(word);
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
  const categoryFilter = options.categories ? new Set(options.categories) : undefined;
  const queryTokens = tokenize(query);

  // 1) 词法召回
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
          if (node && isAnswerableNode(node, categoryFilter) && !expanded.has(nb)) {
            expanded.set(nb, { node, sim: seed.sim * 0.5 ** (h + 1), viaGraph: true });
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  // 3) 加权重排（含情绪权重与情绪同向加权）
  const maxAge = 90 * 86_400_000;
  const curValence = options.currentEmotionValence ?? 0;
  const results: RetrievedMemory[] = [];
  for (const { node, sim, viaGraph } of expanded.values()) {
    if (!isAnswerableNode(node, categoryFilter)) continue;
    const recency = Math.max(0, 1 - (now() - node.createdAt) / maxAge);
    const emoWeight = node.emotionWeight ?? 0;
    const nodeValence = node.emotionValence ?? 0;
    const moodCongruent = curValence !== 0 && nodeValence !== 0 && Math.sign(curValence) === Math.sign(nodeValence);
    const score =
      0.5 * sim
      + 0.3 * node.importance
      + 0.2 * recency
      + (node.pinned ? 0.3 : 0)
      + 0.15 * emoWeight
      + (moodCongruent ? 0.08 : 0);
    const certainty = classifyCertainty(node);
    const reasons = [
      `sim=${sim.toFixed(2)}`,
      `imp=${node.importance.toFixed(2)}`,
      `recency=${recency.toFixed(2)}`,
      ...(emoWeight > 0 ? [`emo=${emoWeight.toFixed(2)}`] : []),
      ...(moodCongruent ? ['mood-congruent'] : []),
      ...(node.pinned ? ['pinned'] : []),
      ...(viaGraph ? ['via-graph'] : []),
    ];
    results.push({ node, score, certainty, reasons });
  }

  const finalHits = results.sort((a, b) => b.score - a.score).slice(0, topN);
  if (options.recordRecall) {
    for (const hit of finalHits) store.recordRecall(hit.node.id);
  }
  return finalHits;
}

/** 把检索结果格式化为 LLM 可消费的记忆上下文（区分清晰记忆 / 模糊印象 / 不确定提示） */
export function formatMemoryContext(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return '';
  const lines = memories
    .map((m) => {
      if (m.certainty === 'fuzzy') return `- [模糊印象] ${m.node.text}`;
      if (m.certainty === 'uncertain') return `- [记忆较模糊，请如实表达不太确定、切勿编造] ${m.node.text}`;
      return `- ${m.node.text}`;
    })
    .join('\n');
  return `【小鲸的长期记忆（检索命中 ${memories.length} 条）】\n${lines.slice(0, 600)}`;
}

export type { MemoryEdge };
