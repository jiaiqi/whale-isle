/**
 * 记忆图谱存储（T-M5-04 → V2-P1-04 类人五类记忆与级联真删除）：
 * - 五类记忆：working / episodic / semantic / relational / self
 * - 情绪权重延长记忆保留（emotionWeight），保护 Self 域，支持模糊印象归纳与用户手动纠正
 * - 严格区分「自然衰变遗忘（naturalDecayed）」与「显式用户真删除（hardDelete）」：
 *   真删除级联清除衍生摘要/日记、原子重写 JSONL 擦除磁盘原文、触发 SQLite 账本级联回调并留无明文审计
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  FuzzyImpression,
  MemoryCategory,
  MemoryCorrectionEntry,
  MemoryDeletionAudit,
  MemoryRetentionPolicy,
} from '@workbench/shared-protocol';

export type NodeType = 'event' | 'entity' | 'concept' | 'summary';
export type EdgeKind = 'temporal' | 'causal' | 'semantic' | 'entity' | 'instance';

export interface MemoryNode {
  id: string;
  nodeType: NodeType;
  category?: MemoryCategory;
  characterId?: string;
  text: string;
  importance: number; // 0~1
  confidence?: number; // 0~1
  emotionWeight?: number; // 0~1
  emotionValence?: number; // -1~1
  entityKey?: string;
  entityDisplayName?: string;
  derivedFromIds?: string[];
  retentionPolicy?: MemoryRetentionPolicy;
  recallCount?: number;
  lastRecalledAt?: number;
  correctionHistory?: MemoryCorrectionEntry[];
  naturalDecayed?: boolean;
  createdAt: number;
  lastUsedAt: number;
  instanceCount: number;
  pinned: boolean;
  tombstone?: boolean;
  meta?: Record<string, string | number | boolean>;
}

export interface MemoryEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
  createdAt: number;
}

export interface StoreOptions {
  dir: string;
  /** 半衰期（天）——默认 30 天（feiyuos-memory-graph 实测） */
  halfLifeDays?: number;
  /** 宽限（天）——新节点不满宽限期不衰减 */
  graceDays?: number;
  /** 低于该重要度删除 */
  pruneBelow?: number;
  now?: () => number;
}

interface GraphFile {
  nodes?: MemoryNode[];
  edges?: MemoryEdge[];
}

const HALF_LIFE_DAYS = 30;
const GRACE_DAYS = 7;
const PRUNE_BELOW = 0.2;

export function inferMemoryCategory(nodeType: NodeType): MemoryCategory {
  if (nodeType === 'event') return 'episodic';
  if (nodeType === 'entity') return 'relational';
  return 'semantic';
}

