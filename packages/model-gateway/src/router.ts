/**
 * 路由解析（T-M1-03，Magpie 思想重写）：
 * 干饭套餐 roleBindings → 直接绑定（"providerId/modelId"）或粘性组（"group/groupId"）。
 * 粘性策略：PROMPT_CACHE_STICKY（会话内锁死同节点吃满 Prompt Cache）/
 *           ROUND_ROBIN / LOWEST_LATENCY；失败时输出"粘性优先 + 权重降序"的候选序列供 failover。
 */
import type { StickyRoutingGroup, WorkbenchRoleSlot } from '@workbench/shared-protocol';

export interface RouteCandidate {
  providerId: string;
  modelId: string;
  /** 候选所在粘性组 id（直接绑定为 null） */
  groupId: string | null;
  /** 权重（直接绑定固定 100；来自组定义） */
  weight: number;
}

export class RouteError extends Error {
  constructor(
    readonly code: 'ROUTE_UNBOUND' | 'BAD_BINDING' | 'GROUP_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

/** 粘性状态（网关内存态：会话内 lastGood / 轮询游标 / 时延记录） */
export class StickyState {
  private lastGood = new Map<string, RouteCandidate>();
  private cursors = new Map<string, number>();
  private latencies = new Map<string, number>();

  static key(sessionId: string, slot: WorkbenchRoleSlot, groupId: string): string {
    return `${sessionId}::${slot}::${groupId}`;
  }

  recordGood(key: string, candidate: RouteCandidate): void {
    this.lastGood.set(key, candidate);
  }

  getGood(key: string): RouteCandidate | null {
    return this.lastGood.get(key) ?? null;
  }

  nextCursor(groupId: string, modulo: number): number {
    const current = this.cursors.get(groupId) ?? 0;
    const next = modulo > 0 ? current % modulo : 0;
    this.cursors.set(groupId, (current + 1) % Math.max(modulo, 1));
    return next;
  }

  recordLatency(groupId: string, index: number, latencyMs: number): void {
    const key = `${groupId}::${index}`;
    const existing = this.latencies.get(key);
    if (existing === undefined || latencyMs < existing) {
      this.latencies.set(key, latencyMs);
    }
  }

  latencyOf(groupId: string, index: number): number | null {
    return this.latencies.get(`${groupId}::${index}`) ?? null;
  }

  /** 干饭套餐切换时清空粘性/游标/时延（新套餐新会话语义） */
  clearAll(): void {
    this.lastGood.clear();
    this.cursors.clear();
    this.latencies.clear();
  }
}

export interface CandidateOrderContext {
  binding: string;
  groups: StickyRoutingGroup[];
  state: StickyState;
  sessionId: string;
  slot: WorkbenchRoleSlot;
}

function groupCandidates(group: StickyRoutingGroup): RouteCandidate[] {
  return group.candidates.map((candidate) => ({
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    groupId: group.groupId,
    weight: candidate.weight,
  }));
}

function byWeightDesc(a: RouteCandidate, b: RouteCandidate): number {
  return b.weight - a.weight;
}

function sameTarget(a: RouteCandidate, b: RouteCandidate): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/** 解析绑定 → 有序候选序列（第一个为首选，其余为 failover 池） */
export function orderedCandidates(context: CandidateOrderContext): RouteCandidate[] {
  const { binding } = context;
  if (binding.startsWith('group/')) {
    const groupId = binding.slice('group/'.length);
    const group = context.groups.find((candidate) => candidate.groupId === groupId);
    if (!group) throw new RouteError('GROUP_MISSING', `粘性组不存在：${groupId}`);
    const candidates = groupCandidates(group);
    if (candidates.length === 0) throw new RouteError('GROUP_MISSING', `粘性组 ${groupId} 无候选节点`);
    const stickyKey = StickyState.key(context.sessionId, context.slot, group.groupId);

    switch (group.strategy) {
      case 'PROMPT_CACHE_STICKY': {
        const sticky = context.state.getGood(stickyKey);
        const rest = [...candidates].sort(byWeightDesc).filter(
          (candidate) => !(sticky && sameTarget(candidate, sticky)),
        );
        return sticky ? [sticky, ...rest] : [...candidates].sort(byWeightDesc);
      }
      case 'ROUND_ROBIN': {
        const start = context.state.nextCursor(group.groupId, candidates.length);
        return [...candidates.slice(start), ...candidates.slice(0, start)];
      }
      case 'LOWEST_LATENCY': {
        return [...candidates].sort((a, b) => {
          const indexA = candidates.indexOf(a);
          const indexB = candidates.indexOf(b);
          const latencyA = context.state.latencyOf(group.groupId, indexA) ?? Number.MAX_SAFE_INTEGER;
          const latencyB = context.state.latencyOf(group.groupId, indexB) ?? Number.MAX_SAFE_INTEGER;
          if (latencyA !== latencyB) return latencyA - latencyB;
          return b.weight - a.weight;
        });
      }
    }
  }

  // 直接绑定："providerId/modelId"
  const separator = binding.indexOf('/');
  const providerId = separator > 0 ? binding.slice(0, separator) : '';
  const modelId = separator > 0 ? binding.slice(separator + 1) : '';
  if (!providerId || !modelId) {
    throw new RouteError('BAD_BINDING', `绑定格式应为 providerId/modelId 或 group/groupId：${binding}`);
  }
  return [{ providerId, modelId, groupId: null, weight: 100 }];
}

/** 粘性记录：成功后写入 lastGood（下次同会话直接命中同节点） */
export function recordStickyGood(
  context: CandidateOrderContext,
  candidate: RouteCandidate,
): void {
  if (!candidate.groupId) return;
  const key = StickyState.key(context.sessionId, context.slot, candidate.groupId);
  context.state.recordGood(key, candidate);
}
