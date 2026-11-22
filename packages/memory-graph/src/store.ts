/**
 * 记忆图谱存储（T-M5-04）：JSONL append-only + 内存 Map/邻接表 + 墓碑压实。
 * 设计来源 feiyuos-memory-graph（MIT）：node{nodeType,importance,instanceCount,lastUsedAt}
 * 反 AI 幻觉铁律（dsh-pet 教训）：内部 id/路径永不写入记忆正文。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type NodeType = 'event' | 'entity' | 'concept' | 'summary';
export type EdgeKind = 'temporal' | 'causal' | 'semantic' | 'entity' | 'instance';

export interface MemoryNode {
  id: string;
  nodeType: NodeType;
  text: string;
  importance: number; // 0~1
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

export class MemoryStore {
  private nodes = new Map<string, MemoryNode>();
  private edges: MemoryEdge[] = [];
  private readonly nodesPath: string;
  private readonly edgesPath: string;
  private readonly halfLifeMs: number;
  private readonly graceMs: number;
  private readonly pruneBelow: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly options: StoreOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.nodesPath = join(options.dir, 'nodes.jsonl');
    this.edgesPath = join(options.dir, 'edges.jsonl');
    this.halfLifeMs = (options.halfLifeDays ?? HALF_LIFE_DAYS) * 86_400_000;
    this.graceMs = (options.graceDays ?? GRACE_DAYS) * 86_400_000;
    this.pruneBelow = options.pruneBelow ?? PRUNE_BELOW;
    this.now = options.now ?? Date.now;
    this.load();
  }

  private load(): void {
    const loadFile = (path: string): GraphFile[] => {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const out: GraphFile[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as GraphFile);
        } catch {
          /* 坏行跳过（append-only 容错） */
        }
      }
      return out;
    };
    for (const rec of loadFile(this.nodesPath)) {
      for (const n of rec.nodes ?? []) {
        // 后写覆盖（墓碑/更新语义）
        this.nodes.set(n.id, n);
        this.seq = Math.max(this.seq, Number(n.id.replace(/\D/g, '').slice(-8)) || 0);
      }
    }
    for (const rec of loadFile(this.edgesPath)) {
      this.edges.push(...(rec.edges ?? []));
    }
    this.applyDecay();
  }

  /** 半衰期衰减 + 墓碑清理（宽限期内的新节点不衰减） */
  private applyDecay(): void {
    const t = this.now();
    for (const node of this.nodes.values()) {
      if (node.pinned || node.tombstone) continue;
      const age = t - node.createdAt;
      if (age <= this.graceMs) continue;
      const periods = (age - this.graceMs) / this.halfLifeMs;
      if (periods <= 0) continue;
      node.importance = node.importance * Math.pow(0.5, periods);
      if (node.importance < this.pruneBelow) node.tombstone = true;
    }
  }

  /** 写入节点（幂等：相同 nodeType+text 视为同一实例，instanceCount 合并） */
  addNode(input: Pick<MemoryNode, 'nodeType' | 'text'> & { importance?: number; pinned?: boolean; meta?: MemoryNode['meta'] }): MemoryNode {
    const text = sanitizeMemoryText(input.text);
    if (text === '') throw new Error('记忆正文不能为空');
    const existing = this.findByText(input.nodeType, text);
    if (existing) {
      existing.instanceCount += 1;
      existing.lastUsedAt = this.now();
      existing.importance = Math.min(1, existing.importance + 0.05);
      this.append('nodes', { nodes: [existing] });
      return existing;
    }
    const node: MemoryNode = {
      id: `n${String(++this.seq).padStart(8, '0')}`,
      nodeType: input.nodeType,
      text,
      importance: clamp01(input.importance ?? defaultImportance(input.nodeType)),
      createdAt: this.now(),
      lastUsedAt: this.now(),
      instanceCount: 1,
      pinned: input.pinned ?? false,
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

  /** 记录一次动作事件（autodrive 回执 → event 节点），返回节点 */
  recordAction(input: { summary: string; tool: string; day: string; status: string }): MemoryNode {
    const text = `${input.day} ${input.tool}：${input.summary}`;
    const node = this.addNode({
      nodeType: 'event',
      text,
      importance: input.status === 'COMPLETED' ? 0.35 : 0.6, // 翻车更重要（未来避坑）
      meta: { tool: input.tool, status: input.status, day: input.day },
    });
    // 时间序边：与上一条 event 相连（temporal）
    const prev = [...this.nodes.values()]
      .filter((n) => n.nodeType === 'event' && n.id !== node.id && !n.tombstone)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (prev) this.addEdge(prev.id, node.id, 'temporal', 0.5);
    return node;
  }

  /** 换日归纳：当天 events 汇总为 summary 节点（小鲸日记条目） */
  writeDiary(day: string): MemoryNode | null {
    const events = [...this.nodes.values()].filter(
      (n) => n.nodeType === 'event' && !n.tombstone && n.meta?.['day'] === day,
    );
    if (events.length === 0) return null;
    const ok = events.filter((e) => e.meta?.['status'] === 'COMPLETED').length;
    const fail = events.length - ok;
    const tools = [...new Set(events.map((e) => String(e.meta?.['tool'] ?? '')))].filter(Boolean).slice(0, 6);
    const text = `${day} 日记：完成 ${ok} 项，翻车 ${fail} 次；涉及 ${tools.join('、')}。`;
    const summary = this.addNode({ nodeType: 'summary', text, importance: 0.7, pinned: false, meta: { day } });
    for (const e of events) this.addEdge(summary.id, e.id, 'instance', 1);
    return summary;
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
    const tmpN = `${this.nodesPath}.tmp`;
    const tmpE = `${this.edgesPath}.tmp`;
    writeFileSync(tmpN, alive.map((n) => JSON.stringify({ nodes: [n] })).join('\n') + '\n', 'utf8');
    writeFileSync(tmpE, this.edges.map((e) => JSON.stringify({ edges: [e] })).join('\n') + '\n', 'utf8');
    renameSync(tmpN, this.nodesPath);
    renameSync(tmpE, this.edgesPath);
  }

  wipe(): void {
    this.nodes.clear();
    this.edges = [];
    rmSync(this.nodesPath, { force: true });
    rmSync(this.edgesPath, { force: true });
  }

  private findByText(nodeType: NodeType, text: string): MemoryNode | undefined {
    for (const n of this.nodes.values()) {
      if (n.nodeType === nodeType && n.text === text && !n.tombstone) return n;
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
    .replace(/\/Users\/[^\s，。；]+/g, '') // 绝对路径
    .replace(/\bn\d{8}\b/g, '') // 内部节点 id
    .replace(/\b(?:sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,})/g, '{{MASKED}}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