export class MemoryStore {
  private nodes = new Map<string, MemoryNode>();
  private edges: MemoryEdge[] = [];
  private audits: MemoryDeletionAudit[] = [];
  private readonly nodesPath: string;
  private readonly edgesPath: string;
  private readonly auditsPath: string;
  private readonly halfLifeMs: number;
  private readonly graceMs: number;
  private readonly pruneBelow: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly options: StoreOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.nodesPath = join(options.dir, 'nodes.jsonl');
    this.edgesPath = join(options.dir, 'edges.jsonl');
    this.auditsPath = join(options.dir, 'deletion-audit.jsonl');
    this.halfLifeMs = (options.halfLifeDays ?? HALF_LIFE_DAYS) * 86_400_000;
    this.graceMs = (options.graceDays ?? GRACE_DAYS) * 86_400_000;
    this.pruneBelow = options.pruneBelow ?? PRUNE_BELOW;
    this.now = options.now ?? Date.now;
    this.load();
  }

  private load(): void {
    const loadFile = <T>(path: string): T[] => {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const out: T[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          /* 坏行跳过（append-only 容错） */
        }
      }
      return out;
    };
    for (const rec of loadFile<GraphFile>(this.nodesPath)) {
      for (const n of rec.nodes ?? []) {
        this.nodes.set(n.id, n);
        this.seq = Math.max(this.seq, Number(n.id.replace(/\D/g, '').slice(-8)) || 0);
      }
    }
    for (const rec of loadFile<GraphFile>(this.edgesPath)) {
      this.edges.push(...(rec.edges ?? []));
    }
    this.audits = loadFile<MemoryDeletionAudit>(this.auditsPath);
    this.applyDecay();
  }

  /** 半衰期衰减 + 自然遗忘标记（保护 Self 域与 pinned；情绪权重延长半衰期；模糊印象慢衰变） */
  private applyDecay(): void {
    const t = this.now();
    for (const node of this.nodes.values()) {
      if (
        node.pinned
        || node.tombstone
        || node.category === 'self'
        || node.retentionPolicy === 'protected_self'
      ) {
        continue;
      }
      const age = t - node.createdAt;
      if (age <= this.graceMs) continue;
      const emotionScale = 1 + clamp01(node.emotionWeight ?? 0) * 1.5;
      const policyScale = node.retentionPolicy === 'consolidated' ? 3 : 1;
      const effectiveHalfLife = this.halfLifeMs * emotionScale * policyScale;
      const periods = (age - this.graceMs) / effectiveHalfLife;
      if (periods <= 0) continue;
      node.importance = node.importance * Math.pow(0.5, periods);
      if (node.retentionPolicy === 'consolidated') {
        node.importance = Math.max(this.pruneBelow + 0.05, node.importance);
        continue;
      }
      if (node.importance < this.pruneBelow) {
        node.tombstone = true;
        node.naturalDecayed = true;
      }
    }
  }

  /** 写入节点（幂等：相同 nodeType+text+category 视为同一实例，instanceCount 合并） */
  addNode(
    input: Pick<MemoryNode, 'nodeType' | 'text'> & {
      category?: MemoryCategory;
      characterId?: string;
      importance?: number;
      confidence?: number;
      emotionWeight?: number;
      emotionValence?: number;
      entityKey?: string;
      entityDisplayName?: string;
      derivedFromIds?: string[];
      retentionPolicy?: MemoryRetentionPolicy;
      pinned?: boolean;
      meta?: MemoryNode['meta'];
    },
  ): MemoryNode {
    const text = sanitizeMemoryText(input.text);
    if (text === '') throw new Error('记忆正文不能为空');
    const category = input.category ?? inferMemoryCategory(input.nodeType);
    const existing = this.findByText(input.nodeType, text, category);
    if (existing) {
      existing.instanceCount += 1;
      existing.lastUsedAt = this.now();
      existing.importance = Math.min(1, existing.importance + 0.05);
      if (input.emotionWeight !== undefined) {
        existing.emotionWeight = Math.max(existing.emotionWeight ?? 0, clamp01(input.emotionWeight));
      }
      this.append('nodes', { nodes: [existing] });
      return existing;
    }
    const retentionPolicy: MemoryRetentionPolicy = input.retentionPolicy
      ?? (category === 'self' ? 'protected_self' : category === 'working' ? 'ephemeral' : 'standard');
    const t = this.now();
    const node: MemoryNode = {
      id: `n${String(++this.seq).padStart(8, '0')}`,
      nodeType: input.nodeType,
      category,
      text,
      importance: clamp01(input.importance ?? defaultImportance(input.nodeType)),
      confidence: clamp01(input.confidence ?? 0.85),
      retentionPolicy,
      recallCount: 0,
      createdAt: t,
      lastUsedAt: t,
      instanceCount: 1,
      pinned: input.pinned ?? false,
      ...(input.characterId !== undefined ? { characterId: input.characterId } : {}),
      ...(input.emotionWeight !== undefined ? { emotionWeight: clamp01(input.emotionWeight) } : {}),
      ...(input.emotionValence !== undefined ? { emotionValence: Math.max(-1, Math.min(1, input.emotionValence)) } : {}),
      ...(input.entityKey !== undefined ? { entityKey: input.entityKey } : {}),
      ...(input.entityDisplayName !== undefined ? { entityDisplayName: input.entityDisplayName } : {}),
      ...(input.derivedFromIds !== undefined ? { derivedFromIds: [...new Set(input.derivedFromIds)] } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    this.nodes.set(node.id, node);
    this.append('nodes', { nodes: [node] });
    return node;
  }

  addEdge(from: string, to: string, kind: EdgeKind, weight = 1): MemoryEdge {
    const existing = this.edges.find((e) => e.from === from && e.to === to && e.kind === kind);
    if (existing) {
      existing.weight = Math.min(1, existing.weight + 0.1);
      return existing;
    }
    const edge: MemoryEdge = { from, to, kind, weight: clamp01(weight), createdAt: this.now() };
    this.edges.push(edge);
    this.append('edges', { edges: [edge] });
    return edge;
  }

  /** 记录一次动作事件（autodrive 回执 → episodic event 节点），返回节点 */
  recordAction(input: { summary: string; tool: string; day: string; status: string }): MemoryNode {
    const text = `${input.day} ${input.tool}：${input.summary}`;
    const isSuccess = input.status === 'COMPLETED';
    const node = this.addNode({
      nodeType: 'event',
      category: 'episodic',
      text,
      importance: isSuccess ? 0.35 : 0.6,
      emotionWeight: isSuccess ? 0.1 : 0.45,
      emotionValence: isSuccess ? 0.2 : -0.35,
      meta: { tool: input.tool, status: input.status, day: input.day },
    });
    const prev = [...this.nodes.values()]
      .filter((n) => n.nodeType === 'event' && n.id !== node.id && !n.tombstone)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (prev) this.addEdge(prev.id, node.id, 'temporal', 0.5);
    return node;
  }

  /** 换日归纳：当天 events 汇总为 semantic summary 节点，记录 derivedFromIds 供级联删除 */
  writeDiary(day: string): MemoryNode | null {
    const events = [...this.nodes.values()].filter(
      (n) => n.nodeType === 'event' && !n.tombstone && n.meta?.['day'] === day,
    );
    if (events.length === 0) return null;
    const ok = events.filter((e) => e.meta?.['status'] === 'COMPLETED').length;
    const fail = events.length - ok;
    const tools = [...new Set(events.map((e) => String(e.meta?.['tool'] ?? '')))].filter(Boolean).slice(0, 6);
    const text = `${day} 日记：完成 ${ok} 项，翻车 ${fail} 次；涉及 ${tools.join('、')}。`;
    const summary = this.addNode({
      nodeType: 'summary',
      category: 'semantic',
      text,
      importance: 0.7,
      pinned: false,
      derivedFromIds: events.map((e) => e.id),
      meta: { day },
    });
    for (const e of events) this.addEdge(summary.id, e.id, 'instance', 1);
    return summary;
  }

  /** 主动回忆巩固：提升回忆计数与重要度 */
  recordRecall(id: string): void {
    const node = this.nodes.get(id);
    if (!node || node.tombstone) return;
    node.recallCount = (node.recallCount ?? 0) + 1;
    node.lastRecalledAt = this.now();
    node.importance = clamp01(node.importance + 0.03);
    this.append('nodes', { nodes: [node] });
  }

  /** 用户手动纠正某条记忆：保留纠正历史并提升置信度至 1.0 */
  correctNode(id: string, newText: string, reason = '用户手动纠正'): MemoryNode {
    const node = this.nodes.get(id);
    if (!node || node.tombstone) {
      throw new Error(`未找到可纠正的记忆节点：${id}`);
    }
    const cleaned = sanitizeMemoryText(newText);
    if (cleaned === '') throw new Error('纠正后的记忆正文不能为空');
    const t = this.now();
    const entry: MemoryCorrectionEntry = {
      prevText: node.text,
      nextText: cleaned,
      reason: reason.trim() || '用户手动纠正',
      correctedAt: t,
    };
    node.text = cleaned;
    node.confidence = 1;
    node.lastUsedAt = t;
    node.correctionHistory = [...(node.correctionHistory ?? []), entry];
    this.rewriteAll();
    return node;
  }

  /**
   * 模糊印象归纳（V2-P1-04）：
   * 将同一人物（entityKey）的多次散落互动归纳为「常来/熟人」模糊印象（consolidated），
   * 即使旧单句随时间自然衰变遗忘，角色仍能记得「TA 常来」。
   */
  consolidateRelationalImpressions(options: { entityKey?: string; minInteractions?: number } = {}): FuzzyImpression[] {
    const minInteractions = Math.max(1, options.minInteractions ?? 2);
    const grouped = new Map<string, MemoryNode[]>();
    for (const node of this.nodes.values()) {
      if (node.tombstone || node.retentionPolicy === 'consolidated') continue;
      if (!node.entityKey) continue;
      if (options.entityKey && node.entityKey !== options.entityKey) continue;
      const list = grouped.get(node.entityKey) ?? [];
      list.push(node);
      grouped.set(node.entityKey, list);
    }

    const impressions: FuzzyImpression[] = [];
    for (const [entityKey, sources] of grouped.entries()) {
      const totalCount = sources.reduce((sum, n) => sum + n.instanceCount, 0);
      if (totalCount < minInteractions) continue;
      const displayName = sources.find((n) => n.entityDisplayName)?.entityDisplayName ?? entityKey;
      const lastSeenAt = Math.max(...sources.map((n) => n.lastUsedAt));
      const confidence = Number(clamp01(0.55 + Math.min(0.35, totalCount * 0.05)).toFixed(2));
      const summary = `对「${displayName}」的模糊印象：近期互动 ${totalCount} 次（常来互动），旧单句细节随时间自然淡忘。`;
      const sourceIds = sources.map((n) => n.id);

      const existing = [...this.nodes.values()].find(
        (n) => !n.tombstone && n.category === 'relational' && n.retentionPolicy === 'consolidated' && n.entityKey === entityKey,
      );

      let targetNode: MemoryNode;
      if (existing) {
        existing.text = summary;
        existing.confidence = confidence;
        existing.lastUsedAt = this.now();
        existing.derivedFromIds = [...new Set([...(existing.derivedFromIds ?? []), ...sourceIds])];
        existing.entityDisplayName = displayName;
        targetNode = existing;
      } else {
        targetNode = this.addNode({
          nodeType: 'summary',
          category: 'relational',
          retentionPolicy: 'consolidated',
          text: summary,
          importance: 0.72,
          confidence,
          entityKey,
          entityDisplayName: displayName,
          derivedFromIds: sourceIds,
        });
      }

      for (const src of sources) {
        this.addEdge(targetNode.id, src.id, 'instance', 0.9);
      }

      impressions.push({
        nodeId: targetNode.id,
        entityKey,
        displayName,
        interactionCount: totalCount,
        summary,
        confidence,
        lastSeenAt,
        sourceNodeIds: sourceIds,
      });
    }

    if (impressions.length > 0) this.rewriteAll();
    return impressions;
  }

  /**
   * 显式真删除（级联覆盖衍生摘要/日记、原子重写磁盘 JSONL、联动账本删除回调、落盘无明文审计）。
   * 默认强制保护 Self 保护域不被误删。
   */
  hardDelete(
    nodeId: string,
    options: {
      reason?: string;
      allowProtectedSelf?: boolean;
      onDeleteLedgerRef?: (entityKey: string) => boolean;
    } = {},
  ): { deleted: boolean; blockedReason?: 'NOT_FOUND' | 'PROTECTED_SELF_MEMORY'; audit?: MemoryDeletionAudit } {
    const target = this.nodes.get(nodeId);
    if (!target || target.tombstone) {
      return { deleted: false, blockedReason: 'NOT_FOUND' };
    }
    const targetCategory = target.category ?? inferMemoryCategory(target.nodeType);
    if ((targetCategory === 'self' || target.retentionPolicy === 'protected_self') && !options.allowProtectedSelf) {
      return { deleted: false, blockedReason: 'PROTECTED_SELF_MEMORY' };
    }

    const derivedIds = new Set<string>();
    for (const candidate of this.nodes.values()) {
      if (candidate.id === nodeId) continue;
      if (candidate.derivedFromIds?.includes(nodeId)) {
        derivedIds.add(candidate.id);
      }
    }
    for (const edge of this.edges) {
      if (edge.kind === 'instance' && edge.to === nodeId) {
        const src = this.nodes.get(edge.from);
        if (src && src.nodeType === 'summary') derivedIds.add(src.id);
      }
    }

    const allRemoved = new Set<string>([nodeId, ...derivedIds]);
    const entityKeys = new Set<string>();
    for (const id of allRemoved) {
      const n = this.nodes.get(id);
      if (n?.entityKey) entityKeys.add(n.entityKey);
      this.nodes.delete(id);
    }
    this.edges = this.edges.filter((e) => !allRemoved.has(e.from) && !allRemoved.has(e.to));
    this.rewriteAll();

    const clearedLedgerRefs: string[] = [];
    if (options.onDeleteLedgerRef) {
      for (const key of entityKeys) {
        if (options.onDeleteLedgerRef(key)) clearedLedgerRefs.push(key);
      }
    }

    const audit: MemoryDeletionAudit = {
      auditId: `del-${this.now()}-${nodeId}`,
      targetNodeId: nodeId,
      targetCategory,
      reason: options.reason?.trim() || '用户显式请求删除',
      deletedNodeIds: [nodeId],
      deletedDerivedIds: [...derivedIds],
      clearedLedgerRefs,
      deletedAt: this.now(),
    };
    this.audits.push(audit);
    appendFileSync(this.auditsPath, `${JSON.stringify(audit)}\n`, 'utf8');
    return { deleted: true, audit };
  }

  deletionAudits(): MemoryDeletionAudit[] {
    return structuredClone(this.audits);
  }

  listByCategory(category: MemoryCategory): MemoryNode[] {
    return this.allNodes().filter((n) => (n.category ?? inferMemoryCategory(n.nodeType)) === category);
  }

  get size(): number {
    return [...this.nodes.values()].filter((n) => !n.tombstone).length;
  }

  allNodes(): MemoryNode[] {
    return [...this.nodes.values()].filter((n) => !n.tombstone);
  }

  allEdges(): MemoryEdge[] {
    return [...this.edges];
  }

  neighborIds(id: string): string[] {
    const out: string[] = [];
    for (const e of this.edges) {
      if (e.from === id) out.push(e.to);
      else if (e.to === id) out.push(e.from);
    }
    return out;
  }

  pin(id: string, pinned: boolean): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.pinned = pinned;
    this.append('nodes', { nodes: [node] });
  }

  /** 墓碑压实：tombstone 比例 > 30% 时重写两文件（feiyuos-memory-graph 策略） */
  compact(): void {
    const all = [...this.nodes.values()];
    const tombs = all.filter((n) => n.tombstone).length;
    if (all.length === 0 || tombs / all.length < 0.3) return;
    const alive = all.filter((n) => !n.tombstone);
    const aliveIds = new Set(alive.map((n) => n.id));
    this.nodes = new Map(alive.map((n) => [n.id, n]));
    this.edges = this.edges.filter((e) => aliveIds.has(e.from) && aliveIds.has(e.to));
    this.rewriteAll();
  }

  wipe(): void {
    this.nodes.clear();
    this.edges = [];
    rmSync(this.nodesPath, { force: true });
    rmSync(this.edgesPath, { force: true });
  }

  private rewriteAll(): void {
    const allNodes = [...this.nodes.values()];
    const tmpN = `${this.nodesPath}.tmp`;
    const tmpE = `${this.edgesPath}.tmp`;
    writeFileSync(
      tmpN,
      allNodes.length === 0 ? '' : `${allNodes.map((n) => JSON.stringify({ nodes: [n] })).join('\n')}\n`,
      'utf8',
    );
    writeFileSync(
      tmpE,
      this.edges.length === 0 ? '' : `${this.edges.map((e) => JSON.stringify({ edges: [e] })).join('\n')}\n`,
      'utf8',
    );
    renameSync(tmpN, this.nodesPath);
    renameSync(tmpE, this.edgesPath);
  }

  private findByText(nodeType: NodeType, text: string, category: MemoryCategory): MemoryNode | undefined {
    for (const n of this.nodes.values()) {
      const cat = n.category ?? inferMemoryCategory(n.nodeType);
      if (n.nodeType === nodeType && cat === category && n.text === text && !n.tombstone) return n;
    }
    return undefined;
  }

  private append(kind: 'nodes' | 'edges', rec: GraphFile): void {
    const path = kind === 'nodes' ? this.nodesPath : this.edgesPath;
    appendFileSync(path, `${JSON.stringify(rec)}\n`, 'utf8');
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function defaultImportance(type: NodeType): number {
  return type === 'summary' ? 0.7 : type === 'event' ? 0.4 : 0.5;
}

/** 正文消毒：内部 id / 绝对路径 / 键值一律剔除（dsh-pet 记忆事故教训） */
export function sanitizeMemoryText(text: string): string {
  return text
    .replace(/\/Users\/[^\s，。；]+/g, '')
    .replace(/\bn\d{8}\b/g, '')
    .replace(/\b(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,})/g, '{{MASKED}}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
